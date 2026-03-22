require("dotenv").config();

const { createSessionRepository } = require("./repositories/sessionRepository");
const { createSessionService } = require("./services/sessionService");
const { createApp } = require("./app");
const { logInfo, logError } = require("./lib/logger");

const PORT = Number(process.env.PORT || 3001);

async function startServer() {
  const repository = createSessionRepository({
    databaseUrl: process.env.DATABASE_URL,
    pgssl: process.env.PGSSL,
  });

  await repository.initializeStorage();

  const sessionService = createSessionService(repository);
  const app = createApp(sessionService);

  app.listen(PORT, () => {
    logInfo("server.started", {
      url: `http://localhost:${PORT}`,
      storageMode: repository.getStorageMode(),
    });
  });
}

startServer().catch((error) => {
  logError("server.start_failed", error, {
    storageMode: process.env.DATABASE_URL ? "postgres" : "memory",
  });
  process.exit(1);
});
