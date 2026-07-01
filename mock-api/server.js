// ==========================================
// Gurpo 5 Pedidos / Order Management: Crear y administrar el ciclo de vida de un pedido.
// ==========================================
const express = require('express');
const cors = require('cors');
const dns = require('dns');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config(); // solo para desarrollo local

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ==========================================
// CONFIGURACIÓN Y PARSEO DE BASE DE DATOS
// ==========================================
const normalizeConnectionString = (connectionString) => {
  if (!connectionString) return undefined;
  if (connectionString.includes('sslmode=')) return connectionString;
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

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==========================================
// FUNCIONES AUXILIARES DE NEGOCIO
// ==========================================
async function findProductStock(productId) {
  if (!pool || !productId) return null;

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


// ==========================================
// ENDPOINT: HEALTH CHECK
// ==========================================
app.get('/health', async (_req, res) => {
  let totalOrdersCount = 0;
  if (pool && dbAvailable) {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) AS count FROM orders');
      totalOrdersCount = Number(rows[0].count) || 0;
    } catch (err) {
      console.error('Error counting orders in health check:', err.message);
    }
  }
  res.json({ status: 'ok', database: pool ? 'configured' : 'not-configured', dbAvailable, dbErrorMessage, totalOrdersInDb: totalOrdersCount });
});

// ==========================================
// METODO 1: POST /orders (Crear pedido)
// ==========================================
app.post('/orders', async (req, res) => {
  const { userId, items } = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'];
  const correlationId = req.headers['x-correlation-id'] || 'local';
  const now = new Date().toISOString();

  if (!userId || !Array.isArray(items) || items.length === 0 || !idempotencyKey) {
    return res.status(400).json({ timestamp: now, status: 400, code: 'INVALID_REQUEST', message: 'userId, items e idempotency-key son requeridos.', correlationId });
  }

  if (!pool || !dbAvailable) {
    return res.status(500).json({ timestamp: now, status: 500, code: 'DATABASE_UNAVAILABLE', message: 'La base de datos de Supabase no está disponible.', correlationId });
  }

  const orderItems = [];
  for (const item of items) {
    const productId = String(item.productId).trim();
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unitPrice || 0);

    if (!productId || quantity <= 0) {
      return res.status(400).json({ timestamp: now, status: 400, code: 'INVALID_REQUEST', message: 'Cada item requiere un productId y cantidad positiva.', correlationId });
    }

    const stockInfo = await findProductStock(productId);
    if (!stockInfo) {
      return res.status(422).json({ timestamp: now, status: 422, code: 'PRODUCT_NOT_FOUND', message: `No se encontró el producto ${productId}`, correlationId });
    }

    if (stockInfo.stock < quantity) {
      return res.status(422).json({ timestamp: now, status: 422, code: 'OUT_OF_STOCK', message: `El producto ${productId} tiene stock ${stockInfo.stock} y se pidió ${quantity}`, correlationId });
    }

    orderItems.push({ productId, quantity, unitPrice, subtotal: unitPrice * quantity });
  }

  const totalAmount = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
  const orderNumber = `ORD-${Date.now()}`;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertOrderQuery = `
      INSERT INTO orders (order_number, user_id, total_amount, status, idempotency_key, created_at, updated_at)
      VALUES ($1, $2, $3, 'CREATED', $4, $5, $5) RETURNING id;
    `;
    
    let orderUuid;
    try {
      const orderResult = await client.query(insertOrderQuery, [orderNumber, userId, totalAmount, idempotencyKey, now]);
      orderUuid = orderResult.rows[0].id;
    } catch (dbErr) {
      if (dbErr.code === '23505') { 
        await client.query('ROLLBACK');
        return res.status(409).json({ timestamp: now, status: 409, code: 'IDEMPOTENCY_CONFLICT', message: 'Esta orden ya fue procesada previamente.', correlationId });
      }
      throw dbErr;
    }

    await client.query(`INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at) VALUES ($1, NULL, 'CREATED', 'Orden creada de forma exitosa.', $2);`, [orderUuid, now]);

    for (const item of orderItems) {
      await client.query(`INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, created_at) VALUES ($1, $2, $3, $4, $5, $6);`, [orderUuid, item.productId, item.quantity, item.unitPrice, item.subtotal, now]);
      await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2;`, [item.quantity, item.productId]);
    }

    await client.query(`INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $5);`, ['OrderCreated', correlationId, orderUuid, JSON.stringify({ orderId: orderUuid, orderNumber, userId, totalAmount, items: orderItems }), now]);

    await client.query('COMMIT');
    return res.status(201).json({ id: orderUuid, orderNumber, userId, status: 'CREATED', totalAmount, items: orderItems, createdAt: now, updatedAt: now });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de Supabase:', error);
    return res.status(500).json({ timestamp: now, status: 500, code: 'ORDER_TRANSACTION_FAILED', message: 'Error interno al guardar la orden.', error: error.message, correlationId });
  } finally {
    client.release();
  }
});

// ==========================================
// METODO 2: GET /orders (Listar pedidos de usuario paginado)
// ==========================================
app.get('/orders', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'La base de datos de Supabase no está disponible.' });
  }

  const { userId, page = 1, limit = 10 } = req.query;

  if (!userId) {
    return res.status(400).json({ code: 'MISSING_USER_ID', message: 'El parámetro query "userId" es requerido.' });
  }

  const offset = (Number(page) - 1) * Number(limit);

  try {
    const countResult = await pool.query('SELECT COUNT(*) AS total FROM orders WHERE user_id = $1', [userId]);
    const totalItems = Number(countResult.rows[0].total) || 0;

    const ordersQuery = `
      SELECT id, order_number, user_id, status, total_amount, created_at, updated_at 
      FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `;
    const ordersResult = await pool.query(ordersQuery, [userId, Number(limit), offset]);

    return res.json({
      data: ordersResult.rows,
      pagination: { totalItems, currentPage: Number(page), limit: Number(limit), totalPages: Math.ceil(totalItems / Number(limit)) }
    });
  } catch (error) {
    console.error('Error en GET /orders:', error.message);
    return res.status(500).json({ error: 'Error al obtener los pedidos.', details: error.message });
  }
});

// ==========================================
// METODO 3: GET /orders/:id (Obtener pedido por ID)
// ==========================================
app.get('/orders/:id', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'La base de datos de Supabase no está disponible.' });
  }

  const orderId = req.params.id;
  if (!uuidRegex.test(orderId)) {
    return res.status(400).json({ code: 'INVALID_UUID_FORMAT', message: 'El ID de la orden debe ser un UUID válido.' });
  }

  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: `La orden con ID ${orderId} no fue encontrada.` });
    }

    const orderData = orderResult.rows[0];
    const itemsResult = await pool.query('SELECT id, product_id, quantity, unit_price, subtotal FROM order_items WHERE order_id = $1', [orderId]);
    const historyResult = await pool.query('SELECT previous_status, new_status, reason, changed_at FROM order_status_history WHERE order_id = $1 ORDER BY changed_at ASC', [orderId]);

    return res.json({
      id: orderData.id,
      orderNumber: orderData.order_number,
      userId: orderData.user_id,
      status: orderData.status,
      totalAmount: Number(orderData.total_amount),
      idempotencyKey: orderData.idempotency_key,
      createdAt: orderData.created_at,
      updatedAt: orderData.updated_at,
      items: itemsResult.rows,
      history: historyResult.rows
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error interno al consultar la orden.', details: error.message });
  }
});

// ==========================================
// METODO 4: PATCH /orders/:id (Actualizar estado de un pedido)
// ==========================================
app.patch('/orders/:id', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'La base de datos de Supabase no está disponible.' });
  }

  const orderId = req.params.id;
  const { status, reason } = req.body || {};
  const correlationId = req.headers['x-correlation-id'] || 'local';
  const now = new Date().toISOString();

  if (!uuidRegex.test(orderId)) {
    return res.status(400).json({ code: 'INVALID_UUID_FORMAT', message: 'El ID de la orden debe ser un UUID válido.' });
  }

  if (!status) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'El campo "status" es requerido en el body.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentOrderResult = await client.query('SELECT status, order_number, user_id FROM orders WHERE id = $1 LIMIT 1', [orderId]);
    if (currentOrderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `La orden con ID ${orderId} no existe.` });
    }

    const previousStatus = currentOrderResult.rows[0].status;
    const orderNumber = currentOrderResult.rows[0].order_number;
    const userId = currentOrderResult.rows[0].user_id;

    const updatedOrderResult = await client.query('UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *', [status.toUpperCase(), now, orderId]);
    const updatedOrder = updatedOrderResult.rows[0];

    await client.query('INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at) VALUES ($1, $2, $3, $4, $5)', 
      [orderId, previousStatus, status.toUpperCase(), reason || 'Actualización de estado.', now]);

    const eventPayload = { orderId, orderNumber, userId, previousStatus, newStatus: status.toUpperCase(), reason };
    await client.query('INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $5)',
      ['OrderStatusChanged', correlationId, orderId, JSON.stringify(eventPayload), now]);

    await client.query('COMMIT');

    return res.json({
      message: 'Estado de la orden actualizado con éxito.',
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.order_number,
      previousStatus,
      newStatus: updatedOrder.status,
      updatedAt: updatedOrder.updated_at
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en PATCH /orders/:id:', error.message);
    return res.status(500).json({ error: 'Error al cambiar el estado del pedido.', details: error.message });
  } finally {
    client.release();
  }
});

// ==========================================
// ARRANQUE SEGURO Y SINCRONIZADO (REEMPLAZA AL APP.LISTEN VIEJO)
// ==========================================
const startServer = async () => {
  if (dbUrl) {
    poolConfig = await parseDatabaseUrl(dbUrl);
    if (poolConfig) {
      pool = new Pool(poolConfig);
      try {
        // Forzamos a esperar a Supabase antes de abrir el puerto
        await pool.query('SELECT 1');
        dbAvailable = true;
        console.log('✅ Postgres connection OK con Supabase');
      } catch (error) {
        dbErrorMessage = error.message;
        console.error('❌ Postgres connection failed:', dbErrorMessage);
      }
    }
  } else {
    console.error('❌ No se detectó la variable DATABASE_URL');
  }

  // Tu app.listen original ahora vive protegido aquí adentro:
  app.listen(port, () => {
    console.log(`🚀 Order service listening on port ${port}`);
  });
};

// Ejecutamos la función para iniciar todo en el orden correcto
startServer();