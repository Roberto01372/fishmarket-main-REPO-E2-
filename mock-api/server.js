const express = require('express');
const cors = require('cors');
const dns = require('dns');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env.example') });

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

const normalizeConnectionString = (connectionString) => {
  if (!connectionString) {
    return undefined;
  }

  if (connectionString.includes('sslmode=')) {
    return connectionString;
  }

  return connectionString.includes('?')
    ? `${connectionString}&sslmode=require`
    : `${connectionString}?sslmode=require`;
};

const dbUrl = process.env.DATABASE_URL ? normalizeConnectionString(process.env.DATABASE_URL) : undefined;

const resolveHostIPv4 = (hostname) => {
  return new Promise((resolve) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      resolve(err ? null : address);
    });
  });
};

const parseDatabaseUrl = async (connectionString) => {
  try {
    const url = new URL(connectionString);
    const ipv4 = await resolveHostIPv4(url.hostname);
    return {
      host: ipv4 || url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname?.slice(1),
      ssl: { rejectUnauthorized: false },
      family: 4,
    };
  } catch (error) {
    console.error('Failed to parse DATABASE_URL:', error.message);
    return null;
  }
};

let poolConfig = null;
let pool = null;
let dbAvailable = false;
let dbErrorMessage = null;

(async () => {
  if (dbUrl) {
    poolConfig = await parseDatabaseUrl(dbUrl);
    if (poolConfig) {
      pool = new Pool(poolConfig);

      pool.query('SELECT 1')
        .then(() => {
          dbAvailable = true;
          console.log('Postgres connection OK');
        })
        .catch((error) => {
          dbErrorMessage = error.message;
          console.error('Postgres connection failed:', dbErrorMessage);
        });
    }
  }
})();

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

if (pool) {
  pool.query('SELECT 1')
    .then(() => {
      dbAvailable = true;
      console.log('Postgres connection OK');
    })
    .catch((error) => {
      dbErrorMessage = error.message;
      console.error('Postgres connection failed:', dbErrorMessage);
    });
}

async function findProductStock(productId) {
  if (!pool || !productId) {
    return null;
  }

  const productTable = process.env.PRODUCTS_TABLE ?? 'products';
  const idColumn = process.env.PRODUCTS_ID_COLUMN ?? 'id';
  const stockColumn = process.env.STOCK_COLUMN ?? 'stock';

  try {
    const { rows } = await pool.query(
      `SELECT ${quoteIdentifier(idColumn)} AS product_id, ${quoteIdentifier(stockColumn)} AS stock FROM ${quoteIdentifier(productTable)} WHERE ${quoteIdentifier(idColumn)} = $1 LIMIT 1`,
      [productId],
    );

    if (rows.length > 0) {
      return {
        table: productTable,
        productId: rows[0].product_id,
        stock: Number(rows[0].stock) || 0,
        foundOnTable: productTable,
        idColumn,
        stockColumn,
      };
    }

    return null;
  } catch (error) {
    console.error('findProductStock error:', error.message);
    return null;
  }
}

async function getAllPublicTables() {
  try {
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    return rows.map((row) => row.table_name).filter(Boolean);
  } catch (error) {
    return [];
  }
}

const orders = [];

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', database: pool ? 'configured' : 'not-configured', dbAvailable, dbErrorMessage, orders: orders.length });
});

app.get('/debug/product/:id', async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: 'DB pool not configured', dbErrorMessage });
  }

  const productId = req.params.id;
  const result = await findProductStock(productId);
  return res.json({ productId, result, dbAvailable, dbErrorMessage });
});

app.get('/orders', (_req, res) => {
  res.json({
    message: 'Use POST /orders to create a new order; GET /orders only returns metadata.',
    totalOrders: orders.length,
    dbAvailable,
    dbErrorMessage,
  });
});

app.get('/orders/:id', (req, res) => {
  const order = orders.find((o) => o.orderId === req.params.id);
  if (!order) {
    return res.status(404).json({ message: 'Order not found' });
  }
  return res.json(order);
});

app.post('/orders', async (req, res) => {
  const { userId, items } = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'];

  if (!userId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      timestamp: new Date().toISOString(),
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'userId and items are required',
      correlationId: req.headers['x-correlation-id'] || 'local',
    });
  }

  if (!idempotencyKey) {
    return res.status(400).json({
      timestamp: new Date().toISOString(),
      status: 400,
      code: 'MISSING_IDEMPOTENCY_KEY',
      message: 'Idempotency-Key header is required',
      correlationId: req.headers['x-correlation-id'] || 'local',
    });
  }

  const orderItems = [];
  for (const item of items) {
    const productId = item.productId;
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unitPrice || 0);

    if (!productId || quantity <= 0) {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'Each item needs productId and a positive quantity',
        correlationId: req.headers['x-correlation-id'] || 'local',
      });
    }

    const stockInfo = await findProductStock(productId);
    if (!stockInfo) {
      return res.status(422).json({
        timestamp: new Date().toISOString(),
        status: 422,
        code: 'PRODUCT_NOT_FOUND',
        message: `No se encontró el producto ${productId} en la base de datos`,
        correlationId: req.headers['x-correlation-id'] || 'local',
      });
    }

    if (stockInfo.stock < quantity) {
      return res.status(422).json({
        timestamp: new Date().toISOString(),
        status: 422,
        code: 'OUT_OF_STOCK',
        message: `El producto ${productId} tiene stock ${stockInfo.stock} y se pidió ${quantity}`,
        correlationId: req.headers['x-correlation-id'] || 'local',
      });
    }

    orderItems.push({
      productId,
      quantity,
      unitPrice,
      subtotal: unitPrice * quantity,
    });
  }

  const totalAmount = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
  const order = {
    orderId: `ORD-${Date.now()}`,
    userId,
    status: 'CREATED',
    totalAmount,
    items: orderItems,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  orders.push(order);

  return res.status(201).json(order);
});

app.listen(port, () => {
  console.log(`Order service listening on port ${port}`);
});
