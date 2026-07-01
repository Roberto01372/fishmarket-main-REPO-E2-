const express = require("express");
const cors = require("cors");
const ordersRoutes = require("./routes/orders.routes");
const debugRoutes = require("./routes/debug.routes");
const { notFound, errorHandler } = require("./middlewares/error.middleware");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(ordersRoutes);
app.use(debugRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
