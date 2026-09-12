const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const webpush = require("web-push");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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

fs.mkdirSync(DATA_DIR, { recursive: true });

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

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
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

function stories() {
  return read(STORIES_FILE, []).filter(
    s => s.expiresAt > Date.now()
  );
}

function saveStories(v) {
  write(STORIES_FILE, v);
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

function newSession(username) {
  const s = sessions();

  const token = crypto.randomBytes(32).toString("hex");

  s[token] = {
    username,
    createdAt: Date.now()
  };

  saveSessions(s);

  return token;
}

function sessionUser(token) {
  if (!token) return null;

  const s = sessions()[token];

  if (!s) return null;

  return getUser(s.username);
}

function deleteSession(token) {
  const s = sessions();

  delete s[token];

  saveSessions(s);
}

function authToken(req) {
  const a = req.headers.authorization || "";

  return a.startsWith("Bearer ")
    ? a.slice(7)
    : "";
}

app.use(express.json({
  limit: "10mb"
}));

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// =====================================================
// USUARIOS CONECTADOS
// =====================================================

const online = new Map();

// =====================================================
// PUSH NOTIFICATIONS
// =====================================================

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

function sendPushToUser(username, payload) {
  if (!vapidPublic || !vapidPrivate) {
    return;
  }

  const subs = pushSubs();

  for (const sub of subs) {
    if (
      norm(sub.username) !==
      norm(username)
    ) {
      continue;
    }

    webpush
      .sendNotification(
        sub.subscription,
        JSON.stringify(payload)
      )
      .catch(() => {});
  }
}

// =====================================================
// REGISTRO
// =====================================================

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
      error:
        "Ese usuario ya existe."
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

// =====================================================
// LOGIN
// =====================================================

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

  const token =
    newSession(u.username);

  res.json({
    success: true,
    username: u.displayName,
    token
  });
});

// =====================================================
// SESIÓN
// =====================================================

app.get("/api/session", (req, res) => {
  const u =
    sessionUser(authToken(req));

  if (!u) {
    return res.status(401).json({
      loggedIn: false
    });
  }

  res.json({
    loggedIn: true,
    username: u.displayName,
    profileImage:
      u.profileImage || ""
  });
});

// =====================================================
// LOGOUT
// =====================================================

app.post("/api/logout", (req, res) => {
  deleteSession(
    authToken(req)
  );

  res.json({
    success: true
  });
});

// =====================================================
// PERFIL
// =====================================================

app.get("/api/profile", (req, res) => {
  const u =
    sessionUser(authToken(req));

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
  const u =
    sessionUser(authToken(req));

  if (!u) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const displayName =
    String(
      req.body.displayName ||
      u.displayName
    ).trim();

  const profileImage =
    String(
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

  if (
    profileImage.length > 800000
  ) {
    return res.status(400).json({
      error:
        "La imagen es demasiado grande."
    });
  }

  const list = users();

  const idx = list.findIndex(
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
});

// =====================================================
// PUSH
// =====================================================

app.post("/api/push/subscribe", (req, res) => {
  const u =
    sessionUser(authToken(req));

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
    publicKey:
      vapidPublic
  });
});

// =====================================================
// HISTORIAS
// =====================================================

app.get("/api/stories", (req, res) => {
  const currentUser =
    sessionUser(authToken(req));

  if (!currentUser) {
    return res.status(401).json({
      error: "No autorizado"
    });
  }

  const activeStories =
    stories();

  // Elimina del archivo las historias caducadas
  saveStories(activeStories);

  const grouped = {};

  for (const story of activeStories) {
    const key =
      norm(story.username);

    if (!grouped[key]) {
      grouped[key] = {
        username:
          story.username,

        displayName:
          story.displayName ||
          story.username,

        profileImage:
          story.profileImage ||
          "",

        stories: []
      };
    }

    grouped[key].stories.push(story);
  }

  const result =
    Object.values(grouped);

  result.sort((a, b) => {
    if (
      norm(a.username) ===
      norm(currentUser.username)
    ) {
      return -1;
    }

    if (
      norm(b.username) ===
      norm(currentUser.username)
    ) {
      return 1;
    }

    const aLast =
      a.stories[
        a.stories.length - 1
      ]?.createdAt || 0;

    const bLast =
      b.stories[
        b.stories.length - 1
      ]?.createdAt || 0;

    return bLast - aLast;
  });

  res.json(result);
});

// =====================================================
// PUBLICAR HISTORIA
// =====================================================

app.post("/api/stories", (req, res) => {
  const u =
    sessionUser(authToken(req));

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
    String(
      req.body.content || ""
    ).trim();

  const background =
    String(
      req.body.background || ""
    ).trim();

  if (!content) {
    return res.status(400).json({
      error:
        "La historia no puede estar vacía."
    });
  }

  // Texto
  if (
    type === "text" &&
    content.length > 500
  ) {
    return res.status(400).json({
      error:
        "El texto puede tener hasta 500 caracteres."
    });
  }

  // Imagen
  if (
    type === "image" &&
    content.length > 8000000
  ) {
    return res.status(400).json({
      error:
        "La imagen es demasiado grande."
    });
  }

  if (
    type === "image" &&
    !/^data:image\/(jpeg|png|webp|gif);base64,/i.test(
      content
    )
  ) {
    return res.status(400).json({
      error:
        "Formato de imagen no válido."
    });
  }

  const now = Date.now();

  const activeStories =
    stories();

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
        ? background ||
          "#075e54"
        : "",

    createdAt:
      now,

    expiresAt:
      now +
      24 * 60 * 60 * 1000
  };

  activeStories.push(story);

  saveStories(
    activeStories
  );

  // Avisar inmediatamente a todos los usuarios conectados
  io.emit(
    "storyCreated",
    story
  );

  res.json({
    success: true,
    story
  });
});

// =====================================================
// BORRAR HISTORIA
// =====================================================

app.delete(
  "/api/stories/:id",
  (req, res) => {
    const u =
      sessionUser(
        authToken(req)
      );

    if (!u) {
      return res.status(401).json({
        error: "No autorizado"
      });
    }

    const all =
      stories();

    const idx =
      all.findIndex(
        s =>
          s.id ===
          req.params.id
      );

    if (idx < 0) {
      return res.status(404).json({
        error:
          "Historia no encontrada."
      });
    }

    if (
      norm(all[idx].username) !==
      norm(u.username)
    ) {
      return res.status(403).json({
        error:
          "No puedes borrar esta historia."
      });
    }

    const removed =
      all.splice(idx, 1)[0];

    saveStories(all);

    io.emit(
      "storyDeleted",
      {
        id: removed.id
      }
    );

    res.json({
      success: true
    });
  }
);

// =====================================================
// SOCKET HELPERS
// =====================================================

function sendUserList() {
  const list =
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
        [...online.values()]
          .some(
            x =>
              norm(x) ===
              norm(u.username)
          )
    }));

  io.emit(
    "userList",
    list
  );
}

function unreadCountsFor(username) {
  const counts = {};

  const blocks =
    getUser(username)
      ?.blockedUsers || [];

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
    unreadCountsFor(username)
  );
}

function isBlocked(a, b) {
  const ua =
    getUser(a);

  return !!(
    ua &&
    (ua.blockedUsers || [])
      .includes(norm(b))
  );
}

function isEitherBlocked(a, b) {
  return (
    isBlocked(a, b) ||
    isBlocked(b, a)
  );
}

// =====================================================
// SOCKET.IO
// =====================================================

io.on("connection", socket => {

  // ===================================================
  // AUTENTICACIÓN
  // ===================================================

  socket.on(
    "authenticate",
    token => {
      const u =
        sessionUser(token);

      if (!u) {
        return socket.emit(
          "authenticationError"
        );
      }

      // Evitar dos sesiones del mismo usuario
      for (
        const [
          sid,
          name
        ] of online.entries()
      ) {
        if (
          sid !== socket.id &&
          norm(name) ===
            norm(u.username)
        ) {
          online.delete(sid);

          const old =
            io.sockets.sockets.get(
              sid
            );

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
    }
  );

  // ===================================================
  // BUSCAR USUARIO
  // ===================================================

  socket.on(
    "findUser",
    username => {
      const me =
        online.get(
          socket.id
        );

      if (!me) return;

      const target =
        norm(username);

      if (!target) {
        return socket.emit(
          "userNotFound"
        );
      }

      if (
        target ===
        norm(me)
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

      const onlineNow =
        [
          ...online.values()
        ].some(
          x =>
            norm(x) ===
            target
        );

      socket.emit(
        "userFound",
        {
          username:
            u.username,

          displayName:
            u.displayName,

          profileImage:
            u.profileImage ||
            "",

          online:
            onlineNow
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
        online.get(
          socket.id
        );

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
          .filter(m =>
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
              !m.deletedFor?.includes(
                norm(me)
              )
          );

      socket.emit(
        "conversationHistory",
        {
          username:
            other,

          messages:
            conv
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
        online.get(
          socket.id
        );

      const to =
        norm(data?.to);

      const text =
        String(
          data?.message || ""
        ).trim();

      if (
        !me ||
        !to ||
        !text ||
        text.length > 5000
      ) {
        return;
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
          crypto
            .randomBytes(5)
            .toString("hex"),

        from:
          norm(me),

        fromDisplay:
          getUser(me)
            ?.displayName ||
          me,

        to,

        toDisplay:
          getUser(to)
            ?.displayName ||
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

      const all =
        messages();

      all.push(msg);

      if (
        all.length > 50000
      ) {
        all.splice(
          0,
          all.length - 50000
        );
      }

      saveMessages(all);

      for (
        const [
          sid,
          name
        ] of online.entries()
      ) {
        if (
          norm(name) ===
          to
        ) {
          io.to(sid).emit(
            "privateMessage",
            msg
          );

          break;
        }
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

  // ===================================================
  // MARCAR LEÍDO
  // ===================================================

  socket.on(
    "markConversationRead",
    otherUsername => {
      const me =
        online.get(
          socket.id
        );

      const other =
        norm(otherUsername);

      if (!me) return;

      const all =
        messages();

      for (const m of all) {
        if (
          norm(m.from) ===
            other &&
          norm(m.to) ===
            norm(me)
        ) {
          m.read = true;
        }
      }

      saveMessages(all);

      emitUnread(
        socket,
        me
      );
    }
  );

  // ===================================================
  // BORRAR MENSAJE
  // ===================================================

  socket.on(
    "deleteMessage",
    id => {
      const me =
        online.get(
          socket.id
        );

      if (!me || !id) {
        return;
      }

      const all =
        messages();

      const idx =
        all.findIndex(
          m =>
            m.id === id
        );

      if (idx < 0) {
        return;
      }

      if (
        norm(all[idx].from) !==
        norm(me)
      ) {
        return socket.emit(
          "messageError",
          "Solo puedes borrar tus propios mensajes."
        );
      }

      all[idx].deletedFor =
        Array.from(
          new Set([
            ...(all[idx]
              .deletedFor || []),
            norm(me)
          ])
        );

      all[idx].message =
        "Mensaje eliminado";

      all[idx].deleted =
        true;

      saveMessages(all);

      const target =
        all[idx].to;

      for (
        const [
          sid,
          name
        ] of online.entries()
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
                all[idx].id,

              message:
                all[idx].message
            }
          );
        }
      }
    }
  );

  // ===================================================
  // BLOQUEAR
  // ===================================================

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
        !target ||
        target === norm(me) ||
        !getUser(target)
      ) {
        return;
      }

      const list =
        users();

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
            ...(
              list[idx]
                .blockedUsers || []
            ),
            target
          ])
        );

      saveUsers(list);

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

  // ===================================================
  // DESBLOQUEAR
  // ===================================================

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
            norm(u.username) ===
            norm(me)
        );

      if (idx < 0) return;

      list[idx].blockedUsers =
        (
          list[idx]
            .blockedUsers || []
        )
          .filter(
            x =>
              norm(x) !==
              target
          );

      saveUsers(list);

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

  // ===================================================
  // LISTA DE BLOQUEADOS
  // ===================================================

  socket.on(
    "getBlockedUsers",
    () => {
      const me =
        online.get(
          socket.id
        );

      if (!me) return;

      socket.emit(
        "blockedUsers",
        getUser(me)
          ?.blockedUsers || []
      );
    }
  );

  // ===================================================
  // LLAMADAS DE VOZ
  // ===================================================

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

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (!targetSocket) {
        return socket.emit(
          "callError",
          "El usuario está desconectado."
        );
      }

      io.to(
        targetSocket[0]
      ).emit(
        "incomingCall",
        {
          from:
            norm(caller),

          fromDisplay:
            getUser(caller)
              ?.displayName ||
            caller
        }
      );

      sendPushToUser(
        target,
        {
          type:
            "call",

          from:
            getUser(caller)
              ?.displayName ||
            caller,

          username:
            norm(caller),

          message:
            "Llamada entrante"
        }
      );
    }
  );

  // ===================================================
  // ACEPTAR LLAMADA
  // ===================================================

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

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (!targetSocket) {
        return socket.emit(
          "callError",
          "El usuario ya no está conectado."
        );
      }

      io.to(
        targetSocket[0]
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

  // ===================================================
  // RECHAZAR LLAMADA
  // ===================================================

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

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (
        targetSocket
      ) {
        io.to(
          targetSocket[0]
        ).emit(
          "callRejected",
          {
            from:
              norm(rejecter)
          }
        );
      }
    }
  );

  // ===================================================
  // WEBRTC OFFER
  // ===================================================

  socket.on(
    "callOffer",
    ({ to, offer }) => {
      const sender =
        online.get(
          socket.id
        );

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !offer
      ) {
        return;
      }

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (
        targetSocket
      ) {
        io.to(
          targetSocket[0]
        ).emit(
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

  // ===================================================
  // WEBRTC ANSWER
  // ===================================================

  socket.on(
    "callAnswer",
    ({ to, answer }) => {
      const sender =
        online.get(
          socket.id
        );

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !answer
      ) {
        return;
      }

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (
        targetSocket
      ) {
        io.to(
          targetSocket[0]
        ).emit(
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

  // ===================================================
  // WEBRTC ICE
  // ===================================================

  socket.on(
    "callIceCandidate",
    ({ to, candidate }) => {
      const sender =
        online.get(
          socket.id
        );

      const target =
        norm(to);

      if (
        !sender ||
        !target ||
        !candidate
      ) {
        return;
      }

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (
        targetSocket
      ) {
        io.to(
          targetSocket[0]
        ).emit(
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

  // ===================================================
  // FINALIZAR LLAMADA
  // ===================================================

  socket.on(
    "callEnd",
    ({ to }) => {
      const sender =
        online.get(
          socket.id
        );

      const target =
        norm(to);

      if (
        !sender ||
        !target
      ) {
        return;
      }

      const targetSocket =
        [
          ...online.entries()
        ].find(
          ([, name]) =>
            norm(name) ===
            target
        );

      if (
        targetSocket
      ) {
        io.to(
          targetSocket[0]
        ).emit(
          "callEnded",
          {
            from:
              norm(sender)
          }
        );
      }
    }
  );

  // ===================================================
  // DESCONECTAR
  // ===================================================

  socket.on(
    "disconnect",
    () => {
      online.delete(
        socket.id
      );

      sendUserList();
    }
  );
});

// =====================================================
// SERVIR INDEX.HTML
// =====================================================

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

// =====================================================
// ARRANCAR SERVIDOR
// =====================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Mi Chat funcionando en http://localhost:${PORT}`
    );
  }
);
