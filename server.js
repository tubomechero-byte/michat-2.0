```js
const online = new Map();

// =====================================================
// MI CHAT ADMIN
// =====================================================

const ADMIN_USERNAME =
  String(process.env.ADMIN_USERNAME || "admin").trim();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "").trim();

const ADMIN_SESSION_SECRET =
  String(
    process.env.ADMIN_SESSION_SECRET ||
    "CAMBIA-ESTA-CLAVE-ADMIN-EN-RENDER"
  );

const ADMIN_SESSION_MAX_AGE =
  7 * 24 * 60 * 60 * 1000;

function createAdminToken() {
  const payload = Buffer.from(
    JSON.stringify({
      username: ADMIN_USERNAME,
      createdAt: Date.now()
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const payload = parts[0];
  const signature = parts[1];

  const expected = crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
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

    if (!data || data.username !== ADMIN_USERNAME) {
      return null;
    }

    if (
      !data.createdAt ||
      Date.now() - Number(data.createdAt) >
        ADMIN_SESSION_MAX_AGE
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function adminToken(req) {
  const authorization =
    req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice(7);
}

function requireAdmin(req, res, next) {
  const admin = verifyAdminToken(
    adminToken(req)
  );

  if (!admin) {
    return res.status(401).json({
      error: "Sesión de administrador no válida."
    });
  }

  req.admin = admin;
  next();
}

// LOGIN ADMIN

app.post("/api/admin/login", (req, res) => {
  const username =
    String(req.body?.username || "").trim();

  const password =
    String(req.body?.password || "");

  if (!ADMIN_PASSWORD) {
    console.error(
      "ADMIN_PASSWORD no está configurada en Render."
    );

    return res.status(500).json({
      error:
        "El administrador no está configurado en el servidor."
    });
  }

  if (
    username !== ADMIN_USERNAME ||
    password !== ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error:
        "Usuario o contraseña de administrador incorrectos."
    });
  }

  const token = createAdminToken();

  // IMPORTANTE:
  // No usamos comillas invertidas para evitar
  // el error de sintaxis que tenía el archivo anterior.
  console.log(
    "Inicio de sesión de administrador: " +
    ADMIN_USERNAME
  );

  res.json({
    success: true,
    token,
    username: ADMIN_USERNAME
  });
});

// COMPROBAR SESIÓN

app.get(
  "/api/admin/me",
  requireAdmin,
  (req, res) => {
    res.json({
      loggedIn: true,
      username: req.admin.username
    });
  }
);

// LOGOUT

app.post(
  "/api/admin/logout",
  requireAdmin,
  (req, res) => {
    res.json({
      success: true
    });
  }
);

// ESTADÍSTICAS

app.get(
  "/api/admin/stats",
  requireAdmin,
  (req, res) => {
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
      online: onlineUsers.size
    });
  }
);

// USUARIOS

app.get(
  "/api/admin/users",
  requireAdmin,
  (req, res) => {
    const onlineUsers = new Set(
      [...online.values()].map(name => norm(name))
    );

    const result = users().map(user => ({
      username: user.username,

      displayName:
        user.displayName || user.username,

      profileImage:
        user.profileImage || "",

      online:
        onlineUsers.has(norm(user.username)),

      createdAt:
        user.createdAt || null,

      contacts:
        Array.isArray(user.contacts)
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
  }
);

// ESTADOS DE UN USUARIO

app.get(
  "/api/admin/users/:username/stories",
  requireAdmin,
  (req, res) => {
    const username =
      norm(req.params.username);

    if (!getUser(username)) {
      return res.status(404).json({
        error: "Usuario no encontrado."
      });
    }

    const list =
      cleanExpiredStories().filter(
        story =>
          norm(story.username) === username
      );

    res.json(list);
  }
);

// TODOS LOS ESTADOS

app.get(
  "/api/admin/stories",
  requireAdmin,
  (req, res) => {
    const list =
      cleanExpiredStories();

    list.sort(
      (a, b) =>
        Number(b.createdAt || 0) -
        Number(a.createdAt || 0)
    );

    res.json(list);
  }
);

// BORRAR CUALQUIER ESTADO

app.delete(
  "/api/admin/stories/:id",
  requireAdmin,
  (req, res) => {
    const id =
      String(req.params.id || "");

    if (!id) {
      return res.status(400).json({
        error: "ID de estado inválido."
      });
    }

    const list =
      cleanExpiredStories();

    const index =
      list.findIndex(
        story =>
          String(story.id) === id
      );

    if (index < 0) {
      return res.status(404).json({
        error: "Estado no encontrado."
      });
    }

    const removed =
      list.splice(index, 1)[0];

    saveStories(list);

    io.emit("storyDeleted", {
      id: removed.id
    });

    io.emit(
      "storiesUpdated",
      list
    );

    console.log(
      "Administrador eliminó el estado " +
      removed.id +
      " de " +
      removed.username
    );

    res.json({
      success: true
    });
  }
);

// MENSAJES RECIENTES

app.get(
  "/api/admin/messages",
  requireAdmin,
  (req, res) => {
    let limit =
      Number(req.query.limit || 100);

    if (!Number.isFinite(limit)) {
      limit = 100;
    }

    limit = Math.max(
      1,
      Math.min(limit, 500)
    );

    res.json(
      messages()
        .slice(-limit)
        .reverse()
    );
  }
);

// PANEL ADMIN

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin",
      "index.html"
    )
  );
});

app.get("/admin/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin",
      "index.html"
    )
  );
});

// =====================================================
// PUSH / FIREBASE
// =====================================================
```
