// ==========================================
// Grupo 5 - Order Management
// Crear y administrar el ciclo de vida de un pedido.
// Integración:
// G2 -> Autenticación
// G7 -> Inventario
// G6 -> Pagos
// G8 -> Despacho
// ==========================================

const express = require("express");
const cors = require("cors");
const dns = require("dns");
const path = require('path');
const dotenv = require("dotenv");
const { Pool } = require("pg");
const axios = require("axios");
const crypto = require("crypto");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ==========================================
// URLs de integración
// ==========================================

const G2_BASE_URL =
    process.env.G2_BASE_URL ||
    "https://auth-minimarket-cloud.onrender.com";

const G6_BASE_URL =
    process.env.G6_BASE_URL ||
    "https://payment-service-g6-1.onrender.com";

const G7_BASE_URL =
    process.env.G7_BASE_URL ||
    "https://inventario-g7.onrender.com";

const G8_BASE_URL =
    process.env.G8_BASE_URL ||
    "https://arq-microservicio-de-despacho-y-logistica.onrender.com";


// ==========================================
// Base de datos
// ==========================================

const normalizeConnectionString = (connectionString) => {
    if (!connectionString) return undefined;

    if (connectionString.includes("sslmode="))
        return connectionString;

    return connectionString.includes("?")
        ? `${connectionString}&sslmode=require`
        : `${connectionString}?sslmode=require`;
};

const dbUrl = process.env.DATABASE_URL
    ? normalizeConnectionString(process.env.DATABASE_URL)
    : undefined;

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
            database: url.pathname.slice(1),
            ssl: {
                rejectUnauthorized: false
            },
            family: 4

        };

    } catch (err) {

        console.error("DATABASE_URL:", err.message);

        return null;

    }

};

let pool = null;
let dbAvailable = false;
let dbErrorMessage = null;

const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// ==========================================
// G2
// Validación de token
// ==========================================

async function validateTokenWithG2(authHeader) {

    if (!authHeader || !authHeader.startsWith("Bearer "))
        return null;

    try {

        const response = await axios.get(

            `${G2_BASE_URL}/auth/validate`,

            {

                headers: {

                    Authorization: authHeader,
                    "X-Consumer": "order-service"

                }

            }

        );

        return response.data;

    } catch (error) {

        console.error("Error validando token con G2");

        return null;

    }

}


// ==========================================
// G7
// Reserva de stock
// ==========================================

async function reserveStockWithG7(
    orderNumber,
    orderItems,
    idempotencyKey
) {

    try {

        const response = await axios.post(

            `${G7_BASE_URL}/inventory/reserve`,

            {

                orderId: orderNumber,

                items: orderItems.map(item => ({

                    productId: item.productId,
                    quantity: item.quantity

                }))

            },

            {

                headers: {

                    "Idempotency-Key": idempotencyKey

                }

            }

        );

        return response.data;

    } catch (error) {

        if (error.response) {

            throw {

                status: error.response.status,
                data: error.response.data

            };

        }

        throw error;

    }

}


// ==========================================
// G7
// Liberar reserva
// ==========================================

async function releaseReservationWithG7(orderNumber) {

    try {

        await axios.post(

            `${G7_BASE_URL}/inventory/release`,

            {

                orderId: orderNumber

            }

        );

    } catch (error) {

        console.error(
            "No fue posible liberar la reserva en G7"
        );

    }

}


// ==========================================
// G7
// Confirmar reserva
// ==========================================

async function confirmReservationWithG7(orderNumber) {

    try {

        await axios.post(

            `${G7_BASE_URL}/inventory/confirm`,

            {

                orderId: orderNumber

            }

        );

    } catch (error) {

        console.error(
            "No fue posible confirmar la reserva en G7"
        );

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
// POST /orders
// Crear pedido (Integrado G2 + G7)
// ==========================================

app.post("/orders", async (req, res) => {

    const authHeader = req.headers["authorization"];

    const idempotencyKey =
        req.headers["idempotency-key"];

    const correlationId =
        req.headers["x-correlation-id"] || "local";

    const now = new Date().toISOString();


    //---------------------------------------
    // Validar token G2
    //---------------------------------------

    const userProfile =
        await validateTokenWithG2(authHeader);

    if (!userProfile) {

        return res.status(401).json({

            timestamp: now,
            status: 401,
            code: "UNAUTHORIZED",
            message: "Token inválido.",
            correlationId

        });

    }


    const userId =
        userProfile.business_user_id;

    if (!userId) {

        return res.status(422).json({

            timestamp: now,
            status: 422,
            code: "MISSING_BUSINESS_USER_ID",
            message: "business_user_id inexistente.",
            correlationId

        });

    }


    //---------------------------------------
    // Validar body
    //---------------------------------------

    const { items } = req.body || {};

    if (
        !Array.isArray(items) ||
        items.length === 0
    ) {

        return res.status(400).json({

            timestamp: now,
            status: 400,
            code: "INVALID_REQUEST",
            message: "items requerido.",
            correlationId

        });

    }


    if (!idempotencyKey) {

        return res.status(400).json({

            timestamp: now,
            status: 400,
            code: "MISSING_IDEMPOTENCY_KEY",
            message: "Idempotency-Key requerido.",
            correlationId

        });

    }


    //---------------------------------------
    // BD disponible
    //---------------------------------------

    if (!pool || !dbAvailable) {

        return res.status(500).json({

            timestamp: now,
            status: 500,
            code: "DATABASE_UNAVAILABLE",
            message: "Base de datos no disponible.",
            correlationId

        });

    }


    //---------------------------------------
    // Construir items
    //---------------------------------------

    const orderItems = [];

    for (const item of items) {

        const productId =
            String(item.productId).trim();

        const quantity =
            Number(item.quantity);

        const unitPrice =
            Number(item.unitPrice);

        if (
            !productId ||
            quantity <= 0
        ) {

            return res.status(400).json({

                timestamp: now,
                status: 400,
                code: "INVALID_ITEM",
                message: "Producto inválido.",
                correlationId

            });

        }

        orderItems.push({

            productId,
            quantity,
            unitPrice,
            subtotal:
                quantity * unitPrice

        });

    }


    //---------------------------------------
    // Total
    //---------------------------------------

    const totalAmount =
        orderItems.reduce(

            (sum, item) =>
                sum + item.subtotal,

            0

        );


    //---------------------------------------
    // Número de orden
    //---------------------------------------

    const orderNumber =
        `ORD-${Date.now()}`;


    //---------------------------------------
    // Reservar stock en G7
    //---------------------------------------

    let reservation;

    try {

        reservation =
            await reserveStockWithG7(

                orderNumber,
                orderItems,
                idempotencyKey

            );

        console.log(
            "Reserva creada:",
            reservation
        );

    }

    catch (err) {

        return res.status(

            err.status || 500

        ).json({

            timestamp: now,
            status:
                err.status || 500,

            code:
                "STOCK_RESERVATION_FAILED",

            message:
                "No fue posible reservar stock.",

            details:
                err.data,

            correlationId

        });

    }

    const client =
        await pool.connect();
        
    try {

        await client.query("BEGIN");

        //--------------------------------------------------
        // Crear orden
        //--------------------------------------------------

        let orderUuid;

        try {

            const orderResult = await client.query(

                `INSERT INTO orders
                (
                    order_number,
                    user_id,
                    total_amount,
                    status,
                    idempotency_key,
                    created_at,
                    updated_at
                )

                VALUES

                (
                    $1,
                    $2,
                    $3,
                    'STOCK_RESERVED',
                    $4,
                    $5,
                    $5
                )

                RETURNING id`,

                [

                    orderNumber,
                    userId,
                    totalAmount,
                    idempotencyKey,
                    now

                ]

            );

            orderUuid =
                orderResult.rows[0].id;

        }

        catch (dbErr) {

            //-----------------------------------------
            // Si falla la BD
            // liberar reserva en G7
            //-----------------------------------------

            await releaseReservationWithG7(
                orderNumber
            );

            if (dbErr.code === "23505") {

                await client.query("ROLLBACK");

                return res.status(409).json({

                    timestamp: now,
                    status: 409,
                    code: "IDEMPOTENCY_CONFLICT",
                    message:
                        "La orden ya existe.",

                    correlationId

                });

            }

            throw dbErr;

        }


        //--------------------------------------------------
        // Historial
        //--------------------------------------------------

        await client.query(

            `INSERT INTO order_status_history

            (
                order_id,
                previous_status,
                new_status,
                reason,
                changed_at
            )

            VALUES

            (
                $1,
                NULL,
                'STOCK_RESERVED',
                'Stock reservado correctamente.',
                $2
            )`,

            [

                orderUuid,
                now

            ]

        );


        //--------------------------------------------------
        // Items
        //--------------------------------------------------

        for (const item of orderItems) {

            await client.query(

                `INSERT INTO order_items

                (
                    order_id,
                    product_id,
                    quantity,
                    unit_price,
                    subtotal,
                    created_at
                )

                VALUES

                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6
                )`,

                [

                    orderUuid,
                    item.productId,
                    item.quantity,
                    item.unitPrice,
                    item.subtotal,
                    now

                ]

            );

        }


        //--------------------------------------------------
        // Outbox
        //--------------------------------------------------

        await client.query(

            `INSERT INTO outbox_events

            (
                event_type,
                correlation_id,
                aggregate_id,
                payload,
                occurred_at,
                created_at
            )

            VALUES

            (
                $1,
                $2,
                $3,
                $4,
                $5,
                $5
            )`,

            [

                "OrderCreated",

                correlationId,

                orderUuid,

                JSON.stringify({

                    orderId: orderUuid,

                    orderNumber,

                    reservationId:
                        reservation.reservationId,

                    userId,

                    totalAmount,

                    items: orderItems

                }),

                now

            ]

        );


        //--------------------------------------------------
        // Commit
        //--------------------------------------------------

        await client.query("COMMIT");


        //--------------------------------------------------
        // Respuesta
        //--------------------------------------------------

        return res.status(201).json({

            id: orderUuid,

            orderNumber,

            reservationId:
                reservation.reservationId,

            userId,

            status: "STOCK_RESERVED",

            totalAmount,

            items: orderItems,

            createdAt: now,

            updatedAt: now

        });

    }

    catch (error) {

        //-----------------------------------------
        // Si falla cualquier INSERT
        // liberar reserva
        //-----------------------------------------

        try {

            await client.query("ROLLBACK");

        } catch (_) {}

        await releaseReservationWithG7(
            orderNumber
        );

        console.error(error);

        return res.status(500).json({

            timestamp: now,

            status: 500,

            code: "ORDER_TRANSACTION_FAILED",

            message:
                "No fue posible crear el pedido.",

            error:
                error.message,

            correlationId

        });

    }

    finally {

        client.release();

    }

});

// ==========================================
// GET /orders — Listar pedidos paginados
// ==========================================
app.get('/orders', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'Base de datos no disponible.' });
  }
  const { userId, page = 1, limit = 10 } = req.query;
  if (!userId) {
    return res.status(400).json({ code: 'MISSING_USER_ID', message: 'El parámetro userId es requerido.' });
  }
  const offset = (Number(page) - 1) * Number(limit);
  try {
    const countResult = await pool.query('SELECT COUNT(*) AS total FROM orders WHERE user_id = $1', [userId]);
    const totalItems = Number(countResult.rows[0].total) || 0;
    const ordersResult = await pool.query(
      `SELECT id, order_number, user_id, status, total_amount, created_at, updated_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, Number(limit), offset]
    );
    return res.json({
      data: ordersResult.rows,
      pagination: { totalItems, currentPage: Number(page), limit: Number(limit), totalPages: Math.ceil(totalItems / Number(limit)) }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error al obtener pedidos.', details: error.message });
  }
});

// ==========================================
// GET /orders/:id — Obtener pedido por ID
// ==========================================
app.get('/orders/:id', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'Base de datos no disponible.' });
  }
  const orderId = req.params.id;
  if (!uuidRegex.test(orderId)) {
    return res.status(400).json({ code: 'INVALID_UUID_FORMAT', message: 'El ID debe ser un UUID válido.' });
  }
  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: `La orden ${orderId} no fue encontrada.` });
    }
    const orderData = orderResult.rows[0];
    const itemsResult = await pool.query(
      'SELECT id, product_id, quantity, unit_price, subtotal FROM order_items WHERE order_id = $1', [orderId]
    );
    const historyResult = await pool.query(
      'SELECT previous_status, new_status, reason, changed_at FROM order_status_history WHERE order_id = $1 ORDER BY changed_at ASC', [orderId]
    );
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
    return res.status(500).json({ error: 'Error al consultar la orden.', details: error.message });
  }
});

// ==========================================
// PATCH /orders/:id — Actualizar estado
// ==========================================

// FSM según contrato OpenAPI (grupo-5-order-service-contract-def.yaml)
const VALID_TRANSITIONS = {
  CREATED:         ['STOCK_RESERVED', 'CANCELLED', 'FAILED'],
  STOCK_RESERVED:  ['PAYMENT_PENDING'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED', 'FAILED'],
  PAID:            ['READY_TO_SHIP'],
  READY_TO_SHIP:   ['SHIPPED'],
  SHIPPED:         ['DELIVERED', 'FAILED'],
  CANCELLED:       [],
  FAILED:          [],
  DELIVERED:       [],
};

app.patch('/orders/:id', async (req, res) => {
  if (!pool || !dbAvailable) {
    return res.status(500).json({ error: 'Base de datos no disponible.' });
  }
  const orderId = req.params.id;
  const { status, reason } = req.body || {};
  const correlationId = req.headers['x-correlation-id'] || 'local';
  const now = new Date().toISOString();

  if (!uuidRegex.test(orderId)) {
    return res.status(400).json({ code: 'INVALID_UUID_FORMAT', message: 'El ID debe ser un UUID válido.' });
  }
  if (!status) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'El campo status es requerido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT status, order_number, user_id FROM orders WHERE id = $1 LIMIT 1', [orderId]
    );
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: `La orden ${orderId} no existe.` });
    }
    const previousStatus = currentResult.rows[0].status;
    const orderNumber = currentResult.rows[0].order_number;
    const userId = currentResult.rows[0].user_id;
    const newStatus = status.toUpperCase();

    const allowedTargets = VALID_TRANSITIONS[previousStatus] ?? [];
    if (!allowedTargets.includes(newStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        timestamp: now,
        status: 400,
        code: 'INVALID_STATUS_TRANSITION',
        message: `Transición inválida: ${previousStatus} → ${newStatus}. Estados permitidos desde ${previousStatus}: [${allowedTargets.join(', ') || 'ninguno'}].`,
        correlationId
      });
    }

    const updatedResult = await client.query(
      'UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
      [newStatus, now, orderId]
    );
    await client.query(
      'INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at) VALUES ($1, $2, $3, $4, $5)',
      [orderId, previousStatus, newStatus, reason || 'Actualización de estado.', now]
    );

    // --- Logica dinamica para evento ---
    let eventType = 'OrderStatusChanged'; // Evento genérico por defecto
    
    if (newStatus === 'READY_TO_SHIP') {
      eventType = 'ReadyToShip'; 
    } else if (newStatus === 'PAID') {
      eventType = 'PaymentApproved';
    } else if (newStatus === 'FAILED') {
      eventType = 'OrderFailed';
    } else if (newStatus === 'CANCELLED') {
      eventType = 'OrderCancelled';
    }

    // Insertar en la tabla outbox_events usando la nueva variable eventType
    await client.query(
      'INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $5)',
      [eventType, correlationId, orderId,
       JSON.stringify({ orderId, orderNumber, userId, previousStatus, newStatus, reason }), now]
    );
    // --- fin logica dinamica---

    if (newStatus === 'PAYMENT_PENDING') {
      const totalAmount = Number(updatedResult.rows[0].total_amount);
      await client.query(
        'INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at) VALUES ($1, $2, $3, $4, $5, $5)',
        ['PaymentPending', correlationId, orderId,
         JSON.stringify({ orderId, orderNumber, userId, totalAmount }), now]
      );
    }

    await client.query('COMMIT');

    return res.json({
      message: 'Estado actualizado con éxito.',
      orderId: updatedResult.rows[0].id,
      orderNumber: updatedResult.rows[0].order_number,
      previousStatus,
      newStatus,
      updatedAt: updatedResult.rows[0].updated_at
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Error al cambiar el estado.', details: error.message });
  } finally {
    client.release();
  }
});

// ==========================================
// ARRANQUE
// ==========================================
const startServer = async () => {
  if (dbUrl) {
    const poolConfig = await parseDatabaseUrl(dbUrl);
    if (poolConfig) {
      pool = new Pool(poolConfig);
      try {
        await pool.query('SELECT 1');
        dbAvailable = true;
        console.log('Postgres connection OK con Supabase');
      } catch (error) {
        dbErrorMessage = error.message;
        console.error('Postgres connection failed:', dbErrorMessage);
      }
    }
  } else {
    console.error('No se detectó DATABASE_URL');
  }
  app.listen(port, () => {
    console.log(`Order service listening on port ${port}`);
  });
};

startServer();