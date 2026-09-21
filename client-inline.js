
"use strict";

const socket = io({autoConnect:false});

let myUsername = "";
let selectedUser = "";
let allUsers = [];
let authMode = "login";
let unread = {};
let conversations = {};
let pendingContactUser = null;
let relationshipData = { contacts: [], incoming: [], outgoing: [] };

const $ = id => document.getElementById(id);

const authScreen = $("authScreen");
const app = $("app");
const authUsername = $("authUsername");
const authPassword = $("authPassword");
const authButton = $("authButton");
const switchAuth = $("switchAuth");
const authDescription = $("authDescription");
const authError = $("authError");

const usersContainer = $("users");
const searchInput = $("searchInput");
const messagesContainer = $("messages");
const messageInput = $("messageInput");
const sendButton = $("sendButton");
const attachButton = $("attachButton");
const fileInput = $("fileInput");
const mediaName = $("mediaName");
let pendingMedia = null;
const chatTitle = $("chatTitle");
const chatSubtitle = $("chatSubtitle");
const headerAvatar = $("headerAvatar");
const blockCurrentButton = $("blockCurrentButton");
const callButton = $("callButton");
const hangupButton = $("hangupButton");

const incomingCallModal = $("incomingCallModal");
const incomingCallText = $("incomingCallText");
const acceptCallButton = $("acceptCallButton");
const rejectCallButton = $("rejectCallButton");
const callError = $("callError");
const remoteAudio = $("remoteAudio");

const activeCallScreen = $("activeCallScreen");
const activeCallAvatarImage = $("activeCallAvatarImage");
const activeCallAvatarLetter = $("activeCallAvatarLetter");
const activeCallName = $("activeCallName");
const activeCallStatus = $("activeCallStatus");
const activeCallTimer = $("activeCallTimer");
const muteCallButton = $("muteCallButton");
const muteCallIcon = $("muteCallIcon");
const muteCallText = $("muteCallText");
const speakerCallButton = $("speakerCallButton");
const speakerCallIcon = $("speakerCallIcon");
const speakerCallText = $("speakerCallText");
const recordCallButton = $("recordCallButton");
const recordCallIcon = $("recordCallIcon");
const recordCallText = $("recordCallText");
const recordingBanner = $("recordingBanner");
const activeHangupButton = $("activeHangupButton");

let activeCallTimerInterval = null;
let activeCallStartTime = null;
let callMuted = false;
let callSpeaker = true;

const layout = $("layout");
const notifications = $("notifications");
const requestsButton = $("requestsButton");
const requestsBadge = $("requestsBadge");
const requestsModal = $("requestsModal");
const requestsList = $("requestsList");

let peerConnection = null;
let localStream = null;
let callPeer = "";
let callState = "idle";
let pendingOffer = null;
let queuedIceCandidates = [];
let callRecorder = null;
let callRecordingChunks = [];
let callRecordingStartedAt = 0;
let callRecordingMimeType = "audio/webm";
let callRecordingPeer = "";
let callRecordingAudioContext = null;
let callRecordingDestination = null;

function esc(value){
  const d = document.createElement("div");
  d.textContent = String(value ?? "");
  return d.innerHTML;
}

function norm(value){
  return String(value || "").trim().toLowerCase();
}

function avatarHtml(user){
  if(user && user.profileImage){
    return `<img src="${esc(user.profileImage)}" alt="">`;
  }

  return esc(
    (
      user?.displayName ||
      user?.username ||
      "?"
    ).charAt(0).toUpperCase()
  );
}

/* =====================================================
   AUTENTICACIÓN
===================================================== */

switchAuth.onclick = () => {

  authError.textContent = "";

  authMode =
    authMode === "login"
      ? "register"
      : "login";

  authDescription.textContent =
    authMode === "login"
      ? "Inicia sesión para entrar."
      : "Crea una cuenta.";

  authButton.textContent =
    authMode === "login"
      ? "Iniciar sesión"
      : "Crear cuenta";

  switchAuth.textContent =
    authMode === "login"
      ? "Crear una cuenta"
      : "Ya tengo una cuenta";
};

authButton.onclick = authenticate;

authPassword.onkeydown = e => {
  if(e.key === "Enter"){
    authenticate();
  }
};

async function loadIdentity(){

  const token = localStorage.getItem("chatToken");

  if(!token) return;

  try{

    const response =
      await fetch("/api/profile",{
        headers:{
          Authorization:"Bearer " + token
        }
      });

    if(!response.ok) return;

    const data = await response.json();

    if(data.username){
      myUsername = data.username;
    }

  }catch{}
}

async function authenticate(){

  const username =
    authUsername.value.trim();

  const password =
    authPassword.value;

  authError.textContent = "";

  if(!username || !password){
    authError.textContent =
      "Completa todos los campos.";
    return;
  }

  authButton.disabled = true;

  try{

    const response =
      await fetch(
        authMode === "login"
          ? "/api/login"
          : "/api/register",
        {
          method:"POST",
          headers:{
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            username,
            password
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok){
      throw new Error(
        data.error || "Error"
      );
    }

    localStorage.setItem(
      "chatToken",
      data.token
    );

    myUsername =
      data.username;

    await loadIdentity();

    enterApp();

  }catch(error){

    authError.textContent =
      error.message;

  }finally{

    authButton.disabled = false;
  }
}

async function checkSession(){

  const token =
    localStorage.getItem("chatToken");

  if(!token) return;

  try{

    const response =
      await fetch(
        "/api/session",
        {
          headers:{
            Authorization:"Bearer " + token
          }
        }
      );

    if(!response.ok){
      localStorage.removeItem("chatToken");
      return;
    }

    const data =
      await response.json();

    if(data.loggedIn){

      myUsername =
        data.username ||
        data.displayName ||
        myUsername;

      await loadIdentity();

      enterApp();
    }

  }catch{}
}

function enterApp(){

  authScreen.style.display = "none";
  app.style.display = "block";

  if(!socket.connected){
    socket.connect();
  }
}

socket.on("connect",() => {

  const token =
    localStorage.getItem("chatToken");

  if(token){
    socket.emit(
      "authenticate",
      token
    );
  }
});

socket.on("authenticated",data => {
  myUsername =
    data.username ||
    myUsername;
  loadStories();

  // Una acción de una notificación puede haber llegado
  // antes de que Socket.IO terminara de autenticar.
  if (pendingNativeCallAction) {
    const pending = pendingNativeCallAction;
    pendingNativeCallAction = null;
    setTimeout(() => {
      handleNativeCallNotification(pending);
    }, 150);
  }
});

socket.on("moderationNotice", notice => {
  if(!notice) return;
  markModerationSeen(notice.id);
  showNotification(
    notice.title || "Aviso de moderación",
    notice.message || "",
    "",
    "moderation"
  );
});

socket.on("moderationNotices", list => {
  const notices = Array.isArray(list) ? list : [];
  const newestFirst = notices.slice().sort((a,b) => Number(b.createdAt||0) - Number(a.createdAt||0));
  let shown = 0;
  for(const notice of newestFirst){
    if(!notice?.id || moderationSeen(notice.id)) continue;
    markModerationSeen(notice.id);
    showNotification(
      notice.title || "Aviso de moderación",
      notice.message || "",
      "",
      "moderation"
    );
    shown++;
    if(shown >= 5) break;
  }
});

function moderationSeen(id){
  try{
    const seen = JSON.parse(localStorage.getItem("michat_moderation_seen") || "[]");
    return seen.includes(String(id));
  }catch{return false}
}

function markModerationSeen(id){
  try{
    const key = "michat_moderation_seen";
    const seen = JSON.parse(localStorage.getItem(key) || "[]");
    const value = String(id);
    if(!seen.includes(value)) seen.push(value);
    localStorage.setItem(key, JSON.stringify(seen.slice(-100)));
  }catch{}
}

socket.on("authenticationError",() => {

  localStorage.removeItem("chatToken");

  location.reload();
});

/* =====================================================
   USUARIOS Y SOLICITUDES
===================================================== */

function isContact(username){
  return relationshipData.contacts.some(x => norm(x) === norm(username));
}
function hasIncomingRequest(username){
  return relationshipData.incoming.some(x => norm(x) === norm(username));
}
function hasOutgoingRequest(username){
  return relationshipData.outgoing.some(x => norm(x) === norm(username));
}
function updateRequestsBadge(){
  const count = relationshipData.incoming.length;
  requestsBadge.textContent = count > 99 ? "99+" : String(count);
  requestsBadge.classList.toggle("hidden", count === 0);
}
function renderRequests(){
  updateRequestsBadge();
  requestsList.innerHTML = "";
  const incomingUsers = relationshipData.incoming
    .map(username => allUsers.find(u => norm(u.username) === norm(username)))
    .filter(Boolean);
  if(!incomingUsers.length){
    requestsList.innerHTML = `<div class="empty" style="min-height:120px">No tienes solicitudes pendientes.</div>`;
    return;
  }
  incomingUsers.forEach(user => {
    const row = document.createElement("div");
    row.className = "requestItem";
    row.innerHTML = `
      <div class="avatar">${avatarHtml(user)}</div>
      <div class="requestItemInfo">
        <div class="requestItemName">${esc(user.displayName || user.username)}</div>
        <div class="requestItemUser">@${esc(user.username)}</div>
      </div>
      <div class="requestItemActions">
        <button class="primary" data-action="accept">Aceptar</button>
        <button class="muted" data-action="reject">Rechazar</button>
      </div>
    `;
    row.querySelector('[data-action="accept"]').onclick = () => socket.emit("acceptContactRequest", user.username);
    row.querySelector('[data-action="reject"]').onclick = () => socket.emit("rejectContactRequest", user.username);
    requestsList.appendChild(row);
  });
}

socket.on("relationshipData", data => {
  relationshipData = {
    contacts: Array.isArray(data?.contacts) ? data.contacts.map(norm) : [],
    incoming: Array.isArray(data?.incoming) ? data.incoming.map(norm) : [],
    outgoing: Array.isArray(data?.outgoing) ? data.outgoing.map(norm) : []
  };
  renderRequests();
  renderUsers();
});

requestsButton.onclick = () => {
  renderRequests();
  requestsModal.style.display = "flex";
};
$("closeRequests").onclick = () => {
  requestsModal.style.display = "none";
};

socket.on("contactRequestReceived", user => {
  if(user?.username && !hasIncomingRequest(user.username)){
    relationshipData.incoming.push(norm(user.username));
  }
  renderRequests();
  showNotification(
    user?.displayName || user?.username || "Solicitud",
    "Te ha enviado una solicitud de contacto."
  );
});

socket.on("contactRequestSent", data => {
  if(data?.username && !hasOutgoingRequest(data.username)){
    relationshipData.outgoing.push(norm(data.username));
  }
  renderUsers();
  $("newChatModal").style.display = "none";
  pendingContactUser = null;
  showNotification(
    "Solicitud enviada",
    `Solicitud enviada a ${data?.displayName || data?.username || "usuario"}.`
  );
});

socket.on("contactRequestAccepted", user => {
  if(user?.username){
    if(!isContact(user.username)) relationshipData.contacts.push(norm(user.username));
    relationshipData.incoming = relationshipData.incoming.filter(x => norm(x) !== norm(user.username));
    relationshipData.outgoing = relationshipData.outgoing.filter(x => norm(x) !== norm(user.username));
  }
  renderRequests();
  renderUsers();
  showNotification(
    "Solicitud aceptada",
    `${user?.displayName || user?.username || "El usuario"} ya puede hablar contigo.`
  );
});

socket.on("contactRequestRejected", data => {
  const username = norm(data?.username || "");
  if(username){
    relationshipData.incoming = relationshipData.incoming.filter(x => norm(x) !== username);
    relationshipData.outgoing = relationshipData.outgoing.filter(x => norm(x) !== username);
  }
  renderRequests();
  renderUsers();
});

socket.on("contactRequestError", message => {
  $("newChatError").textContent = message || "No se pudo gestionar la solicitud.";
});

socket.on("userList",users => {

  allUsers =
    Array.isArray(users)
      ? users
      : [];

  $("onlineCount").textContent =
    allUsers.filter(
      user => user.online
    ).length;

  renderUsers();
});

function renderUsers(){

  const query =
    searchInput.value
      .trim()
      .toLowerCase();

  usersContainer.innerHTML = "";

  const list =
    allUsers.filter(user => {

      if(
        !user ||
        norm(user.username) ===
          norm(myUsername)
      ){
        return false;
      }

      return (
        (
          user.displayName ||
          user.username
        )
        .toLowerCase()
        .includes(query)
      ) ||
      user.username
        .toLowerCase()
        .includes(query);
    });

  if(!list.length){

    usersContainer.innerHTML =
      `<div style="padding:20px;text-align:center;color:#777">
        No tienes contactos añadidos.
      </div>`;

    return;
  }

  list.forEach(user => {

    const row =
      document.createElement("div");

    row.className = "user";

    const count = unread[user.username] || 0;
    const contact = isContact(user.username);
    const incoming = hasIncomingRequest(user.username);
    const outgoing = hasOutgoingRequest(user.username);

    let actionHtml = "";
    if(contact) actionHtml = `<button class="toolBtn" data-action="open">Abrir</button>`;
    else if(incoming) actionHtml = `<button class="toolBtn primary" data-action="accept">Aceptar</button>`;
    else if(outgoing) actionHtml = `<button class="toolBtn" data-action="pending">Enviada</button>`;
    else actionHtml = `<button class="toolBtn primary" data-action="request">Solicitar</button>`;

    row.innerHTML = `
      <div class="avatar">${avatarHtml(user)}</div>
      <div class="userInfo">
        <div class="userName">${esc(user.displayName || user.username)}</div>
        <div class="userSub">@${esc(user.username)}</div>
        <div class="statusRow">
          <div class="${user.online ? "online" : "offline"}">${user.online ? "● En línea" : "○ Desconectado"}</div>
          <div style="display:flex;align-items:center;gap:6px">
            ${actionHtml}
            ${count ? `<div class="badge">${count > 99 ? "99+" : count}</div>` : ""}
          </div>
        </div>
      </div>
    `;

    const actionButton = row.querySelector('[data-action]');
    if(actionButton){
      actionButton.onclick = event => {
        event.stopPropagation();
        const action = actionButton.dataset.action;
        if(action === "open") {
          openChat(user.username, user.displayName || user.username, user.online, user.profileImage || "");
        }else if(action === "accept") {
          socket.emit("acceptContactRequest", user.username);
        }else if(action === "request") {
          socket.emit("sendContactRequest", user.username);
        }
      };
    }

    if(contact){
      row.style.cursor = "pointer";
      row.onclick = () => openChat(user.username, user.displayName || user.username, user.online, user.profileImage || "");
    }

    usersContainer.appendChild(row);
  });
}

searchInput.oninput = renderUsers;

/* =====================================================
   CONTACTOS
===================================================== */

$("newChatButton").onclick = () => {

  $("newChatError").textContent = "";
  $("newChatUsername").value = "";
  $("newChatModal").style.display = "flex";

  setTimeout(
    () => $("newChatUsername").focus(),
    50
  );
};

$("cancelNewChat").onclick = () => {
  $("newChatModal").style.display = "none";
};

$("contactButton").onclick = () => {

  const username =
    $("newChatUsername")
      .value
      .trim();

  $("newChatError").textContent = "";

  if(!username){
    $("newChatError").textContent =
      "Escribe un nombre de usuario.";
    return;
  }

  socket.emit("findUser",username);
};

$("newChatUsername").onkeydown = e => {
  if(e.key === "Enter"){
    $("contactButton").click();
  }
};

socket.on("userNotFound",() => {
  $("newChatError").textContent =
    "No existe ese usuario.";
});

socket.on("userFoundError",message => {
  $("newChatError").textContent =
    message;
});

socket.on("userFound",user => {
  pendingContactUser = user;
  const relationship = user.relationship || "none";

  if(relationship === "accepted") {
    $("newChatModal").style.display = "none";
    openChat(user.username, user.displayName || user.username, !!user.online, user.profileImage || "");
    pendingContactUser = null;
    return;
  }
  if(relationship === "outgoing") {
    $("newChatError").textContent = "Ya has enviado una solicitud a este usuario.";
    return;
  }
  if(relationship === "incoming") {
    $("newChatError").textContent = "Este usuario ya te ha enviado una solicitud. Acepta la solicitud desde «Solicitudes».";
    return;
  }

  socket.emit("sendContactRequest", user.username);
});

socket.on("contactRequestError",message => {
  $("newChatError").textContent = message;
  pendingContactUser = null;
});

/* =====================================================
   CHAT
===================================================== */

function openChat(
  username,
  displayName,
  online,
  profileImage = ""
){

  if(!isContact(username)) {
    selectedUser = "";
    messageInput.disabled = true;
    sendButton.disabled = true;
    attachButton.disabled = true;
    messagesContainer.innerHTML = `<div class="empty">Para poder hablar con ${esc(displayName || username)}, primero debes enviar una solicitud y esperar a que la acepte.</div>`;
    chatTitle.textContent = displayName || username;
    chatSubtitle.textContent = "🔒 Solicitud de contacto necesaria";
    layout.classList.add("mobileChat");
    return;
  }

  selectedUser = username;

  unread[username] = 0;

  renderUsers();

  chatTitle.textContent =
    displayName || username;

  chatSubtitle.textContent =
    online
      ? "● En línea"
      : "○ Desconectado";

  headerAvatar.innerHTML =
    profileImage
      ? `<img src="${esc(profileImage)}" alt="">`
      : esc(
          (displayName || username)
            .charAt(0)
            .toUpperCase()
        );

  blockCurrentButton.classList.remove("hidden");
  blockCurrentButton.textContent = "🚫 Bloquear";

  callButton.classList.remove("hidden");
  hangupButton.classList.add("hidden");

  layout.classList.add("mobileChat");

  messageInput.disabled = false;
  sendButton.disabled = false;
  attachButton.disabled = false;

  messagesContainer.innerHTML =
    `<div class="empty">
      Cargando conversación...
    </div>`;

  socket.emit(
    "getConversation",
    username
  );

  /* CORREGIDO: faltaba ); en tu código */
  socket.emit(
    "markConversationRead",
    username
  );
}

socket.on("conversationHistory",data => {

  conversations[data.username] =
    data.messages || [];

  if(selectedUser === data.username){
    renderConversation(data.username);
  }
});

socket.on("conversationBlocked",message => {

  messagesContainer.innerHTML =
    `<div class="empty">
      ${esc(message)}
    </div>`;

  messageInput.disabled = true;
  sendButton.disabled = true;
  attachButton.disabled = true;
  clearPendingMedia();
});

function renderConversation(username){

  const list =
    conversations[username] || [];

  messagesContainer.innerHTML = "";

  if(!list.length){

    messagesContainer.innerHTML =
      `<div class="empty">
        Todavía no hay mensajes.
      </div>`;

    return;
  }

  list.forEach(addMessage);

  messagesContainer.scrollTop =
    messagesContainer.scrollHeight;
}

function addMessage(message){

  const mine =
    norm(message.from) ===
    norm(myUsername);

  const row =
    document.createElement("div");

  row.className =
    "messageRow " +
    (mine ? "mine" : "");

  const bubble =
    document.createElement("div");

  bubble.className = "bubble";

  const date =
    new Date(message.time);

  const time =
    date.getHours()
      .toString()
      .padStart(2,"0") +
    ":" +
    date.getMinutes()
      .toString()
      .padStart(2,"0");

  const text =
    message.deleted
      ? `<span class="deletedText">
           Mensaje eliminado
         </span>`
      : esc(message.message || "");

  bubble.innerHTML = `
    ${
      mine
        ? ""
        : `<div class="from">
             ${esc(
               message.fromDisplay ||
               message.from
             )}
           </div>`
    }

    ${message.message ? `<div>${text}</div>` : ""}

    <div class="time">
      ${time}
    </div>
  `;

  if(!message.deleted && message.media){
    const mediaWrap = document.createElement("div");
    mediaWrap.innerHTML = mediaHtml(message);
    bubble.insertBefore(mediaWrap.firstElementChild, bubble.querySelector(".time"));
  }

  if(mine && !message.deleted){

    const tools =
      document.createElement("div");

    tools.className =
      "messageContext";

    const deleteButton =
      document.createElement("button");

    deleteButton.className =
      "deleteBtn";

    deleteButton.textContent =
      "🗑️ Borrar";

    deleteButton.onclick = () => {
      socket.emit(
        "deleteMessage",
        message.id
      );
    };

    tools.appendChild(
      deleteButton
    );

    bubble.appendChild(
      tools
    );
  }

  row.appendChild(
    bubble
  );

  messagesContainer.appendChild(
    row
  );
}

socket.on("messageDeleted",data => {

  for(const key in conversations){

    const index =
      conversations[key].findIndex(
        message =>
          message.id === data.id
      );

    if(index >= 0){

      conversations[key][index].deleted = true;
      conversations[key][index].message =
        data.message;
    }
  }

  if(selectedUser){
    renderConversation(selectedUser);
  }
});

attachButton.onclick = () => fileInput.click();

fileInput.onchange = () => {
  const file = fileInput.files && fileInput.files[0];
  if(!file){
    clearPendingMedia();
    return;
  }

  if(file.size > 7 * 1024 * 1024){
    showNotification("Mi Chat", "El archivo no puede superar los 7 MB.");
    clearPendingMedia();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    if(!dataUrl.startsWith("data:")){
      showNotification("Mi Chat", "No se pudo preparar el archivo.");
      clearPendingMedia();
      return;
    }

    let type = "file";
    if(file.type.startsWith("image/")) type = "image";
    else if(file.type.startsWith("video/")) type = "video";
    else if(file.type.startsWith("audio/")) type = "audio";

    pendingMedia = {
      data: dataUrl,
      mimeType: file.type || "application/octet-stream",
      fileName: file.name,
      type
    };

    mediaName.textContent = "📎 " + file.name;
    mediaName.style.display = "block";
  };
  reader.onerror = () => {
    showNotification("Mi Chat", "No se pudo leer el archivo.");
    clearPendingMedia();
  };
  reader.readAsDataURL(file);
};

function clearPendingMedia(){
  pendingMedia = null;
  fileInput.value = "";
  mediaName.textContent = "";
  mediaName.style.display = "none";
}

function mediaHtml(message){
  const src = esc(message.media || "");
  const name = esc(message.fileName || "archivo");
  const mime = String(message.mimeType || "");

  if(message.type === "image" || mime.startsWith("image/")){
    return `<img class="chatMedia" src="${src}" alt="${name}" loading="lazy">`;
  }

  if(message.type === "video" || mime.startsWith("video/")){
    return `<video class="chatMedia chatVideo" src="${src}" controls playsinline preload="metadata"></video>`;
  }

  if(message.type === "audio" || mime.startsWith("audio/")){
    return `<audio class="chatAudio" src="${src}" controls preload="metadata"></audio>`;
  }

  return `<a class="fileAttachment" href="${src}" download="${name}"><span class="fileAttachmentIcon">📎</span><span class="fileAttachmentName">${name}</span></a>`;
}

sendButton.onclick = sendMessage;

messageInput.onkeydown = event => {
  if(event.key === "Enter"){
    sendMessage();
  }
};

function sendMessage(){

  const text =
    messageInput.value.trim();

  if((!text && !pendingMedia) || !selectedUser){
    return;
  }

  socket.emit(
    "privateMessage",
    {
      to:selectedUser,
      message:text,
      media:pendingMedia
    }
  );

  messageInput.value = "";
  clearPendingMedia();
}

socket.on("messageSent",message => {

  const key =
    message.to;

  if(!conversations[key]){
    conversations[key] = [];
  }

  if(
    !conversations[key].some(
      item =>
        item.id === message.id
    )
  ){

    conversations[key].push(message);
  }

  if(selectedUser === key){

    addMessage(message);

    messagesContainer.scrollTop =
      messagesContainer.scrollHeight;
  }
});

socket.on("privateMessage",message => {

  const other =
    norm(message.from) ===
    norm(myUsername)
      ? norm(message.to)
      : norm(message.from);

  if(!conversations[other]){
    conversations[other] = [];
  }

  if(
    !conversations[other].some(
      item =>
        item.id === message.id
    )
  ){

    conversations[other].push(message);
  }

  if(selectedUser === other){

    addMessage(message);

    messagesContainer.scrollTop =
      messagesContainer.scrollHeight;

    socket.emit(
      "markConversationRead",
      other
    );

  }else{

    unread[other] =
      (unread[other] || 0) + 1;

    renderUsers();

    showNotification(
      message.fromDisplay ||
      message.from,
      message.message,
      other,
      "message"
    );
  }
});

socket.on("unreadCounts",data => {
  unread = data || {};
  renderUsers();
});

/* =====================================================
   NOTIFICACIÓN EN PANTALLA
===================================================== */

function showNotification(
  title,
  text,
  username = "",
  type = "message"
){

  const notification =
    document.createElement("div");

  notification.className =
    "notification";

  notification.innerHTML = `
    <div class="notificationTitle">
      ${
        type === "call"
          ? "📞 "
          : type === "moderation"
          ? "⚠️ "
          : "💬 "
      }${esc(title)}
    </div>

    <div class="notificationText">
      ${esc(text)}
    </div>
  `;

  notification.onclick = () => {

    if(
      type === "call" &&
      username
    ){

      showIncomingCallFromNotification(
        username,
        title
      );

    }else if(username){

      const user =
        allUsers.find(
          item =>
            norm(item.username) ===
            norm(username)
        );

      if(user){

        openChat(
          user.username,
          user.displayName || user.username,
          user.online,
          user.profileImage || ""
        );

      }else{

        socket.emit(
          "findUser",
          username
        );
      }
    }

    notification.remove();
  };

  notifications.appendChild(
    notification
  );

  setTimeout(
    () => notification.remove(),
    6000
  );
}

/* =====================================================
   WEBRTC
===================================================== */

const rtcConfig = {
  iceServers:[
    {
      urls:"stun:stun.l.google.com:19302"
    },
    {
      urls:"stun:stun1.l.google.com:19302"
    }
  ]
};

async function ensureMicrophone(){

  if(
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ){

    throw new Error(
      "Este navegador no permite usar el micrófono aquí."
    );
  }

  if(!localStream){

    localStream =
      await navigator.mediaDevices.getUserMedia({
        audio:true,
        video:false
      });
  }

  return localStream;
}

async function flushIceCandidates(){

  if(
    !peerConnection ||
    !peerConnection.remoteDescription
  ){
    return;
  }

  const pending =
    queuedIceCandidates.splice(0);

  for(const candidate of pending){

    try{

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );

    }catch(error){

      console.warn(
        "No se pudo añadir ICE:",
        error
      );
    }
  }
}

async function startPeer(){

  if(peerConnection){
    return;
  }

  peerConnection =
    new RTCPeerConnection(
      rtcConfig
    );

  const stream =
    await ensureMicrophone();

  stream.getTracks().forEach(
    track => {
      peerConnection.addTrack(
        track,
        stream
      );
    }
  );

  peerConnection.ontrack =
    event => {

      console.log("WEBRTC: audio remoto recibido", event);

      if(
        !event.streams ||
        !event.streams[0]
      ){
        console.warn("WEBRTC: no llegó ningún MediaStream remoto");
        return;
      }

      remoteAudio.srcObject =
        event.streams[0];

      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      remoteAudio.muted = false;
      remoteAudio.volume = 1.0;

      remoteAudio.play()
        .then(() => {
          console.log("WEBRTC: audio remoto reproduciéndose correctamente");
        })
        .catch(error => {
          console.error("WEBRTC: ERROR reproduciendo audio remoto:", error);
        });
    };

  peerConnection.onicecandidate =
    event => {

      if(
        event.candidate &&
        callPeer
      ){

        socket.emit(
          "callIceCandidate",
          {
            to:callPeer,
            candidate:event.candidate
          }
        );
      }
    };



  peerConnection.oniceconnectionstatechange = () => {
    console.log(
      "WEBRTC iceConnectionState:",
      peerConnection?.iceConnectionState
    );
  };

  peerConnection.onconnectionstatechange =
    () => {

      const state =
        peerConnection?.connectionState;

      console.log("WEBRTC connectionState:", state);

      if(state === "connected"){
        setActiveCallStatus("En llamada");
      }

      if(state === "connecting"){
        setActiveCallStatus("Conectando...");
      }

      if(
        state === "failed" ||
        state === "closed"
      ){

        cleanupCall(false);
      }
    };
}



/* =====================================================
   PANTALLA DE LLAMADA ACTIVA
===================================================== */

function getCallUser(username){
  return allUsers.find(
    user => norm(user.username) === norm(username)
  );
}

function showActiveCallScreen(username, status = "Conectando..."){

  const user = getCallUser(username);
  const name =
    user?.displayName ||
    username ||
    "Usuario";

  activeCallName.textContent = name;
  activeCallStatus.textContent = status;

  if(user?.profileImage){
    activeCallAvatarImage.src = user.profileImage;
    activeCallAvatarImage.style.display = "block";
    activeCallAvatarLetter.style.display = "none";
  }else{
    activeCallAvatarImage.removeAttribute("src");
    activeCallAvatarImage.style.display = "none";
    activeCallAvatarLetter.textContent =
      (name.charAt(0) || "👤").toUpperCase();
    activeCallAvatarLetter.style.display = "block";
  }

  callMuted = false;
  callSpeaker = true;
  updateMuteButton();
  updateSpeakerButton();

  activeCallScreen.classList.add("visible");
  activeCallScreen.setAttribute("aria-hidden", "false");

  if(!activeCallStartTime){
    startCallTimer();
  }
}

function hideActiveCallScreen(){
  activeCallScreen.classList.remove("visible");
  activeCallScreen.setAttribute("aria-hidden", "true");
  stopCallTimer();
}

function setActiveCallStatus(status){
  if(!activeCallScreen.classList.contains("visible")){
    showActiveCallScreen(callPeer, status);
    return;
  }
  activeCallStatus.textContent = status;
}

function startCallTimer(){
  stopCallTimer();
  activeCallStartTime = Date.now();
  updateCallTimer();
  activeCallTimerInterval = setInterval(updateCallTimer, 1000);
}

function stopCallTimer(){
  if(activeCallTimerInterval){
    clearInterval(activeCallTimerInterval);
    activeCallTimerInterval = null;
  }
  activeCallStartTime = null;
  activeCallTimer.textContent = "00:00";
}

function updateCallTimer(){
  if(!activeCallStartTime) return;

  const elapsed = Math.max(
    0,
    Math.floor((Date.now() - activeCallStartTime) / 1000)
  );

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  activeCallTimer.textContent =
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0");
}

function updateMuteButton(){
  if(callMuted){
    muteCallIcon.textContent = "🔇";
    muteCallText.textContent = "Activar";
    muteCallButton.classList.add("active");
  }else{
    muteCallIcon.textContent = "🎤";
    muteCallText.textContent = "Silenciar";
    muteCallButton.classList.remove("active");
  }
}

function toggleCallMute(){
  if(!localStream) return;

  const tracks = localStream.getAudioTracks();
  if(!tracks.length) return;

  callMuted = !callMuted;

  tracks.forEach(track => {
    track.enabled = !callMuted;
  });

  updateMuteButton();
}

function updateSpeakerButton(){
  speakerCallIcon.textContent = callSpeaker ? "🔊" : "🔈";
  speakerCallText.textContent = callSpeaker ? "Altavoz" : "Audio";
  speakerCallButton.classList.toggle("active", callSpeaker);
}

async function toggleCallSpeaker(){
  /*
     Android WebView mantiene la salida en el dispositivo de
     comunicación mediante MainActivity. En navegadores que
     soportan setSinkId intentamos aplicar el dispositivo por defecto.
  */
  callSpeaker = !callSpeaker;

  if(remoteAudio && typeof remoteAudio.setSinkId === "function"){
    try{
      await remoteAudio.setSinkId("default");
    }catch(error){
      console.warn("No se pudo cambiar el dispositivo de audio:", error);
    }
  }

  updateSpeakerButton();
}

muteCallButton.onclick = toggleCallMute;
speakerCallButton.onclick = toggleCallSpeaker;
activeHangupButton.onclick = () => cleanupCall(true);


function setRecordingUI(active){
  recordingBanner.classList.toggle("visible", !!active);
  recordCallButton.classList.toggle("active", !!active);
  recordCallIcon.textContent = active ? "⏹️" : "🔴";
  recordCallText.textContent = active ? "Detener" : "Grabar";
}

async function startCallRecording(){
  if(callRecorder || callState !== "in-call") return;
  if(!callPeer || !localStream) return;

  const remoteStream = remoteAudio.srcObject;
  if(!remoteStream){
    showNotification("Grabación", "Espera a que la llamada esté conectada.");
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if(!AudioContextClass){
    showNotification("Grabación", "Tu navegador no permite mezclar el audio de la llamada.");
    return;
  }

  try{
    callRecordingAudioContext = new AudioContextClass();

    // En Android/WebView el AudioContext puede arrancar suspendido.
    // Hay que reactivarlo antes de crear la grabación.
    if (callRecordingAudioContext.state === "suspended") {
      await callRecordingAudioContext.resume();
    }

    callRecordingDestination = callRecordingAudioContext.createMediaStreamDestination();

    const localTracks = localStream.getAudioTracks ? localStream.getAudioTracks() : [];
    if (!localTracks.length) {
      throw new Error("No se encontró el micrófono de la llamada.");
    }

    const localSource = callRecordingAudioContext.createMediaStreamSource(
      new MediaStream(localTracks)
    );

    // Primero intentamos capturar el audio tal como se reproduce en el elemento
    // <audio>. Esto evita que algunos WebView entreguen una pista remota que
    // luego no pasa correctamente al AudioContext.
    let remoteCaptureStream = null;
    if (typeof remoteAudio.captureStream === "function") {
      try {
        remoteCaptureStream = remoteAudio.captureStream();
      } catch (e) {
        console.warn("captureStream no disponible para el audio remoto:", e);
      }
    }

    if (!remoteCaptureStream || !remoteCaptureStream.getAudioTracks().length) {
      remoteCaptureStream = remoteStream;
    }

    const remoteTracks = remoteCaptureStream.getAudioTracks
      ? remoteCaptureStream.getAudioTracks()
      : [];

    if (!remoteTracks.length) {
      throw new Error("Todavía no se ha recibido el audio de la otra persona.");
    }

    const remoteSource = callRecordingAudioContext.createMediaStreamSource(
      new MediaStream(remoteTracks)
    );

    localSource.connect(callRecordingDestination);
    remoteSource.connect(callRecordingDestination);

    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus"
    ];
    callRecordingMimeType = preferred.find(x => MediaRecorder.isTypeSupported(x)) || "audio/webm";
    callRecorder = new MediaRecorder(callRecordingDestination.stream, {
      mimeType: callRecordingMimeType,
      audioBitsPerSecond: 32000
    });
    callRecordingChunks = [];
    callRecordingStartedAt = Date.now();
    callRecordingPeer = callPeer;

    callRecorder.ondataavailable = event => {
      if(event.data && event.data.size) callRecordingChunks.push(event.data);
    };

    callRecorder.onerror = event => {
      console.error("Error grabando llamada:", event.error);
      showNotification("Grabación", "Se produjo un error durante la grabación.");
      stopCallRecording(false);
    };

    callRecorder.onstop = async () => {
      const duration = Math.round((Date.now() - callRecordingStartedAt) / 1000);
      const blob = new Blob(callRecordingChunks, { type: callRecordingMimeType });
      callRecordingChunks = [];

      if(blob.size){
        try{
          const token = localStorage.getItem("chatToken");
          const response = await fetch(
            "/api/call-recordings?to=" + encodeURIComponent(callRecordingPeer) +
            "&startedAt=" + encodeURIComponent(callRecordingStartedAt) +
            "&duration=" + encodeURIComponent(duration),
            {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + token,
                "Content-Type": callRecordingMimeType
              },
              body: blob
            }
          );
          const data = await response.json().catch(() => ({}));
          if(!response.ok) throw new Error(data.error || "No se pudo guardar la grabación.");
          showNotification("Grabación", "Grabación guardada correctamente.");
        }catch(error){
          console.error(error);
          showNotification("Grabación", error.message || "No se pudo guardar la grabación.");
        }
      }

      try{ callRecordingAudioContext?.close(); }catch{}
      callRecordingAudioContext = null;
      callRecordingDestination = null;
      callRecordingPeer = "";
      callRecorder = null;
      setRecordingUI(false);
    };

    callRecorder.start(1000);
    setRecordingUI(true);
    socket.emit("recordingStarted", { to: callPeer });
    showNotification("Grabación", "La llamada se está grabando y ambos participantes han sido avisados.");
  }catch(error){
    console.error(error);
    try{ callRecordingAudioContext?.close(); }catch{}
    callRecordingAudioContext = null;
    callRecordingDestination = null;
    callRecorder = null;
    setRecordingUI(false);
    showNotification("Grabación", error.message || "No se pudo iniciar la grabación.");
  }
}

function stopCallRecording(notify = true){
  if(!callRecorder){
    setRecordingUI(false);
    return;
  }
  if(notify && callPeer) socket.emit("recordingStopped", { to: callPeer });
  try{ callRecorder.stop(); }catch{}
}

recordCallButton.onclick = () => {
  if(callRecorder) stopCallRecording(true);
  else startCallRecording();
};

socket.on("recordingStarted", () => {
  recordingBanner.classList.add("visible");
  showNotification("Grabación", "La otra persona ha iniciado la grabación de la llamada.");
});

socket.on("recordingStopped", () => {
  if(!callRecorder) recordingBanner.classList.remove("visible");
  showNotification("Grabación", "La grabación de la llamada ha terminado.");
});

async function createAndSendOffer(){

  await startPeer();

  const offer =
    await peerConnection.createOffer();

  await peerConnection.setLocalDescription(
    offer
  );

  socket.emit(
    "callOffer",
    {
      to:callPeer,
      offer:peerConnection.localDescription
    }
  );
}

async function callUser(){

  if(
    !selectedUser ||
    callState !== "idle"
  ){
    return;
  }

  callPeer =
    selectedUser;

  callState =
    "calling";

  showActiveCallScreen(callPeer, "Llamando...");

  callButton.classList.add("hidden");
  hangupButton.classList.remove("hidden");

  chatSubtitle.textContent =
    "📞 Llamando...";

  try{

    await ensureMicrophone();

    socket.emit(
      "callRequest",
      {
        to:callPeer
      }
    );

  }catch(error){

    console.error(
      "Error usando micrófono:",
      error
    );

    cleanupCall(false);

    showNotification(
      "Sistema",
      error.message ||
        "No se pudo usar el micrófono."
    );
  }
}

function showIncomingCallFromNotification(
  username,
  displayName = ""
){

  if(callState !== "idle"){
    return;
  }

  callPeer =
    username;

  callState =
    "incoming";

  const contact =
    allUsers.find(
      user =>
        norm(user.username) ===
        norm(username)
    );

  const name =
    displayName ||
    contact?.displayName ||
    username;

  incomingCallText.textContent =
    name +
    " te está llamando.";

  callError.textContent = "";

  incomingCallModal.style.display =
    "flex";
}

async function acceptCall(){

  if(
    !callPeer ||
    callState !== "incoming"
  ){
    return;
  }

  incomingCallModal.style.display =
    "none";

  callState =
    "in-call";

  showActiveCallScreen(callPeer, "Conectando...");

  callButton.classList.add("hidden");
  hangupButton.classList.remove("hidden");

  chatSubtitle.textContent =
    "📞 Conectando...";

  try{

    await ensureMicrophone();

    await startPeer();

    /*
      La oferta puede llegar justo después
      de aceptar. Si ya está guardada,
      la procesamos.
    */

    if(pendingOffer){

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(
          pendingOffer
        )
      );

      await flushIceCandidates();

      const answer =
        await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(
        answer
      );

      socket.emit(
        "callAnswer",
        {
          to:callPeer,
          answer:peerConnection.localDescription
        }
      );

      pendingOffer = null;
    }

    socket.emit(
      "callAccept",
      {
        to:callPeer
      }
    );

  }catch(error){

    console.error(
      "Error aceptando llamada:",
      error
    );

    cleanupCall(true);

    showNotification(
      "Llamada",
      error.message ||
        "No se pudo iniciar la llamada."
    );
  }
}

function rejectCall(){

  incomingCallModal.style.display =
    "none";

  if(callPeer){

    socket.emit(
      "callReject",
      {
        to:callPeer
      }
    );
  }

  cleanupCall(false);
}

function cleanupCall(
  notifyRemote = true
){

  if(callRecorder){
    stopCallRecording(false);
  } else {
    setRecordingUI(false);
  }


  if(
    notifyRemote &&
    callPeer
  ){

    socket.emit(
      "callEnd",
      {
        to:callPeer
      }
    );
  }

  if(peerConnection){

    try{
      peerConnection.close();
    }catch{}
  }

  peerConnection = null;

  if(localStream){

    localStream.getTracks().forEach(
      track =>
        track.stop()
    );
  }

  localStream = null;

  remoteAudio.srcObject = null;

  pendingOffer = null;
  queuedIceCandidates = [];

  callState = "idle";
  callPeer = "";

  incomingCallModal.style.display =
    "none";

  hideActiveCallScreen();

  hangupButton.classList.add("hidden");

  if(selectedUser){

    callButton.classList.remove("hidden");

    const user =
      allUsers.find(
        item =>
          norm(item.username) ===
          norm(selectedUser)
      );

    if(user){

      chatSubtitle.textContent =
        user.online
          ? "● En línea"
          : "○ Desconectado";
    }

  }else{

    callButton.classList.add("hidden");
  }
}

callButton.onclick =
  callUser;

hangupButton.onclick =
  () => cleanupCall(true);

acceptCallButton.onclick =
  acceptCall;

rejectCallButton.onclick =
  rejectCall;

socket.on("callError",message => {

  cleanupCall(false);

  showNotification(
    "Llamada",
    message
  );
});

socket.on("incomingCall",data => {

  if(
    callState !== "idle"
  ){

    socket.emit(
      "callReject",
      {
        to:data.from
      }
    );

    return;
  }

  callPeer =
    data.from;

  callState =
    "incoming";

  incomingCallText.textContent =
    `${
      data.fromDisplay ||
      data.from
    } te está llamando.`;

  callError.textContent = "";

  incomingCallModal.style.display =
    "flex";

  showNotification(
    "Llamada entrante",
    `${
      data.fromDisplay ||
      data.from
    } te está llamando`,
    data.from,
    "call"
  );
});

socket.on(
  "callAccepted",
  async data => {

    try{

      if(callState !== "calling"){
        return;
      }

      callPeer =
        data.from ||
        callPeer;

      callState =
        "in-call";

      showActiveCallScreen(callPeer, "Conectando...");

      chatSubtitle.textContent =
        "📞 Conectando...";

      await createAndSendOffer();

    }catch(error){

      console.error(
        "Error creando oferta:",
        error
      );

      cleanupCall(true);

      showNotification(
        "Llamada",
        error.message ||
          "No se pudo iniciar la llamada."
      );
    }
  }
);

socket.on(
  "callRejected",
  () => {

    showNotification(
      "Llamada",
      "La otra persona rechazó la llamada."
    );

    cleanupCall(false);
  }
);

socket.on(
  "callOffer",
  async data => {

    try{

      callPeer =
        data.from ||
        callPeer;

      pendingOffer =
        data.offer;

      if(
        callState !== "in-call" &&
        callState !== "incoming"
      ){
        return;
      }

      if(!peerConnection){
        await startPeer();
      }

      /*
        Si todavía está aceptando la llamada,
        guardamos la oferta para procesarla
        después de aceptar.
      */

      if(callState === "incoming"){
        return;
      }

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(
          pendingOffer
        )
      );

      await flushIceCandidates();

      const answer =
        await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(
        answer
      );

      socket.emit(
        "callAnswer",
        {
          to:callPeer,
          answer:peerConnection.localDescription
        }
      );

      pendingOffer = null;

      setActiveCallStatus("En llamada");

      chatSubtitle.textContent =
        "📞 En llamada";

    }catch(error){

      console.error(
        "Error procesando oferta:",
        error
      );

      cleanupCall(true);

      showNotification(
        "Llamada",
        "Error al conectar la llamada."
      );
    }
  }
);

socket.on(
  "callAnswer",
  async data => {

    try{

      if(!peerConnection){
        return;
      }

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(
          data.answer
        )
      );

      await flushIceCandidates();

      setActiveCallStatus("En llamada");

      chatSubtitle.textContent =
        "📞 En llamada";

    }catch(error){

      console.error(
        "Error procesando respuesta:",
        error
      );

      cleanupCall(true);
    }
  }
);

socket.on(
  "callIceCandidate",
  async data => {

    try{

      if(!data.candidate){
        return;
      }

      if(
        !peerConnection ||
        !peerConnection.remoteDescription
      ){

        queuedIceCandidates.push(
          data.candidate
        );

        return;
      }

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(
          data.candidate
        )
      );

    }catch(error){

      console.warn(
        "Error procesando ICE:",
        error
      );
    }
  }
);

socket.on(
  "callEnded",
  () => {

    showNotification(
      "Llamada",
      "La llamada ha terminado."
    );

    cleanupCall(false);
  }
);

/* =====================================================
   BLOQUEOS
===================================================== */

blockCurrentButton.onclick = () => {

  if(!selectedUser){
    return;
  }

  socket.emit(
    "blockUser",
    selectedUser
  );
};

socket.on(
  "blockUpdated",
  data => {

    if(
      data.blocked &&
      selectedUser ===
        data.username
    ){

      messagesContainer.innerHTML =
        `<div class="empty">
          Has bloqueado a este usuario.
        </div>`;

      messageInput.disabled =
        true;

      sendButton.disabled =
        true;

      blockCurrentButton.textContent =
        "🚫 Bloqueado";
    }
  }
);

/* =====================================================
   CONFIGURACIÓN
===================================================== */

$("settingsButton").onclick = () => {
  $("settingsModal").style.display = "flex";
};

$("closeSettings").onclick = () => {
  $("settingsModal").style.display = "none";
};

$("settingsBlocked").onclick = () => {

  $("settingsModal").style.display = "none";

  socket.emit(
    "getBlockedUsers"
  );

  $("blockedModal").style.display = "flex";
};

$("settingsPush").onclick = async () => {

  $("settingsModal").style.display =
    "none";

  await activatePushNotifications();
};

$("settingsReport").onclick = () => {
  $("settingsModal").style.display = "none";
  $("reportText").value = "";
  $("reportCategory").value = "Problema técnico";
  $("reportMessage").textContent = "";
  $("reportModal").style.display = "flex";
};

$("closeReport").onclick = () => {
  $("reportModal").style.display = "none";
};

$("sendReport").onclick = async () => {
  const button = $("sendReport");
  const message = $("reportMessage");
  const text = $("reportText").value.trim();

  if (text.length < 5) {
    message.style.color = "#c00";
    message.textContent = "Escribe al menos 5 caracteres.";
    return;
  }

  button.disabled = true;
  message.style.color = "#777";
  message.textContent = "Enviando...";

  try {
    const token = localStorage.getItem("chatToken");
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({
        category: $("reportCategory").value,
        text
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo enviar el reporte.");

    message.style.color = "#087f23";
    message.textContent = "Reporte enviado correctamente. Gracias.";
    $("reportText").value = "";
    setTimeout(() => { $("reportModal").style.display = "none"; }, 1200);
  } catch (error) {
    message.style.color = "#c00";
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};

$("closeBlocked").onclick = () => {
  $("blockedModal").style.display = "none";
};

socket.on(
  "blockedUsers",
  list => {

    const box =
      $("blockedList");

    box.innerHTML = "";

    if(!list || !list.length){

      box.innerHTML =
        '<div style="color:#777">No has bloqueado a nadie.</div>';

      return;
    }

    list.forEach(username => {

      const row =
        document.createElement("div");

      row.className = "blockItem";

      row.innerHTML =
        `<span>${esc(username)}</span>`;

      const button =
        document.createElement("button");

      button.className = "smallBtn";
      button.style.background = "#eee";
      button.style.color = "#333";
      button.textContent = "Desbloquear";

      button.onclick = () => {

        socket.emit(
          "unblockUser",
          username
        );
      };

      row.appendChild(button);
      box.appendChild(row);
    });
  }
);

socket.on(
  "blockUpdated",
  () => {
    socket.emit(
      "getBlockedUsers"
    );
  }
);

/* =====================================================
   PERFIL
===================================================== */

async function openProfileModal(){

  $("profileError").textContent = "";

  const token =
    localStorage.getItem("chatToken");

  try{

    const response =
      await fetch(
        "/api/profile",
        {
          headers:{
            Authorization:"Bearer " + token
          }
        }
      );

    const data =
      await response.json();

    $("profileName").value =
      data.displayName || "";

    $("profilePreview").innerHTML =
      data.profileImage
        ? `<img src="${esc(data.profileImage)}" alt="">`
        : "";

    $("profilePreview").dataset.value =
      data.profileImage || "";

    $("profileFile").value = "";

    $("profileModal").style.display =
      "flex";

  }catch{}
}

$("settingsProfile").onclick = () => {

  $("settingsModal").style.display =
    "none";

  openProfileModal();
};

$("cancelProfile").onclick = () => {
  $("profileModal").style.display = "none";
};

$("profileFile").onchange = async event => {

  const file =
    event.target.files[0];

  if(!file){
    return;
  }

  if(file.size > 4 * 1024 * 1024){

    $("profileError").textContent =
      "La foto debe pesar menos de 4 MB.";

    return;
  }

  const data =
    await resizeImage(
      file,
      256,
      256
    );

  $("profilePreview").innerHTML =
    `<img src="${data}" alt="">`;

  $("profilePreview").dataset.value =
    data;
};

async function resizeImage(
  file,
  width,
  height
){

  return new Promise(
    (resolve,reject) => {

      const image =
        new Image();

      const reader =
        new FileReader();

      reader.onload = () => {

        image.onload = () => {

          const canvas =
            document.createElement(
              "canvas"
            );

          const scale =
            Math.min(
              width / image.width,
              height / image.height
            );

          canvas.width =
            Math.max(
              1,
              Math.round(
                image.width * scale
              )
            );

          canvas.height =
            Math.max(
              1,
              Math.round(
                image.height * scale
              )
            );

          canvas.getContext("2d")
            .drawImage(
              image,
              0,
              0,
              canvas.width,
              canvas.height
            );

          resolve(
            canvas.toDataURL(
              "image/jpeg",
              .82
            )
          );
        };

        image.src =
          reader.result;
      };

      reader.onerror =
        reject;

      reader.readAsDataURL(file);
    }
  );
}

$("saveProfile").onclick = async () => {

  $("profileError").textContent = "";

  const token =
    localStorage.getItem("chatToken");

  const body = {
    displayName:
      $("profileName")
        .value
        .trim(),

    profileImage:
      $("profilePreview")
        .dataset
        .value || ""
  };

  try{

    const response =
      await fetch(
        "/api/profile",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json",
            Authorization:
              "Bearer " + token
          },

          body:
            JSON.stringify(body)
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      throw new Error(
        data.error || "Error"
      );
    }

    $("profileModal").style.display =
      "none";

    myUsername =
      data.displayName;

    showNotification(
      "Sistema",
      "Perfil actualizado."
    );

  }catch(error){

    $("profileError").textContent =
      error.message;
  }
};

/* =====================================================
   NOTIFICACIONES
===================================================== */

async function activatePushNotifications(){

  try{

    /*
      MUY IMPORTANTE:
      En Android NO usamos Web Push.

      Android recibe las notificaciones mediante
      Firebase Cloud Messaging y MainActivity.java.

      Por eso salimos antes de tocar:
      Notification.requestPermission()
      serviceWorker
      PushManager
    */

    const isAndroid =
      /Android/i.test(
        navigator.userAgent
      );

    if(isAndroid){

      showNotification(
        "Sistema",
        "Las notificaciones de Android se gestionan mediante Firebase."
      );

      return;
    }

    /*
      Solo navegadores normales.
    */

    if(
      !("Notification" in window) ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ){

      showNotification(
        "Sistema",
        "Tu navegador no admite notificaciones push."
      );

      return;
    }

    const permission =
      await Notification.requestPermission();

    if(permission !== "granted"){

      showNotification(
        "Sistema",
        "No se concedió permiso para las notificaciones."
      );

      return;
    }

    const keyResponse =
      await fetch(
        "/api/push/public-key"
      );

    if(!keyResponse.ok){

      throw new Error(
        "No se pudo obtener la configuración de notificaciones."
      );
    }

    const keyData =
      await keyResponse.json();

    if(
      !keyData.enabled ||
      !keyData.publicKey
    ){

      showNotification(
        "Sistema",
        "Las notificaciones push no están configuradas en el servidor."
      );

      return;
    }

    const registration =
      await navigator.serviceWorker.register(
        "/sw.js"
      );

    let subscription =
      await registration.pushManager.getSubscription();

    if(!subscription){

      subscription =
        await registration.pushManager.subscribe({
          userVisibleOnly:true,
          applicationServerKey:
            urlBase64ToUint8(
              keyData.publicKey
            )
        });
    }

    const token =
      localStorage.getItem(
        "chatToken"
      );

    if(!token){

      showNotification(
        "Sistema",
        "Debes iniciar sesión primero."
      );

      return;
    }

    const response =
      await fetch(
        "/api/push/subscribe",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json",

            Authorization:
              "Bearer " + token
          },

          body:
            JSON.stringify({
              subscription
            })
        }
      );

    if(!response.ok){

      throw new Error(
        "No se pudo registrar la suscripción."
      );
    }

    showNotification(
      "Sistema",
      "Notificaciones activadas."
    );

  }catch(error){

    console.error(
      "Error activando notificaciones:",
      error
    );

    showNotification(
      "Sistema",
      "No se pudieron activar las notificaciones."
    );
  }
}

function urlBase64ToUint8(
  base64
){

  const padding =
    "=".repeat(
      (
        4 -
        base64.length % 4
      ) % 4
    );

  const value =
    (
      base64 +
      padding
    )
    .replace(/-/g,"+")
    .replace(/_/g,"/");

  const raw =
    atob(value);

  return Uint8Array.from(
    [...raw].map(
      character =>
        character.charCodeAt(0)
    )
  );
}

/* =====================================================
   LOGOUT
===================================================== */

$("logoutButton").onclick = async () => {

  cleanupCall(false);

  const token =
    localStorage.getItem(
      "chatToken"
    );

  try{

    await fetch(
      "/api/logout",
      {
        method:"POST",
        headers:{
          Authorization:
            "Bearer " + token
        }
      }
    );

  }catch{}

  localStorage.removeItem(
    "chatToken"
  );

  socket.disconnect();

  location.reload();
};

$("backButton").onclick = () => {
  layout.classList.remove(
    "mobileChat"
  );
};

window.addEventListener(
  "beforeunload",
  () => cleanupCall(false)
);

/* =====================================================
   HISTORIAS
===================================================== */

const storiesBar =
  $("storiesBar");

const storyCreateModal =
  $("storyCreateModal");

const storyViewerModal =
  $("storyViewerModal");

const storyTextType =
  $("storyTextType");

const storyImageType =
  $("storyImageType");

const storyText =
  $("storyText");

const storyImageFile =
  $("storyImageFile");

const storyPreview =
  $("storyPreview");

const storyCreateError =
  $("storyCreateError");

const storyViewerContent =
  $("storyViewerContent");

const storyMeta =
  $("storyMeta");

const storyProgressFill =
  $("storyProgressFill");

const deleteStoryButton =
  $("deleteStoryButton");

let storiesList = [];
let storyMode = "text";
let selectedStoryGroup = null;
let selectedStoryIndex = 0;
let storyTimer = null;
let storyStartedAt = 0;

function storyGroupsFromFlat(list){

  const groups = {};

  for(const story of list || []){

    if(
      !story ||
      Number(story.expiresAt) <=
        Date.now()
    ){
      continue;
    }

    const key =
      norm(story.username);

    if(!groups[key]){

      groups[key] = {
        username:story.username,
        displayName:
          story.displayName ||
          story.username,
        profileImage:
          story.profileImage || "",
        stories:[]
      };
    }

    groups[key].stories.push(
      story
    );
  }

  return Object.values(
    groups
  ).sort(
    (a,b) => {

      if(
        norm(a.username) ===
        norm(myUsername)
      ){
        return -1;
      }

      if(
        norm(b.username) ===
        norm(myUsername)
      ){
        return 1;
      }

      return (
        (
          b.stories[
            b.stories.length - 1
          ]?.createdAt || 0
        ) -
        (
          a.stories[
            a.stories.length - 1
          ]?.createdAt || 0
        )
      );
    }
  );
}

function renderStories(){

  const groups =
    storyGroupsFromFlat(
      storiesList
    );

  storiesBar.innerHTML = "";

  const addButton =
    document.createElement(
      "button"
    );

  addButton.className =
    "storyItem";

  addButton.innerHTML = `
    <div class="storyRing">
      <div class="storyAvatar storyAdd">＋</div>
    </div>

    <div class="storyLabel">
      Tu historia
    </div>
  `;

  addButton.onclick =
    openStoryCreator;

  storiesBar.appendChild(
    addButton
  );

  for(const group of groups){

    if(
      norm(group.username) ===
      norm(myUsername)
    ){
      continue;
    }

    const hasUnseen =
      group.stories.some(
        story =>
          !(story.views || []).some(
            view =>
              norm(view.username) ===
              norm(myUsername)
          )
      );

    const button =
      document.createElement(
        "button"
      );

    button.className =
      "storyItem";

    button.innerHTML = `
      <div class="storyRing ${
        hasUnseen ? "" : "seen"
      }">

        <div class="storyAvatar">
          ${avatarHtml(group)}
        </div>

      </div>

      <div class="storyLabel">
        ${esc(group.displayName)}
      </div>

      <div class="storySeenLabel">
        ${
          hasUnseen
            ? "No vista"
            : "Vista"
        }
      </div>
    `;

    button.onclick =
      () =>
        openStoryViewer(
          group,
          0
        );

    storiesBar.appendChild(
      button
    );
  }

  const mine =
    groups.find(
      group =>
        norm(group.username) ===
        norm(myUsername)
    );

  if(
    mine &&
    mine.stories.length
  ){

    addButton.innerHTML = `
      <div class="storyRing">

        <div class="storyAvatar">
          ${avatarHtml(mine)}
        </div>

      </div>

      <div class="storyLabel">
        Tu historia
      </div>
    `;

    addButton.onclick =
      () =>
        openStoryViewer(
          mine,
          0
        );

    addButton.ondblclick =
      openStoryCreator;
  }
}

async function loadStories(){

  if(socket.connected){
    socket.emit(
      "getStories"
    );
  }

  try{

    const token =
      localStorage.getItem(
        "chatToken"
      );

    if(!token) return;

    const response =
      await fetch(
        "/api/stories",
        {
          headers:{
            Authorization:
              "Bearer " + token
          }
        }
      );

    if(!response.ok) return;

    const data =
      await response.json();

    storiesList =
      Array.isArray(data)
        ? data.map(
            story => ({
              ...story,
              views:
                Array.isArray(
                  story.views
                )
                  ? story.views
                  : []
            })
          )
        : [];

    renderStories();

  }catch{}
}

socket.on(
  "storiesData",
  list => {

    storiesList =
      Array.isArray(list)
        ? list
        : [];

    renderStories();
  }
);

socket.on(
  "storyCreated",
  story => {

    if(
      !Array.isArray(
        story.views
      )
    ){

      story.views = [];
    }

    if(
      !storiesList.some(
        item =>
          item.id ===
          story.id
      )
    ){

      storiesList.push(
        story
      );
    }

    renderStories();
  }
);

socket.on(
  "storyViewed",
  data => {

    const index =
      storiesList.findIndex(
        story =>
          story.id ===
          data.storyId
      );

    if(index >= 0){

      storiesList[index].views =
        Array.isArray(data.views)
          ? data.views
          : storiesList[index].views || [];

      renderStories();
    }
  }
);

socket.on(
  "storyDeleted",
  data => {

    storiesList =
      storiesList.filter(
        story =>
          story.id !==
          data.id
      );

    renderStories();

    if(selectedStoryGroup){

      selectedStoryGroup.stories =
        selectedStoryGroup.stories.filter(
          story =>
            story.id !== data.id
        );

      if(
        !selectedStoryGroup.stories.length
      ){

        closeStoryViewer();
      }
    }
  }
);

function openStoryCreator(){

  storyCreateError.textContent = "";

  storyText.value = "";
  storyImageFile.value = "";

  storyMode = "text";

  storyTextType.classList.add(
    "active"
  );

  storyImageType.classList.remove(
    "active"
  );

  storyText.classList.remove(
    "hidden"
  );

  storyImageFile.classList.add(
    "hidden"
  );

  storyPreview.style.background =
    "#075e54";

  storyPreview.innerHTML =
    "Tu historia aparecerá aquí";

  storyPreview.dataset.value = "";

  storyCreateModal.style.display =
    "flex";
}

storyTextType.onclick = () => {

  storyMode = "text";

  storyTextType.classList.add(
    "active"
  );

  storyImageType.classList.remove(
    "active"
  );

  storyText.classList.remove(
    "hidden"
  );

  storyImageFile.classList.add(
    "hidden"
  );
};

storyImageType.onclick = () => {

  storyMode = "image";

  storyImageType.classList.add(
    "active"
  );

  storyTextType.classList.remove(
    "active"
  );

  storyText.classList.add(
    "hidden"
  );

  storyImageFile.classList.remove(
    "hidden"
  );
};

storyText.oninput = () => {

  storyPreview.style.background =
    "#075e54";

  storyPreview.textContent =
    storyText.value.trim() ||
    "Tu historia aparecerá aquí";
};

storyImageFile.onchange =
  async () => {

    const file =
      storyImageFile.files[0];

    if(!file) return;

    if(
      file.size >
      5 * 1024 * 1024
    ){

      storyCreateError.textContent =
        "La foto debe pesar menos de 5 MB.";

      return;
    }

    try{

      const data =
        await resizeImage(
          file,
          1200,
          1200
        );

      storyPreview.style.background =
        "#111";

      storyPreview.innerHTML =
        `<img src="${data}" alt="">`;

      storyPreview.dataset.value =
        data;

    }catch{

      storyCreateError.textContent =
        "No se pudo procesar la foto.";
    }
  };

$("cancelStory").onclick = () => {
  storyCreateModal.style.display =
    "none";
};

$("publishStory").onclick =
  async () => {

    storyCreateError.textContent = "";

    let content = "";

    if(storyMode === "text"){

      content =
        storyText.value.trim();

    }else{

      content =
        storyPreview.dataset.value ||
        "";
    }

    if(!content){

      storyCreateError.textContent =
        storyMode === "text"
          ? "Escribe algo primero."
          : "Selecciona una foto.";

      return;
    }

    try{

      const token =
        localStorage.getItem(
          "chatToken"
        );

      const response =
        await fetch(
          "/api/stories",
          {
            method:"POST",
            headers:{
              "Content-Type":
                "application/json",
              Authorization:
                "Bearer " + token
            },
            body:JSON.stringify({
              type:storyMode,
              content
            })
          }
        );

      const data =
        await response.json();

      if(!response.ok){

        throw new Error(
          data.error ||
          "No se pudo publicar la historia."
        );
      }

      storyCreateModal.style.display =
        "none";

      storyPreview.dataset.value =
        "";

    }catch(error){

      storyCreateError.textContent =
        error.message;
    }
  };

function openStoryViewer(
  group,
  index
){

  selectedStoryGroup =
    group;

  selectedStoryIndex =
    Math.max(
      0,
      Math.min(
        index,
        group.stories.length - 1
      )
    );

  storyViewerModal.style.display =
    "flex";

  renderCurrentStory();
}

async function markStoryViewed(
  storyId
){

  try{

    const token =
      localStorage.getItem(
        "chatToken"
      );

    if(!token) return;

    await fetch(
      "/api/stories/" +
      encodeURIComponent(storyId) +
      "/view",
      {
        method:"POST",
        headers:{
          Authorization:
            "Bearer " + token
        }
      }
    );

  }catch{}
}

function renderCurrentStory(){

  if(
    !selectedStoryGroup ||
    !selectedStoryGroup.stories.length
  ){

    closeStoryViewer();
    return;
  }

  const story =
    selectedStoryGroup.stories[
      selectedStoryIndex
    ];

  storyMeta.innerHTML = `
    <div class="avatar">
      ${avatarHtml(selectedStoryGroup)}
    </div>

    <div>
      ${esc(
        selectedStoryGroup.displayName
      )}
    </div>
  `;

  if(story.type === "image"){

    storyViewerContent.innerHTML =
      `<img
        src="${esc(story.content)}"
        alt="Historia"
      >`;

  }else{

    storyViewerContent.innerHTML =
      `
        <div
          class="storyViewerText"
          style="
            background:${esc(
              story.background ||
              "#075e54"
            )};
            width:100%;
            height:100%;
            display:flex;
            align-items:center;
            justify-content:center
          "
        >
          ${esc(story.content)}
        </div>
      `;
  }

  deleteStoryButton.classList.toggle(
    "hidden",
    norm(story.username) !==
      norm(myUsername)
  );

  if(
    norm(story.username) !==
      norm(myUsername)
  ){

    markStoryViewed(
      story.id
    );
  }

  storyStartedAt =
    Date.now();

  storyProgressFill.style.width =
    "0%";

  clearInterval(storyTimer);

  storyTimer =
    setInterval(
      () => {

        const progress =
          Math.min(
            100,
            (
              (
                Date.now() -
                storyStartedAt
              ) /
              6000
            ) *
            100
          );

        storyProgressFill.style.width =
          progress + "%";

        if(progress >= 100){

          clearInterval(
            storyTimer
          );

          nextStory();
        }

      },
      50
    );
}

function nextStory(){

  if(!selectedStoryGroup){
    return;
  }

  if(
    selectedStoryIndex <
    selectedStoryGroup.stories.length - 1
  ){

    selectedStoryIndex++;

    renderCurrentStory();

  }else{

    closeStoryViewer();
  }
}

function prevStory(){

  if(!selectedStoryGroup){
    return;
  }

  if(selectedStoryIndex > 0){

    selectedStoryIndex--;

    renderCurrentStory();
  }
}

function closeStoryViewer(){

  clearInterval(storyTimer);

  storyViewerModal.style.display =
    "none";

  selectedStoryGroup = null;
}

$("storyNext").onclick =
  nextStory;

$("storyPrev").onclick =
  prevStory;

$("closeStoryViewer").onclick =
  closeStoryViewer;

deleteStoryButton.onclick =
  async () => {

    const story =
      selectedStoryGroup?.stories[
        selectedStoryIndex
      ];

    if(!story) return;

    if(
      !confirm(
        "¿Borrar esta historia?"
      )
    ){
      return;
    }

    try{

      const token =
        localStorage.getItem(
          "chatToken"
        );

      const response =
        await fetch(
          "/api/stories/" +
          encodeURIComponent(
            story.id
          ),
          {
            method:"DELETE",
            headers:{
              Authorization:
                "Bearer " + token
            }
          }
        );

      if(!response.ok){

        const data =
          await response.json();

        throw new Error(
          data.error ||
          "No se pudo borrar."
        );
      }

    }catch(error){

      showNotification(
        "Historias",
        error.message
      );
    }
  };

window.addEventListener(
  "keydown",
  event => {

    if(
      storyViewerModal.style.display !==
      "flex"
    ){
      return;
    }

    if(event.key === "ArrowRight"){
      nextStory();
    }

    if(event.key === "ArrowLeft"){
      prevStory();
    }

    if(event.key === "Escape"){
      closeStoryViewer();
    }
  }
);

/* =====================================================
   NOTIFICACIÓN NATIVA ANDROID
===================================================== */

let pendingNativeCallAction = null;

function handleNativeCallNotification(data){

  if(!data){
    return;
  }

  const username =
    norm(data.username || "");

  if(!username){
    return;
  }

  const action =
    norm(data.action || "");

  if(callState !== "idle"){
    return;
  }

  showIncomingCallFromNotification(
    username,
    data.sender || ""
  );

  // La llamada se muestra primero para que el usuario vea
  // el estado incluso si el micrófono tarda un momento en abrirse.
  if(action === "accept"){
    setTimeout(() => {
      if(callState === "incoming"){
        acceptCall();
      }
    }, 250);
  }

  if(action === "reject"){
    setTimeout(() => {
      if(callState === "incoming"){
        rejectCall();
      }
    }, 250);
  }
}

window.addEventListener(
  "nativeNotification",
  event => {

    try{

      const data =
        event.detail || {};

      const username =
        norm(data.username || "");

      const type =
        norm(data.type || "");

      if(!username){
        return;
      }

      if(type === "call"){

        // Si todavía no estamos autenticados por Socket.IO,
        // guardamos la acción y la procesamos al autenticar.
        if(!myUsername || !socket.connected){
          pendingNativeCallAction = data;
          return;
        }

        handleNativeCallNotification(data);
        return;
      }

      const contact =
        allUsers.find(
          user =>
            norm(user.username) ===
            username
        );

      if(contact){

        openChat(
          contact.username,
          contact.displayName ||
            contact.username,
          contact.online,
          contact.profileImage || ""
        );

      }else{

        socket.emit(
          "findUser",
          username
        );
      }

    }catch(error){

      console.error(
        "nativeNotification:",
        error
      );
    }
  }
);

/* =====================================================
   ARRANQUE
===================================================== */

checkSession();

