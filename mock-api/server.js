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
const amqp = require("amqplib");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

// ==========================================
// URLs de integración
// ==========================================

const RABBITMQ_URL = // Publicación y consumo de eventos
    process.env.RABBITMQ_URL || 
    "amqp://admin_g5:123123@ https://rabbitmq-testeo.onrender.com:5672";

const G2_BASE_URL =
    process.env.G2_BASE_URL ||
    "https://auth-minimarket-cloud.onrender.com";

const G6_BASE_URL =
    process.env.G6_BASE_URL ||
    "https://payment-service-g6-1.onrender.com/api/payments";

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
// RabbitMQ
// Variables globales
// ==========================================

let rabbitConnection = null;
let rabbitChannel = null;

const EXCHANGE_NAME = "payments.events";

// Cola exclusiva del Grupo 5
const QUEUE_NAME = "g5-order-service";

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
                    "Idempotency-Key": idempotencyKey,
                    "X-consumer": "order-service"
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
        console.error("No fue posible liberar la reserva en G7");
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
        console.error("No fue posible confirmar la reserva en G7");
    }
}

// ==========================================
// RabbitMQ
// Conexión
// ==========================================
async function connectRabbitMQ() {
    try {
        rabbitConnection = await amqp.connect(RABBITMQ_URL);
        rabbitConnection.on("close", () => {
            console.log("RabbitMQ desconectado. Reintentando...");
            setTimeout(connectRabbitMQ, 5000);
        });
        rabbitConnection.on("error", (err) => {
            console.error("RabbitMQ Error:", err.message);
        });
        rabbitChannel = await rabbitConnection.createChannel();
        await rabbitChannel.assertExchange(
            EXCHANGE_NAME,
            "topic",
            {
                durable: true
            }
        );
        console.log("RabbitMQ conectado.");
    }
    catch (err) {
        console.error("No fue posible conectar RabbitMQ:",err.message);
        setTimeout(connectRabbitMQ, 5000);
    }
}

// ==========================================
// RabbitMQ
// Publicador Outbox
// ==========================================
async function publishPendingEvents() {
    if (!rabbitChannel || !pool || !dbAvailable)
        return;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await client.query(
            `
            SELECT *
            FROM outbox_events
            WHERE published_at IS NULL
            ORDER BY created_at ASC
            LIMIT 20
            FOR UPDATE SKIP LOCKED
            `
        );
        for (const event of result.rows) {
            const message = {
                eventId: event.event_id,
                eventType: event.event_type,
                version: event.version,
                producer: event.producer,
                correlationId: event.correlation_id,
                occurredAt: event.occurred_at,
                payload: event.payload
            };
            rabbitChannel.publish(
                EXCHANGE_NAME,
                event.event_type,
                Buffer.from(JSON.stringify(message)),
                {
                    persistent: true,
                    messageId: event.event_id,
                    correlationId: event.correlation_id,
                    contentType: "application/json"
                }
            );
            await client.query(
                `
                UPDATE outbox_events
                SET published_at = NOW()
                WHERE id = $1
                `,
                [event.id]
            );
            console.log(`Evento publicado: ${event.event_type}`);
        }
        await client.query("COMMIT");
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error(
            "Error publicando eventos:",
            err.message
        );
    }
    finally {
        client.release();
    }
}

// ==========================================
// RabbitMQ
// Consumer
// ==========================================
async function startConsumer() {
    if (!rabbitChannel)
        return;
    // Crear la cola del Grupo 5
    await rabbitChannel.assertQueue(
        QUEUE_NAME,
        {
            durable: true
        }
    );
    const routingKeys = [
        "payment.approved",
        "payment.rejected",
        "InventoryReleased",
        "ShipmentCreated",
        "ShipmentDelivered",
        "ShipmentFailed"
    ];
    for (const key of routingKeys) {
        await rabbitChannel.bindQueue(
            QUEUE_NAME,
            EXCHANGE_NAME,
            key
        );
    }
    rabbitChannel.consume(
        QUEUE_NAME,
        processMessage,
        {
            noAck: false
        }
    );
    console.log("Consumer iniciado.");
}

// ==========================================
// RabbitMQ
// Procesamiento de mensajes
// ==========================================

async function processMessage(msg) {
    if (!msg)
        return;
    const event = JSON.parse(
        msg.content.toString()
    );
    const routingKey = msg.fields.routingKey;
    const eventId = event.eventId;
    const eventType = event.eventType;
    const producer = event.producer;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        //---------------------------------------------------
        // Verificar si ya fue procesado
        //---------------------------------------------------
        const exists = await client.query(
            `
            SELECT 1
            FROM consumed_events
            WHERE event_id = $1
            `,
            [
                eventId
            ]
        );
        if (exists.rows.length > 0) {
            await client.query("ROLLBACK");
            rabbitChannel.ack(msg);
            return;
        }
        //---------------------------------------------------
        // Procesar evento
        //---------------------------------------------------
        switch (routingKey) {
            case "payment.approved":
                console.log("Pago aprobado");
                await client.query(
                    `
                    UPDATE orders
                    SET status='PAID',
                        updated_at=NOW()
                    WHERE id=$1
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                await client.query(
                    `
                    INSERT INTO order_status_history
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
                        'PAYMENT_PENDING',
                        'PAID',
                        'Pago aprobado por Grupo 6.',
                        NOW()
                    )
                    `,
                    [
                    event.payload.orderId
                    ]
                );
                break;
            case "payment.rejected":
                console.log("Pago rechazado");
                await client.query(
                    `
                    UPDATE orders
                    SET status='FAILED',
                        updated_at=NOW()
                    WHERE id=$1
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                await client.query(
                    `
                    INSERT INTO order_status_history
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
                        'PAYMENT_PENDING',
                        'FAILED',
                        'Pago rechazado por Grupo 6.',
                        NOW()
                    )
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                break;
            case "ShipmentCreated":
                console.log("Despacho creado");
                await client.query(
                    `
                    UPDATE orders
                    SET status='SHIPPED',
                        updated_at=NOW()
                    WHERE id = $1
                    `,
                    [event.payload.orderId]
                );
                const { rows } = await client.query(
                    `
                        SELECT order_number, user_id
                        FROM orders
                        WHERE id = $1
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                const order = rows[0];
                await client.query(
                    `
                    INSERT INTO order_status_history
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
                        'READY_TO_SHIP',
                        'SHIPPED',
                        'Despacho creado por Grupo 8.',
                        NOW()
                    )
                    `,
                    [event.payload.orderId]
                );
                await client.query(
                    `
                    INSERT INTO outbox_events
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
                        NOW(),
                        NOW()
                    )
                    `,
                    [
                        "Shipped.created",
                        event.correlationId,
                        event.payload.orderId,
                        JSON.stringify({
                            orderId: event.payload.orderId,
                            orderNumber: order.order_number,
                            userId: order.user_id,
                            previousStatus: "READY_TO_SHIP",
                            newStatus: "SHIPPED",
                            reason: "ShipmentCreated event received"
                        })
                    ]
                );
                break;
            case "ShipmentDelivered":
                console.log("Pedido entregado");
                await client.query(
                    `
                    UPDATE orders
                    SET status='DELIVERED',
                        updated_at=NOW()
                    WHERE id=$1
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                await client.query(
                    `
                    INSERT INTO order_status_history
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
                        'SHIPPED',
                        'DELIVERED',
                        'Pedido entregado por Grupo 8.',
                        NOW()
                    )
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                break;
            case "ShipmentFailed":
                console.log("Despacho fallido");
                await client.query(
                    `
                    UPDATE orders
                    SET status='FAILED',
                        updated_at=NOW()
                    WHERE id=$1
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                await client.query(
                    `
                    INSERT INTO order_status_history
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
                        'SHIPPED',
                        'FAILED',
                        'Despacho fallido informado por Grupo 8.',
                        NOW()
                    )
                    `,
                    [
                        event.payload.orderId
                    ]
                );
                break;
            case "InventoryReleased":
                console.log("Inventario liberado");
                break;
            default:
                console.log("Evento ignorado:",routingKey);
        }

        //---------------------------------------------------
        // Registrar evento consumido
        //---------------------------------------------------
        await client.query(
            `
            INSERT INTO consumed_events
            (
                event_id,
                event_type,
                producer,
                order_id
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4
            )
            `,
            [
                eventId,
                eventType,
                producer,
                event.payload.orderId || null
            ]
        );
        await client.query("COMMIT");
        rabbitChannel.ack(msg);
    }
    catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        rabbitChannel.nack(
            msg,
            false,
            true
        );
    }
    finally {
        client.release();
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
// Crear pedido (Optimizado con estado CREATED inicial)
// ==========================================

app.post("/orders", async (req, res) => {
    const authHeader = req.headers["authorization"];
    const idempotencyKey = req.headers["idempotency-key"];
    const correlationId = req.headers["x-correlation-id"] || "local";
    const now = new Date().toISOString();

    //---------------------------------------
    // Validar token G2
    //---------------------------------------
    const userProfile = await validateTokenWithG2(authHeader);
    if (!userProfile) {
        return res.status(401).json({
            timestamp: now,
            status: 401,
            code: "UNAUTHORIZED",
            message: "Token inválido.",
            correlationId
        });
    }
    const userId = userProfile.business_user_id;
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
    if (!Array.isArray(items) || items.length === 0) {
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
        const productId = String(item.productId).trim();
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        if (!productId || quantity <= 0) {
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
            subtotal: quantity * unitPrice
        });
    }

    const totalAmount = orderItems.reduce((sum, item) => sum + item.subtotal, 0);
    const orderNumber = `ORD-${Date.now()}`;

    // ==================================================
    // FASE 1: CREAR LA ORDEN EN LA BD EN ESTADO 'CREATED'
    // ==================================================
    const client = await pool.connect();
    let orderUuid;

    try {
        await client.query("BEGIN");

        const orderResult = await client.query(
            `INSERT INTO orders
            (order_number, user_id, total_amount, status, idempotency_key, created_at, updated_at)
            VALUES ($1, $2, $3, 'CREATED', $4, $5, $5)
            RETURNING id`,
            [orderNumber, userId, totalAmount, idempotencyKey, now]
        );
        orderUuid = orderResult.rows[0].id;

        // Historial inicial
        await client.query(
            `INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at)
            VALUES ($1, NULL, 'CREATED', 'Pedido inicializado en el sistema.', $2)`,
            [orderUuid, now]
        );

        // Insertar items de la orden
        for (const item of orderItems) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [orderUuid, item.productId, item.quantity, item.unitPrice, item.subtotal, now]
            );
        }

        await client.query("COMMIT");
        console.log(`Orden registrada con éxito en estado CREATED: ${orderUuid}`);
    }
    catch (dbErr) {
        await client.query("ROLLBACK");
        if (dbErr.code === "23505") {
            return res.status(409).json({
                timestamp: now,
                status: 409,
                code: "IDEMPOTENCY_CONFLICT",
                message: "La orden ya existe.",
                correlationId
            });
        }
        console.error("Error guardando orden inicial:", dbErr);
        return res.status(500).json({
            timestamp: now,
            status: 500,
            code: "ORDER_CREATION_FAILED",
            message: "No se pudo registrar la orden inicial.",
            correlationId
        });
    }

    // ==================================================
    // FASE 2: ENVIAR RESERVA DE STOCK AL GRUPO 7
    // ==================================================
    let reservation;
    try {
        reservation = await reserveStockWithG7(orderNumber, orderItems, idempotencyKey);
        console.log("Reserva exitosa en G7:", reservation);

        // ==================================================
        // FASE 3A: SI OK -> PASAR A 'STOCK_RESERVED'
        // ==================================================
        try {
            await client.query("BEGIN");

            await client.query(
                `UPDATE orders SET status = 'STOCK_RESERVED', updated_at = $1 WHERE id = $2`,
                [now, orderUuid]
            );

            await client.query(
                `INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at)
                VALUES ($1, 'CREATED', 'STOCK_RESERVED', 'Stock reservado correctamente en G7.', $2)`,
                [orderUuid, now]
            );

            // Guardar evento exitoso en Outbox
            await client.query(
                `INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $5)`,
                [
                    "OrderCreated",
                    correlationId,
                    orderUuid,
                    JSON.stringify({
                        orderId: orderUuid,
                        orderNumber,
                        reservationId: reservation.reservationId,
                        userId,
                        totalAmount,
                        items: orderItems
                    }),
                    now
                ]
            );

            await client.query("COMMIT");

            return res.status(201).json({
                id: orderUuid,
                orderNumber,
                reservationId: reservation.reservationId,
                userId,
                status: "STOCK_RESERVED",
                totalAmount,
                items: orderItems,
                createdAt: now,
                updatedAt: now
            });
        } catch (innerErr) {
            await client.query("ROLLBACK");
            throw innerErr;
        }

    } catch (err) {
        // ==================================================
        // FASE 3B: SI FALLA STOCK (422) -> PASAR A 'REJECTED'
        // ==================================================
        console.log("Reserva falló en G7, procediendo a rechazar la orden.");
        
        try {
            await client.query("BEGIN");

            // Pasamos la orden a REJECTED en Supabase
            await client.query(
                `UPDATE orders SET status = 'REJECTED', updated_at = $1 WHERE id = $2`,
                [now, orderUuid]
            );

            await client.query(
                `INSERT INTO order_status_history (order_id, previous_status, new_status, reason, changed_at)
                VALUES ($1, 'CREATED', 'REJECTED', 'Reserva de stock rechazada por Grupo 7.', $2)`,
                [orderUuid, now]
            );

            // ENVIAR EVENTO StockRejected AL OUTBOX CON EL USERID QUE G9 NECESITA
            await client.query(
                `INSERT INTO outbox_events (event_type, correlation_id, aggregate_id, payload, occurred_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $5)`,
                [
                    "OrderRejected",
                    correlationId,
                    orderUuid,
                    JSON.stringify({
                        orderId: orderUuid,
                        orderNumber,
                        userId,
                        reason: err.data?.message || "No fue posible reservar stock por falta de unidades."
                    }),
                    now
                ]
            );

            await client.query("COMMIT");

            // Respondemos con el error de stock pero informando que la orden fue registrada como REJECTED
            return res.status(err.status || 422).json({
                timestamp: now,
                status: err.status || 422,
                code: "STOCK_RESERVATION_FAILED",
                message: "No fue posible reservar stock. Orden rechazada.",
                orderId: orderUuid,
                userId,
                details: err.data,
                correlationId
            });

        } catch (innerErr) {
            await client.query("ROLLBACK");
            console.error("Critical error handling stock rejection rollback:", innerErr);
            return res.status(500).json({
                timestamp: now,
                status: 500,
                code: "ORDER_TRANSACTION_FAILED",
                message: "Error crítico procesando el fallo de stock.",
                error: innerErr.message,
                correlationId
            });
        }
    } finally {
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
    } else if (newStatus === 'SHIPPED') {
        eventType = 'Shipped';
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
        ['payment.pending', correlationId, orderId,
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
                await pool.query("SELECT 1");
                dbAvailable = true;
                console.log("Postgres connection OK con Supabase");
            } catch (error) {
                dbErrorMessage = error.message;
                console.error("Postgres connection failed:", dbErrorMessage);
            }
        }
    } else {
        console.error("No se detectó DATABASE_URL");
    }

    // ==========================================
    // Conectar RabbitMQ
    // ==========================================
    await connectRabbitMQ();

    // ==========================================
    // Iniciar Consumer
    // ==========================================
    await startConsumer();

    // ==========================================
    // Iniciar Publisher
    // ==========================================
    setInterval(
        publishPendingEvents,
        5000
    );
    app.listen(port, () => {
        console.log(`Order service listening on port ${port}`);
    });
};

startServer();