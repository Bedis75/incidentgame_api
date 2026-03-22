require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const USE_POSTGRES = DATABASE_URL.length > 0;
const REQUEST_LOG_BODY_LIMIT = 200;

const sessions = new Map();
const dbPool = USE_POSTGRES
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    })
  : null;
const categories = ["red", "blue", "green"];
const CATEGORY_LABEL = {
  red: "Detection & Logging",
  blue: "Triage & Diagnosis",
  green: "Resolution & Closure",
};
const SPACES = Array.from({ length: 24 }, (_, index) => {
  const cycle = index % 4;
  if (cycle === 0) return "red";
  if (cycle === 1) return "blue";
  if (cycle === 2) return "green";
  return "neutral";
});
const DEFAULT_QUESTION_DECK = [
  {
    category: "red",
    prompt: "What should happen first when an alert triggers?",
    options: [
      "Ignore it until users report impact",
      "Log and create or update an incident ticket",
      "Close monitoring to reduce noise",
      "Jump directly to closure",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "red",
    prompt: "Give one common source of incidents.",
    options: [
      "Monitoring alert or user report",
      "Holiday calendar entry",
      "Coffee machine notification",
      "Office parking shortage",
    ],
    correctOptionIndex: 0,
  },
  {
    category: "red",
    prompt: "What is the purpose of incident classification?",
    options: [
      "To make incident tickets longer",
      "To route and prioritize incidents correctly",
      "To remove SLA commitments",
      "To skip communication",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "What two factors determine incident priority?",
    options: [
      "Age and team size",
      "Impact and urgency",
      "Shift timing and weather",
      "Budget and hardware brand",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "When should an incident be escalated?",
    options: [
      "Only after closure",
      "When SLA risk is high or expertise is missing",
      "Never",
      "Only if no ticket exists",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "Why communicate during triage?",
    options: [
      "To create extra approvals",
      "To align responders and keep stakeholders informed",
      "To delay recovery",
      "To hide incident impact",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "green",
    prompt: "What is a workaround in incident management?",
    options: [
      "A final permanent fix",
      "A temporary action to restore service quickly",
      "A postmortem template",
      "A tool for deleting logs",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "green",
    prompt: "What should be verified before closure?",
    options: [
      "Service restored, fix validated, and users confirmed",
      "Only ticket title updated",
      "Only manager informed",
      "No verification needed",
    ],
    correctOptionIndex: 0,
  },
  {
    category: "green",
    prompt: "Why capture lessons learned?",
    options: [
      "To prevent recurrence and improve response process",
      "To reduce monitoring visibility",
      "To avoid documenting root causes",
      "To skip closure checks",
    ],
    correctOptionIndex: 0,
  },
];
let questionDeck = [...DEFAULT_QUESTION_DECK];
const TRAP_ACTIVITIES = [
  "Name 3 actions to stabilize an incident in 20 seconds.",
  "Give one escalation reason and one communication channel.",
  "State a quick workaround and one verification step.",
  "List impact, urgency, and one SLA-related action.",
  "Name one likely root cause and one containment action.",
  "Give a closure check and one lesson learned item.",
];
const ANSWER_REVEAL_MS = 3000;
const QUESTION_TIMEOUT_MS = 45000;
const legacyDemoTeamNames = new Set([
  "team alpha",
  "team bravo",
  "team charlie",
  "team delta",
]);
const legacyDemoPlayerNames = new Set([
  "nora",
  "ibrahim",
  "lea",
  "mateo",
  "chen",
  "sana",
  "ava",
  "rami",
  "noah",
  "zoe",
  "karim",
  "mina",
]);

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

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
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
});

async function initializeStorage() {
  if (!USE_POSTGRES || !dbPool) {
    questionDeck = [...DEFAULT_QUESTION_DECK];
    logInfo("storage.initialized", { mode: "memory", questionCount: questionDeck.length });
    return;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      host_player_id UUID NOT NULL,
      payload JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS session_players (
      id UUID PRIMARY KEY,
      session_code TEXT NOT NULL REFERENCES sessions(code) ON DELETE CASCADE,
      username TEXT NOT NULL,
      is_host BOOLEAN NOT NULL DEFAULT FALSE,
      team_id UUID,
      joined_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_connected BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_session_players_name
      ON session_players (session_code, lower(username));

    CREATE INDEX IF NOT EXISTS idx_session_players_session_code
      ON session_players (session_code);

    CREATE TABLE IF NOT EXISTS questions (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('red', 'blue', 'green')),
      prompt TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS question_options (
      id BIGSERIAL PRIMARY KEY,
      question_id BIGINT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL CHECK (option_index >= 0),
      option_text TEXT NOT NULL,
      is_correct BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (question_id, option_index)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_question_single_correct
      ON question_options (question_id)
      WHERE is_correct = TRUE
  `);

  await refreshQuestionDeck();
  logInfo("storage.initialized", { mode: "postgres", questionCount: questionDeck.length });
}

function mapQuestionRowsToDeck(rows) {
  const byId = new Map();

  for (const row of rows) {
    let entry = byId.get(row.id);
    if (!entry) {
      entry = {
        category: row.category,
        prompt: row.prompt,
        options: [],
        correctOptionIndex: null,
      };
      byId.set(row.id, entry);
    }

    entry.options[row.option_index] = row.option_text;
    if (row.is_correct) {
      entry.correctOptionIndex = row.option_index;
    }
  }

  return [...byId.values()].filter(
    (question) =>
      categories.includes(question.category) &&
      question.options.length > 1 &&
      Number.isInteger(question.correctOptionIndex),
  );
}

async function refreshQuestionDeck() {
  if (!USE_POSTGRES || !dbPool) {
    questionDeck = [...DEFAULT_QUESTION_DECK];
    logInfo("questions.deck.loaded", { source: "memory-default", questionCount: questionDeck.length });
    return;
  }

  const result = await dbPool.query(
    `
      SELECT
        q.id,
        q.category,
        q.prompt,
        o.option_index,
        o.option_text,
        o.is_correct
      FROM questions q
      JOIN question_options o ON o.question_id = q.id
      WHERE q.is_active = TRUE
      ORDER BY q.id, o.option_index
    `,
  );

  const mapped = mapQuestionRowsToDeck(result.rows);
  questionDeck = mapped.length > 0 ? mapped : [...DEFAULT_QUESTION_DECK];
  logInfo("questions.deck.loaded", {
    source: mapped.length > 0 ? "database" : "memory-default",
    questionCount: questionDeck.length,
  });
}

async function loadPlayersForSession(code) {
  if (!USE_POSTGRES || !dbPool) {
    return null;
  }

  const result = await dbPool.query(
    `
      SELECT id, username, is_host, team_id, joined_at
      FROM session_players
      WHERE session_code = $1
      ORDER BY joined_at ASC
    `,
    [code],
  );

  return result.rows.map((row) => ({
    id: row.id,
    username: row.username,
    isHost: Boolean(row.is_host),
    teamId: row.team_id || null,
    joinedAt: new Date(row.joined_at).toISOString(),
  }));
}

async function savePlayersForSession(client, code, players) {
  await client.query("DELETE FROM session_players WHERE session_code = $1", [code]);

  for (const player of players) {
    await client.query(
      `
        INSERT INTO session_players (
          id,
          session_code,
          username,
          is_host,
          team_id,
          joined_at,
          last_seen_at,
          is_connected
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), TRUE)
      `,
      [
        player.id,
        code,
        player.username,
        Boolean(player.isHost),
        player.teamId || null,
        player.joinedAt || new Date().toISOString(),
      ],
    );
  }
}

async function touchPlayerLastSeen(code, playerId) {
  if (!USE_POSTGRES || !dbPool) {
    return;
  }

  await dbPool.query(
    `
      UPDATE session_players
      SET last_seen_at = NOW(), is_connected = TRUE
      WHERE session_code = $1 AND id = $2
    `,
    [code, playerId],
  );
}

async function sessionCodeExists(code) {
  if (sessions.has(code)) {
    return true;
  }

  if (!USE_POSTGRES || !dbPool) {
    return false;
  }

  const result = await dbPool.query("SELECT 1 FROM sessions WHERE code = $1 LIMIT 1", [code]);
  return result.rowCount > 0;
}

async function loadSession(code) {
  const normalizedCode = String(code || "").toUpperCase();
  if (!normalizedCode) {
    return null;
  }

  if (!USE_POSTGRES || !dbPool) {
    const session = sessions.get(normalizedCode) || null;
    logInfo("session.load", {
      code: normalizedCode,
      source: "memory",
      found: Boolean(session),
    });
    return session;
  }

  const result = await dbPool.query("SELECT payload FROM sessions WHERE code = $1", [normalizedCode]);
  if (result.rowCount === 0) {
    sessions.delete(normalizedCode);
    logInfo("session.load", {
      code: normalizedCode,
      source: "postgres",
      found: false,
    });
    return null;
  }

  const session = result.rows[0].payload;
  const loadedPlayers = await loadPlayersForSession(normalizedCode);
  if (loadedPlayers && loadedPlayers.length > 0) {
    session.players = loadedPlayers;
  }
  sessions.set(normalizedCode, session);
  logInfo("session.load", {
    code: normalizedCode,
    source: "postgres",
    found: true,
    players: Array.isArray(session.players) ? session.players.length : 0,
    status: session.status,
  });
  return session;
}

async function saveSession(session) {
  sessions.set(session.code, session);

  if (!USE_POSTGRES || !dbPool) {
    logInfo("session.save", {
      code: session.code,
      source: "memory",
      status: session.status,
      players: Array.isArray(session.players) ? session.players.length : 0,
    });
    return;
  }

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
        INSERT INTO sessions (
          code,
          status,
          host_player_id,
          payload,
          version,
          created_at,
          started_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6, NOW())
        ON CONFLICT (code)
        DO UPDATE SET
          status = EXCLUDED.status,
          host_player_id = EXCLUDED.host_player_id,
          payload = EXCLUDED.payload,
          started_at = EXCLUDED.started_at,
          version = sessions.version + 1,
          updated_at = NOW()
      `,
      [
        session.code,
        session.status,
        session.hostPlayerId,
        JSON.stringify(session),
        session.createdAt || new Date().toISOString(),
        session.startedAt || null,
      ],
    );

    await savePlayersForSession(client, session.code, session.players || []);
    await client.query("COMMIT");
    logInfo("session.save", {
      code: session.code,
      source: "postgres",
      status: session.status,
      players: Array.isArray(session.players) ? session.players.length : 0,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    logError("session.save.failed", error, {
      code: session.code,
      source: USE_POSTGRES ? "postgres" : "memory",
      status: session.status,
    });
    throw error;
  } finally {
    client.release();
  }
}

async function deleteSessionByCode(code) {
  const normalizedCode = String(code || "").toUpperCase();
  sessions.delete(normalizedCode);

  if (!USE_POSTGRES || !dbPool) {
    return;
  }

  await dbPool.query("DELETE FROM sessions WHERE code = $1", [normalizedCode]);
}

function generateSessionCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function createUniqueSessionCode() {
  let code = generateSessionCode();
  while (await sessionCodeExists(code)) {
    code = generateSessionCode();
  }
  return code;
}

function normalizeName(value) {
  return String(value || "").trim();
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
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
    leaderboard,
  };
}

async function getSessionOr404(req, res) {
  const code = String(req.params.code || "").toUpperCase();
  const session = await loadSession(code);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return null;
  }
  return session;
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

function applyScore(session, teamId, category, delta, actorPlayerId) {
  const team = findTeam(session, teamId);
  if (!team) {
    return;
  }

  if (!categories.includes(category)) {
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

  const deck = questionDeck.filter((question) => question.category === landed);
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
      await saveSession(session);
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
    await saveSession(session);
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

app.get("/", (req, res) => {
  res.json({
    message: "Incident Game API running",
    version: "1.0.0",
    storageMode: USE_POSTGRES ? "postgres" : "memory",
    endpoints: [
      "POST /api/sessions",
      "POST /api/sessions/:code/join",
      "GET /api/sessions/:code",
      "GET /api/sessions/:code/players",
      "POST /api/sessions/:code/players/:playerId/team",
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
});

app.post("/api/sessions", async (req, res) => {
  const username = normalizeName(req.body?.username);
  if (!username) {
    res.status(400).json({ error: "username is required." });
    return;
  }

  const hostPlayerId = randomUUID();
  const sessionCode = await createUniqueSessionCode();

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
    gameState: null,
  };

  await saveSession(session);
  logInfo("session.created", {
    code: sessionCode,
    hostPlayerId,
    hostUsername: username,
  });

  res.status(201).json({
    session: sanitizeSession(session),
    player: hostPlayer,
  });
});

app.post("/api/sessions/:code/join", async (req, res) => {
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
    await touchPlayerLastSeen(session.code, duplicatePlayer.id);
    logInfo("session.player.reconnected", {
      code: session.code,
      playerId: duplicatePlayer.id,
      username: duplicatePlayer.username,
    });
    res.status(200).json({
      session: sanitizeSession(session),
      player: duplicatePlayer,
      reconnected: true,
    });
    return;
  }

  if (session.status !== "lobby") {
    res.status(409).json({ error: "Session has already started. Use the same username to reconnect." });
    return;
  }

  const player = {
    id: randomUUID(),
    username,
    isHost: false,
    teamId: null,
    joinedAt: new Date().toISOString(),
  };

  session.players.push(player);
  await saveSession(session);
  logInfo("session.player.joined", {
    code: session.code,
    playerId: player.id,
    username: player.username,
    playersAfterJoin: session.players.length,
  });
  res.status(201).json({
    session: sanitizeSession(session),
    player,
  });
});

app.get("/api/sessions/:code", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  const cleaned = cleanupLegacySessionData(session);
  if (cleaned) {
    await saveSession(session);
  }
  res.json({ session: sanitizeSession(session) });
});

app.get("/api/sessions/:code/players", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;
  res.json({ players: session.players });
});

app.post("/api/sessions/:code/players/:playerId/team", async (req, res) => {
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

  await saveSession(session);

  res.json({
    message: "Player assigned to team.",
    player,
    team,
  });
});

app.post("/api/sessions/:code/teams", async (req, res) => {
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

      let player = session.players.find(
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

  await saveSession(session);

  res.json({
    message: "Teams saved.",
    skippedPlayers,
    session: sanitizeSession(session),
  });
});

app.post("/api/sessions/:code/start", async (req, res) => {
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

  await saveSession(session);
  logInfo("session.started", {
    code: session.code,
    hostPlayerId,
    teamCount: session.teams.length,
    playerCount: session.players.length,
  });

  res.json({
    message: "Session started.",
    session: sanitizeSession(session),
  });
});

app.get("/api/sessions/:code/game-state", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;

  if (session.status !== "in-game") {
    res.status(409).json({ error: "Session is not in-game." });
    return;
  }

  await ensureGameState(session);
  const viewerPlayerId = normalizeName(req.query?.playerId);
  res.json({ gameState: sanitizeGameState(session, viewerPlayerId) });
});

app.post("/api/sessions/:code/game/roll", async (req, res) => {
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

  if (gameState.winnerId || gameState.pendingQuestion || gameState.answerReveal || gameState.pendingNeutral || gameState.pendingTrap) {
    res.status(409).json({ error: "Current turn is waiting for another action.", gameState: sanitizeGameState(session, actorPlayerId) });
    return;
  }

  const roll = rollDice();
  gameState.lastRoll = roll;
  gameState.rollSequence = Number(gameState.rollSequence || 0) + 1;
  resolveMove(session, roll);

  await saveSession(session);

  res.json({
    gameState: sanitizeGameState(session, actorPlayerId),
    roll,
  });
});

app.post("/api/sessions/:code/game/neutral", async (req, res) => {
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
    res.status(409).json({ error: "No pending neutral decision.", gameState: sanitizeGameState(session, actorPlayerId) });
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

  await saveSession(session);

  res.json({
    gameState: sanitizeGameState(session, actorPlayerId),
    roll: steps,
  });
});

app.post("/api/sessions/:code/game/answer", async (req, res) => {
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
    res.status(409).json({ error: "No pending question.", gameState: sanitizeGameState(session, actorPlayerId) });
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

  await saveSession(session);

  res.json({
    gameState: sanitizeGameState(session, actorPlayerId),
    correct,
    selectedOptionIndex,
    correctOptionIndex: pendingQuestion.correctOptionIndex,
  });
});

app.post("/api/sessions/:code/game/trap-attempt", async (req, res) => {
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

  if (gameState.winnerId || gameState.pendingQuestion || gameState.answerReveal || gameState.pendingNeutral || gameState.pendingTrap) {
    res.status(409).json({ error: "Current turn is waiting for another action.", gameState: sanitizeGameState(session, actorPlayerId) });
    return;
  }

  const hasAllWedges =
    activeTeam.wedges.red >= 2 && activeTeam.wedges.blue >= 2 && activeTeam.wedges.green >= 2;
  if (!hasAllWedges) {
    res.status(409).json({ error: "Team does not have all wedges.", gameState: sanitizeGameState(session, actorPlayerId) });
    return;
  }

  gameState.pendingTrap = {
    context: "championship",
    activity: randomFrom(TRAP_ACTIVITIES),
  };
  gameState.turnMessage = "Championship trap activity: succeed to win, fail and lose one wedge.";
  gameState.updatedAt = new Date().toISOString();

  await saveSession(session);

  res.json({ gameState: sanitizeGameState(session, actorPlayerId) });
});

app.post("/api/sessions/:code/game/trap-result", async (req, res) => {
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
    res.status(409).json({ error: "No pending trap result.", gameState: sanitizeGameState(session, actorPlayerId) });
    return;
  }

  const success = Boolean(req.body?.success);

  gameState.pendingTrap = null;

  if (success) {
    gameState.winnerId = activeTeam.id;
    gameState.turnMessage = `${activeTeam.name} succeeded in the championship trap and is crowned Incident Management Champion.`;
    gameState.updatedAt = new Date().toISOString();
    await saveSession(session);
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

  await saveSession(session);

  res.json({ gameState: sanitizeGameState(session, actorPlayerId) });
});

app.post("/api/sessions/:code/score", async (req, res) => {
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

  await saveSession(session);

  res.json({
    message: "Score updated.",
    scoreEvent,
    team,
  });
});

app.get("/api/sessions/:code/leaderboard", async (req, res) => {
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
});

app.post("/api/sessions/:code/reset-scores", async (req, res) => {
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

  await saveSession(session);

  res.json({
    message: "Scores reset.",
    session: sanitizeSession(session),
  });
});

app.delete("/api/sessions/:code", async (req, res) => {
  const session = await getSessionOr404(req, res);
  if (!session) return;

  const hostPlayerId = normalizeName(req.body?.hostPlayerId);
  if (!hostPlayerId || !assertHost(session, hostPlayerId, res)) {
    return;
  }

  await deleteSessionByCode(session.code);
  logInfo("session.deleted", {
    code: session.code,
    requestedBy: hostPlayerId,
  });
  res.json({ message: "Session deleted." });
});

app.use((error, req, res, next) => {
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
});

async function startServer() {
  await initializeStorage();

  app.listen(PORT, () => {
    logInfo("server.started", {
      url: `http://localhost:${PORT}`,
      storageMode: USE_POSTGRES ? "postgres" : "memory",
    });
  });
}

startServer().catch((error) => {
  logError("server.start_failed", error, {
    storageMode: USE_POSTGRES ? "postgres" : "memory",
  });
  process.exit(1);
});