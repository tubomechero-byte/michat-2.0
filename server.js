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

function saveUsers(data) {
  write(USERS_FILE, data);
}

function messages() {
  return read(MESSAGES_FILE, []);
}

function saveMessages(data) {
  write(MESSAGES_FILE, data);
}

function sessions() {
  return read(SESSIONS_FILE, {});
}

function saveSessions(data) {
  write(SESSIONS_FILE, data);
}

function pushSubs() {
  return read(PUSH_FILE, []);
}

function savePushSubs(data) {
  write(PUSH_FILE, data);
}

function allStories() {
  return read(STORIES_FILE, []);
}

function activeStories() {
  const now = Date.now();

  return allStories().filter(
    story => story.expiresAt > now
  );
}

function saveStories(data) {
  write(STORIES_FILE, data);
}

function cleanExpiredStories() {
  const active = activeStories();
  saveStories(active);
  return active;
}

function norm(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getUser(username) {
  const u = norm(username);

  return users().find(
    user => norm(user.username) === u
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
  if (!token) {
    return null;
  }

  const session =
    sessions()[token];

  if (!session) {
    return null;
  }

  return getUser(session.username);
}

function deleteSession(token) {
  const data = sessions();

  delete data[token];

  saveSessions(data);
}

function authToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (
    authorization.startsWith("Bearer ")
  ) {
    return authorization.slice(7);
  }

  return "";
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

// =====================================================
// PUSH
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
  if (
    !vapidPublic ||
    !vapidPrivate
  ) {
    return;
  }

  const subscriptions =
    pushSubs();

  for (
    const item of subscriptions
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
      .catch(() => {});
  }
}

// =====================================================
// REGISTRO
// =====================================================

app.post(
  "/api/register",
  (req, res) => {
    const displayName =
      String(
        req.body.username || ""
      ).trim();

    const password =
      String(
        req.body.password || ""
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

    if (password.length < 6) {
      return res.status(400).json({
        error:
          "La contraseña debe tener al menos 6 caracteres."
      });
    }

    const username =
      norm(displayName);

    const list = users();

    if (
      list.some(
        user =>
          norm(user.username) ===
          username
      )
    ) {
      return res.status(400).json({
        error:
          "Ese usuario ya existe."
      });
    }

    const passwordData =
      passwordHash(password);

    list.push({
      username,
      displayName,
      salt: passwordData.salt,
      passwordHash:
        passwordData.hash,
      profileImage: "",
      blockedUsers: [],
      createdAt: Date.now()
    });

    saveUsers(list);

    const token =
      newSession(username);

    sendUserList();

    res.json({
      success: true,
      username: displayName,
      token
    });
  }
);

// =====================================================
// LOGIN
// =====================================================

app.post(
  "/api/login",
  (req, res) => {
    const username =
      norm(req.body.username);

    const password =
      String(
        req.body.password || ""
      );

    const user =
      getUser(username);

    if (
      !user ||
      !validPassword(
        password,
        user.salt,
        user.passwordHash
      )
    ) {
      return res.status(401).json({
        error:
          "Usuario o contraseña incorrectos."
      });
    }

    const token =
      newSession(user.username);

    res.json({
      success: true,
      username: user.displayName,
      token
    });
  }
);

// =====================================================
// SESIÓN
// =====================================================

app.get(
  "/api/session",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        loggedIn: false
      });
    }

    res.json({
      loggedIn: true,
      username: user.displayName,
      profileImage:
        user.profileImage || ""
    });
  }
);

// =====================================================
// LOGOUT
// =====================================================

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

// =====================================================
// PERFIL
// =====================================================

app.get(
  "/api/profile",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    res.json({
      username: user.username,
      displayName:
        user.displayName,
      profileImage:
        user.profileImage || ""
    });
  }
);

app.post(
  "/api/profile",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const displayName =
      String(
        req.body.displayName ||
        user.displayName
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

    const list = users();

    const index =
      list.findIndex(
        item =>
          norm(item.username) ===
          norm(user.username)
      );

    if (index < 0) {
      return res.status(404).json({
        error:
          "Usuario no encontrado."
      });
    }

    list[index].displayName =
      displayName;

    list[index].profileImage =
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

// =====================================================
// PUSH
// =====================================================

app.post(
  "/api/push/subscribe",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
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

    const list =
      pushSubs();

    const exists =
      list.some(
        item =>
          item.username ===
            user.username &&
          item.subscription
            .endpoint ===
            subscription.endpoint
      );

    if (!exists) {
      list.push({
        username:
          user.username,
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
  }
);

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      enabled:
        !!(
          vapidPublic &&
          vapidPrivate
        ),
      publicKey:
        vapidPublic
    });
  }
);

// =====================================================
// HISTORIAS
// =====================================================

app.get(
  "/api/stories",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const active =
      cleanExpiredStories();

    res.json(active);
  }
);

// =====================================================
// PUBLICAR HISTORIA
// =====================================================

app.post(
  "/api/stories",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
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

    const now =
      Date.now();

    const list =
      cleanExpiredStories();

    // Limitar cantidad de historias del usuario
    const userStories =
      list.filter(
        story =>
          norm(story.username) ===
          norm(user.username)
      );

    if (
      userStories.length >= 20
    ) {
      return res.status(400).json({
        error:
          "Has alcanzado el límite de 20 historias activas."
      });
    }

    const story = {
      id:
        now +
        "-" +
        crypto
          .randomBytes(5)
          .toString("hex"),

      username:
        user.username,

      displayName:
        user.displayName ||
        user.username,

      profileImage:
        user.profileImage ||
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

    list.push(story);

    saveStories(list);

    // Actualizar las historias a todos los usuarios conectados
    io.emit(
      "storyCreated",
      story
    );

    res.json({
      success: true,
      story
    });
  }
);

// =====================================================
// BORRAR HISTORIA
// =====================================================

app.delete(
  "/api/stories/:id",
  (req, res) => {
    const user =
      sessionUser(
        authToken(req)
      );

    if (!user) {
      return res.status(401).json({
        error:
          "No autorizado"
      });
    }

    const list =
      cleanExpiredStories();

    const index =
      list.findIndex(
        story =>
          story.id ===
          req.params.id
      );

    if (index < 0) {
      return res.status(404).json({
        error:
          "Historia no encontrada."
      });
    }

    if (
      norm(
        list[index].username
      ) !==
      norm(user.username)
    ) {
      return res.status(403).json({
        error:
          "No puedes borrar esta historia."
      });
    }

    const removed =
      list.splice(index, 1)[0];

    saveStories(list);

    io.emit(
      "storyDeleted",
      {
        id:
          removed.id
      }
    );

    res.json({
      success: true
    });
  }
);

// =====================================================
// LISTA DE USUARIOS
// =====================================================

function sendUserList() {
  const list =
    users().map(user => ({
      username:
        user.username,

      displayName:
        user.displayName ||
        user.username,

      profileImage:
        user.profileImage ||
        "",

      online:
        [...online.values()]
          .some(
            name =>
              norm(name) ===
              norm(user.username)
          )
    }));

  io.emit(
    "userList",
    list
  );
}

// =====================================================
// MENSAJES NO LEÍDOS
// =====================================================

function unreadCountsFor(username) {
  const counts = {};

  const blocks =
    getUser(username)
      ?.blockedUsers || [];

  for (
    const message of messages()
  ) {
    if (
      norm(message.to) ===
        norm(username) &&
      !message.read &&
      !blocks.includes(
        norm(message.from)
      )
    ) {
      const from =
        norm(message.from);

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

// =====================================================
// BLOQUEOS
// =====================================================

function isBlocked(a, b) {
  const user =
    getUser(a);

  return !!(
    user &&
    (user.blockedUsers || [])
      .includes(
        norm(b)
      )
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

io.on(
  "connection",
  socket => {

    // =================================================
    // AUTENTICAR
    // =================================================

    socket.on(
      "authenticate",
      token => {
        const user =
          sessionUser(token);

        if (!user) {
          return socket.emit(
            "authenticationError"
          );
        }

        for (
          const [
            socketId,
            username
          ] of online.entries()
        ) {
          if (
            socketId !== socket.id &&
            norm(username) ===
              norm(user.username)
          ) {
            online.delete(
              socketId
            );

            const oldSocket =
              io.sockets.sockets.get(
                socketId
              );

            if (oldSocket) {
              oldSocket.disconnect(
                true
              );
            }
          }
        }

        online.set(
          socket.id,
          user.username
        );

        socket.emit(
          "authenticated",
          {
            username:
              user.displayName,

            profileImage:
              user.profileImage ||
              ""
          }
        );

        sendUserList();

        emitUnread(
          socket,
          user.username
        );

        // Entregar historias actuales
        socket.emit(
          "storiesUpdated",
          cleanExpiredStories()
        );
      }
    );

    // =================================================
    // BUSCAR USUARIO
    // =================================================

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

        const user =
          getUser(target);

        if (!user) {
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
          [...online.values()]
            .some(
              name =>
                norm(name) ===
                target
            );

        socket.emit(
          "userFound",
          {
            username:
              user.username,

            displayName:
              user.displayName,

            profileImage:
              user.profileImage ||
              "",

            online:
              onlineNow
          }
        );
      }
    );

    // =================================================
    // CONVERSACIÓN
    // =================================================

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

        const conversation =
          messages()
            .filter(
              message =>
                (
                  norm(
                    message.from
                  ) ===
                    norm(me) &&
                  norm(
                    message.to
                  ) ===
                    other
                ) ||
                (
                  norm(
                    message.from
                  ) ===
                    other &&
                  norm(
                    message.to
                  ) ===
                    norm(me)
                )
            )
            .filter(
              message =>
                !message.deletedFor?.includes(
                  norm(me)
                )
            );

        socket.emit(
          "conversationHistory",
          {
            username:
              other,

            messages:
              conversation
          }
        );
      }
    );

    // =================================================
    // MENSAJE PRIVADO
    // =================================================

    socket.on(
      "privateMessage",
      data => {
        const me =
          online.get(
            socket.id
          );

        const to =
          norm(
            data?.to
          );

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

        const message = {
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
            new Date()
              .toISOString(),

          read:
            false,

          deletedFor:
            []
        };

        const list =
          messages();

        list.push(message);

        if (
          list.length > 50000
        ) {
          list.splice(
            0,
            list.length - 50000
          );
        }

        saveMessages(list);

        for (
          const [
            socketId,
            username
          ] of online.entries()
        ) {
          if (
            norm(username) ===
            to
          ) {
            io.to(
              socketId
            ).emit(
              "privateMessage",
              message
            );

            break;
          }
        }

        socket.emit(
          "messageSent",
          message
        );

        sendPushToUser(
          to,
          {
            type:
              "message",

            from:
              message.fromDisplay,

            message:
              message.message,

            username:
              message.from
          }
        );
      }
    );

    // =================================================
    // MARCAR CONVERSACIÓN LEÍDA
    // =================================================

    socket.on(
      "markConversationRead",
      otherUsername => {
        const me =
          online.get(
            socket.id
          );

        const other =
          norm(otherUsername);

        if (!me) {
          return;
        }

        const list =
          messages();

        for (
          const message of list
        ) {
          if (
            norm(
              message.from
            ) === other &&
            norm(
              message.to
            ) === norm(me)
          ) {
            message.read = true;
          }
        }

        saveMessages(list);

        emitUnread(
          socket,
          me
        );
      }
    );

    // =================================================
    // BORRAR MENSAJE
    // =================================================

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

        const list =
          messages();

        const index =
          list.findIndex(
            message =>
              message.id ===
              id
          );

        if (index < 0) {
          return;
        }

        if (
          norm(
            list[index].from
          ) !==
          norm(me)
        ) {
          return socket.emit(
            "messageError",
            "Solo puedes borrar tus propios mensajes."
          );
        }

        list[index]
          .deletedFor =
          Array.from(
            new Set([
              ...(
                list[index]
                  .deletedFor ||
                []
              ),
              norm(me)
            ])
          );

        list[index].message =
          "Mensaje eliminado";

        list[index].deleted =
          true;

        saveMessages(list);

        const target =
          list[index].to;

        for (
          const [
            socketId,
            username
          ] of online.entries()
        ) {
          if (
            norm(username) ===
              target ||
            norm(username) ===
              norm(me)
          ) {
            io.to(
              socketId
            ).emit(
              "messageDeleted",
              {
                id:
                  list[index]
                    .id,

                message:
                  list[index]
                    .message
              }
            );
          }
        }
      }
    );

    // =================================================
    // BLOQUEAR
    // =================================================

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
          target ===
            norm(me) ||
          !getUser(target)
        ) {
          return;
        }

        const list =
          users();

        const index =
          list.findIndex(
            user =>
              norm(
                user.username
              ) ===
              norm(me)
          );

        if (index < 0) {
          return;
        }

        list[index]
          .blockedUsers =
          Array.from(
            new Set([
              ...(
                list[index]
                  .blockedUsers ||
                []
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

    // =================================================
    // DESBLOQUEAR
    // =================================================

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

        const index =
          list.findIndex(
            user =>
              norm(
                user.username
              ) ===
              norm(me)
          );

        if (index < 0) {
          return;
        }

        list[index]
          .blockedUsers =
          (
            list[index]
              .blockedUsers ||
            []
          ).filter(
            item =>
              norm(item) !==
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

    // =================================================
    // LISTA DE BLOQUEADOS
    // =================================================

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

    // =================================================
    // LLAMADA
    // =================================================

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

        if (
          !getUser(target)
        ) {
          return socket.emit(
            "callError",
            "Ese usuario no existe."
          );
        }

        const targetSocket =
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
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

    // =================================================
    // ACEPTAR
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
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

    // =================================================
    // RECHAZAR
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
                target
            );

        if (targetSocket) {
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

    // =================================================
    // WEBRTC OFFER
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
                target
            );

        if (targetSocket) {
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

    // =================================================
    // WEBRTC ANSWER
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
                target
            );

        if (targetSocket) {
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

    // =================================================
    // ICE
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
                target
            );

        if (targetSocket) {
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

    // =================================================
    // FINALIZAR LLAMADA
    // =================================================

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
          [...online.entries()]
            .find(
              ([, username]) =>
                norm(username) ===
                target
            );

        if (targetSocket) {
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

    // =================================================
    // DESCONEXIÓN
    // =================================================

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

// =====================================================
// LIMPIEZA AUTOMÁTICA DE HISTORIAS
// =====================================================

setInterval(
  () => {
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
  },
  60 * 1000
);

// =====================================================
// INDEX.HTML
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
// SERVIDOR
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
