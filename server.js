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

const SUPABASE_URL = String(process.env.SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/i, "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

const STATE_FILES = {
  "users.json": [], "messages.json": [], "sessions.json": {},
  "push.json": [], "stories.json": [], "fcm.json": {}
};

let supabaseAvailable = false;
let supabaseReadyResolve;
const supabaseReady = new Promise(resolve => { supabaseReadyResolve = resolve; });
let supabaseWriteQueue = Promise.resolve();

function ensure(file, value) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
ensure(USERS_FILE, []);
ensure(MESSAGES_FILE, []);
ensure(SESSIONS_FILE, {});
ensure(PUSH_FILE, []);
ensure(STORIES_FILE, []);
ensure(FCM_FILE, {});

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function stateKey(file) { return path.basename(file); }

async function supabaseRequest(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY)
    throw new Error("SUPABASE_URL/SUPABASE_SECRET_KEY no configuradas.");
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + pathname, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: "Bearer " + SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!response.ok) {
    const message = typeof data === "string" ? data : data?.message || data?.hint || JSON.stringify(data);
    throw new Error(`Supabase HTTP ${response.status}: ${message}`);
  }
  return data;
}

function queueSupabasePersist(file, data) {
  const key = stateKey(file);
  supabaseWriteQueue = supabaseWriteQueue.then(async () => {
    const ready = await supabaseReady;
    if (!ready) return;
    await supabaseRequest("michat_state?on_conflict=state_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ state_key:key, state_data:data, updated_at:new Date().toISOString() }])
    });
  }).catch(error => console.error(`Error guardando ${key} en Supabase:`, error.message));
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  queueSupabasePersist(file, data);
}

async function initializeDatabase() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.log("SUPABASE_URL/SUPABASE_SECRET_KEY no configuradas. Se usará almacenamiento local temporal.");
    supabaseReadyResolve(false);
    return;
  }
  try {
    const rows = await supabaseRequest("michat_state?select=state_key,state_data,updated_at");
    const byKey = new Map((Array.isArray(rows) ? rows : []).map(row => [row.state_key, row]));
    for (const [key, fallback] of Object.entries(STATE_FILES)) {
      const file = path.join(DATA_DIR, key);
      const local = read(file, fallback);
      const remote = byKey.get(key);
      if (remote) {
        fs.writeFileSync(file, JSON.stringify(remote.state_data, null, 2), "utf8");
        console.log(`Supabase -> ${key}`);
      } else {
        await supabaseRequest("michat_state?on_conflict=state_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ state_key:key, state_data:local, updated_at:new Date().toISOString() }])
        });
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

function users(){return read(USERS_FILE,[])}
function saveUsers(v){write(USERS_FILE,v)}
function messages(){return read(MESSAGES_FILE,[])}
function saveMessages(v){write(MESSAGES_FILE,v)}
function sessions(){return read(SESSIONS_FILE,{})}
function saveSessions(v){write(SESSIONS_FILE,v)}
function pushSubs(){return read(PUSH_FILE,[])}
function savePushSubs(v){write(PUSH_FILE,v)}
function allStories(){return read(STORIES_FILE,[])}
function saveStories(v){write(STORIES_FILE,v)}
function fcmTokens(){return read(FCM_FILE,{})}
function saveFcmTokens(v){write(FCM_FILE,v)}
function cleanExpiredStories(){const active=allStories().filter(s=>Number(s.expiresAt)>Date.now());saveStories(active);return active}
function norm(v){return String(v||"").trim().toLowerCase()}
function getUser(username){const u=norm(username);return users().find(x=>norm(x.username)===u)}
function passwordHash(password){const salt=crypto.randomBytes(16).toString("hex");const hash=crypto.scryptSync(password,salt,64).toString("hex");return {salt,hash}}
function validPassword(password,salt,hash){try{const got=crypto.scryptSync(password,salt,64).toString("hex");return crypto.timingSafeEqual(Buffer.from(got,"hex"),Buffer.from(hash,"hex"))}catch{return false}}

const SESSION_SECRET=process.env.SESSION_SECRET||"michat-session-secret-change-this";
function createSessionToken(username){
  const payload=Buffer.from(JSON.stringify({username:norm(username),createdAt:Date.now()})).toString("base64url");
  const signature=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+signature;
}
function verifySessionToken(token){
  if(!token||typeof token!=="string")return null;
  const parts=token.split(".");if(parts.length!==2)return null;
  const [payload,signature]=parts;
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  const a=Buffer.from(signature),b=Buffer.from(expected);
  if(a.length!==b.length)return null;
  try{if(!crypto.timingSafeEqual(a,b))return null;const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));return data&&data.username?data:null}catch{return null}
}
function newSession(username){return createSessionToken(username)}
function sessionUser(token){
  if(!token)return null;
  const signed=verifySessionToken(token);
  if(signed)return getUser(signed.username);
  const legacy=sessions()[token];
  return legacy?getUser(legacy.username):null;
}
function deleteSession(token){
  if(!token)return;
  const data=sessions();
  if(Object.prototype.hasOwnProperty.call(data,token)){delete data[token];saveSessions(data)}
}
function authToken(req){const a=req.headers.authorization||"";return a.startsWith("Bearer ")?a.slice(7):""}

app.use(express.json({limit:"12mb"}));
app.use(express.static(path.join(__dirname,"public")));
const online=new Map();

const vapidPublic=process.env.VAPID_PUBLIC_KEY||"";
const vapidPrivate=process.env.VAPID_PRIVATE_KEY||"";
const vapidSubject=process.env.VAPID_SUBJECT||"mailto:admin@example.com";
if(vapidPublic&&vapidPrivate)webpush.setVapidDetails(vapidSubject,vapidPublic,vapidPrivate);

let firebaseReady=false;
try{
  if(!getApps().length){
    let raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON||"";
    if(!raw){
      for(const p of ["/etc/secrets/firebase-service-account.json",path.join(__dirname,"firebase-service-account.json")]){
        if(fs.existsSync(p)){raw=fs.readFileSync(p,"utf8");break}
      }
    }
    if(raw){initializeApp({credential:cert(JSON.parse(raw))});firebaseReady=true;console.log("Firebase Admin listo para FCM.")}
    else console.log("Firebase no configurado: FCM desactivado.");
  }else firebaseReady=true;
}catch(error){console.error("FCM init error:",error.message)}

async function sendFcmToUser(username,payload){
  if(!firebaseReady)return;
  const data=fcmTokens(),key=norm(username);
  const tokens=Array.isArray(data[key])?data[key].filter(Boolean):[];
  if(!tokens.length)return;
  const type=String(payload?.type||"message"),body=String(payload?.body||payload?.message||"");
  const message={
    tokens,
    data:{type,username:String(payload?.username||""),sender:String(payload?.sender||payload?.from||""),body,message:body},
    android:{priority:"high"}
  };
  if(type!=="call"){message.notification={title:String(payload?.title||payload?.from||"Mi Chat"),body};message.android.notification={channelId:"michat_messages",sound:"default"}}
  try{
    const result=await getMessaging().sendEachForMulticast(message);
    const invalid=new Set();
    result.responses.forEach((r,i)=>{
      const code=r.error?.code;
      if(code==="messaging/registration-token-not-registered"||code==="messaging/invalid-registration-token")invalid.add(tokens[i]);
    });
    if(invalid.size){data[key]=tokens.filter(t=>!invalid.has(t));saveFcmTokens(data)}
  }catch(error){console.error("FCM send error:",error.message)}
}
function sendPushToUser(username,payload){
  if(vapidPublic&&vapidPrivate)for(const item of pushSubs())if(norm(item.username)===norm(username))webpush.sendNotification(item.subscription,JSON.stringify(payload)).catch(()=>{});
  sendFcmToUser(username,payload).catch(()=>{});
}
function socketIdFor(username){for(const [sid,name] of online.entries())if(norm(name)===norm(username))return sid;return null}
function isBlocked(a,b){const u=getUser(a);return !!(u&&(u.blockedUsers||[]).includes(norm(b)))}
function isEitherBlocked(a,b){return isBlocked(a,b)||isBlocked(b,a)}

function sendUserList(){
  io.emit("userList",users().map(u=>({username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",online:[...online.values()].some(x=>norm(x)===norm(u.username))})));
}
function getContactList(username){
  const me=getUser(username);if(!me)return [];
  return (me.contacts||[]).map(getUser).filter(Boolean).filter(u=>!isEitherBlocked(username,u.username)).map(u=>({username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",online:!!socketIdFor(u.username)}));
}

/* =========================
   ADMIN
   =========================
   Variables Render:
   ADMIN_USERNAME
   ADMIN_PASSWORD

   Opcional:
   ADMIN_TOKEN_SECRET
*/
const ADMIN_USERNAME=norm(process.env.ADMIN_USERNAME||"admin");
const ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||"");
const ADMIN_TOKEN_SECRET=String(process.env.ADMIN_TOKEN_SECRET||SESSION_SECRET);

function createAdminToken(){
  const payload=Buffer.from(JSON.stringify({admin:true,createdAt:Date.now()})).toString("base64url");
  const signature=crypto.createHmac("sha256",ADMIN_TOKEN_SECRET).update(payload).digest("base64url");
  return "admin."+payload+"."+signature;
}
function verifyAdminToken(token){
  if(!token||typeof token!=="string")return false;
  const p=token.split(".");
  if(p.length!==3||p[0]!=="admin")return false;
  const expected=crypto.createHmac("sha256",ADMIN_TOKEN_SECRET).update(p[1]).digest("base64url");
  if(p[2].length!==expected.length)return false;
  try{
    if(!crypto.timingSafeEqual(Buffer.from(p[2]),Buffer.from(expected)))return false;
    const data=JSON.parse(Buffer.from(p[1],"base64url").toString("utf8"));
    return data?.admin===true;
  }catch{return false}
}
function adminAuth(req){
  const token=authToken(req);
  return verifyAdminToken(token);
}

/* CORRECCIÓN: este endpoint debe existir ANTES de cualquier uso desde el frontend. */
app.post("/api/admin/login",(req,res)=>{
  const username=norm(req.body?.username);
  const password=String(req.body?.password||"");

  if(!ADMIN_PASSWORD){
    return res.status(503).json({
      error:"Administrador no configurado. Define ADMIN_USERNAME y ADMIN_PASSWORD en Render."
    });
  }

  if(username!==ADMIN_USERNAME||password!==ADMIN_PASSWORD){
    return res.status(401).json({error:"Usuario o contraseña de administrador incorrectos."});
  }

  res.json({success:true,username:ADMIN_USERNAME,token:createAdminToken()});
});

app.get("/api/admin/session",(req,res)=>{
  if(!adminAuth(req))return res.status(401).json({loggedIn:false});
  res.json({loggedIn:true,username:ADMIN_USERNAME});
});

app.post("/api/admin/logout",(req,res)=>res.json({success:true}));

/* Panel administrativo básico para comprobar que el login funciona. */
app.get("/api/admin/users",(req,res)=>{
  if(!adminAuth(req))return res.status(401).json({error:"No autorizado"});
  res.json(users().map(u=>({
    username:u.username,
    displayName:u.displayName||u.username,
    profileImage:u.profileImage||"",
    contacts:u.contacts||[],
    blockedUsers:u.blockedUsers||[],
    createdAt:u.createdAt||null
  })));
});

app.delete("/api/admin/users/:username",(req,res)=>{
  if(!adminAuth(req))return res.status(401).json({error:"No autorizado"});
  const target=norm(req.params.username);
  if(target===ADMIN_USERNAME)return res.status(400).json({error:"No puedes borrar la cuenta de administrador desde aquí."});
  const list=users(),idx=list.findIndex(u=>norm(u.username)===target);
  if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  list.splice(idx,1);saveUsers(list);
  const msgs=messages().filter(m=>norm(m.from)!==target&&norm(m.to)!==target);saveMessages(msgs);
  const fcm=fcmTokens();delete fcm[target];saveFcmTokens(fcm);
  const push=pushSubs().filter(x=>norm(x.username)!==target);savePushSubs(push);
  sendUserList();
  res.json({success:true});
});

app.post("/api/register",(req,res)=>{
  const displayName=String(req.body.username||"").trim(),password=String(req.body.password||"");
  if(displayName.length<3||displayName.length>24)return res.status(400).json({error:"El nombre debe tener entre 3 y 24 caracteres."});
  if(!/^[a-zA-Z0-9_]+$/.test(displayName))return res.status(400).json({error:"Solo letras, números y _."});
  if(password.length<6)return res.status(400).json({error:"La contraseña debe tener al menos 6 caracteres."});
  const username=norm(displayName),list=users();
  if(list.some(u=>norm(u.username)===username))return res.status(400).json({error:"Ese usuario ya existe."});
  const p=passwordHash(password);
  list.push({username,displayName,salt:p.salt,passwordHash:p.hash,profileImage:"",blockedUsers:[],contacts:[],createdAt:Date.now()});
  saveUsers(list);sendUserList();
  res.json({success:true,username:displayName,token:newSession(username)});
});

app.post("/api/login",(req,res)=>{
  const username=norm(req.body.username),password=String(req.body.password||""),u=getUser(username);
  if(!u||!validPassword(password,u.salt,u.passwordHash))return res.status(401).json({error:"Usuario o contraseña incorrectos."});
  const list=users(),idx=list.findIndex(x=>norm(x.username)===norm(u.username));
  if(idx>=0){if(!Array.isArray(list[idx].contacts))list[idx].contacts=[];if(!Array.isArray(list[idx].blockedUsers))list[idx].blockedUsers=[];saveUsers(list)}
  res.json({success:true,username:u.displayName,token:newSession(u.username)});
});

app.get("/api/session",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({loggedIn:false});
  res.json({loggedIn:true,username:u.username,displayName:u.displayName,profileImage:u.profileImage||""});
});
app.post("/api/logout",(req,res)=>{deleteSession(authToken(req));res.json({success:true})});

app.get("/api/profile",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  res.json({username:u.username,displayName:u.displayName,profileImage:u.profileImage||""});
});
app.post("/api/profile",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const displayName=String(req.body.displayName||u.displayName).trim(),profileImage=String(req.body.profileImage||"");
  if(displayName.length<3||displayName.length>24)return res.status(400).json({error:"Nombre inválido."});
  if(profileImage.length>800000)return res.status(400).json({error:"La imagen es demasiado grande."});
  const list=users(),idx=list.findIndex(x=>norm(x.username)===norm(u.username));if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  list[idx].displayName=displayName;list[idx].profileImage=profileImage;saveUsers(list);sendUserList();
  res.json({success:true,displayName,profileImage});
});

app.get("/api/contacts",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  res.json(getContactList(u.username));
});
app.post("/api/contacts/add",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const target=norm(req.body.username),targetUser=getUser(target);
  if(!target)return res.status(400).json({error:"Escribe un nombre de usuario."});
  if(target===norm(u.username))return res.status(400).json({error:"No puedes añadirte a ti mismo."});
  if(!targetUser)return res.status(404).json({error:"Ese usuario no existe."});
  if(isEitherBlocked(u.username,target))return res.status(400).json({error:"No puedes añadir a este usuario."});
  const list=users(),idx=list.findIndex(x=>norm(x.username)===norm(u.username));if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  if(!Array.isArray(list[idx].contacts))list[idx].contacts=[];
  if(!list[idx].contacts.some(x=>norm(x)===target))list[idx].contacts.push(target);saveUsers(list);
  res.json({success:true,contact:getContactList(u.username).find(x=>norm(x.username)===target)||null});
});
app.post("/api/contacts/remove",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const target=norm(req.body.username),list=users(),idx=list.findIndex(x=>norm(x.username)===norm(u.username));
  if(idx<0)return res.status(404).json({error:"Usuario no encontrado."});
  list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target);saveUsers(list);res.json({success:true});
});

app.post("/api/push/subscribe",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const subscription=req.body.subscription;if(!subscription?.endpoint)return res.status(400).json({error:"Suscripción inválida."});
  const list=pushSubs(),exists=list.some(x=>x.username===u.username&&x.subscription.endpoint===subscription.endpoint);
  if(!exists)list.push({username:u.username,subscription});savePushSubs(list);
  res.json({success:true,enabled:!!(vapidPublic&&vapidPrivate)});
});
app.get("/api/push/public-key",(req,res)=>res.json({enabled:!!(vapidPublic&&vapidPrivate),publicKey:vapidPublic}));

app.post("/api/fcm/token",(req,res)=>{
  const user=sessionUser(authToken(req));if(!user)return res.status(401).json({error:"No autorizado"});
  const token=String(req.body.token||"").trim();if(!token||token.length<20||token.length>4096)return res.status(400).json({error:"Token FCM inválido."});
  const data=fcmTokens();for(const username of Object.keys(data))data[username]=(Array.isArray(data[username])?data[username]:[]).filter(existing=>existing!==token);
  const key=norm(user.username);if(!Array.isArray(data[key]))data[key]=[];if(!data[key].includes(token))data[key].push(token);data[key]=data[key].slice(-5);saveFcmTokens(data);
  res.json({success:true});
});

app.get("/api/stories",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  res.json(cleanExpiredStories());
});
app.post("/api/stories",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const type=req.body.type==="image"?"image":"text",content=String(req.body.content||"").trim();
  if(!content)return res.status(400).json({error:"La historia no puede estar vacía."});
  if(type==="text"&&content.length>500)return res.status(400).json({error:"El texto puede tener como máximo 500 caracteres."});
  if(type==="image"&&content.length>9000000)return res.status(400).json({error:"La imagen es demasiado grande."});
  if(type==="image"&&!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(content))return res.status(400).json({error:"Formato de imagen no válido."});
  const list=cleanExpiredStories(),ownCount=list.filter(s=>norm(s.username)===norm(u.username)).length;
  if(ownCount>=20)return res.status(400).json({error:"Has alcanzado el límite de 20 historias activas."});
  const now=Date.now(),story={id:now+"-"+crypto.randomBytes(5).toString("hex"),username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",type,content,background:type==="text"?String(req.body.background||"#075e54"):"",createdAt:now,expiresAt:now+86400000,views:[]};
  list.push(story);saveStories(list);io.emit("storyCreated",story);io.emit("storiesUpdated",list);res.json({success:true,story});
});
app.post("/api/stories/:id/view",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const list=cleanExpiredStories(),idx=list.findIndex(s=>String(s.id)===String(req.params.id));if(idx<0)return res.status(404).json({error:"Historia no encontrada."});
  const story=list[idx];if(!Array.isArray(story.views))story.views=[];
  if(norm(story.username)===norm(u.username)){saveStories(list);return res.json({success:true,viewed:false,owner:true,views:story.views})}
  let added=false;
  if(!story.views.some(v=>norm(v.username)===norm(u.username))){const view={username:u.username,displayName:u.displayName||u.username,profileImage:u.profileImage||"",viewedAt:Date.now()};story.views.push(view);added=true;saveStories(list);const ownerSid=socketIdFor(story.username);if(ownerSid)io.to(ownerSid).emit("storyViewed",{storyId:story.id,view,views:story.views})}else saveStories(list);
  res.json({success:true,viewed:true,owner:false,added,views:story.views});
});
app.get("/api/stories/:id/views",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const story=cleanExpiredStories().find(s=>String(s.id)===String(req.params.id));if(!story)return res.status(404).json({error:"Historia no encontrada."});
  if(norm(story.username)!==norm(u.username))return res.status(403).json({error:"Solo el dueño puede ver los espectadores."});
  const views=Array.isArray(story.views)?story.views:[];res.json({success:true,count:views.length,views});
});
app.delete("/api/stories/:id",(req,res)=>{
  const u=sessionUser(authToken(req));if(!u)return res.status(401).json({error:"No autorizado"});
  const list=cleanExpiredStories(),idx=list.findIndex(s=>String(s.id)===String(req.params.id));if(idx<0)return res.status(404).json({error:"Historia no encontrada."});
  if(norm(list[idx].username)!==norm(u.username))return res.status(403).json({error:"No puedes borrar esta historia."});
  const removed=list.splice(idx,1)[0];saveStories(list);io.emit("storyDeleted",{id:removed.id});io.emit("storiesUpdated",list);res.json({success:true});
});

function unreadCountsFor(username){
  const counts={},blocks=getUser(username)?.blockedUsers||[];
  for(const m of messages())if(norm(m.to)===norm(username)&&!m.read&&!blocks.includes(norm(m.from))){const from=norm(m.from);counts[from]=(counts[from]||0)+1}
  return counts;
}
function emitUnread(socket,username){socket.emit("unreadCounts",unreadCountsFor(username))}

io.on("connection",socket=>{
  socket.on("authenticate",token=>{
    const u=sessionUser(token);if(!u)return socket.emit("authenticationError");
    for(const [sid,name] of online.entries())if(sid!==socket.id&&norm(name)===norm(u.username)){online.delete(sid);io.sockets.sockets.get(sid)?.disconnect(true)}
    online.set(socket.id,u.username);
    socket.emit("authenticated",{username:u.username,displayName:u.displayName,profileImage:u.profileImage||""});
    sendUserList();emitUnread(socket,u.username);socket.emit("storiesData",cleanExpiredStories());socket.emit("contactsUpdated",getContactList(u.username));
  });
  socket.on("getContacts",()=>{const me=online.get(socket.id);if(me)socket.emit("contactsUpdated",getContactList(me))});
  socket.on("addContact",username=>{
    const me=online.get(socket.id),target=norm(username);if(!me||!target)return;
    if(target===norm(me))return socket.emit("contactError","No puedes añadirte a ti mismo.");
    if(!getUser(target))return socket.emit("contactError","Ese usuario no existe.");
    if(isEitherBlocked(me,target))return socket.emit("contactError","No puedes añadir a este usuario.");
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    if(!Array.isArray(list[idx].contacts))list[idx].contacts=[];if(!list[idx].contacts.some(x=>norm(x)===target))list[idx].contacts.push(target);saveUsers(list);
    socket.emit("contactAdded",getContactList(me).find(x=>norm(x.username)===target)||{username:target});socket.emit("contactsUpdated",getContactList(me));
  });
  socket.on("removeContact",username=>{
    const me=online.get(socket.id),target=norm(username);if(!me||!target)return;
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target);saveUsers(list);socket.emit("contactRemoved",{username:target});socket.emit("contactsUpdated",getContactList(me));
  });
  socket.on("getStories",()=>{const me=online.get(socket.id);if(me)socket.emit("storiesData",cleanExpiredStories())});
  socket.on("findUser",username=>{
    const me=online.get(socket.id),target=norm(username),u=getUser(target);if(!me)return;
    if(!target)return socket.emit("userNotFound");
    if(target===norm(me))return socket.emit("userFoundError","No puedes contactar contigo mismo.");
    if(!u)return socket.emit("userNotFound");
    if(isEitherBlocked(me,target))return socket.emit("userFoundError","No puedes contactar con este usuario.");
    socket.emit("userFound",{username:u.username,displayName:u.displayName,profileImage:u.profileImage||"",online:!!socketIdFor(target)});
  });
  socket.on("getConversation",otherUsername=>{
    const me=online.get(socket.id),other=norm(otherUsername);if(!me||!getUser(other)||isEitherBlocked(me,other))return;
    const conv=messages().filter(m=>((norm(m.from)===norm(me)&&norm(m.to)===other)||(norm(m.from)===other&&norm(m.to)===norm(me)))&&!(m.deletedFor||[]).includes(norm(me)));
    socket.emit("conversationHistory",{username:other,messages:conv});
  });
  socket.on("privateMessage",data=>{
    const me=online.get(socket.id),to=norm(data?.to),text=String(data?.message||"").trim();
    if(!me||!to||!text||text.length>5000||!getUser(to)||to===norm(me)||isEitherBlocked(me,to))return;
    const msg={id:Date.now()+"-"+crypto.randomBytes(5).toString("hex"),from:norm(me),fromDisplay:getUser(me)?.displayName||me,to,toDisplay:getUser(to)?.displayName||to,message:text,time:new Date().toISOString(),read:false,deletedFor:[]};
    const list=messages();list.push(msg);if(list.length>50000)list.splice(0,list.length-50000);saveMessages(list);
    const targetSid=socketIdFor(to);if(targetSid)io.to(targetSid).emit("privateMessage",msg);socket.emit("messageSent",msg);
    sendPushToUser(to,{type:"message",from:msg.fromDisplay,message:msg.message,username:msg.from});
  });
  socket.on("markConversationRead",otherUsername=>{
    const me=online.get(socket.id),other=norm(otherUsername);if(!me)return;
    const list=messages();for(const m of list)if(norm(m.from)===other&&norm(m.to)===norm(me))m.read=true;saveMessages(list);emitUnread(socket,me);
  });
  socket.on("deleteMessage",id=>{
    const me=online.get(socket.id);if(!me||!id)return;const list=messages(),idx=list.findIndex(m=>m.id===id);if(idx<0)return;
    if(norm(list[idx].from)!==norm(me))return socket.emit("messageError","Solo puedes borrar tus propios mensajes.");
    list[idx].deletedFor=Array.from(new Set([...(list[idx].deletedFor||[]),norm(me)]));list[idx].message="Mensaje eliminado";list[idx].deleted=true;saveMessages(list);
    const target=list[idx].to;for(const [sid,name] of online.entries())if(norm(name)===target||norm(name)===norm(me))io.to(sid).emit("messageDeleted",{id:list[idx].id,message:list[idx].message});
  });
  socket.on("blockUser",username=>{
    const me=online.get(socket.id),target=norm(username);if(!me||!target||target===norm(me)||!getUser(target))return;
    const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].blockedUsers=Array.from(new Set([...(list[idx].blockedUsers||[]),target]));list[idx].contacts=(list[idx].contacts||[]).filter(x=>norm(x)!==target);saveUsers(list);
    socket.emit("blockUpdated",{username:target,blocked:true});socket.emit("contactsUpdated",getContactList(me));sendUserList();
  });
  socket.on("unblockUser",username=>{
    const me=online.get(socket.id),target=norm(username);if(!me||!target)return;const list=users(),idx=list.findIndex(u=>norm(u.username)===norm(me));if(idx<0)return;
    list[idx].blockedUsers=(list[idx].blockedUsers||[]).filter(x=>norm(x)!==target);saveUsers(list);socket.emit("blockUpdated",{username:target,blocked:false});sendUserList();
  });
  socket.on("getBlockedUsers",()=>{const me=online.get(socket.id);if(me)socket.emit("blockedUsers",getUser(me)?.blockedUsers||[])});

  // WebRTC signaling
  socket.on("callRequest",({to})=>{
    const caller=online.get(socket.id),target=norm(to);if(!caller||!target)return;
    if(target===norm(caller))return socket.emit("callError","No puedes llamarte a ti mismo.");
    if(isEitherBlocked(caller,target))return socket.emit("callError","No puedes contactar con este usuario.");
    if(!getUser(target))return socket.emit("callError","Ese usuario no existe.");
    const callerName=getUser(caller)?.displayName||caller,targetSid=socketIdFor(target);
    if(targetSid)io.to(targetSid).emit("incomingCall",{from:norm(caller),fromDisplay:callerName});
    sendPushToUser(target,{type:"call",title:"Llamada entrante",body:callerName+" te está llamando",from:callerName,username:norm(caller),message:"Llamada entrante"});
    socket.emit("callRinging",{to:target,online:!!targetSid});
  });
  socket.on("callAccept",({to})=>{const callee=online.get(socket.id),target=norm(to),targetSid=socketIdFor(target);if(callee&&target&&targetSid)io.to(targetSid).emit("callAccepted",{from:norm(callee),fromDisplay:getUser(callee)?.displayName||callee})});
  socket.on("callReject",({to})=>{const rejecter=online.get(socket.id),targetSid=socketIdFor(norm(to));if(rejecter&&targetSid)io.to(targetSid).emit("callRejected",{from:norm(rejecter)})});
  socket.on("callOffer",({to,offer})=>{const sender=online.get(socket.id),targetSid=socketIdFor(norm(to));if(sender&&targetSid&&offer)io.to(targetSid).emit("callOffer",{from:norm(sender),offer})});
  socket.on("callAnswer",({to,answer})=>{const sender=online.get(socket.id),targetSid=socketIdFor(norm(to));if(sender&&targetSid&&answer)io.to(targetSid).emit("callAnswer",{from:norm(sender),answer})});
  socket.on("callIceCandidate",({to,candidate})=>{const sender=online.get(socket.id),targetSid=socketIdFor(norm(to));if(sender&&targetSid&&candidate)io.to(targetSid).emit("callIceCandidate",{from:norm(sender),candidate})});
  socket.on("callEnd",({to})=>{const sender=online.get(socket.id),targetSid=socketIdFor(norm(to));if(sender&&targetSid)io.to(targetSid).emit("callEnded",{from:norm(sender)})});
  socket.on("disconnect",()=>{online.delete(socket.id);sendUserList()});
});

setInterval(()=>{
  const before=allStories().length,after=cleanExpiredStories();
  if(before!==after.length)io.emit("storiesUpdated",after);
},60000);

app.get("/{*splat}",(req,res,next)=>{
  if(req.path.startsWith("/api/")||req.path.startsWith("/socket.io/"))return next();
  res.sendFile(path.join(__dirname,"public","index.html"));
});

(async()=>{
  await initializeDatabase();
  server.listen(PORT,"0.0.0.0",()=>console.log(`Mi Chat funcionando en puerto ${PORT}`));
})();
