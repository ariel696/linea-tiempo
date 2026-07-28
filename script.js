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
    ownerName:currentUser.displayName||currentUser.email||'Usuario'
  });
  const createdTimeline = {
    id: ref.id,
    ...data,
    eventos: [],
    ownerId: currentUser.uid,
    ownerName: currentUser.displayName || currentUser.email || 'Usuario'
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

async function renderHome(){
  const seq=++_renderHomeSeq;
  showScreen('home');
  updateHeader(currentUser);
  const grid=document.getElementById('timelines-grid');
  const empty=document.getElementById('empty-state');
  grid.innerHTML='';
  grid.appendChild(empty);

  let timelines=[];
  try { timelines=await fetchTimelines(); } catch(e){ console.error(e); }
  if(seq!==_renderHomeSeq) return;

  const otras=timelines;

  // ¿Hay al menos una línea de tiempo que el usuario actual puede borrar?
  // Si no hay ninguna, no tiene sentido mostrarle el botón "Seleccionar".
  const hayBorrables = otras.some(tl=>canEdit(tl));
  const btnActivar = document.getElementById('btn-activar-seleccion');
  btnActivar.classList.toggle('hidden', !hayBorrables);

  if(otras.length===0){
    empty.style.display='block';
  } else {
    empty.style.display='none';
    otras.forEach((tl,i)=>{
      const card=document.createElement('div');
      card.className='timeline-card';
      card.style.setProperty('--card-accent',tl.color||'#E8845A');
      card.style.animationDelay=(i*0.07)+'s';
      const count=(tl.eventos||[]).length;
      const esPropia=currentUser&&tl.ownerId===currentUser.uid;
      const ownerLabel=tl.ownerName?`<span class="card-owner">por ${escHtml(tl.ownerName)}</span>`:'';
      const propiaLabel=esPropia?`<span class="card-owner card-owner--propia">✎ Tuya</span>`:ownerLabel;
      const puedeBorrar=canEdit(tl);
      // El checkbox solo se dibuja si estamos en modo selección Y el
      // usuario tiene permiso de borrar esta línea de tiempo en particular.
      const checkboxHtml = (modoSeleccion && puedeBorrar)
        ? `<label class="card-checkbox">
             <input type="checkbox" class="card-checkbox-input" data-id="${tl.id}" ${idsSeleccionados.has(tl.id)?'checked':''}/>
           </label>`
        : '';
      card.innerHTML=`
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
      grid.appendChild(card);
    });
  }
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
async function openTimeline(id){
  activeTimelineId=id;
  const tl=await getTimeline(id);
  if(!tl) return;

  const puedeEditar=canEdit(tl);

  document.documentElement.style.setProperty('--accent',tl.color||'#E8845A');
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(tl.color||'#E8845A',0.18));
  document.getElementById('editor-title').textContent=tl.nombre;
  document.getElementById('editor-desc').textContent=tl.desc||'';

  const ownerEl=document.getElementById('editor-owner');
  if(ownerEl){
    if(!puedeEditar&&tl.ownerName){ ownerEl.textContent=`por ${tl.ownerName}`; ownerEl.classList.remove('hidden'); }
    else { ownerEl.classList.add('hidden'); }
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
  selectEditColor(tl.color||'#E8845A');
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
  const color=selectedEditColor;
  const lecturas=getTimelineNotesFromEditor();
  const relatedTimelineIds=normalizeRelatedTimelineIds(getRelatedTimelineIdsFromEditor());
  const tl=_timelineCache[activeTimelineId];
  _timelineCache[activeTimelineId]={...tl,nombre,desc,color,lecturas,relatedTimelineIds};
  document.getElementById('editor-title').textContent=nombre;
  document.getElementById('editor-desc').textContent=desc;
  document.documentElement.style.setProperty('--accent',color);
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(color,0.18));
  renderTimelineFromCache(_timelineCache[activeTimelineId]);
  hideModal('modal-editar-tl');
  toast('Línea de tiempo actualizada ✓');
  try {
    await updateTimeline(activeTimelineId,{nombre,desc,color,lecturas,relatedTimelineIds});
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
    await renderHome();
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
    if(_timelineCache[activeTimelineId]){
      _timelineCache[activeTimelineId]={..._timelineCache[activeTimelineId],eventos:eventosOrdenados};
    }
    await updateTimeline(activeTimelineId,{eventos:eventosOrdenados});
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
  _timelineCache[activeTimelineId]={...tl,eventos};
  closeEventModal(true);
  hideModal('modal-ver');
  toast('Evento eliminado');
  renderTimelineFromCache(_timelineCache[activeTimelineId]);
  try {
    await updateTimeline(activeTimelineId,{eventos});
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
  selectColor('#E8845A');
  showModal('modal-nueva');
}

async function crearTimeline(){
  if(isCreatingTimeline) return;
  const nombre=document.getElementById('input-nombre').value.trim();
  if(!nombre){ shake(document.getElementById('input-nombre')); return; }
  if(!currentUser){ toast('Debes iniciar sesión primero.'); return; }
  const desc=document.getElementById('input-desc').value.trim();
  const btnCrear=document.getElementById('btn-crear-confirmar');
  isCreatingTimeline=true;
  btnCrear.disabled=true;
  btnCrear.textContent='Creando...';

  try {
    const {ref, writePromise}=createTimeline({nombre,desc,color:selectedColor});
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

  if(user){
    const screenAuth=document.getElementById('screen-auth');
    if(!screenAuth.classList.contains('hidden')){
      await renderHome();
    } else if(document.getElementById('screen-home').classList.contains('active')){
      await renderHome();
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
    await renderHome();
  });
  document.getElementById('btn-add-event').addEventListener('click',()=>openModalEvento(null));

  document.getElementById('modal-close-evento').addEventListener('click',()=>closeEventModal());
  document.getElementById('btn-guardar-evento').addEventListener('click',guardarEvento);
  document.getElementById('btn-eliminar-evento').addEventListener('click',eliminarEvento);
  document.getElementById('btn-add-sub-event').addEventListener('click',()=>addSubtimelineRow());

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
