
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
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
ensure(FILES.users, []);
ensure(FILES.messages, []);
ensure(FILES.sessions, {});
ensure(FILES.push, []);
ensure(FILES.stories, []);
ensure(FILES.fcm, {});

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
const users = () => read(FILES.users, []);
const messages = () => read(FILES.messages, []);
const sessions = () => read(FILES.sessions, {});
const pushSubs = () => read(FILES.push, []);
const stories = () => read(FILES.stories, []);
const fcmTokens = () => read(FILES.fcm, {});

function saveUsers(v){ write(FILES.users, v); }
function saveMessages(v){ write(FILES.messages, v); }
function saveSessions(v){ write(FILES.sessions, v); }
function savePushSubs(v){ write(FILES.push, v); }
function saveStories(v){ write(FILES.stories, v); }
function saveFcmTokens(v){ write(FILES.fcm, v); }

function norm(v) { return String(v || "").trim().toLowerCase(); }
function getUser(username) { const n = norm(username); return users().find(u => norm(u.username) === n); }

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function validPassword(password, salt, hash) {
  try {
    const got = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}
function newSession(username) {
  const data = sessions();
  const token = crypto.randomBytes(32).toString("hex");
  data[token] = { username, createdAt: Date.now() };
  saveSessions(data);
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const s = sessions()[token];
  return s ? getUser(s.username) : null;
}
function deleteSession(token) {
  const data = sessions();
  delete data[token];
  saveSessions(data);
}
function authToken(req) {
  const a = req.headers.authorization || "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}
function onlineUsername(socketId) { return online.get(socketId) || null; }
function socketIdFor(username) {
  const n = norm(username);
  for (const [sid, name] of online.entries()) if (norm(name) === n) return sid;
  return null;
}
function isBlocked(a,b) {
  const u = getUser(a);
  return !!(u && Array.isArray(u.blockedUsers) && u.blockedUsers.some(x => norm(x) === norm(b)));
}
function isEitherBlocked(a,b) { return isBlocked(a,b) || isBlocked(b,a); }
function cleanExpiredStories() {
  const now = Date.now();
  const active = stories().filter(s => Number(s.expiresAt) > now);
  saveStories(active);
  return active;
}

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const online = new Map();

const vapidPublic = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivate = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
}

let firebaseReady = false;
try {
  if (!getApps().length) {
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
    if (!raw) {
      for (const p of ["/etc/secrets/firebase-service-account.json", path.join(__dirname, "firebase-service-account.json")]) {
        if (fs.existsSync(p)) { raw = fs.readFileSync(p, "utf8"); break; }
      }
    }
    if (!raw) throw new Error("No se encontró la credencial de Firebase. Usa FIREBASE_SERVICE_ACCOUNT_JSON o /etc/secrets/firebase-service-account.json.");
    initializeApp({ credential: cert(JSON.parse(raw)) });
    console.log("Firebase Admin listo para FCM.");
  } else {
    console.log("Firebase Admin ya estaba inicializado.");
  }
  firebaseReady = true;
} catch (error) {
  firebaseReady = false;
  console.error("FCM init error:", error.message);
}

async function sendFcmToUser(username, payload) {
  if (!firebaseReady) return;
  const data = fcmTokens();
  const key = norm(username);
  const tokens = Array.isArray(data[key]) ? data[key] : [];
  if (!tokens.length) {
    console.log("No hay tokens FCM registrados para " + key + ".");
    return;
  }
  const title = String(payload && (payload.title || payload.from) || "Mi Chat");
  const body = String(payload && (payload.body || payload.message) || "");
  const message = {
    tokens,
    notification: { title, body },
    data: {
      type: String(payload && payload.type || "message"),
      username: String(payload && payload.username || ""),
      from: String(payload && payload.from || ""),
      body,
      message: body
    },
    android: {
      priority: "high",
      notification: { channelId: "michat_messages", sound: "default" }
    }
  };
  try {
    console.log("Enviando FCM a " + key + ". Tokens: " + tokens.length);
    const result = await getMessaging().sendEachForMulticast(message);
    console.log("FCM enviado a " + key + ": éxito=" + result.successCount + ", errores=" + result.failureCount);
    if (result.failureCount) {
      const invalid = new Set();
      result.responses.forEach((r, i) => {
        const c = r.error && r.error.code;
        if (!r.success && (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token")) invalid.add(tokens[i]);
      });
      if (invalid.size) {
        data[key] = tokens.filter(t => !invalid.has(t));
        saveFcmTokens(data);
        console.log("Se eliminaron " + invalid.size + " tokens inválidos de " + key + ".");
      }
    }
  } catch (error) {
    console.error("FCM send error:", error.message);
  }
}
function sendPushToUser(username, payload) {
  if (vapidPublic && vapidPrivate) {
    for (const item of pushSubs()) {
      if (norm(item.username) !== norm(username)) continue;
      webpush.sendNotification(item.subscription, JSON.stringify(payload)).catch(e => console.error("Error enviando Web Push:", e.message));
    }
  }
  sendFcmToUser(username, payload).catch(e => console.error("Error enviando FCM:", e.message));
}

function sendUserList() {
  io.emit("userList", users().map(u => ({
    username: u.username,
    displayName: u.displayName || u.username,
    profileImage: u.profileImage || "",
    online: [...online.values()].some(x => norm(x) === norm(u.username))
  })));
}
function getContactList(username) {
  const me = getUser(username);
  if (!me) return [];
  const contacts = Array.isArray(me.contacts) ? me.contacts : [];
  return contacts.map(getUser).filter(Boolean).filter(u => !isEitherBlocked(username, u.username)).map(u => ({
    username: u.username,
    displayName: u.displayName || u.username,
    profileImage: u.profileImage || "",
    online: [...online.values()].some(x => norm(x) === norm(u.username))
  }));
}
function unreadCountsFor(username) {
  const counts = {};
  const blocks = (getUser(username) && getUser(username).blockedUsers) || [];
  for (const m of messages()) {
    if (norm(m.to) === norm(username) && !m.read && !blocks.some(b => norm(b) === norm(m.from))) {
      const from = norm(m.from);
      counts[from] = (counts[from] || 0) + 1;
    }
  }
  return counts;
}
function emitUnread(socket, username) { socket.emit("unreadCounts", unreadCountsFor(username)); }

// ===================== AUTH =====================

app.post("/api/register", (req,res) => {
  const displayName = String(req.body && req.body.username || "").trim();
  const password = String(req.body && req.body.password || "");
  if (displayName.length < 3 || displayName.length > 24) return res.status(400).json({error:"El nombre debe tener entre 3 y 24 caracteres."});
  if (!/^[a-zA-Z0-9_]+$/.test(displayName)) return res.status(400).json({error:"Solo letras, números y _."});
  if (password.length < 6) return res.status(400).json({error:"La contraseña debe tener al menos 6 caracteres."});
  const username = norm(displayName);
  const list = users();
  if (list.some(u => norm(u.username) === username)) return res.status(400).json({error:"Ese usuario ya existe."});
  const p = passwordHash(password);
  list.push({username,displayName,salt:p.salt,passwordHash:p.hash,profileImage:"",blockedUsers:[],contacts:[],createdAt:Date.now()});
  saveUsers(list);
  sendUserList();
  res.json({success:true,username:displayName,token:newSession(username)});
});

app.post("/api/login", (req,res) => {
  const username = norm(req.body && req.body.username);
  const password = String(req.body && req.body.password || "");
  const u = getUser(username);
  if (!u || !validPassword(password,u.salt,u.passwordHash)) return res.status(401).json({error:"Usuario o contraseña incorrectos."});
  const list = users();
  const idx = list.findIndex(x => norm(x.username) === norm(u.username));
  if (idx >= 0) {
    if (!Array.isArray(list[idx].contacts)) list[idx].contacts = [];
    if (!Array.isArray(list[idx].blockedUsers)) list[idx].blockedUsers = [];
    saveUsers(list);
  }
  res.json({success:true,username:u.displayName,token:newSession(u.username)});
});

app.get("/api/session",(req,res)=>{
  const u = sessionUser(authToken(req));
  if (!u) return res.status(401).json({loggedIn:false});
  res.json({loggedIn:true,username:u.displayName,profileImage:u.profileImage||""});
});
app.post("/api/logout",(req,res)=>{ deleteSession(authToken(req)); res.json({success:true}); });

app.get("/api/profile",(req,res)=>{
  const u=sessionUser(authToken(req));
  if(!u) return res.status(401).json({error:"No autorizado"});
  res.json({username:u.username,displayName:u.displayName,profileImage:u.profileImage||""});
});
app.post("/api/profile",(req,res)=>{
  const u=sessionUser(authToken(req));
  if(!u) return res.status(401).json({error:"No autorizado"});
  const displayName=String(req.body&&req.body.displayName||u.displayName).trim();
  const profileImage=String(req.body&&req.body.profileImage||"");
  if(displayName.length<3||displayName.length>24) return res.status(400).json({error:"Nombre inválido."});
  if(profileImage.length>800000) return res.status(400).json({error:"La imagen es demasiado grande."});
  const list=users(); const idx=list.findIndex(x=>norm(x.username)===norm(u.username));
  if(idx<0) return res.status(404).json({error:"Usuario no encontrado."});
  list[idx].displayName=displayName; list[idx].profileImage=profileImage; saveUsers(list); sendUserList();
  res.json({success:true,displayName,profileImage});
});

// ===================== CONTACTS =====================

app.get("/api/contacts",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  res.json(getContactList(u.username));
});
app.post("/api/contacts/add",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const target=norm(req.body&&req.body.username);
  if(!target)return res.status(400).json({error:"Escribe un nombre de usuario."});
  if(target===norm(u.username))return res.status(400).json({error:"No puedes añadirte a ti mismo."});
  if(!getUser(target))return res.status(404).json({error:"Ese usuario no existe."});
  if(isEitherBlocked(u.username,target))return res.status(400).json({error:"No puedes añadir a este usuario."});
  const list=users(); const idx=list.findIndex(x=>norm(x.username)===norm(u.username));
  if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  if(!Array.isArray(list[idx].contacts))list[idx].contacts=[];
  if(!list[idx].contacts.some(x=>norm(x)===target))list[idx].contacts.push(target);
  saveUsers(list);
  res.json({success:true,contact:getContactList(u.username).find(x=>norm(x.username)===target)||null});
});
app.post("/api/contacts/remove",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const target=norm(req.body&&req.body.username); const list=users(); const idx=list.findIndex(x=>norm(x.username)===norm(u.username));
  if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target); saveUsers(list); res.json({success:true});
});

// ===================== WEB PUSH =====================

app.post("/api/push/subscribe",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const subscription=req.body&&req.body.subscription;
  if(!subscription||!subscription.endpoint)return res.status(400).json({error:"Suscripción inválida."});
  const list=pushSubs();
  if(!list.some(x=>x.username===u.username&&x.subscription&&x.subscription.endpoint===subscription.endpoint)) list.push({username:u.username,subscription});
  savePushSubs(list);
  res.json({success:true,enabled:!!(vapidPublic&&vapidPrivate)});
});
app.get("/api/push/public-key",(req,res)=>res.json({enabled:!!(vapidPublic&&vapidPrivate),publicKey:vapidPublic}));

// ===================== FCM TOKEN =====================

console.log("RUTA FCM CARGADA");
app.post("/api/fcm/token",(req,res)=>{
  console.log("PETICIÓN FCM RECIBIDA");
  const user=sessionUser(authToken(req));
  if(!user)return res.status(401).json({error:"No autorizado"});
  const token=String(req.body&&req.body.token||"").trim();
  if(!token||token.length<20||token.length>4096)return res.status(400).json({error:"Token FCM inválido."});
  const data=fcmTokens();
  for(const username of Object.keys(data)) data[username]=Array.isArray(data[username])?data[username].filter(x=>x!==token):[];
  const key=norm(user.username);
  if(!Array.isArray(data[key]))data[key]=[];
  if(!data[key].includes(token))data[key].push(token);
  data[key]=data[key].slice(-5);
  saveFcmTokens(data);
  console.log("FCM OK: "+key+" -> "+data[key].length+" dispositivo(s)");
  res.json({success:true,username:key,devices:data[key].length});
});

// ===================== STORIES =====================

app.get("/api/stories",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  res.json(cleanExpiredStories().map(s=>({...s,views:Array.isArray(s.views)?s.views:[]})));
});
app.post("/api/stories",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const type=req.body&&req.body.type==="image"?"image":"text";
  const content=String(req.body&&req.body.content||"").trim();
  if(!content)return res.status(400).json({error:"La historia no puede estar vacía."});
  if(type==="text"&&content.length>500)return res.status(400).json({error:"El texto puede tener como máximo 500 caracteres."});
  if(type==="image"&&content.length>9000000)return res.status(400).json({error:"La imagen es demasiado grande."});
  if(type==="image"&&!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(content))return res.status(400).json({error:"Formato de imagen no válido."});
  const list=cleanExpiredStories();
  if(list.filter(s=>norm(s.username)===norm(u.username)).length>=20)return res.status(400).json({error:"Has alcanzado el límite de 20 historias activas."});
  const now=Date.now();
  const story={id:now+"-"+crypto.randomBytes(5).toString("hex"),username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",type,content,background:type==="text"?String(req.body&&req.body.background||"#075e54"):"",createdAt:now,expiresAt:now+86400000,views:[]};
  list.push(story); saveStories(list); io.emit("storyCreated",story); io.emit("storiesUpdated",list); res.json({success:true,story});
});
app.post("/api/stories/:id/view",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const list=cleanExpiredStories(); const story=list.find(s=>String(s.id)===String(req.params.id));
  if(!story)return res.status(404).json({error:"Historia no encontrada."});
  if(!Array.isArray(story.views))story.views=[];
  if(norm(story.username)===norm(u.username)){saveStories(list);return res.json({success:true,viewed:false,owner:true,views:story.views});}
  let added=false;
  if(!story.views.some(v=>norm(v.username)===norm(u.username))){
    const view={username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",viewedAt:Date.now()};
    story.views.push(view); added=true; saveStories(list);
    const sid=socketIdFor(story.username); if(sid)io.to(sid).emit("storyViewed",{storyId:story.id,view,views:story.views});
  } else saveStories(list);
  res.json({success:true,viewed:true,owner:false,added,views:story.views});
});
app.get("/api/stories/:id/views",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const story=cleanExpiredStories().find(s=>String(s.id)===String(req.params.id));
  if(!story)return res.status(404).json({error:"Historia no encontrada."});
  if(norm(story.username)!==norm(u.username))return res.status(403).json({error:"Solo el dueño puede ver los espectadores."});
  const views=Array.isArray(story.views)?story.views:[]; res.json({success:true,count:views.length,views});
});
app.delete("/api/stories/:id",(req,res)=>{
  const u=sessionUser(authToken(req)); if(!u)return res.status(401).json({error:"No autorizado"});
  const list=cleanExpiredStories(); const idx=list.findIndex(s=>String(s.id)===String(req.params.id));
  if(idx<0)return res.status(404).json({error:"Historia no encontrada."});
  if(norm(list[idx].username)!==norm(u.username))return res.status(403).json({error:"No puedes borrar esta historia."});
  const removed=list.splice(idx,1)[0]; saveStories(list); io.emit("storyDeleted",{id:removed.id}); io.emit("storiesUpdated",list); res.json({success:true});
});

// ===================== SOCKET.IO =====================

io.on("connection", socket => {
  socket.on("authenticate", token => {
    const u=sessionUser(token);
    if(!u)return socket.emit("authenticationError");
    for(const [sid,name] of online.entries()){
      if(sid!==socket.id&&norm(name)===norm(u.username)){
        online.delete(sid);
        const old=io.sockets.sockets.get(sid);
        if(old)old.disconnect(true);
      }
    }
    online.set(socket.id,u.username);
    socket.emit("authenticated",{username:u.displayName,profileImage:u.profileImage||""});
    sendUserList(); emitUnread(socket,u.username); socket.emit("storiesData",cleanExpiredStories()); socket.emit("contactsUpdated",getContactList(u.username));
  });

  socket.on("getContacts",()=>{const me=onlineUsername(socket.id);if(me)socket.emit("contactsUpdated",getContactList(me));});
  socket.on("addContact",username=>{
    const me=onlineUsername(socket.id), target=norm(username); if(!me||!target)return;
    if(target===norm(me))return socket.emit("contactError","No puedes añadirte a ti mismo.");
    if(!getUser(target))return socket.emit("contactError","Ese usuario no existe.");
    if(isEitherBlocked(me,target))return socket.emit("contactError","No puedes añadir a este usuario.");
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    if(!Array.isArray(list[idx].contacts))list[idx].contacts=[];
    if(!list[idx].contacts.some(x=>norm(x)===target))list[idx].contacts.push(target);
    saveUsers(list);
    const contact=getContactList(me).find(x=>norm(x.username)===target)||{username:target};
    socket.emit("contactAdded",contact);socket.emit("contactsUpdated",getContactList(me));
  });
  socket.on("removeContact",username=>{
    const me=onlineUsername(socket.id), target=norm(username);if(!me||!target)return;
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target);saveUsers(list);
    socket.emit("contactRemoved",{username:target});socket.emit("contactsUpdated",getContactList(me));
  });
  socket.on("getStories",()=>{const me=onlineUsername(socket.id);if(me)socket.emit("storiesData",cleanExpiredStories());});
  socket.on("findUser",username=>{
    const me=onlineUsername(socket.id),target=norm(username);if(!me)return;
    if(!target)return socket.emit("userNotFound");
    if(target===norm(me))return socket.emit("userFoundError","No puedes contactar contigo mismo.");
    const u=getUser(target);if(!u)return socket.emit("userNotFound");
    if(isEitherBlocked(me,target))return socket.emit("userFoundError","No puedes contactar con este usuario.");
    socket.emit("userFound",{username:u.username,displayName:u.displayName,profileImage:u.profileImage||"",online:[...online.values()].some(x=>norm(x)===target)});
  });
  socket.on("getConversation",otherUsername=>{
    const me=onlineUsername(socket.id),other=norm(otherUsername);if(!me||!getUser(other))return;
    if(isEitherBlocked(me,other))return socket.emit("conversationBlocked","Esta conversación está bloqueada.");
    const conv=messages().filter(m=>((norm(m.from)===norm(me)&&norm(m.to)===other)||(norm(m.from)===other&&norm(m.to)===norm(me)))).filter(m=>!(m.deletedFor||[]).some(x=>norm(x)===norm(me)));
    socket.emit("conversationHistory",{username:other,messages:conv});
  });
  socket.on("privateMessage",data=>{
    const me=onlineUsername(socket.id),to=norm(data&&data.to),text=String(data&&data.message||"").trim();if(!me||!to||!text||text.length>5000)return;
    if(!getUser(to))return socket.emit("messageError","Ese usuario no existe.");
    if(to===norm(me))return socket.emit("messageError","No puedes enviarte mensajes.");
    if(isEitherBlocked(me,to))return socket.emit("messageError","No puedes contactar con este usuario.");
    const msg={id:Date.now()+"-"+crypto.randomBytes(5).toString("hex"),from:norm(me),fromDisplay:getUser(me)?.displayName||me,to,toDisplay:getUser(to)?.displayName||to,message:text,time:new Date().toISOString(),read:false,deletedFor:[]};
    const list=messages();list.push(msg);if(list.length>50000)list.splice(0,list.length-50000);saveMessages(list);
    const sid=socketIdFor(to);if(sid)io.to(sid).emit("privateMessage",msg);socket.emit("messageSent",msg);
    sendPushToUser(to,{type:"message",from:msg.fromDisplay,message:msg.message,username:msg.from});
  });
  socket.on("markConversationRead",otherUsername=>{
    const me=onlineUsername(socket.id),other=norm(otherUsername);if(!me)return;
    const list=messages();for(const m of list)if(norm(m.from)===other&&norm(m.to)===norm(me))m.read=true;saveMessages(list);emitUnread(socket,me);
  });
  socket.on("deleteMessage",id=>{
    const me=onlineUsername(socket.id);if(!me||!id)return;const list=messages(),idx=list.findIndex(m=>m.id===id);if(idx<0)return;
    if(norm(list[idx].from)!==norm(me))return socket.emit("messageError","Solo puedes borrar tus propios mensajes.");
    list[idx].deletedFor=Array.from(new Set([...(list[idx].deletedFor||[]),norm(me)]));list[idx].message="Mensaje eliminado";list[idx].deleted=true;saveMessages(list);
    const target=list[idx].to;for(const [sid,name] of online.entries())if(norm(name)===norm(target)||norm(name)===norm(me))io.to(sid).emit("messageDeleted",{id:list[idx].id,message:list[idx].message});
  });
  socket.on("blockUser",username=>{
    const me=onlineUsername(socket.id),target=norm(username);if(!me||!target||target===norm(me)||!getUser(target))return;
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].blockedUsers=Array.from(new Set([...(list[idx].blockedUsers||[]),target]));
    list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target);saveUsers(list);
    socket.emit("blockUpdated",{username:target,blocked:true});socket.emit("contactsUpdated",getContactList(me));sendUserList();
  });
  socket.on("unblockUser",username=>{
    const me=onlineUsername(socket.id),target=norm(username);if(!me||!target)return;
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].blockedUsers=(list[idx].blockedUsers||[]).filter(x=>norm(x)!==target);saveUsers(list);socket.emit("blockUpdated",{username:target,blocked:false});sendUserList();
  });
  socket.on("getBlockedUsers",()=>{const me=onlineUsername(socket.id);if(me)socket.emit("blockedUsers",getUser(me)?.blockedUsers||[]);});

  socket.on("callRequest",({to})=>{
    const caller=onlineUsername(socket.id),target=norm(to);if(!caller||!target)return;
    if(target===norm(caller))return socket.emit("callError","No puedes llamarte a ti mismo.");
    if(isEitherBlocked(caller,target))return socket.emit("callError","No puedes contactar con este usuario.");
    if(!getUser(target))return socket.emit("callError","Ese usuario no existe.");
    const callerName=getUser(caller)?.displayName||caller, targetSid=socketIdFor(target);
    if(targetSid)io.to(targetSid).emit("incomingCall",{from:norm(caller),fromDisplay:callerName});
    sendPushToUser(target,{type:"call",title:"Llamada entrante",body:callerName+" te está llamando",from:callerName,username:norm(caller),message:"Llamada entrante"});
    socket.emit("callRinging",{to:target,online:!!targetSid});
  });
  socket.on("callAccept",({to})=>{
    const callee=onlineUsername(socket.id),target=norm(to);if(!callee||!target)return;const sid=socketIdFor(target);
    if(!sid)return socket.emit("callError","El usuario ya no está conectado.");
    io.to(sid).emit("callAccepted",{from:norm(callee),fromDisplay:getUser(callee)?.displayName||callee});
  });
  socket.on("callReject",({to})=>{
    const rejecter=onlineUsername(socket.id),target=norm(to);if(!rejecter||!target)return;const sid=socketIdFor(target);if(sid)io.to(sid).emit("callRejected",{from:norm(rejecter)});
  });
  socket.on("callOffer",({to,offer})=>{const sender=onlineUsername(socket.id),target=norm(to);if(!sender||!target||!offer)return;const sid=socketIdFor(target);if(sid)io.to(sid).emit("callOffer",{from:norm(sender),offer});});
  socket.on("callAnswer",({to,answer})=>{const sender=onlineUsername(socket.id),target=norm(to);if(!sender||!target||!answer)return;const sid=socketIdFor(target);if(sid)io.to(sid).emit("callAnswer",{from:norm(sender),answer});});
  socket.on("callIceCandidate",({to,candidate})=>{const sender=onlineUsername(socket.id),target=norm(to);if(!sender||!target||!candidate)return;const sid=socketIdFor(target);if(sid)io.to(sid).emit("callIceCandidate",{from:norm(sender),candidate});});
  socket.on("callEnd",({to})=>{const sender=onlineUsername(socket.id),target=norm(to);if(!sender||!target)return;const sid=socketIdFor(target);if(sid)io.to(sid).emit("callEnded",{from:norm(sender)});});
  socket.on("disconnect",()=>{online.delete(socket.id);sendUserList();});
});

// ===================== CLEANUP =====================

setInterval(()=>{
  const before=stories().length;
  const after=cleanExpiredStories();
  if(before!==after.length)io.emit("storiesUpdated",after);
},60000);

// ===================== SPA FALLBACK =====================

app.use((req,res,next)=>{
  if(req.path.startsWith("/api/")||req.path.startsWith("/socket.io/"))return next();
  const indexFile=path.join(__dirname,"public","index.html");
  if(!fs.existsSync(indexFile))return res.status(404).send("No se encontró public/index.html");
  res.sendFile(indexFile);
});

server.listen(PORT,"0.0.0.0",()=>{
  console.log("Mi Chat funcionando en http://localhost:" + PORT);
});
