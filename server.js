const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const webpush = require("web-push");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const PUSH_FILE = path.join(DATA_DIR, "push.json");
const STORIES_FILE = path.join(DATA_DIR, "stories.json");
const FCM_FILE = path.join(DATA_DIR, "fcm.json");
const RECORDINGS_FILE = path.join(DATA_DIR, "recordings.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// =====================================================
// SUPABASE / PERSISTENCIA
// =====================================================
// Render Free tiene almacenamiento de archivos efímero.
// Guardamos el estado persistente mediante la Data API de Supabase
// para no depender de DATABASE_URL, pg ni de un pooler de PostgreSQL.

const SUPABASE_URL = String(process.env.SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/i, "")
  .replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

const STATE_FILES = {
  "users.json": [],
  "messages.json": [],
  "sessions.json": {},
  "push.json": [],
  "stories.json": [],
  "fcm.json": {},
  "recordings.json": [],
  "reports.json": []
};

let supabaseAvailable = false;
let supabaseReadyResolve;
const supabaseReady = new Promise(resolve => {
  supabaseReadyResolve = resolve;
});
let supabaseWriteQueue = Promise.resolve();

function ensure(file, value) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  }
}

ensure(USERS_FILE, []);
ensure(MESSAGES_FILE, []);
ensure(SESSIONS_FILE, {});
ensure(PUSH_FILE, []);
ensure(STORIES_FILE, []);
ensure(FCM_FILE, {});
ensure(RECORDINGS_FILE, []);
ensure(REPORTS_FILE, []);

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function stateKey(file) {
  return path.basename(file);
}

async function supabaseRequest(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY no configuradas.");
  }

  const response = await fetch(
    SUPABASE_URL + "/rest/v1/" + pathname,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: "Bearer " + SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message || data?.hint || JSON.stringify(data);

    throw new Error(
      `Supabase HTTP ${response.status}: ${message}`
    );
  }

  return data;
}

function queueSupabasePersist(file, data) {
  const key = stateKey(file);

  supabaseWriteQueue = supabaseWriteQueue
    .then(async () => {
      const ready = await supabaseReady;
      if (!ready) return;

      await supabaseRequest(
        "michat_state?on_conflict=state_key",
        {
          method: "POST",
          headers: {
            Prefer: "resolution=merge-duplicates,return=minimal"
          },
          body: JSON.stringify([
            {
              state_key: key,
              state_data: data,
              updated_at: new Date().toISOString()
            }
          ])
        }
      );
    })
    .catch(error => {
      console.error(
        `Error guardando ${key} en Supabase:`,
        error.message
      );
    });
}

function write(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  queueSupabasePersist(file, data);
}

async function initializeDatabase() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.log(
      "SUPABASE_URL/SUPABASE_SECRET_KEY no configuradas. Se usará almacenamiento local temporal."
    );
    supabaseReadyResolve(false);
    return;
  }

  try {
    // La tabla michat_state se crea una vez desde el SQL de configuración.
    // Aquí solo comprobamos que la Data API puede leerla.
    const rows = await supabaseRequest(
      "michat_state?select=state_key,state_data,updated_at"
    );

    const byKey = new Map(
      (Array.isArray(rows) ? rows : []).map(row => [
        row.state_key,
        row
      ])
    );

    for (const [key, fallback] of Object.entries(STATE_FILES)) {
      const file = path.join(DATA_DIR, key);
      const local = read(file, fallback);
      const remote = byKey.get(key);

      if (remote) {
        fs.writeFileSync(
          file,
          JSON.stringify(remote.state_data, null, 2),
          "utf8"
        );
        console.log(`Supabase -> ${key}`);
      } else {
        await supabaseRequest(
          "michat_state?on_conflict=state_key",
          {
            method: "POST",
            headers: {
              Prefer: "resolution=merge-duplicates,return=minimal"
            },
            body: JSON.stringify([
              {
                state_key: key,
                state_data: local,
                updated_at: new Date().toISOString()
              }
            ])
          }
        );
        console.log(`Migrado a Supabase -> ${key}`);
      }
    }

    supabaseAvailable = true;
    supabaseReadyResolve(true);
    console.log("Supabase conectado y datos persistentes activos.");
  } catch (error) {
    supabaseAvailable = false;
    supabaseReadyResolve(false);
    console.error("Supabase no disponible:", error.message);
    console.log("El servidor continuará con almacenamiento local temporal.");
  }
}

function users() {
  return read(USERS_FILE, []);
}

function saveUsers(v) {
  write(USERS_FILE, v);
}

function messages() {
  return read(MESSAGES_FILE, []);
}

function saveMessages(v) {
  write(MESSAGES_FILE, v);
}

function sessions() {
  return read(SESSIONS_FILE, {});
}

function saveSessions(v) {
  write(SESSIONS_FILE, v);
}

function pushSubs() {
  return read(PUSH_FILE, []);
}

function savePushSubs(v) {
  write(PUSH_FILE, v);
}

function allStories() {
  return read(STORIES_FILE, []);
}

function saveStories(v) {
  write(STORIES_FILE, v);
}

function recordings() {
  return read(RECORDINGS_FILE, []);
}

function saveRecordings(v) {
  write(RECORDINGS_FILE, v);
}

function reports() {
  return read(REPORTS_FILE, []);
}

function saveReports(v) {
  write(REPORTS_FILE, v);
}

function fcmTokens() {
  return read(FCM_FILE, {});
}

function saveFcmTokens(v) {
  write(FCM_FILE, v);
}

function cleanExpiredStories() {
  const now = Date.now();
  const active = allStories().filter(s => Number(s.expiresAt) > now);
  saveStories(active);
  return active;
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

function getUser(username) {
  const u = norm(username);
  return users().find(x => norm(x.username) === u);
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function validPassword(password, salt, hash) {
  try {
    const got = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(
      Buffer.from(got, "hex"),
      Buffer.from(hash, "hex")
    );
  } catch {
    return false;
  }
}

// =====================================================
// SESIONES
// =====================================================
//
// Las sesiones nuevas usan un token firmado para que una
// recarga/reinicio del servicio de Render no invalide la
// sesión por depender de sessions.json.
// Se mantiene compatibilidad con los tokens antiguos.

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "michat-session-secret-change-this-in-render";

function createSessionToken(username) {
  const payload = Buffer
    .from(JSON.stringify({
      username: norm(username),
      createdAt: Date.now()
    }))
    .toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length) {
    return null;
  }

  try {
    if (!crypto.timingSafeEqual(a, b)) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!data || !data.username) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function newSession(username) {
  return createSessionToken(username);
}

function sessionUser(token) {
  if (!token) return null;

  // Tokens nuevos: no dependen de sessions.json.
  const signed = verifySessionToken(token);

  if (signed) {
    return getUser(signed.username);
  }

  // Compatibilidad con sesiones antiguas ya creadas.
  const legacy = sessions()[token];

  if (!legacy) return null;

  return getUser(legacy.username);
}

function deleteSession(token) {
  // Los tokens nuevos no se almacenan en disco.
  // Borramos también los antiguos por compatibilidad.
  if (!token) return;

  const data = sessions();

  if (Object.prototype.hasOwnProperty.call(data, token)) {
    delete data[token];
    saveSessions(data);
  }
}

function authToken(req) {
  const a = req.headers.authorization || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const online = new Map();

// =====================================================
// GRABACIONES DE LLAMADAS (VISIBLES Y CON CONSENTIMIENTO)
// =====================================================

function requireUser(req, res, next) {
  const user = sessionUser(authToken(req));
  if (!user) {
    return res.status(401).json({ error: "Sesión no válida." });
  }
  req.user = user;
  next();
}

app.post(
  "/api/call-recordings",
  express.raw({ type: ["audio/webm", "audio/ogg", "audio/mp4"], limit: "8mb" }),
  requireUser,
  (req, res) => {
    const to = norm(req.query.to || "");
    const startedAt = Number(req.query.startedAt || Date.now());
    const duration = Math.max(0, Math.min(15 * 60, Number(req.query.duration || 0)));

    if (!to || !getUser(to)) {
      return res.status(400).json({ error: "Destinatario de la llamada inválido." });
    }

    if (to === norm(req.user.username)) {
      return res.status(400).json({ error: "Destinatario inválido." });
    }

    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "La grabación está vacía." });
    }

    const id = crypto.randomBytes(16).toString("hex");
    const mimeType = String(req.headers["content-type"] || "audio/webm").split(";")[0].toLowerCase();
    const extension = mimeType === "audio/mp4" ? ".m4a" : mimeType === "audio/ogg" ? ".ogg" : ".webm";
    const fileName = id + extension;
    const filePath = path.join(RECORDINGS_DIR, fileName);

    try {
      fs.writeFileSync(filePath, req.body);
    } catch (error) {
      console.error("No se pudo guardar la grabación:", error);
      return res.status(500).json({ error: "No se pudo guardar la grabación." });
    }

    const item = {
      id,
      from: norm(req.user.username),
      fromDisplay: req.user.displayName || req.user.username,
      to,
      toDisplay: getUser(to)?.displayName || to,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      duration,
      size: req.body.length,
      mimeType: req.headers["content-type"] || "audio/webm",
      fileName,
      createdAt: Date.now()
    };

    const list = recordings();
    list.push(item);
    if (list.length > 100) {
      const removed = list.splice(0, list.length - 100);
      for (const old of removed) {
        try { fs.unlinkSync(path.join(RECORDINGS_DIR, old.fileName)); } catch {}
      }
    }
    saveRecordings(list);

    addAdminActivity(
      `${item.fromDisplay} ha guardado una grabación de llamada con ${item.toDisplay}.`
    );

    res.json({ success: true, id });
  }
);

// El participante puede avisar al otro de que ha empezado/terminado una grabación.

// =====================================================
// REPORTES DE USUARIOS
// =====================================================

app.post("/api/reports", requireUser, (req, res) => {
  const text = String(req.body?.text || "").trim();
  const category = String(req.body?.category || "Otro").trim().slice(0, 50);

  if (text.length < 5) {
    return res.status(400).json({ error: "El reporte debe tener al menos 5 caracteres." });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: "El reporte no puede superar los 2000 caracteres." });
  }

  const report = {
    id: Date.now() + "-" + crypto.randomBytes(5).toString("hex"),
    username: req.user.username,
    displayName: req.user.displayName || req.user.username,
    category,
    text,
    status: "open",
    createdAt: Date.now()
  };

  const list = reports();
  list.push(report);
  if (list.length > 500) list.splice(0, list.length - 500);
  saveReports(list);

  addAdminActivity(`${report.displayName} (@${report.username}) envió un reporte: ${category}.`);

  res.json({ success: true, id: report.id });
});

// =====================================================
// MI CHAT ADMIN
// =====================================================

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "admin").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const ADMIN_SESSION_SECRET = String(
  process.env.ADMIN_SESSION_SECRET || "CAMBIA-ESTA-CLAVE-ADMIN-EN-RENDER"
);
const ADMIN_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Terminal de actividad del administrador.
const adminActivity = [];

function addAdminActivity(text) {
  const line = {
    id: Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
    time: new Date().toISOString(),
    text: String(text || "")
  };

  adminActivity.push(line);

  if (adminActivity.length > 200) {
    adminActivity.splice(0, adminActivity.length - 200);
  }
}

function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({
    username: ADMIN_USERNAME,
    createdAt: Date.now()
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return null;

  try {
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!data || data.username !== ADMIN_USERNAME) return null;

    if (
      !data.createdAt ||
      Date.now() - Number(data.createdAt) > ADMIN_SESSION_MAX_AGE
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function adminToken(req) {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
}

function requireAdmin(req, res, next) {
  const admin = verifyAdminToken(adminToken(req));

  if (!admin) {
    return res.status(401).json({
      error: "Sesión de administrador no válida."
    });
  }

  req.admin = admin;
  next();
}

app.post("/api/admin/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!ADMIN_PASSWORD) {
    console.error("ADMIN_PASSWORD no está configurada en Render.");
    return res.status(500).json({
      error: "El administrador no está configurado en el servidor."
    });
  }

  if (
    username !== ADMIN_USERNAME ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: "Usuario o contraseña de administrador incorrectos."
    });
  }

  res.json({
    success: true,
    token: createAdminToken(),
    username: ADMIN_USERNAME
  });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({
    loggedIn: true,
    username: req.admin.username
  });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  res.json({ success: true });
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const userList = users();
  const messageList = messages();
  const storyList = cleanExpiredStories();
  const onlineUsers = new Set(
    [...online.values()].map(name => norm(name))
  );

  res.json({
    users: userList.length,
    messages: messageList.length,
    stories: storyList.length,
    online: onlineUsers.size,
    reports: reports().filter(r => r.status !== "resolved").length
  });
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const onlineUsers = new Set(
    [...online.values()].map(name => norm(name))
  );

  const result = users().map(user => ({
    username: user.username,
    displayName: user.displayName || user.username,
    profileImage: user.profileImage || "",
    online: onlineUsers.has(norm(user.username)),
    createdAt: user.createdAt || null,
    contacts: Array.isArray(user.contacts)
      ? user.contacts.length
      : 0
  }));

  result.sort((a, b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return String(a.username).localeCompare(
      String(b.username)
    );
  });

  res.json(result);
});

app.delete("/api/admin/users/:username", requireAdmin, (req, res) => {
  const username = norm(req.params.username);

  if (!username) {
    return res.status(400).json({
      error: "Usuario inválido."
    });
  }

  const list = users();
  const index = list.findIndex(
    u => norm(u.username) === username
  );

  if (index < 0) {
    return res.status(404).json({
      error: "Usuario no encontrado."
    });
  }

  const removed = list[index];
  list.splice(index, 1);
  saveUsers(list);

  // Eliminar sus sesiones antiguas.
  const sessionData = sessions();
  let sessionChanged = false;

  for (const [token, value] of Object.entries(sessionData)) {
    if (norm(value?.username) === username) {
      delete sessionData[token];
      sessionChanged = true;
    }
  }

  if (sessionChanged) {
    saveSessions(sessionData);
  }

  // Quitar al usuario de contactos y bloqueos de los demás.
  const updatedUsers = users();
  let usersChanged = false;

  for (const user of updatedUsers) {
    const oldContacts = Array.isArray(user.contacts)
      ? user.contacts
      : [];
    const oldBlocked = Array.isArray(user.blockedUsers)
      ? user.blockedUsers
      : [];

    const newContacts = oldContacts.filter(
      name => norm(name) !== username
    );
    const newBlocked = oldBlocked.filter(
      name => norm(name) !== username
    );

    if (
      newContacts.length !== oldContacts.length ||
      newBlocked.length !== oldBlocked.length
    ) {
      user.contacts = newContacts;
      user.blockedUsers = newBlocked;
      usersChanged = true;
    }
  }

  if (usersChanged) {
    saveUsers(updatedUsers);
  }

  // Eliminar mensajes relacionados con la cuenta.
  const remainingMessages = messages().filter(
    message =>
      norm(message.from) !== username &&
      norm(message.to) !== username
  );
  saveMessages(remainingMessages);

  // Eliminar estados de la cuenta.
  const remainingStories = allStories().filter(
    story => norm(story.username) !== username
  );
  saveStories(remainingStories);

  // Eliminar grabaciones en las que participe la cuenta.
  const recordingList = recordings();
  const remainingRecordings = recordingList.filter(item => {
    const belongs =
      norm(item.from) === username ||
      norm(item.to) === username;
    if (belongs) {
      try { fs.unlinkSync(path.join(RECORDINGS_DIR, item.fileName)); } catch {}
    }
    return !belongs;
  });
  saveRecordings(remainingRecordings);

  // Eliminar sus suscripciones Web Push.
  const remainingPush = pushSubs().filter(
    item => norm(item.username) !== username
  );
  savePushSubs(remainingPush);

  // Eliminar sus tokens FCM.
  const fcmData = fcmTokens();
  if (Object.prototype.hasOwnProperty.call(fcmData, username)) {
    delete fcmData[username];
    saveFcmTokens(fcmData);
  }

  // Desconectar cualquier sesión Socket.IO activa.
  for (const [socketId, name] of online.entries()) {
    if (norm(name) === username) {
      online.delete(socketId);
      const targetSocket = io.sockets.sockets.get(socketId);
      if (targetSocket) {
        targetSocket.disconnect(true);
      }
    }
  }

  sendUserList();

  console.log(
    `Administrador eliminó la cuenta ${username}.`
  );

  res.json({
    success: true,
    username: removed.username
  });
});

app.post("/api/admin/users/:username/reset-password", requireAdmin, (req, res) => {
  const username = norm(req.params.username);
  const newPassword = String(req.body?.password || "");

  if (!username) {
    return res.status(400).json({
      error: "Usuario inválido."
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      error: "La nueva contraseña debe tener al menos 6 caracteres."
    });
  }

  const list = users();
  const index = list.findIndex(
    u => norm(u.username) === username
  );

  if (index < 0) {
    return res.status(404).json({
      error: "Usuario no encontrado."
    });
  }

  const p = passwordHash(newPassword);

  list[index].salt = p.salt;
  list[index].passwordHash = p.hash;

  saveUsers(list);

  console.log(
    `Administrador restableció la contraseña de ${username}.`
  );

  res.json({
    success: true,
    username: list[index].username
  });
});

app.get("/api/admin/recordings", requireAdmin, (req, res) => {
  res.json(
    recordings()
      .slice()
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .map(item => ({ ...item }))
  );
});

app.get("/api/admin/recordings/:id", (req, res) => {
  const token = adminToken(req) || String(req.query.token || "");
  const admin = verifyAdminToken(token);
  if (!admin) {
    return res.status(401).send("Sesión de administrador no válida.");
  }

  const item = recordings().find(x => String(x.id) === String(req.params.id));
  if (!item) return res.status(404).send("Grabación no encontrada.");

  const filePath = path.join(RECORDINGS_DIR, item.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("El archivo de la grabación ya no está disponible en el servidor.");
  }

  res.type(item.mimeType || "audio/webm");
  fs.createReadStream(filePath).pipe(res);
});

app.delete("/api/admin/recordings/:id", requireAdmin, (req, res) => {
  const list = recordings();
  const index = list.findIndex(x => String(x.id) === String(req.params.id));
  if (index < 0) return res.status(404).json({ error: "Grabación no encontrada." });

  const removed = list.splice(index, 1)[0];
  saveRecordings(list);
  try { fs.unlinkSync(path.join(RECORDINGS_DIR, removed.fileName)); } catch {}

  addAdminActivity(`Administrador eliminó una grabación de ${removed.fromDisplay} con ${removed.toDisplay}.`);
  res.json({ success: true });
});

app.get("/api/admin/users/:username/stories", requireAdmin, (req, res) => {
  const username = norm(req.params.username);

  if (!getUser(username)) {
    return res.status(404).json({
      error: "Usuario no encontrado."
    });
  }

  res.json(
    cleanExpiredStories().filter(
      story => norm(story.username) === username
    )
  );
});

app.get("/api/admin/stories", requireAdmin, (req, res) => {
  const list = cleanExpiredStories();

  list.sort(
    (a, b) =>
      Number(b.createdAt || 0) -
      Number(a.createdAt || 0)
  );

  res.json(list);
});

app.delete("/api/admin/stories/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");

  if (!id) {
    return res.status(400).json({
      error: "ID de estado inválido."
    });
  }

  const list = cleanExpiredStories();
  const index = list.findIndex(
    story => String(story.id) === id
  );

  if (index < 0) {
    return res.status(404).json({
      error: "Estado no encontrado."
    });
  }

  const removed = list.splice(index, 1)[0];
  saveStories(list);

  io.emit("storyDeleted", { id: removed.id });
  io.emit("storiesUpdated", list);

  console.log(
    "Administrador eliminó el estado " +
    removed.id +
    " de " +
    removed.username
  );

  res.json({ success: true });
});

app.get("/api/admin/activity", requireAdmin, (req, res) => {
  res.json(adminActivity.slice(-100).reverse());
});

app.get("/api/admin/reports", requireAdmin, (req, res) => {
  res.json(reports().slice().reverse());
});

app.patch("/api/admin/reports/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const status = String(req.body?.status || "").trim().toLowerCase();

  if (!["open", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Estado de reporte inválido." });
  }

  const list = reports();
  const item = list.find(r => String(r.id) === id);
  if (!item) return res.status(404).json({ error: "Reporte no encontrado." });

  item.status = status;
  item.resolvedAt = status === "resolved" ? Date.now() : null;
  saveReports(list);
  addAdminActivity(`Administrador marcó el reporte de @${item.username} como ${status === "resolved" ? "resuelto" : "abierto"}.`);

  res.json({ success: true });
});

app.delete("/api/admin/reports/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const list = reports();
  const index = list.findIndex(r => String(r.id) === id);
  if (index < 0) return res.status(404).json({ error: "Reporte no encontrado." });

  const removed = list[index];
  list.splice(index, 1);
  saveReports(list);
  addAdminActivity(`Administrador eliminó el reporte de @${removed.username}.`);
  res.json({ success: true });
});

app.get("/api/admin/messages", requireAdmin, (req, res) => {
  let limit = Number(req.query.limit || 100);

  if (!Number.isFinite(limit)) limit = 100;

  limit = Math.max(1, Math.min(limit, 500));

  res.json(
    messages().slice(-limit).reverse()
  );
});

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "admin", "index.html")
  );
});

app.get("/admin/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "admin", "index.html")
  );
});

// =====================================================
// PUSH / FIREBASE
// =====================================================

const vapidPublic = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivate = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject =
  process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(
    vapidSubject,
    vapidPublic,
    vapidPrivate
  );
}

let firebaseReady = false;

try {
  if (!getApps().length) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";

    // Render Secret Files
    if (!raw) {
      const secretPaths = [
        "/etc/secrets/firebase-service-account.json",
        path.join(__dirname, "firebase-service-account.json")
      ];

      for (const secretPath of secretPaths) {
        if (fs.existsSync(secretPath)) {
          raw = fs.readFileSync(secretPath, "utf8");
          break;
        }
      }
    }

    if (!raw) {
      throw new Error(
        "No se encontró la credencial de Firebase. Usa FIREBASE_SERVICE_ACCOUNT_JSON o /etc/secrets/firebase-service-account.json."
      );
    }

    const serviceAccount = JSON.parse(raw);

    initializeApp({
      credential: cert(serviceAccount)
    });

    firebaseReady = true;
    console.log("Firebase Admin listo para FCM.");
  } else {
    firebaseReady = true;
  }
} catch (error) {
  firebaseReady = false;
  console.error("FCM init error:", error.message);
}

async function sendFcmToUser(username, payload) {
  if (!firebaseReady) {
    console.error("FCM no está disponible.");
    return;
  }

  const data = fcmTokens();
  const key = norm(username);

  const tokens = Array.isArray(data[key])
    ? data[key].filter(Boolean)
    : [];

  if (!tokens.length) {
    console.log(`No hay tokens FCM registrados para ${key}.`);
    return;
  }

  const title = String(
    payload?.title ||
    payload?.from ||
    "Mi Chat"
  );

  const body = String(
    payload?.body ||
    payload?.message ||
    ""
  );

  const type = String(payload?.type || "message");

  const message = {
    tokens,
    data: {
      type,
      username: String(payload?.username || ""),
      sender: String(payload?.sender || payload?.from || ""),
      body,
      message: body
    },
    android: {
      priority: "high"
    }
  };

  // Las llamadas se envían como data-only para que
  // MyFirebaseMessagingService controle el tono y los botones
  // Contestar / Colgar incluso con la app cerrada.
  if (type !== "call") {
    message.notification = {
      title,
      body
    };

    message.android.notification = {
      channelId: "michat_messages",
      sound: "default"
    };
  }

  try {
    console.log(`Enviando FCM a ${key}. Tokens: ${tokens.length}`);

    const result = await getMessaging().sendEachForMulticast(message);

    console.log(
      `FCM enviado a ${key}: éxito=${result.successCount}, errores=${result.failureCount}`
    );

    if (result.failureCount > 0) {
      const invalid = new Set();

      result.responses.forEach((response, index) => {
        if (response.success) {
          console.log(`FCM OK [${index}] para ${key}`);
          return;
        }

        const error = response.error;
        const code = error?.code || "sin-código";
        const messageText = error?.message || "sin-mensaje";

        console.error(`ERROR FCM DETALLADO [${index}] para ${key}:`);
        console.error(`Código: ${code}`);
        console.error(`Mensaje: ${messageText}`);

        if (error?.details) {
          console.error("Detalles:", error.details);
        }

        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          invalid.add(tokens[index]);
        }
      });

      if (invalid.size > 0) {
        data[key] = tokens.filter(token => !invalid.has(token));
        saveFcmTokens(data);

        console.log(
          `Se eliminaron ${invalid.size} tokens inválidos de ${key}.`
        );
      }
    }
  } catch (error) {
    console.error("FCM send error:");
    console.error("Código:", error?.code || "sin-código");
    console.error("Mensaje:", error?.message || error);
    if (error?.stack) {
      console.error(error.stack);
    }
  }
}

function sendPushToUser(username, payload) {
  // Push web
  if (vapidPublic && vapidPrivate) {
    for (const item of pushSubs()) {
      if (
        norm(item.username) !== norm(username)
      ) {
        continue;
      }

      webpush
        .sendNotification(
          item.subscription,
          JSON.stringify(payload)
        )
        .catch(() => {});
    }
  }

  // Android / Firebase
  sendFcmToUser(
    username,
    payload
  ).catch(() => {});
}

// =====================================================
// USUARIOS
// =====================================================

function sendUserList() {
  const list = users().map(u => ({
    username: u.username,
    displayName: u.displayName || u.username,
    profileImage: u.profileImage || "",
    online: [...online.values()].some(
      x => norm(x) === norm(u.username)
    )
  }));

  io.emit("userList", list);
}

function getContactList(username) {
  const me = getUser(username);

  if (!me) return [];

  const contacts = Array.isArray(me.contacts)
    ? me.contacts
    : [];

  return contacts
    .map(name => getUser(name))
    .filter(Boolean)
    .filter(
      u => !isEitherBlocked(
        username,
        u.username
      )
    )
    .map(u => ({
      username: u.username,
      displayName:
        u.displayName || u.username,
      profileImage:
        u.profileImage || "",
      online: [...online.values()].some(
        x => norm(x) === norm(u.username)
      )
    }));
}

function socketIdFor(username) {
  for (const [sid, name] of online.entries()) {
    if (norm(name) === norm(username)) {
      return sid;
    }
  }

  return null;
}

app.post("/api/register", (req, res) => {
  const displayName =
    String(req.body.username || "").trim();

  const password =
    String(req.body.password || "");

  if (
    displayName.length < 3 ||
    displayName.length > 24
  ) {
    return res.status(400).json({
      error:
        "El nombre debe tener entre 3 y 24 caracteres."
    });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(displayName)) {
    return res.status(400).json({
      error:
        "Solo letras, números y _."
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      error:
        "La contraseña debe tener al menos 6 caracteres."
    });
  }

  const username = norm(displayName);
  const list = users();

  if (
    list.some(
      u => norm(u.username) === username
    )
  ) {
    return res.status(400).json({
      error: "Ese usuario ya existe."
    });
  }

  const p = passwordHash(password);

  list.push({
    username,
    displayName,
    salt: p.salt,
    passwordHash: p.hash,
    profileImage: "",
    blockedUsers: [],
    contacts: [],
    createdAt: Date.now()
  });

  saveUsers(list);

  const token = newSession(username);

  sendUserList();

  res.json({
    success: true,
    username: displayName,
    token
  });
});

app.post("/api/login", (req, res) => {
  const username =
    norm(req.body.username);

  const password =
    String(req.body.password || "");

  const u = getUser(username);

  if (
    !u ||
    !validPassword(
      password,
      u.salt,
      u.passwordHash
    )
  ) {
    return res.status(401).json({
      error:
        "Usuario o contraseña incorrectos."
    });
  }

  const list = users();

  const idx = list.findIndex(
    x => norm(x.username) ===
      norm(u.username)
  );

  if (idx >= 0) {
    if (!Array.isArray(list[idx].contacts)) {
      list[idx].contacts = [];
    }

    if (!Array.isArray(list[idx].blockedUsers)) {
      list[idx].blockedUsers = [];
    }

    saveUsers(list);
  }

  const token = newSession(u.username);

  res.json({
    success: true,
    username: u.displayName,
    token
  });
});

app.get("/api/session", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      loggedIn: false
    });
  }

  res.json({
    loggedIn: true,
    username: u.username,
    displayName: u.displayName,
    profileImage:
      u.profileImage || ""
  });
});

app.post("/api/logout", (req, res) => {
  deleteSession(
    authToken(req)
  );

  res.json({
    success: true
  });
});

app.get("/api/profile", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  res.json({
    username: u.username,
    displayName: u.displayName,
    profileImage:
      u.profileImage || ""
  });
});

app.post("/api/profile", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const displayName = String(
    req.body.displayName ||
    u.displayName
  ).trim();

  const profileImage = String(
    req.body.profileImage || ""
  );

  if (
    displayName.length < 3 ||
    displayName.length > 24
  ) {
    return res.status(400).json({
      error: "Nombre inválido."
    });
  }

  if (profileImage.length > 800000) {
    return res.status(400).json({
      error:
        "La imagen es demasiado grande."
    });
  }

  const list = users();

  const idx = list.findIndex(
    x => norm(x.username) ===
      norm(u.username)
  );

  if (idx < 0) {
    return res.status(404).json({
      error:
        "Usuario no encontrado."
    });
  }

  list[idx].displayName =
    displayName;

  list[idx].profileImage =
    profileImage;

  saveUsers(list);
  sendUserList();

  res.json({
    success: true,
    displayName,
    profileImage
  });
});

// =====================================================
// CONTACTOS
// =====================================================

app.get("/api/contacts", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  res.json(
    getContactList(u.username)
  );
});

app.post("/api/contacts/add", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const target =
    norm(req.body.username);

  const targetUser =
    getUser(target);

  if (!target) {
    return res.status(400).json({
      error:
        "Escribe un nombre de usuario."
    });
  }

  if (
    target === norm(u.username)
  ) {
    return res.status(400).json({
      error:
        "No puedes añadirte a ti mismo."
    });
  }

  if (!targetUser) {
    return res.status(404).json({
      error:
        "Ese usuario no existe."
    });
  }

  if (
    isEitherBlocked(
      u.username,
      target
    )
  ) {
    return res.status(400).json({
      error:
        "No puedes añadir a este usuario."
    });
  }

  const list = users();

  const idx = list.findIndex(
    x => norm(x.username) ===
      norm(u.username)
  );

  if (idx < 0) {
    return res.status(404).json({
      error:
        "Usuario no encontrado."
    });
  }

  if (!Array.isArray(list[idx].contacts)) {
    list[idx].contacts = [];
  }

  if (
    !list[idx].contacts.some(
      x => norm(x) === target
    )
  ) {
    list[idx].contacts.push(target);
    saveUsers(list);
  }

  res.json({
    success: true,
    contact:
      getContactList(
        u.username
      ).find(
        x => norm(x.username) === target
      ) || null
  });
});

app.post("/api/contacts/remove", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const target =
    norm(req.body.username);

  const list = users();

  const idx = list.findIndex(
    x => norm(x.username) ===
      norm(u.username)
  );

  if (idx < 0) {
    return res.status(404).json({
      error:
        "Usuario no encontrado."
    });
  }

  list[idx].contacts =
    (list[idx].contacts || [])
      .filter(
        x => norm(x) !== target
      );

  saveUsers(list);

  res.json({
    success: true
  });
});

// =====================================================
// PUSH WEB
// =====================================================

app.post("/api/push/subscribe", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const subscription =
    req.body.subscription;

  if (
    !subscription ||
    !subscription.endpoint
  ) {
    return res.status(400).json({
      error:
        "Suscripción inválida."
    });
  }

  const list = pushSubs();

  const exists = list.some(
    x =>
      x.username === u.username &&
      x.subscription.endpoint ===
        subscription.endpoint
  );

  if (!exists) {
    list.push({
      username: u.username,
      subscription
    });
  }

  savePushSubs(list);

  res.json({
    success: true,
    enabled:
      !!(
        vapidPublic &&
        vapidPrivate
      )
  });
});

app.get("/api/push/public-key", (req, res) => {
  res.json({
    enabled:
      !!(
        vapidPublic &&
        vapidPrivate
      ),
    publicKey: vapidPublic
  });
});

// =====================================================
// TOKEN FCM ANDROID
// =====================================================

app.post("/api/fcm/token", (req, res) => {
  const user = sessionUser(
    authToken(req)
  );

  if (!user) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const token =
    String(req.body.token || "").trim();

  if (
    !token ||
    token.length < 20 ||
    token.length > 4096
  ) {
    return res.status(400).json({
      error:
        "Token FCM inválido."
    });
  }

  const data = fcmTokens();

  // El mismo dispositivo/token no debe
  // quedarse asociado a varios usuarios.
  for (const username of Object.keys(data)) {
    data[username] =
      (
        Array.isArray(data[username])
          ? data[username]
          : []
      ).filter(
        existing => existing !== token
      );
  }

  const key =
    norm(user.username);

  if (!Array.isArray(data[key])) {
    data[key] = [];
  }

  if (!data[key].includes(token)) {
    data[key].push(token);
  }

  data[key] =
    data[key].slice(-5);

  saveFcmTokens(data);

  console.log(
    `FCM token registrado para ${key}. Total de dispositivos: ${data[key].length}`
  );

  res.json({
    success: true
  });
});

// =====================================================
// HISTORIAS
// =====================================================

app.get("/api/stories", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const list =
    cleanExpiredStories()
      .map(story => ({
        ...story,
        views:
          Array.isArray(story.views)
            ? story.views
            : []
      }));

  res.json(list);
});

app.post("/api/stories", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const type =
    req.body.type === "image"
      ? "image"
      : "text";

  const content =
    String(req.body.content || "").trim();

  if (!content) {
    return res.status(400).json({
      error:
        "La historia no puede estar vacía."
    });
  }

  if (
    type === "text" &&
    content.length > 500
  ) {
    return res.status(400).json({
      error:
        "El texto puede tener como máximo 500 caracteres."
    });
  }

  if (
    type === "image" &&
    content.length > 9000000
  ) {
    return res.status(400).json({
      error:
        "La imagen es demasiado grande."
    });
  }

  if (
    type === "image" &&
    !/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(
      content
    )
  ) {
    return res.status(400).json({
      error:
        "Formato de imagen no válido."
    });
  }

  const list =
    cleanExpiredStories();

  const ownCount =
    list.filter(
      s =>
        norm(s.username) ===
        norm(u.username)
    ).length;

  if (ownCount >= 20) {
    return res.status(400).json({
      error:
        "Has alcanzado el límite de 20 historias activas."
    });
  }

  const now = Date.now();

  const story = {
    id:
      now +
      "-" +
      crypto.randomBytes(5).toString("hex"),

    username: u.username,

    displayName:
      u.displayName || u.username,

    profileImage:
      u.profileImage || "",

    type,

    content,

    background:
      type === "text"
        ? String(
            req.body.background ||
            "#075e54"
          )
        : "",

    createdAt: now,

    expiresAt:
      now +
      24 * 60 * 60 * 1000,

    views: []
  };

  list.push(story);

  saveStories(list);

  io.emit(
    "storyCreated",
    story
  );

  io.emit(
    "storiesUpdated",
    list
  );

  res.json({
    success: true,
    story
  });
});

// =====================================================
// MARCAR HISTORIA COMO VISTA
// =====================================================

app.post("/api/stories/:id/view", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const list =
    cleanExpiredStories();

  const idx = list.findIndex(
    s =>
      String(s.id) ===
      String(req.params.id)
  );

  if (idx < 0) {
    return res.status(404).json({
      error:
        "Historia no encontrada."
    });
  }

  const story = list[idx];

  if (!Array.isArray(story.views)) {
    story.views = [];
  }

  if (
    norm(story.username) ===
    norm(u.username)
  ) {
    saveStories(list);

    return res.json({
      success: true,
      viewed: false,
      owner: true,
      views: story.views
    });
  }

  let added = false;

  if (
    !story.views.some(
      v =>
        norm(v.username) ===
        norm(u.username)
    )
  ) {
    const view = {
      username: u.username,
      displayName:
        u.displayName ||
        u.username,
      profileImage:
        u.profileImage || "",
      viewedAt: Date.now()
    };

    story.views.push(view);
    added = true;

    saveStories(list);

    const ownerSid =
      socketIdFor(
        story.username
      );

    if (ownerSid) {
      io.to(ownerSid).emit(
        "storyViewed",
        {
          storyId: story.id,
          view,
          views: story.views
        }
      );
    }
  } else {
    saveStories(list);
  }

  res.json({
    success: true,
    viewed: true,
    owner: false,
    added,
    views: story.views
  });
});

// =====================================================
// VER QUIÉN HA VISTO UNA HISTORIA
// =====================================================

app.get("/api/stories/:id/views", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const list =
    cleanExpiredStories();

  const story =
    list.find(
      s =>
        String(s.id) ===
        String(req.params.id)
    );

  if (!story) {
    return res.status(404).json({
      error:
        "Historia no encontrada."
    });
  }

  if (
    norm(story.username) !==
    norm(u.username)
  ) {
    return res.status(403).json({
      error:
        "Solo el dueño puede ver los espectadores."
    });
  }

  const views =
    Array.isArray(story.views)
      ? story.views
      : [];

  res.json({
    success: true,
    count: views.length,
    views
  });
});

app.delete("/api/stories/:id", (req, res) => {
  const u = sessionUser(
    authToken(req)
  );

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const list =
    cleanExpiredStories();

  const idx = list.findIndex(
    s =>
      String(s.id) ===
      String(req.params.id)
  );

  if (idx < 0) {
    return res.status(404).json({
      error:
        "Historia no encontrada."
    });
  }

  if (
    norm(list[idx].username) !==
    norm(u.username)
  ) {
    return res.status(403).json({
      error:
        "No puedes borrar esta historia."
    });
  }

  const removed =
    list.splice(idx, 1)[0];

  saveStories(list);

  io.emit(
    "storyDeleted",
    {
      id: removed.id
    }
  );

  io.emit(
    "storiesUpdated",
    list
  );

  res.json({
    success: true
  });
});

// =====================================================
// SOCKET.IO
// =====================================================

io.on("connection", socket => {
  socket.on("authenticate", token => {
    const u =
      sessionUser(token);

    if (!u) {
      return socket.emit(
        "authenticationError"
      );
    }

    for (const [
      sid,
      name
    ] of online.entries()) {
      if (
        sid !== socket.id &&
        norm(name) ===
          norm(u.username)
      ) {
        online.delete(sid);

        const old =
          io.sockets.sockets.get(sid);

        if (old) {
          old.disconnect(true);
        }
      }
    }

    online.set(
      socket.id,
      u.username
    );

    socket.emit(
      "authenticated",
      {
        username:
          u.username,
        displayName:
          u.displayName,
        profileImage:
          u.profileImage || ""
      }
    );

    sendUserList();

    emitUnread(
      socket,
      u.username
    );

    socket.emit(
      "storiesData",
      cleanExpiredStories()
    );

    socket.emit(
      "contactsUpdated",
      getContactList(
        u.username
      )
    );
  });

  // ===================================================
  // CONTACTOS
  // ===================================================

  socket.on("getContacts", () => {
    const me =
      online.get(socket.id);

    if (!me) return;

    socket.emit(
      "contactsUpdated",
      getContactList(me)
    );
  });

  socket.on(
    "addContact",
    username => {
      const me =
        online.get(socket.id);

      const target =
        norm(username);

      if (!me || !target) return;

      if (
        target === norm(me)
      ) {
        return socket.emit(
          "contactError",
          "No puedes añadirte a ti mismo."
        );
      }

      if (!getUser(target)) {
        return socket.emit(
          "contactError",
          "Ese usuario no existe."
        );
      }

      if (
        isEitherBlocked(
          me,
          target
        )
      ) {
        return socket.emit(
          "contactError",
          "No puedes añadir a este usuario."
        );
      }

      const list = users();

      const idx =
        list.findIndex(
          u =>
            norm(u.username) ===
            norm(me)
        );

      if (idx < 0) {
        return socket.emit(
          "contactError",
          "Usuario no encontrado."
        );
      }

      if (
        !Array.isArray(
          list[idx].contacts
        )
      ) {
        list[idx].contacts = [];
      }

      if (
        !list[idx].contacts.some(
          x =>
            norm(x) ===
            target
        )
      ) {
        list[idx].contacts.push(
          target
        );

        saveUsers(list);
      }

      const contact =
        getContactList(me).find(
          x =>
            norm(x.username) ===
            target
        );

      socket.emit(
        "contactAdded",
        contact || {
          username: target
        }
      );

      socket.emit(
        "contactsUpdated",
        getContactList(me)
      );
    }
  );

  socket.on(
    "removeContact",
    username => {
      const me =
        online.get(socket.id);

      const target =
        norm(username);

      if (!me || !target) return;

      const list = users();

      const idx =
        list.findIndex(
          u =>
            norm(u.username) ===
            norm(me)
        );

      if (idx < 0) return;

      list[idx].contacts =
        (
          list[idx].contacts ||
          []
        ).filter(
          x =>
            norm(x) !==
            target
        );

      saveUsers(list);

      socket.emit(
        "contactRemoved",
        {
          username: target
        }
      );

      socket.emit(
        "contactsUpdated",
        getContactList(me)
      );
    }
  );

  // ===================================================
  // HISTORIAS
  // ===================================================

  socket.on(
    "getStories",
    () => {
      const me =
        online.get(socket.id);

      if (!me) return;

      socket.emit(
        "storiesData",
        cleanExpiredStories()
      );
    }
  );

  // ===================================================
  // BUSCAR USUARIO
  // ===================================================

  socket.on(
    "findUser",
    username => {
      const me =
        online.get(socket.id);

      if (!me) return;

      const target =
        norm(username);

      if (!target) {
        return socket.emit(
          "userNotFound"
        );
      }

      if (
        target === norm(me)
      ) {
        return socket.emit(
          "userFoundError",
          "No puedes contactar contigo mismo."
        );
      }

      const u =
        getUser(target);

      if (!u) {
        return socket.emit(
          "userNotFound"
        );
      }

      if (
        isEitherBlocked(
          me,
          target
        )
      ) {
        return socket.emit(
          "userFoundError",
          "No puedes contactar con este usuario."
        );
      }

      socket.emit(
        "userFound",
        {
          username: u.username,
          displayName:
            u.displayName,
          profileImage:
            u.profileImage || "",
          online:
            [...online.values()]
              .some(
                x =>
                  norm(x) ===
                  target
              )
        }
      );
    }
  );

  // ===================================================
  // CONVERSACIÓN
  // ===================================================

  socket.on(
    "getConversation",
    otherUsername => {
      const me =
        online.get(socket.id);

      const other =
        norm(otherUsername);

      if (
        !me ||
        !getUser(other)
      ) {
        return;
      }

      if (
        isEitherBlocked(
          me,
          other
        )
      ) {
        return socket.emit(
          "conversationBlocked",
          "Esta conversación está bloqueada."
        );
      }

      const conv =
        messages()
          .filter(
            m =>
              (
                norm(m.from) ===
                  norm(me) &&
                norm(m.to) ===
                  other
              ) ||
              (
                norm(m.from) ===
                  other &&
                norm(m.to) ===
                  norm(me)
              )
          )
          .filter(
            m =>
              !(
                m.deletedFor ||
                []
              ).includes(
                norm(me)
              )
          );

      socket.emit(
        "conversationHistory",
        {
          username: other,
          messages: conv
        }
      );
    }
  );

  // ===================================================
  // MENSAJES
  // ===================================================

  socket.on(
    "privateMessage",
    data => {
      const me =
        online.get(socket.id);

      const to =
        norm(data?.to);

      const text =
        String(
          data?.message || ""
        ).trim();

      const media = data?.media && typeof data.media === "object"
        ? data.media
        : null;

      const mediaData = media
        ? String(media.data || "")
        : "";

      const mediaMime = media
        ? String(media.mimeType || "").slice(0, 120)
        : "";

      const mediaName = media
        ? String(media.fileName || "archivo").slice(0, 180)
        : "";

      const mediaType = media
        ? String(media.type || "file").slice(0, 30)
        : "";

      const allowedMedia = !mediaMime ||
        mediaMime.startsWith("image/") ||
        mediaMime.startsWith("video/") ||
        mediaMime.startsWith("audio/") ||
        [
          "application/pdf",
          "text/plain",
          "application/zip",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        ].includes(mediaMime);

      const hasMedia = Boolean(
        mediaData &&
        mediaData.startsWith("data:") &&
        mediaData.length <= 10 * 1024 * 1024 &&
        allowedMedia
      );

      if (
        !me ||
        !to ||
        (!text && !hasMedia) ||
        text.length > 5000
      ) {
        return;
      }

      if (media && !hasMedia) {
        return socket.emit(
          "messageError",
          "El archivo no es válido, no está permitido o supera el límite de 7 MB."
        );
      }

      if (!getUser(to)) {
        return socket.emit(
          "messageError",
          "Ese usuario no existe."
        );
      }

      if (
        to === norm(me)
      ) {
        return socket.emit(
          "messageError",
          "No puedes enviarte mensajes."
        );
      }

      if (
        isEitherBlocked(
          me,
          to
        )
      ) {
        return socket.emit(
          "messageError",
          "No puedes contactar con este usuario."
        );
      }

      const msg = {
        id:
          Date.now() +
          "-" +
          crypto.randomBytes(5).toString("hex"),

        from: norm(me),

        fromDisplay:
          getUser(me)?.displayName ||
          me,

        to,

        toDisplay:
          getUser(to)?.displayName ||
          to,

        message: text,

        type: hasMedia
          ? mediaType || "file"
          : "text",

        media: hasMedia
          ? mediaData
          : "",

        fileName: hasMedia
          ? mediaName
          : "",

        mimeType: hasMedia
          ? mediaMime
          : "",

        time:
          new Date().toISOString(),

        read: false,

        deletedFor: []
      };

      const list =
        messages();

      list.push(msg);

      if (list.length > 50000) {
        list.splice(
          0,
          list.length - 50000
        );
      }

      saveMessages(list);

      const targetSid =
        socketIdFor(to);

      if (targetSid) {
        io.to(targetSid).emit(
          "privateMessage",
          msg
        );
      }

      socket.emit(
        "messageSent",
        msg
      );

      sendPushToUser(
        to,
        {
          type: "message",
          from:
            msg.fromDisplay,
          message:
            msg.message ||
            (msg.fileName
              ? "📎 " + msg.fileName
              : "Archivo multimedia"),
          username:
            msg.from
        }
      );
    }
  );

  socket.on(
    "markConversationRead",
    otherUsername => {
      const me =
        online.get(socket.id);

      const other =
        norm(otherUsername);

      if (!me) return;

      const list =
        messages();

      for (const m of list) {
        if (
          norm(m.from) ===
            other &&
          norm(m.to) ===
            norm(me)
        ) {
          m.read = true;
        }
      }

      saveMessages(list);

      emitUnread(
        socket,
        me
      );
    }
  );

  socket.on(
    "deleteMessage",
    id => {
      const me =
        online.get(socket.id);

      if (!me || !id) return;

      const list =
        messages();

      const idx =
        list.findIndex(
          m => m.id === id
        );

      if (idx < 0) return;

      if (
        norm(list[idx].from) !==
        norm(me)
      ) {
        return socket.emit(
          "messageError",
          "Solo puedes borrar tus propios mensajes."
        );
      }

      list[idx].deletedFor =
        Array.from(
          new Set([
            ...(list[idx]
              .deletedFor || []),
            norm(me)
          ])
        );

      list[idx].message =
        "Mensaje eliminado";

      list[idx].deleted = true;

      saveMessages(list);

      const target =
        list[idx].to;

      for (
        const [sid, name]
        of online.entries()
      ) {
        if (
          norm(name) ===
            target ||
          norm(name) ===
            norm(me)
        ) {
          io.to(sid).emit(
            "messageDeleted",
            {
              id:
                list[idx].id,
              message:
                list[idx].message
            }
          );
        }
      }
    }
  );

  // ===================================================
  // BLOQUEOS
  // ===================================================

  socket.on(
    "blockUser",
    username => {
      const me =
        online.get(socket.id);

      const target =
        norm(username);

      if (
        !me ||
        !target ||
        target === norm(me) ||
        !getUser(target)
      ) {
        return;
      }

      const list = users();

      const idx =
        list.findIndex(
          u =>
            norm(u.username) ===
            norm(me)
        );

      if (idx < 0) return;

      list[idx].blockedUsers =
        Array.from(
          new Set([
            ...(list[idx]
              .blockedUsers || []),
            target
          ])
        );

      list[idx].contacts =
        (
          list[idx].contacts ||
          []
        ).filter(
          x =>
            norm(x) !==
            target
        );

      saveUsers(list);

      socket.emit(
        "blockUpdated",
        {
          username: target,
          blocked: true
        }
      );

      socket.emit(
        "contactsUpdated",
        getContactList(me)
      );

      sendUserList();
    }
  );

  socket.on(
    "unblockUser",
    username => {
      const me =
        online.get(socket.id);

      const target =
        norm(username);

      if (!me || !target) return;

      const list = users();

      const idx =
        list.findIndex(
          u =>
            norm(u.username) ===
            norm(me)
        );

      if (idx < 0) return;

      list[idx].blockedUsers =
        (
          list[idx]
            .blockedUsers || []
        ).filter(
          x =>
            norm(x) !==
            target
        );

      saveUsers(list);

      socket.emit(
        "blockUpdated",
        {
          username: target,
          blocked: false
        }
      );

      sendUserList();
    }
  );

  socket.on(
    "getBlockedUsers",
    () => {
      const me =
        online.get(socket.id);

      if (!me) return;

      socket.emit(
        "blockedUsers",
        getUser(me)?.blockedUsers ||
          []
      );
    }
  );

  // ===================================================
  // LLAMADAS WEBRTC
  // ===================================================

  socket.on(
    "callRequest",
    ({ to }) => {
      const caller =
        online.get(socket.id);

      const target =
        norm(to);

      if (!caller || !target) {
        return;
      }

      if (
        target === norm(caller)
      ) {
        return socket.emit(
          "callError",
          "No puedes llamarte a ti mismo."
        );
      }

      if (
        isEitherBlocked(
          caller,
          target
        )
      ) {
        return socket.emit(
          "callError",
          "No puedes contactar con este usuario."
        );
      }

      const targetUser =
        getUser(target);

      if (!targetUser) {
        return socket.emit(
          "callError",
          "Ese usuario no existe."
        );
      }

      const callerName =
        getUser(caller)?.displayName ||
        caller;

      // Si el receptor tiene la app/web abierta,
      // avisamos inmediatamente mediante Socket.IO.
      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "incomingCall",
          {
            from: norm(caller),
            fromDisplay:
              callerName
          }
        );
      }

      // IMPORTANTE:
      // Se manda FCM SIEMPRE, incluso si el receptor
      // está desconectado o tiene la app cerrada.
      sendPushToUser(
        target,
        {
          type: "call",
          title:
            "Llamada entrante",
          body:
            callerName +
            " te está llamando",
          from:
            callerName,
          username:
            norm(caller),
          message:
            "Llamada entrante"
        }
      );

      // Indicamos al llamante que el aviso
      // de llamada ha sido iniciado.
      socket.emit(
        "callRinging",
        {
          to: target,
          online:
            !!targetSid
        }
      );
    }
  );

  socket.on(
    "callAccept",
    ({ to }) => {
      const callee =
        online.get(socket.id);

      const target =
        norm(to);

      if (!callee || !target) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (!targetSid) {
        return socket.emit(
          "callError",
          "El usuario ya no está conectado."
        );
      }

      io.to(targetSid).emit(
        "callAccepted",
        {
          from:
            norm(callee),
          fromDisplay:
            getUser(callee)?.displayName ||
            callee
        }
      );
    }
  );

  socket.on(
    "callReject",
    ({ to }) => {
      const rejecter =
        online.get(socket.id);

      const target =
        norm(to);

      if (
        !rejecter ||
        !target
      ) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "callRejected",
          {
            from:
              norm(rejecter)
          }
        );
      }
    }
  );

  socket.on(
    "callOffer",
    ({ to, offer }) => {
      const sender =
        online.get(socket.id);

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !offer
      ) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "callOffer",
          {
            from:
              norm(sender),
            offer
          }
        );
      }
    }
  );

  socket.on(
    "callAnswer",
    ({ to, answer }) => {
      const sender =
        online.get(socket.id);

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !answer
      ) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "callAnswer",
          {
            from:
              norm(sender),
            answer
          }
        );
      }
    }
  );

  socket.on(
    "callIceCandidate",
    ({ to, candidate }) => {
      const sender =
        online.get(socket.id);

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !candidate
      ) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "callIceCandidate",
          {
            from:
              norm(sender),
            candidate
          }
        );
      }
    }
  );

  socket.on(
    "recordingStarted",
    ({ to }) => {
      const sender = online.get(socket.id);
      const target = norm(to);
      if (!sender || !target || isEitherBlocked(sender, target)) return;
      const targetSid = socketIdFor(target);
      if (targetSid) io.to(targetSid).emit("recordingStarted", { from: norm(sender) });
    }
  );

  socket.on(
    "recordingStopped",
    ({ to }) => {
      const sender = online.get(socket.id);
      const target = norm(to);
      if (!sender || !target) return;
      const targetSid = socketIdFor(target);
      if (targetSid) io.to(targetSid).emit("recordingStopped", { from: norm(sender) });
    }
  );

  socket.on(
    "callEnd",
    ({ to }) => {
      const sender =
        online.get(socket.id);

      const target =
        norm(to);

      if (
        !sender ||
        !target
      ) {
        return;
      }

      const targetSid =
        socketIdFor(target);

      if (targetSid) {
        io.to(targetSid).emit(
          "callEnded",
          {
            from:
              norm(sender)
          }
        );
      }
    }
  );

  socket.on(
    "disconnect",
    () => {
      online.delete(socket.id);
      sendUserList();
    }
  );
});

// =====================================================
// NO LEÍDOS
// =====================================================

function unreadCountsFor(username) {
  const counts = {};

  const blocks =
    getUser(username)?.blockedUsers ||
    [];

  for (const m of messages()) {
    if (
      norm(m.to) ===
        norm(username) &&
      !m.read &&
      !blocks.includes(
        norm(m.from)
      )
    ) {
      const from =
        norm(m.from);

      counts[from] =
        (counts[from] || 0) + 1;
    }
  }

  return counts;
}

function emitUnread(
  socket,
  username
) {
  socket.emit(
    "unreadCounts",
    unreadCountsFor(username)
  );
}

function isBlocked(a, b) {
  const u = getUser(a);

  return !!(
    u &&
    (
      u.blockedUsers ||
      []
    ).includes(
      norm(b)
    )
  );
}

function isEitherBlocked(
  a,
  b
) {
  return (
    isBlocked(a, b) ||
    isBlocked(b, a)
  );
}

// =====================================================
// LIMPIEZA DE HISTORIAS
// =====================================================

setInterval(() => {
  const before =
    allStories().length;

  const after =
    cleanExpiredStories();

  if (
    before !== after.length
  ) {
    io.emit(
      "storiesUpdated",
      after
    );
  }
}, 60 * 1000);

// =====================================================
// INDEX
// =====================================================

app.get("/{*splat}", (req, res, next) => {
  if (
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  if (
    req.path.startsWith(
      "/socket.io/"
    )
  ) {
    return next();
  }

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

(async () => {
  await initializeDatabase();

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Mi Chat funcionando en http://localhost:${PORT}`
      );
      console.log(
        `Persistencia: ${supabaseAvailable ? "Supabase activa" : "local temporal"}`
      );
    }
  );
})();
