const express = require("express");
const pool = require("../config/database");

const router = express.Router();

router.get("/debug/product/:id", async (req, res) => {
  try {
    const productId = req.params.id;

    if (!productId) {
      return res.status(400).json({
        timestamp: new Date().toISOString(),
        status: 400,
        code: "INVALID_REQUEST",
        message: "El parámetro id es requerido",
      });
    }

    const { rows } = await pool.query(
      "SELECT id, name, price, stock FROM products WHERE id = $1",
      [productId],
    );

    if (rows.length === 0) {
      return res.status(404).json({
        timestamp: new Date().toISOString(),
        status: 404,
        code: "PRODUCT_NOT_FOUND",
        message: `No se encontró el producto ${productId}`,
      });
    }

    return res.json({ product: rows[0] });
  } catch (error) {
    return res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 500,
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
  }
});

module.exports = router;
