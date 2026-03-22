const { Pool } = require("pg");
const { DEFAULT_QUESTION_DECK, categories } = require("../lib/constants");
const { logInfo, logError } = require("../lib/logger");

function createSessionRepository({ databaseUrl, pgssl }) {
  const normalizedUrl = String(databaseUrl || "").trim();
  const usePostgres = normalizedUrl.length > 0;
  const sessions = new Map();
  let questionDeck = [...DEFAULT_QUESTION_DECK];

  const dbPool = usePostgres
    ? new Pool({
        connectionString: normalizedUrl,
        ssl: pgssl === "false" ? false : { rejectUnauthorized: false },
      })
    : null;

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
    if (!usePostgres || !dbPool) {
      questionDeck = [...DEFAULT_QUESTION_DECK];
      logInfo("questions.deck.loaded", {
        source: "memory-default",
        questionCount: questionDeck.length,
      });
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

  async function initializeStorage() {
    if (!usePostgres || !dbPool) {
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

  async function loadPlayersForSession(code) {
    if (!usePostgres || !dbPool) {
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
    if (!usePostgres || !dbPool) {
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

    if (!usePostgres || !dbPool) {
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

    if (!usePostgres || !dbPool) {
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

    if (!usePostgres || !dbPool) {
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
        source: usePostgres ? "postgres" : "memory",
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

    if (!usePostgres || !dbPool) {
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

  return {
    initializeStorage,
    loadSession,
    saveSession,
    deleteSessionByCode,
    createUniqueSessionCode,
    touchPlayerLastSeen,
    getQuestionDeck: () => [...questionDeck],
    getStorageMode: () => (usePostgres ? "postgres" : "memory"),
  };
}

module.exports = {
  createSessionRepository,
};
