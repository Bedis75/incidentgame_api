const { randomUUID } = require("crypto");
const {
  categories,
  CATEGORY_LABEL,
  SPACES,
  TRAP_ACTIVITIES,
  ANSWER_REVEAL_MS,
  QUESTION_TIMEOUT_MS,
  legacyDemoTeamNames,
  legacyDemoPlayerNames,
} = require("../lib/constants");
const { logInfo } = require("../lib/logger");

function createSessionService(repository) {
  function normalizeName(value) {
    return String(value || "").trim();
  }

  function randomFrom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function rollDice() {
    return Math.floor(Math.random() * 6) + 1;
  }

  function findPlayer(session, playerId) {
    return session.players.find((player) => player.id === playerId);
  }

  function findTeam(session, teamId) {
    return session.teams.find((team) => team.id === teamId);
  }

  function assertHost(session, playerId, res) {
    if (session.hostPlayerId !== playerId) {
      res.status(403).json({ error: "Only the session host can perform this action." });
      return false;
    }

    return true;
  }

  function sanitizeSession(session) {
    const leaderboard = [...session.teams]
      .sort((a, b) => b.score.total - a.score.total)
      .map((team) => ({
        teamId: team.id,
        name: team.name,
        total: team.score.total,
        red: team.score.red,
        blue: team.score.blue,
        green: team.score.green,
        playerCount: team.playerIds.length,
      }));

    return {
      code: session.code,
      status: session.status,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      hostPlayerId: session.hostPlayerId,
      players: session.players,
      teams: session.teams,
      scoreEvents: session.scoreEvents,
      activityEvents: Array.isArray(session.activityEvents) ? session.activityEvents : [],
      leaderboard,
    };
  }

  function pushActivityEvent(session, type, message, meta = {}) {
    if (!Array.isArray(session.activityEvents)) {
      session.activityEvents = [];
    }

    session.activityEvents.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      message,
      ...meta,
    });

    if (session.activityEvents.length > 80) {
      session.activityEvents = session.activityEvents.slice(-80);
    }
  }

  function removePlayerFromTeams(session, playerId) {
    for (const team of session.teams) {
      if (team.playerIds.includes(playerId)) {
        team.playerIds = team.playerIds.filter((id) => id !== playerId);
      }
    }
  }

  function rememberRecentlyLeft(session, player) {
    if (!Array.isArray(session.recentlyLeft)) {
      session.recentlyLeft = [];
    }

    const existingIndex = session.recentlyLeft.findIndex(
      (entry) => entry.username.toLowerCase() === player.username.toLowerCase(),
    );

    const entry = {
      username: player.username,
      teamId: player.teamId || null,
      leftAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      session.recentlyLeft[existingIndex] = entry;
    } else {
      session.recentlyLeft.push(entry);
    }

    if (session.recentlyLeft.length > 100) {
      session.recentlyLeft = session.recentlyLeft.slice(-100);
    }
  }

  function applyScore(session, teamId, category, delta, actorPlayerId) {
    const team = findTeam(session, teamId);
    if (!team || !categories.includes(category)) {
      return;
    }

    team.score[category] = Math.max(0, team.score[category] + delta);
    team.score.total = team.score.red + team.score.blue + team.score.green;

    session.scoreEvents.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      teamId,
      category,
      delta,
      actorPlayerId: actorPlayerId || null,
      totalAfter: team.score.total,
    });
  }

  function buildInitialGameState(session) {
    return {
      teams: session.teams.map((team) => ({
        id: team.id,
        name: team.name,
        position: 0,
        wedges: {
          red: Math.max(0, Math.min(2, team.score.red || 0)),
          blue: Math.max(0, Math.min(2, team.score.blue || 0)),
          green: Math.max(0, Math.min(2, team.score.green || 0)),
        },
      })),
      currentTeamIndex: 0,
      lastRoll: null,
      rollSequence: 0,
      turnMessage:
        "Roll d6 and move clockwise. Red/Blue/Green: answer QCM. Neutral: roll again or move +1.",
      pendingQuestion: null,
      pendingQuestionOpenedAt: null,
      answerReveal: null,
      pendingNeutral: false,
      pendingTrap: null,
      winnerId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  function sanitizeGameState(session, viewerPlayerId = "") {
    if (!session.gameState) {
      return null;
    }

    const viewer = viewerPlayerId ? findPlayer(session, viewerPlayerId) : null;

    return {
      ...session.gameState,
      viewerTeamId: viewer?.teamId || null,
      viewerIsHost: Boolean(viewer?.isHost),
      teams: session.gameState.teams.map((teamState) => {
        const team = findTeam(session, teamState.id);
        return {
          ...teamState,
          playerCount: team ? team.playerIds.length : 0,
        };
      }),
    };
  }

  function getActiveGameTeam(session) {
    if (!session.gameState || session.gameState.teams.length === 0) {
      return null;
    }

    return session.gameState.teams[session.gameState.currentTeamIndex] || null;
  }

  function advanceGameTurn(session) {
    if (!session.gameState || session.gameState.teams.length === 0) {
      return;
    }

    session.gameState.currentTeamIndex =
      (session.gameState.currentTeamIndex + 1) % session.gameState.teams.length;
    session.gameState.pendingQuestion = null;
    session.gameState.pendingQuestionOpenedAt = null;
    session.gameState.answerReveal = null;
    session.gameState.pendingNeutral = false;
    session.gameState.pendingTrap = null;
    const nextTeam = getActiveGameTeam(session);
    if (nextTeam) {
      session.gameState.turnMessage = `${nextTeam.name} turn. Roll the dice.`;
    }
    session.gameState.updatedAt = new Date().toISOString();
  }

  function resolveMove(session, steps) {
    const gameState = session.gameState;
    const team = getActiveGameTeam(session);

    if (!gameState || !team) {
      return;
    }

    team.position = (team.position + steps) % SPACES.length;
    const landed = SPACES[team.position];

    if (landed === "neutral") {
      gameState.pendingNeutral = true;
      gameState.pendingQuestion = null;
      gameState.pendingQuestionOpenedAt = null;
      gameState.turnMessage = `${team.name} landed on Neutral. Choose roll again or move +1.`;
      gameState.updatedAt = new Date().toISOString();
      return;
    }

    const deck = repository.getQuestionDeck().filter((question) => question.category === landed);
    if (deck.length === 0) {
      gameState.pendingQuestion = null;
      gameState.pendingQuestionOpenedAt = null;
      gameState.pendingNeutral = false;
      gameState.turnMessage = `${team.name} landed on ${CATEGORY_LABEL[landed]}, but no active question exists for this category.`;
      gameState.updatedAt = new Date().toISOString();
      return;
    }

    gameState.pendingQuestion = randomFrom(deck);
    gameState.pendingQuestionOpenedAt = Date.now();
    gameState.pendingNeutral = false;
    gameState.turnMessage = `${team.name} landed on ${CATEGORY_LABEL[landed]}. Answer to earn a wedge.`;
    gameState.updatedAt = new Date().toISOString();
  }

  async function ensureGameState(session) {
    let changed = false;

    if (!session.gameState) {
      session.gameState = buildInitialGameState(session);
      changed = true;
    }

    if (session.gameState.answerReveal) {
      const hideAt = Number(session.gameState.answerReveal.hideAt || 0);
      if (hideAt > 0 && Date.now() >= hideAt) {
        advanceGameTurn(session);
        changed = true;
        await repository.saveSession(session);
        return;
      }
    }

    if (session.gameState.pendingQuestion) {
      if (!session.gameState.pendingQuestionOpenedAt) {
        session.gameState.pendingQuestionOpenedAt = Date.now();
        session.gameState.updatedAt = new Date().toISOString();
        changed = true;
      }

      const openedAt = Number(session.gameState.pendingQuestionOpenedAt || 0);
      if (Date.now() - openedAt >= QUESTION_TIMEOUT_MS) {
        const activeTeam = getActiveGameTeam(session);
        if (!activeTeam) {
          return;
        }

        const timedOutQuestion = session.gameState.pendingQuestion;
        session.gameState.pendingQuestion = null;
        session.gameState.pendingQuestionOpenedAt = null;
        session.gameState.answerReveal = {
          question: timedOutQuestion,
          selectedOptionIndex: -1,
          correct: false,
          correctOptionIndex: timedOutQuestion.correctOptionIndex,
          teamId: activeTeam.id,
          teamName: activeTeam.name,
          hideAt: Date.now() + ANSWER_REVEAL_MS,
        };
        session.gameState.turnMessage = `${activeTeam.name} timed out. Showing the correct answer.`;
        session.gameState.updatedAt = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) {
      await repository.saveSession(session);
    }
  }

  function assertActorCanPlayCurrentTurn(session, actorPlayerId, res) {
    const normalizedActor = normalizeName(actorPlayerId);
    if (!normalizedActor) {
      res.status(400).json({ error: "actorPlayerId is required for gameplay actions." });
      return null;
    }

    const actor = findPlayer(session, normalizedActor);
    if (!actor) {
      res.status(404).json({ error: "Actor player not found." });
      return null;
    }

    const activeTeam = getActiveGameTeam(session);
    if (!activeTeam) {
      res.status(409).json({ error: "No active team." });
      return null;
    }

    if (!actor.teamId || actor.teamId !== activeTeam.id) {
      res.status(403).json({ error: "Only players in the active team can perform this action." });
      return null;
    }

    return { actor, activeTeam };
  }

  function cleanupLegacySessionData(session) {
    const hasLegacyTeams =
      session.teams.length === 4 &&
      session.teams.every((team) => legacyDemoTeamNames.has(normalizeName(team.name).toLowerCase()));

    if (!hasLegacyTeams) {
      return false;
    }

    session.teams = [];
    session.players = session.players.filter((player) => {
      if (player.isHost) {
        player.teamId = null;
        return true;
      }

      return !legacyDemoPlayerNames.has(normalizeName(player.username).toLowerCase());
    });

    for (const player of session.players) {
      player.teamId = null;
    }

    return true;
  }

  async function getSessionOr404(req, res) {
    const code = String(req.params.code || "").toUpperCase();
    const session = await repository.loadSession(code);
    if (!session) {
      res.status(404).json({ error: "Session not found." });
      return null;
    }

    return session;
  }

  return {
    getRoot: (req, res) => {
      res.json({
        message: "Incident Game API running",
        version: "1.0.0",
        storageMode: repository.getStorageMode(),
        endpoints: [
          "POST /api/sessions",
          "POST /api/sessions/:code/join",
          "GET /api/sessions/:code",
          "GET /api/sessions/:code/players",
          "POST /api/sessions/:code/players/:playerId/team",
          "POST /api/sessions/:code/players/:playerId/kick",
          "POST /api/sessions/:code/leave",
          "POST /api/sessions/:code/teams",
          "POST /api/sessions/:code/start",
          "GET /api/sessions/:code/game-state",
          "POST /api/sessions/:code/game/roll",
          "POST /api/sessions/:code/game/neutral",
          "POST /api/sessions/:code/game/answer",
          "POST /api/sessions/:code/game/trap-attempt",
          "POST /api/sessions/:code/game/trap-result",
          "POST /api/sessions/:code/score",
          "GET /api/sessions/:code/leaderboard",
          "POST /api/sessions/:code/reset-scores",
          "DELETE /api/sessions/:code",
        ],
      });
    },

    createSession: async (req, res) => {
      const username = normalizeName(req.body?.username);
      if (!username) {
        res.status(400).json({ error: "username is required." });
        return;
      }

      const hostPlayerId = randomUUID();
      const sessionCode = await repository.createUniqueSessionCode();

      const hostPlayer = {
        id: hostPlayerId,
        username,
        isHost: true,
        teamId: null,
        joinedAt: new Date().toISOString(),
      };

      const session = {
        code: sessionCode,
        status: "lobby",
        createdAt: new Date().toISOString(),
        startedAt: null,
        hostPlayerId,
        players: [hostPlayer],
        teams: [],
        scoreEvents: [],
        activityEvents: [],
        recentlyLeft: [],
        gameState: null,
      };

      pushActivityEvent(session, "host-created", `${username} created the session.`, {
        playerId: hostPlayerId,
        username,
      });

      await repository.saveSession(session);
      logInfo("session.created", {
        code: sessionCode,
        hostPlayerId,
        hostUsername: username,
      });

      res.status(201).json({
        session: sanitizeSession(session),
        player: hostPlayer,
      });
    },

    joinSession: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const username = normalizeName(req.body?.username);
      if (!username) {
        res.status(400).json({ error: "username is required." });
        return;
      }

      const duplicatePlayer = session.players.find(
        (player) => player.username.toLowerCase() === username.toLowerCase(),
      );

      if (duplicatePlayer) {
        res.status(409).json({ error: "This username is already in the session." });
        return;
      }

      const player = {
        id: randomUUID(),
        username,
        isHost: false,
        teamId: null,
        joinedAt: new Date().toISOString(),
      };

      const recentlyLeft = Array.isArray(session.recentlyLeft)
        ? session.recentlyLeft.find((entry) => entry.username.toLowerCase() === username.toLowerCase())
        : null;

      if (session.status !== "lobby" && !recentlyLeft) {
        res.status(409).json({ error: "Session has already started." });
        return;
      }

      if (recentlyLeft?.teamId) {
        const previousTeam = findTeam(session, recentlyLeft.teamId);
        if (previousTeam) {
          player.teamId = previousTeam.id;
          if (!previousTeam.playerIds.includes(player.id)) {
            previousTeam.playerIds.push(player.id);
          }
        }
      }

      session.players.push(player);
      if (Array.isArray(session.recentlyLeft)) {
        session.recentlyLeft = session.recentlyLeft.filter(
          (entry) => entry.username.toLowerCase() !== username.toLowerCase(),
        );
      }

      pushActivityEvent(
        session,
        recentlyLeft ? "player-rejoined" : "player-joined",
        recentlyLeft ? `${player.username} has rejoined the game.` : `${player.username} has joined the game.`,
        {
          playerId: player.id,
          username: player.username,
          teamId: player.teamId,
        },
      );

      await repository.saveSession(session);
      await repository.touchPlayerLastSeen(session.code, player.id);
      logInfo("session.player.joined", {
        code: session.code,
        playerId: player.id,
        username: player.username,
        playersAfterJoin: session.players.length,
      });

      res.status(201).json({
        session: sanitizeSession(session),
        player,
        reconnected: Boolean(recentlyLeft),
      });
    },

    leaveSession: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const playerId = normalizeName(req.body?.playerId);
      if (!playerId) {
        res.status(400).json({ error: "playerId is required." });
        return;
      }

      const player = findPlayer(session, playerId);
      if (!player) {
        res.status(200).json({ message: "Player already left the session." });
        return;
      }

      if (player.isHost || player.id === session.hostPlayerId) {
        await repository.deleteSessionByCode(session.code);
        logInfo("session.closed_by_host", {
          code: session.code,
          hostPlayerId: player.id,
          hostUsername: player.username,
        });
        res.json({
          message: "Host left. Session closed.",
          sessionClosed: true,
          closedByHost: player.username,
        });
        return;
      }

      removePlayerFromTeams(session, player.id);
      rememberRecentlyLeft(session, player);
      session.players = session.players.filter((existing) => existing.id !== player.id);

      pushActivityEvent(session, "player-left", `${player.username} has quit the game.`, {
        playerId: player.id,
        username: player.username,
        teamId: player.teamId,
      });

      await repository.saveSession(session);
      logInfo("session.player.left", {
        code: session.code,
        playerId: player.id,
        username: player.username,
        remainingPlayers: session.players.length,
      });

      res.json({
        message: "Player left the session.",
        sessionClosed: false,
        session: sanitizeSession(session),
      });
    },

    kickPlayer: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const hostPlayerId = normalizeName(req.body?.hostPlayerId);
      if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
        return;
      }

      const targetPlayerId = normalizeName(req.params.playerId);
      const targetPlayer = findPlayer(session, targetPlayerId);
      if (!targetPlayer) {
        res.status(404).json({ error: "Player not found." });
        return;
      }

      if (targetPlayer.id === session.hostPlayerId || targetPlayer.isHost) {
        res.status(409).json({ error: "Host cannot be kicked." });
        return;
      }

      removePlayerFromTeams(session, targetPlayer.id);
      rememberRecentlyLeft(session, targetPlayer);
      session.players = session.players.filter((player) => player.id !== targetPlayer.id);

      pushActivityEvent(session, "player-kicked", `${targetPlayer.username} was removed by host.`, {
        playerId: targetPlayer.id,
        username: targetPlayer.username,
        teamId: targetPlayer.teamId,
      });

      await repository.saveSession(session);
      logInfo("session.player.kicked", {
        code: session.code,
        hostPlayerId,
        kickedPlayerId: targetPlayer.id,
        kickedUsername: targetPlayer.username,
      });

      res.json({
        message: "Player removed from session.",
        session: sanitizeSession(session),
      });
    },

    getSession: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const cleaned = cleanupLegacySessionData(session);
      if (cleaned) {
        await repository.saveSession(session);
      }

      res.json({ session: sanitizeSession(session) });
    },

    getPlayers: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;
      res.json({ players: session.players });
    },

    setPlayerTeam: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const playerId = String(req.params.playerId || "");
      const teamId = normalizeName(req.body?.teamId);

      const player = findPlayer(session, playerId);
      if (!player) {
        res.status(404).json({ error: "Player not found." });
        return;
      }

      if (!teamId) {
        res.status(400).json({ error: "teamId is required." });
        return;
      }

      const team = findTeam(session, teamId);
      if (!team) {
        res.status(404).json({ error: "Team not found." });
        return;
      }

      if (player.teamId && player.teamId !== team.id) {
        const previousTeam = findTeam(session, player.teamId);
        if (previousTeam) {
          previousTeam.playerIds = previousTeam.playerIds.filter((id) => id !== player.id);
        }
      }

      player.teamId = team.id;
      if (!team.playerIds.includes(player.id)) {
        team.playerIds.push(player.id);
      }

      await repository.saveSession(session);

      res.json({ message: "Player assigned to team.", player, team });
    },

    saveTeams: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const hostPlayerId = normalizeName(req.body?.hostPlayerId);
      if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
        return;
      }

      if (session.status !== "lobby") {
        res.status(409).json({ error: "Teams cannot be modified after game start." });
        return;
      }

      const incomingTeams = Array.isArray(req.body?.teams) ? req.body.teams : null;
      if (!incomingTeams || incomingTeams.length === 0) {
        res.status(400).json({ error: "teams must be a non-empty array." });
        return;
      }

      const createdTeams = [];
      for (const rawTeam of incomingTeams) {
        const name = normalizeName(rawTeam?.name);
        if (!name) {
          res.status(400).json({ error: "Every team must have a name." });
          return;
        }

        createdTeams.push({
          id: randomUUID(),
          name,
          playerIds: [],
          score: { red: 0, blue: 0, green: 0, total: 0 },
        });
      }

      session.teams = createdTeams;
      session.gameState = null;

      for (const player of session.players) {
        player.teamId = null;
      }

      const skippedPlayers = [];

      for (let teamIndex = 0; teamIndex < incomingTeams.length; teamIndex += 1) {
        const rawTeam = incomingTeams[teamIndex];
        const team = createdTeams[teamIndex];
        const players = Array.isArray(rawTeam?.players) ? rawTeam.players : [];

        for (const rawName of players) {
          const username = normalizeName(rawName);
          if (!username) continue;

          const player = session.players.find(
            (existing) => existing.username.toLowerCase() === username.toLowerCase(),
          );

          if (!player) {
            skippedPlayers.push(username);
            continue;
          }

          player.teamId = team.id;
          if (!team.playerIds.includes(player.id)) {
            team.playerIds.push(player.id);
          }
        }
      }

      await repository.saveSession(session);

      res.json({
        message: "Teams saved.",
        skippedPlayers,
        session: sanitizeSession(session),
      });
    },

    startSession: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const hostPlayerId = normalizeName(req.body?.hostPlayerId);
      if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
        return;
      }

      if (session.status === "in-game") {
        res.status(409).json({ error: "Session already started." });
        return;
      }

      if (session.teams.length === 0) {
        res.status(400).json({ error: "Create teams before starting the game." });
        return;
      }

      session.status = "in-game";
      session.startedAt = new Date().toISOString();
      session.gameState = buildInitialGameState(session);

      await repository.saveSession(session);
      logInfo("session.started", {
        code: session.code,
        hostPlayerId,
        teamCount: session.teams.length,
        playerCount: session.players.length,
      });

      res.json({ message: "Session started.", session: sanitizeSession(session) });
    },

    getGameState: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const viewerPlayerId = normalizeName(req.query?.playerId);
      res.json({ gameState: sanitizeGameState(session, viewerPlayerId) });
    },

    roll: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const gameState = session.gameState;
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);
      const actorContext = assertActorCanPlayCurrentTurn(session, actorPlayerId, res);
      if (!actorContext) {
        return;
      }

      if (
        gameState.winnerId ||
        gameState.pendingQuestion ||
        gameState.answerReveal ||
        gameState.pendingNeutral ||
        gameState.pendingTrap
      ) {
        res.status(409).json({
          error: "Current turn is waiting for another action.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      const rollValue = rollDice();
      gameState.lastRoll = rollValue;
      gameState.rollSequence = Number(gameState.rollSequence || 0) + 1;
      resolveMove(session, rollValue);

      await repository.saveSession(session);

      res.json({ gameState: sanitizeGameState(session, actorPlayerId), roll: rollValue });
    },

    neutralDecision: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const gameState = session.gameState;
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);
      const actorContext = assertActorCanPlayCurrentTurn(session, actorPlayerId, res);
      if (!actorContext) {
        return;
      }

      if (!gameState.pendingNeutral) {
        res.status(409).json({
          error: "No pending neutral decision.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      const choice = normalizeName(req.body?.choice).toLowerCase();
      if (choice !== "roll" && choice !== "plus") {
        res.status(400).json({ error: "choice must be roll or plus." });
        return;
      }

      const steps = choice === "roll" ? rollDice() : 1;
      gameState.pendingNeutral = false;
      gameState.lastRoll = steps;
      gameState.rollSequence = Number(gameState.rollSequence || 0) + 1;
      resolveMove(session, steps);

      await repository.saveSession(session);
      res.json({ gameState: sanitizeGameState(session, actorPlayerId), roll: steps });
    },

    answerQuestion: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const gameState = session.gameState;
      const pendingQuestion = gameState.pendingQuestion;
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);
      const actorContext = assertActorCanPlayCurrentTurn(session, actorPlayerId, res);
      if (!actorContext) {
        return;
      }

      if (!pendingQuestion) {
        res.status(409).json({
          error: "No pending question.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      const selectedOptionIndex = Number(req.body?.selectedOptionIndex);
      if (!Number.isInteger(selectedOptionIndex)) {
        res.status(400).json({ error: "selectedOptionIndex must be an integer." });
        return;
      }

      const activeTeam = actorContext.activeTeam;
      const correct = selectedOptionIndex === pendingQuestion.correctOptionIndex;

      if (correct && activeTeam.wedges[pendingQuestion.category] < 2) {
        activeTeam.wedges[pendingQuestion.category] += 1;
        applyScore(session, activeTeam.id, pendingQuestion.category, 1, actorPlayerId || null);
      }

      gameState.turnMessage = correct
        ? `${activeTeam.name} answered correctly. ${CATEGORY_LABEL[pendingQuestion.category]} wedge awarded (max 2).`
        : `${activeTeam.name} answered wrong. Turn ends.`;

      gameState.pendingQuestion = null;
      gameState.pendingQuestionOpenedAt = null;
      gameState.answerReveal = {
        question: pendingQuestion,
        selectedOptionIndex,
        correct,
        correctOptionIndex: pendingQuestion.correctOptionIndex,
        teamId: activeTeam.id,
        teamName: activeTeam.name,
        hideAt: Date.now() + ANSWER_REVEAL_MS,
      };
      gameState.updatedAt = new Date().toISOString();

      await repository.saveSession(session);

      res.json({
        gameState: sanitizeGameState(session, actorPlayerId),
        correct,
        selectedOptionIndex,
        correctOptionIndex: pendingQuestion.correctOptionIndex,
      });
    },

    trapAttempt: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const gameState = session.gameState;
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);
      const actorContext = assertActorCanPlayCurrentTurn(session, actorPlayerId, res);
      if (!actorContext) {
        return;
      }
      const activeTeam = actorContext.activeTeam;

      if (
        gameState.winnerId ||
        gameState.pendingQuestion ||
        gameState.answerReveal ||
        gameState.pendingNeutral ||
        gameState.pendingTrap
      ) {
        res.status(409).json({
          error: "Current turn is waiting for another action.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      const hasAllWedges =
        activeTeam.wedges.red >= 2 && activeTeam.wedges.blue >= 2 && activeTeam.wedges.green >= 2;
      if (!hasAllWedges) {
        res.status(409).json({
          error: "Team does not have all wedges.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      gameState.pendingTrap = {
        context: "championship",
        activity: randomFrom(TRAP_ACTIVITIES),
      };
      gameState.turnMessage = "Championship trap activity: succeed to win, fail and lose one wedge.";
      gameState.updatedAt = new Date().toISOString();

      await repository.saveSession(session);
      res.json({ gameState: sanitizeGameState(session, actorPlayerId) });
    },

    trapResult: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      await ensureGameState(session);
      const gameState = session.gameState;
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);
      const actorContext = assertActorCanPlayCurrentTurn(session, actorPlayerId, res);
      if (!actorContext) {
        return;
      }

      const activeTeam = actorContext.activeTeam;
      if (!gameState.pendingTrap) {
        res.status(409).json({
          error: "No pending trap result.",
          gameState: sanitizeGameState(session, actorPlayerId),
        });
        return;
      }

      const success = Boolean(req.body?.success);
      gameState.pendingTrap = null;

      if (success) {
        gameState.winnerId = activeTeam.id;
        gameState.turnMessage = `${activeTeam.name} succeeded in the championship trap and is crowned Incident Management Champion.`;
        gameState.updatedAt = new Date().toISOString();
        await repository.saveSession(session);
        res.json({ gameState: sanitizeGameState(session, actorPlayerId) });
        return;
      }

      const available = categories.filter((category) => activeTeam.wedges[category] > 0);
      if (available.length > 0) {
        const removeFrom = randomFrom(available);
        activeTeam.wedges[removeFrom] -= 1;
        applyScore(session, activeTeam.id, removeFrom, -1, actorPlayerId || null);
      }

      gameState.turnMessage = `${activeTeam.name} failed the championship trap and lost one wedge.`;
      gameState.updatedAt = new Date().toISOString();
      advanceGameTurn(session);

      await repository.saveSession(session);
      res.json({ gameState: sanitizeGameState(session, actorPlayerId) });
    },

    updateScore: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      if (session.status !== "in-game") {
        res.status(409).json({ error: "Session is not in-game." });
        return;
      }

      const teamId = normalizeName(req.body?.teamId);
      const category = normalizeName(req.body?.category).toLowerCase();
      const delta = Number(req.body?.delta ?? 1);
      const actorPlayerId = normalizeName(req.body?.actorPlayerId);

      if (!teamId) {
        res.status(400).json({ error: "teamId is required." });
        return;
      }

      if (!categories.includes(category)) {
        res.status(400).json({ error: "category must be red, blue, or green." });
        return;
      }

      if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ error: "delta must be a non-zero number." });
        return;
      }

      const team = findTeam(session, teamId);
      if (!team) {
        res.status(404).json({ error: "Team not found." });
        return;
      }

      if (actorPlayerId) {
        const actor = findPlayer(session, actorPlayerId);
        if (!actor) {
          res.status(404).json({ error: "Actor player not found." });
          return;
        }
      }

      const nextCategoryScore = Math.max(0, team.score[category] + delta);
      team.score[category] = nextCategoryScore;
      team.score.total = team.score.red + team.score.blue + team.score.green;

      const scoreEvent = {
        id: randomUUID(),
        at: new Date().toISOString(),
        teamId,
        category,
        delta,
        actorPlayerId: actorPlayerId || null,
        totalAfter: team.score.total,
      };
      session.scoreEvents.push(scoreEvent);

      await repository.saveSession(session);
      res.json({ message: "Score updated.", scoreEvent, team });
    },

    getLeaderboard: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const leaderboard = [...session.teams]
        .sort((a, b) => b.score.total - a.score.total)
        .map((team) => ({
          teamId: team.id,
          name: team.name,
          score: team.score,
          players: team.playerIds.map((playerId) =>
            session.players.find((player) => player.id === playerId),
          ),
        }));

      res.json({
        sessionCode: session.code,
        leaderboard,
      });
    },

    resetScores: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const hostPlayerId = normalizeName(req.body?.hostPlayerId);
      if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
        return;
      }

      for (const team of session.teams) {
        team.score = { red: 0, blue: 0, green: 0, total: 0 };
      }
      session.scoreEvents = [];

      await repository.saveSession(session);
      res.json({ message: "Scores reset.", session: sanitizeSession(session) });
    },

    deleteSession: async (req, res) => {
      const session = await getSessionOr404(req, res);
      if (!session) return;

      const hostPlayerId = normalizeName(req.body?.hostPlayerId);
      if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
        return;
      }

      await repository.deleteSessionByCode(session.code);
      logInfo("session.deleted", {
        code: session.code,
        requestedBy: hostPlayerId,
      });
      res.json({ message: "Session deleted." });
    },
  };
}

module.exports = {
  createSessionService,
};
