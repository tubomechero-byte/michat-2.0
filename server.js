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

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  messages: path.join(DATA_DIR, "messages.json"),
  sessions: path.join(DATA_DIR, "sessions.json"),
  push: path.join(DATA_DIR, "push.json"),
  stories: path.join(DATA_DIR, "stories.json"),
  fcm: path.join(DATA_DIR, "fcm.json")
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function ensure(file, value) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(value, null, 2),
      "utf8"
    );
  }
}

ensure(FILES.users, []);
ensure(FILES.messages, []);
ensure(FILES.sessions, {});
ensure(FILES.push, []);
ensure(FILES.stories, []);
ensure(FILES.fcm, {});

function read(file, fallback) {
  try {
    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

const users = () => read(FILES.users, []);
const messages = () => read(FILES.messages, []);
const sessions = () => read(FILES.sessions, {});
const pushSubs = () => read(FILES.push, []);
const stories = () => read(FILES.stories, []);
const fcmTokens = () => read(FILES.fcm, {});

function saveUsers(v) {
  write(FILES.users, v);
}

function saveMessages(v) {
  write(FILES.messages, v);
}

function saveSessions(v) {
  write(FILES.sessions, v);
}

function savePushSubs(v) {
  write(FILES.push, v);
}

function saveStories(v) {
  write(FILES.stories, v);
}

function saveFcmTokens(v) {
  write(FILES.fcm, v);
}

function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function getUser(username) {
  const n = norm(username);

  return users().find(
    u => norm(u.username) === n
  );
}

function passwordHash(password) {
  const salt =
    crypto.randomBytes(16).toString("hex");

  const hash =
    crypto
      .scryptSync(password, salt, 64)
      .toString("hex");

  return {
    salt,
    hash
  };
}

function validPassword(password, salt, hash) {
  try {
    const got =
      crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(got, "hex"),
      Buffer.from(hash, "hex")
    );
  } catch {
    return false;
  }
}

function newSession(username) {
  const data = sessions();

  const token =
    crypto.randomBytes(32).toString("hex");

  data[token] = {
    username,
    createdAt: Date.now()
  };

  saveSessions(data);

  return token;
}

function sessionUser(token) {
  if (!token) return null;

  const s = sessions()[token];

  return s
    ? getUser(s.username)
    : null;
}

function deleteSession(token) {
  const data = sessions();

  delete data[token];

  saveSessions(data);
}

function authToken(req) {
  const a =
    req.headers.authorization || "";

  return a.startsWith("Bearer ")
    ? a.slice(7)
    : "";
}

function onlineUsername(socketId) {
  return online.get(socketId) || null;
}

function socketIdFor(username) {
  const n = norm(username);

  for (const [sid, name] of online.entries()) {
    if (norm(name) === n) {
      return sid;
    }
  }

  return null;
}

function isBlocked(a, b) {
  const u = getUser(a);

  return !!(
    u &&
    Array.isArray(u.blockedUsers) &&
    u.blockedUsers.some(
      x => norm(x) === norm(b)
    )
  );
}

function isEitherBlocked(a, b) {
  return (
    isBlocked(a, b) ||
    isBlocked(b, a)
  );
}

function cleanExpiredStories() {
  const now = Date.now();

  const active =
    stories().filter(
      s => Number(s.expiresAt) > now
    );

  saveStories(active);

  return active;
}

app.use(
  express.json({
    limit: "12mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const online = new Map();

const vapidPublic =
  process.env.VAPID_PUBLIC_KEY || "";

const vapidPrivate =
  process.env.VAPID_PRIVATE_KEY || "";

const vapidSubject =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@example.com";

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
    let raw =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      "";

    if (!raw) {
      for (const p of [
        "/etc/secrets/firebase-service-account.json",
        path.join(
          __dirname,
          "firebase-service-account.json"
        )
      ]) {
        if (fs.existsSync(p)) {
          raw =
            fs.readFileSync(
              p,
              "utf8"
            );

          break;
        }
      }
    }

    if (!raw) {
      throw new Error(
        "No se encontró la credencial de Firebase. Usa FIREBASE_SERVICE_ACCOUNT_JSON o /etc/secrets/firebase-service-account.json."
      );
    }

    initializeApp({
      credential: cert(
        JSON.parse(raw)
      )
    });

    console.log(
      "Firebase Admin listo para FCM."
    );
  } else {
    console.log(
      "Firebase Admin ya estaba inicializado."
    );
  }

  firebaseReady = true;

} catch (error) {
  firebaseReady = false;

  console.error(
    "FCM init error:",
    error.message
  );
}


/* =====================================================
   FCM — CORREGIDO
   ===================================================== */

async function sendFcmToUser(
  username,
  payload
) {
  if (!firebaseReady) {
    console.log(
      "FCM no está disponible."
    );

    return;
  }

  const data = fcmTokens();

  const key = norm(username);

  const tokens =
    Array.isArray(data[key])
      ? data[key]
      : [];

  if (!tokens.length) {
    console.log(
      "No hay tokens FCM registrados para " +
      key +
      "."
    );

    return;
  }

  const title = String(
    payload &&
      (
        payload.title ||
        payload.from
      ) ||
      "Mi Chat"
  );

  const body = String(
    payload &&
      (
        payload.body ||
        payload.message
      ) ||
      ""
  );

  const message = {
    tokens,

    notification: {
      title,
      body
    },

    data: {
      type: String(
        payload &&
          payload.type ||
        "message"
      ),

      username: String(
        payload &&
          payload.username ||
        ""
      ),

      from: String(
        payload &&
          payload.from ||
        ""
      ),

      body,
      message: body
    },

    android: {
      priority: "high",

      notification: {
        channelId:
          "michat_messages",

        sound: "default"
      }
    }
  };

  try {
    console.log(
      "Enviando FCM a " +
      key +
      ". Tokens: " +
      tokens.length
    );

    /*
     * IMPORTANTE:
     * Aquí se crea "response".
     * No usamos "result" y después "response".
     */
    const response =
      await getMessaging()
        .sendEachForMulticast(
          message
        );

    console.log(
      "FCM enviado a " +
      key +
      ": éxito=" +
      response.successCount +
      ", errores=" +
      response.failureCount
    );

    if (
      response.failureCount > 0
    ) {
      response.responses.forEach(
        (result, index) => {

          if (!result.success) {
            console.error(
              "ERROR FCM DETALLADO [" +
              index +
              "]:",

              result.error &&
                result.error.code,

              result.error &&
                result.error.message
            );
          }
        }
      );
    }

    /*
     * Eliminar tokens que Firebase
     * haya marcado como inválidos.
     */
    if (
      response.failureCount > 0
    ) {
      const invalid =
        new Set();

      response.responses.forEach(
        (result, index) => {

          const code =
            result.error &&
            result.error.code;

          if (
            !result.success &&
            (
              code ===
                "messaging/registration-token-not-registered" ||

              code ===
                "messaging/invalid-registration-token"
            )
          ) {
            invalid.add(
              tokens[index]
            );
          }
        }
      );

      if (invalid.size) {
        data[key] =
          tokens.filter(
            token =>
              !invalid.has(token)
          );

        saveFcmTokens(data);

        console.log(
          "Se eliminaron " +
          invalid.size +
          " tokens inválidos de " +
          key +
          "."
        );
      }
    }

    return response;

  } catch (error) {

    /*
     * Aquí ya NO se usa una variable
     * llamada "response" que no exista.
     */
    console.error(
      "FCM send error:",
      error
    );

    return null;
  }
}


/* =====================================================
   PUSH
   ===================================================== */

function sendPushToUser(
  username,
  payload
) {

  if (
    vapidPublic &&
    vapidPrivate
  ) {

    for (
      const item of pushSubs()
    ) {

      if (
        norm(item.username) !==
        norm(username)
      ) {
        continue;
      }

      webpush
        .sendNotification(
          item.subscription,
          JSON.stringify(payload)
        )
        .catch(e =>
          console.error(
            "Error enviando Web Push:",
            e.message
          )
        );
    }
  }

  sendFcmToUser(
    username,
    payload
  ).catch(e =>
    console.error(
      "Error enviando FCM:",
      e.message
    )
  );
}


/* =====================================================
   USUARIOS
   ===================================================== */

function sendUserList() {

  io.emit(
    "userList",

    users().map(u => ({
      username:
        u.username,

      displayName:
        u.displayName ||
        u.username,

      profileImage:
        u.profileImage ||
        "",

      online:
        [...online.values()].some(
          x =>
            norm(x) ===
            norm(u.username)
        )
    }))
  );
}

function getContactList(
  username
) {

  const me =
    getUser(username);

  if (!me) {
    return [];
  }

  const contacts =
    Array.isArray(me.contacts)
      ? me.contacts
      : [];

  return contacts
    .map(getUser)
    .filter(Boolean)
    .filter(
      u =>
        !isEitherBlocked(
          username,
          u.username
        )
    )
    .map(u => ({
      username:
        u.username,

      displayName:
        u.displayName ||
        u.username,

      profileImage:
        u.profileImage ||
        "",

      online:
        [...online.values()].some(
          x =>
            norm(x) ===
            norm(u.username)
        )
    }));
}

function unreadCountsFor(
  username
) {

  const counts = {};

  const user =
    getUser(username);

  const blocks =
    (
      user &&
      user.blockedUsers
    ) || [];

  for (
    const m of messages()
  ) {

    if (
      norm(m.to) ===
        norm(username) &&

      !m.read &&

      !blocks.some(
        b =>
          norm(b) ===
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
    unreadCountsFor(
      username
    )
  );
}


/* =====================================================
   AUTH
   ===================================================== */

app.post(
  "/api/register",
  (req, res) => {

    const displayName =
      String(
        req.body &&
          req.body.username ||
        ""
      ).trim();

    const password =
      String(
        req.body &&
          req.body.password ||
        ""
      );

    if (
      displayName.length < 3 ||
      displayName.length > 24
    ) {
      return res.status(400).json({
        error:
          "El nombre debe tener entre 3 y 24 caracteres."
      });
    }

    if (
      !/^[a-zA-Z0-9_]+$/.test(
        displayName
      )
    ) {
      return res.status(400).json({
        error:
          "Solo letras, números y _."
      });
    }

    if (
      password.length < 6
    ) {
      return res.status(400).json({
        error:
          "La contraseña debe tener al menos 6 caracteres."
      });
    }

    const username =
      norm(displayName);

    const list =
      users();

    if (
      list.some(
        u =>
          norm(u.username) ===
          username
      )
    ) {
      return res.status(400).json({
        error:
          "Ese usuario ya existe."
      });
    }

    const p =
      passwordHash(
        password
      );

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

    sendUserList();

    res.json({
      success: true,
      username: displayName,
      token:
        newSession(
          username
        )
    });
  }
);

app.post(
  "/api/login",
  (req, res) => {

    const username =
      norm(
        req.body &&
          req.body.username
      );

    const password =
      String(
        req.body &&
          req.body.password ||
        ""
      );

    const u =
      getUser(username);

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

    const list =
      users();

    const idx =
      list.findIndex(
        x =>
          norm(x.username) ===
          norm(u.username)
      );

    if (idx >= 0) {

      if (
        !Array.isArray(
          list[idx].contacts
        )
      ) {
        list[idx].contacts =
          [];
      }

      if (
        !Array.isArray(
          list[idx].blockedUsers
        )
      ) {
        list[idx].blockedUsers =
          [];
      }

      saveUsers(list);
    }

    res.json({
      success: true,
      username:
        u.displayName,
      token:
        newSession(
          u.username
        )
    });
  }
);

app.get(
  "/api/session",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        loggedIn: false
      });
    }

    res.json({
      loggedIn: true,
      username:
        u.displayName,
      profileImage:
        u.profileImage || ""
    });
  }
);

app.post(
  "/api/logout",
  (req, res) => {

    deleteSession(
      authToken(req)
    );

    res.json({
      success: true
    });
  }
);

app.get(
  "/api/profile",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    res.json({
      username:
        u.username,

      displayName:
        u.displayName,

      profileImage:
        u.profileImage || ""
    });
  }
);

app.post(
  "/api/profile",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const displayName =
      String(
        req.body &&
          req.body.displayName ||
        u.displayName
      ).trim();

    const profileImage =
      String(
        req.body &&
          req.body.profileImage ||
        ""
      );

    if (
      displayName.length < 3 ||
      displayName.length > 24
    ) {
      return res.status(400).json({
        error:
          "Nombre inválido."
      });
    }

    if (
      profileImage.length >
      800000
    ) {
      return res.status(400).json({
        error:
          "La imagen es demasiado grande."
      });
    }

    const list =
      users();

    const idx =
      list.findIndex(
        x =>
          norm(x.username) ===
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
  }
);


/* =====================================================
   CONTACTS
   ===================================================== */

app.get(
  "/api/contacts",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    res.json(
      getContactList(
        u.username
      )
    );
  }
);

app.post(
  "/api/contacts/add",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const target =
      norm(
        req.body &&
          req.body.username
      );

    if (!target) {
      return res.status(400).json({
        error:
          "Escribe un nombre de usuario."
      });
    }

    if (
      target ===
      norm(u.username)
    ) {
      return res.status(400).json({
        error:
          "No puedes añadirte a ti mismo."
      });
    }

    if (!getUser(target)) {
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

    const list =
      users();

    const idx =
      list.findIndex(
        x =>
          norm(x.username) ===
          norm(u.username)
      );

    if (idx < 0) {
      return res.status(404).json({
        error:
          "Usuario no encontrado."
      });
    }

    if (
      !Array.isArray(
        list[idx].contacts
      )
    ) {
      list[idx].contacts =
        [];
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
    }

    saveUsers(list);

    res.json({
      success: true,

      contact:
        getContactList(
          u.username
        ).find(
          x =>
            norm(x.username) ===
            target
        ) || null
    });
  }
);

app.post(
  "/api/contacts/remove",
  (req, res) => {

    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const target =
      norm(
        req.body &&
          req.body.username
      );

    const list =
      users();

    const idx =
      list.findIndex(
        x =>
          norm(x.username) ===
          norm(u.username)
      );

    if (idx < 0) {
      return res.status(404).json({
        error:
          "Usuario no encontrado."
      });
    }

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

    res.json({
      success: true
    });
  }
);


/* =====================================================
   WEB PUSH
   ===================================================== */

app.post(
  "/a
