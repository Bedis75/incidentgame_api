const express = require("express");
const cors = require("cors");
const { requestLoggerMiddleware } = require("./lib/logger");
const { errorHandlerMiddleware } = require("./middleware/errorHandler");
const { createSessionRouter } = require("./routes/sessionsRoutes");

function createApp(sessionService) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(requestLoggerMiddleware);
  app.use(createSessionRouter(sessionService));
  app.use(errorHandlerMiddleware);
  return app;
}

module.exports = {
  createApp,
};
