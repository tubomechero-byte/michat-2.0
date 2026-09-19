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

ensure(USERS_FILE, []);
ensure(MESSAGES_FILE, []);
ensure(SESSIONS_FILE, {});
ensure(PUSH_FILE, []);
ensure(STORIES_FILE, []);
ensure(FCM_FILE, {});

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

function fcmTokens() {
  return read(FCM_FILE, {});
}

function saveFcmTokens(v) {
  write(FCM_FILE, v);
}

function cleanExpiredStories() {
  const now = Date.now();

  const active =
    allStories().filter(
      story =>
        Number(story.expiresAt) > now
    );

  saveStories(active);

  return active;
}

function norm(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function getUser(username) {
  const u = norm(username);

  return users().find(
    x =>
      norm(x.username) === u
  );
}

function passwordHash(password) {
  const salt =
    crypto.randomBytes(16).toString("hex");

  const hash =
    crypto
      .scryptSync(
        password,
        salt,
        64
      )
      .toString("hex");

  return {
    salt,
    hash
  };
}

function validPassword(
  password,
  salt,
  hash
) {
  try {
    const got =
      crypto
        .scryptSync(
          password,
          salt,
          64
        )
        .toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(got, "hex"),
      Buffer.from(hash, "hex")
    );

  } catch {
    return false;
  }
}


/* =====================================================
   SESIONES
===================================================== */

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "michat-session-secret-change-this-in-render";

function createSessionToken(username) {

  const payload =
    Buffer
      .from(
        JSON.stringify({
          username:
            norm(username),

          createdAt:
            Date.now()
        })
      )
      .toString("base64url");

  const signature =
    crypto
      .createHmac(
        "sha256",
        SESSION_SECRET
      )
      .update(payload)
      .digest("base64url");

  return (
    payload +
    "." +
    signature
  );
}

function verifySessionToken(token) {

  if (
    !token ||
    typeof token !== "string"
  ) {
    return null;
  }

  const parts =
    token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [
    payload,
    signature
  ] = parts;

  const expected =
    crypto
      .createHmac(
        "sha256",
        SESSION_SECRET
      )
      .update(payload)
      .digest("base64url");

  const a =
    Buffer.from(signature);

  const b =
    Buffer.from(expected);

  if (a.length !== b.length) {
    return null;
  }

  try {

    if (
      !crypto.timingSafeEqual(
        a,
        b
      )
    ) {
      return null;
    }

  } catch {
    return null;
  }

  try {

    const data =
      JSON.parse(
        Buffer
          .from(
            payload,
            "base64url"
          )
          .toString("utf8")
      );

    if (
      !data ||
      !data.username
    ) {
      return null;
    }

    return data;

  } catch {
    return null;
  }
}

function newSession(username) {
  return createSessionToken(
    username
  );
}

function sessionUser(token) {

  if (!token) {
    return null;
  }

  const signed =
    verifySessionToken(token);

  if (signed) {
    return getUser(
      signed.username
    );
  }

  const legacy =
    sessions()[token];

  if (!legacy) {
    return null;
  }

  return getUser(
    legacy.username
  );
}

function deleteSession(token) {

  if (!token) {
    return;
  }

  const data =
    sessions();

  if (
    Object.prototype.hasOwnProperty.call(
      data,
      token
    )
  ) {

    delete data[token];

    saveSessions(data);
  }
}

function authToken(req) {

  const a =
    req.headers.authorization ||
    "";

  return a.startsWith("Bearer ")
    ? a.slice(7)
    : "";
}


app.use(
  express.json({
    limit: "12mb"
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

const online =
  new Map();


/* =====================================================
   PUSH / FIREBASE
===================================================== */

const vapidPublic =
  process.env.VAPID_PUBLIC_KEY ||
  "";

const vapidPrivate =
  process.env.VAPID_PRIVATE_KEY ||
  "";

const vapidSubject =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@example.com";

if (
  vapidPublic &&
  vapidPrivate
) {

  webpush.setVapidDetails(
    vapidSubject,
    vapidPublic,
    vapidPrivate
  );
}

let firebaseReady =
  false;

try {

  if (!getApps().length) {

    let raw =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      "";

    if (!raw) {

      const secretPaths = [
        "/etc/secrets/firebase-service-account.json",
        path.join(
          __dirname,
          "firebase-service-account.json"
        )
      ];

      for (
        const secretPath
        of secretPaths
      ) {

        if (
          fs.existsSync(
            secretPath
          )
        ) {

          raw =
            fs.readFileSync(
              secretPath,
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

    const serviceAccount =
      JSON.parse(raw);

    initializeApp({
      credential:
        cert(serviceAccount)
    });

    firebaseReady =
      true;

    console.log(
      "Firebase Admin listo para FCM."
    );

  } else {

    firebaseReady =
      true;
  }

} catch (error) {

  firebaseReady =
    false;

  console.error(
    "FCM init error:",
    error.message
  );
}


async function sendFcmToUser(
  username,
  payload
) {

  if (!firebaseReady) {

    console.error(
      "FCM no está disponible."
    );

    return;
  }

  const data =
    fcmTokens();

  const key =
    norm(username);

  const tokens =
    Array.isArray(
      data[key]
    )
      ? data[key]
      : [];

  if (!tokens.length) {

    console.log(
      `No hay tokens FCM registrados para ${key}.`
    );

    return;
  }

  const title =
    String(
      payload.title ||
      payload.from ||
      "Mi Chat"
    );

  const body =
    String(
      payload.body ||
      payload.message ||
      ""
    );

  const message = {

    tokens,

    notification: {
      title,
      body
    },

    data: {
      type:
        String(
          payload.type ||
          "message"
        ),

      username:
        String(
          payload.username ||
          ""
        ),

      from:
        String(
          payload.from ||
          ""
        ),

      body,

      message:
        body
    },

    android: {

      priority:
        "high",

      notification: {
        channelId:
          "michat_messages"
      }
    }
  };

  try {

    console.log(
      `Enviando FCM a ${key}. Tokens: ${tokens.length}`
    );

    const result =
      await getMessaging()
        .sendEachForMulticast(
          message
        );

    console.log(
      `FCM enviado a ${key}: éxito=${result.successCount}, errores=${result.failureCount}`
    );

    if (
      result.failureCount >
      0
    ) {

      const current =
        fcmTokens();

      const valid =
        [];

      result.responses.forEach(
        (response, index) => {

          if (
            response.success
          ) {

            valid.push(
              tokens[index]
            );

          } else {

            const code =
              response.error?.code ||
              "";

            if (
              code !==
                "messaging/registration-token-not-registered" &&
              code !==
                "messaging/invalid-registration-token"
            ) {

              valid.push(
                tokens[index]
              );
            }
          }
        }
      );

      current[key] =
        valid.slice(-5);

      saveFcmTokens(
        current
      );
    }

  } catch (error) {

    console.error(
      "FCM send error:",
      error.message
    );
  }
}


async function sendPushToUser(
  username,
  payload
) {

  const user =
    getUser(username);

  if (!user) {
    return;
  }

  if (
    vapidPublic &&
    vapidPrivate
  ) {

    const subscriptions =
      pushSubs();

    const target =
      subscriptions.filter(
        item =>
          norm(
            item?.username
          ) ===
          norm(
            user.username
          )
      );

    for (
      const item
      of target
    ) {

      try {

        await webpush.sendNotification(
          item.subscription,
          JSON.stringify(
            payload
          )
        );

      } catch (error) {

        console.error(
          "Web Push error:",
          error.message
        );
      }
    }
  }

  await sendFcmToUser(
    username,
    payload
  );
}


/* =====================================================
   AUTENTICACIÓN
===================================================== */

app.post(
  "/api/register",
  (req, res) => {

    const displayName =
      String(
        req.body.username ||
        ""
      ).trim();

    const password =
      String(
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
      passwordHash(password);

    list.push({
      username,

      displayName,

      salt:
        p.salt,

      passwordHash:
        p.hash,

      profileImage:
        "",

      blockedUsers:
        [],

      contacts:
        [],

      createdAt:
        Date.now()
    });

    saveUsers(list);

    sendUserList();

    const token =
      newSession(
        username
      );

    res.json({
      success:
        true,

      username:
        displayName,

      token
    });
  }
);


app.post(
  "/api/login",
  (req, res) => {

    const username =
      norm(
        req.body.username
      );

    const password =
      String(
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

    const token =
      newSession(
        u.username
      );

    res.json({
      success:
        true,

      username:
        u.displayName,

      token
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
        loggedIn:
          false
      });
    }

    res.json({

      loggedIn:
        true,

      username:
        u.username,

      displayName:
        u.displayName,

      profileImage:
        u.profileImage ||
        ""
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
      success:
        true
    });
  }
);


/* =====================================================
   PERFIL
===================================================== */

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
        u.profileImage ||
        ""
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
        req.body.displayName ||
        u.displayName
      ).trim();

    const profileImage =
      String(
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
      success:
        true,

      displayName,

      profileImage
    });
  }
);


/* =====================================================
   CONTACTOS
===================================================== */

function getContactList(
  username
) {

  const u =
    getUser(username);

  if (!u) {
    return [];
  }

  const contacts =
    Array.isArray(
      u.contacts
    )
      ? u.contacts
      : [];

  return contacts
    .map(
      username => {

        const user =
          getUser(username);

        if (!user) {
          return null;
        }

        return {

          username:
            user.username,

          displayName:
            user.displayName,

          profileImage:
            user.profileImage ||
            "",

          online:
            socketIdFor(
              user.username
            ) !== null
        };
      }
    )
    .filter(Boolean);
}


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
        req.body.username
      );

    const targetUser =
      getUser(target);

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

    const list =
      users();

    const idx =
      list.findIndex(
        user =>
          norm(user.username) ===
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

      saveUsers(list);
    }

    const contact =
      getContactList(
        u.username
      ).find(
        x =>
          norm(x.username) ===
          target
      );

    res.json({
      success:
        true,

      contact:
        contact || {
          username:
            target
        }
    });

    const sid =
      socketIdFor(
        u.username
      );

    if (sid) {

      io.to(sid).emit(
        "contactsUpdated",
        getContactList(
          u.username
        )
      );
    }
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
        req.body.username
      );

    const list =
      users();

    const idx =
      list.findIndex(
        user =>
          norm(user.username) ===
          norm(u.username)
      );

    if (idx < 0) {

      return res.status(404).json({
        error:
          "Usuario no encontrado."
      });
    }

    list[idx].contacts =
      Array.isArray(
        list[idx].contacts
      )
        ? list[idx].contacts.filter(
            x =>
              norm(x) !==
              target
          )
        : [];

    saveUsers(list);

    res.json({
      success:
        true
    });

    const sid =
      socketIdFor(
        u.username
      );

    if (sid) {

      io.to(sid).emit(
        "contactsUpdated",
        getContactList(
          u.username
        )
      );
    }
  }
);


/* =====================================================
   FCM TOKEN
===================================================== */

app.post(
  "/api/fcm/token",
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

    const token =
      String(
        req.body.token ||
        ""
      ).trim();

    if (!token) {

      return res.status(400).json({
        error:
          "Token FCM requerido."
      });
    }

    const data =
      fcmTokens();

    const key =
      norm(u.username);

    if (
      !Array.isArray(
        data[key]
      )
    ) {

      data[key] =
        [];
    }

    if (
      !data[key].includes(
        token
      )
    ) {

      data[key].push(
        token
      );
    }

    data[key] =
      data[key].slice(-5);

    saveFcmTokens(data);

    console.log(
      `FCM token registrado para ${key}. Total de dispositivos: ${data[key].length}`
    );

    res.json({
      success:
        true,

      username:
        u.username,

      devices:
        data[key].length
    });
  }
);


/* =====================================================
   HISTORIAS
===================================================== */

app.get(
  "/api/stories",
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

    const list =
      cleanExpiredStories()
        .map(
          story => ({
            ...story,

            views:
              Array.isArray(
                story.views
              )
                ? story.views
                : []
          })
        );

    res.json(list);
  }
);


app.post(
  "/api/stories",
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

    const type =
      req.body.type ===
      "image"
        ? "image"
        : "text";

    const content =
      String(
        req.body.content ||
        ""
      ).trim();

    if (!content) {

      return res.status(400).json({
        error:
          "La historia no puede estar vacía."
      });
    }

    if (
      type === "text" &&
      content.length >
        500
    ) {

      return res.status(400).json({
        error:
          "El texto puede tener como máximo 500 caracteres."
      });
    }

    if (
      type === "image" &&
      content.length >
        9000000
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
        story =>
          norm(
            story.username
          ) ===
          norm(
            u.username
          )
      ).length;

    if (
      ownCount >= 20
    ) {

      return res.status(400).json({
        error:
          "Has alcanzado el límite de 20 historias activas."
      });
    }

    const now =
      Date.now();

    const story = {

      id:
        now +
        "-" +
        crypto
          .randomBytes(5)
          .toString("hex"),

      username:
        u.username,

      displayName:
        u.displayName ||
        u.username,

      profileImage:
        u.profileImage ||
        "",

      type,

      content,

      background:
        type === "text"
          ? String(
              req.body.background ||
              "#075e54"
            )
          : "",

      createdAt:
        now,

      expiresAt:
        now +
        24 * 60 * 60 * 1000,

      views:
        []
    };

    list.push(
      story
    );

    saveStories(
      list
    );

    io.emit(
      "storyCreated",
      story
    );

    io.emit(
      "storiesUpdated",
      list
    );

    res.json({
      success:
        true,

      story
    });
  }
);


/* =====================================================
   HISTORIAS VISTAS
===================================================== */

app.post(
  "/api/stories/:id/view",
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

    const list =
      cleanExpiredStories();

    const idx =
      list.findIndex(
        story =>
          String(story.id) ===
          String(req.params.id)
      );

    if (idx < 0) {

      return res.status(404).json({
        error:
          "Historia no encontrada."
      });
    }

    const story =
      list[idx];

    if (
      !Array.isArray(
        story.views
      )
    ) {

      story.views =
        [];
    }

    if (
      norm(
        story.username
      ) ===
      norm(
        u.username
      )
    ) {

      saveStories(
        list
      );

      return res.json({
        success:
          true,

        viewed:
          false,

        owner:
          true,

        views:
          story.views
      });
    }

    let added =
      false;

    if (
      !story.views.some(
        view =>
          norm(
            view.username
          ) ===
          norm(
            u.username
          )
      )
    ) {

      const view = {

        username:
          u.username,

        displayName:
          u.displayName ||
          u.username,

        profileImage:
          u.profileImage ||
          "",

        viewedAt:
          Date.now()
      };

      story.views.push(
        view
      );

      added =
        true;

      saveStories(
        list
      );

      const ownerSid =
        socketIdFor(
          story.username
        );

      if (ownerSid) {

        io.to(
          ownerSid
        ).emit(
          "storyViewed",
          {
            storyId:
              story.id,

            view,

            views:
              story.views
          }
        );
      }

    } else {

      saveStories(
        list
      );
    }

    res.json({

      success:
        true,

      viewed:
        true,

      owner:
        false,

      added,

      views:
        story.views
    });
  }
);


app.get(
  "/api/stories/:id/views",
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

    const list =
      cleanExpiredStories();

    const story =
      list.find(
        item =>
          String(item.id) ===
          String(req.params.id)
      );

    if (!story) {

      return res.status(404).json({
        error:
          "Historia no encontrada."
      });
    }

    if (
      norm(
        story.username
      ) !==
      norm(
        u.username
      )
    ) {

      return res.status(403).json({
        error:
          "Solo el dueño puede ver los espectadores."
      });
    }

    const views =
      Array.isArray(
        story.views
      )
        ? story.views
        : [];

    res.json({

      success:
        true,

      count:
        views.length,

      views
    });
  }
);


app.delete(
  "/api/stories/:id",
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

    const list =
      cleanExpiredStories();

    const idx =
      list.findIndex(
        story =>
          String(story.id) ===
          String(req.params.id)
      );

    if (idx < 0) {

      return res.status(404).json({
        error:
          "Historia no encontrada."
      });
    }

    if (
      norm(
        list[idx].username
      ) !==
      norm(
        u.username
      )
    ) {

      return res.status(403).json({
        error:
          "No puedes borrar esta historia."
      });
    }

    const removed =
      list.splice(
        idx,
        1
      )[0];

    saveStories(
      list
    );

    io.emit(
      "storyDeleted",
      {
        id:
          removed.id
      }
    );

    io.emit(
      "storiesUpdated",
      list
    );

    res.json({
      success:
        true
    });
  }
);


/* =====================================================
   FUNCIONES DE USUARIOS ONLINE
===================================================== */

function socketIdFor(
  username
) {

  const target =
    norm(username);

  for (
    const [
      sid,
      name
    ]
    of online.entries()
  ) {

    if (
      norm(name) ===
      target
    ) {

      return sid;
    }
  }

  return null;
}

function getUserList() {

  const list =
    users();

  return list.map(
    user => ({

      username:
        user.username,

      displayName:
        user.displayName,

      profileImage:
        user.profileImage ||
        "",

      online:
        socketIdFor(
          user.username
        ) !== null
    })
  );
}

function sendUserList() {

  io.emit(
    "userList",
    getUserList()
  );
}


/* =====================================================
   MENSAJES
===================================================== */

function unreadCountsFor(
  username
) {

  const counts = {};

  const blocks =
    getUser(username)?.blockedUsers ||
    [];

  for (
    const m
    of messages()
  ) {

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
        (counts[from] || 0) +
        1;
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


function isBlocked(
  a,
  b
) {

  const u =
    getUser(a);

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


/* =====================================================
   SOCKET.IO
===================================================== */

io.on(
  "connection",
  socket => {

    socket.on(
      "authenticate",
      token => {

        const u =
          sessionUser(
            token
          );

        if (!u) {

          return socket.emit(
            "authenticationError"
          );
        }

        for (
          const [
            sid,
            name
          ]
          of online.entries()
        ) {

          if (
            sid !== socket.id &&
            norm(name) ===
              norm(
                u.username
              )
          ) {

            online.delete(
              sid
            );

            const old =
              io.sockets.sockets.get(
                sid
              );

            if (old) {
              old.disconnect(
                true
              );
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
              u.displayName,

            profileImage:
              u.profileImage ||
              ""
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
      }
    );


    /* =================================================
       CONTACTOS SOCKET
    ================================================= */

    socket.on(
      "getContacts",
      () => {

        const me =
          online.get(
            socket.id
          );

        if (!me) {
          return;
        }

        socket.emit(
          "contactsUpdated",
          getContactList(me)
        );
      }
    );


    socket.on(
      "addContact",
      username => {

        const me =
          online.get(
            socket.id
          );

        const target =
          norm(username);

        if (
          !me ||
          !target
        ) {
          return;
        }

        if (
          target ===
          norm(me)
        ) {

          return socket.emit(
            "contactError",
            "No puedes añadirte a ti mismo."
          );
        }

        if (
          !getUser(target)
        ) {

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

        const list =
          users();

        const idx =
          list.findIndex(
            u =>
              norm(
                u.username
              ) ===
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
            list[idx]
              .contacts
          )
        ) {

          list[idx]
            .contacts = [];
        }

        if (
          !list[idx]
            .contacts
            .some(
              x =>
                norm(x) ===
                target
            )
        ) {

          list[idx]
            .contacts
            .push(
              target
            );

          saveUsers(list);
        }

        const contact =
          getContactList(
            me
          ).find(
            x =>
              norm(
                x.username
              ) ===
              target
          );

        socket.emit(
          "contactAdded",
          contact || {
            username:
              target
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
          online.get(
            socket.id
          );

        const target =
          norm(username);

        if (
          !me ||
          !target
        ) {
          return;
        }

        const list =
          users();

        const idx =
          list.findIndex(
            u =>
              norm(
                u.username
              ) ===
              norm(me)
          );

        if (idx < 0) {
          return;
        }

        list[idx].contacts =
          Array.isArray(
            list[idx].contacts
          )
            ? list[idx].contacts.filter(
                x =>
                  norm(x) !==
                  target
              )
            : [];

        saveUsers(list);

        socket.emit(
          "contactsUpdated",
          getContactList(me)
        );
      }
    );


    /* =================================================
       MENSAJES
    ================================================= */

    socket.on(
      "privateMessage",
      data => {

        const me =
          online.get(
            socket.id
          );

        if (!me) {
          return;
        }

        const to =
          norm(
            data?.to
          );

        const text =
          String(
            data?.message ||
            ""
          )
          .trim()
          .slice(
            0,
            5000
          );

        if (
          !to ||
          !text
        ) {
          return;
        }

        if (
          !getUser(to)
        ) {

          return socket.emit(
            "messageError",
            "Ese usuario no existe."
          );
        }

        if (
          to ===
          norm(me)
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
            crypto
              .randomBytes(5)
              .toString("hex"),

          from:
            norm(me),

          fromDisplay:
            getUser(me)?.displayName ||
            me,

          to,

          toDisplay:
            getUser(to)?.displayName ||
            to,

          message:
            text,

          time:
            new Date().toISOString(),

          read:
            false,

          deletedFor:
            []
        };

        const list =
          messages();

        list.push(
          msg
        );

        if (
          list.length >
          50000
        ) {

          list.splice(
            0,
            list.length -
              50000
          );
        }

        saveMessages(
          list
        );

        const targetSid =
          socketIdFor(to);

        if (targetSid) {

          io.to(
            targetSid
          ).emit(
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
            type:
              "message",

            from:
              msg.fromDisplay,

            message:
              msg.message,

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
          online.get(
            socket.id
          );

        const other =
          norm(
            otherUsername
          );

        if (!me) {
          return;
        }

        const list =
          messages();

        for (
          const m
          of list
        ) {

          if (
            norm(m.from) ===
              other &&

            norm(m.to) ===
              norm(me)
          ) {

            m.read =
              true;
          }
        }

        saveMessages(
          list
        );

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
          online.get(
            socket.id
          );

        if (
          !me ||
          !id
        ) {
          return;
        }

        const list =
          messages();

        const idx =
          list.findIndex(
            m =>
              m.id ===
              id
          );

        if (idx < 0) {
          return;
        }

        if (
          norm(
            list[idx].from
          ) !==
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
                .deletedFor ||
                []),

              norm(me)
            ])
          );

        list[idx].message =
          "Mensaje eliminado";

        list[idx].deleted =
          true;

        saveMessages(
          list
        );

        const target =
          list[idx].to;

        for (
          const [
            sid,
            name
          ]
          of online.entries()
        ) {

          if (
            norm(name) ===
              target ||
            norm(name) ===
              norm(me)
          ) {

            io.to(
              sid
            ).emit(
              "messageDeleted",
              {
                id:
                  list[idx].id,

                message:
                  list[idx]
                    .message
              }
            );
          }
        }
      }
    );


    /* =================================================
       BLOQUEOS
    ================================================= */

    socket.on(
      "getBlockedUsers",
      () => {

        const me =
          online.get(
            socket.id
          );

        if (!me) {
          return;
        }

        socket.emit(
          "blockedUsers",
          getUser(me)
            ?.blockedUsers ||
            []
        );
      }
    );


    socket.on(
      "blockUser",
      username => {

        const me =
          online.get(
            socket.id
          );

        const target =
          norm(username);

        if (
          !me ||
          !target
        ) {
          return;
        }

        if (
          target ===
          norm(me)
        ) {
          return;
        }

        if (
          !getUser(target)
        ) {
          return;
        }

        const list =
          users();

        const idx =
          list.findIndex(
            u =>
              norm(
                u.username
              ) ===
              norm(me)
          );

        if (idx < 0) {
          return;
        }

        if (
          !Array.isArray(
            list[idx]
              .blockedUsers
          )
        ) {

          list[idx]
            .blockedUsers = [];
        }

        if (
          !list[idx]
            .blockedUsers
            .includes(
              target
            )
        ) {

          list[idx]
            .blockedUsers
            .push(
              target
            );

          saveUsers(
            list
          );
        }

        socket.emit(
          "blockUpdated",
          {
            username:
              target,

            blocked:
              true
          }
        );

        sendUserList();
      }
    );


    socket.on(
      "unblockUser",
      username => {

        const me =
          online.get(
            socket.id
          );

        const target =
          norm(username);

        if (
          !me ||
          !target
        ) {
          return;
        }

        const list =
          users();

        const idx =
          list.findIndex(
            u =>
              norm(
                u.username
              ) ===
              norm(me)
          );

        if (idx < 0) {
          return;
        }

        list[idx]
          .blockedUsers =
          Array.isArray(
            list[idx]
              .blockedUsers
          )
            ? list[idx]
                .blockedUsers
                .filter(
                  x =>
                    norm(x) !==
                    target
                )
            : [];

        saveUsers(
          list
        );

        socket.emit(
          "blockUpdated",
          {
            username:
              target,

            blocked:
              false
          }
        );

        sendUserList();
      }
    );


    /* =================================================
       WEBRTC
    ================================================= */

    socket.on(
      "callRequest",
      ({ to }) => {

        const caller =
          online.get(
            socket.id
          );

        const target =
          norm(to);

        if (
          !caller ||
          !target
        ) {
          return;
        }

        if (
          target ===
          norm(caller)
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
          getUser(
            caller
          )?.displayName ||
          caller;

        const targetSid =
          socketIdFor(
            target
          );

        if (targetSid) {

          io.to(
            targetSid
          ).emit(
            "incomingCall",
            {
              from:
                norm(caller),

              fromDisplay:
                callerName
            }
          );
        }

        sendPushToUser(
          target,
          {
            type:
              "call",

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

        socket.emit(
          "callRinging",
          {
            to:
              target,

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
          online.get(
            socket.id
          );

        const target =
          norm(to);

        if (
          !callee ||
          !target
        ) {
          return;
        }

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {

          return socket.emit(
            "callError",
            "El usuario ya no está conectado."
          );
        }

        io.to(
          targetSid
        ).emit(
          "callAccepted",
          {
            from:
              norm(callee),

            fromDisplay:
              getUser(callee)
                ?.displayName ||
              callee
          }
        );
      }
    );


    socket.on(
      "callReject",
      ({ to }) => {

        const rejecter =
          online.get(
            socket.id
          );

        const target =
          norm(to);

        if (
          !rejecter ||
          !target
        ) {
          return;
        }

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {
          return;
        }

        io.to(
          targetSid
        ).emit(
          "callRejected"
        );
      }
    );


    socket.on(
      "callEnd",
      ({ to }) => {

        const caller =
          online.get(
            socket.id
          );

        const target =
          norm(to);

        if (
          !caller ||
          !target
        ) {
          return;
        }

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {
          return;
        }

        io.to(
          targetSid
        ).emit(
          "callEnded"
        );
      }
    );


    socket.on(
      "callOffer",
      data => {

        const me =
          online.get(
            socket.id
          );

        if (
          !me ||
          !data ||
          !data.to ||
          !data.offer
        ) {
          return;
        }

        const target =
          norm(
            data.to
          );

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {
          return;
        }

        io.to(
          targetSid
        ).emit(
          "callOffer",
          {
            from:
              norm(me),

            offer:
              data.offer
          }
        );
      }
    );


    socket.on(
      "callAnswer",
      data => {

        const me =
          online.get(
            socket.id
          );

        if (
          !me ||
          !data ||
          !data.to ||
          !data.answer
        ) {
          return;
        }

        const target =
          norm(
            data.to
          );

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {
          return;
        }

        io.to(
          targetSid
        ).emit(
          "callAnswer",
          {
            from:
              norm(me),

            answer:
              data.answer
          }
        );
      }
    );


    socket.on(
      "callIceCandidate",
      data => {

        const me =
          online.get(
            socket.id
          );

        if (
          !me ||
          !data ||
          !data.to ||
          !data.candidate
        ) {
          return;
        }

        const target =
          norm(
            data.to
          );

        const targetSid =
          socketIdFor(
            target
          );

        if (!targetSid) {
          return;
        }

        io.to(
          targetSid
        ).emit(
          "callIceCandidate",
          {
            from:
              norm(me),

            candidate:
              data.candidate
          }
        );
      }
    );


    /* =================================================
       DESCONEXIÓN
    ================================================= */

    socket.on(
      "disconnect",
      () => {

        online.delete(
          socket.id
        );

        sendUserList();
      }
    );
  }
);


/* =====================================================
   LIMPIEZA AUTOMÁTICA DE HISTORIAS
===================================================== */

setInterval(
  () => {

    const before =
      allStories().length;

    const after =
      cleanExpiredStories();

    if (
      before !==
      after.length
    ) {

      io.emit(
        "storiesUpdated",
        after
      );
    }

  },
  60 * 1000
);


/* =====================================================
   INDEX
===================================================== */

app.get(
  "*",
  (req, res, next) => {

    if (
      req.path.startsWith(
        "/api/"
      )
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
  }
);


/* =====================================================
   SERVIDOR
===================================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Mi Chat funcionando en http://localhost:${PORT}`
    );
  }
);
