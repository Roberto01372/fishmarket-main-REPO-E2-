const express = require('express');
const cors = require('cors');
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

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: normalizeConnectionString(process.env.DATABASE_URL) })
  : null;

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

async function findProductStock(productId) {
  if (!pool) {
    return null;
  }

  const candidateTables = [
    process.env.PRODUCTS_TABLE,
    'products',
    'inventory',
    'product_inventory',
    'product',
    'items',
    'catalog_products',
    'stocks',
    'product_stocks',
  ].filter(Boolean);

  const candidateIdColumns = [
    process.env.PRODUCTS_ID_COLUMN,
    'id',
    'product_id',
    'productId',
    'sku',
    'code',
    'slug',
  ].filter(Boolean);

  const candidateStockColumns = [
    process.env.STOCK_COLUMN,
    'stock',
    'quantity',
    'stock_quantity',
    'available_quantity',
    'quantity_available',
    'inventory',
    'units_in_stock',
    'available_stock',
  ].filter(Boolean);

  const normalizedProductId = String(productId || '').trim();
  const productVariants = [
    normalizedProductId,
    normalizedProductId.replace(/^P-|^PROD-|^PRODUCT-/i, ''),
    normalizedProductId.replace(/[^0-9]/g, ''),
    normalizedProductId.replace(/^0+/, ''),
  ].filter(Boolean);

  const allTables = [...new Set([...(candidateTables || []), ...(await getAllPublicTables())])];

  for (const table of allTables) {
    try {
      const { rows: columnsRows } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const columns = columnsRows.map((row) => row.column_name);

      const idColumn = candidateIdColumns.find((column) => columns.includes(column)) || columns.find((column) => ['id', 'product_id', 'productId', 'sku', 'code', 'slug'].includes(column));
      const stockColumn = candidateStockColumns.find((column) => columns.includes(column)) || columns.find((column) => ['stock', 'quantity', 'stock_quantity', 'available_quantity', 'quantity_available', 'inventory', 'units_in_stock', 'available_stock'].includes(column));

      if (!idColumn || !stockColumn) {
        continue;
      }

      const whereClause = productVariants
        .map((_, index) => `${quoteIdentifier(idColumn)}::text = $${index + 1}`)
        .join(' OR ');

      const { rows } = await pool.query(
        `SELECT ${quoteIdentifier(idColumn)} AS product_id, ${quoteIdentifier(stockColumn)} AS stock FROM ${quoteIdentifier(table)} WHERE ${whereClause} LIMIT 1`,
        productVariants,
      );

      if (rows.length > 0) {
        return {
          table,
          productId: rows[0].product_id,
          stock: Number(rows[0].stock) || 0,
        };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
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
  res.json({ status: 'ok', database: pool ? 'configured' : 'not-configured', orders: orders.length });
});

app.get('/orders', (_req, res) => {
  res.json({
    message: 'Use POST /orders to create a new order. GET returns this help message.',
    totalOrders: orders.length,
  });
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
    if (!stockInfo || stockInfo.stock < quantity) {
      return res.status(422).json({
        timestamp: new Date().toISOString(),
        status: 422,
        code: 'OUT_OF_STOCK',
        message: `El producto ${productId} no tiene stock suficiente`,
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

  return res.status(201).json({
    orderId: `ORD-${Date.now()}`,
    userId,
    status: 'CREATED',
    totalAmount,
    items: orderItems,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

app.listen(port, () => {
  console.log(`Order service listening on port ${port}`);
});
