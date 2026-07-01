const pool = require("../config/database");

const createOrder = async (req, res, next) => {
  try {
    const { userId, items } = req.body || {};
    const idempotencyKey = req.headers["idempotency-key"];

    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        code: "INVALID_REQUEST",
        message: "El campo userId es requerido",
        correlationId: req.headers["x-correlation-id"] || "local",
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        code: "MISSING_IDEMPOTENCY_KEY",
        message: "El header Idempotency-Key es obligatorio para crear un pedido",
        correlationId: req.headers["x-correlation-id"] || "local",
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        code: "INVALID_REQUEST",
        message: "El campo items es requerido",
        correlationId: req.headers["x-correlation-id"] || "local",
      });
    }

    const orderItems = [];
    let totalAmount = 0;

    for (const item of items) {
      const rawProductId = item?.productId;
      const productId = typeof rawProductId === "string" ? rawProductId.trim() : rawProductId;
      const quantity = Number(item?.quantity);
      const unitPrice = Number(item?.unitPrice || 0);

      if (!productId || Number.isNaN(quantity) || quantity <= 0) {
        return res.status(400).json({
          timestamp: new Date().toISOString(),
          status: 400,
          code: "INVALID_REQUEST",
          message: "Cada item debe incluir productId y una cantidad válida",
          correlationId: req.headers["x-correlation-id"] || "local",
        });
      }

      const productResult = await pool.query(
        "SELECT id, name, price, stock FROM products WHERE id = $1",
        [productId],
      );

      if (productResult.rows.length === 0) {
        return res.status(404).json({
          timestamp: new Date().toISOString(),
          status: 404,
          code: "PRODUCT_NOT_FOUND",
          message: `No se encontró el producto ${productId}`,
          correlationId: req.headers["x-correlation-id"] || "local",
        });
      }

      const product = productResult.rows[0];
      const availableStock = Number(product.stock);

      if (availableStock < quantity) {
        return res.status(422).json({
          timestamp: new Date().toISOString(),
          status: 422,
          code: "OUT_OF_STOCK",
          message: `El producto ${productId} no tiene stock suficiente`,
          correlationId: req.headers["x-correlation-id"] || "local",
        });
      }

      const subtotal = unitPrice * quantity;
      totalAmount += subtotal;

      orderItems.push({
        productId,
        quantity,
        unitPrice,
        subtotal,
      });
    }

    for (const item of orderItems) {
      await pool.query(
        "UPDATE products SET stock = stock - $1 WHERE id = $2",
        [item.quantity, item.productId],
      );
    }

    const now = new Date().toISOString();
    const order = {
      orderId: `ORD-${Date.now()}`,
      userId,
      status: "CREATED",
      totalAmount,
      items: orderItems,
      createdAt: now,
      updatedAt: now,
    };

    return res.status(201).json(order);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOrder,
};
