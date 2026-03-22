const express = require("express");

function createSessionRouter(service) {
  const router = express.Router();

  router.get("/", service.getRoot);
  router.post("/api/sessions", service.createSession);
  router.post("/api/sessions/:code/join", service.joinSession);
  router.post("/api/sessions/:code/leave", service.leaveSession);
  router.post("/api/sessions/:code/players/:playerId/kick", service.kickPlayer);
  router.get("/api/sessions/:code", service.getSession);
  router.get("/api/sessions/:code/players", service.getPlayers);
  router.post("/api/sessions/:code/players/:playerId/team", service.setPlayerTeam);
  router.post("/api/sessions/:code/teams", service.saveTeams);
  router.post("/api/sessions/:code/start", service.startSession);
  router.get("/api/sessions/:code/game-state", service.getGameState);
  router.post("/api/sessions/:code/game/roll", service.roll);
  router.post("/api/sessions/:code/game/neutral", service.neutralDecision);
  router.post("/api/sessions/:code/game/answer", service.answerQuestion);
  router.post("/api/sessions/:code/game/trap-attempt", service.trapAttempt);
  router.post("/api/sessions/:code/game/trap-result", service.trapResult);
  router.post("/api/sessions/:code/score", service.updateScore);
  router.get("/api/sessions/:code/leaderboard", service.getLeaderboard);
  router.post("/api/sessions/:code/reset-scores", service.resetScores);
  router.delete("/api/sessions/:code", service.deleteSession);

  return router;
}

module.exports = {
  createSessionRouter,
};
