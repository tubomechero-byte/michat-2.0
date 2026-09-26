
const tokenKey='michat_admin_token';
let supabaseStorageFiles=[];
let supabaseUsageData=null;
let commandAccessRanks = new Map();
const $=id=>document.getElementById(id);
function headers(){return {'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem(tokenKey)}}
function showPanel(){ $('loginCard').classList.add('hidden'); $('panel').classList.remove('hidden'); $('logout').classList.remove('hidden'); loadGlobalAccess(); loadAll(); loadSupabaseStorage(); loadSupabaseUsage(); loadContactRequests(); loadGroups(); loadChats(); loadCommandAccess(); loadReports(); loadModeration(); loadAppeals(); loadBans(); loadStories(); loadRecordings(); startActivity(); }
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{...headers(),...(opt.headers||{})}});let d={};try{d=await r.json()}catch{} if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
async function login(){
  const msg = $('loginMsg');
  msg.className = 'msg';
  msg.textContent = 'Iniciando sesión...';
  const button = $('loginBtn');
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        username: $('loginUser').value.trim(),
        password: $('loginPass').value
      })
    });

    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (!response.ok) {
      throw new Error(data.error || ('Error del servidor (HTTP ' + response.status + ')'));
    }
    if (!data.token) {
      throw new Error('El servidor no devolvió el token de administrador.');
    }

    localStorage.setItem(tokenKey, data.token);
    showPanel();
  } catch (e) {
    console.error('Login:', e);
    msg.className = 'msg error';
    msg.textContent = e && e.message
      ? e.message
      : 'No se pudo iniciar sesión. Comprueba la conexión con el servidor.';
  } finally {
    button.disabled = false;
  }
}
let activityTimer=null;
let activityIds=new Set();
let activityCache=[];

function activityCategory(item){
  const text=String(item?.text||'').toLowerCase();
  if(/mensaje|mensaj(e|es)|envió un mensaje|envio un mensaje|escribió|escribio/.test(text)) return 'message';
  if(/registr/.test(text)) return 'register';
  if(/inició sesión|inicio de sesión|inició sesion|inicio de sesion|ha iniciado sesión|ha iniciado sesion/.test(text)) return 'login';
  if(/se ha conectado|se conectó|se conecto|conectado al servidor/.test(text)) return 'connect';
  if(/se ha desconectado|se desconectó|se desconecto|desconectado/.test(text)) return 'disconnect';
  if(/apelación|apelacion/.test(text)) return 'appeal';
  if(/reporte|reportó|reporto/.test(text)) return 'report';
  if(/baneo|baneó|baneó|desbaneo|quitó el baneo|quito el baneo|banear/.test(text)) return 'ban';
  if(/aviso de moderación|moderación|moderacion|kick|expulsó|expulso/.test(text)) return 'moderation';
  if(/ejecutó \/|ejecuto \/|consola/.test(text)) return 'command';
  if(/grabación|grabacion/.test(text)) return 'recording';
  if(/estado|historia/.test(text)) return 'story';
  if(/contraseña|contrasena|@usuario|correo|teléfono|telefono|cambió su/.test(text)) return 'account';
  return 'other';
}

function renderActivity(list){
  const terminal=$('terminal');
  if(!terminal)return;
  activityCache = Array.isArray(list) ? list : [];
  const filter=$('activityFilter')?.value || 'all';
  const filtered = filter==='all' ? activityCache : activityCache.filter(item=>activityCategory(item)===filter);
  const count=$('activityCount');
  if(count) count.textContent = `${filtered.length} registro${filtered.length===1?'':'s'}`;
  const wasInitialized = terminal.dataset.initialized === '1';
  const oldScrollTop = terminal.scrollTop;
  const oldScrollHeight = terminal.scrollHeight;
  const wasAtTop = oldScrollTop <= 8;
  if(!filtered.length){
    terminal.innerHTML=filter==='all'
      ? '<div class="terminal-line">Mi Chat Admin iniciado. Esperando actividad...</div>'
      : '<div class="terminal-line">No hay registros para este filtro.</div>';
    terminal.dataset.initialized='1';
    terminal.scrollTop=0;
    return;
  }
  terminal.innerHTML=filtered.map(item=>{
    const d=new Date(item.time);
    const time=Number.isNaN(d.getTime())?'--:--:--':d.toLocaleTimeString('es-ES');
    const label = activityCategory(item);
    return `<div class="terminal-line" data-category="${escAttr(label)}"><span class="terminal-time">[${esc(time)}]</span><span class="terminal-text">${esc(item.text)}</span></div>`;
  }).join('');
  terminal.dataset.initialized='1';
  if(!wasInitialized || wasAtTop){
    terminal.scrollTop=0;
  }else{
    const delta=terminal.scrollHeight-oldScrollHeight;
    terminal.scrollTop=Math.max(0, oldScrollTop+Math.max(0,delta));
  }
}

async function loadActivity(){
  try{
    const list=await api('/api/admin/activity');
    renderActivity(list);
    list.forEach(x=>activityIds.add(x.id));
  }catch(e){}
}

function startActivity(){
  loadActivity();
  if(activityTimer)clearInterval(activityTimer);
  activityTimer=setInterval(loadActivity,1000);
}

async function loadGroups(){
  try{
    const list=await api('/api/admin/groups');
    const el=$('adminGroups');
    if($('groupsCount')) $('groupsCount').textContent=list.length?`${list.length} grupo${list.length===1?'':'s'}`:'Sin grupos';
    $('groupsMsg').className='msg'; $('groupsMsg').textContent='';
    if(!list.length){el.innerHTML='<div class="small" style="padding:12px;color:#666">No hay grupos creados.</div>';return;}
    el.innerHTML=list.map(group=>{
      const members=(group.members||[]).map(member=>`@${esc(member.username)}`).join(', ');
      const admins=(group.admins||[]).map(member=>`@${esc(member.username)}`).join(', ');
      const created=group.createdAt?new Date(group.createdAt).toLocaleString('es-ES'):'—';
      const avatar=group.avatar?`<img src="${esc(group.avatar)}" alt="" style="width:58px;height:58px;border-radius:16px;object-fit:cover">`:'<div style="width:58px;height:58px;border-radius:16px;background:#eef2ff;display:flex;align-items:center;justify-content:center;font-size:28px">👥</div>';
      return `<div class="story-card" style="display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap"><div style="display:flex;gap:12px;align-items:flex-start;min-width:0">${avatar}<div style="min-width:0"><h3 style="margin:0 0 6px">${esc(group.name||'Grupo')}</h3><div class="small">ID: ${esc(group.id)}</div><div class="small">Creado por: <b>@${esc(group.createdBy)}</b> · ${esc(created)}</div><div class="small" style="margin-top:6px">Administradores: ${admins||'—'}</div><div class="small" style="margin-top:4px">Miembros (${(group.members||[]).length}): ${members||'—'}</div></div></div><div style="display:flex;gap:8px;align-items:center"><button class="danger" type="button" onclick="deleteAdminGroup('${escAttr(group.id)}','${escAttr(group.name||'Grupo')}')">🗑️ Borrar grupo</button></div></div>`;
    }).join('');
  }catch(e){ $('groupsMsg').className='msg error'; $('groupsMsg').textContent=e.message||'No se pudieron cargar los grupos.'; }
}
async function deleteAdminGroup(groupId,name){
  if(!confirm(`¿Seguro que quieres borrar el grupo «${name}»? Se eliminarán sus mensajes y desaparecerá para todos sus miembros.`)) return;
  try{await api('/api/admin/groups/'+encodeURIComponent(groupId),{method:'DELETE'}); $('groupsMsg').className='msg ok'; $('groupsMsg').textContent='Grupo eliminado correctamente.'; await loadGroups();}
  catch(e){$('groupsMsg').className='msg error';$('groupsMsg').textContent=e.message||'No se pudo eliminar el grupo.';}
}
$('refreshGroups').onclick=loadGroups;

async function loadContactRequests(){
  try{
    const list=await api('/api/admin/contact-requests');
    $('contactRequestsCount').textContent=list.length ? `${list.length} pendiente${list.length===1?'':'s'}` : 'Sin solicitudes pendientes';
    $('contactRequestsMsg').className='msg';
    $('contactRequestsMsg').textContent=list.length?'':'No hay solicitudes de contacto pendientes.';
    $('contactRequestsList').innerHTML=list.map(item=>`<div class="story-card"><b>📨 @${esc(item.senderUsername||'')} → @${esc(item.recipientUsername||'')}</b><div class="story-meta">${esc(item.senderDisplayName||item.senderUsername||'')} quiere añadir a ${esc(item.recipientDisplayName||item.recipientUsername||'')}</div><div class="appeal-actions"><button onclick="adminAcceptContactRequest('${escAttr(item.recipientUsername)}','${escAttr(item.senderUsername)}')">Aceptar</button><button class="danger" onclick="adminRejectContactRequest('${escAttr(item.recipientUsername)}','${escAttr(item.senderUsername)}')">Rechazar</button></div></div>`).join('');
  }catch(e){$('contactRequestsMsg').className='msg error';$('contactRequestsMsg').textContent=e.message}
}

async function adminAcceptContactRequest(recipientUsername,senderUsername){
  if(!confirm(`¿Aceptar la solicitud de @${senderUsername} para @${recipientUsername}?`))return;
  try{
    await api('/api/admin/contact-requests/accept',{method:'POST',body:JSON.stringify({recipientUsername,senderUsername})});
    $('contactRequestsMsg').className='msg ok';
    $('contactRequestsMsg').textContent=`Solicitud aceptada: @${senderUsername} y @${recipientUsername} ya son contactos.`;
    await loadContactRequests();
    await loadAll();
  }catch(e){$('contactRequestsMsg').className='msg error';$('contactRequestsMsg').textContent=e.message}
}

async function adminRejectContactRequest(recipientUsername,senderUsername){
  if(!confirm(`¿Rechazar la solicitud de @${senderUsername} para @${recipientUsername}?`))return;
  try{
    await api('/api/admin/contact-requests/reject',{method:'POST',body:JSON.stringify({recipientUsername,senderUsername})});
    $('contactRequestsMsg').className='msg ok';
    $('contactRequestsMsg').textContent=`Solicitud rechazada: @${senderUsername} → @${recipientUsername}.`;
    await loadContactRequests();
  }catch(e){$('contactRequestsMsg').className='msg error';$('contactRequestsMsg').textContent=e.message}
}

let adminChatPeopleCache = [];
let selectedAdminChatUser = '';
let selectedAdminChatPartner = '';
let selectedAdminChatList = [];

function adminAvatarLetter(name){
  const value=String(name||'?').trim();
  return esc((value[0]||'?').toUpperCase());
}
function adminFormatChatDate(value){
  if(!value) return '';
  return new Date(Number(value)).toLocaleString('es-ES');
}
function adminFormatTime(value){
  if(!value) return '';
  const date=new Date(Number(value));
  return date.toLocaleDateString('es-ES') === new Date().toLocaleDateString('es-ES')
    ? date.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})
    : date.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit'});
}
function renderChatPeople(){
  const box=$('chatPeopleList');
  if(!box)return;
  if(!adminChatPeopleCache.length){
    box.innerHTML='<div class="msg">No hay usuarios registrados.</div>';
    return;
  }
  box.innerHTML=adminChatPeopleCache.map(user=>`<button type="button" class="admin-wa-person" onclick="openAdminPerson('${escAttr(user.username)}')"><div class="admin-wa-avatar">${adminAvatarLetter(user.displayName||user.username)}</div><div class="admin-wa-person-main"><div class="admin-wa-person-name">${esc(user.displayName||user.username)}</div><div class="admin-wa-person-meta">@${esc(user.username)} · ${user.messageLogging?'✅ Registro permitido':'🔒 Registro no permitido'} · ${user.messageCount} mensaje${user.messageCount===1?'':'s'}</div></div><span>›</span></button>`).join('');
}
function renderSelectedPersonChats(){
  const box=$('selectedPersonChats');
  if(!box)return;
  if(!selectedAdminChatList.length){
    box.innerHTML='<div class="msg" style="margin:6px">Esta persona todavía no tiene conversaciones con mensajes visibles para el administrador.</div>';
    return;
  }
  box.innerHTML=selectedAdminChatList.map(chat=>`<button type="button" class="admin-wa-chat-row ${selectedAdminChatPartner===chat.username?'active':''}" onclick="openAdminConversation('${escAttr(chat.username)}')"><div class="admin-wa-avatar">${adminAvatarLetter(chat.displayName||chat.username)}</div><div class="admin-wa-chat-row-main"><div class="admin-wa-chat-row-name">${esc(chat.displayName||chat.username)}</div><div class="admin-wa-chat-row-preview">${esc(chat.lastFromDisplay?chat.lastFromDisplay+': ':'')}${esc(chat.lastPreview||'Sin texto')}</div></div><div class="admin-wa-chat-row-time">${esc(adminFormatTime(chat.lastAt))}</div></button>`).join('');
}
function renderAdminMessageBody(message){
  const text=esc(message.message||'');
  const type=String(message.type||'text').toLowerCase();
  if(message.media){
    if(type==='image') return `<img class="admin-wa-media" src="${escAttr(message.media)}" alt="Imagen">${text?`<div style="margin-top:6px">${text}</div>`:''}`;
    if(type==='video') return `<video class="admin-wa-media" controls src="${escAttr(message.media)}"></video>${text?`<div style="margin-top:6px">${text}</div>`:''}`;
    if(type==='audio') return `<audio controls style="max-width:100%" src="${escAttr(message.media)}"></audio>${text?`<div style="margin-top:6px">${text}</div>`:''}`;
    const label=message.fileName||'Archivo';
    return `<a href="${escAttr(message.media)}" target="_blank" rel="noopener" style="font-weight:700">📎 ${esc(label)}</a>${text?`<div style="margin-top:6px">${text}</div>`:''}`;
  }
  return text||'Mensaje vacío';
}
function renderAdminThread(data){
  const box=$('selectedChatMessages');
  if(!box)return;
  const me=selectedAdminChatUser;
  const messages=Array.isArray(data?.messages)?data.messages:[];
  $('selectedChatName').textContent=data?.userBDisplay || data?.userADisplay || 'Conversación';
  $('selectedChatMeta').textContent=messages.length?`${messages.length} mensaje${messages.length===1?'':'s'} visibles`:'Sin mensajes visibles';
  $('selectedChatAvatar').textContent=adminAvatarLetter(data?.userBDisplay||data?.userADisplay||'?');
  const deleteButton=$('deleteSelectedConversation');
  if(deleteButton) deleteButton.classList.toggle('admin-wa-hidden',!selectedAdminChatPartner);
  if(!messages.length){
    box.innerHTML='<div class="admin-wa-empty">No hay mensajes visibles en esta conversación.</div>';
    return;
  }
  box.innerHTML=messages.map(message=>{
    const mine=String(message.from||'').toLowerCase()===String(me||'').toLowerCase();
    const stamp=message.createdAt?new Date(Number(message.createdAt)).toLocaleString('es-ES'):String(message.time||'');
    return `<div class="admin-wa-bubble ${mine?'me':'other'}"><div>${renderAdminMessageBody(message)}</div><div class="admin-wa-bubble-meta">${esc(mine?'Tú':(message.fromDisplay||message.from||''))} · ${esc(stamp)}</div></div>`;
  }).join('');
  box.scrollTop=box.scrollHeight;
}
async function loadChats(){
  try{
    adminChatPeopleCache=await api('/api/admin/chat-people');
    renderChatPeople();
  }catch(e){
    $('chatsMsg').className='msg error';
    $('chatsMsg').textContent=e.message;
  }
}
async function openAdminPerson(username){
  try{
    selectedAdminChatUser=String(username||'').trim().toLowerCase();
    selectedAdminChatPartner='';
    const person=adminChatPeopleCache.find(item=>String(item.username).toLowerCase()===selectedAdminChatUser);
    $('selectedPersonName').textContent=person?.displayName || selectedAdminChatUser;
    $('selectedPersonMeta').textContent=person?.messageLogging ? 'Vista tipo WhatsApp · registro de mensajes permitido' : 'Vista tipo WhatsApp · esta persona no ha permitido el registro de sus mensajes';
    $('selectedChatName').textContent='Selecciona un chat';
    $('selectedChatMeta').textContent='Sus conversaciones aparecerán a la izquierda.';
    $('selectedChatAvatar').textContent=adminAvatarLetter(person?.displayName||selectedAdminChatUser);
    $('selectedChatMessages').innerHTML='<div class="admin-wa-empty">Cargando conversaciones…</div>';
    $('adminChatWorkspace').classList.remove('admin-wa-hidden');
    $('chatPeopleList').classList.add('admin-wa-mobile-hidden');
    const list=await api('/api/admin/chats/by-user/'+encodeURIComponent(selectedAdminChatUser));
    selectedAdminChatList=Array.isArray(list)?list:[];
    renderSelectedPersonChats();
    $('chatsMsg').className='msg';
    $('chatsMsg').textContent=`Mostrando las conversaciones visibles de ${person?.displayName||selectedAdminChatUser}.`;
  }catch(e){
    $('chatsMsg').className='msg error';
    $('chatsMsg').textContent=e.message;
  }
}
function closeAdminPerson(){
  selectedAdminChatUser='';
  selectedAdminChatPartner='';
  selectedAdminChatList=[];
  $('adminChatWorkspace').classList.add('admin-wa-hidden');
  $('chatPeopleList').classList.remove('admin-wa-mobile-hidden');
  $('selectedChatMessages').innerHTML='<div class="admin-wa-empty">Selecciona una conversación para ver los mensajes.</div>';
}
async function openAdminConversation(partner){
  if(!selectedAdminChatUser || !partner)return;
  try{
    selectedAdminChatPartner=String(partner).trim().toLowerCase();
    renderSelectedPersonChats();
    $('selectedChatMessages').innerHTML='<div class="admin-wa-empty">Cargando mensajes…</div>';
    const data=await api('/api/admin/chats/thread/'+encodeURIComponent(selectedAdminChatUser)+'/'+encodeURIComponent(selectedAdminChatPartner));
    renderAdminThread(data);
  }catch(e){
    $('selectedChatMessages').innerHTML=`<div class="admin-wa-empty">${esc(e.message||'No se pudo cargar la conversación.')}</div>`;
  }
}
async function deletePrivateChatAdmin(userA,userB){
  if(!confirm(`¿Eliminar todos los mensajes visibles del chat entre @${userA} y @${userB}? Esta acción no se puede deshacer.`))return;
  try{
    const result=await api(`/api/admin/chats/private/${encodeURIComponent(userA)}/${encodeURIComponent(userB)}`,{method:'DELETE'});
    $('chatsMsg').className='msg ok';
    $('chatsMsg').textContent=`Se eliminaron ${result.removed} mensaje${result.removed===1?'':'s'}.`;
    if(selectedAdminChatUser===String(userA).toLowerCase()||selectedAdminChatUser===String(userB).toLowerCase()){
      selectedAdminChatPartner='';
      await openAdminPerson(selectedAdminChatUser);
    }else{await loadChats();}
  }catch(e){
    $('chatsMsg').className='msg error';
    $('chatsMsg').textContent=e.message;
  }
}
async function deleteSelectedConversation(){
  if(!selectedAdminChatUser||!selectedAdminChatPartner)return;
  await deletePrivateChatAdmin(selectedAdminChatUser,selectedAdminChatPartner);
}
async function deleteSelectedPersonChats(){
  if(!selectedAdminChatUser)return;
  const person=adminChatPeopleCache.find(item=>String(item.username).toLowerCase()===selectedAdminChatUser);
  if(!confirm(`¿Eliminar todos los mensajes visibles de los chats privados de ${person?.displayName||selectedAdminChatUser}? Esta acción no se puede deshacer.`))return;
  try{
    const result=await api('/api/admin/chats/user/'+encodeURIComponent(selectedAdminChatUser),{method:'DELETE'});
    $('chatsMsg').className='msg ok';
    $('chatsMsg').textContent=`Se eliminaron ${result.removed} mensaje${result.removed===1?'':'s'}.`;
    await loadChats();
    await openAdminPerson(selectedAdminChatUser);
  }catch(e){
    $('chatsMsg').className='msg error';
    $('chatsMsg').textContent=e.message;
  }
}

async function loadGlobalAccess(){
  try{
    const state=await api('/api/admin/global-access');
    const status=$('globalAccessStatus');
    if(state.enabled){
      status.className='msg error';
      status.textContent=`🔒 Bloqueado para todos. Solo @${state.ownerUsername||'propietario'} puede entrar con la contraseña de acceso global.`;
      $('enableGlobalAccess').style.display='none';
      $('disableGlobalAccess').style.display='inline-block';
    }else{
      status.className='msg ok';
      status.textContent='✅ Acceso normal: los usuarios pueden entrar al chat.';
      $('enableGlobalAccess').style.display='inline-block';
      $('disableGlobalAccess').style.display='none';
    }
  }catch(e){
    $('globalAccessStatus').className='msg error';
    $('globalAccessStatus').textContent=e.message||'No se pudo consultar el estado.';
  }
}

async function enableGlobalAccess(){
  const ownerUsername=String($('globalOwnerUsername').value||'').trim();
  const password=String($('globalOwnerPassword').value||'');
  if(!ownerUsername){alert('Escribe el usuario propietario.');return;}
  if(password.length<6){alert('La contraseña debe tener al menos 6 caracteres.');return;}
  if(!confirm(`¿Bloquear el acceso al chat para TODOS excepto @${ownerUsername}?`))return;
  try{
    await api('/api/admin/global-access',{method:'PUT',body:JSON.stringify({enabled:true,ownerUsername,password})});
    $('globalOwnerPassword').value='';
    $('globalAccessMsg').className='msg ok';
    $('globalAccessMsg').textContent='🔒 Bloqueo global activado.';
    await loadGlobalAccess();
  }catch(e){
    $('globalAccessMsg').className='msg error';
    $('globalAccessMsg').textContent=e.message||'No se pudo activar el bloqueo global.';
  }
}

async function disableGlobalAccess(){
  if(!confirm('¿Desbloquear el acceso global al chat y permitir que vuelvan a entrar todos los usuarios?'))return;
  try{
    await api('/api/admin/global-access',{method:'PUT',body:JSON.stringify({enabled:false})});
    $('globalAccessMsg').className='msg ok';
    $('globalAccessMsg').textContent='🔓 Acceso global desbloqueado.';
    await loadGlobalAccess();
  }catch(e){
    $('globalAccessMsg').className='msg error';
    $('globalAccessMsg').textContent=e.message||'No se pudo desbloquear el acceso global.';
  }
}

function formatBytes(bytes){
  if(bytes===null||bytes===undefined||!Number.isFinite(Number(bytes))) return 'No disponible';
  const n=Number(bytes);
  if(n<1024) return n+' B';
  const units=['KB','MB','GB','TB','PB'];
  let value=n/1024, i=0;
  while(value>=1024 && i<units.length-1){value/=1024;i++;}
  return value.toFixed(value>=100?0:value>=10?1:2)+' '+units[i];
}

function renderStorage(storage){
  const box=$('storageSummary');
  if(!box||!storage)return;
  const total=Number(storage.total);
  const free=Number(storage.free);
  const usedByData=Number(storage.usedByData||0);
  const backend=String(storage.backend||'local');
  const backendText=backend==='supabase'
    ? 'Los datos persistentes de Mi Chat se gestionan con Supabase. Esta pantalla NO representa la cuota de Supabase; el valor local es solo lo que ocupa la carpeta data/ en el servidor.'
    : 'Los datos de Mi Chat se guardan localmente en el servidor; el tamaño mostrado corresponde a la carpeta data/.';
  box.className='msg';
  let diskHtml='<div style="margin-top:12px">';
  if(Number.isFinite(total)&&total>0&&Number.isFinite(free)){
    const used=Math.max(0,total-free);
    const percent=Math.min(100,Math.max(0,(used/total)*100));
    diskHtml=`<div class="storage-separator"></div><b>💽 Disco del servidor</b><div class="storage-details">Libre: ${formatBytes(free)} de ${formatBytes(total)} · ${formatBytes(used)} usados · ${percent.toFixed(1)}% usado</div><div class="storage-bar" aria-label="Uso del disco del servidor"><div class="storage-bar-fill" style="width:${percent.toFixed(1)}%"></div></div><div class="small">Este valor incluye todo lo que haya en el disco de Render, no solo Mi Chat.</div>`;
  }else{
    diskHtml='<div class="storage-separator"></div><div class="small">No se ha podido obtener el espacio del disco del servidor.</div>';
  }
  box.innerHTML=`<div class="storage-main"><b>📦 Mi Chat</b><div class="storage-primary">${formatBytes(usedByData)}</div><div class="storage-details">Tamaño real de los archivos locales de Mi Chat (carpeta <code>data/</code>).</div></div>${diskHtml}<div class="small" style="margin-top:12px">${backendText}</div></div>`;
}

async function loadAll(){try{const s=await api('/api/admin/stats');$('stats').innerHTML=`<div class="stat"><b>Usuarios</b><br>${s.users}</div><div class="stat"><b>Mensajes</b><br>${s.messages}</div><div class="stat"><b>Estados</b><br>${s.stories}</div><div class="stat"><b>Conectados</b><br>${s.online}</div>`;renderStorage(s.storage);const list=await api('/api/admin/users');$('users').innerHTML=list.map(u=>{const banned=Boolean(u.banActive);const status=banned?`<span class="banned">🔨 Baneado${u.banUntil?` hasta ${esc(new Date(Number(u.banUntil)).toLocaleString('es-ES'))}`:' permanentemente'}</span>`:(u.online?`<span class="online">● Online</span>`:`<span class="offline">○ Offline</span>`);const action=banned?`<button class="secondary" onclick="unbanUser('${escAttr(u.username)}')">Quitar baneo</button>`:`<button class="danger" onclick="banUser('${escAttr(u.username)}')">Banear</button>`;const messageLoggingAction=u.messageLogging?`<button class="secondary" onclick="setMessageLogging('${escAttr(u.username)}',false)">Desactivar mensajes</button>`:`<button onclick="setMessageLogging('${escAttr(u.username)}',true)">Activar mensajes</button>`;const accessBlockAction=u.accessBlocked?`<button class="secondary" onclick="setAccessBlock('${escAttr(u.username)}',false)">Desbloquear acceso</button>`:`<button class="danger" onclick="setAccessBlock('${escAttr(u.username)}',true)">Bloquear acceso</button>`;const email=u.email?`<span>${esc(u.email)}</span>`:'<span class="small">Sin correo</span>';const phone=u.phone?`<span>${esc(u.phone)}</span>`:'<span class="small">Sin teléfono</span>';return `<tr><td>${esc(u.username)}</td><td>${esc(u.displayName)}</td><td>${email}</td><td>${phone}</td><td>${status}</td><td>${u.contacts}</td><td style="text-align:center">${u.messageLogging?'<span class="ok">✅ Sí</span>':'<span class="small">❌ No</span>'}</td><td style="text-align:center">${u.accessBlocked?'<span class="banned">🔒 Bloqueado</span>':'<span class="ok">✅ Permitido</span>'}</td><td><button onclick="changeEmail('${escAttr(u.username)}','${escAttr(u.email||'')}')">Cambiar correo</button><button onclick="resetPassword('${escAttr(u.username)}')">Restablecer contraseña</button>${messageLoggingAction}${accessBlockAction}${action}<button class="danger" onclick="deleteUser('${escAttr(u.username)}')">Eliminar cuenta</button></td></tr>`}).join('');populateModerationUsers(list);}catch(e){if(e.message.includes('Sesión'))logout();else $('actionMsg').textContent=e.message}}

async function setMessageLogging(username, enabled){
  const actionText = enabled ? 'activar el registro de mensajes' : 'desactivar el registro de mensajes';
  if(!confirm(`¿Quieres ${actionText} para @${username}?`)) return;
  try{
    await api('/api/admin/message-logging/'+encodeURIComponent(username),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
    $('actionMsg').className='msg ok';
    $('actionMsg').textContent=enabled ? `Mensajes de @${username}: registro activado.` : `Mensajes de @${username}: registro desactivado.`;
    await loadAll();
  }catch(e){
    $('actionMsg').className='msg error';
    $('actionMsg').textContent=e.message||'No se pudo cambiar el registro de mensajes.';
  }
}

function populateCommandAccessUsers(list, accessList=[]){const select=$('commandAccessUser');if(!select)return;const current=select.value;commandAccessRanks=new Map((accessList||[]).map(u=>[String(u.username||'').toLowerCase(),String(u.rank||'')]));const rankMap=commandAccessRanks;select.innerHTML='<option value="">Selecciona un usuario</option>'+list.map(u=>{const rank=rankMap.get(String(u.username||'').toLowerCase());const label=rank==='moderator'?' · 🛡️ Moderador':rank==='basic'?' · 🔹 Básico':'';return `<option value="${escAttr(u.username)}">@${esc(u.username)}${label}</option>`}).join('');if([...select.options].some(o=>o.value===current))select.value=current;updateSelectedRankFromUser();}

function updateSelectedRankFromUser(){const username=$('commandAccessUser')?.value;const rankSelect=$('commandAccessRank');if(!username||!rankSelect)return;const rank=commandAccessRanks.get(String(username).toLowerCase());if(rank && [...rankSelect.options].some(o=>o.value===rank))rankSelect.value=rank;else rankSelect.value='basic';}

function renderCommandAccess(list){const box=$('commandAccessList');if(!box)return;if(!list.length){box.innerHTML='<div class="msg">No hay usuarios con rango asignado.</div>';return}box.innerHTML=list.map(item=>{const rank=item.rank==='moderator'?'moderator':'basic';const label=rank==='moderator'?'🛡️ Moderador':'🔹 Básico';return `<div class="command-access-item" data-username="${escAttr(item.username||'')}" data-rank="${rank}"><div class="command-access-user"><div class="command-access-name">@${esc(item.username||'')} <span class="small">${label}</span></div><div class="command-access-meta">${esc(item.displayName||item.username||'')} · ${item.online?'<span class="online">Online</span>':'<span class="offline">Offline</span>'}</div></div><div class="command-access-actions"><button class="secondary" onclick="changeCommandAccessRank('${escAttr(item.username)}','${rank==='moderator'?'basic':'moderator'}')">Cambiar a ${rank==='moderator'?'Básico':'Moderador'}</button><button class="danger" onclick="revokeCommandAccess('${escAttr(item.username)}')">Quitar</button></div></div>`}).join('');}

async function loadCommandAccess(){try{const [usersList, accessList]=await Promise.all([api('/api/admin/users'),api('/api/admin/command-access')]);populateCommandAccessUsers(usersList,accessList);renderCommandAccess(accessList);}catch(e){$('commandAccessMsg').className='msg error';$('commandAccessMsg').textContent=e.message}}

async function grantCommandAccess(){const username=$('commandAccessUser').value;const rank=$('commandAccessRank').value;if(!username){$('commandAccessMsg').className='msg error';$('commandAccessMsg').textContent='Selecciona un usuario.';return}try{$('grantCommandAccess').disabled=true;$('commandAccessMsg').className='msg';$('commandAccessMsg').textContent='Asignando rango...';await api('/api/admin/command-access/'+encodeURIComponent(username),{method:'PUT',body:JSON.stringify({rank})});$('commandAccessMsg').className='msg ok';$('commandAccessMsg').textContent='Rango '+(rank==='moderator'?'Moderador':'Básico')+' asignado a @'+username+'.';await loadCommandAccess();}catch(e){$('commandAccessMsg').className='msg error';$('commandAccessMsg').textContent=e.message}finally{$('grantCommandAccess').disabled=false}}

async function changeCommandAccessRank(username,rank){try{await api('/api/admin/command-access/'+encodeURIComponent(username),{method:'PUT',body:JSON.stringify({rank})});$('commandAccessMsg').className='msg ok';$('commandAccessMsg').textContent='Rango actualizado para @'+username+'.';await loadCommandAccess();}catch(e){$('commandAccessMsg').className='msg error';$('commandAccessMsg').textContent=e.message}}

async function revokeCommandAccess(username){if(!confirm('¿Quitar el acceso a la consola a @'+username+'?'))return;try{await api('/api/admin/command-access/'+encodeURIComponent(username),{method:'DELETE'});$('commandAccessMsg').className='msg ok';$('commandAccessMsg').textContent='Acceso quitado a @'+username+'.';await loadCommandAccess();}catch(e){$('commandAccessMsg').className='msg error';$('commandAccessMsg').textContent=e.message}}

async function revokeSelectedCommandAccess(){const username=$('commandAccessUser').value;if(username)await revokeCommandAccess(username);}

function populateModerationUsers(list){const select=$('moderationUser');if(!select)return;const current=select.value;select.innerHTML='<option value="">Selecciona un usuario</option><option value="*">Todos los usuarios</option>'+list.map(u=>`<option value="${escAttr(u.username)}">@${esc(u.username)} · ${esc(u.displayName)}</option>`).join('');if([...select.options].some(o=>o.value===current))select.value=current;}

async function loadModeration(){try{const list=await api('/api/admin/moderation');const box=$('moderationHistory');box.innerHTML=list.length?list.map(item=>{const date=item.createdAt?new Date(Number(item.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';const target=item.target==='*'?'Todos los usuarios':'@'+(item.target||'');return `<div class="notice-card"><div style="display:flex;align-items:flex-start;gap:10px"><div style="flex:1;min-width:0"><div class="notice-title">⚠️ ${esc(item.title||'Aviso de moderación')}</div><div class="story-meta">${esc(target)} · ${esc(date)}</div></div><button type="button" class="danger" title="Borrar este aviso" onclick="deleteModerationNotice('${escAttr(item.id)}')">🗑️ Borrar</button></div><div class="story-text">${esc(item.message||'')}</div></div>`}).join(''):'<div class="msg">No hay avisos enviados.</div>';}catch(e){$('moderationMsg').className='msg error';$('moderationMsg').textContent=e.message}}
async function deleteModerationNotice(id){if(!id)return;if(!confirm('¿Borrar este aviso de moderación?'))return;const msg=$('moderationMsg');try{msg.className='msg';msg.textContent='Borrando aviso...';await api('/api/admin/moderation/'+encodeURIComponent(id),{method:'DELETE'});msg.className='msg ok';msg.textContent='Aviso borrado correctamente.';await loadModeration();}catch(e){msg.className='msg error';msg.textContent=e.message}}

async function sendModeration(){const target=$('moderationUser').value;const title=$('moderationTitle').value.trim()||'Aviso de moderación';const message=$('moderationMessage').value.trim();const msg=$('moderationMsg');if(!target){msg.className='msg error';msg.textContent='Selecciona un destinatario.';return}if(!message){msg.className='msg error';msg.textContent='Escribe el texto del aviso.';return}try{$('sendModeration').disabled=true;msg.className='msg';msg.textContent='Enviando aviso...';const result=await api('/api/admin/moderation',{method:'POST',body:JSON.stringify({username:target,title,message})});msg.className='msg ok';msg.textContent=`Aviso enviado a ${result.recipients} usuario${result.recipients===1?'':'s'}.`;$('moderationMessage').value='';await loadModeration();}catch(e){msg.className='msg error';msg.textContent=e.message}finally{$('sendModeration').disabled=false}}

async function loadAppeals(){try{const list=await api('/api/admin/appeals');const box=$('appeals');$('appealsMsg').className='msg';$('appealsMsg').textContent=list.length?'':'No hay apelaciones.';box.innerHTML=list.map(item=>{const date=item.createdAt?new Date(Number(item.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';const status=item.status==='approved'?'approved':item.status==='rejected'?'rejected':'pending';const statusText=status==='approved'?'Aprobada':status==='rejected'?'Rechazada':'Pendiente';return `<div class="appeal-card"><div style="display:flex;align-items:flex-start;gap:10px"><div style="flex:1;min-width:0"><b>📨 Apelación de @${esc(item.username||'')}</b><div class="story-meta">${esc(item.displayName||'')} · ${esc(date)} · <strong class="appeal-${status}">${statusText}</strong></div></div><button type="button" class="danger" title="Borrar esta apelación" onclick="deleteAppeal('${escAttr(String(item.id))}')">🗑️ Borrar</button></div><div class="story-meta"><b>${esc(item.noticeTitle||'Aviso de moderación')}</b></div><div class="story-text">${esc(item.text||'')}</div><div class="appeal-actions"><button onclick="setAppealStatus('${escAttr(String(item.id))}','approved')">Aprobar</button><button class="danger" onclick="setAppealStatus('${escAttr(String(item.id))}','rejected')">Rechazar</button><button class="secondary" onclick="setAppealStatus('${escAttr(String(item.id))}','pending')">Pendiente</button></div></div>`}).join('')}catch(e){$('appealsMsg').className='msg error';$('appealsMsg').textContent=e.message}}
async function setAppealStatus(id,status){try{await api('/api/admin/appeals/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({status})});await loadAppeals()}catch(e){$('appealsMsg').className='msg error';$('appealsMsg').textContent=e.message}}
async function deleteAppeal(id){if(!id)return;if(!confirm('¿Borrar esta apelación? Esta acción no se puede deshacer.'))return;const msg=$('appealsMsg');try{msg.className='msg';msg.textContent='Borrando apelación...';await api('/api/admin/appeals/'+encodeURIComponent(id),{method:'DELETE'});msg.className='msg ok';msg.textContent='Apelación borrada correctamente.';await loadAppeals()}catch(e){msg.className='msg error';msg.textContent=e.message}}
async function loadReports(){
  try{
    const list=await api('/api/admin/reports');
    const box=$('reports');
    $('reportsMsg').className='msg';
    $('reportsMsg').textContent=list.length?'':'No hay reportes.';
    box.innerHTML=list.map(item=>{
      const date=item.createdAt?new Date(Number(item.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';
      const status=item.status==='resolved'?'resolved':'open';
      const statusText=status==='resolved'?'Resuelto':'Pendiente';
      return `<div class="story-card"><b>⚠️ ${esc(item.category||'Otro')}</b><div class="story-meta">@${esc(item.username||'')} · ${esc(item.displayName||'')} · ${esc(date)} · <strong>${statusText}</strong></div><div class="story-text" style="white-space:pre-wrap">${esc(item.text||'')}</div><button onclick="toggleReport('${escAttr(String(item.id))}','${status}')">${status==='resolved'?'Marcar pendiente':'Marcar resuelto'}</button><button class="danger" onclick="deleteReport('${escAttr(String(item.id))}')">Eliminar</button></div>`;
    }).join('');
  }catch(e){$('reportsMsg').className='msg error';$('reportsMsg').textContent=e.message}
}
async function toggleReport(id,status){
  try{await api('/api/admin/reports/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({status:status==='resolved'?'open':'resolved'})});await loadReports();await loadAll();}catch(e){$('reportsMsg').className='msg error';$('reportsMsg').textContent=e.message}
}
async function deleteReport(id){
  if(!confirm('¿Eliminar este reporte definitivamente?'))return;
  try{await api('/api/admin/reports/'+encodeURIComponent(id),{method:'DELETE'});await loadReports();await loadAll();}catch(e){$('reportsMsg').className='msg error';$('reportsMsg').textContent=e.message}
}

async function loadRecordings(){
  try{
    const list=await api('/api/admin/recordings');
    const box=$('recordings');
    $('recordingsMsg').className='msg';
    $('recordingsMsg').textContent=list.length?'':'No hay grabaciones guardadas.';
    const adminToken=localStorage.getItem(tokenKey)||'';
    box.innerHTML=list.map(item=>{
      const date=item.createdAt?new Date(Number(item.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';
      const mins=Math.floor(Number(item.duration||0)/60), secs=Number(item.duration||0)%60;
      const duration=String(mins).padStart(2,'0')+':'+String(secs).padStart(2,'0');
      const size=(Number(item.size||0)/1024/1024).toFixed(2)+' MB';
      const src='/api/admin/recordings/'+encodeURIComponent(item.id)+'?token='+encodeURIComponent(adminToken);
      return `<div class="story-card"><b>📞 ${esc(item.fromDisplay||item.from)} → ${esc(item.toDisplay||item.to)}</b><div class="story-meta">${esc(date)} · ${esc(duration)} · ${esc(size)}</div><audio controls preload="none" src="${escAttr(src)}" style="width:100%"></audio><br><button class="danger" onclick="deleteRecording('${escAttr(String(item.id))}')">Eliminar</button></div>`;
    }).join('');
  }catch(e){$('recordingsMsg').className='msg error';$('recordingsMsg').textContent=e.message}
}

async function deleteRecording(id){
  if(!confirm('¿Eliminar definitivamente esta grabación?'))return;
  try{
    await api('/api/admin/recordings/'+encodeURIComponent(id),{method:'DELETE'});
    await loadRecordings();
  }catch(e){$('recordingsMsg').className='msg error';$('recordingsMsg').textContent=e.message}
}

async function loadStories(){try{const list=await api('/api/admin/stories');const box=$('stories');$('storiesMsg').textContent=list.length?'':'No hay estados activos.';box.innerHTML=list.map(story=>{const type=String(story.type||'text').toLowerCase();const user=esc(story.username||'');const created=story.createdAt?new Date(Number(story.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';let media='';if(type==='image'){media=`<img class="story-media" src="${escAttr(story.content||'')}" alt="Estado">`}else if(type==='video'){media=`<video class="story-media" controls src="${escAttr(story.content||'')}"></video>`}else{media=`<div class="story-text">${esc(story.content||'')}</div>`}return `<div class="story-card"><b>@${user}</b><div class="story-meta">${esc(created)} · ${esc(type)}</div>${media}<button onclick="viewStory('${escAttr(String(story.id))}')">Ver</button><button class="danger" onclick="deleteStory('${escAttr(String(story.id))}')">Eliminar</button></div>`}).join('')}catch(e){$('storiesMsg').className='msg error';$('storiesMsg').textContent=e.message}}
async function viewStory(id){try{const list=await api('/api/admin/stories');const story=list.find(x=>String(x.id)===String(id));if(!story)throw new Error('Estado no encontrado.');$('storyModalTitle').textContent='Estado de @'+(story.username||'');const type=String(story.type||'text').toLowerCase();let html='';if(type==='image')html=`<img src="${escAttr(story.content||'')}" alt="Estado">`;else if(type==='video')html=`<video controls src="${escAttr(story.content||'')}"></video>`;else html=`<div class="story-text">${esc(story.content||'')}</div>`;$('storyModalContent').innerHTML=html+'<p class="small">'+esc(story.createdAt?new Date(Number(story.createdAt)).toLocaleString('es-ES'):'')+'</p>';$('storyModal').classList.remove('hidden')}catch(e){alert(e.message)}}
function closeStoryModal(){$('storyModal').classList.add('hidden');$('storyModalContent').innerHTML=''}
async function deleteStory(id){if(!confirm('¿Eliminar este estado definitivamente?'))return;try{await api('/api/admin/stories/'+encodeURIComponent(id),{method:'DELETE'});$('storiesMsg').className='msg ok';$('storiesMsg').textContent='Estado eliminado.';await loadStories();await loadAll()}catch(e){$('storiesMsg').className='msg error';$('storiesMsg').textContent=e.message}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escAttr(s){return String(s??'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")}
async function banUser(username){const duration=prompt('Duración del baneo para @'+username+'\nEjemplos: 30m, 2h, 7d, 1w\nEscribe 0 para permanente.');if(duration===null)return;if(!duration.trim()){alert('Debes indicar una duración.');return}const reason=prompt('Motivo del baneo (opcional):','Incumplimiento de las normas de la comunidad.');if(reason===null)return;if(!confirm('¿Banear a @'+username+' durante '+duration.trim()+'?'))return;try{await api('/api/admin/users/'+encodeURIComponent(username)+'/ban',{method:'POST',body:JSON.stringify({duration:duration.trim(),reason:String(reason||'').trim()})});$('actionMsg').className='ok';$('actionMsg').textContent='Baneo aplicado a @'+username+'.';await loadAll();await loadBans();}catch(e){$('actionMsg').className='error';$('actionMsg').textContent=e.message}}
async function unbanUser(username){if(!confirm('¿Quitar el baneo de @'+username+'?'))return;try{await api('/api/admin/users/'+encodeURIComponent(username)+'/unban',{method:'POST'});$('actionMsg').className='ok';$('actionMsg').textContent='Baneo retirado de @'+username+'.';await loadAll();await loadBans();}catch(e){$('actionMsg').className='error';$('actionMsg').textContent=e.message}}
async function loadBans(){try{const list=await api('/api/admin/bans');const box=$('bans');$('bansMsg').className='msg';$('bansMsg').textContent=list.length?'':'No hay baneos registrados.';box.innerHTML=list.map(item=>{const active=item.active;const created=item.createdAt?new Date(Number(item.createdAt)).toLocaleString('es-ES'):'Fecha desconocida';const expires=item.expiresAt?new Date(Number(item.expiresAt)).toLocaleString('es-ES'):'Permanente';const status=active?'<strong class="ban-active">Activo</strong>':'<strong class="ban-revoked">Finalizado</strong>';const action=(active?`<button class="secondary" onclick="unbanUser('${escAttr(item.username)}')">Quitar baneo</button> `:'')+`<button class="danger" onclick="deleteBan('${escAttr(String(item.id))}','${escAttr(item.username||'')}')">🗑️ Borrar</button>`;return `<div class="ban-card"><b>🔨 @${esc(item.username||'')}</b><div class="story-meta">${esc(item.displayName||'')} · ${esc(created)} · ${status}</div><div class="story-meta">Finaliza: ${esc(expires)}</div>${item.reason?`<div class="story-text">${esc(item.reason)}</div>`:''}${action}</div>`}).join('')}catch(e){$('bansMsg').className='msg error';$('bansMsg').textContent=e.message}}

async function deleteBan(id, username){
  if(!id)return;
  if(!confirm('¿Borrar definitivamente el registro de baneo de @'+username+'? Si el baneo sigue activo, también quedará eliminado.'))return;
  const msg=$('bansMsg');
  try{
    msg.className='msg';
    msg.textContent='Borrando baneo...';
    await api('/api/admin/bans/'+encodeURIComponent(id),{method:'DELETE'});
    msg.className='msg ok';
    msg.textContent='Baneo borrado correctamente.';
    await loadBans();
    await loadAll();
  }catch(e){
    msg.className='msg error';
    msg.textContent=e.message;
  }
}


async function setAccessBlock(username,blocked){
  let reason='';
  if(blocked){
    reason=prompt('Motivo del bloqueo de acceso para @'+username+' (opcional):','Acceso bloqueado por un administrador.');
    if(reason===null)return;
    if(!confirm('¿Bloquear el acceso a Mi Chat de @'+username+'?'))return;
  }else{
    if(!confirm('¿Desbloquear el acceso a Mi Chat de @'+username+'?'))return;
  }
  try{
    await api('/api/admin/users/'+encodeURIComponent(username)+(blocked?'/access-block':'/access-unblock'),{method:'POST',body:blocked?JSON.stringify({reason:String(reason||'').trim()}):undefined});
    $('actionMsg').className='ok';
    $('actionMsg').textContent=blocked?`Acceso al chat bloqueado para @${username}.`:`Acceso al chat desbloqueado para @${username}.`;
    await loadAll();
  }catch(e){
    $('actionMsg').className='error';
    $('actionMsg').textContent=e.message||'No se pudo cambiar el acceso al chat.';
  }
}

async function changeEmail(username,currentEmail=''){const initial=prompt('Correo electrónico de @'+username+'\nDeja vacío para quitar el correo.',currentEmail||'');if(initial===null)return;const email=initial.trim();if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){alert('El correo electrónico no es válido.');return}if(!confirm(email?`¿Cambiar el correo de @${username} a ${email}?`:`¿Quitar el correo de @${username}?`))return;try{await api('/api/admin/users/'+encodeURIComponent(username)+'/email',{method:'PUT',body:JSON.stringify({email})});$('actionMsg').className='ok';$('actionMsg').textContent=email?'Correo actualizado para @'+username+'.':'Correo eliminado de @'+username+'.';await loadAll()}catch(e){$('actionMsg').className='error';$('actionMsg').textContent=e.message}}

async function resetPassword(username){const p=prompt('Nueva contraseña para '+username+' (mínimo 6 caracteres):');if(p===null)return;if(p.length<6){alert('La contraseña debe tener al menos 6 caracteres.');return}if(!confirm('¿Restablecer la contraseña de '+username+'?'))return;try{await api('/api/admin/users/'+encodeURIComponent(username)+'/reset-password',{method:'POST',body:JSON.stringify({password:p})});$('actionMsg').className='ok';$('actionMsg').textContent='Contraseña restablecida para '+username+'.'}catch(e){$('actionMsg').className='error';$('actionMsg').textContent=e.message}}
async function deleteUser(username){if(!confirm('¿Eliminar DEFINITIVAMENTE la cuenta de '+username+'? También se eliminarán sus mensajes, estados, sesiones y tokens de notificaciones.'))return;if(!confirm('Esta acción no se puede deshacer. ¿Continuar?'))return;try{await api('/api/admin/users/'+encodeURIComponent(username),{method:'DELETE'});$('actionMsg').className='ok';$('actionMsg').textContent='Cuenta eliminada: '+username;await loadAll();await loadCommandAccess()}catch(e){$('actionMsg').className='error';$('actionMsg').textContent=e.message}}
async function clearBrowserCache(){
  if(!confirm('¿Borrar la caché de este navegador? No se eliminarán usuarios, chats ni datos del servidor.'))return;
  try{
    if(window.caches&&typeof caches.keys==='function'){
      const names=await caches.keys();
      await Promise.all(names.map(name=>caches.delete(name)));
    }
    if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){
      const regs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(reg=>reg.unregister()));
    }
    try{sessionStorage.clear()}catch{}
    $('actionMsg').className='ok';
    $('actionMsg').textContent='Caché del navegador limpiada. Recargando…';
    setTimeout(()=>location.reload(),250);
  }catch(e){
    $('actionMsg').className='error';
    $('actionMsg').textContent='No se pudo limpiar toda la caché: '+(e.message||e);
  }
}


function supabaseFileDate(value){
  if(!value)return '—';
  const time=Date.parse(value);
  return Number.isFinite(time)?new Date(time).toLocaleString('es-ES') : esc(String(value));
}


function renderSupabaseUsage(data){
  supabaseUsageData=data||null;
  const msg=$('supabaseUsageMsg');
  const cards=$('supabaseUsageCards');
  const breakdown=$('supabaseUsageBreakdown');
  const observed=$('supabaseUsageObserved');
  if(!msg||!cards||!breakdown)return;

  const dbBytes=Number(data?.database?.actualBytes);
  const diskUsed=Number(data?.database?.diskUsedBytes);
  const diskTotal=Number(data?.database?.diskTotalBytes);
  const diskFree=Number(data?.database?.diskFreeBytes);
  const appBytes=Number(data?.appData?.totalBytes||0);
  const storageBytes=Number(data?.storage?.totalBytes||0);
  const storageFiles=Number(data?.storage?.totalFiles||0);
  const dbOk=Number.isFinite(dbBytes)&&dbBytes>0;
  const diskOk=Number.isFinite(diskUsed)&&Number.isFinite(diskTotal)&&diskTotal>0;
  const errors=Array.isArray(data?.errors)?data.errors:[];

  const dbValue=dbOk?formatBytes(dbBytes):(diskOk?formatBytes(diskUsed):'No disponible');
  const dbNote=dbOk
    ? esc(data.database.sourceMetric?`Métrica: ${data.database.sourceMetric}`:'Tamaño reportado por Supabase')
    : diskOk
      ? `Disco físico de PostgreSQL: ${formatBytes(diskUsed)} usados de ${formatBytes(diskTotal)} · ${formatBytes(diskFree)} libres`
      : 'No se pudo leer el Metrics API de Supabase.';

  cards.innerHTML=`<div class="supabase-usage-card"><div class="small">🗄️ PostgreSQL</div><div class="supabase-usage-value">${dbValue}</div><div class="supabase-usage-note">${dbNote}</div></div><div class="supabase-usage-card"><div class="small">💾 Disco de PostgreSQL</div><div class="supabase-usage-value">${diskOk?formatBytes(diskUsed):'No disponible'}</div><div class="supabase-usage-note">${diskOk?`${formatBytes(diskFree)} libres de ${formatBytes(diskTotal)} totales. Incluye base de datos, WAL y sistema.`:'No disponible desde el Metrics API.'}</div></div><div class="supabase-usage-card"><div class="small">💬 Datos de Mi Chat</div><div class="supabase-usage-value">${formatBytes(appBytes)}</div><div class="supabase-usage-note">Payload de los ${Number(data?.appData?.rows||0).toLocaleString('es-ES')} registros de <code>michat_state</code>. Es un desglose lógico, no el tamaño físico de PostgreSQL.</div></div><div class="supabase-usage-card"><div class="small">📦 Supabase Storage</div><div class="supabase-usage-value">${formatBytes(storageBytes)}</div><div class="supabase-usage-note">${storageFiles.toLocaleString('es-ES')} objetos listados en los buckets.</div></div>`;

  if(dbOk){
    msg.className='supabase-usage-ok';
    msg.textContent='✅ Supabase ha devuelto el tamaño de la base de datos PostgreSQL.';
  }else if(diskOk){
    msg.className='supabase-usage-ok';
    msg.textContent='✅ Supabase ha devuelto el uso físico del disco de PostgreSQL. El tamaño exacto de tablas + índices puede ser distinto.';
  }else{
    msg.className=errors.length?'supabase-usage-warn':'msg';
    msg.textContent=errors.length?'⚠️ No se pudo consultar el Metrics API de Supabase.':'No se pudo obtener el almacenamiento de Supabase.';
  }

  if(errors.length){
    msg.textContent += ' ' + errors.join(' | ');
  }

  const items=Array.isArray(data?.appData?.items)?data.appData.items:[];
  const itemRows=items.map(item=>`<tr><td class="supabase-usage-key">${esc(item.stateKey)}</td><td>${formatBytes(Number(item.bytes||0))}</td><td>${item.updatedAt?supabaseFileDate(item.updatedAt):'—'}</td></tr>`).join('');
  const bucketRows=(data?.storage?.buckets||[]).map(bucket=>`<tr><td>🪣 ${esc(bucket.name)}</td><td>${formatBytes(Number(bucket.bytes||0))}</td><td>${Number(bucket.files||0).toLocaleString('es-ES')}${bucket.truncated?' ⚠️ listado limitado':''}</td></tr>`).join('');
  const dbDetailNote=esc(String(data?.database?.note||''));
  const diskDetail=(Number.isFinite(diskUsed)&&Number.isFinite(diskTotal))?`<div class="supabase-usage-note" style="margin-top:8px">💽 Disco físico de PostgreSQL: <b>${formatBytes(diskUsed)}</b> usados / <b>${formatBytes(diskTotal)}</b> totales · ${formatBytes(Number.isFinite(diskFree)?diskFree:0)} libres.</div>`:'';
  breakdown.innerHTML=`<div class="supabase-usage-note" style="margin-top:14px">${dbDetailNote}</div>${diskDetail}<h3 style="margin:16px 0 8px">Qué está ocupando Mi Chat</h3><div class="table-wrap"><table class="supabase-usage-table"><thead><tr><th>Datos</th><th>Tamaño del contenido</th><th>Actualizado</th></tr></thead><tbody>${itemRows||'<tr><td colspan="3">No se han podido leer los datos de <code>michat_state</code>.</td></tr>'}</tbody></table></div><h3 style="margin:16px 0 8px">Supabase Storage por bucket</h3><div class="table-wrap"><table class="supabase-usage-table"><thead><tr><th>Bucket</th><th>Tamaño de archivos</th><th>Objetos</th></tr></thead><tbody>${bucketRows||'<tr><td colspan="3">No hay objetos listados en Storage.</td></tr>'}</tbody></table></div><div class="supabase-usage-warn">ℹ️ El tamaño de la base de datos incluye datos, índices y otros componentes de PostgreSQL. Borrar filas no siempre reduce inmediatamente el tamaño físico porque PostgreSQL puede necesitar VACUUM para recuperar espacio. No se debe confundir con el almacenamiento de archivos de Storage.</div>`;
  observed.textContent=data?.observedAt?`Última lectura: ${new Date(data.observedAt).toLocaleString('es-ES')}`:'';
}

async function loadSupabaseUsage(){
  const msg=$('supabaseUsageMsg');
  if(msg){msg.className='msg';msg.textContent='Comprobando almacenamiento real de Supabase…';}
  try{
    const data=await api('/api/admin/supabase/usage');
    renderSupabaseUsage(data);
  }catch(e){
    if(msg){msg.className='supabase-usage-error';msg.textContent=e.message||'No se pudo consultar el almacenamiento real de Supabase.';}
    $('supabaseUsageCards').innerHTML='';
    $('supabaseUsageBreakdown').innerHTML='';
  }
}

function renderSupabaseStorage(data){
  supabaseStorageFiles=Array.isArray(data?.objects)?data.objects:[];
  const summary=$('supabaseStorageSummary');
  const body=$('supabaseStorageFiles');
  const msg=$('supabaseStorageMsg');
  const warning=$('supabaseStorageWarning');
  const del=$('deleteSelectedSupabaseFiles');
  const selectAll=$('supabaseStorageSelectAll');
  const headerCheck=$('supabaseStorageHeaderCheck');
  if(!summary||!body)return;

  const totalBytes=Number(data?.totalBytes||0);
  const totalFiles=Number(data?.totalFiles||0);
  const bucketCount=Array.isArray(data?.buckets)?data.buckets.length:0;
  summary.innerHTML=`<div class="supabase-storage-stat"><div class="supabase-muted">Archivos</div><b>${totalFiles.toLocaleString('es-ES')}</b></div><div class="supabase-storage-stat"><div class="supabase-muted">Tamaño listado</div><b>${formatBytes(totalBytes)}</b></div><div class="supabase-storage-stat"><div class="supabase-muted">Buckets</div><b>${bucketCount}</b></div>`;

  const bucketRows=(data?.buckets||[]).map(b=>`<div class="small">🪣 <b>${esc(b.name)}</b> · ${Number(b.files||0).toLocaleString('es-ES')} archivos · ${formatBytes(Number(b.bytes||0))}${b.truncated?' · ⚠️ listado limitado':''}</div>`).join('');
  warning.innerHTML=bucketRows?`<div style="margin-top:8px">${bucketRows}</div>`:'';
  if(data?.truncated){warning.innerHTML += '<div class="supabase-warning">⚠️ Algún bucket tiene más de 5000 objetos o demasiadas carpetas para este listado. La cifra mostrada corresponde a los objetos que se han podido listar.</div>';}
  warning.innerHTML += '<div class="supabase-danger-note">⚠️ Borrar un objeto de Supabase Storage es permanente. No borres archivos de aquí si todavía los necesita Mi Chat.</div>';

  if(!supabaseStorageFiles.length){
    const errors=Array.isArray(data?.errors)?data.errors:[];
    const buckets=Array.isArray(data?.buckets)?data.buckets:[];
    const detail=errors.length
      ? `<div style="margin-top:6px">${esc(errors.join(' | '))}</div>`
      : (buckets.length
        ? '<div style="margin-top:6px">Hay buckets, pero no hay objetos listados en ellos. En Mi Chat, las fotos y otros datos pueden estar guardados dentro de la base de datos <code>michat_state</code> en lugar de Storage.</div>'
        : '<div style="margin-top:6px">No hay buckets de Storage o no contienen objetos. Esto es independiente del almacenamiento de la base de datos de Supabase.</div>');
    body.innerHTML=`<tr><td colspan="6"><div class="supabase-empty">📦 No hay archivos de Supabase Storage para mostrar.${detail}</div></td></tr>`;
  }else{
    body.innerHTML=supabaseStorageFiles.map((file,i)=>`<tr><td><input class="supabase-file-check supabase-check" type="checkbox" data-index="${i}" style="width:auto;margin:0"></td><td><span class="supabase-bucket-badge">${esc(file.bucketName||file.bucket||'')}</span>${file.public?'<div class="supabase-muted">Público</div>':'<div class="supabase-muted">Privado</div>'}</td><td class="supabase-file-path">${esc(file.path||'')}</td><td>${formatBytes(Number(file.size||0))}<div class="supabase-muted">${esc(file.mimeType||'')}</div></td><td>${supabaseFileDate(file.updatedAt)}</td><td class="supabase-file-actions"><button class="danger" onclick="deleteSupabaseStorageFile(${i})">Borrar</button></td></tr>`).join('');
  }
  [selectAll,headerCheck].forEach(el=>{if(el)el.checked=false;});
  if(del)del.disabled=true;
  msg.className='msg ok';
  const sourceLabel=data?.source==='storage.objects'?'consultados desde storage.objects':'consultados desde Storage API';
  msg.textContent=`Supabase Storage: ${totalFiles.toLocaleString('es-ES')} archivo${totalFiles===1?'':'s'} listados (${sourceLabel}).`;
  if(Array.isArray(data?.errors)&&data.errors.length){
    msg.textContent += ' Aviso: '+data.errors.join(' | ');
  }
  updateSupabaseStorageSelection();
}

function updateSupabaseStorageSelection(){
  const checks=[...document.querySelectorAll('.supabase-file-check')];
  const selected=checks.filter(c=>c.checked).length;
  const all=checks.length>0&&selected===checks.length;
  const del=$('deleteSelectedSupabaseFiles');
  const selectAll=$('supabaseStorageSelectAll');
  const headerCheck=$('supabaseStorageHeaderCheck');
  if(del)del.disabled=selected===0;
  if(selectAll)selectAll.checked=all;
  if(headerCheck)headerCheck.checked=all;
}

function setAllSupabaseStorageSelection(checked){
  document.querySelectorAll('.supabase-file-check').forEach(el=>{el.checked=checked;});
  updateSupabaseStorageSelection();
}

async function loadSupabaseStorage(){
  const msg=$('supabaseStorageMsg');
  if(msg){msg.className='msg';msg.textContent='Cargando archivos de Supabase Storage…';}
  try{
    const data=await api('/api/admin/supabase/storage');
    renderSupabaseStorage(data);
  }catch(e){
    supabaseStorageFiles=[];
    if(msg){msg.className='msg error';msg.textContent=e.message||'No se pudo consultar Supabase Storage.';}
    $('supabaseStorageSummary').innerHTML='';
    $('supabaseStorageFiles').innerHTML='<tr><td colspan="6"><div class="supabase-empty">No se pudieron cargar los archivos. Comprueba SUPABASE_URL y SUPABASE_SECRET_KEY en Render.</div></td></tr>';
  }
}

async function deleteSupabaseStorageFile(index){
  const file=supabaseStorageFiles[index];
  if(!file)return;
  if(!confirm(`¿Borrar permanentemente este archivo?\\n\\n${file.bucket}/${file.path}\\nTamaño: ${formatBytes(Number(file.size||0))}`))return;
  await deleteSupabaseStorageObjects([{bucket:file.bucket,path:file.path}]);
}

async function deleteSelectedSupabaseStorageFiles(){
  const selected=[...document.querySelectorAll('.supabase-file-check:checked')].map(el=>supabaseStorageFiles[Number(el.dataset.index)]).filter(Boolean);
  if(!selected.length)return;
  const total=selected.reduce((sum,f)=>sum+Number(f.size||0),0);
  if(!confirm(`¿Borrar permanentemente ${selected.length} archivo${selected.length===1?'':'s'} de Supabase Storage?\\n\\nEspacio que liberarás aproximadamente: ${formatBytes(total)}\\n\\nEsta acción no se puede deshacer.`))return;
  await deleteSupabaseStorageObjects(selected.map(f=>({bucket:f.bucket,path:f.path})));
}

async function deleteSupabaseStorageObjects(objects){
  try{
    const result=await api('/api/admin/supabase/storage/objects',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({objects})});
    const msg=$('supabaseStorageMsg');
    msg.className='msg ok';
    msg.textContent=`Se eliminaron ${Number(result.removed||0)} archivo${Number(result.removed||0)===1?'':'s'} de Supabase Storage.`;
    await loadSupabaseStorage();
    await loadAll();
  }catch(e){
    const msg=$('supabaseStorageMsg');
    msg.className='msg error';
    msg.textContent=e.message||'No se pudieron eliminar los archivos.';
  }
}

async function check(){const t=localStorage.getItem(tokenKey);if(!t)return;if(t)try{await api('/api/admin/me');showPanel();startActivity()}catch{localStorage.removeItem(tokenKey)}}
$('loginBtn').onclick=login;$('latestActivity').onclick=()=>{const t=$('terminal');if(t)t.scrollTop=0};$('activityFilter').onchange=()=>renderActivity(activityCache);$('refreshCommandAccess').onclick=loadCommandAccess;$('grantCommandAccess').onclick=grantCommandAccess;$('commandAccessUser').onchange=updateSelectedRankFromUser;$('revokeCommandAccess').onclick=revokeSelectedCommandAccess;$('refresh').onclick=loadAll;$('enableGlobalAccess').onclick=enableGlobalAccess;$('disableGlobalAccess').onclick=disableGlobalAccess;$('refreshGlobalAccess').onclick=loadGlobalAccess;$('refreshChats').onclick=loadChats;$('chatBackToPeople').onclick=closeAdminPerson;$('deleteSelectedConversation').onclick=deleteSelectedConversation;$('deleteSelectedPersonChats').onclick=deleteSelectedPersonChats;$('refreshContactRequests').onclick=loadContactRequests;$('sendModeration').onclick=sendModeration;$('refreshAppeals').onclick=loadAppeals;$('refreshBans').onclick=loadBans;$('refreshReports').onclick=loadReports;$('refreshStories').onclick=loadStories;$('refreshRecordings').onclick=loadRecordings;$('clearBrowserCache').onclick=clearBrowserCache;$('refreshSupabaseStorage').onclick=loadSupabaseStorage;$('refreshSupabaseUsage').onclick=loadSupabaseUsage;$('deleteSelectedSupabaseFiles').onclick=deleteSelectedSupabaseStorageFiles;$('supabaseStorageSelectAll').onchange=e=>setAllSupabaseStorageSelection(e.target.checked);$('supabaseStorageHeaderCheck').onchange=e=>setAllSupabaseStorageSelection(e.target.checked);document.addEventListener('change',e=>{if(e.target.classList.contains('supabase-file-check'))updateSupabaseStorageSelection()});$('logout').onclick=()=>{localStorage.removeItem(tokenKey);location.reload()};$('loginPass').addEventListener('keydown',e=>{if(e.key==='Enter')login()});check();
