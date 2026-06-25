const notFound = (req, res, next) => {
  res.status(404).json({
    timestamp: new Date().toISOString(),
    status: 404,
    code: "NOT_FOUND",
    message: `Ruta no encontrada: ${req.originalUrl}`,
  });
  next();
};

const errorHandler = (err, req, res, next) => {
  console.error(err);

  res.status(err.status || 500).json({
    timestamp: new Date().toISOString(),
    status: err.status || 500,
    code: err.code || "INTERNAL_SERVER_ERROR",
    message: err.message || "Error interno del servidor",
    correlationId: req.headers["x-correlation-id"] || "local",
  });
};

module.exports = {
  notFound,
  errorHandler,
};
