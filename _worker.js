async function ensureSchema(env) {
  if (!env.QUIZ_DB) {
    throw new Error("Binding D1 manquante : QUIZ_DB");
  }

  await env.QUIZ_DB.batch([
    env.QUIZ_DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      code TEXT PRIMARY KEY,
      branding_json TEXT NOT NULL,
      selected_questions_json TEXT NOT NULL,
      logos_json TEXT NOT NULL,
      current_question_index INTEGER NOT NULL DEFAULT 0,
      session_state TEXT NOT NULL DEFAULT 'lobby',
      updated_at TEXT NOT NULL
    )`),
    env.QUIZ_DB.prepare(`CREATE TABLE IF NOT EXISTS teams (
      session_code TEXT NOT NULL,
      team_name TEXT NOT NULL,
      grade TEXT,
      child_age_band TEXT,
      parent_age_band TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      parent_correct INTEGER NOT NULL DEFAULT 0,
      child_correct INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (session_code, team_name)
    )`),
    env.QUIZ_DB.prepare(`CREATE TABLE IF NOT EXISTS answers (
      session_code TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      parent_answer TEXT,
      child_answer TEXT,
      scored INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (session_code, question_id, team_name)
    )`),
    env.QUIZ_DB.prepare(`CREATE TABLE IF NOT EXISTS logo_assets (
      session_code TEXT NOT NULL,
      logo_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      image_data BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_code, logo_id)
    )`),
  ]);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function getSession(env, code) {
  const row = await env.QUIZ_DB.prepare(
    `SELECT code, branding_json, selected_questions_json, logos_json, current_question_index, session_state, updated_at
     FROM sessions WHERE code = ?1`
  ).bind(code).first();
  if (!row) return null;
  return {
    code: row.code,
    branding: parseJson(row.branding_json, {}),
    selectedQuestions: parseJson(row.selected_questions_json, []),
    logos: parseJson(row.logos_json, []),
    currentQuestionIndex: row.current_question_index || 0,
    sessionState: row.session_state || "lobby",
    updatedAt: row.updated_at,
  };
}


function buildLogoSrc(code, logoId, updatedAt) {
  const qs = new URLSearchParams({ code: String(code || ""), id: String(logoId || "") });
  if (updatedAt) qs.set("v", String(updatedAt));
  return `/api/logo?${qs.toString()}`;
}

async function hydrateLogos(env, code, logosMeta) {
  const rowsResult = await env.QUIZ_DB.prepare(
    `SELECT logo_id, updated_at FROM logo_assets WHERE session_code = ?1`
  ).bind(code).all();
  const assets = new Map((rowsResult.results || []).map((row) => [Number(row.logo_id), row]));
  return (logosMeta || []).map((logo) => {
    const asset = assets.get(Number(logo.id));
    return {
      ...logo,
      src: asset ? buildLogoSrc(code, logo.id, asset.updated_at) : String(logo.src || ""),
    };
  });
}

function percentageDistribution(rows, key) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  rows.forEach((row) => {
    const value = row[key];
    if (counts[value] !== undefined) counts[value] += 1;
  });
  const total = rows.length;
  if (!total) return counts;
  return Object.fromEntries(
    Object.entries(counts).map(([answer, count]) => [answer, Math.round((count / total) * 100)])
  );
}

async function buildState(env, code) {
  const session = await getSession(env, code);
  if (!session) return null;
  session.logos = await hydrateLogos(env, code, session.logos);

  const teamsRows = await env.QUIZ_DB.prepare(
    `SELECT team_name, grade, score, parent_correct, child_correct
     FROM teams WHERE session_code = ?1
     ORDER BY score DESC, team_name ASC`
  ).bind(code).all();

  const leaderboard = (teamsRows.results || []).map((row, index) => ({
    rank: index + 1,
    name: row.team_name,
    grade: row.grade,
    score: row.score,
    parent: row.parent_correct,
    child: row.child_correct,
  }));

  const question = session.selectedQuestions[session.currentQuestionIndex] || null;
  let answerRows = [];
  if (question) {
    const answersResult = await env.QUIZ_DB.prepare(
      `SELECT parent_answer, child_answer FROM answers WHERE session_code = ?1 AND question_id = ?2`
    ).bind(code, question.id).all();
    answerRows = answersResult.results || [];
  }

  const scoreParents = leaderboard.reduce((sum, team) => sum + (team.parent || 0), 0);
  const scoreChildren = leaderboard.reduce((sum, team) => sum + (team.child || 0), 0);

  return {
    session,
    leaderboard,
    familiesConnected: leaderboard.length,
    responsesReceived: answerRows.length,
    parentDistribution: percentageDistribution(answerRows, "parent_answer"),
    childDistribution: percentageDistribution(answerRows, "child_answer"),
    scoreParents,
    scoreChildren,
  };
}

async function handlePublishConfig(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  if (!code) return error("Code session manquant");
  const branding = body.branding || {};
  const selectedQuestions = Array.isArray(body.selectedQuestions) ? body.selectedQuestions : [];
  const logos = Array.isArray(body.logos) ? body.logos : [];
  if (!selectedQuestions.length) return error("Aucune question sÃ©lectionnÃ©e");

  const now = new Date().toISOString();
  await env.QUIZ_DB.prepare(
    `INSERT INTO sessions (code, branding_json, selected_questions_json, logos_json, current_question_index, session_state, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, 'lobby', ?5)
     ON CONFLICT(code) DO UPDATE SET
       branding_json = excluded.branding_json,
       selected_questions_json = excluded.selected_questions_json,
       logos_json = excluded.logos_json,
       current_question_index = 0,
       session_state = 'lobby',
       updated_at = excluded.updated_at`
  ).bind(code, JSON.stringify(branding), JSON.stringify(selectedQuestions), JSON.stringify(logos), now).run();

  await env.QUIZ_DB.prepare(`DELETE FROM answers WHERE session_code = ?1`).bind(code).run();
  await env.QUIZ_DB.prepare(
    `UPDATE teams SET score = 0, parent_correct = 0, child_correct = 0, last_seen = ?2 WHERE session_code = ?1`
  ).bind(code, now).run();

  return json({ ok: true });
}

async function handleJoin(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  const teamName = String(body.teamName || "").trim();
  if (!code) return error("Code session manquant");
  if (!teamName) return error("Pseudo d'Ã©quipe manquant");
  const session = await getSession(env, code);
  if (!session) return error("Session introuvable. Publie d'abord la configuration cÃ´tÃ© admin.", 404);
  const now = new Date().toISOString();
  await env.QUIZ_DB.prepare(
    `INSERT INTO teams (session_code, team_name, grade, child_age_band, parent_age_band, score, parent_correct, child_correct, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, 0, ?6)
     ON CONFLICT(session_code, team_name) DO UPDATE SET
       grade = excluded.grade,
       child_age_band = excluded.child_age_band,
       parent_age_band = excluded.parent_age_band,
       last_seen = excluded.last_seen`
  ).bind(code, teamName, body.childGrade || "", body.childAgeBand || "", body.parentAgeBand || "", now).run();
  return json({ ok: true });
}

async function handleAnswer(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  const teamName = String(body.teamName || "").trim();
  const questionId = Number(body.questionId);
  if (!code || !teamName || !Number.isFinite(questionId)) return error("RÃ©ponse incomplÃ¨te");

  const session = await getSession(env, code);
  if (!session) return error("Session introuvable", 404);
  const currentQuestion = session.selectedQuestions[session.currentQuestionIndex];
  if (!currentQuestion || Number(currentQuestion.id) !== questionId) {
    return error("Cette question n'est plus la question active.");
  }

  const now = new Date().toISOString();
  await env.QUIZ_DB.prepare(
    `INSERT INTO answers (session_code, question_id, team_name, parent_answer, child_answer, scored, submitted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
     ON CONFLICT(session_code, question_id, team_name) DO UPDATE SET
       parent_answer = excluded.parent_answer,
       child_answer = excluded.child_answer,
       submitted_at = excluded.submitted_at`
  ).bind(code, questionId, teamName, body.parentAnswer || "", body.childAnswer || "", now).run();
  return json({ ok: true });
}

async function handleAction(request, env) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  const action = String(body.action || "");
  if (!code || !action) return error("Action incomplÃ¨te");
  const session = await getSession(env, code);
  if (!session) return error("Session introuvable", 404);
  const now = new Date().toISOString();

  if (action === "open_lobby") {
    await env.QUIZ_DB.prepare(`UPDATE sessions SET session_state = 'lobby', updated_at = ?2 WHERE code = ?1`).bind(code, now).run();
    return json({ ok: true });
  }

  if (action === "open_question") {
    await env.QUIZ_DB.prepare(`UPDATE sessions SET session_state = 'question_open', updated_at = ?2 WHERE code = ?1`).bind(code, now).run();
    return json({ ok: true });
  }

  if (action === "final") {
    await env.QUIZ_DB.prepare(`UPDATE sessions SET session_state = 'final_screen', updated_at = ?2 WHERE code = ?1`).bind(code, now).run();
    return json({ ok: true });
  }

  if (action === "next") {
    const nextIndex = Math.min(session.currentQuestionIndex + 1, Math.max(session.selectedQuestions.length - 1, 0));
    await env.QUIZ_DB.prepare(
      `UPDATE sessions SET current_question_index = ?2, session_state = 'question_open', updated_at = ?3 WHERE code = ?1`
    ).bind(code, nextIndex, now).run();
    return json({ ok: true });
  }

  if (action === "reset_scores") {
    await env.QUIZ_DB.prepare(`DELETE FROM answers WHERE session_code = ?1`).bind(code).run();
    await env.QUIZ_DB.prepare(
      `UPDATE teams SET score = 0, parent_correct = 0, child_correct = 0, last_seen = ?2 WHERE session_code = ?1`
    ).bind(code, now).run();
    await env.QUIZ_DB.prepare(
      `UPDATE sessions SET current_question_index = 0, session_state = 'lobby', updated_at = ?2 WHERE code = ?1`
    ).bind(code, now).run();
    return json({ ok: true });
  }

  if (action === "reveal") {
    const question = session.selectedQuestions[session.currentQuestionIndex];
    if (!question) return error("Aucune question active");
    const answersResult = await env.QUIZ_DB.prepare(
      `SELECT team_name, parent_answer, child_answer FROM answers WHERE session_code = ?1 AND question_id = ?2 AND scored = 0`
    ).bind(code, question.id).all();
    const rows = answersResult.results || [];

    for (const row of rows) {
      const parentOk = row.parent_answer === question.correct ? 1 : 0;
      const childOk = row.child_answer === question.correct ? 1 : 0;
      await env.QUIZ_DB.prepare(
        `UPDATE teams
         SET score = score + ?3,
             parent_correct = parent_correct + ?4,
             child_correct = child_correct + ?5,
             last_seen = ?6
         WHERE session_code = ?1 AND team_name = ?2`
      ).bind(code, row.team_name, parentOk + childOk, parentOk, childOk, now).run();
    }

    await env.QUIZ_DB.prepare(
      `UPDATE answers SET scored = 1 WHERE session_code = ?1 AND question_id = ?2`
    ).bind(code, question.id).run();

    await env.QUIZ_DB.prepare(
      `UPDATE sessions SET session_state = 'reveal', updated_at = ?2 WHERE code = ?1`
    ).bind(code, now).run();

    return json({ ok: true });
  }

  return error("Action inconnue");
}


async function handleLogoUpload(request, env) {
  const form = await request.formData();
  const code = normalizeCode(form.get("code"));
  const rawLogoId = Number(form.get("logoId"));
  const file = form.get("file");
  const explicitName = String(form.get("name") || "").trim();
  if (!code) return error("Code session manquant");
  if (!(file instanceof File)) return error("Fichier logo manquant");
  if (!Number.isFinite(rawLogoId)) return error("Identifiant de logo manquant");
  if (file.size > 1600000) return error("Le fichier dÃ©passe la limite conseillÃ©e de 1,6 Mo pour D1.");

  const now = new Date().toISOString();
  const bytes = await file.arrayBuffer();
  const mimeType = file.type || "application/octet-stream";
  const name = explicitName || file.name || `logo-${rawLogoId}`;

  await env.QUIZ_DB.prepare(
    `INSERT INTO logo_assets (session_code, logo_id, name, mime_type, image_data, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(session_code, logo_id) DO UPDATE SET
       name = excluded.name,
       mime_type = excluded.mime_type,
       image_data = excluded.image_data,
       updated_at = excluded.updated_at`
  ).bind(code, rawLogoId, name, mimeType, bytes, now).run();

  return json({
    ok: true,
    logoId: rawLogoId,
    name,
    srcUrl: buildLogoSrc(code, rawLogoId, now),
    updatedAt: now,
  });
}

async function handleLogoGet(url, env) {
  const code = normalizeCode(url.searchParams.get("code"));
  const logoId = Number(url.searchParams.get("id"));

  if (!code || !Number.isFinite(logoId)) {
    return error("Paramètres logo invalides", 400);
  }

  const row = await env.QUIZ_DB.prepare(
    `SELECT mime_type, image_data FROM logo_assets WHERE session_code = ?1 AND logo_id = ?2`
  ).bind(code, logoId).first();

  if (!row) {
    return new Response("Logo introuvable", { status: 404 });
  }

  const bytes = Array.isArray(row.image_data)
    ? new Uint8Array(row.image_data)
    : row.image_data instanceof Uint8Array
      ? row.image_data
      : new Uint8Array([]);

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": row.mime_type || "application/octet-stream",
      "cache-control": "public, max-age=300",
    },
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
if (url.pathname === "/api/live-test") {
  const stub = env.QUIZ_LIVE.getByName("DEMO123");
  return stub.fetch("https://quiz-live.internal/?code=DEMO123");
}
      if (url.pathname.startsWith("/api/")) {
        await ensureSchema(env);

        if (request.method === "GET" && url.pathname === "/api/state") {
          const code = normalizeCode(url.searchParams.get("code"));
          if (!code) return error("Code session manquant");
          const state = await buildState(env, code);
          if (!state) return error("Session introuvable. Publie d'abord la configuration cÃ´tÃ© admin.", 404);
          return json(state);
        }

        if (request.method === "GET" && url.pathname === "/api/logo") {
          return handleLogoGet(url, env);
        }

        if (request.method === "GET" && url.pathname === "/api/export") {
          const code = normalizeCode(url.searchParams.get("code"));
          if (!code) return error("Code session manquant");
          const state = await buildState(env, code);
          if (!state) return error("Session introuvable.", 404);
          return json(state);
        }

        if (request.method === "POST" && url.pathname === "/api/logo-upload") {
          return handleLogoUpload(request, env);
        }

        if (request.method === "POST" && url.pathname === "/api/publish-config") {
          return handlePublishConfig(request, env);
        }

        if (request.method === "POST" && url.pathname === "/api/join") {
          return handleJoin(request, env);
        }

        if (request.method === "POST" && url.pathname === "/api/answer") {
          return handleAnswer(request, env);
        }

        if (request.method === "POST" && url.pathname === "/api/action") {
          return handleAction(request, env);
        }

        return error("Route API inconnue", 404);
      }

      return env.ASSETS.fetch(request);
    } catch (thrown) {
      return error(thrown instanceof Error ? thrown.message : "Erreur serveur", 500);
    }
  },
};

