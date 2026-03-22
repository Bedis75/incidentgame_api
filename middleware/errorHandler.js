const { logError } = require("../lib/logger");

function errorHandlerMiddleware(error, req, res, next) {
  if (error instanceof SyntaxError && "body" in error) {
    logError("request.invalid_json", error, {
      requestId: req.requestId || null,
      method: req.method,
      path: req.path,
    });
    res.status(400).json({ error: "Invalid JSON payload." });
    return;
  }

  if (error) {
    logError("request.unhandled_error", error, {
      requestId: req.requestId || null,
      method: req.method,
      path: req.path,
    });
    res.status(500).json({ error: "Internal server error." });
    return;
  }

  next(error);
}

module.exports = {
  errorHandlerMiddleware,
};
