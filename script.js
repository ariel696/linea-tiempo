// ============================================================
//  LÍNEA DE TIEMPO — script.js
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
  setDoc,
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
  apiKey: "AIzaSyApm4Mek3Hqe8Gpf9sV31LAfuE_R_pEuxs",
  authDomain: "linea-tiempo-16fa4.firebaseapp.com",
  projectId: "linea-tiempo-16fa4",
  storageBucket: "linea-tiempo-16fa4.firebasestorage.app",
  messagingSenderId: "137078435316",
  appId: "1:137078435316:web:be4bcebecc59b3eadc9da1"
};

const ROOT_EMAIL = "arielriquelme08@gmail.com";

/*
  Configuración de Cloudinary: el servicio en la nube donde guardamos
  las fotos de los eventos, en vez de convertirlas a texto base64 y
  meterlas directo en Firestore.
  - CLOUDINARY_CLOUD_NAME: la cuenta (la misma que usas en Kokoro).
  - CLOUDINARY_UPLOAD_PRESET: la "puerta de entrada" en modo
    "Unsigned", que permite subir imágenes directo desde el navegador.
*/
const CLOUDINARY_CLOUD_NAME = "dppjzp5a2";
const CLOUDINARY_UPLOAD_PRESET = "linea-tiempo-eventos";

/*
  Sube un archivo (la foto elegida) a Cloudinary y devuelve el link
  público donde va a quedar guardada. Es "async" porque subir un
  archivo toma tiempo, y no queremos congelar la página mientras tanto.
*/
async function subirImagenCloudinary(archivo) {
  // FormData es como un "sobre" especial que puede llevar archivos,
  // no solo texto, para enviarlos por internet.
  const datosFormulario = new FormData();
  datosFormulario.append("file", archivo);
  datosFormulario.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const respuesta = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: datosFormulario }
  );

  if (!respuesta.ok) {
    throw new Error("No se pudo subir la imagen a Cloudinary");
  }

  const datos = await respuesta.json();
  // "secure_url" es el link público y permanente de la imagen ya subida.
  return datos.secure_url;
}

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
let pendingImages       = [];
let activeUploadsCount  = 0;
let eventDraftSnapshot = null;
let confirmationResult = null;
let isSavingEvent      = false;
let isCreatingTimeline = false;
let viewingProfileUid  = null;
let lastListScreen     = 'home';

// Estado de búsqueda/orden de las grillas de líneas de tiempo (inicio y perfil).
// Se mantienen por separado porque son pantallas distintas con sus propios controles.
let homeSortBy       = 'recent';
let homeSearchQuery  = '';
let _homeTimelinesRaw  = [];

let perfilSortBy      = 'recent';
let perfilSearchQuery = '';
let _perfilTimelinesRaw = [];

// Vista activa dentro del perfil/muro: 'lineas' (grilla normal) o
// 'stats' (resumen tipo "logros"). Se resetea a 'lineas' cada vez que
// se entra a un perfil distinto, para no dejar a alguien "atrapado"
// en la vista de estadísticas de otra persona.
let perfilViewMode = 'lineas';

// Imagen de fondo de la línea de tiempo (modal Nueva y modal Editar).
// Solo una imagen por línea, a diferencia de la galería de eventos.
let pendingTlImagenUrl      = null;
let pendingTlImagenSubiendo = false;
let editTlImagenUrl         = null;
let editTlImagenSubiendo    = false;

let _timelinesCache = null;
let _timelineCache  = {};
let _pendingTimelineWrites = {};
let _renderHomeSeq = 0;

// Estado del "modo selección" para borrar varias líneas de tiempo a la vez.
let modoSeleccion = false;
let idsSeleccionados = new Set();

function invalidateCache(id){
  _timelinesCache = null;
  if(id) delete _timelineCache[id];
  if(id) delete _pendingTimelineWrites[id];
}

let zoomLevel     = 1.0;
let homeZoomLevel = 1.0;
const ZOOM_MIN    = 0.4;
const ZOOM_MAX    = 2.0;
const ZOOM_STEP   = 0.15;

// ─── UTILIDADES ───────────────────────────────────────────
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
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

function friendlyFirestoreError(e){
  const code = e && e.code ? e.code : '';
  const map = {
    'permission-denied':'Firebase no permitió guardar. Revisa y despliega las reglas de Firestore.',
    'unauthenticated':'Debes iniciar sesión para guardar.',
    'unavailable':'Firebase no está disponible ahora. Intenta de nuevo.',
    'not-found':'No se encontró la base de datos o el documento.',
    'failed-precondition':'Falta crear un índice o activar Firestore en el proyecto.'
  };
  return map[code] || 'Error al crear. Intenta de nuevo.';
}

// ─── PERMISOS ─────────────────────────────────────────────
function canEdit(tl){
  if(!currentUser) return false;
  if(isRoot) return true;
  if(tl.ownerId && tl.ownerId === currentUser.uid) return true;
  return false;
}

// Una línea de tiempo "privada" solo la puede VER su dueño (o root).
// El resto de la gente ni siquiera sabe que existe: no aparece en el
// inicio, no aparece en el perfil de otra persona, y si alguien
// intenta abrirla directamente, se le niega el acceso.
function canView(tl){
  if(!tl.privada) return true;
  if(!currentUser) return false;
  if(isRoot) return true;
  return tl.ownerId === currentUser.uid;
}

// ─── HEADER ───────────────────────────────────────────────
function updateHeader(user){
  const userArea   = document.getElementById('user-area');
  const btnAcceder = document.getElementById('btn-acceder');
  const btnNueva   = document.getElementById('btn-nueva');

  if(user){
    userArea.classList.remove('hidden');
    btnAcceder.classList.add('hidden');
    btnNueva.classList.remove('hidden');
    document.getElementById('user-name').textContent = user.displayName || user.email || 'Usuario';
    const avatar = document.getElementById('user-avatar');
    if(user.photoURL){ avatar.src=user.photoURL; avatar.style.display='block'; }
    else { avatar.style.display='none'; }
  } else {
    userArea.classList.add('hidden');
    btnAcceder.classList.remove('hidden');
    btnNueva.classList.add('hidden');
  }
}

// ─── ZOOM ─────────────────────────────────────────────────
function applyZoom(newZoom){
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const canvas = document.getElementById('timeline-canvas');
  if(canvas){ canvas.style.transform=`scale(${zoomLevel})`; canvas.style.transformOrigin='top left'; }
  const label = document.getElementById('zoom-label');
  if(label) label.textContent = Math.round(zoomLevel*100)+'%';
}

function setupZoomControls(){
  const btnIn=document.getElementById('btn-zoom-in');
  const btnOut=document.getElementById('btn-zoom-out');
  const btnReset=document.getElementById('btn-zoom-reset');
  if(btnIn)    btnIn.onclick    = ()=>applyZoom(zoomLevel+ZOOM_STEP);
  if(btnOut)   btnOut.onclick   = ()=>applyZoom(zoomLevel-ZOOM_STEP);
  if(btnReset) btnReset.onclick = ()=>applyZoom(1.0);
  const wrapper=document.getElementById('timeline-scroll-wrapper');
  if(wrapper){
    wrapper.addEventListener('wheel',e=>{
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); applyZoom(zoomLevel+(e.deltaY>0?-ZOOM_STEP:ZOOM_STEP)); }
    },{passive:false});
  }
}

function setupDragScroll(){
  const wrapper=document.getElementById('timeline-scroll-wrapper');
  if(!wrapper) return;
  let isDragging=false,startX,startY,scrollLeft,scrollTop;
  wrapper.addEventListener('mousedown',e=>{
    if(e.target.closest('.event-card')||e.target.closest('.timeline-note-card')||e.target.closest('.zoom-controls')) return;
    isDragging=true; startX=e.pageX-wrapper.offsetLeft; startY=e.pageY-wrapper.offsetTop;
    scrollLeft=wrapper.scrollLeft; scrollTop=wrapper.scrollTop; wrapper.style.cursor='grabbing';
  });
  document.addEventListener('mouseup',()=>{ isDragging=false; if(wrapper) wrapper.style.cursor='grab'; });
  wrapper.addEventListener('mousemove',e=>{
    if(!isDragging) return; e.preventDefault();
    wrapper.scrollLeft=scrollLeft-(e.pageX-wrapper.offsetLeft-startX);
    wrapper.scrollTop=scrollTop-(e.pageY-wrapper.offsetTop-startY);
  });
}

function applyHomeZoom(newZoom){
  homeZoomLevel=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,newZoom));
  const canvas=document.getElementById('home-timeline-canvas');
  if(canvas){ canvas.style.transform=`scale(${homeZoomLevel})`; canvas.style.transformOrigin='top left'; }
  const label=document.getElementById('home-zoom-label');
  if(label) label.textContent=Math.round(homeZoomLevel*100)+'%';
}

function setupHomeZoomControls(){
  const btnIn=document.getElementById('home-btn-zoom-in');
  const btnOut=document.getElementById('home-btn-zoom-out');
  const btnReset=document.getElementById('home-btn-zoom-reset');
  if(btnIn)    btnIn.onclick    = ()=>applyHomeZoom(homeZoomLevel+ZOOM_STEP);
  if(btnOut)   btnOut.onclick   = ()=>applyHomeZoom(homeZoomLevel-ZOOM_STEP);
  if(btnReset) btnReset.onclick = ()=>applyHomeZoom(1.0);
  const wrapper=document.getElementById('home-timeline-scroll-wrapper');
  if(wrapper){
    wrapper.addEventListener('wheel',e=>{
      if(e.ctrlKey||e.metaKey){ e.preventDefault(); applyHomeZoom(homeZoomLevel+(e.deltaY>0?-ZOOM_STEP:ZOOM_STEP)); }
    },{passive:false});
  }
}

function setupHomeDragScroll(){
  const wrapper=document.getElementById('home-timeline-scroll-wrapper');
  if(!wrapper) return;
  let isDragging=false,startX,startY,scrollLeft,scrollTop;
  wrapper.addEventListener('mousedown',e=>{
    if(e.target.closest('.event-card')||e.target.closest('.timeline-note-card')) return;
    isDragging=true; startX=e.pageX-wrapper.offsetLeft; startY=e.pageY-wrapper.offsetTop;
    scrollLeft=wrapper.scrollLeft; scrollTop=wrapper.scrollTop; wrapper.style.cursor='grabbing';
  });
  document.addEventListener('mouseup',()=>{ isDragging=false; if(wrapper) wrapper.style.cursor='grab'; });
  wrapper.addEventListener('mousemove',e=>{
    if(!isDragging) return; e.preventDefault();
    wrapper.scrollLeft=scrollLeft-(e.pageX-wrapper.offsetLeft-startX);
    wrapper.scrollTop=scrollTop-(e.pageY-wrapper.offsetTop-startY);
  });
}

// ─── FIRESTORE ────────────────────────────────────────────
async function fetchTimelines(){
  if(_timelinesCache) return _timelinesCache;
  const q=query(collection(db,'timelines'),orderBy('creadoEn','desc'));
  const snap=await getDocs(q);
  const byId=new Map();
  snap.docs.forEach(d=>byId.set(d.id,{id:d.id,...d.data()}));
  _timelinesCache=[...byId.values()];
  return _timelinesCache;
}

function createTimeline(data){
  const ref=doc(collection(db,'timelines'));
  const writePromise=setDoc(ref,{
    ...data,
    eventos:[],
    creadoEn:serverTimestamp(),
    ownerId:currentUser.uid,
    ownerName:currentUser.displayName||currentUser.email||'Usuario',
    ownerPhotoURL:currentUser.photoURL||null
  });
  const createdTimeline = {
    id: ref.id,
    ...data,
    eventos: [],
    ownerId: currentUser.uid,
    ownerName: currentUser.displayName || currentUser.email || 'Usuario',
    ownerPhotoURL: currentUser.photoURL || null
  };
  _timelineCache[ref.id] = createdTimeline;
  _timelinesCache = [createdTimeline, ...((_timelinesCache||[]).filter(t=>t.id!==ref.id))];
  _pendingTimelineWrites[ref.id] = writePromise;
  writePromise.catch(()=>{ delete _pendingTimelineWrites[ref.id]; });
  return { ref, writePromise };
}

async function updateTimeline(id,data){
  if(_timelineCache[id]) _timelineCache[id]={..._timelineCache[id],...data};
  if(_timelinesCache){
    const idx=_timelinesCache.findIndex(t=>t.id===id);
    if(idx>-1) _timelinesCache[idx]={..._timelinesCache[idx],...data};
  }
  if(_pendingTimelineWrites[id]){
    const pending=_pendingTimelineWrites[id];
    pending.then(async()=>{
      try {
        await updateDoc(doc(db,'timelines',id),data);
      } catch(e){
        console.error(e);
      }
    }).catch(()=>{});
    return;
  }
  await updateDoc(doc(db,'timelines',id),data);
}

async function deleteTimeline(id){
  await deleteDoc(doc(db,'timelines',id));
  invalidateCache(id);
}

async function getTimeline(id){
  if(_timelineCache[id]) return _timelineCache[id];
  const snap=await getDoc(doc(db,'timelines',id));
  if(!snap.exists()) return null;
  const data={id:snap.id,...snap.data()};
  _timelineCache[id]=data;
  return data;
}

function extraerAnio(fecha){
  if(!fecha) return Infinity;
  const match=fecha.match(/\d{4}/);
  return match?parseInt(match[0]):Infinity;
}

function getYearLabel(fecha){
  const match=String(fecha||'').match(/\d{4}/);
  return match ? match[0] : '';
}
const NOTE_SCALE_MIN=0.7;
const NOTE_SCALE_MAX=2;

function clampNoteScale(size){
  const n=Number(size);
  if(!Number.isFinite(n)) return 1;
  return Math.min(NOTE_SCALE_MAX,Math.max(NOTE_SCALE_MIN,n));
}

function normalizeTimelineNotes(notes){
  return [...(notes||[])].map(note=>{
    const x=Number(note.x);
    const y=Number(note.y);
    return {
      id: note.id || uid(),
      texto: String(note.texto||'').trim(),
      color: note.color || '#5A8EE8',
      eventIds: [...new Set([...(note.eventIds||[])].filter(Boolean))],
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      size: clampNoteScale(note.size!=null?note.size:1)
    };
  }).filter(note=>note.texto || note.eventIds.length>0);
}

function findTimelineNoteForEvent(notes,eventId){
  return notes.find(note=>note.eventIds.includes(eventId)) || null;
}

function getTimelineNotesFromEditor(){
  return [...document.querySelectorAll('.timeline-note-row')].map(row=>{
    const x=Number(row.dataset.x);
    const y=Number(row.dataset.y);
    const size=Number(row.dataset.size);
    return {
      id: row.dataset.noteId || uid(),
      texto: row.querySelector('.timeline-note-text').value.trim(),
      color: row.querySelector('.timeline-note-color').value || '#5A8EE8',
      eventIds: [...row.querySelectorAll('.timeline-note-event:checked')].map(input=>input.value),
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      size: Number.isFinite(size) ? size : 1
    };
  }).filter(note=>note.texto || note.eventIds.length>0);
}

function addTimelineNoteRow(note={},eventos=[]){
  const editor=document.getElementById('timeline-notes-editor');
  if(!editor) return;
  const row=document.createElement('div');
  const noteId=note.id||uid();
  const selected=new Set(note.eventIds||[]);
  const color=note.color||'#5A8EE8';
  row.className='timeline-note-row';
  row.dataset.noteId=noteId;
  if(note.x!=null) row.dataset.x=note.x;
  if(note.y!=null) row.dataset.y=note.y;
  row.dataset.size=clampNoteScale(note.size!=null?note.size:1);
  const eventosHtml=eventos.length?eventos.map(ev=>{
    const year=getYearLabel(ev.fecha);
    return `<label class="timeline-note-event-option"><input class="timeline-note-event" type="checkbox" value="${escHtml(ev.id)}" ${selected.has(ev.id)?'checked':''}/><span>${escHtml(ev.titulo||'Sin titulo')}${year?` · ${escHtml(year)}`:''}</span></label>`;
  }).join(''):'<span class="timeline-note-empty">Agrega eventos para poder relacionarlos.</span>';
  row.innerHTML=`
    <textarea class="timeline-note-text" rows="2" placeholder="Ej: La llegada de Atari cambia la forma de entender las consolas.">${escHtml(note.texto||'')}</textarea>
    <input class="timeline-note-color" type="color" value="${escHtml(color)}" title="Color de la lectura"/>
    <button type="button" class="timeline-note-remove" title="Quitar descripcion">×</button>
    <div class="timeline-note-events">${eventosHtml}</div>`;
  row.querySelector('.timeline-note-remove').addEventListener('click',()=>row.remove());
  editor.appendChild(row);
}

function resetTimelineNotesEditor(notes=[],eventos=[]){
  const editor=document.getElementById('timeline-notes-editor');
  if(!editor) return;
  editor.innerHTML='';
  normalizeTimelineNotes(notes).forEach(note=>addTimelineNoteRow(note,eventos));
}


function normalizeRelatedTimelineIds(ids){
  return [...new Set([...(ids||[])].map(id=>String(id||'').trim()).filter(id=>id&&id!==activeTimelineId))];
}

function getRelatedTimelineIdsFromEditor(){
  return [...document.querySelectorAll('.related-timeline-check:checked')].map(input=>input.value);
}

function resetRelatedTimelinesEditor(currentId,relatedIds=[],timelines=[]){
  const editor=document.getElementById('related-timelines-editor');
  if(!editor) return;
  const selected=new Set(normalizeRelatedTimelineIds(relatedIds));
  const options=[...(timelines||[])].filter(tl=>tl.id&&tl.id!==currentId);
  if(options.length===0){
    editor.innerHTML='<span class="related-timelines-empty">Crea otra linea de tiempo para poder vincularla.</span>';
    return;
  }
  editor.innerHTML=options.map(tl=>{
    const count=(tl.eventos||[]).length;
    return `<label class="related-timeline-option">
      <input class="related-timeline-check" type="checkbox" value="${escHtml(tl.id)}" ${selected.has(tl.id)?'checked':''}/>
      <span><strong>${escHtml(tl.nombre||'Sin titulo')}</strong><small>${count} evento${count===1?'':'s'}</small></span>
    </label>`;
  }).join('');
}

async function renderRelatedTimelinesPanel(tl){
  const section=document.getElementById('related-timelines-section');
  const grid=document.getElementById('related-timelines-grid');
  if(!section||!grid) return;
  const ids=normalizeRelatedTimelineIds(tl.relatedTimelineIds||[]);
  if(ids.length===0){
    section.classList.add('hidden');
    grid.innerHTML='';
    return;
  }
  let timelines=_timelinesCache;
  try {
    if(!timelines) timelines=await fetchTimelines();
  } catch(e){
    console.error(e);
    timelines=[];
  }
  const byId=new Map([...(timelines||[]), ...Object.values(_timelineCache||{})].map(item=>[item.id,item]));
  const related=ids.map(id=>byId.get(id)).filter(Boolean);
  if(related.length===0){
    section.classList.add('hidden');
    grid.innerHTML='';
    return;
  }
  section.classList.remove('hidden');
  grid.innerHTML=related.map(item=>{
    const count=(item.eventos||[]).length;
    const desc=item.desc?`<p>${escHtml(item.desc)}</p>`:'';
    return `<button type="button" class="related-timeline-card" data-id="${escHtml(item.id)}" style="--related-color:${escHtml(item.color||'#5A8EE8')}; --related-glow:${hexToAlpha(item.color||'#5A8EE8',0.16)}">
      <span class="related-timeline-kicker">${count} evento${count===1?'':'s'}</span>
      <strong>${escHtml(item.nombre||'Sin titulo')}</strong>
    </button>`;
  }).join('');
  grid.querySelectorAll('.related-timeline-card').forEach(card=>{
    card.addEventListener('click',()=>openTimeline(card.dataset.id));
  });
}
function renderTimelineNotesPanel(tl){
  const panel=document.getElementById('timeline-notes-panel');
  if(!panel) return;
  const eventos=ordenarEventos(tl.eventos||[]);
  const byId=new Map(eventos.map(ev=>[ev.id,ev]));
  const notes=normalizeTimelineNotes(tl.lecturas||[]).filter(note=>note.texto);
  if(notes.length===0){
    panel.classList.add('hidden');
    panel.innerHTML='';
    return;
  }
  const puedeEditar=canEdit(tl);
  panel.classList.remove('hidden');
  panel.classList.toggle('timeline-notes-panel--editable',puedeEditar);
  panel.innerHTML=notes.map((note,i)=>{
    const chips=note.eventIds.map(id=>byId.get(id)).filter(Boolean).map(ev=>`<span>${escHtml(ev.titulo||'Sin titulo')}</span>`).join('');
    const x=note.x==null?i*280:note.x;
    const y=note.y==null?470:note.y;
    const size=clampNoteScale(note.size!=null?note.size:1);
    return `<article class="timeline-note-card${puedeEditar?' timeline-note-card--editable':''}" data-note-id="${escHtml(note.id)}" style="--note-color:${escHtml(note.color)}; --note-glow:${hexToAlpha(note.color,0.16)}; --note-scale:${size}; left:${x}px; top:${y}px;">
      <p>${escHtml(note.texto)}</p>
      ${chips?`<div class="timeline-note-chips">${chips}</div>`:''}
      ${puedeEditar?'<div class="timeline-note-resize-handle" title="Agrandar o achicar"></div>':''}
    </article>`;
  }).join('');
  if(puedeEditar){
    panel.querySelectorAll('.timeline-note-card').forEach(card=>{
      setupTimelineNoteDrag(card,tl);
      setupTimelineNoteResize(card,tl);
    });
  }
}


function setupTimelineNoteDrag(card,tl){
  card.addEventListener('pointerdown',e=>{
    if(e.button!==undefined && e.button!==0) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas=document.getElementById('timeline-canvas');
    if(!canvas) return;
    const noteId=card.dataset.noteId;
    const canvasRect=canvas.getBoundingClientRect();
    const cardRect=card.getBoundingClientRect();
    const offsetX=(e.clientX-cardRect.left)/zoomLevel;
    const offsetY=(e.clientY-cardRect.top)/zoomLevel;
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);

    const move=ev=>{
      ev.preventDefault();
      const x=(ev.clientX-canvasRect.left)/zoomLevel-offsetX;
      const y=(ev.clientY-canvasRect.top)/zoomLevel-offsetY;
      const maxX=Math.max(0,canvas.offsetWidth-card.offsetWidth);
      const maxY=Math.max(0,canvas.offsetHeight-card.offsetHeight);
      const nextX=Math.max(0,Math.min(maxX,Math.round(x)));
      const nextY=Math.max(0,Math.min(maxY,Math.round(y)));
      card.style.left=nextX+'px';
      card.style.top=nextY+'px';
    };

    const up=async ev=>{
      card.classList.remove('dragging');
      card.releasePointerCapture(ev.pointerId);
      card.removeEventListener('pointermove',move);
      card.removeEventListener('pointerup',up);
      card.removeEventListener('pointercancel',up);
      const x=parseInt(card.style.left,10)||0;
      const y=parseInt(card.style.top,10)||0;
      const prev=_timelineCache[tl.id]||tl;
      const lecturas=normalizeTimelineNotes(prev.lecturas||[]).map(note=>note.id===noteId?{...note,x,y}:note);
      _timelineCache[tl.id]={...prev,lecturas};
      try {
        await updateTimeline(tl.id,{lecturas});
      } catch(err){
        console.error(err);
        toast('No se pudo guardar la posición de la descripción.');
      }
    };

    card.addEventListener('pointermove',move);
    card.addEventListener('pointerup',up);
    card.addEventListener('pointercancel',up);
  });
}

function setupTimelineNoteResize(card,tl){
  const handle=card.querySelector('.timeline-note-resize-handle');
  if(!handle) return;
  handle.addEventListener('pointerdown',e=>{
    if(e.button!==undefined && e.button!==0) return;
    e.preventDefault();
    e.stopPropagation();
    const noteId=card.dataset.noteId;
    const startX=e.clientX;
    const startScale=parseFloat(getComputedStyle(card).getPropertyValue('--note-scale'))||1;
    const startWidth=card.getBoundingClientRect().width;
    card.classList.add('resizing');
    handle.setPointerCapture(e.pointerId);

    const move=ev=>{
      ev.preventDefault();
      const deltaX=(ev.clientX-startX)/zoomLevel;
      const nextScale=clampNoteScale(startScale + deltaX/startWidth);
      card.style.setProperty('--note-scale',nextScale);
    };

    const up=async ev=>{
      card.classList.remove('resizing');
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove',move);
      handle.removeEventListener('pointerup',up);
      handle.removeEventListener('pointercancel',up);
      const size=clampNoteScale(parseFloat(card.style.getPropertyValue('--note-scale'))||1);
      const prev=_timelineCache[tl.id]||tl;
      const lecturas=normalizeTimelineNotes(prev.lecturas||[]).map(note=>note.id===noteId?{...note,size}:note);
      _timelineCache[tl.id]={...prev,lecturas};
      try {
        await updateTimeline(tl.id,{lecturas});
      } catch(err){
        console.error(err);
        toast('No se pudo guardar el tamaño de la descripción.');
      }
    };

    handle.addEventListener('pointermove',move);
    handle.addEventListener('pointerup',up);
    handle.addEventListener('pointercancel',up);
  });
}
function ordenarEventos(eventos){
  return [...eventos].sort((a,b)=>extraerAnio(a.fecha)-extraerAnio(b.fecha));
}

// Devuelve el arreglo de imágenes de un evento. Compatible con eventos
// antiguos que solo tenían el campo "imagen" (una sola URL).
function getEventImages(ev){
  if(Array.isArray(ev.imagenes) && ev.imagenes.length) return ev.imagenes;
  if(ev.imagen) return [ev.imagen];
  return [];
}

function ordenarSubEventos(items){
  return [...(items||[])].sort((a,b)=>extraerAnio(a.fecha)-extraerAnio(b.fecha));
}

function getSubtimelineFromEditor(){
  return [...document.querySelectorAll('.subtimeline-row')].map(row=>({
    fecha: row.querySelector('.sub-fecha').value.trim(),
    titulo: row.querySelector('.sub-titulo').value.trim(),
    descripcion: row.querySelector('.sub-desc').value.trim()
  })).filter(item=>item.fecha||item.titulo||item.descripcion);
}

function addSubtimelineRow(item={}){
  const editor=document.getElementById('subtimeline-editor');
  const row=document.createElement('div');
  row.className='subtimeline-row';
  row.innerHTML=`
    <input class="sub-fecha" type="text" placeholder="Fecha" value="${escHtml(item.fecha||'')}"/>
    <input class="sub-titulo" type="text" placeholder="Título del hito" value="${escHtml(item.titulo||'')}"/>
    <textarea class="sub-desc" rows="2" placeholder="Detalle breve">${escHtml(item.descripcion||'')}</textarea>
    <button type="button" class="sub-remove" title="Quitar hito">×</button>`;
  row.querySelector('.sub-remove').addEventListener('click',()=>row.remove());
  editor.appendChild(row);
}

function getEventDraftSnapshot(){
  return {
    titulo: document.getElementById('ev-titulo').value.trim(),
    fecha: document.getElementById('ev-fecha').value.trim(),
    descripcion: document.getElementById('ev-descripcion').value.trim(),
    imagenes: [...pendingImages],
    subEventos: ordenarSubEventos(getSubtimelineFromEditor())
  };
}

function rememberEventDraft(){
  eventDraftSnapshot = JSON.stringify(getEventDraftSnapshot());
}

function isEventModalOpen(){
  const modal = document.getElementById('modal-evento');
  return modal && !modal.classList.contains('hidden');
}

function hasUnsavedEventDraft(){
  if(!isEventModalOpen() || eventDraftSnapshot===null) return false;
  return JSON.stringify(getEventDraftSnapshot()) !== eventDraftSnapshot;
}

function closeEventModal(force=false){
  if(!force && hasUnsavedEventDraft()){
    const salir = confirm('Tienes cambios sin guardar en este evento. ¿Salir y perder esos datos?');
    if(!salir) return false;
  }
  hideModal('modal-evento');
  eventDraftSnapshot = null;
  return true;
}
function resetSubtimelineEditor(items=[]){
  const editor=document.getElementById('subtimeline-editor');
  editor.innerHTML='';
  ordenarSubEventos(items).forEach(addSubtimelineRow);
}

function renderSubtimelineView(items){
  const wrap=document.getElementById('ver-subtimeline');
  const subEventos=ordenarSubEventos(items);
  if(subEventos.length===0){
    wrap.classList.add('hidden');
    wrap.innerHTML='';
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML=`
    <div class="ver-subtimeline-title">Referencias relacionadas</div>
    <div class="mini-timeline">
      ${subEventos.map(item=>`
        <div class="mini-timeline-item">
          <div class="mini-dot"></div>
          <div class="mini-date">${escHtml(item.fecha||'')}</div>
          <div class="mini-title">${escHtml(item.titulo||'Sin título')}</div>
          ${item.descripcion?`<div class="mini-desc">${escHtml(item.descripcion)}</div>`:''}
        </div>
      `).join('')}
    </div>`;
}

// ─── HOME ─────────────────────────────────────────────────
const PRINCIPAL_NOMBRES=['Principal-Inicio','Principal'];

function esTimelinePrincipal(tl){
  const nombre=(tl.nombre||'').trim().toLowerCase();
  return PRINCIPAL_NOMBRES.some(item=>item.toLowerCase()===nombre);
}

function getHomePrincipalTimeline(timelines){
  return PRINCIPAL_NOMBRES.map(nombre=>timelines.find(tl=>(tl.nombre||'').trim().toLowerCase()===nombre.toLowerCase())).find(Boolean);
}

async function renderHomePrincipalTimeline(timelines){
  try {
    if(!timelines) timelines=await fetchTimelines();
    const principal=getHomePrincipalTimeline(timelines);

    const titleEl=document.getElementById('home-tl-title');
    const descEl=document.getElementById('home-tl-desc');
    const editBtn=document.getElementById('btn-edit-home-principal');
    const container=document.getElementById('home-timeline-events');
    const emptyEl=document.getElementById('home-timeline-empty');
    const lineEl=document.getElementById('home-timeline-line');
    if(!container) return;
    container.innerHTML='';

    if(!principal){
      if(titleEl) titleEl.textContent='Principal-Inicio';
      if(descEl) descEl.textContent='Crea una línea llamada Principal-Inicio para destacarla aquí.';
      if(emptyEl) emptyEl.style.display='flex';
      if(lineEl)  lineEl.style.display='none';
      if(editBtn) editBtn.classList.add('hidden');
      if(emptyEl) emptyEl.onclick=null;
      return;
    }

    if(titleEl) titleEl.textContent=principal.nombre;
    if(descEl)  descEl.textContent=principal.desc||'';
    if(editBtn){
      editBtn.classList.toggle('hidden',!isRoot);
      editBtn.onclick=()=>openTimeline(principal.id);
    }

    const color=principal.color||'#E8845A';
    const section=document.querySelector('.home-timeline-section');
    if(section) section.style.setProperty('--home-accent',color);

    const eventos=ordenarEventos(principal.eventos||[]);

    if(eventos.length===0){
      if(emptyEl) emptyEl.style.display='flex';
      if(lineEl)  lineEl.style.display='none';
      if(emptyEl) emptyEl.onclick=()=>openTimeline(principal.id);
      return;
    }

    if(emptyEl) emptyEl.style.display='none';
    if(lineEl)  lineEl.style.display='block';

    eventos.forEach((ev,i)=>{
      const item=document.createElement('div');
      item.className='event-item';
      item.style.animationDelay=(i*0.06)+'s';
      item.style.setProperty('--accent',color);
      item.style.setProperty('--accent-glow',hexToAlpha(color,0.18));
      const evThumb=getEventImages(ev)[0];
      const imgHtml=evThumb?`<img class="event-thumbnail" src="${evThumb}" alt=""/>`:'';
      const descHtml=ev.descripcion?`<div class="event-descripcion">${escHtml(ev.descripcion)}</div>`:'';
      const yearHtml=getYearLabel(ev.fecha)?`<div class="event-year">${getYearLabel(ev.fecha)}</div>`:'';
      item.innerHTML=`
        <div class="event-spacer"></div>
        ${yearHtml}
        <div class="event-card">
          ${imgHtml}
          <div class="event-titulo">${escHtml(ev.titulo)}</div>
          ${descHtml}
        </div>
        <div class="event-connector"></div>
        <div class="event-dot"></div>
        <div class="event-connector"></div>
        <div class="event-spacer"></div>`;
      item.querySelector('.event-card').addEventListener('click',()=>openTimeline(principal.id));
      container.appendChild(item);
    });

    setupHomeZoomControls();
    setupHomeDragScroll();
    applyHomeZoom(1.0);
  } catch(e){ console.error('Error cargando línea principal del inicio:',e); }
}

// ─── BÚSQUEDA Y ORDEN DE LÍNEAS DE TIEMPO ───────────────────
// Convierte el campo "creadoEn" (que puede venir como Timestamp de
// Firestore, como {seconds}, o como número plano) a milisegundos,
// para poder comparar fechas sin importar de dónde vino el dato.
function getCreadoEnMillis(tl){
  const c = tl && tl.creadoEn;
  if(!c) return 0;
  if(typeof c.toMillis === 'function') return c.toMillis();
  if(typeof c.seconds === 'number') return c.seconds*1000;
  if(typeof c === 'number') return c;
  return 0;
}

// Milisegundos de la última actividad real sobre la línea de tiempo:
// usa "actualizadoEn" (se guarda cada vez que se edita el nombre/desc,
// o se agrega/edita/elimina un evento) y si nunca se ha editado, cae
// de vuelta a la fecha de creación.
function getUltimaActividadMillis(tl){
  const a=tl && tl.actualizadoEn;
  if(typeof a === 'number' && a>0) return a;
  return getCreadoEnMillis(tl);
}

// Convierte una diferencia de tiempo en un texto corto en español,
// tipo "hace 3 días". Usado en la franja de "Actividad reciente".
function formatTiempoRelativo(millis){
  if(!millis) return '';
  const diffMs=Date.now()-millis;
  if(diffMs<60000) return 'justo ahora';
  const minuto=60000, hora=3600000, dia=86400000, semana=7*dia, mes=30*dia, anio=365*dia;
  if(diffMs<hora){ const n=Math.floor(diffMs/minuto); return `hace ${n} minuto${n===1?'':'s'}`; }
  if(diffMs<dia){ const n=Math.floor(diffMs/hora); return `hace ${n} hora${n===1?'':'s'}`; }
  if(diffMs<semana){ const n=Math.floor(diffMs/dia); return `hace ${n} día${n===1?'':'s'}`; }
  if(diffMs<mes){ const n=Math.floor(diffMs/semana); return `hace ${n} semana${n===1?'':'s'}`; }
  if(diffMs<anio){ const n=Math.floor(diffMs/mes); return `hace ${n} mes${n===1?'':'es'}`; }
  const n=Math.floor(diffMs/anio); return `hace ${n} año${n===1?'':'s'}`;
}

// Construye la franja "Actividad reciente" que va arriba del bloque de
// "Destacar en el inicio", en el muro/perfil. Solo el dueño de la línea
// de tiempo la ve (a diferencia de "Destacar", que root también puede
// ver): ayuda a distinguir de un vistazo cuáles líneas siguen activas
// y cuáles llevan tiempo abandonadas.
function buildActividadRow(tl){
  if(!currentUser || tl.ownerId!==currentUser.uid) return null;
  const millis=getUltimaActividadMillis(tl);
  const row=document.createElement('div');
  row.className='activity-strip';
  row.innerHTML=`<span class="activity-strip-icon">🕒</span><span>Actualizada ${formatTiempoRelativo(millis)}</span>`;
  return row;
}

// ─── "ME GUSTA" EN LÍNEAS DE TIEMPO ─────────────────────────
// El campo "likes" es un arreglo de uids en el documento de la línea
// de tiempo. Solo alguien que no sea el dueño puede darle "me gusta".
// El dueño puede ver cuántos lleva, pero no puede dárselo a sí mismo.
function getLikesArray(tl){
  return Array.isArray(tl && tl.likes) ? tl.likes : [];
}

// Refleja un cambio de "likes" en todas las copias locales que
// tenemos de esa línea de tiempo (la del detalle, la de la lista de
// inicio y la del perfil), para que cualquier pantalla que se
// redibuje después muestre el dato correcto sin tener que recargar
// desde Firestore.
function setLikesLocal(id, likes){
  if(_timelineCache[id]) _timelineCache[id]={..._timelineCache[id],likes};
  if(_timelinesCache){
    const idx=_timelinesCache.findIndex(t=>t.id===id);
    if(idx>-1) _timelinesCache[idx]={..._timelinesCache[idx],likes};
  }
  const hIdx=_homeTimelinesRaw.findIndex(t=>t.id===id);
  if(hIdx>-1) _homeTimelinesRaw[hIdx]={..._homeTimelinesRaw[hIdx],likes};
  const pIdx=_perfilTimelinesRaw.findIndex(t=>t.id===id);
  if(pIdx>-1) _perfilTimelinesRaw[pIdx]={..._perfilTimelinesRaw[pIdx],likes};
}

// Actualiza en el DOM todos los botones de "me gusta" de una línea de
// tiempo puntual (puede aparecer en el inicio y en un perfil a la
// vez), sin necesidad de redibujar toda la grilla.
function actualizarBotonLike(id, likes){
  const count=(likes||[]).length;
  const likedByMe=!!(currentUser && likes.includes(currentUser.uid));
  document.querySelectorAll(`.btn-like[data-id="${id}"]`).forEach(btn=>{
    btn.classList.toggle('liked', likedByMe);
    const heart=btn.querySelector('.like-heart');
    const countEl=btn.querySelector('.like-count');
    if(heart) heart.textContent = likedByMe ? '❤️' : '🤍';
    if(countEl) countEl.textContent = count;
  });
}

// Marca/desmarca el "me gusta" del usuario actual sobre una línea de
// tiempo. Actualiza primero en pantalla (para que se sienta instantáneo)
// y luego guarda en Firestore; si falla, revierte.
async function toggleLike(tl){
  if(!currentUser){ showAuth(); return; }
  if(tl.ownerId===currentUser.uid){
    toast('No puedes darle "me gusta" a tu propia línea de tiempo.');
    return;
  }
  const likesActuales=getLikesArray(tl);
  const yaLeGusta=likesActuales.includes(currentUser.uid);
  const likes=yaLeGusta
    ? likesActuales.filter(uid=>uid!==currentUser.uid)
    : [...likesActuales,currentUser.uid];

  setLikesLocal(tl.id,likes);
  actualizarBotonLike(tl.id,likes);
  // Si estamos parados justo en la vista de estadísticas de un perfil,
  // el total de "me gusta" del muro también cambia al instante.
  const perfilScreen=document.getElementById('screen-perfil');
  if(perfilScreen && perfilScreen.classList.contains('active') && perfilViewMode==='stats'){
    renderPerfilStats();
  }

  try {
    await updateTimeline(tl.id,{likes});
  } catch(err){
    console.error(err);
    setLikesLocal(tl.id,likesActuales);
    actualizarBotonLike(tl.id,likesActuales);
    toast('No se pudo guardar el "me gusta". Intenta de nuevo.');
  }
}

// Construye la fila con el botón de "me gusta" que va debajo de cada
// tarjeta de línea de tiempo (tanto en el inicio como en el perfil).
function buildLikeRow(tl){
  const row=document.createElement('div');
  row.className='like-row';
  const likes=getLikesArray(tl);
  const count=likes.length;
  const esPropia=!!(currentUser && tl.ownerId===currentUser.uid);
  const likedByMe=!!(currentUser && likes.includes(currentUser.uid));

  const btn=document.createElement('button');
  btn.type='button';
  btn.className='btn-like'+(likedByMe?' liked':'')+(esPropia?' disabled':'');
  btn.dataset.id=tl.id;
  btn.title = esPropia
    ? 'No puedes darle "me gusta" a tu propia línea de tiempo'
    : (likedByMe ? 'Quitar me gusta' : 'Dar me gusta');
  btn.innerHTML = `<span class="like-heart">${likedByMe?'❤️':'🤍'}</span><span class="like-count">${count}</span>`;
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    if(esPropia){
      toast('No puedes darle "me gusta" a tu propia línea de tiempo.');
      return;
    }
    toggleLike(tl);
  });

  row.appendChild(btn);
  return row;
}

// Filtra por nombre (si hay texto buscado) y ordena según el modo
// elegido. Devuelve un arreglo nuevo, sin modificar el original.
function filtrarYOrdenarTimelines(lista, query, sortBy){
  const q=(query||'').trim().toLowerCase();
  let out = q ? lista.filter(tl=>(tl.nombre||'').toLowerCase().includes(q)) : [...lista];
  switch(sortBy){
    case 'oldest':
      out.sort((a,b)=>getCreadoEnMillis(a)-getCreadoEnMillis(b));
      break;
    case 'events':
      out.sort((a,b)=>(b.eventos||[]).length-(a.eventos||[]).length);
      break;
    case 'az':
      out.sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));
      break;
    case 'recent':
    default:
      out.sort((a,b)=>getCreadoEnMillis(b)-getCreadoEnMillis(a));
  }
  return out;
}

const SORT_LABELS = { recent:'Más reciente', oldest:'Más antiguo', events:'Más eventos', az:'A-Z' };

// Conecta el buscador y el botón desplegable de orden (home o perfil):
// engancha los listeners solo una vez (evita duplicar handlers) y
// sincroniza el texto/opción activa con el estado guardado en JS.
function setupTimelinesToolbar({ searchInputId, sortToggleId, sortMenuId, getSortBy, setSortBy, getQuery, setQuery, onChange }){
  const searchInput=document.getElementById(searchInputId);
  const dropdown=document.getElementById(sortToggleId)?.closest('.sort-dropdown');
  const toggle=document.getElementById(sortToggleId);
  const menu=document.getElementById(sortMenuId);
  if(!searchInput || !toggle || !menu || !dropdown) return;

  if(!searchInput._wired){
    searchInput._wired=true;
    searchInput.addEventListener('input',()=>{
      setQuery(searchInput.value);
      onChange();
    });
  }

  function syncSortUI(){
    toggle.querySelector('.sort-toggle-label').textContent = SORT_LABELS[getSortBy()] || SORT_LABELS.recent;
    menu.querySelectorAll('.sort-option').forEach(b=>b.classList.toggle('active', b.dataset.sort===getSortBy()));
  }

  if(!toggle._wired){
    toggle._wired=true;
    toggle.addEventListener('click',e=>{
      e.stopPropagation();
      const abierto=!menu.classList.contains('hidden');
      // Cierra cualquier otro desplegable de orden que haya quedado abierto
      // (por ejemplo si hubiera varios en la misma pantalla).
      document.querySelectorAll('.sort-dropdown-menu').forEach(m=>m.classList.add('hidden'));
      document.querySelectorAll('.sort-dropdown').forEach(d=>d.classList.remove('open'));
      if(!abierto){
        menu.classList.remove('hidden');
        dropdown.classList.add('open');
      }
    });
  }
  if(!menu._wired){
    menu._wired=true;
    menu.addEventListener('click',e=>{
      e.stopPropagation();
      const btn=e.target.closest('.sort-option');
      if(!btn) return;
      setSortBy(btn.dataset.sort);
      menu.classList.add('hidden');
      dropdown.classList.remove('open');
      syncSortUI();
      onChange();
    });
  }
  // Cierra cualquier desplegable abierto si se hace clic fuera de él.
  // Se engancha una sola vez en todo el documento.
  if(!window._sortDropdownOutsideWired){
    window._sortDropdownOutsideWired=true;
    document.addEventListener('click',()=>{
      document.querySelectorAll('.sort-dropdown-menu').forEach(m=>m.classList.add('hidden'));
      document.querySelectorAll('.sort-dropdown').forEach(d=>d.classList.remove('open'));
    });
  }

  searchInput.value=getQuery();
  syncSortUI();
}

async function renderHome(){
  lastListScreen='home';
  const seq=++_renderHomeSeq;
  showScreen('home');
  updateHeader(currentUser);

  let timelines=[];
  try { timelines=await fetchTimelines(); } catch(e){ console.error(e); }
  if(seq!==_renderHomeSeq) return;

  // El inicio es una vitrina curada: solo muestra líneas de tiempo que
  // el usuario root aprobó explícitamente como "destacadas". Todas las
  // demás (nuevas, pendientes, rechazadas o privadas) viven únicamente
  // en el perfil de quien las creó, hasta que las sugiera y se acepten.
  _homeTimelinesRaw=timelines.filter(tl=>!tl.privada && tl.estadoDestacada==='aprobada');

  // ¿Hay al menos una línea de tiempo que el usuario actual puede borrar?
  // Si no hay ninguna, no tiene sentido mostrarle el botón "Seleccionar".
  const hayBorrables = _homeTimelinesRaw.some(tl=>canEdit(tl));
  const btnActivar = document.getElementById('btn-activar-seleccion');
  btnActivar.classList.toggle('hidden', !hayBorrables);

  setupTimelinesToolbar({
    searchInputId:'home-search',
    sortToggleId:'home-sort-toggle',
    sortMenuId:'home-sort-menu',
    getSortBy:()=>homeSortBy,
    setSortBy:v=>{homeSortBy=v;},
    getQuery:()=>homeSearchQuery,
    setQuery:v=>{homeSearchQuery=v;},
    onChange:renderHomeCards
  });

  renderHomeCards();
}

// Dibuja las tarjetas del inicio a partir de _homeTimelinesRaw, aplicando
// la búsqueda y el orden vigentes. Se llama tanto al cargar la pantalla
// como cada vez que cambia el texto buscado o el botón de orden.
function renderHomeCards(){
  const grid=document.getElementById('timelines-grid');
  const empty=document.getElementById('empty-state');
  grid.innerHTML='';
  grid.appendChild(empty);

  const otras=filtrarYOrdenarTimelines(_homeTimelinesRaw, homeSearchQuery, homeSortBy);

  if(_homeTimelinesRaw.length===0){
    empty.style.display='block';
    empty.querySelector('p').innerHTML='Aún no hay líneas de tiempo destacadas.<br/>Crea la tuya y sugiérela desde tu perfil.';
  } else if(otras.length===0){
    empty.style.display='block';
    empty.querySelector('p').innerHTML='No encontramos líneas de tiempo con ese nombre.';
  } else {
    empty.style.display='none';
    otras.forEach((tl,i)=>{
      const wrap=document.createElement('div');
      wrap.className='timeline-card-wrap';
      wrap.style.animationDelay=(i*0.07)+'s';

      const card=document.createElement('div');
      card.className='timeline-card';
      card.style.setProperty('--card-accent',tl.color||'#E8845A');
      const count=(tl.eventos||[]).length;
      const esPropia=currentUser&&tl.ownerId===currentUser.uid;
      const ownerLabel=tl.ownerName?`<span class="card-owner card-owner-link" data-owner-id="${escHtml(tl.ownerId||'')}">por ${escHtml(tl.ownerName)}</span>`:'';
      const propiaLabel=esPropia?`<span class="card-owner card-owner--propia card-owner-link" data-owner-id="${escHtml(tl.ownerId||'')}">✎ Tuya</span>`:ownerLabel;
      const puedeBorrar=canEdit(tl);
      // El checkbox solo se dibuja si estamos en modo selección Y el
      // usuario tiene permiso de borrar esta línea de tiempo en particular.
      const checkboxHtml = (modoSeleccion && puedeBorrar)
        ? `<label class="card-checkbox">
             <input type="checkbox" class="card-checkbox-input" data-id="${tl.id}" ${idsSeleccionados.has(tl.id)?'checked':''}/>
           </label>`
        : '';
      const bgImageHtml=tl.imagenUrl?`<div class="card-bg-image" style="background-image:url('${escHtml(tl.imagenUrl)}')"></div>`:'';
      card.innerHTML=`
        ${bgImageHtml}
        ${checkboxHtml}
        <span class="card-icon">◉</span>
        <div class="card-name">${escHtml(tl.nombre)}</div>
        <div class="card-desc">${escHtml(tl.desc||'Sin descripción')}</div>
        <div class="card-meta"><span class="dot"></span>${count===0?'Sin eventos aún':count+(count===1?' evento':' eventos')}</div>
        ${propiaLabel}`;

      if(modoSeleccion && puedeBorrar){
        // El checkbox necesita "detener" el clic para que no le llegue
        // también a la tarjeta completa (evita marcar/desmarcar doble).
        const checkboxInput=card.querySelector('.card-checkbox-input');
        checkboxInput.addEventListener('click',e=>e.stopPropagation());
        checkboxInput.addEventListener('change',()=>alternarSeleccion(tl.id));

        // En modo selección, el clic en la tarjeta marca/desmarca en
        // vez de abrir la línea de tiempo.
        card.classList.add('seleccionable');
        card.addEventListener('click',()=>alternarSeleccion(tl.id));
      } else {
        card.addEventListener('click',()=>openTimeline(tl.id));
      }
      const ownerLink=card.querySelector('.card-owner-link');
      if(ownerLink && tl.ownerId){
        ownerLink.addEventListener('click',e=>{
          e.stopPropagation();
          renderPerfil(tl.ownerId);
        });
      }
      wrap.appendChild(card);
      // El modo selección (para borrar en lote) es solo para tarjetas
      // propias; ocultamos el botón de "me gusta" mientras tanto para
      // no estorbar el flujo de selección.
      if(!(modoSeleccion && puedeBorrar)) wrap.appendChild(buildLikeRow(tl));
      grid.appendChild(wrap);
    });
  }
}

// ─── PERFIL / MURO DE USUARIO ──────────────────────────────
// Muestra las líneas de tiempo creadas por un usuario en particular.
// Es pública: cualquiera puede visitarla, pero las líneas marcadas
// como "privada" solo se muestran si quien mira es el propio dueño
// (o root). Se accede desde "Mi perfil" en el header, o haciendo
// clic en el nombre del dueño dentro de cualquier tarjeta.
async function renderPerfil(uid){
  if(!uid) return;
  // Si cambiamos de perfil (otro usuario), reseteamos la búsqueda/orden
  // para no arrastrar un filtro que no tiene sentido en el nuevo muro.
  if(viewingProfileUid!==uid){
    perfilSearchQuery='';
    perfilSortBy='recent';
    perfilViewMode='lineas';
  }
  viewingProfileUid=uid;
  lastListScreen='perfil';
  const seq=++_renderHomeSeq;
  showScreen('perfil');
  updateHeader(currentUser);

  let timelines=[];
  try { timelines=await fetchTimelines(); } catch(e){ console.error(e); }
  if(seq!==_renderHomeSeq) return;

  const esPropio = !!(currentUser && currentUser.uid===uid);
  const puedeVerPrivadas = esPropio || isRoot;

  const todasDelUsuario = timelines.filter(tl=>tl.ownerId===uid);
  const visibles = todasDelUsuario.filter(tl=>!tl.privada || puedeVerPrivadas);
  const numPrivadas = todasDelUsuario.filter(tl=>tl.privada).length;
  _perfilTimelinesRaw = visibles;

  // Para el nombre/foto: si es tu propio perfil usamos tus datos de
  // Auth (siempre disponibles). Si es el perfil de otra persona, no
  // tenemos acceso a su cuenta de Auth, así que usamos lo que quedó
  // guardado en cualquiera de sus líneas de tiempo (ownerName/ownerPhotoURL).
  let nombre='Usuario', foto='';
  if(esPropio && currentUser){
    nombre=currentUser.displayName||currentUser.email||'Usuario';
    foto=currentUser.photoURL||'';
  } else if(todasDelUsuario.length){
    nombre=todasDelUsuario[0].ownerName||'Usuario';
    foto=todasDelUsuario[0].ownerPhotoURL||'';
  }

  document.getElementById('perfil-nombre').textContent=nombre;
  const avatarEl=document.getElementById('perfil-avatar');
  if(foto){ avatarEl.src=foto; avatarEl.style.display='block'; }
  else { avatarEl.style.display='none'; }

  const countLabel = visibles.length===0?'Sin líneas de tiempo aún'
    : `${visibles.length} línea${visibles.length===1?'':'s'} de tiempo`;
  const privLabel = (esPropio && numPrivadas>0) ? ` (${numPrivadas} privada${numPrivadas===1?'':'s'})` : '';
  document.getElementById('perfil-count').textContent = countLabel+privLabel;

  document.getElementById('perfil-grid-title').textContent = esPropio
    ? 'Tus líneas de tiempo'
    : `Líneas de tiempo de ${nombre}`;
  document.getElementById('btn-nueva-perfil').classList.toggle('hidden', !esPropio);

  // Los textos de "vacío" cambian según si de plano no hay líneas de
  // tiempo, o si hay pero la búsqueda actual no encontró ninguna.
  const perfilEmptyBaseMsg = esPropio
    ? 'Aún no has creado ninguna línea de tiempo.'
    : 'Este usuario aún no tiene líneas de tiempo públicas.';

  setupTimelinesToolbar({
    searchInputId:'perfil-search',
    sortToggleId:'perfil-sort-toggle',
    sortMenuId:'perfil-sort-menu',
    getSortBy:()=>perfilSortBy,
    setSortBy:v=>{perfilSortBy=v;},
    getQuery:()=>perfilSearchQuery,
    setQuery:v=>{perfilSearchQuery=v;},
    onChange:()=>renderPerfilCards(perfilEmptyBaseMsg)
  });

  renderPerfilCards(perfilEmptyBaseMsg);
  applyPerfilViewMode();
}

// Muestra la sección de "Líneas de tiempo" o la de "Estadísticas del
// perfil" según perfilViewMode, y deja el botón con el texto correcto.
function applyPerfilViewMode(){
  const btn = document.getElementById('btn-toggle-perfil-stats');
  const lineasSection = document.getElementById('perfil-lineas-section');
  const statsSection = document.getElementById('perfil-stats-section');
  if(perfilViewMode==='stats'){
    lineasSection.classList.add('hidden');
    statsSection.classList.remove('hidden');
    btn.textContent = '← Ver líneas de tiempo';
    renderPerfilStats();
  } else {
    statsSection.classList.add('hidden');
    lineasSection.classList.remove('hidden');
    btn.textContent = '📊 Estadísticas del perfil';
  }
}

// Calcula y dibuja las tarjetas de "logros" del perfil: total de
// líneas, total de eventos creados, línea más antigua y línea con
// más eventos. Usa _perfilTimelinesRaw, que ya viene filtrado por
// privacidad (solo lo que quien mira puede ver).
function renderPerfilStats(){
  const grid = document.getElementById('perfil-stats-grid');
  const empty = document.getElementById('perfil-stats-empty');
  const lista = _perfilTimelinesRaw || [];
  grid.innerHTML = '';

  if(lista.length===0){
    empty.classList.remove('hidden');
    grid.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.classList.remove('hidden');

  const totalLineas = lista.length;
  const totalEventos = lista.reduce((sum,tl)=>sum+(tl.eventos||[]).length,0);
  const totalLikes = lista.reduce((sum,tl)=>sum+getLikesArray(tl).length,0);

  let masAntigua = lista[0];
  lista.forEach(tl=>{ if(getCreadoEnMillis(tl) < getCreadoEnMillis(masAntigua)) masAntigua = tl; });

  let masEventos = lista[0];
  lista.forEach(tl=>{ if((tl.eventos||[]).length > (masEventos.eventos||[]).length) masEventos = tl; });

  const antiguaMillis = getCreadoEnMillis(masAntigua);
  const numEventosDestacada = (masEventos.eventos||[]).length;

  const cards = [
    {
      icon:'📚',
      value: String(totalLineas),
      label: totalLineas===1 ? 'línea de tiempo' : 'líneas de tiempo'
    },
    {
      icon:'✨',
      value: String(totalEventos),
      label: totalEventos===1 ? 'evento creado' : 'eventos creados'
    },
    {
      icon:'❤️',
      value: String(totalLikes),
      label: totalLikes===1 ? 'me gusta recibido' : 'me gusta recibidos'
    },
    {
      icon:'🕰️',
      value: escHtml(masAntigua.nombre||'Sin nombre'),
      label: 'línea más antigua',
      sub: antiguaMillis ? `Creada hace ${formatTiempoRelativo(antiguaMillis).replace('hace ','')}` : null,
      textValue: true
    },
    {
      icon:'🏆',
      value: escHtml(masEventos.nombre||'Sin nombre'),
      label: 'línea con más eventos',
      sub: `${numEventosDestacada} evento${numEventosDestacada===1?'':'s'}`,
      textValue: true
    }
  ];

  cards.forEach((c,i)=>{
    const card=document.createElement('div');
    card.className='stat-card';
    card.style.animationDelay=(i*0.07)+'s';
    card.innerHTML = `
      <span class="stat-card-icon">${c.icon}</span>
      <div class="stat-card-value${c.textValue?' stat-value-text':''}">${c.value}</div>
      <div class="stat-card-label">${c.label}</div>
      ${c.sub?`<div class="stat-card-sub">${escHtml(c.sub)}</div>`:''}
    `;
    grid.appendChild(card);
  });
}

// Dibuja las tarjetas del perfil a partir de _perfilTimelinesRaw,
// aplicando la búsqueda y el orden vigentes.
function renderPerfilCards(emptyBaseMsg){
  const grid=document.getElementById('perfil-grid');
  const empty=document.getElementById('perfil-empty');
  grid.innerHTML='';
  grid.appendChild(empty);

  const visibles=filtrarYOrdenarTimelines(_perfilTimelinesRaw, perfilSearchQuery, perfilSortBy);

  if(_perfilTimelinesRaw.length===0){
    empty.style.display='block';
    empty.querySelector('p').textContent=emptyBaseMsg;
  } else if(visibles.length===0){
    empty.style.display='block';
    empty.querySelector('p').textContent='No encontramos líneas de tiempo con ese nombre.';
  } else {
    empty.style.display='none';
    visibles.forEach((tl,i)=>{
      const wrap=document.createElement('div');
      wrap.className='timeline-card-wrap';

      const card=document.createElement('div');
      card.className='timeline-card';
      card.style.setProperty('--card-accent',tl.color||'#E8845A');
      card.style.animationDelay=(i*0.07)+'s';
      const count=(tl.eventos||[]).length;
      const bgImageHtml=tl.imagenUrl?`<div class="card-bg-image" style="background-image:url('${escHtml(tl.imagenUrl)}')"></div>`:'';
      const privadaBadge=tl.privada?`<span class="card-privada-badge">🔒 Privada</span>`:'';
      card.innerHTML=`
        ${bgImageHtml}
        ${privadaBadge}
        <span class="card-icon">◉</span>
        <div class="card-name">${escHtml(tl.nombre)}</div>
        <div class="card-desc">${escHtml(tl.desc||'Sin descripción')}</div>
        <div class="card-meta"><span class="dot"></span>${count===0?'Sin eventos aún':count+(count===1?' evento':' eventos')}</div>`;
      card.addEventListener('click',()=>openTimeline(tl.id));
      wrap.appendChild(card);
      wrap.appendChild(buildLikeRow(tl));

      const activityRow=buildActividadRow(tl);
      if(activityRow) wrap.appendChild(activityRow);

      const featureRow=buildFeatureRow(tl);
      if(featureRow) wrap.appendChild(featureRow);

      grid.appendChild(wrap);
    });
  }
}

// Construye la fila de controles para "destacar en el inicio" que va
// debajo de cada tarjeta en el perfil. Solo se muestra si quien mira
// es el dueño de la línea o el usuario root, y la línea no es privada
// (una línea privada nunca puede aparecer en el inicio).
function buildFeatureRow(tl){
  if(!currentUser || tl.privada) return null;
  const isOwner = tl.ownerId===currentUser.uid;
  if(!isOwner && !isRoot) return null;

  const estado = tl.estadoDestacada || 'ninguna';
  const row=document.createElement('div');
  row.className='feature-row';

  if(isRoot){
    // El usuario root puede aprobar/rechazar directamente desde
    // cualquier perfil, sin pasar por la pantalla de Solicitudes.
    if(estado==='pendiente'){
      row.innerHTML=`<span class="feature-status">⏳ Pidió aparecer en el inicio</span>
        <button type="button" class="btn-feature btn-feature-accept">✓ Aprobar</button>
        <button type="button" class="btn-feature btn-feature-reject">✕ Rechazar</button>`;
      row.querySelector('.btn-feature-accept').addEventListener('click',()=>aprobarDestacada(tl.id));
      row.querySelector('.btn-feature-reject').addEventListener('click',()=>rechazarDestacada(tl.id));
    } else if(estado==='aprobada'){
      row.innerHTML=`<span class="feature-status feature-status--on">★ En el inicio</span>
        <button type="button" class="btn-feature btn-feature-quitar">Quitar</button>`;
      row.querySelector('.btn-feature-quitar').addEventListener('click',()=>quitarDestacada(tl.id));
    } else {
      row.innerHTML=`<button type="button" class="btn-feature btn-feature-destacar">★ Destacar en el inicio</button>`;
      row.querySelector('.btn-feature-destacar').addEventListener('click',()=>aprobarDestacada(tl.id));
    }
  } else {
    // Dueño (no root): puede sugerir, cancelar su solicitud, o
    // quitar su propia línea del inicio si ya estaba destacada.
    if(estado==='pendiente'){
      row.innerHTML=`<span class="feature-status">⏳ Esperando revisión</span>
        <button type="button" class="btn-feature btn-feature-cancelar">Cancelar</button>`;
      row.querySelector('.btn-feature-cancelar').addEventListener('click',()=>cancelarSolicitudDestacada(tl.id));
    } else if(estado==='aprobada'){
      row.innerHTML=`<span class="feature-status feature-status--on">★ Mostrándose en el inicio</span>
        <button type="button" class="btn-feature btn-feature-quitar">Quitar</button>`;
      row.querySelector('.btn-feature-quitar').addEventListener('click',()=>quitarDestacada(tl.id));
    } else {
      const nota = estado==='rechazada'
        ? `<span class="feature-status feature-status--muted">Tu última solicitud no fue aceptada</span>`
        : '';
      row.innerHTML=`${nota}<button type="button" class="btn-feature btn-feature-sugerir">☆ Sugerir para el inicio</button>`;
      row.querySelector('.btn-feature-sugerir').addEventListener('click',()=>solicitarDestacada(tl.id));
    }
  }
  return row;
}

async function solicitarDestacada(id){
  try {
    await updateTimeline(id,{estadoDestacada:'pendiente'});
    toast('Solicitud enviada. El administrador la revisará pronto.');
    if(viewingProfileUid) renderPerfil(viewingProfileUid);
    if(isRoot) refreshSolicitudesBadge();
  } catch(e){ console.error(e); toast('No se pudo enviar la solicitud.'); }
}

async function cancelarSolicitudDestacada(id){
  try {
    await updateTimeline(id,{estadoDestacada:'ninguna'});
    toast('Solicitud cancelada.');
    if(viewingProfileUid) renderPerfil(viewingProfileUid);
    if(isRoot) refreshSolicitudesBadge();
  } catch(e){ console.error(e); toast('Error al cancelar.'); }
}

async function quitarDestacada(id){
  try {
    await updateTimeline(id,{estadoDestacada:'ninguna'});
    toast('Se quitó del inicio.');
    if(viewingProfileUid) renderPerfil(viewingProfileUid);
    if(isRoot) refreshSolicitudesBadge();
  } catch(e){ console.error(e); toast('Error al quitar.'); }
}

async function aprobarDestacada(id){
  try {
    await updateTimeline(id,{estadoDestacada:'aprobada'});
    toast('Línea destacada en el inicio ✓');
    if(document.getElementById('screen-solicitudes').classList.contains('active')) await renderSolicitudes();
    else if(viewingProfileUid) await renderPerfil(viewingProfileUid);
    refreshSolicitudesBadge();
  } catch(e){ console.error(e); toast('Error al aprobar.'); }
}

async function rechazarDestacada(id){
  try {
    await updateTimeline(id,{estadoDestacada:'rechazada'});
    toast('Solicitud rechazada.');
    if(document.getElementById('screen-solicitudes').classList.contains('active')) await renderSolicitudes();
    else if(viewingProfileUid) await renderPerfil(viewingProfileUid);
    refreshSolicitudesBadge();
  } catch(e){ console.error(e); toast('Error.'); }
}

// ─── PANTALLA SOLICITUDES (solo root) ───────────────────────
async function renderSolicitudes(){
  if(!isRoot){ renderHome(); return; }
  showScreen('solicitudes');
  updateHeader(currentUser);

  const list=document.getElementById('solicitudes-list');
  const empty=document.getElementById('solicitudes-empty');
  list.innerHTML='';
  list.appendChild(empty);

  let timelines=[];
  try { timelines=await fetchTimelines(); } catch(e){ console.error(e); }
  const pendientes=timelines.filter(tl=>tl.estadoDestacada==='pendiente');
  updateSolicitudesBadge(pendientes.length);

  if(pendientes.length===0){
    empty.style.display='block';
    return;
  }
  empty.style.display='none';
  pendientes.forEach(tl=>{
    const item=document.createElement('div');
    item.className='solicitud-item';
    item.innerHTML=`
      <div class="solicitud-info">
        <div class="solicitud-nombre">${escHtml(tl.nombre)}</div>
        <div class="solicitud-meta">por ${escHtml(tl.ownerName||'Usuario')} · ${escHtml(tl.desc||'Sin descripción')}</div>
      </div>
      <div class="solicitud-actions">
        <button type="button" class="btn-feature btn-feature-accept">✓ Aprobar</button>
        <button type="button" class="btn-feature btn-feature-reject">✕ Rechazar</button>
        <button type="button" class="btn-mini btn-solicitud-ver">Ver</button>
      </div>`;
    item.querySelector('.btn-feature-accept').addEventListener('click',()=>aprobarDestacada(tl.id));
    item.querySelector('.btn-feature-reject').addEventListener('click',()=>rechazarDestacada(tl.id));
    item.querySelector('.btn-solicitud-ver').addEventListener('click',()=>openTimeline(tl.id));
    list.appendChild(item);
  });
}

async function refreshSolicitudesBadge(){
  if(!isRoot) return;
  try {
    const timelines=await fetchTimelines();
    updateSolicitudesBadge(timelines.filter(tl=>tl.estadoDestacada==='pendiente').length);
  } catch(e){ console.error(e); }
}

function updateSolicitudesBadge(n){
  const badge=document.getElementById('solicitudes-badge');
  if(!badge) return;
  if(n>0){ badge.textContent=n; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

// Activa o desactiva el modo selección, mostrando/ocultando los botones.
function setModoSeleccion(activo){
  modoSeleccion=activo;
  if(!activo) idsSeleccionados.clear();
  document.getElementById('btn-activar-seleccion').classList.toggle('hidden',activo);
  document.getElementById('bulk-count').classList.toggle('hidden',!activo);
  document.getElementById('btn-eliminar-seleccionadas').classList.toggle('hidden',!activo);
  document.getElementById('btn-cancelar-seleccion').classList.toggle('hidden',!activo);
  actualizarContadorSeleccion();
  renderHome();
}

function actualizarContadorSeleccion(){
  const n=idsSeleccionados.size;
  document.getElementById('bulk-count').textContent = n+(n===1?' seleccionada':' seleccionadas');
}

// Marca o desmarca una línea de tiempo de la selección (sin volver a
// dibujar toda la grilla, para que sea instantáneo al hacer clic).
function alternarSeleccion(id){
  if(idsSeleccionados.has(id)) idsSeleccionados.delete(id);
  else idsSeleccionados.add(id);
  actualizarContadorSeleccion();
  const input=document.querySelector(`.card-checkbox-input[data-id="${id}"]`);
  if(input) input.checked=idsSeleccionados.has(id);
}

async function eliminarSeleccionadas(){
  const n=idsSeleccionados.size;
  if(n===0) return;
  const confirmado=confirm(`¿Seguro que quieres eliminar ${n} línea${n===1?'':'s'} de tiempo? Esta acción no se puede deshacer.`);
  if(!confirmado) return;

  const btn=document.getElementById('btn-eliminar-seleccionadas');
  btn.disabled=true;
  btn.textContent='Eliminando...';
  try {
    // Promise.all lanza todos los borrados al mismo tiempo (en vez de
    // uno por uno esperando cada uno), así que es más rápido cuando
    // borras varias a la vez.
    await Promise.all([...idsSeleccionados].map(id=>deleteTimeline(id)));
    toast(`${n} línea${n===1?'':'s'} de tiempo eliminada${n===1?'':'s'} ✓`);
  } catch(e){
    console.error(e);
    toast('Ocurrió un error al eliminar algunas líneas de tiempo.');
  } finally {
    btn.disabled=false;
    btn.textContent='🗑 Eliminar seleccionadas';
    setModoSeleccion(false);
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
      const panel=document.getElementById('tab-'+tab.dataset.tab);
      panel.classList.remove('hidden');
      panel.classList.add('active');
      setAuthError('');
    });
  });
}

async function loginWithGoogle(){
  try { await signInWithPopup(auth,gProvider); }
  catch(e){ setAuthError(friendlyError(e.code)); }
}

async function loginWithEmail(){
  const email=document.getElementById('login-email').value.trim();
  const pass=document.getElementById('login-password').value;
  if(!email||!pass){ setAuthError('Completa email y contraseña.'); return; }
  try { await signInWithEmailAndPassword(auth,email,pass); }
  catch(e){ setAuthError(friendlyError(e.code)); }
}

async function registerWithEmail(){
  const nombre=document.getElementById('reg-nombre').value.trim();
  const email=document.getElementById('reg-email').value.trim();
  const pass=document.getElementById('reg-password').value;
  if(!email||!pass){ setAuthError('Completa todos los campos.'); return; }
  if(pass.length<6){ setAuthError('La contraseña debe tener al menos 6 caracteres.'); return; }
  try {
    const cred=await createUserWithEmailAndPassword(auth,email,pass);
    if(nombre) await updateProfile(cred.user,{displayName:nombre});
  } catch(e){ setAuthError(friendlyError(e.code)); }
}

async function sendPhoneSMS(){
  const phone=document.getElementById('login-phone').value.trim();
  if(!phone){ setAuthError('Ingresa tu número con código de país (Ej: +56 9...)'); return; }
  try {
    if(!window.recaptchaVerifier){
      window.recaptchaVerifier=new RecaptchaVerifier(auth,'recaptcha-container',{size:'invisible'});
    }
    confirmationResult=await signInWithPhoneNumber(auth,phone,window.recaptchaVerifier);
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
  const code=document.getElementById('login-phone-code').value.trim();
  if(!code||code.length<6){ setAuthError('Ingresa el código de 6 dígitos.'); return; }
  try { await confirmationResult.confirm(code); }
  catch(e){ setAuthError('Código incorrecto. Intenta de nuevo.'); }
}

function friendlyError(code){
  const map={
    'auth/user-not-found':'No existe una cuenta con ese email.',
    'auth/wrong-password':'Contraseña incorrecta.',
    'auth/email-already-in-use':'Ese email ya está registrado.',
    'auth/invalid-email':'Email inválido.',
    'auth/weak-password':'Contraseña muy débil (mínimo 6 caracteres).',
    'auth/too-many-requests':'Demasiados intentos. Espera un momento.',
    'auth/popup-closed-by-user':'Cerraste la ventana de Google.',
    'auth/invalid-phone-number':'Número inválido. Usa formato +56...',
    'auth/invalid-verification-code':'Código de verificación incorrecto.',
  };
  return map[code]||'Ocurrió un error. Intenta de nuevo.';
}

// ─── EDITOR ───────────────────────────────────────────────
// Vuelve a la lista desde la que se entró al editor: el inicio o el
// perfil que se estaba viendo (según cuál se haya visitado último).
async function goBackToList(){
  if(lastListScreen==='perfil' && viewingProfileUid) await renderPerfil(viewingProfileUid);
  else await renderHome();
}

async function openTimeline(id){
  const tl=await getTimeline(id);
  if(!tl) return;

  // Las líneas privadas ni siquiera se abren si quien mira no es el
  // dueño (ni root), aunque tenga el enlace directo.
  if(!canView(tl)){
    toast('Esta línea de tiempo es privada.');
    return;
  }

  activeTimelineId=id;
  const puedeEditar=canEdit(tl);

  document.documentElement.style.setProperty('--accent',tl.color||'#E8845A');
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(tl.color||'#E8845A',0.18));
  document.getElementById('editor-title').textContent=tl.nombre;
  document.getElementById('editor-desc').textContent=tl.desc||'';

  const ownerEl=document.getElementById('editor-owner');
  if(ownerEl){
    if(!puedeEditar&&tl.ownerName){
      ownerEl.textContent=`por ${tl.ownerName}`;
      ownerEl.classList.remove('hidden');
      if(tl.ownerId){
        ownerEl.classList.add('editor-owner--link');
        ownerEl.onclick=()=>renderPerfil(tl.ownerId);
      }
    }
    else { ownerEl.classList.add('hidden'); ownerEl.classList.remove('editor-owner--link'); ownerEl.onclick=null; }
  }

  const btnAdd=document.getElementById('btn-add-event');
  const btnEditTl=document.getElementById('btn-edit-tl');
  const btnDelTl=document.getElementById('btn-delete-tl');

  if(puedeEditar){
    btnAdd.classList.remove('hidden');
    btnEditTl.classList.remove('hidden');
    if(btnDelTl) btnDelTl.classList.remove('hidden');
  } else {
    btnAdd.classList.add('hidden');
    btnEditTl.classList.add('hidden');
    if(btnDelTl) btnDelTl.classList.add('hidden');
  }

  showScreen('editor');
  zoomLevel=1.0;
  renderTimelineFromCache(tl);
  setupZoomControls();
  setupDragScroll();
  applyZoom(1.0);
}

function renderTimelineFromCache(tl){
  const container=document.getElementById('timeline-events');
  const empty=document.getElementById('timeline-empty');
  const line=document.getElementById('timeline-line');
  container.innerHTML='';

  const eventos=ordenarEventos(tl.eventos||[]);
  const lecturas=normalizeTimelineNotes(tl.lecturas||[]);
  renderTimelineNotesPanel(tl);
  renderRelatedTimelinesPanel(tl);

  if(eventos.length===0){
    empty.style.display='flex';
    line.style.display='none';
  } else {
    empty.style.display='none';
    line.style.display='block';
    eventos.forEach((ev,i)=>{
      const item=document.createElement('div');
      item.className='event-item';
      item.style.animationDelay=(i*0.06)+'s';
      const note=findTimelineNoteForEvent(lecturas,ev.id);
      if(note){
        item.classList.add('event-item--noted');
        item.style.setProperty('--note-color',note.color);
        item.style.setProperty('--note-glow',hexToAlpha(note.color,0.16));
      }
      const evThumb=getEventImages(ev)[0];
      const imgHtml=evThumb?`<img class="event-thumbnail" src="${evThumb}" alt=""/>`:'';
      const descHtml=ev.descripcion?`<div class="event-descripcion">${escHtml(ev.descripcion)}</div>`:'';
      const yearHtml=getYearLabel(ev.fecha)?`<div class="event-year">${getYearLabel(ev.fecha)}</div>`:'';
      const subCount=(ev.subEventos||[]).length;
      const subHtml=subCount?`<div class="event-subtimeline-pill">${subCount} hito${subCount===1?'':'s'} relacionados</div>`:'';
      item.innerHTML=`
        <div class="event-spacer"></div>
        ${yearHtml}
        <div class="event-card">
          ${imgHtml}
          <div class="event-titulo">${escHtml(ev.titulo)}</div>
          ${descHtml}
          ${subHtml}
        </div>
        <div class="event-connector"></div>
        <div class="event-dot"></div>
        <div class="event-connector"></div>
        <div class="event-spacer"></div>`;
      item.querySelector('.event-card').addEventListener('click',()=>verEventoFromCache(ev.id,tl));
      container.appendChild(item);
    });
  }
}

// ─── EDITAR LÍNEA DE TIEMPO ───────────────────────────────
async function openModalEditarTimeline(){
  const tl=_timelineCache[activeTimelineId];
  if(!tl||!canEdit(tl)){ toast('No tienes permiso para editar esta linea de tiempo.'); return; }
  document.getElementById('edit-tl-nombre').value=tl.nombre||'';
  document.getElementById('edit-tl-desc').value=tl.desc||'';
  document.getElementById('edit-tl-privada').checked=!!tl.privada;
  selectEditColor(tl.color||'#E8845A');
  editTlImagenUrl=tl.imagenUrl||null;
  editTlImagenSubiendo=false;
  renderEditTlImagen();
  resetTimelineNotesEditor(tl.lecturas||[],ordenarEventos(tl.eventos||[]));
  try {
    const timelines=await fetchTimelines();
    resetRelatedTimelinesEditor(tl.id,tl.relatedTimelineIds||[],timelines);
  } catch(e){
    console.error(e);
    resetRelatedTimelinesEditor(tl.id,tl.relatedTimelineIds||[],[]);
  }
  showModal('modal-editar-tl');
  document.getElementById('edit-tl-nombre').focus();
}

async function guardarEdicionTimeline(){
  const nombre=document.getElementById('edit-tl-nombre').value.trim();
  if(!nombre){ shake(document.getElementById('edit-tl-nombre')); return; }
  const desc=document.getElementById('edit-tl-desc').value.trim();
  const privada=document.getElementById('edit-tl-privada').checked;
  const color=selectedEditColor;
  const lecturas=getTimelineNotesFromEditor();
  const relatedTimelineIds=normalizeRelatedTimelineIds(getRelatedTimelineIdsFromEditor());
  const imagenUrl=editTlImagenUrl||null;
  const tl=_timelineCache[activeTimelineId];
  const actualizadoEn=Date.now();
  _timelineCache[activeTimelineId]={...tl,nombre,desc,privada,color,lecturas,relatedTimelineIds,imagenUrl,actualizadoEn};
  document.getElementById('editor-title').textContent=nombre;
  document.getElementById('editor-desc').textContent=desc;
  document.documentElement.style.setProperty('--accent',color);
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(color,0.18));
  renderTimelineFromCache(_timelineCache[activeTimelineId]);
  hideModal('modal-editar-tl');
  toast('Línea de tiempo actualizada ✓');
  try {
    await updateTimeline(activeTimelineId,{nombre,desc,privada,color,lecturas,relatedTimelineIds,imagenUrl,actualizadoEn});
  } catch(e){
    _timelineCache[activeTimelineId]=tl;
    document.getElementById('editor-title').textContent=tl.nombre;
    document.getElementById('editor-desc').textContent=tl.desc||'';
    toast('Error al guardar. Intenta de nuevo.');
    console.error(e);
  }
}

function selectEditColor(color){
  selectedEditColor=color;
  document.querySelectorAll('.edit-tl-color').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.color===color);
  });
}

async function eliminarTimeline(){
  const tl=_timelineCache[activeTimelineId];
  if(!tl||!canEdit(tl)){ toast('No tienes permiso para eliminar esta línea de tiempo.'); return; }
  if(!confirm(`¿Eliminar la línea de tiempo "${tl.nombre}"?`)) return;
  try {
    await deleteTimeline(activeTimelineId);
    toast('Línea de tiempo eliminada');
    await goBackToList();
  } catch(e){ toast('Error al eliminar.'); console.error(e); }
}

// ─── MODAL EVENTO ─────────────────────────────────────────
function openModalEvento(eventId=null){
  const tl=_timelineCache[activeTimelineId];
  if(!tl||!canEdit(tl)){ toast('No tienes permiso para editar esta línea de tiempo.'); return; }

  isSavingEvent=false;
  const btnGuardar=document.getElementById('btn-guardar-evento');
  btnGuardar.disabled=false;
  btnGuardar.textContent='Guardar evento';

  editingEventId=eventId;
  pendingImages=[];
  activeUploadsCount=0;
  renderImageGalleryEditor();
  resetSubtimelineEditor();

  const titulo=document.getElementById('modal-evento-titulo');
  const btnElim=document.getElementById('btn-eliminar-evento');

  if(eventId){
    const ev=(tl.eventos||[]).find(e=>e.id===eventId);
    if(ev){
      titulo.textContent='Editar evento';
      document.getElementById('ev-titulo').value=ev.titulo||'';
      document.getElementById('ev-fecha').value=ev.fecha||'';
      document.getElementById('ev-descripcion').value=ev.descripcion||'';
      pendingImages=getEventImages(ev);
      renderImageGalleryEditor();
      resetSubtimelineEditor(ev.subEventos||[]);
      btnElim.classList.remove('hidden');
      showModal('modal-evento');
      rememberEventDraft();
    }
  } else {
    titulo.textContent='Nuevo evento';
    document.getElementById('ev-titulo').value='';
    document.getElementById('ev-fecha').value='';
    document.getElementById('ev-descripcion').value='';
    resetSubtimelineEditor();
    btnElim.classList.add('hidden');
    showModal('modal-evento');
    rememberEventDraft();
    document.getElementById('ev-titulo').focus();
  }
}

async function guardarEvento(){
  if(isSavingEvent) return;
  const tituloVal=document.getElementById('ev-titulo').value.trim();
  if(!tituloVal){ shake(document.getElementById('ev-titulo')); return; }
  if(activeUploadsCount>0){ toast('Espera a que terminen de subir las imágenes.'); return; }

  isSavingEvent=true;
  const btnGuardar=document.getElementById('btn-guardar-evento');
  btnGuardar.disabled=true;
  btnGuardar.textContent='Guardando…';

  try {
    const tl=await getTimeline(activeTimelineId);
    const eventos=[...(tl.eventos||[])];
    const fechaVal=document.getElementById('ev-fecha').value.trim();
    const descVal=document.getElementById('ev-descripcion').value.trim();
    const subEventos=ordenarSubEventos(getSubtimelineFromEditor());

    if(editingEventId){
      const idx=eventos.findIndex(e=>e.id===editingEventId);
      if(idx>-1) eventos[idx]={...eventos[idx],titulo:tituloVal,fecha:fechaVal,descripcion:descVal,imagenes:[...pendingImages],imagen:null,subEventos};
    } else {
      eventos.push({id:uid(),titulo:tituloVal,fecha:fechaVal,descripcion:descVal,imagenes:[...pendingImages],subEventos,creadoEn:Date.now()});
    }

    const eventosOrdenados=ordenarEventos(eventos);
    const actualizadoEn=Date.now();
    if(_timelineCache[activeTimelineId]){
      _timelineCache[activeTimelineId]={..._timelineCache[activeTimelineId],eventos:eventosOrdenados,actualizadoEn};
    }
    await updateTimeline(activeTimelineId,{eventos:eventosOrdenados,actualizadoEn});
    closeEventModal(true);
    hideModal('modal-ver');
    toast('Guardado ✓');
    renderTimelineFromCache(_timelineCache[activeTimelineId]);
  } catch(e){
    toast('Error al guardar. Intenta de nuevo.');
    console.error(e);
    isSavingEvent=false;
    btnGuardar.disabled=false;
    btnGuardar.textContent='Guardar evento';
  }
}

async function eliminarEvento(){
  if(!editingEventId) return;
  if(!confirm('¿Eliminar este evento?')) return;
  const tl=_timelineCache[activeTimelineId];
  if(!tl) return;
  const eventos=(tl.eventos||[]).filter(e=>e.id!==editingEventId);
  const actualizadoEn=Date.now();
  _timelineCache[activeTimelineId]={...tl,eventos,actualizadoEn};
  closeEventModal(true);
  hideModal('modal-ver');
  toast('Evento eliminado');
  renderTimelineFromCache(_timelineCache[activeTimelineId]);
  try {
    await updateTimeline(activeTimelineId,{eventos,actualizadoEn});
  } catch(e){
    _timelineCache[activeTimelineId]=tl;
    renderTimelineFromCache(tl);
    toast('Error al eliminar.');
    console.error(e);
  }
}

function verEventoFromCache(eventId,tl){
  const ev=(tl.eventos||[]).find(e=>e.id===eventId);
  if(!ev) return;
  document.getElementById('ver-fecha').textContent=ev.fecha||'';
  document.getElementById('ver-titulo').textContent=ev.titulo;
  document.getElementById('ver-descripcion').textContent=ev.descripcion||'';
  renderVerImagenes(getEventImages(ev));
  renderSubtimelineView(ev.subEventos||[]);
  const btnEditar=document.getElementById('btn-editar-desde-ver');
  if(canEdit(tl)) btnEditar.classList.remove('hidden');
  else btnEditar.classList.add('hidden');
  editingEventId=eventId;
  showModal('modal-ver');
}

let lightboxImages=[];
let lightboxIndex=0;

function renderVerImagenes(imagenes){
  const wrap=document.getElementById('ver-imagenes');
  if(!imagenes.length){
    wrap.classList.add('hidden');
    wrap.innerHTML='';
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML=imagenes.map(src=>`<img src="${escHtml(src)}" alt="" data-full="${escHtml(src)}"/>`).join('');
  wrap.querySelectorAll('img').forEach((img,i)=>{
    img.addEventListener('click',()=>openLightbox(imagenes,i));
  });
}

function openLightbox(imagenes,index){
  lightboxImages=imagenes;
  lightboxIndex=index;
  const lightbox=document.getElementById('lightbox');
  lightbox.classList.remove('hidden');
  showLightboxImage();
}

function showLightboxImage(){
  document.getElementById('lightbox-img').src=lightboxImages[lightboxIndex];
  const counter=document.getElementById('lightbox-counter');
  const multiple=lightboxImages.length>1;
  counter.classList.toggle('hidden',!multiple);
  counter.textContent=`${lightboxIndex+1} / ${lightboxImages.length}`;
  document.getElementById('lightbox-prev').classList.toggle('hidden',!multiple);
  document.getElementById('lightbox-next').classList.toggle('hidden',!multiple);
}

function lightboxSiguiente(){
  if(!lightboxImages.length) return;
  lightboxIndex=(lightboxIndex+1)%lightboxImages.length;
  showLightboxImage();
}

function lightboxAnterior(){
  if(!lightboxImages.length) return;
  lightboxIndex=(lightboxIndex-1+lightboxImages.length)%lightboxImages.length;
  showLightboxImage();
}

function closeLightbox(){
  const lightbox=document.getElementById('lightbox');
  lightbox.classList.add('hidden');
  document.getElementById('lightbox-img').src='';
  lightboxImages=[];
  lightboxIndex=0;
}

// ─── NUEVA TIMELINE ───────────────────────────────────────
function openModalNueva(){
  if(!currentUser){ showAuth(); return; }
  document.getElementById('input-nombre').value='';
  document.getElementById('input-desc').value='';
  document.getElementById('input-privada').checked=false;
  selectColor('#E8845A');
  pendingTlImagenUrl=null;
  pendingTlImagenSubiendo=false;
  renderNuevaTlImagen();
  showModal('modal-nueva');
}

async function crearTimeline(){
  if(isCreatingTimeline) return;
  const nombre=document.getElementById('input-nombre').value.trim();
  if(!nombre){ shake(document.getElementById('input-nombre')); return; }
  if(!currentUser){ toast('Debes iniciar sesión primero.'); return; }
  const desc=document.getElementById('input-desc').value.trim();
  const privada=document.getElementById('input-privada').checked;
  const btnCrear=document.getElementById('btn-crear-confirmar');
  isCreatingTimeline=true;
  btnCrear.disabled=true;
  btnCrear.textContent='Creando...';

  try {
    const {ref, writePromise}=createTimeline({nombre,desc,color:selectedColor,imagenUrl:pendingTlImagenUrl||null,privada});
    hideModal('modal-nueva');
    await openTimeline(ref.id);
    toast('Línea de tiempo creada ✓');
    writePromise.catch(e=>{
      console.error('La línea se abrió, pero no se pudo guardar todavía en Firebase:', e);
      toast('La línea se abrió, pero Firebase no respondió. Revisa tu conexión o reglas.', 6000);
    });
  } catch(e){
    toast(friendlyFirestoreError(e), 6000);
    console.error('Error al crear línea de tiempo:', e);
  } finally {
    isCreatingTimeline=false;
    btnCrear.disabled=false;
    btnCrear.textContent='Crear';
  }
}

// ─── IMÁGENES (galería del editor de evento) ───────────────
function renderImageGalleryEditor(){
  const editor=document.getElementById('img-gallery-editor');
  if(!editor) return;
  const thumbs=pendingImages.map((src,i)=>`
    <div class="img-gallery-thumb" data-index="${i}">
      <img src="${escHtml(src)}" alt=""/>
      <button type="button" class="img-gallery-thumb-remove" data-index="${i}" title="Quitar imagen">✕</button>
    </div>`).join('');
  const uploadingTiles=Array.from({length:activeUploadsCount}).map(()=>
    `<div class="img-gallery-uploading">Subiendo…</div>`
  ).join('');
  editor.innerHTML=thumbs+uploadingTiles+`
    <button type="button" class="img-add-tile" id="img-add-tile">
      <span class="img-icon">🖼</span>
      <span>Agregar imagen</span>
    </button>`;
  editor.querySelectorAll('.img-gallery-thumb-remove').forEach(btn=>{
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const idx=Number(btn.dataset.index);
      pendingImages.splice(idx,1);
      renderImageGalleryEditor();
    });
  });
  const addTile=document.getElementById('img-add-tile');
  if(addTile) addTile.addEventListener('click',()=>document.getElementById('ev-imagen').click());
}

// ─── IMAGEN DE FONDO DE LA LÍNEA DE TIEMPO (una sola imagen) ────
// Se reutiliza el mismo look de la galería de eventos (.img-gallery-editor),
// pero acá solo se admite una imagen por línea de tiempo.
function renderTlImagenEditor(editorId, imageUrl, subiendo, onQuitar, onAgregar){
  const editor=document.getElementById(editorId);
  if(!editor) return;
  if(subiendo){
    editor.innerHTML=`<div class="img-gallery-uploading">Subiendo…</div>`;
    return;
  }
  if(imageUrl){
    editor.innerHTML=`
      <div class="img-gallery-thumb">
        <img src="${escHtml(imageUrl)}" alt=""/>
        <button type="button" class="img-gallery-thumb-remove" title="Quitar imagen">✕</button>
      </div>`;
    editor.querySelector('.img-gallery-thumb-remove').addEventListener('click',e=>{
      e.stopPropagation();
      onQuitar();
    });
    return;
  }
  editor.innerHTML=`
    <button type="button" class="img-add-tile" id="${editorId}-add-tile">
      <span class="img-icon">🖼</span>
      <span>Agregar imagen</span>
    </button>`;
  document.getElementById(`${editorId}-add-tile`).addEventListener('click',onAgregar);
}

function renderNuevaTlImagen(){
  renderTlImagenEditor('tl-imagen-editor', pendingTlImagenUrl, pendingTlImagenSubiendo,
    ()=>{ pendingTlImagenUrl=null; renderNuevaTlImagen(); },
    ()=>document.getElementById('input-tl-imagen').click());
}

function renderEditTlImagen(){
  renderTlImagenEditor('edit-tl-imagen-editor', editTlImagenUrl, editTlImagenSubiendo,
    ()=>{ editTlImagenUrl=null; renderEditTlImagen(); },
    ()=>document.getElementById('edit-tl-imagen').click());
}

function cargarImagenLocal(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality){
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if(blob) resolve(blob);
      else reject(new Error('No se pudo comprimir la imagen'));
    }, type, quality);
  });
}

async function comprimirImagen(file){
  const MAX_LADO = 1400;
  const CALIDAD = 0.7;
  const img = await cargarImagenLocal(file);
  const anchoOriginal = img.naturalWidth || img.width;
  const altoOriginal = img.naturalHeight || img.height;
  const escala = Math.min(1, MAX_LADO / Math.max(anchoOriginal, altoOriginal));
  const ancho = Math.max(1, Math.round(anchoOriginal * escala));
  const alto = Math.max(1, Math.round(altoOriginal * escala));
  const canvas = document.createElement('canvas');
  canvas.width = ancho;
  canvas.height = alto;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ancho, alto);
  ctx.drawImage(img, 0, 0, ancho, alto);

  const blob = await canvasToBlob(canvas, 'image/jpeg', CALIDAD);
  if(blob.size >= file.size && file.size <= 900 * 1024){
    return file;
  }

  const nombreBase = (file.name || 'imagen').replace(/\.[^.]+$/, '');
  return new File([blob], `${nombreBase}-comprimida.jpg`, {
    type: 'image/jpeg',
    lastModified: Date.now()
  });
}

async function subirUnaImagen(file){
  if(!file.type.startsWith('image/')){ toast('El archivo debe ser una imagen.'); return; }
  if(file.size>20*1024*1024){ toast('Imagen muy grande. Máximo 20 MB.'); return; }
  activeUploadsCount++;
  renderImageGalleryEditor();
  try {
    const imagenComprimida = await comprimirImagen(file);
    const url = await subirImagenCloudinary(imagenComprimida);
    pendingImages.push(url);
  } catch(e){
    console.error(e);
    toast('No se pudo subir una imagen. Intenta de nuevo.');
  } finally {
    activeUploadsCount--;
    renderImageGalleryEditor();
  }
}

function handleImageFiles(files){
  const lista=[...(files||[])];
  if(!lista.length) return;
  lista.forEach(subirUnaImagen);
}

function selectColor(color){
  selectedColor=color;
  document.querySelectorAll('.color-dot:not(.edit-tl-color)').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.color===color);
  });
}

async function logout(){
  invalidateCache();
  await signOut(auth);
  toast('Sesión cerrada');
}

// ─── AUTH STATE ───────────────────────────────────────────
onAuthStateChanged(auth, async user=>{
  currentUser=user;
  isRoot=!!(user&&user.email&&user.email.toLowerCase()===ROOT_EMAIL.toLowerCase());

  // Muestra la nota de deploy solo si el usuario logueado es root.
  document.getElementById('nota-deploy-root').classList.toggle('hidden', !isRoot);

  // Muestra el botón para volver a "Lo Mío" solo si el usuario es root.
  document.getElementById('btn-lo-mio-root').classList.toggle('hidden', !isRoot);

  // El botón "Solicitudes" (revisar líneas sugeridas para el inicio)
  // solo lo ve el usuario root.
  document.getElementById('btn-solicitudes').classList.toggle('hidden', !isRoot);
  if(isRoot) refreshSolicitudesBadge();
  else document.getElementById('solicitudes-badge').classList.add('hidden');

  if(user){
    const screenAuth=document.getElementById('screen-auth');
    if(!screenAuth.classList.contains('hidden')){
      await renderHome();
    } else if(document.getElementById('screen-home').classList.contains('active')){
      await renderHome();
    } else if(document.getElementById('screen-perfil').classList.contains('active') && viewingProfileUid){
      await renderPerfil(viewingProfileUid);
    } else if(document.getElementById('screen-solicitudes').classList.contains('active')){
      await renderSolicitudes();
    } else {
      updateHeader(user);
    }
  } else {
    updateHeader(null);
  }
});

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{

  document.getElementById('btn-acceder').addEventListener('click',showAuth);
  document.getElementById('btn-nueva').addEventListener('click',openModalNueva);
  document.getElementById('btn-logout').addEventListener('click',logout);
  document.getElementById('btn-mi-perfil').addEventListener('click',()=>{
    if(!currentUser){ showAuth(); return; }
    renderPerfil(currentUser.uid);
  });
  document.getElementById('btn-perfil-back').addEventListener('click',renderHome);
  document.getElementById('btn-nueva-perfil').addEventListener('click',openModalNueva);
  document.getElementById('btn-toggle-perfil-stats').addEventListener('click',()=>{
    perfilViewMode = perfilViewMode==='stats' ? 'lineas' : 'stats';
    applyPerfilViewMode();
  });
  document.getElementById('btn-solicitudes').addEventListener('click',renderSolicitudes);
  document.getElementById('btn-solicitudes-back').addEventListener('click',renderHome);

  document.getElementById('btn-activar-seleccion').addEventListener('click',()=>setModoSeleccion(true));
  document.getElementById('btn-cancelar-seleccion').addEventListener('click',()=>setModoSeleccion(false));
  document.getElementById('btn-eliminar-seleccionadas').addEventListener('click',eliminarSeleccionadas);

  setupAuthTabs();
  document.getElementById('btn-google-login').addEventListener('click',loginWithGoogle);
  document.getElementById('btn-google-register').addEventListener('click',loginWithGoogle);
  document.getElementById('btn-login-email').addEventListener('click',loginWithEmail);
  document.getElementById('btn-register-email').addEventListener('click',registerWithEmail);
  document.getElementById('btn-login-phone').addEventListener('click',sendPhoneSMS);
  document.getElementById('btn-verify-phone').addEventListener('click',verifyPhoneCode);
  document.getElementById('btn-auth-back').addEventListener('click',renderHome);

  ['login-email','login-password'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') loginWithEmail(); });
  });
  ['reg-nombre','reg-email','reg-password'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') registerWithEmail(); });
  });

  document.getElementById('modal-close-nueva').addEventListener('click',()=>hideModal('modal-nueva'));
  document.getElementById('btn-crear-confirmar').addEventListener('click',crearTimeline);
  ['input-nombre','input-desc'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') crearTimeline(); });
  });

  document.getElementById('modal-close-editar-tl').addEventListener('click',()=>hideModal('modal-editar-tl'));
  document.getElementById('btn-edit-tl').addEventListener('click',openModalEditarTimeline);
  document.getElementById('btn-editar-tl-confirmar').addEventListener('click',guardarEdicionTimeline);
  document.getElementById('btn-add-timeline-note').addEventListener('click',()=>{
    const tl=_timelineCache[activeTimelineId];
    addTimelineNoteRow({},ordenarEventos((tl&&tl.eventos)||[]));
  });
  ['edit-tl-nombre','edit-tl-desc'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown',e=>{ if(e.key==='Enter') guardarEdicionTimeline(); });
  });
  document.querySelectorAll('.edit-tl-color').forEach(btn=>{
    btn.addEventListener('click',()=>selectEditColor(btn.dataset.color));
  });
  document.getElementById('modal-editar-tl').addEventListener('click',function(e){ if(e.target===this) hideModal('modal-editar-tl'); });

  const btnDelTl=document.getElementById('btn-delete-tl');
  if(btnDelTl) btnDelTl.addEventListener('click',eliminarTimeline);

  document.getElementById('btn-back').addEventListener('click',async()=>{
    if(!closeEventModal()) return;
    document.documentElement.style.setProperty('--accent','#E8845A');
    document.documentElement.style.setProperty('--accent-glow','rgba(232,132,90,0.18)');
    await goBackToList();
  });
  document.getElementById('btn-add-event').addEventListener('click',()=>openModalEvento(null));

  document.getElementById('modal-close-evento').addEventListener('click',()=>closeEventModal());
  document.getElementById('btn-guardar-evento').addEventListener('click',guardarEvento);
  document.getElementById('btn-eliminar-evento').addEventListener('click',eliminarEvento);
  document.getElementById('btn-add-sub-event').addEventListener('click',()=>addSubtimelineRow());

  document.getElementById('input-tl-imagen').addEventListener('change',async e=>{
    const file=e.target.files[0];
    e.target.value='';
    if(!file) return;
    pendingTlImagenSubiendo=true;
    renderNuevaTlImagen();
    try {
      pendingTlImagenUrl=await subirImagenCloudinary(file);
    } catch(err){
      console.error(err);
      toast('No se pudo subir la imagen. Intenta de nuevo.');
    } finally {
      pendingTlImagenSubiendo=false;
      renderNuevaTlImagen();
    }
  });

  document.getElementById('edit-tl-imagen').addEventListener('change',async e=>{
    const file=e.target.files[0];
    e.target.value='';
    if(!file) return;
    editTlImagenSubiendo=true;
    renderEditTlImagen();
    try {
      editTlImagenUrl=await subirImagenCloudinary(file);
    } catch(err){
      console.error(err);
      toast('No se pudo subir la imagen. Intenta de nuevo.');
    } finally {
      editTlImagenSubiendo=false;
      renderEditTlImagen();
    }
  });

  const galleryEditor=document.getElementById('img-gallery-editor');
  document.getElementById('ev-imagen').addEventListener('change',e=>{
    handleImageFiles(e.target.files);
    e.target.value='';
  });
  galleryEditor.addEventListener('dragover',e=>{ e.preventDefault(); galleryEditor.style.outline='2px dashed var(--accent)'; });
  galleryEditor.addEventListener('dragleave',()=>{ galleryEditor.style.outline=''; });
  galleryEditor.addEventListener('drop',e=>{
    e.preventDefault();
    galleryEditor.style.outline='';
    const files=[...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'));
    handleImageFiles(files);
  });

  document.getElementById('modal-close-ver').addEventListener('click',()=>hideModal('modal-ver'));
  document.getElementById('btn-editar-desde-ver').addEventListener('click',()=>{ const id=editingEventId; hideModal('modal-ver'); openModalEvento(id); });

  document.getElementById('lightbox-close').addEventListener('click',closeLightbox);
  document.getElementById('lightbox').addEventListener('click',e=>{ if(e.target.id==='lightbox') closeLightbox(); });
  document.getElementById('lightbox-img').addEventListener('click',lightboxSiguiente);
  document.getElementById('lightbox-next').addEventListener('click',e=>{ e.stopPropagation(); lightboxSiguiente(); });
  document.getElementById('lightbox-prev').addEventListener('click',e=>{ e.stopPropagation(); lightboxAnterior(); });
  document.addEventListener('keydown',e=>{
    if(document.getElementById('lightbox').classList.contains('hidden')) return;
    if(e.key==='Escape') closeLightbox();
    else if(e.key==='ArrowRight') lightboxSiguiente();
    else if(e.key==='ArrowLeft') lightboxAnterior();
  });

  document.querySelectorAll('.color-dot:not(.edit-tl-color)').forEach(btn=>{
    btn.addEventListener('click',()=>selectColor(btn.dataset.color));
  });
  selectColor('#E8845A');

  ['modal-nueva','modal-ver'].forEach(id=>{
    document.getElementById(id).addEventListener('click',function(e){ if(e.target===this) hideModal(id); });
  });
  document.getElementById('modal-evento').addEventListener('click',function(e){ if(e.target===this) closeEventModal(); });

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      ['modal-nueva','modal-ver','modal-editar-tl'].forEach(id=>hideModal(id));
      closeEventModal();
    }
  });

  window.addEventListener('beforeunload',e=>{
    if(hasUnsavedEventDraft()){
      e.preventDefault();
      e.returnValue='';
    }
  });

  renderHome();
});
