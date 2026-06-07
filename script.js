// ============================================================
//  LÍNEA DE TIEMPO — script.js
//  Firebase Auth + Firestore + Storage (base64 en Firestore)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  updateProfile,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── CONFIGURACIÓN FIREBASE ───────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAwThVn7mBns-rEtwHDZZBGc_BvpnapHe8",
  authDomain: "linea-tiempo-e06e7.firebaseapp.com",
  projectId: "linea-tiempo-e06e7",
  storageBucket: "linea-tiempo-e06e7.firebasestorage.app",
  messagingSenderId: "700427072241",
  appId: "1:700427072241:web:148b5f6778be30aa502f50"
};

const ROOT_EMAIL = "arielriquelme08@gmail.com";

const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const gProvider = new GoogleAuthProvider();

let currentUser        = null;
let isRoot             = false;
let activeTimelineId   = null;
let editingEventId     = null;
let selectedColor      = "#E8845A";
let selectedEditColor  = "#E8845A";
let pendingImageData   = null;
let confirmationResult = null;

// ─── BANDERA ANTI-DUPLICADO ───────────────────────────────
let isSavingEvent = false;

// ─── CACHÉ LOCAL ─────────────────────────────────────────
let _timelinesCache = null;
let _timelineCache  = {};

function invalidateCache(id){
  _timelinesCache = null;
  if(id) delete _timelineCache[id];
}

// ─── ZOOM STATE ───────────────────────────────────────────
let zoomLevel = 1.0;
const ZOOM_MIN  = 0.4;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.15;

// ─── HOME TIMELINE ZOOM STATE ─────────────────────────────
let homeZoomLevel = 1.0;

// ─── UTILIDADES ───────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function hexToAlpha(hex,a){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }

function toast(msg, dur=3000){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.add('hidden'), dur);
}

function shake(el){
  el.style.animation='none';
  el.offsetHeight;
  el.style.animation='shake 0.35s ease';
  setTimeout(()=>el.style.animation='',400);
}

function showModal(id){ document.getElementById(id).classList.remove('hidden'); }
function hideModal(id){ document.getElementById(id).classList.add('hidden'); }

function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>{
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  const el = document.getElementById('screen-'+name);
  el.classList.remove('hidden');
  el.classList.add('active');
}

function setAuthError(msg){
  const el = document.getElementById('auth-error');
  if(msg){ el.textContent=msg; el.classList.remove('hidden'); }
  else { el.classList.add('hidden'); }
}

// ─── ZOOM ─────────────────────────────────────────────────
function applyZoom(newZoom){
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const canvas = document.getElementById('timeline-canvas');
  if(canvas){
    canvas.style.transform = `scale(${zoomLevel})`;
    canvas.style.transformOrigin = 'top left';
  }
  const label = document.getElementById('zoom-label');
  if(label) label.textContent = Math.round(zoomLevel * 100) + '%';
}

function setupZoomControls(){
  const btnIn    = document.getElementById('btn-zoom-in');
  const btnOut   = document.getElementById('btn-zoom-out');
  const btnReset = document.getElementById('btn-zoom-reset');

  if(btnIn)    btnIn.onclick    = ()=> applyZoom(zoomLevel + ZOOM_STEP);
  if(btnOut)   btnOut.onclick   = ()=> applyZoom(zoomLevel - ZOOM_STEP);
  if(btnReset) btnReset.onclick = ()=> applyZoom(1.0);

  const wrapper = document.getElementById('timeline-scroll-wrapper');
  if(wrapper){
    wrapper.addEventListener('wheel', e => {
      if(e.ctrlKey || e.metaKey){
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        applyZoom(zoomLevel + delta);
      }
    }, { passive: false });
  }
}

// ─── DRAG TO SCROLL ───────────────────────────────────────
function setupDragScroll(){
  const wrapper = document.getElementById('timeline-scroll-wrapper');
  if(!wrapper) return;

  let isDragging = false;
  let startX, startY, scrollLeft, scrollTop;

  wrapper.addEventListener('mousedown', e => {
    if(e.target.closest('.event-card') || e.target.closest('.zoom-controls')) return;
    isDragging = true;
    startX     = e.pageX - wrapper.offsetLeft;
    startY     = e.pageY - wrapper.offsetTop;
    scrollLeft = wrapper.scrollLeft;
    scrollTop  = wrapper.scrollTop;
    wrapper.style.cursor = 'grabbing';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    if(wrapper) wrapper.style.cursor = 'grab';
  });

  wrapper.addEventListener('mousemove', e => {
    if(!isDragging) return;
    e.preventDefault();
    const x = e.pageX - wrapper.offsetLeft;
    const y = e.pageY - wrapper.offsetTop;
    wrapper.scrollLeft = scrollLeft - (x - startX);
    wrapper.scrollTop  = scrollTop  - (y - startY);
  });
}

// ─── HEADER ───────────────────────────────────────────────
function updateHeader(user){
  const userArea   = document.getElementById('user-area');
  const btnAcceder = document.getElementById('btn-acceder');
  const btnNueva   = document.getElementById('btn-nueva');

  if(user){
    userArea.classList.remove('hidden');
    btnAcceder.classList.add('hidden');
    document.getElementById('user-name').textContent = user.displayName || user.email || 'Usuario';
    const avatar = document.getElementById('user-avatar');
    if(user.photoURL){ avatar.src=user.photoURL; avatar.style.display='block'; }
    else { avatar.style.display='none'; }
    if(isRoot) btnNueva.classList.remove('hidden');
    else btnNueva.classList.add('hidden');
  } else {
    userArea.classList.add('hidden');
    btnAcceder.classList.remove('hidden');
    btnNueva.classList.add('hidden');
  }
}

// ─── FIRESTORE + CACHÉ ────────────────────────────────────
async function fetchTimelines(){
  if(_timelinesCache) return _timelinesCache;
  const q = query(collection(db,'timelines'), orderBy('creadoEn','desc'));
  const snap = await getDocs(q);
  _timelinesCache = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  return _timelinesCache;
}

async function createTimeline(data){
  const ref = await addDoc(collection(db,'timelines'),{ ...data, eventos:[], creadoEn:serverTimestamp() });
  invalidateCache();
  return ref;
}

async function updateTimeline(id, data){
  await updateDoc(doc(db,'timelines',id), data);
  if(_timelineCache[id]) _timelineCache[id] = { ..._timelineCache[id], ...data };
  if(_timelinesCache){
    const idx = _timelinesCache.findIndex(t=>t.id===id);
    if(idx>-1) _timelinesCache[idx] = { ..._timelinesCache[idx], ...data };
  }
}

async function deleteTimeline(id){
  await deleteDoc(doc(db,'timelines',id));
  invalidateCache(id);
}

async function getTimeline(id){
  if(_timelineCache[id]) return _timelineCache[id];
  const snap = await getDoc(doc(db,'timelines',id));
  if(!snap.exists()) return null;
  const data = { id:snap.id, ...snap.data() };
  _timelineCache[id] = data;
  return data;
}

// ─── ORDENAR EVENTOS POR AÑO ──────────────────────────────
function extraerAnio(fecha){
  if(!fecha) return Infinity;
  const match = fecha.match(/\d{4}/);
  return match ? parseInt(match[0]) : Infinity;
}

function ordenarEventos(eventos){
  return [...eventos].sort((a, b) => extraerAnio(a.fecha) - extraerAnio(b.fecha));
}

// ─── LÍNEA PRINCIPAL EN HOME ──────────────────────────────
const PRINCIPAL_NOMBRE = 'Principal';

async function renderHomePrincipalTimeline(timelines){
  try {
    if(!timelines) timelines = await fetchTimelines();
    const principal = timelines.find(tl =>
      tl.nombre && tl.nombre.trim().toLowerCase() === PRINCIPAL_NOMBRE.toLowerCase()
    );
    if(!principal) return;

    const titleEl = document.getElementById('home-tl-title');
    const descEl  = document.getElementById('home-tl-desc');
    if(titleEl) titleEl.textContent = principal.nombre;
    if(descEl)  descEl.textContent  = principal.desc || '';

    // Aplicar color de acento de esa línea
    const color = principal.color || '#E8845A';
    const section = document.querySelector('.home-timeline-section');
    if(section) section.style.setProperty('--home-accent', color);

    const container = document.getElementById('home-timeline-events');
    const emptyEl   = document.getElementById('home-timeline-empty');
    const lineEl    = document.getElementById('home-timeline-line');
    if(!container) return;
    container.innerHTML = '';

    const eventos = ordenarEventos(principal.eventos || []);

    if(eventos.length === 0){
      if(emptyEl) emptyEl.style.display = 'flex';
      if(lineEl)  lineEl.style.display  = 'none';
      return;
    }

    if(emptyEl) emptyEl.style.display = 'none';
    if(lineEl)  lineEl.style.display  = 'block';

    eventos.forEach((ev, i) => {
      const item = document.createElement('div');
      item.className = 'event-item';
      item.style.animationDelay = (i * 0.06) + 's';
      item.style.setProperty('--accent', color);
      item.style.setProperty('--accent-glow', hexToAlpha(color, 0.18));

      const imgHtml  = ev.imagen      ? `<img class="event-thumbnail" src="${ev.imagen}" alt=""/>` : '';
      const descHtml = ev.descripcion ? `<div class="event-descripcion">${escHtml(ev.descripcion)}</div>` : '';

      item.innerHTML = `
        <div class="event-spacer"></div>
        <div class="event-card">
          ${imgHtml}
          <div class="event-fecha">${escHtml(ev.fecha||'—')}</div>
          <div class="event-titulo">${escHtml(ev.titulo)}</div>
          ${descHtml}
        </div>
        <div class="event-connector"></div>
        <div class="event-dot"></div>
        <div class="event-connector"></div>
        <div class="event-spacer"></div>
      `;

      // Al hacer clic abre la línea de tiempo completa
      item.querySelector('.event-card').addEventListener('click', () => openTimeline(principal.id));
      container.appendChild(item);
    });

    setupHomeZoomControls();
    setupHomeDragScroll();
    applyHomeZoom(1.0);
  } catch(e){ console.error('Error cargando línea Principal:', e); }
}

function applyHomeZoom(newZoom){
  homeZoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const canvas = document.getElementById('home-timeline-canvas');
  if(canvas){
    canvas.style.transform = `scale(${homeZoomLevel})`;
    canvas.style.transformOrigin = 'top left';
  }
  const label = document.getElementById('home-zoom-label');
  if(label) label.textContent = Math.round(homeZoomLevel * 100) + '%';
}

function setupHomeZoomControls(){
  const btnIn    = document.getElementById('home-btn-zoom-in');
  const btnOut   = document.getElementById('home-btn-zoom-out');
  const btnReset = document.getElementById('home-btn-zoom-reset');

  if(btnIn)    btnIn.onclick    = ()=> applyHomeZoom(homeZoomLevel + ZOOM_STEP);
  if(btnOut)   btnOut.onclick   = ()=> applyHomeZoom(homeZoomLevel - ZOOM_STEP);
  if(btnReset) btnReset.onclick = ()=> applyHomeZoom(1.0);

  const wrapper = document.getElementById('home-timeline-scroll-wrapper');
  if(wrapper){
    wrapper.addEventListener('wheel', e => {
      if(e.ctrlKey || e.metaKey){
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        applyHomeZoom(homeZoomLevel + delta);
      }
    }, { passive: false });
  }
}

function setupHomeDragScroll(){
  const wrapper = document.getElementById('home-timeline-scroll-wrapper');
  if(!wrapper) return;

  let isDragging = false;
  let startX, startY, scrollLeft, scrollTop;

  wrapper.addEventListener('mousedown', e => {
    if(e.target.closest('.event-card')) return;
    isDragging = true;
    startX     = e.pageX - wrapper.offsetLeft;
    startY     = e.pageY - wrapper.offsetTop;
    scrollLeft = wrapper.scrollLeft;
    scrollTop  = wrapper.scrollTop;
    wrapper.style.cursor = 'grabbing';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    if(wrapper) wrapper.style.cursor = 'grab';
  });

  wrapper.addEventListener('mousemove', e => {
    if(!isDragging) return;
    e.preventDefault();
    const x = e.pageX - wrapper.offsetLeft;
    const y = e.pageY - wrapper.offsetTop;
    wrapper.scrollLeft = scrollLeft - (x - startX);
    wrapper.scrollTop  = scrollTop  - (y - startY);
  });
}

// ─── HOME ─────────────────────────────────────────────────
async function renderHome(){
  showScreen('home');
  updateHeader(currentUser);
  const grid  = document.getElementById('timelines-grid');
  const empty = document.getElementById('empty-state');
  grid.querySelectorAll('.timeline-card').forEach(c=>c.remove());
  let timelines = [];
  try { timelines = await fetchTimelines(); } catch(e){ console.error(e); }

  // Renderizar línea Principal embebida — pasamos datos ya cargados
  renderHomePrincipalTimeline(timelines);

  // Filtrar "Principal" de la grilla de cards
  const otrasTimelines = timelines.filter(tl =>
    !tl.nombre || tl.nombre.trim().toLowerCase() !== PRINCIPAL_NOMBRE.toLowerCase()
  );

  if(otrasTimelines.length===0){
    empty.style.display='block';
  } else {
    empty.style.display='none';
    otrasTimelines.forEach((tl,i)=>{
      const card = document.createElement('div');
      card.className='timeline-card';
      card.style.setProperty('--card-accent', tl.color||'#E8845A');
      card.style.animationDelay=(i*0.07)+'s';
      const count = (tl.eventos||[]).length;
      card.innerHTML=`
        <span class="card-icon">◉</span>
        <div class="card-name">${escHtml(tl.nombre)}</div>
        <div class="card-desc">${escHtml(tl.desc||'Sin descripción')}</div>
        <div class="card-meta">
          <span class="dot"></span>
          ${count===0?'Sin eventos aún':count+(count===1?' evento':' eventos')}
        </div>`;
      card.addEventListener('click',()=>openTimeline(tl.id));
      grid.appendChild(card);
    });
  }
}

// ─── AUTH ─────────────────────────────────────────────────
function showAuth(){ showScreen('auth'); setAuthError(''); }

function setupAuthTabs(){
  document.querySelectorAll('.auth-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.auth-panel').forEach(p=>{ p.classList.remove('active'); p.classList.add('hidden'); });
      tab.classList.add('active');
      const panel = document.getElementById('tab-'+tab.dataset.tab);
      panel.classList.remove('hidden');
      panel.classList.add('active');
      setAuthError('');
    });
  });
}

async function loginWithGoogle(){
  try { await signInWithPopup(auth, gProvider); }
  catch(e){ setAuthError(friendlyError(e.code)); }
}

async function loginWithEmail(){
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  if(!email||!pass){ setAuthError('Completa email y contraseña.'); return; }
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch(e){ setAuthError(friendlyError(e.code)); }
}

async function registerWithEmail(){
  const nombre = document.getElementById('reg-nombre').value.trim();
  const email  = document.getElementById('reg-email').value.trim();
  const pass   = document.getElementById('reg-password').value;
  if(!email||!pass){ setAuthError('Completa todos los campos.'); return; }
  if(pass.length<6){ setAuthError('La contraseña debe tener al menos 6 caracteres.'); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    if(nombre) await updateProfile(cred.user,{ displayName: nombre });
  } catch(e){ setAuthError(friendlyError(e.code)); }
}

async function sendPhoneSMS(){
  const phone = document.getElementById('login-phone').value.trim();
  if(!phone){ setAuthError('Ingresa tu número de teléfono con código de país (Ej: +56 9...)'); return; }
  try {
    if(!window.recaptchaVerifier){
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container',{ size:'invisible' });
    }
    confirmationResult = await signInWithPhoneNumber(auth, phone, window.recaptchaVerifier);
    document.getElementById('phone-code-wrap').classList.remove('hidden');
    document.getElementById('btn-login-phone').classList.add('hidden');
    document.getElementById('btn-verify-phone').classList.remove('hidden');
    setAuthError('');
    toast('Código enviado ✓');
  } catch(e){
    setAuthError(friendlyError(e.code));
    if(window.recaptchaVerifier){ window.recaptchaVerifier.clear(); window.recaptchaVerifier=null; }
  }
}

async function verifyPhoneCode(){
  const code = document.getElementById('login-phone-code').value.trim();
  if(!code||code.length<6){ setAuthError('Ingresa el código de 6 dígitos.'); return; }
  try { await confirmationResult.confirm(code); }
  catch(e){ setAuthError('Código incorrecto. Intenta de nuevo.'); }
}

function friendlyError(code){
  const map = {
    'auth/user-not-found':           'No existe una cuenta con ese email.',
    'auth/wrong-password':           'Contraseña incorrecta.',
    'auth/email-already-in-use':     'Ese email ya está registrado.',
    'auth/invalid-email':            'Email inválido.',
    'auth/weak-password':            'Contraseña muy débil (mínimo 6 caracteres).',
    'auth/too-many-requests':        'Demasiados intentos. Espera un momento.',
    'auth/popup-closed-by-user':     'Cerraste la ventana de Google.',
    'auth/invalid-phone-number':     'Número de teléfono inválido. Usa formato +56...',
    'auth/invalid-verification-code':'Código de verificación incorrecto.',
  };
  return map[code] || 'Ocurrió un error. Intenta de nuevo.';
}

// ─── EDITOR ───────────────────────────────────────────────
async function openTimeline(id){
  activeTimelineId = id;
  const tl = await getTimeline(id);
  if(!tl) return;

  document.documentElement.style.setProperty('--accent', tl.color||'#E8845A');
  document.documentElement.style.setProperty('--accent-glow', hexToAlpha(tl.color||'#E8845A',0.18));
  document.getElementById('editor-title').textContent = tl.nombre;
  document.getElementById('editor-desc').textContent  = tl.desc||'';

  const btnAdd    = document.getElementById('btn-add-event');
  const btnEditTl = document.getElementById('btn-edit-tl');
  if(isRoot){
    btnAdd.classList.remove('hidden');
    btnEditTl.classList.remove('hidden');
  } else {
    btnAdd.classList.add('hidden');
    btnEditTl.classList.add('hidden');
  }

  showScreen('editor');
  zoomLevel = 1.0;
  renderTimelineFromCache(tl);
  setupZoomControls();
  setupDragScroll();
  applyZoom(1.0);
}

function renderTimelineFromCache(tl){
  const container = document.getElementById('timeline-events');
  const empty     = document.getElementById('timeline-empty');
  const line      = document.getElementById('timeline-line');
  container.innerHTML = '';

  // Ordenar eventos por año antes de renderizar
  const eventos = ordenarEventos(tl.eventos || []);

  if(eventos.length === 0){
    empty.style.display = 'flex';
    line.style.display  = 'none';
  } else {
    empty.style.display = 'none';
    line.style.display  = 'block';

    eventos.forEach((ev, i) => {
      const item = document.createElement('div');
      item.className = 'event-item';
      item.style.animationDelay = (i * 0.06) + 's';

      const imgHtml  = ev.imagen      ? `<img class="event-thumbnail" src="${ev.imagen}" alt=""/>` : '';
      const descHtml = ev.descripcion ? `<div class="event-descripcion">${escHtml(ev.descripcion)}</div>` : '';

      item.innerHTML = `
        <div class="event-spacer"></div>
        <div class="event-card">
          ${imgHtml}
          <div class="event-fecha">${escHtml(ev.fecha||'—')}</div>
          <div class="event-titulo">${escHtml(ev.titulo)}</div>
          ${descHtml}
        </div>
        <div class="event-connector"></div>
        <div class="event-dot"></div>
        <div class="event-connector"></div>
        <div class="event-spacer"></div>
      `;

      item.querySelector('.event-card').addEventListener('click', () => verEventoFromCache(ev.id, tl));
      container.appendChild(item);
    });
  }
}

async function renderTimeline(){
  const tl = await getTimeline(activeTimelineId);
  if(!tl) return;
  renderTimelineFromCache(tl);
}

// ─── EDITAR LÍNEA DE TIEMPO ───────────────────────────────
function openModalEditarTimeline(){
  if(!isRoot){ toast('Solo el administrador puede editar la línea de tiempo.'); return; }
  const tl = _timelineCache[activeTimelineId];
  if(!tl) return;

  document.getElementById('edit-tl-nombre').value = tl.nombre || '';
  document.getElementById('edit-tl-desc').value   = tl.desc   || '';
  selectEditColor(tl.color || '#E8845A');
  showModal('modal-editar-tl');
  document.getElementById('edit-tl-nombre').focus();
}

async function guardarEdicionTimeline(){
  const nombre = document.getElementById('edit-tl-nombre').value.trim();
  if(!nombre){ shake(document.getElementById('edit-tl-nombre')); return; }
  const desc  = document.getElementById('edit-tl-desc').value.trim();
  const color = selectedEditColor;

  // Guardar el estado anterior por si hay que revertir
  const tl      = _timelineCache[activeTimelineId];
  const updated = { ...tl, nombre, desc, color };

  // Actualizar caché y UI de forma inmediata (optimistic update)
  _timelineCache[activeTimelineId] = updated;
  document.getElementById('editor-title').textContent = nombre;
  document.getElementById('editor-desc').textContent  = desc;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-glow', hexToAlpha(color, 0.18));

  hideModal('modal-editar-tl');
  toast('Línea de tiempo actualizada ✓');

  // Persistir en Firestore en segundo plano
  try {
    await updateTimeline(activeTimelineId, { nombre, desc, color });
  } catch(e){
    // Revertir si falla
    _timelineCache[activeTimelineId] = tl;
    document.getElementById('editor-title').textContent = tl.nombre;
    document.getElementById('editor-desc').textContent  = tl.desc || '';
    document.documentElement.style.setProperty('--accent', tl.color || '#E8845A');
    document.documentElement.style.setProperty('--accent-glow', hexToAlpha(tl.color || '#E8845A', 0.18));
    toast('Error al guardar. Intenta de nuevo.');
    console.error(e);
  }
}

function selectEditColor(color){
  selectedEditColor = color;
  document.querySelectorAll('.edit-tl-color').forEach(btn=>{
    btn.classList.toggle('selected', btn.dataset.color === color);
  });
}

// ─── MODAL NUEVO/EDITAR EVENTO ────────────────────────────
function openModalEvento(eventId=null){
  if(!isRoot){ toast('Solo el administrador puede editar eventos.'); return; }

  isSavingEvent = false;
  const btnGuardar = document.getElementById('btn-guardar-evento');
  btnGuardar.disabled = false;
  btnGuardar.textContent = 'Guardar evento';

  editingEventId   = eventId;
  pendingImageData = null;
  resetImagenUI();

  const titulo  = document.getElementById('modal-evento-titulo');
  const btnElim = document.getElementById('btn-eliminar-evento');

  if(eventId){
    const tl = _timelineCache[activeTimelineId];
    const ev = tl ? (tl.eventos||[]).find(e=>e.id===eventId) : null;
    if(ev){
      titulo.textContent = 'Editar evento';
      document.getElementById('ev-titulo').value      = ev.titulo||'';
      document.getElementById('ev-fecha').value       = ev.fecha||'';
      document.getElementById('ev-descripcion').value = ev.descripcion||'';
      if(ev.imagen){ showImagePreview(ev.imagen); pendingImageData=ev.imagen; }
      btnElim.classList.remove('hidden');
      showModal('modal-evento');
    } else {
      getTimeline(activeTimelineId).then(tl=>{
        const ev2 = (tl.eventos||[]).find(e=>e.id===eventId);
        if(!ev2) return;
        titulo.textContent = 'Editar evento';
        document.getElementById('ev-titulo').value      = ev2.titulo||'';
        document.getElementById('ev-fecha').value       = ev2.fecha||'';
        document.getElementById('ev-descripcion').value = ev2.descripcion||'';
        if(ev2.imagen){ showImagePreview(ev2.imagen); pendingImageData=ev2.imagen; }
        btnElim.classList.remove('hidden');
        showModal('modal-evento');
      });
    }
  } else {
    titulo.textContent = 'Nuevo evento';
    document.getElementById('ev-titulo').value      = '';
    document.getElementById('ev-fecha').value       = '';
    document.getElementById('ev-descripcion').value = '';
    btnElim.classList.add('hidden');
    showModal('modal-evento');
    document.getElementById('ev-titulo').focus();
  }
}

async function guardarEvento(){
  if(isSavingEvent) return;

  const tituloVal = document.getElementById('ev-titulo').value.trim();
  if(!tituloVal){ shake(document.getElementById('ev-titulo')); return; }

  isSavingEvent = true;
  const btnGuardar = document.getElementById('btn-guardar-evento');
  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando…';

  try {
    const tl      = await getTimeline(activeTimelineId);
    const eventos = [...(tl.eventos || [])];
    const fechaVal = document.getElementById('ev-fecha').value.trim();
    const descVal  = document.getElementById('ev-descripcion').value.trim();

    if(editingEventId){
      const idx = eventos.findIndex(e=>e.id===editingEventId);
      if(idx > -1){
        eventos[idx] = { ...eventos[idx], titulo:tituloVal, fecha:fechaVal, descripcion:descVal, imagen:pendingImageData||null };
      }
    } else {
      eventos.push({ id:uid(), titulo:tituloVal, fecha:fechaVal, descripcion:descVal, imagen:pendingImageData||null, creadoEn:Date.now() });
    }

    // ─── ORDENAR POR AÑO antes de guardar ────────────────
    const eventosOrdenados = ordenarEventos(eventos);

    if(_timelineCache[activeTimelineId]){
      _timelineCache[activeTimelineId] = { ..._timelineCache[activeTimelineId], eventos: eventosOrdenados };
    }

    await updateTimeline(activeTimelineId, { eventos: eventosOrdenados });

    hideModal('modal-evento');
    hideModal('modal-ver');
    toast('Guardado ✓');
    renderTimelineFromCache(_timelineCache[activeTimelineId]);
  } catch(e){
    toast('Error al guardar. Intenta de nuevo.');
    console.error(e);
    isSavingEvent = false;
    btnGuardar.disabled = false;
    btnGuardar.textContent = 'Guardar evento';
  }
}

// ─── ELIMINAR EVENTO (optimistic update) ─────────────────
async function eliminarEvento(){
  if(!editingEventId) return;
  if(!confirm('¿Eliminar este evento?')) return;

  const tl = _timelineCache[activeTimelineId];
  if(!tl) return;

  const eventos = (tl.eventos||[]).filter(e=>e.id!==editingEventId);

  _timelineCache[activeTimelineId] = { ...tl, eventos };
  hideModal('modal-evento');
  hideModal('modal-ver');
  toast('Evento eliminado');
  renderTimelineFromCache(_timelineCache[activeTimelineId]);

  try {
    await updateTimeline(activeTimelineId, { eventos });
  } catch(e) {
    _timelineCache[activeTimelineId] = tl;
    renderTimelineFromCache(tl);
    toast('Error al eliminar. Intenta de nuevo.');
    console.error(e);
  }
}

// ─── VER EVENTO ───────────────────────────────────────────
function verEventoFromCache(eventId, tl){
  const ev = (tl.eventos||[]).find(e=>e.id===eventId);
  if(!ev) return;

  document.getElementById('ver-fecha').textContent       = ev.fecha||'';
  document.getElementById('ver-titulo').textContent      = ev.titulo;
  document.getElementById('ver-descripcion').textContent = ev.descripcion||'';

  const imgEl = document.getElementById('ver-imagen');
  if(ev.imagen){ imgEl.src=ev.imagen; imgEl.classList.remove('hidden'); }
  else { imgEl.classList.add('hidden'); }

  const btnEditar = document.getElementById('btn-editar-desde-ver');
  if(isRoot) btnEditar.classList.remove('hidden');
  else btnEditar.classList.add('hidden');

  editingEventId = eventId;
  showModal('modal-ver');
}

async function verEvento(eventId){
  const tl = await getTimeline(activeTimelineId);
  verEventoFromCache(eventId, tl);
}

// ─── NUEVA TIMELINE ───────────────────────────────────────
function openModalNueva(){
  if(!isRoot){ toast('Solo el administrador puede crear líneas de tiempo.'); return; }
  document.getElementById('input-nombre').value = '';
  document.getElementById('input-desc').value   = '';
  selectColor('#E8845A');
  showModal('modal-nueva');
}

async function crearTimeline(){
  const nombre = document.getElementById('input-nombre').value.trim();
  if(!nombre){ shake(document.getElementById('input-nombre')); return; }
  const desc = document.getElementById('input-desc').value.trim();
  try {
    const ref = await createTimeline({ nombre, desc, color:selectedColor });
    hideModal('modal-nueva');
    toast('Línea de tiempo creada ✓');
    await openTimeline(ref.id);
  } catch(e){ toast('Error al crear. Intenta de nuevo.'); console.error(e); }
}

// ─── IMAGEN ───────────────────────────────────────────────
function resetImagenUI(){
  document.getElementById('img-placeholder').classList.remove('hidden');
  const prev = document.getElementById('img-preview');
  prev.classList.add('hidden'); prev.src='';
  document.getElementById('img-remove').classList.add('hidden');
  document.getElementById('ev-imagen').value='';
}

function showImagePreview(src){
  document.getElementById('img-placeholder').classList.add('hidden');
  const prev = document.getElementById('img-preview');
  prev.src=src; prev.classList.remove('hidden');
  document.getElementById('img-remove').classList.remove('hidden');
}

function handleImageFile(file){
  if(!file) return;
  if(file.size > 1.5*1024*1024){ toast('Imagen muy grande. Máximo 1.5 MB.'); return; }
  const reader = new FileReader();
  reader.onload = e => { pendingImageData=e.target.result; showImagePreview(e.target.result); };
  reader.readAsDataURL(file);
}

// ─── COLOR (modal nueva) ──────────────────────────────────
function selectColor(color){
  selectedColor = color;
  document.querySelectorAll('.color-dot:not(.edit-tl-color)').forEach(btn=>{
    btn.classList.toggle('selected', btn.dataset.color===color);
  });
}

// ─── LOGOUT ───────────────────────────────────────────────
async function logout(){
  invalidateCache();
  await signOut(auth);
  toast('Sesión cerrada');
}

// ─── OBSERVER AUTH ────────────────────────────────────────
onAuthStateChanged(auth, async user=>{
  currentUser = user;
  isRoot = !!(user && user.email && user.email.toLowerCase()===ROOT_EMAIL.toLowerCase());

  if(user){
    const screenAuth = document.getElementById('screen-auth');
    if(!screenAuth.classList.contains('hidden')){
      await renderHome();
    } else {
      updateHeader(user);
      const btnNueva = document.getElementById('btn-nueva');
      if(isRoot) btnNueva.classList.remove('hidden');
      else btnNueva.classList.add('hidden');
    }
  } else {
    updateHeader(null);
  }
});

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', ()=>{

  // Home
  document.getElementById('btn-acceder').addEventListener('click', showAuth);
  document.getElementById('btn-nueva').addEventListener('click', openModalNueva);
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Auth
  setupAuthTabs();
  document.getElementById('btn-google-login').addEventListener('click', loginWithGoogle);
  document.getElementById('btn-google-register').addEventListener('click', loginWithGoogle);
  document.getElementById('btn-login-email').addEventListener('click', loginWithEmail);
  document.getElementById('btn-register-email').addEventListener('click', registerWithEmail);
  document.getElementById('btn-login-phone').addEventListener('click', sendPhoneSMS);
  document.getElementById('btn-verify-phone').addEventListener('click', verifyPhoneCode);
  document.getElementById('btn-auth-back').addEventListener('click', renderHome);

  ['login-email','login-password'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') loginWithEmail(); });
  });
  ['reg-nombre','reg-email','reg-password'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') registerWithEmail(); });
  });

  // Modal nueva timeline
  document.getElementById('modal-close-nueva').addEventListener('click',()=>hideModal('modal-nueva'));
  document.getElementById('btn-crear-confirmar').addEventListener('click', crearTimeline);
  ['input-nombre','input-desc'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') crearTimeline(); });
  });

  // Modal editar timeline
  document.getElementById('modal-close-editar-tl').addEventListener('click',()=>hideModal('modal-editar-tl'));
  document.getElementById('btn-edit-tl').addEventListener('click', openModalEditarTimeline);
  document.getElementById('btn-editar-tl-confirmar').addEventListener('click', guardarEdicionTimeline);
  ['edit-tl-nombre','edit-tl-desc'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') guardarEdicionTimeline(); });
  });
  document.querySelectorAll('.edit-tl-color').forEach(btn=>{
    btn.addEventListener('click',()=>selectEditColor(btn.dataset.color));
  });
  document.getElementById('modal-editar-tl').addEventListener('click',function(e){ if(e.target===this) hideModal('modal-editar-tl'); });

  // Editor
  document.getElementById('btn-back').addEventListener('click', async ()=>{
    document.documentElement.style.setProperty('--accent','#E8845A');
    document.documentElement.style.setProperty('--accent-glow','rgba(232,132,90,0.18)');
    await renderHome();
  });
  document.getElementById('btn-add-event').addEventListener('click',()=>openModalEvento(null));

  // Modal evento
  document.getElementById('modal-close-evento').addEventListener('click',()=>hideModal('modal-evento'));
  document.getElementById('btn-guardar-evento').addEventListener('click', guardarEvento);
  document.getElementById('btn-eliminar-evento').addEventListener('click', eliminarEvento);

  // Imagen
  const uploadArea = document.getElementById('img-upload-area');
  uploadArea.addEventListener('click',()=>document.getElementById('ev-imagen').click());
  document.getElementById('ev-imagen').addEventListener('change',e=>handleImageFile(e.target.files[0]));
  document.getElementById('img-remove').addEventListener('click',e=>{ e.stopPropagation(); pendingImageData=null; resetImagenUI(); });
  uploadArea.addEventListener('dragover',e=>{ e.preventDefault(); uploadArea.style.borderColor='var(--accent)'; });
  uploadArea.addEventListener('dragleave',()=>{ uploadArea.style.borderColor=''; });
  uploadArea.addEventListener('drop',e=>{ e.preventDefault(); uploadArea.style.borderColor=''; const f=e.dataTransfer.files[0]; if(f&&f.type.startsWith('image/')) handleImageFile(f); });

  // Modal ver
  document.getElementById('modal-close-ver').addEventListener('click',()=>hideModal('modal-ver'));
  document.getElementById('btn-editar-desde-ver').addEventListener('click',()=>{ const id=editingEventId; hideModal('modal-ver'); openModalEvento(id); });

  // Color picker (modal nueva)
  document.querySelectorAll('.color-dot:not(.edit-tl-color)').forEach(btn=>{
    btn.addEventListener('click',()=>selectColor(btn.dataset.color));
  });
  selectColor('#E8845A');

  // Cerrar modales al hacer clic fuera
  ['modal-nueva','modal-evento','modal-ver'].forEach(id=>{
    document.getElementById(id).addEventListener('click',function(e){ if(e.target===this) hideModal(id); });
  });

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape') ['modal-nueva','modal-evento','modal-ver','modal-editar-tl'].forEach(id=>hideModal(id));
  });

  renderHome();
});