const express = require("express");
const { createOrder } = require("../controllers/orders.controller");

const router = express.Router();

router.post("/orders", createOrder);

module.exports = router;
