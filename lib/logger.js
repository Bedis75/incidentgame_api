const { randomUUID } = require("crypto");

const REQUEST_LOG_BODY_LIMIT = 200;

function truncateForLog(value, maxLength = REQUEST_LOG_BODY_LIMIT) {
  const normalized = String(value ?? "");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function logInfo(event, details = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event,
      ...details,
    }),
  );
}

function logError(event, error, details = {}) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event,
      ...details,
      errorMessage: error?.message || "Unknown error",
      errorCode: error?.code || null,
    }),
  );
}

function requestLoggerMiddleware(req, res, next) {
  const startedAt = Date.now();
  const requestId = randomUUID().slice(0, 8);
  req.requestId = requestId;

  logInfo("request.start", {
    requestId,
    method: req.method,
    path: req.path,
    query: req.query,
    body: truncateForLog(JSON.stringify(req.body || {})),
  });

  res.on("finish", () => {
    logInfo("request.end", {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
}

module.exports = {
  logInfo,
  logError,
  requestLoggerMiddleware,
};
