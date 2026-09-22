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
  runTransaction,
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
let activeTimelineSectionFilter = '';
let editingEventId     = null;
let selectedColor      = "#E8845A";
let selectedEditColor  = "#E8845A";
let selectedFondo      = "liso";
let selectedEditFondo  = "liso";
let editHashtags       = [];
let pendingImages       = [];
let activeUploadsCount  = 0;
let eventDraftSnapshot = null;
let confirmationResult = null;
let isSavingEvent      = false;
let isCreatingTimeline = false;
let viewingProfileUid  = null;
let viewingProfileUsername = '';
let lastListScreen     = 'home';

// Estado de búsqueda/orden de las grillas de líneas de tiempo (inicio y perfil).
// Se mantienen por separado porque son pantallas distintas con sus propios controles.
let homeSortBy       = 'recent';
let homeSearchQuery  = '';
let _homeTimelinesRaw  = [];
let _homeSearchTimelinesRaw = [];

let perfilSortBy      = 'recent';
let perfilSearchQuery = '';
let _perfilTimelinesRaw = [];

// Vista activa dentro del perfil/muro: 'lineas' (grilla normal) o
// 'stats' (resumen tipo "logros"). Se resetea a 'lineas' cada vez que
// se entra a un perfil distinto, para no dejar a alguien "atrapado"
// en la vista de estadísticas de otra persona.
let perfilViewMode = 'lineas';
let initialRouteHandled = false;

let relatedEditorCurrentId = null;
let relatedEditorSelectedIds = [];
let relatedEditorOptions = [];

// Imagen de fondo de la línea de tiempo (modal Nueva y modal Editar).
// Solo una imagen por línea, a diferencia de la galería de eventos.
let pendingTlImagenUrl      = null;
let pendingTlImagenSubiendo = false;
let editTlImagenUrl         = null;
let editTlImagenSubiendo    = false;

let _timelinesCache = null;
let _timelineCache  = {};
let _pendingTimelineWrites = {};
let _userProfileCache = {};
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

// ─── INFORMACIÓN DETALLADA (estado de verificación) ────────
// El estado "Falta verificar" / "Información verificada" solo se ve si el
// espectador marca la casilla "Información detallada" de la barra del editor.
(function setupDetailToggle(){
  const chk=document.getElementById('chk-info-detallada');
  if(!chk) return;
  const apply=()=>document.body.classList.toggle('show-verify-details',chk.checked);
  chk.addEventListener('change',apply);
  apply();
})();

// ─── PAÍS DEL EVENTO (bandera circular) ───────────────────
// Nombre del país (tal como aparece en el selector) -> código ISO de 2 letras.
const PAIS_CODIGOS = {
  "Afganistán": "af",
  "Albania": "al",
  "Alemania": "de",
  "Andorra": "ad",
  "Angola": "ao",
  "Antigua y Barbuda": "ag",
  "Arabia Saudita": "sa",
  "Argelia": "dz",
  "Argentina": "ar",
  "Armenia": "am",
  "Australia": "au",
  "Austria": "at",
  "Azerbaiyán": "az",
  "Bahamas": "bs",
  "Bangladés": "bd",
  "Barbados": "bb",
  "Baréin": "bh",
  "Bélgica": "be",
  "Belice": "bz",
  "Benín": "bj",
  "Bielorrusia": "by",
  "Bolivia": "bo",
  "Bosnia y Herzegovina": "ba",
  "Botsuana": "bw",
  "Brasil": "br",
  "Brunéi": "bn",
  "Bulgaria": "bg",
  "Burkina Faso": "bf",
  "Burundi": "bi",
  "Bután": "bt",
  "Cabo Verde": "cv",
  "Camboya": "kh",
  "Camerún": "cm",
  "Canadá": "ca",
  "Catar": "qa",
  "Chad": "td",
  "Chile": "cl",
  "China": "cn",
  "Chipre": "cy",
  "Ciudad del Vaticano": "va",
  "Colombia": "co",
  "Comoras": "km",
  "Corea del Norte": "kp",
  "Corea del Sur": "kr",
  "Costa de Marfil": "ci",
  "Costa Rica": "cr",
  "Croacia": "hr",
  "Cuba": "cu",
  "Dinamarca": "dk",
  "Dominica": "dm",
  "Ecuador": "ec",
  "Egipto": "eg",
  "El Salvador": "sv",
  "Emiratos Árabes Unidos": "ae",
  "Eritrea": "er",
  "Eslovaquia": "sk",
  "Eslovenia": "si",
  "España": "es",
  "Estados Unidos": "us",
  "Estonia": "ee",
  "Esuatini": "sz",
  "Etiopía": "et",
  "Filipinas": "ph",
  "Finlandia": "fi",
  "Fiyi": "fj",
  "Francia": "fr",
  "Gabón": "ga",
  "Gambia": "gm",
  "Georgia": "ge",
  "Ghana": "gh",
  "Granada": "gd",
  "Grecia": "gr",
  "Guatemala": "gt",
  "Guinea": "gn",
  "Guinea-Bisáu": "gw",
  "Guinea Ecuatorial": "gq",
  "Guyana": "gy",
  "Haití": "ht",
  "Honduras": "hn",
  "Hungría": "hu",
  "India": "in",
  "Indonesia": "id",
  "Irak": "iq",
  "Irán": "ir",
  "Irlanda": "ie",
  "Islandia": "is",
  "Islas Marshall": "mh",
  "Islas Salomón": "sb",
  "Israel": "il",
  "Italia": "it",
  "Jamaica": "jm",
  "Japón": "jp",
  "Jordania": "jo",
  "Kazajistán": "kz",
  "Kenia": "ke",
  "Kirguistán": "kg",
  "Kiribati": "ki",
  "Kosovo": "xk",
  "Kuwait": "kw",
  "Laos": "la",
  "Lesoto": "ls",
  "Letonia": "lv",
  "Líbano": "lb",
  "Liberia": "lr",
  "Libia": "ly",
  "Liechtenstein": "li",
  "Lituania": "lt",
  "Luxemburgo": "lu",
  "Macedonia del Norte": "mk",
  "Madagascar": "mg",
  "Malasia": "my",
  "Malaui": "mw",
  "Maldivas": "mv",
  "Malí": "ml",
  "Malta": "mt",
  "Marruecos": "ma",
  "Mauricio": "mu",
  "Mauritania": "mr",
  "México": "mx",
  "Micronesia": "fm",
  "Moldavia": "md",
  "Mónaco": "mc",
  "Mongolia": "mn",
  "Montenegro": "me",
  "Mozambique": "mz",
  "Myanmar": "mm",
  "Namibia": "na",
  "Nauru": "nr",
  "Nepal": "np",
  "Nicaragua": "ni",
  "Níger": "ne",
  "Nigeria": "ng",
  "Noruega": "no",
  "Nueva Zelanda": "nz",
  "Omán": "om",
  "Países Bajos": "nl",
  "Pakistán": "pk",
  "Palaos": "pw",
  "Palestina": "ps",
  "Panamá": "pa",
  "Papúa Nueva Guinea": "pg",
  "Paraguay": "py",
  "Perú": "pe",
  "Polonia": "pl",
  "Portugal": "pt",
  "Reino Unido": "gb",
  "República Centroafricana": "cf",
  "República Checa": "cz",
  "República del Congo": "cg",
  "República Democrática del Congo": "cd",
  "República Dominicana": "do",
  "Ruanda": "rw",
  "Rumania": "ro",
  "Rusia": "ru",
  "Samoa": "ws",
  "San Cristóbal y Nieves": "kn",
  "San Marino": "sm",
  "San Vicente y las Granadinas": "vc",
  "Santa Lucía": "lc",
  "Santo Tomé y Príncipe": "st",
  "Senegal": "sn",
  "Serbia": "rs",
  "Seychelles": "sc",
  "Sierra Leona": "sl",
  "Singapur": "sg",
  "Siria": "sy",
  "Somalia": "so",
  "Sri Lanka": "lk",
  "Sudáfrica": "za",
  "Sudán": "sd",
  "Sudán del Sur": "ss",
  "Suecia": "se",
  "Suiza": "ch",
  "Surinam": "sr",
  "Tailandia": "th",
  "Taiwán": "tw",
  "Tanzania": "tz",
  "Tayikistán": "tj",
  "Timor Oriental": "tl",
  "Togo": "tg",
  "Tonga": "to",
  "Trinidad y Tobago": "tt",
  "Túnez": "tn",
  "Turkmenistán": "tm",
  "Turquía": "tr",
  "Tuvalu": "tv",
  "Ucrania": "ua",
  "Uganda": "ug",
  "Uruguay": "uy",
  "Uzbekistán": "uz",
  "Vanuatu": "vu",
  "Venezuela": "ve",
  "Vietnam": "vn",
  "Yemen": "ye",
  "Yibuti": "dj",
  "Zambia": "zm",
  "Zimbabue": "zw"
};

function getCountryFlagUrl(code){
  return 'https://hatscripts.github.io/circle-flags/flags/'+code+'.svg';
}

// Deja el país en su forma oficial (ignora mayúsculas y tildes). Si no existe, devuelve ''.
function normalizeCountryName(value){
  const clean=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  const wanted=clean(value);
  if(!wanted) return '';
  return Object.keys(PAIS_CODIGOS).find(name=>clean(name)===wanted)||'';
}

function getEventCountryValue(){
  const el=document.getElementById('ev-pais');
  return el?normalizeCountryName(el.value):'';
}

function setEventCountryValue(value){
  const el=document.getElementById('ev-pais');
  if(el) el.value=value||'';
}

// Banderita circular para la esquina superior derecha de la tarjeta.
function getCountryFlagHtml(ev){
  const pais=ev&&ev.pais;
  const code=pais&&PAIS_CODIGOS[pais];
  if(!code) return '';
  return `<img class="event-flag" src="${getCountryFlagUrl(code)}" alt="${escHtml(pais)}" title="${escHtml(pais)}" loading="lazy" draggable="false" onerror="this.remove()"/>`;
}

// País (con su bandera) en la ventana "Ver evento".
function renderEventCountryView(ev){
  const el=document.getElementById('ver-pais');
  if(!el) return;
  const pais=ev&&ev.pais;
  const code=pais&&PAIS_CODIGOS[pais];
  if(!code){
    el.className='event-country-pill hidden';
    el.innerHTML='';
    return;
  }
  el.innerHTML=`<img class="event-country-flag" src="${getCountryFlagUrl(code)}" alt="" onerror="this.remove()"/><span>${escHtml(pais)}</span>`;
  el.className='event-country-pill';
}
function hexToAlpha(hex,a){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return `rgba(${r},${g},${b},${a})`; }

// ─── DISEÑO DE FONDO DE LA LÍNEA DE TIEMPO ────────────────
// Cada línea guarda su diseño en el campo "fondo". Los estilos de cada
// uno viven en style.css (bloque "DISEÑO DE FONDO"); aquí solo se elige y
// se aplica con data-fondo sobre el área de la línea de tiempo.
const FONDOS=['liso','cuadricula','puntos','lineas','degradado','resplandor'];

function normalizeFondo(v){ return FONDOS.includes(v)?v:'liso'; }

function selectFondo(scope,fondo){
  fondo=normalizeFondo(fondo);
  if(scope==='editar') selectedEditFondo=fondo; else selectedFondo=fondo;
  const picker=document.getElementById(`fondo-picker-${scope}`);
  if(picker) picker.querySelectorAll('.fondo-option').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.fondo===fondo);
  });
}

// Las vistas previas de "Degradado" y "Resplandor" usan el color de acento
// que la persona tiene elegido en ese momento.
function setFondoPickerAccent(scope,color){
  const picker=document.getElementById(`fondo-picker-${scope}`);
  if(!picker||!color) return;
  picker.style.setProperty('--fondo-accent',color);
  picker.style.setProperty('--fondo-glow',hexToAlpha(color,0.18));
}

function applyTimelineFondo(fondo){
  const wrapper=document.getElementById('timeline-scroll-wrapper');
  if(wrapper) wrapper.dataset.fondo=normalizeFondo(fondo);
}

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

// ─── HASHTAGS ─────────────────────────────────────────────
// Cada línea guarda "hashtags": un arreglo de palabras (sin el #). El buscador
// del inicio y del perfil también las mira, así una línea puede aparecer
// cuando se busca una palabra relacionada aunque no esté en su nombre.
const MAX_HASHTAGS=10;

// Minúsculas y sin tildes, para que "películas" y "peliculas" coincidan.
function normalizeSearchText(str){
  return String(str||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

// Deja solo letras, números y guion bajo (se conservan las tildes).
function sanitizeHashtag(raw){
  return String(raw||'').trim().replace(/^#+/,'').toLowerCase().replace(/[^\p{L}\p{N}_]/gu,'').slice(0,30);
}

function normalizeHashtags(list){
  const seen=new Set();
  const out=[];
  (Array.isArray(list)?list:[]).forEach(raw=>{
    const tag=sanitizeHashtag(raw);
    const key=normalizeSearchText(tag);
    if(!tag||seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  });
  return out.slice(0,MAX_HASHTAGS);
}

// Todo el texto por el que se puede encontrar una línea, ya normalizado.
function timelineSearchText(tl){
  return normalizeSearchText([tl.nombre||'',tl.desc||'',tl.ownerName||'',...(tl.hashtags||[])].join(' '));
}

function renderHashtagsEditor(){
  const chips=document.getElementById('hashtags-chips');
  const input=document.getElementById('hashtags-input');
  if(chips) chips.innerHTML=editHashtags.map(tag=>
    `<button type="button" class="hashtag-chip" data-tag="${escHtml(tag)}" title="Quitar">#${escHtml(tag)} <span>×</span></button>`
  ).join('');
  if(input) input.placeholder=editHashtags.length?'Agregar otro...':'Ej: anime, toei, clásicos';
}

function addHashtagTokens(tokens){
  for(const token of tokens){
    const tag=sanitizeHashtag(token);
    if(!tag) continue;
    if(editHashtags.some(t=>normalizeSearchText(t)===normalizeSearchText(tag))) continue;
    if(editHashtags.length>=MAX_HASHTAGS){ toast(`Máximo ${MAX_HASHTAGS} hashtags.`); break; }
    editHashtags.push(tag);
  }
  renderHashtagsEditor();
}

// Convierte en hashtag lo que quedó escrito en la caja (al presionar Enter,
// al salir del campo o al guardar la línea).
function commitHashtagInput(){
  const input=document.getElementById('hashtags-input');
  if(!input||!input.value) return;
  const value=input.value;
  input.value='';
  addHashtagTokens(value.split(/[\s,#]+/));
}

function setupHashtagsEditor(){
  const box=document.getElementById('hashtags-box');
  const chips=document.getElementById('hashtags-chips');
  const input=document.getElementById('hashtags-input');
  if(!box||!chips||!input) return;
  box.addEventListener('click',e=>{ if(e.target===box) input.focus(); });
  chips.addEventListener('click',e=>{
    const chip=e.target.closest('.hashtag-chip');
    if(!chip) return;
    editHashtags=editHashtags.filter(t=>t!==chip.dataset.tag);
    renderHashtagsEditor();
    input.focus();
  });
  // Un espacio, coma o # cierra la palabra actual (también al pegar varias).
  input.addEventListener('input',()=>{
    const value=input.value;
    if(!/[\s,#]/.test(value)) return;
    const parts=value.split(/[\s,#]+/);
    const last=/[\s,#]$/.test(value)?'':parts.pop();
    addHashtagTokens(parts);
    input.value=last;
  });
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      commitHashtagInput();
    } else if(e.key==='Backspace'&&!input.value&&editHashtags.length){
      editHashtags.pop();
      renderHashtagsEditor();
    }
  });
  input.addEventListener('blur',commitHashtagInput);
}

const SOCIAL_PLATFORMS = [
  { key:'instagram', label:'Instagram', base:'https://www.instagram.com/' },
  { key:'facebook', label:'Facebook', base:'https://www.facebook.com/' },
  { key:'youtube', label:'YouTube', base:'https://www.youtube.com/' },
  { key:'kick', label:'Kick', base:'https://kick.com/' },
  { key:'tiktok', label:'TikTok', base:'https://www.tiktok.com/@' }
];

function normalizeSocialUrl(platformKey,value){
  let v=String(value||'').trim();
  if(!v) return '';
  if(/^https?:\/\//i.test(v)) return v;
  if(/^www\./i.test(v)) return `https://${v}`;
  v=v.replace(/^@/,'').replace(/^\/+/,'').trim();
  if(!v) return '';
  const platform=SOCIAL_PLATFORMS.find(p=>p.key===platformKey);
  if(!platform) return '';
  if(platformKey==='youtube') return platform.base+(v.includes('/')?v:'@'+v);
  if(platformKey==='tiktok') return platform.base+v.replace(/^@/,'');
  return platform.base+v;
}

function getSocialsFromInputs(prefix){
  return SOCIAL_PLATFORMS.reduce((out,platform)=>{
    const input=document.getElementById(`${prefix}-social-${platform.key}`);
    const url=normalizeSocialUrl(platform.key,input&&input.value);
    if(url) out[platform.key]=url;
    return out;
  },{});
}

function setSocialInputs(prefix,socials={}){
  SOCIAL_PLATFORMS.forEach(platform=>{
    const input=document.getElementById(`${prefix}-social-${platform.key}`);
    if(input) input.value=(socials&&socials[platform.key])||'';
  });
}

function hasSocialLinks(socials={}){
  return SOCIAL_PLATFORMS.some(platform=>!!(socials&&socials[platform.key]));
}

function normalizeUsername(value){
  return String(value||'')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^[._-]+|[._-]+$/g,'')
    .slice(0,32);
}

function isValidUsername(username){
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username||'');
}

function suggestUsernameFromUser(user=currentUser){
  const base=(user&&user.displayName) || (user&&user.email&&user.email.split('@')[0]) || 'usuario';
  return normalizeUsername(base) || 'usuario';
}

async function getUserProfile(uid){
  if(!uid) return null;
  if(_userProfileCache[uid]) return _userProfileCache[uid];
  const snap=await getDoc(doc(db,'users',uid));
  const profile=snap.exists()?{uid,...snap.data()}:null;
  if(profile) _userProfileCache[uid]=profile;
  return profile;
}

async function getUidByUsername(username){
  const clean=normalizeUsername(username);
  if(!clean) return '';
  const snap=await getDoc(doc(db,'usernames',clean));
  return snap.exists() ? (snap.data().uid||'') : '';
}

function getMyUsername(){
  return currentUser && _userProfileCache[currentUser.uid]
    ? (_userProfileCache[currentUser.uid].username||'')
    : '';
}

async function guardarIdentidadPerfil({displayName,username}){
  if(!currentUser) return null;
  const cleanUsername=normalizeUsername(username);
  if(!isValidUsername(cleanUsername)){
    const err=new Error('El nombre de usuario debe tener 3 a 32 caracteres y empezar con letra o número.');
    err.code='invalid-username';
    throw err;
  }
  const uid=currentUser.uid;
  const userRef=doc(db,'users',uid);
  await runTransaction(db,async tx=>{
    const userSnap=await tx.get(userRef);
    const previo=userSnap.exists()?userSnap.data():{};
    const oldUsername=previo.username||'';
    const usernameRef=doc(db,'usernames',cleanUsername);
    const usernameSnap=await tx.get(usernameRef);
    if(usernameSnap.exists() && usernameSnap.data().uid!==uid){
      const err=new Error('Ese nombre de usuario ya está en uso.');
      err.code='username-taken';
      throw err;
    }
    if(oldUsername && oldUsername!==cleanUsername){
      tx.delete(doc(db,'usernames',oldUsername));
    }
    tx.set(usernameRef,{
      uid,
      displayName,
      updatedAt:serverTimestamp()
    },{merge:true});
    tx.set(userRef,{
      uid,
      username:cleanUsername,
      displayName,
      photoURL:currentUser.photoURL||'',
      email:currentUser.email||'',
      updatedAt:serverTimestamp()
    },{merge:true});
  });
  const profile={
    uid,
    username:cleanUsername,
    displayName,
    photoURL:currentUser.photoURL||'',
    email:currentUser.email||''
  };
  _userProfileCache[uid]=profile;
  return profile;
}

function setPerfilSocialEnabled(enabled){
  const checkbox=document.getElementById('perfil-social-enabled');
  const fields=document.getElementById('perfil-social-fields');
  if(checkbox) checkbox.checked=!!enabled;
  if(fields) fields.classList.toggle('hidden',!enabled);
  if(!enabled) setSocialInputs('perfil',{});
}

// Las redes sociales son del PERFIL del usuario, no de cada línea. Como
// Firestore guarda el dueño dentro de cada línea (ownerName, ownerPhotoURL…),
// las redes se guardan igual: el mismo "ownerSocials" copiado en todas las
// líneas del usuario. Así el editor sigue leyendo tl.ownerSocials sin cambios.
function socialsStorageKey(){ return currentUser?`lt_perfil_socials_${currentUser.uid}`:''; }

// Devuelve las redes que el usuario tiene configuradas ahora mismo.
function getMySocials(){
  if(!currentUser) return {};
  const mine=(_timelinesCache||[]).filter(t=>t.ownerId===currentUser.uid);
  if(mine.length){
    const withSocials=mine.find(t=>hasSocialLinks(t.ownerSocials));
    return withSocials?{...withSocials.ownerSocials}:{};
  }
  // Sin líneas todavía: usamos lo último guardado en este navegador, para
  // que la primera línea que cree ya nazca con sus redes.
  try {
    return JSON.parse(localStorage.getItem(socialsStorageKey())||'{}')||{};
  } catch(e){ return {}; }
}

// Cambiar la foto de perfil (botón de cámara sobre el avatar, al estilo
// Instagram): sube la imagen elegida a Cloudinary, actualiza el usuario
// de Firebase Auth y deja la foto guardada en todas tus líneas de tiempo
// (ownerPhotoURL), igual que se hace con las redes sociales del perfil.
async function cambiarFotoPerfil(archivo){
  if(!currentUser || !archivo) return;
  const avatarEl=document.getElementById('perfil-avatar');
  const btnEdit=document.getElementById('perfil-avatar-edit');
  const prevSrc=avatarEl.src;
  btnEdit.disabled=true;
  btnEdit.textContent='…';
  try {
    const url=await subirImagenCloudinary(archivo);
    await updateProfile(currentUser,{photoURL:url});
    try {
      await setDoc(doc(db,'users',currentUser.uid),{
        uid:currentUser.uid,
        photoURL:url,
        displayName:currentUser.displayName||currentUser.email||'Usuario',
        email:currentUser.email||'',
        updatedAt:serverTimestamp()
      },{merge:true});
      _userProfileCache[currentUser.uid]={...(_userProfileCache[currentUser.uid]||{}),photoURL:url};
    } catch(e){ console.error(e); }
    avatarEl.src=url;
    avatarEl.style.display='block';
    updateHeader(currentUser);
    try {
      const timelines=await fetchTimelines();
      const mine=timelines.filter(t=>t.ownerId===currentUser.uid);
      await Promise.all(mine.map(t=>updateTimeline(t.id,{ownerPhotoURL:url})));
    } catch(e){ console.error(e); }
    toast('Foto de perfil actualizada ✓');
  } catch(e){
    console.error(e);
    avatarEl.src=prevSrc;
    toast('No se pudo actualizar la foto de perfil',6000);
  } finally {
    btnEdit.disabled=false;
    btnEdit.textContent='📷';
  }
}

async function openModalPerfilConfig(){
  if(!currentUser){ showAuth(); return; }
  try { await fetchTimelines(); } catch(e){ console.error(e); }
  let profile=null;
  try { profile=await getUserProfile(currentUser.uid); } catch(e){ console.error(e); }
  const displayInput=document.getElementById('perfil-display-name');
  const usernameInput=document.getElementById('perfil-username-input');
  if(displayInput) displayInput.value=(profile&&profile.displayName) || currentUser.displayName || '';
  if(usernameInput) usernameInput.value=(profile&&profile.username) || suggestUsernameFromUser(currentUser);
  const socials=getMySocials();
  setSocialInputs('perfil',socials);
  setPerfilSocialEnabled(hasSocialLinks(socials));
  showModal('modal-perfil-config');
}

async function guardarPerfilConfig(){
  if(!currentUser) return;
  const displayName=(document.getElementById('perfil-display-name').value||'').trim() || 'Usuario';
  const username=normalizeUsername(document.getElementById('perfil-username-input').value);
  const enabled=document.getElementById('perfil-social-enabled').checked;
  const socials=enabled?getSocialsFromInputs('perfil'):{};
  const btn=document.getElementById('btn-perfil-config-guardar');
  btn.disabled=true;
  btn.textContent='Guardando...';
  try {
    const profile=await guardarIdentidadPerfil({displayName,username});
    if(currentUser.displayName!==displayName) await updateProfile(currentUser,{displayName});
    try { localStorage.setItem(socialsStorageKey(),JSON.stringify(socials)); } catch(e){}
    const timelines=await fetchTimelines();
    const mine=timelines.filter(t=>t.ownerId===currentUser.uid);
    const changed=mine.filter(t=>
      JSON.stringify(t.ownerSocials||{})!==JSON.stringify(socials)
      || t.ownerName!==displayName
      || t.ownerUsername!==(profile&&profile.username)
    );
    await Promise.all(changed.map(t=>updateTimeline(t.id,{
      ownerSocials:socials,
      ownerName:displayName,
      ownerUsername:profile.username
    })));
    updateHeader(currentUser);
    if(viewingProfileUid===currentUser.uid) await renderPerfil(currentUser.uid,{forceLineas:false});
    hideModal('modal-perfil-config');
    toast('Configuración guardada ✓');
  } catch(e){
    console.error(e);
    if(e.code==='username-taken') toast('Ese nombre de usuario ya está ocupado. Prueba otro.',6000);
    else if(e.code==='invalid-username') toast(e.message,6000);
    else toast(friendlyFirestoreError(e),6000);
  } finally {
    btn.disabled=false;
    btn.textContent='Guardar cambios';
  }
}

function renderOwnerSocialLinks(tl){
  const wrap=document.getElementById('editor-social-links');
  if(!wrap) return;
  const socials=tl&&tl.ownerSocials?tl.ownerSocials:{};
  const links=SOCIAL_PLATFORMS
    .map(platform=>({ ...platform, url:socials[platform.key] }))
    .filter(item=>/^https?:\/\//i.test(item.url||''));
  if(!links.length){
    wrap.classList.add('hidden');
    wrap.innerHTML='';
    return;
  }
  wrap.innerHTML=links.map(item=>
    `<a class="editor-social-link" href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escHtml(item.label)}</a>`
  ).join('');
  wrap.classList.remove('hidden');
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

function getRoute(){
  const params=new URLSearchParams(window.location.search);
  return {
    usuario: params.get('usuario') || '',
    perfil: params.get('perfil') || '',
    linea: params.get('linea') || ''
  };
}

function buildProfileUrl(uid){
  const url=new URL(window.location.href);
  url.search='';
  url.hash='';
  const profile=_userProfileCache[uid]||{};
  if(profile.username) url.searchParams.set('usuario',profile.username);
  else if(uid===viewingProfileUid && viewingProfileUsername) url.searchParams.set('usuario',viewingProfileUsername);
  else url.searchParams.set('perfil',uid);
  return url.toString();
}

function buildTimelineUrl(id){
  const url=new URL(window.location.href);
  url.search='';
  url.hash='';
  url.searchParams.set('linea',id);
  return url.toString();
}

function setRoute(route={},replace=false){
  const url=new URL(window.location.href);
  url.search='';
  url.hash='';
  if(route.usuario) url.searchParams.set('usuario',route.usuario);
  else if(route.perfil) url.searchParams.set('perfil',route.perfil);
  const next=url.pathname+url.search+url.hash;
  const current=window.location.pathname+window.location.search+window.location.hash;
  if(next===current) return;
  const fn=replace?'replaceState':'pushState';
  window.history[fn]({},'',next);
}

async function copyCurrentProfileLink(){
  if(!viewingProfileUid) return;
  const link=buildProfileUrl(viewingProfileUid);
  try {
    await navigator.clipboard.writeText(link);
    toast('Enlace del perfil copiado ✓');
  } catch(e){
    console.error(e);
    window.prompt('Copia el enlace del perfil:',link);
  }
}

async function openRouteFromUrl(){
  const route=getRoute();
  if(route.linea){
    await renderHome({skipRouteUpdate:true});
    await openTimeline(route.linea);
    return;
  }
  if(route.usuario){
    const uid=await getUidByUsername(route.usuario);
    if(uid){
      await renderPerfil(uid,{skipRouteUpdate:true,forceLineas:true,profileUsername:normalizeUsername(route.usuario)});
      return;
    }
    toast('No encontramos ese perfil.');
  }
  if(route.perfil){
    await renderPerfil(route.perfil,{skipRouteUpdate:true,forceLineas:true});
    return;
  }
  await renderHome({skipRouteUpdate:true});
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
    ownerPhotoURL:currentUser.photoURL||null,
    ownerUsername:getMyUsername()||''
  });
  const createdTimeline = {
    id: ref.id,
    ...data,
    eventos: [],
    ownerId: currentUser.uid,
    ownerName: currentUser.displayName || currentUser.email || 'Usuario',
    ownerPhotoURL: currentUser.photoURL || null,
    ownerUsername:getMyUsername()||''
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
function normalizeTimelineSections(secciones){
  return [...(secciones||[])]
    .map(section=>({
      id: section.id || uid(),
      nombre: String(section.nombre||'').trim()
    }))
    .filter(section=>section.nombre);
}

function getTimelineSectionsFromEditor(){
  return [...document.querySelectorAll('.timeline-section-row')].map(row=>({
    id: row.dataset.sectionId || uid(),
    nombre: row.querySelector('.timeline-section-name').value.trim()
  })).filter(section=>section.nombre);
}

function addTimelineSectionRow(section={}){
  const editor=document.getElementById('timeline-sections-editor');
  if(!editor) return;
  editor.querySelector('.timeline-sections-empty')?.remove();
  const row=document.createElement('div');
  row.className='timeline-section-row';
  row.dataset.sectionId=section.id||uid();
  row.innerHTML=`
    <input class="timeline-section-name" type="text" placeholder="Ej: Toei Animation" value="${escHtml(section.nombre||'')}"/>
    <button type="button" class="timeline-section-remove" title="Quitar sección">×</button>`;
  row.querySelector('.timeline-section-remove').addEventListener('click',()=>row.remove());
  editor.appendChild(row);
}

function resetTimelineSectionsEditor(secciones=[]){
  const editor=document.getElementById('timeline-sections-editor');
  if(!editor) return;
  editor.innerHTML='';
  const items=normalizeTimelineSections(secciones);
  if(!items.length){
    const empty=document.createElement('div');
    empty.className='timeline-sections-empty';
    empty.textContent='Todavía no hay secciones agregadas.';
    editor.appendChild(empty);
    return;
  }
  items.forEach(addTimelineSectionRow);
}

function getTimelineSectionById(tl,sectionId){
  if(!sectionId) return null;
  return normalizeTimelineSections(tl&&tl.secciones).find(section=>section.id===sectionId) || null;
}

function getEventSectionHtml(ev,tl){
  const section=getTimelineSectionById(tl,ev&&ev.seccionId);
  return section ? `<div class="event-section-pill">${escHtml(section.nombre)}</div>` : '';
}

function renderEventSectionSelect(tl,selectedId=''){
  const select=document.getElementById('ev-seccion');
  if(!select) return;
  const sections=normalizeTimelineSections(tl&&tl.secciones);
  select.innerHTML='<option value="">Sin sección</option>'+sections.map(section=>
    `<option value="${escHtml(section.id)}">${escHtml(section.nombre)}</option>`
  ).join('');
  const exists=sections.some(section=>section.id===selectedId);
  select.value=exists?selectedId:'';
  // Sin secciones creadas no hay nada que elegir: ocultamos todo el campo.
  const group=select.closest('.form-group');
  if(group) group.classList.toggle('hidden',sections.length===0);
}

function getFilteredTimelineEvents(tl){
  const eventos=ordenarEventos(tl.eventos||[]);
  if(!activeTimelineSectionFilter) return eventos;
  return eventos.filter(ev=>ev.seccionId===activeTimelineSectionFilter);
}

function renderTimelineSectionFilters(tl){
  const wrap=document.getElementById('timeline-section-filters');
  if(!wrap) return;
  const sections=normalizeTimelineSections(tl&&tl.secciones);
  if(!sections.length){
    activeTimelineSectionFilter='';
    wrap.classList.add('hidden');
    wrap.innerHTML='';
    return;
  }
  const activeExists=sections.some(section=>section.id===activeTimelineSectionFilter);
  if(activeTimelineSectionFilter&&!activeExists) activeTimelineSectionFilter='';
  wrap.classList.remove('hidden');
  wrap.innerHTML=[
    `<button type="button" class="timeline-section-filter ${activeTimelineSectionFilter?'':'active'}" data-section-id="">Todas</button>`,
    ...sections.map(section=>
      `<button type="button" class="timeline-section-filter ${activeTimelineSectionFilter===section.id?'active':''}" data-section-id="${escHtml(section.id)}">${escHtml(section.nombre)}</button>`
    )
  ].join('');
  wrap.querySelectorAll('.timeline-section-filter').forEach(btn=>{
    btn.addEventListener('click',()=>{
      activeTimelineSectionFilter=btn.dataset.sectionId||'';
      renderTimelineFromCache(tl);
    });
  });
}
function renderEventSectionView(ev,tl){
  const el=document.getElementById('ver-seccion');
  if(!el) return;
  const section=getTimelineSectionById(tl,ev&&ev.seccionId);
  if(!section){
    el.classList.add('hidden');
    el.textContent='';
    return;
  }
  el.textContent=section.nombre;
  el.className='event-section-pill';
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
  return normalizeRelatedTimelineIds(relatedEditorSelectedIds);
}

function resetRelatedTimelinesEditor(currentId,relatedIds=[],timelines=[]){
  const editor=document.getElementById('related-timelines-editor');
  if(!editor) return;
  relatedEditorCurrentId=currentId;
  relatedEditorSelectedIds=normalizeRelatedTimelineIds(relatedIds);
  relatedEditorOptions=[...(timelines||[])]
    .filter(tl=>tl.id&&tl.id!==currentId)
    .sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));
  renderRelatedTimelinesEditor('');
}

function renderRelatedTimelinesEditor(query=''){
  const editor=document.getElementById('related-timelines-editor');
  if(!editor) return;
  if(relatedEditorOptions.length===0){
    editor.innerHTML='<span class="related-timelines-empty">Crea otra linea de tiempo para poder vincularla.</span>';
    return;
  }

  const selected=new Set(relatedEditorSelectedIds);
  const selectedItems=relatedEditorSelectedIds
    .map(id=>relatedEditorOptions.find(tl=>tl.id===id))
    .filter(Boolean);
  const q=normalizeSearchText(String(query||'').trim().replace(/^#+/,''));
  const suggestions=q
    ? relatedEditorOptions
        .filter(tl=>!selected.has(tl.id))
        .filter(tl=>timelineSearchText(tl).includes(q))
        .slice(0,6)
    : [];

  const chipsHtml=selectedItems.length
    ? selectedItems.map(tl=>`<button type="button" class="related-selected-chip" data-id="${escHtml(tl.id)}">${escHtml(tl.nombre||'Sin titulo')} <span>×</span></button>`).join('')
    : '<span class="related-timelines-empty">Todavía no hay líneas relacionadas agregadas.</span>';

  const suggestionsHtml=q
    ? (suggestions.length
        ? suggestions.map(tl=>{
            const count=(tl.eventos||[]).length;
            return `<button type="button" class="related-suggestion" data-id="${escHtml(tl.id)}">
              <strong>${escHtml(tl.nombre||'Sin titulo')}</strong>
              <small>${count} evento${count===1?'':'s'}${tl.ownerName?` · por ${escHtml(tl.ownerName)}`:''}</small>
            </button>`;
          }).join('')
        : '<span class="related-timelines-empty">No encontramos coincidencias.</span>')
    : '<span class="related-timelines-empty">Escribe para buscar una línea de tiempo y haz clic para relacionarla.</span>';

  editor.innerHTML=`
    <div class="related-search-box">
      <span class="search-icon">⌕</span>
      <input type="text" class="related-search-input" placeholder="Buscar línea de tiempo..." value="${escHtml(query)}" autocomplete="off"/>
    </div>
    <div class="related-selected-list">${chipsHtml}</div>
    <div class="related-suggestions-list">${suggestionsHtml}</div>`;

  const input=editor.querySelector('.related-search-input');
  input.focus();
  input.setSelectionRange(input.value.length,input.value.length);
  input.addEventListener('input',()=>renderRelatedTimelinesEditor(input.value));
  editor.querySelectorAll('.related-suggestion').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=btn.dataset.id;
      if(id&&!relatedEditorSelectedIds.includes(id)) relatedEditorSelectedIds.push(id);
      renderRelatedTimelinesEditor('');
    });
  });
  editor.querySelectorAll('.related-selected-chip').forEach(btn=>{
    btn.addEventListener('click',()=>{
      relatedEditorSelectedIds=relatedEditorSelectedIds.filter(id=>id!==btn.dataset.id);
      renderRelatedTimelinesEditor(input.value);
    });
  });
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

function getVerifyStatusHtml(ev){
  const confirmed=!!(ev&&ev.infoConfirmada);
  const label=confirmed?'Información verificada':'Falta verificar';
  const cls=confirmed?'confirmed':'pending';
  return `<div class="event-verify-status ${cls}">${label}</div>`;
}

function renderVerifyStatus(elementId,ev){
  const el=document.getElementById(elementId);
  if(!el) return;
  const confirmed=!!(ev&&ev.infoConfirmada);
  el.textContent=confirmed?'Información verificada':'Falta verificar';
  el.className=`event-verify-status ${confirmed?'confirmed':'pending'}`;
  el.classList.remove('hidden');
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
    infoConfirmada: document.getElementById('ev-info-confirmada').checked,
    titulo: document.getElementById('ev-titulo').value.trim(),
    fecha: document.getElementById('ev-fecha').value.trim(),
    descripcion: document.getElementById('ev-descripcion').value.trim(),
    pais: getEventCountryValue(),
    seccionId: document.getElementById('ev-seccion').value||'',
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
      const verifyHtml=getVerifyStatusHtml(ev);
      const flagHtml=getCountryFlagHtml(ev);
      const sectionHtml=getEventSectionHtml(ev,principal);
      item.innerHTML=`
        <div class="event-spacer"></div>
        ${yearHtml}
        <div class="event-card${flagHtml?' has-flag':''}">
          ${flagHtml}
          ${imgHtml}
          ${verifyHtml}
          ${sectionHtml}
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
// de tiempo. Cualquier usuario logueado puede darle "me gusta",
// incluido el dueño de la línea de tiempo.
function getLikesArray(tl){
  return Array.isArray(tl && tl.likes) ? tl.likes : [];
}

function getTimelineLocalActual(id, fallback){
  return _timelineCache[id]
    || (_timelinesCache||[]).find(t=>t.id===id)
    || (_homeTimelinesRaw||[]).find(t=>t.id===id)
    || (_perfilTimelinesRaw||[]).find(t=>t.id===id)
    || fallback
    || null;
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
    btn.title = likedByMe ? 'Quitar me gusta' : 'Dar me gusta';
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
  const actual=getTimelineLocalActual(tl.id,tl);
  const likesActuales=getLikesArray(actual);
  const yaLeGusta=likesActuales.includes(currentUser.uid);
  const likes=yaLeGusta
    ? likesActuales.filter(uid=>uid!==currentUser.uid)
    : [...likesActuales,currentUser.uid];

  setLikesLocal(actual.id,likes);
  actualizarBotonLike(actual.id,likes);
  // Si estamos parados justo en la vista de estadísticas de un perfil,
  // el total de "me gusta" del muro también cambia al instante.
  const perfilScreen=document.getElementById('screen-perfil');
  if(perfilScreen && perfilScreen.classList.contains('active') && perfilViewMode==='stats'){
    renderPerfilStats();
  }

  try {
    await updateTimeline(actual.id,{likes});
  } catch(err){
    console.error(err);
    setLikesLocal(actual.id,likesActuales);
    actualizarBotonLike(actual.id,likesActuales);
    toast('No se pudo guardar el "me gusta". Intenta de nuevo.');
  }
}

// Construye el botón de "me gusta" que va dentro de la fila de
// acciones de cada tarjeta (me gusta / comentar / compartir / guardar).
function buildLikeButton(tl){
  const likes=getLikesArray(tl);
  const count=likes.length;
  const likedByMe=!!(currentUser && likes.includes(currentUser.uid));

  const btn=document.createElement('button');
  btn.type='button';
  btn.className='btn-like card-action-btn card-action-like'+(likedByMe?' liked':'');
  btn.dataset.id=tl.id;
  btn.title = likedByMe ? 'Quitar me gusta' : 'Dar me gusta';
  btn.innerHTML = `<span class="card-action-icon like-heart">${likedByMe?'❤️':'🤍'}</span><span class="like-count">${count}</span>`;
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    toggleLike(tl);
  });

  return btn;
}

// Conserva el envoltorio para otras zonas que aún necesiten una fila.
function buildLikeRow(tl){
  const row=document.createElement('div');
  row.className='like-row';
  const btn=buildLikeButton(tl);
  btn.classList.remove('card-like');
  row.appendChild(btn);
  return row;
}

// ─── COMENTARIOS EN LÍNEAS DE TIEMPO ────────────────────────
// Igual que los "me gusta", se guardan como un arreglo dentro del
// propio documento de la línea de tiempo: "comentarios", con objetos
// {uid, nombre, texto, fecha}. "fecha" es un número (Date.now()) y no
// un serverTimestamp porque Firestore no permite serverTimestamp()
// dentro de elementos de un arreglo.
function getComentariosArray(tl){
  return Array.isArray(tl && tl.comentarios) ? tl.comentarios : [];
}

function setComentariosLocal(id, comentarios){
  if(_timelineCache[id]) _timelineCache[id]={..._timelineCache[id],comentarios};
  if(_timelinesCache){
    const idx=_timelinesCache.findIndex(t=>t.id===id);
    if(idx>-1) _timelinesCache[idx]={..._timelinesCache[idx],comentarios};
  }
  const hIdx=_homeTimelinesRaw.findIndex(t=>t.id===id);
  if(hIdx>-1) _homeTimelinesRaw[hIdx]={..._homeTimelinesRaw[hIdx],comentarios};
  const pIdx=_perfilTimelinesRaw.findIndex(t=>t.id===id);
  if(pIdx>-1) _perfilTimelinesRaw[pIdx]={..._perfilTimelinesRaw[pIdx],comentarios};
}

function actualizarContadorComentarios(id, comentarios){
  const count=(comentarios||[]).length;
  document.querySelectorAll(`.card-action-comment[data-id="${id}"] .comment-count`).forEach(el=>{
    el.textContent=count;
  });
}

let _comentariosTimelineId=null;
let _comentariosTimelineRef=null;

function renderComentariosModal(tl){
  _comentariosTimelineId=tl.id;
  _comentariosTimelineRef=tl;
  const lista=document.getElementById('comentarios-lista');
  const empty=document.getElementById('comentarios-empty');
  const comentarios=getComentariosArray(tl).slice().sort((a,b)=>(a.fecha||0)-(b.fecha||0));

  lista.querySelectorAll('.comentario-item').forEach(el=>el.remove());
  empty.style.display = comentarios.length ? 'none' : 'block';

  comentarios.forEach(c=>{
    const puedeBorrar = currentUser && (currentUser.uid===c.uid || canEdit(tl));
    const item=document.createElement('div');
    item.className='comentario-item';
    item.innerHTML=`
      <div class="comentario-header">
        <span class="comentario-autor">${escHtml(c.nombre||'Usuario')}</span>
        <span class="comentario-fecha">${c.fecha?formatTiempoRelativo(c.fecha):''}</span>
      </div>
      <div class="comentario-texto">${escHtml(c.texto||'')}</div>
      ${puedeBorrar?'<button type="button" class="comentario-borrar">Eliminar</button>':''}
    `;
    if(puedeBorrar){
      item.querySelector('.comentario-borrar').addEventListener('click',()=>borrarComentario(tl.id,c));
    }
    lista.appendChild(item);
  });

  const form=document.getElementById('comentarios-form');
  const loginNote=document.getElementById('comentarios-login-note');
  form.classList.toggle('hidden', !currentUser);
  loginNote.classList.toggle('hidden', !!currentUser);
  document.getElementById('comentario-texto').value='';
}

async function openComentarios(tl){
  renderComentariosModal(getTimelineLocalActual(tl.id,tl));
  showModal('modal-comentarios');
}

async function enviarComentario(){
  if(!currentUser){ showAuth(); return; }
  const id=_comentariosTimelineId;
  const tl=_comentariosTimelineRef;
  if(!id || !tl) return;
  const textarea=document.getElementById('comentario-texto');
  const texto=textarea.value.trim();
  if(!texto) return;

  const nuevo={ uid:currentUser.uid, nombre:currentUser.displayName||currentUser.email||'Usuario', texto, fecha:Date.now() };
  const anteriores=getComentariosArray(tl);
  const comentarios=[...anteriores,nuevo];

  const btn=document.getElementById('btn-enviar-comentario');
  btn.disabled=true;
  setComentariosLocal(id,comentarios);
  actualizarContadorComentarios(id,comentarios);
  renderComentariosModal({...tl,comentarios});

  try {
    await updateTimeline(id,{comentarios});
  } catch(e){
    console.error(e);
    setComentariosLocal(id,anteriores);
    actualizarContadorComentarios(id,anteriores);
    renderComentariosModal({...tl,comentarios:anteriores});
    toast('No se pudo publicar el comentario. Intenta de nuevo.');
  } finally {
    btn.disabled=false;
  }
}

async function borrarComentario(id,comentario){
  const tl=_comentariosTimelineRef && _comentariosTimelineRef.id===id ? _comentariosTimelineRef : null;
  if(!tl) return;
  const anteriores=getComentariosArray(tl);
  const comentarios=anteriores.filter(c=>!(c.uid===comentario.uid && c.fecha===comentario.fecha));

  setComentariosLocal(id,comentarios);
  actualizarContadorComentarios(id,comentarios);
  renderComentariosModal({...tl,comentarios});

  try {
    await updateTimeline(id,{comentarios});
  } catch(e){
    console.error(e);
    setComentariosLocal(id,anteriores);
    actualizarContadorComentarios(id,anteriores);
    renderComentariosModal({...tl,comentarios:anteriores});
    toast('No se pudo eliminar el comentario. Intenta de nuevo.');
  }
}

function buildComentarioButton(tl){
  const count=getComentariosArray(tl).length;
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='card-action-btn card-action-comment';
  btn.dataset.id=tl.id;
  btn.title='Ver comentarios';
  btn.innerHTML=`<span class="card-action-icon">💬</span><span class="comment-count">${count}</span>`;
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    openComentarios(tl);
  });
  return btn;
}

// ─── COMPARTIR UNA LÍNEA DE TIEMPO PUNTUAL ──────────────────
function buildCompartirButton(tl){
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='card-action-btn card-action-share';
  btn.title='Compartir';
  btn.innerHTML=`<span class="card-action-icon">↗</span>`;
  btn.addEventListener('click',async e=>{
    e.stopPropagation();
    const link=buildTimelineUrl(tl.id);
    if(navigator.share){
      try { await navigator.share({title:tl.nombre||'Línea de tiempo',url:link}); return; }
      catch(err){ if(err && err.name==='AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Enlace copiado ✓');
    } catch(err){
      console.error(err);
      window.prompt('Copia el enlace:',link);
    }
  });
  return btn;
}

// ─── GUARDAR ("bookmark") LÍNEAS DE TIEMPO ──────────────────
// Mismo patrón que "likes": un arreglo de uids ("guardadoPor") dentro
// del documento de la línea de tiempo.
function getGuardadoArray(tl){
  return Array.isArray(tl && tl.guardadoPor) ? tl.guardadoPor : [];
}

function setGuardadoLocal(id, guardadoPor){
  if(_timelineCache[id]) _timelineCache[id]={..._timelineCache[id],guardadoPor};
  if(_timelinesCache){
    const idx=_timelinesCache.findIndex(t=>t.id===id);
    if(idx>-1) _timelinesCache[idx]={..._timelinesCache[idx],guardadoPor};
  }
  const hIdx=_homeTimelinesRaw.findIndex(t=>t.id===id);
  if(hIdx>-1) _homeTimelinesRaw[hIdx]={..._homeTimelinesRaw[hIdx],guardadoPor};
  const pIdx=_perfilTimelinesRaw.findIndex(t=>t.id===id);
  if(pIdx>-1) _perfilTimelinesRaw[pIdx]={..._perfilTimelinesRaw[pIdx],guardadoPor};
}

function actualizarBotonGuardado(id, guardadoPor){
  const guardadaPorMi=!!(currentUser && (guardadoPor||[]).includes(currentUser.uid));
  document.querySelectorAll(`.card-action-save[data-id="${id}"]`).forEach(btn=>{
    btn.classList.toggle('saved',guardadaPorMi);
    btn.title = guardadaPorMi ? 'Quitar de guardadas' : 'Guardar';
    const icon=btn.querySelector('.card-action-icon');
    if(icon) icon.textContent = guardadaPorMi ? '🔖' : '🏷';
  });
}

async function toggleGuardado(tl){
  if(!currentUser){ showAuth(); return; }
  const actual=getTimelineLocalActual(tl.id,tl);
  const actuales=getGuardadoArray(actual);
  const yaGuardada=actuales.includes(currentUser.uid);
  const guardadoPor=yaGuardada
    ? actuales.filter(uid=>uid!==currentUser.uid)
    : [...actuales,currentUser.uid];

  setGuardadoLocal(actual.id,guardadoPor);
  actualizarBotonGuardado(actual.id,guardadoPor);
  if(viewingProfileUid===currentUser.uid && perfilViewMode==='guardados') renderPerfilGuardados();

  try {
    await updateTimeline(actual.id,{guardadoPor});
    toast(yaGuardada?'Quitada de guardadas':'Guardada ✓');
  } catch(e){
    console.error(e);
    setGuardadoLocal(actual.id,actuales);
    actualizarBotonGuardado(actual.id,actuales);
    toast('No se pudo guardar. Intenta de nuevo.');
  }
}

function buildGuardarButton(tl){
  const guardadoPor=getGuardadoArray(tl);
  const guardadaPorMi=!!(currentUser && guardadoPor.includes(currentUser.uid));
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='card-action-btn card-action-save'+(guardadaPorMi?' saved':'');
  btn.dataset.id=tl.id;
  btn.title = guardadaPorMi ? 'Quitar de guardadas' : 'Guardar';
  btn.innerHTML=`<span class="card-action-icon">${guardadaPorMi?'🔖':'🏷'}</span>`;
  btn.addEventListener('click',e=>{
    e.stopPropagation();
    toggleGuardado(tl);
  });
  return btn;
}

// Fila completa de acciones (me gusta, comentar, compartir, guardar)
// que se muestra debajo de la descripción de cada tarjeta.
function buildCardActionsRow(tl){
  const row=document.createElement('div');
  row.className='card-actions-row';
  row.addEventListener('click',e=>e.stopPropagation());
  row.appendChild(buildLikeButton(tl));
  row.appendChild(buildComentarioButton(tl));
  row.appendChild(buildCompartirButton(tl));
  row.appendChild(buildGuardarButton(tl));
  return row;
}

function buildTimelineCardInfo(tl,count,extraHtml=''){
  const info=document.createElement('div');
  info.className='timeline-card-info';
  // Los hashtags (tl.hashtags) NO se muestran al usuario: solo se usan
  // internamente para el buscador (ver filtrarYOrdenarTimelines y
  // timelineSearchText). Por eso ya no generamos tagsHtml ni lo insertamos.
  info.innerHTML=`
    <div class="card-desc">${escHtml(tl.desc||'Sin descripción')}</div>
    <div class="card-meta"><span class="dot"></span>${count===0?'Sin eventos aún':count+(count===1?' evento':' eventos')}</div>
    ${extraHtml}`;
  return info;
}

// Filtra por nombre (si hay texto buscado) y ordena según el modo
// elegido. Devuelve un arreglo nuevo, sin modificar el original.
function filtrarYOrdenarTimelines(lista, query, sortBy){
  // Si la búsqueda empieza con "#", se buscan solo hashtags.
  const raw=(query||'').trim();
  const soloHashtags=raw.startsWith('#');
  const q=normalizeSearchText(raw.replace(/^#+/,'')).trim();
  let out = q ? lista.filter(tl=>{
    if(soloHashtags) return (tl.hashtags||[]).some(tag=>normalizeSearchText(tag).includes(q));
    return timelineSearchText(tl).includes(q);
  }) : [...lista];
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

async function renderHome(options={}){
  if(!options.skipRouteUpdate) setRoute({});
  lastListScreen='home';
  const seq=++_renderHomeSeq;
  showScreen('home');
  updateHeader(currentUser);

  let timelines=[];
  try { timelines=await fetchTimelines(); } catch(e){ console.error(e); }
  if(seq!==_renderHomeSeq) return;

  // El inicio combina dos zonas: una vitrina curada con líneas destacadas
  // y un buscador general para encontrar cualquier línea pública.
  _homeTimelinesRaw=timelines.filter(tl=>!tl.privada && tl.estadoDestacada==='aprobada');
  _homeSearchTimelinesRaw=timelines.filter(tl=>!tl.privada);

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
    onChange:renderHomeSearchResults
  });

  renderHomeCards();
  renderHomeSearchResults();
}

function appendHomeTimelineCard(grid,tl,i,{allowBulkSelection=true}={}){
  const wrap=document.createElement('div');
  wrap.className='timeline-card-wrap';
  wrap.style.animationDelay=(i*0.07)+'s';

  const card=document.createElement('div');
  card.className='timeline-card';
  card.style.setProperty('--card-accent',tl.color||'#E8845A');
  const count=(tl.eventos||[]).length;
  const esPropia=currentUser&&tl.ownerId===currentUser.uid;
  const propiaLabel=esPropia?`<span class="card-owner card-owner--propia">✎ Tuya</span>`:'';
  const puedeBorrar=canEdit(tl);
  const puedeSeleccionar=allowBulkSelection && modoSeleccion && puedeBorrar;
  const checkboxHtml = puedeSeleccionar
    ? `<label class="card-checkbox">
         <input type="checkbox" class="card-checkbox-input" data-id="${tl.id}" ${idsSeleccionados.has(tl.id)?'checked':''}/>
       </label>`
    : '';
  const bgImageHtml=tl.imagenUrl?`<div class="card-bg-image" style="background-image:url('${escHtml(tl.imagenUrl)}')"></div>`:'';
  card.innerHTML=`
    ${bgImageHtml}
    ${checkboxHtml}
    <div class="card-main-content">
      <span class="card-icon">◉</span>
      <div class="card-name">${escHtml(tl.nombre)}</div>
    </div>`;

  if(puedeSeleccionar){
    const checkboxInput=card.querySelector('.card-checkbox-input');
    checkboxInput.addEventListener('click',e=>e.stopPropagation());
    checkboxInput.addEventListener('change',()=>alternarSeleccion(tl.id));
    card.classList.add('seleccionable');
    card.addEventListener('click',()=>alternarSeleccion(tl.id));
  } else {
    card.addEventListener('click',()=>openTimeline(tl.id));
  }
  wrap.appendChild(card);
  wrap.appendChild(buildTimelineCardInfo(tl,count,propiaLabel));
  if(!puedeSeleccionar) wrap.appendChild(buildCardActionsRow(tl));
  grid.appendChild(wrap);
}

// Dibuja las tarjetas destacadas del inicio. El buscador general no afecta
// esta vitrina: siempre muestra las aprobadas por el administrador.
function renderHomeCards(){
  const grid=document.getElementById('timelines-grid');
  const empty=document.getElementById('empty-state');
  grid.innerHTML='';
  grid.appendChild(empty);

  const destacadas=filtrarYOrdenarTimelines(_homeTimelinesRaw, '', 'recent');

  if(destacadas.length===0){
    empty.style.display='block';
    empty.querySelector('p').innerHTML='Aún no hay líneas de tiempo destacadas.<br/>Crea la tuya y sugiérela desde tu perfil.';
  } else {
    empty.style.display='none';
    destacadas.forEach((tl,i)=>appendHomeTimelineCard(grid,tl,i,{allowBulkSelection:true}));
  }
}

function renderHomeSearchResults(){
  const grid=document.getElementById('home-search-results-grid');
  const empty=document.getElementById('home-search-empty');
  if(!grid||!empty) return;
  grid.innerHTML='';
  grid.appendChild(empty);

  const q=(homeSearchQuery||'').trim();
  if(!q){
    empty.style.display='block';
    empty.querySelector('p').innerHTML='Escribe para buscar entre todas las líneas de tiempo públicas.';
    return;
  }

  const resultados=filtrarYOrdenarTimelines(_homeSearchTimelinesRaw, homeSearchQuery, homeSortBy);
  if(resultados.length===0){
    empty.style.display='block';
    empty.querySelector('p').innerHTML='No encontramos líneas de tiempo públicas con esa búsqueda.';
    return;
  }

  empty.style.display='none';
  resultados.forEach((tl,i)=>appendHomeTimelineCard(grid,tl,i,{allowBulkSelection:false}));
}

// ─── PERFIL / MURO DE USUARIO ──────────────────────────────
// Muestra las líneas de tiempo creadas por un usuario en particular.
// Es pública: cualquiera puede visitarla, pero las líneas marcadas
// como "privada" solo se muestran si quien mira es el propio dueño
// (o root). Se accede desde "Mi perfil" en el header, o haciendo
// clic en el nombre del dueño dentro de cualquier tarjeta.
async function renderPerfil(uid,options={}){
  if(!uid) return;
  let profile=null;
  try { profile=await getUserProfile(uid); } catch(e){ console.error(e); }
  const routeUsername=options.profileUsername || (profile&&profile.username) || '';
  if(!options.skipRouteUpdate) setRoute(routeUsername?{usuario:routeUsername}:{perfil:uid});
  // Si cambiamos de perfil (otro usuario), reseteamos la búsqueda/orden
  // para no arrastrar un filtro que no tiene sentido en el nuevo muro.
  if(viewingProfileUid!==uid || options.forceLineas){
    perfilSearchQuery='';
    perfilSortBy='recent';
    perfilViewMode='lineas';
  }
  viewingProfileUid=uid;
  viewingProfileUsername=routeUsername;
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
  let nombre='Usuario', foto='', username=routeUsername;
  if(esPropio && currentUser){
    nombre=(profile&&profile.displayName) || currentUser.displayName || currentUser.email || 'Usuario';
    foto=(profile&&profile.photoURL) || currentUser.photoURL || '';
    username=(profile&&profile.username) || username;
  } else if(todasDelUsuario.length){
    nombre=(profile&&profile.displayName) || todasDelUsuario[0].ownerName || 'Usuario';
    foto=(profile&&profile.photoURL) || todasDelUsuario[0].ownerPhotoURL || '';
    username=(profile&&profile.username) || todasDelUsuario[0].ownerUsername || username;
  } else if(profile){
    nombre=profile.displayName||'Usuario';
    foto=profile.photoURL||'';
    username=profile.username||username;
  }

  document.getElementById('perfil-nombre').textContent=nombre;
  const usernameEl=document.getElementById('perfil-username');
  if(username){
    usernameEl.textContent='@'+username;
    usernameEl.classList.remove('hidden');
    viewingProfileUsername=username;
  } else {
    usernameEl.textContent='';
    usernameEl.classList.add('hidden');
  }
  const avatarEl=document.getElementById('perfil-avatar');
  if(foto){ avatarEl.src=foto; avatarEl.style.display='block'; }
  else { avatarEl.style.display='none'; }
  // El botón de "cambiar foto" (cámara) solo se muestra en tu propio perfil.
  document.getElementById('perfil-avatar-edit').classList.toggle('hidden', !esPropio);

  // Fila de estadísticas estilo Instagram: líneas de tiempo, eventos
  // totales (sumando los de todas las líneas visibles) y privadas.
  const totalEventos = visibles.reduce((acc,tl)=>acc+((tl.eventos&&tl.eventos.length)||0),0);
  document.getElementById('perfil-stat-lineas').textContent = visibles.length;
  document.getElementById('perfil-stat-eventos').textContent = totalEventos;
  const privadasWrap = document.getElementById('perfil-stat-privadas-wrap');
  if(esPropio && numPrivadas>0){
    document.getElementById('perfil-stat-privadas').textContent = numPrivadas;
    privadasWrap.classList.remove('hidden');
  } else {
    privadasWrap.classList.add('hidden');
  }

  document.getElementById('perfil-grid-title').textContent = esPropio
    ? 'Tus líneas de tiempo'
    : `Líneas de tiempo de ${nombre}`;
  document.getElementById('btn-nueva-perfil').classList.toggle('hidden', !esPropio);
  document.getElementById('btn-perfil-config').classList.toggle('hidden', !esPropio);
  document.getElementById('btn-toggle-perfil-guardados').classList.toggle('hidden', !esPropio);

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

// Muestra la sección de "Líneas de tiempo", "Estadísticas del perfil"
// o "Guardadas" según perfilViewMode, y deja los botones con el texto
// correcto.
function applyPerfilViewMode(){
  const btnStats = document.getElementById('btn-toggle-perfil-stats');
  const btnGuardados = document.getElementById('btn-toggle-perfil-guardados');
  const lineasSection = document.getElementById('perfil-lineas-section');
  const statsSection = document.getElementById('perfil-stats-section');
  const guardadosSection = document.getElementById('perfil-guardados-section');

  lineasSection.classList.toggle('hidden', perfilViewMode!=='lineas');
  statsSection.classList.toggle('hidden', perfilViewMode!=='stats');
  guardadosSection.classList.toggle('hidden', perfilViewMode!=='guardados');

  btnStats.textContent = perfilViewMode==='stats' ? '← Ver líneas de tiempo' : '📊 Estadísticas del perfil';
  btnGuardados.textContent = perfilViewMode==='guardados' ? '← Ver líneas de tiempo' : '🔖 Guardadas';

  if(perfilViewMode==='stats') renderPerfilStats();
  else if(perfilViewMode==='guardados') renderPerfilGuardados();
}

// Dibuja la grilla de "Guardadas": todas las líneas de tiempo (de
// cualquier usuario) que el dueño del perfil marcó con el ícono 🔖,
// y que todavía puede ver (si una se volvió privada y ya no es suya,
// deja de aparecer aquí).
function renderPerfilGuardados(){
  const grid=document.getElementById('perfil-guardados-grid');
  const empty=document.getElementById('perfil-guardados-empty');
  if(!grid||!empty) return;
  grid.querySelectorAll('.timeline-card-wrap').forEach(el=>el.remove());

  const todas=_timelinesCache||[];
  const guardadas=todas.filter(tl=>getGuardadoArray(tl).includes(viewingProfileUid) && canView(tl));

  empty.style.display = guardadas.length ? 'none' : 'block';
  guardadas.forEach((tl,i)=>appendHomeTimelineCard(grid,tl,i,{allowBulkSelection:false}));
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
        <div class="card-main-content">
      <span class="card-icon">◉</span>
      <div class="card-name">${escHtml(tl.nombre)}</div>
    </div>`;
      card.addEventListener('click',()=>openTimeline(tl.id));
      wrap.appendChild(card);
      wrap.appendChild(buildTimelineCardInfo(tl,count));
      wrap.appendChild(buildCardActionsRow(tl));

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
  activeTimelineSectionFilter='';
  const puedeEditar=canEdit(tl);

  document.documentElement.style.setProperty('--accent',tl.color||'#E8845A');
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(tl.color||'#E8845A',0.18));
  applyTimelineFondo(tl.fondo);
  document.getElementById('editor-title').textContent=tl.nombre;
  document.getElementById('editor-desc').textContent=tl.desc||'';

  const ownerEl=document.getElementById('editor-owner');
  if(ownerEl){
    // Ya no mostramos el nombre de quién creó la línea de tiempo en el
    // encabezado; solo dejamos sus redes sociales, si las activó.
    ownerEl.classList.add('hidden');
    ownerEl.classList.remove('editor-owner--link');
    ownerEl.onclick=null;
    renderOwnerSocialLinks(tl);
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

  const allEventos=ordenarEventos(tl.eventos||[]);
  const eventos=getFilteredTimelineEvents(tl);
  const lecturas=normalizeTimelineNotes(tl.lecturas||[]);
  renderTimelineSectionFilters(tl);
  renderTimelineNotesPanel(tl);
  renderRelatedTimelinesPanel(tl);

  if(eventos.length===0){
    const emptyText=empty.querySelector('p');
    if(emptyText){
      emptyText.innerHTML=allEventos.length&&activeTimelineSectionFilter
        ? 'No hay eventos en esta sección.'
        : 'Agrega tu primer evento con el botón <strong>"+ Evento"</strong>';
    }
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
      const verifyHtml=getVerifyStatusHtml(ev);
      const flagHtml=getCountryFlagHtml(ev);
      const sectionHtml=getEventSectionHtml(ev,tl);
      item.innerHTML=`
        <div class="event-spacer"></div>
        ${yearHtml}
        <div class="event-card${flagHtml?' has-flag':''}">
          ${flagHtml}
          ${imgHtml}
          ${verifyHtml}
          ${sectionHtml}
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
  selectFondo('editar',tl.fondo);
  editHashtags=normalizeHashtags(tl.hashtags);
  renderHashtagsEditor();
  const hashtagsInput=document.getElementById('hashtags-input');
  if(hashtagsInput) hashtagsInput.value='';
  editTlImagenUrl=tl.imagenUrl||null;
  editTlImagenSubiendo=false;
  renderEditTlImagen();
  resetTimelineSectionsEditor(tl.secciones||[]);
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
  const fondo=selectedEditFondo;
  commitHashtagInput();
  const hashtags=normalizeHashtags(editHashtags);
  const lecturas=getTimelineNotesFromEditor();
  const secciones=getTimelineSectionsFromEditor();
  const validSectionIds=new Set(secciones.map(section=>section.id));
  const eventos=((_timelineCache[activeTimelineId]&&_timelineCache[activeTimelineId].eventos)||[]).map(ev=>
    !ev.seccionId||validSectionIds.has(ev.seccionId)?ev:{...ev,seccionId:''}
  );
  const relatedTimelineIds=normalizeRelatedTimelineIds(getRelatedTimelineIdsFromEditor());
  const imagenUrl=editTlImagenUrl||null;
  const tl=_timelineCache[activeTimelineId];
  const actualizadoEn=Date.now();
  _timelineCache[activeTimelineId]={...tl,nombre,desc,privada,color,fondo,hashtags,lecturas,secciones,eventos,relatedTimelineIds,imagenUrl,actualizadoEn};
  document.getElementById('editor-title').textContent=nombre;
  document.getElementById('editor-desc').textContent=desc;
  document.documentElement.style.setProperty('--accent',color);
  document.documentElement.style.setProperty('--accent-glow',hexToAlpha(color,0.18));
  applyTimelineFondo(fondo);
  renderTimelineFromCache(_timelineCache[activeTimelineId]);
  hideModal('modal-editar-tl');
  toast('Línea de tiempo actualizada ✓');
  try {
    await updateTimeline(activeTimelineId,{nombre,desc,privada,color,fondo,hashtags,lecturas,secciones,eventos,relatedTimelineIds,imagenUrl,actualizadoEn});
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
  setFondoPickerAccent('editar',color);
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
  renderEventSectionSelect(tl,'');

  const titulo=document.getElementById('modal-evento-titulo');
  const btnElim=document.getElementById('btn-eliminar-evento');

  if(eventId){
    const ev=(tl.eventos||[]).find(e=>e.id===eventId);
    if(ev){
      titulo.textContent='Editar evento';
      document.getElementById('ev-info-confirmada').checked=!!ev.infoConfirmada;
      document.getElementById('ev-titulo').value=ev.titulo||'';
      document.getElementById('ev-fecha').value=ev.fecha||'';
      document.getElementById('ev-descripcion').value=ev.descripcion||'';
      setEventCountryValue(ev.pais);
      pendingImages=getEventImages(ev);
      renderImageGalleryEditor();
      resetSubtimelineEditor(ev.subEventos||[]);
      renderEventSectionSelect(tl,ev.seccionId||'');
      btnElim.classList.remove('hidden');
      showModal('modal-evento');
      rememberEventDraft();
    }
  } else {
    titulo.textContent='Nuevo evento';
    document.getElementById('ev-info-confirmada').checked=false;
    document.getElementById('ev-titulo').value='';
    document.getElementById('ev-fecha').value='';
    document.getElementById('ev-descripcion').value='';
    setEventCountryValue('');
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
    const infoConfirmada=document.getElementById('ev-info-confirmada').checked;
    const fechaVal=document.getElementById('ev-fecha').value.trim();
    const descVal=document.getElementById('ev-descripcion').value.trim();
    const paisVal=getEventCountryValue();
    const seccionId=document.getElementById('ev-seccion').value||'';
    const subEventos=ordenarSubEventos(getSubtimelineFromEditor());

    if(editingEventId){
      const idx=eventos.findIndex(e=>e.id===editingEventId);
      if(idx>-1) eventos[idx]={...eventos[idx],infoConfirmada,seccionId,titulo:tituloVal,fecha:fechaVal,descripcion:descVal,pais:paisVal,imagenes:[...pendingImages],imagen:null,subEventos};
    } else {
      eventos.push({id:uid(),infoConfirmada,seccionId,titulo:tituloVal,fecha:fechaVal,descripcion:descVal,pais:paisVal,imagenes:[...pendingImages],subEventos,creadoEn:Date.now()});
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
  renderVerifyStatus('ver-confirmacion',ev);
  renderEventSectionView(ev,tl);
  renderEventCountryView(ev);
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
  selectFondo('nueva','liso');
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
    const {ref, writePromise}=createTimeline({nombre,desc,color:selectedColor,fondo:selectedFondo,imagenUrl:pendingTlImagenUrl||null,privada,ownerSocials:getMySocials()});
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
  setFondoPickerAccent('nueva',color);
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
  if(user){
    try { await getUserProfile(user.uid); } catch(e){ console.error(e); }
  }

  // Muestra la nota de deploy solo si el usuario logueado es root.
  document.getElementById('nota-deploy-root').classList.toggle('hidden', !isRoot);

  // Muestra el botón para volver a "Lo Mío" solo si el usuario es root.
  document.getElementById('btn-lo-mio-root').classList.toggle('hidden', !isRoot);

  // El botón "Solicitudes" (revisar líneas sugeridas para el inicio)
  // solo lo ve el usuario root.
  document.getElementById('btn-solicitudes').classList.toggle('hidden', !isRoot);
  if(isRoot) refreshSolicitudesBadge();
  else document.getElementById('solicitudes-badge').classList.add('hidden');

  if(!initialRouteHandled){
    initialRouteHandled=true;
    await openRouteFromUrl();
    return;
  }

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
  window.addEventListener('popstate',()=>openRouteFromUrl());

  document.getElementById('btn-acceder').addEventListener('click',showAuth);
  document.getElementById('btn-nueva').addEventListener('click',openModalNueva);
  document.getElementById('btn-logout').addEventListener('click',logout);
  document.getElementById('btn-mi-perfil').addEventListener('click',()=>{
    if(!currentUser){ showAuth(); return; }
    renderPerfil(currentUser.uid);
  });
  document.getElementById('btn-perfil-back').addEventListener('click',renderHome);
  document.getElementById('btn-nueva-perfil').addEventListener('click',openModalNueva);
  document.getElementById('btn-copy-perfil-link').addEventListener('click',copyCurrentProfileLink);
  document.getElementById('btn-perfil-config').addEventListener('click',openModalPerfilConfig);
  document.getElementById('perfil-avatar-edit').addEventListener('click',()=>{
    document.getElementById('perfil-avatar-input').click();
  });
  document.getElementById('perfil-avatar-input').addEventListener('change',e=>{
    const archivo=e.target.files&&e.target.files[0];
    if(archivo) cambiarFotoPerfil(archivo);
    e.target.value='';
  });
  document.getElementById('modal-close-perfil-config').addEventListener('click',()=>hideModal('modal-perfil-config'));
  document.getElementById('btn-perfil-config-guardar').addEventListener('click',guardarPerfilConfig);
  document.getElementById('perfil-username-input').addEventListener('input',e=>{
    const clean=normalizeUsername(e.target.value);
    if(e.target.value!==clean) e.target.value=clean;
  });
  document.getElementById('perfil-social-enabled').addEventListener('change',e=>setPerfilSocialEnabled(e.target.checked));
  document.getElementById('btn-toggle-perfil-stats').addEventListener('click',()=>{
    perfilViewMode = perfilViewMode==='stats' ? 'lineas' : 'stats';
    applyPerfilViewMode();
  });
  document.getElementById('btn-toggle-perfil-guardados').addEventListener('click',()=>{
    perfilViewMode = perfilViewMode==='guardados' ? 'lineas' : 'guardados';
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
  document.getElementById('btn-add-timeline-section').addEventListener('click',()=>addTimelineSectionRow());
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

  document.getElementById('modal-close-comentarios').addEventListener('click',()=>hideModal('modal-comentarios'));
  document.getElementById('btn-enviar-comentario').addEventListener('click',enviarComentario);
  document.getElementById('comentario-texto').addEventListener('keydown',e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); enviarComentario(); }
  });

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
  setupHashtagsEditor();
  selectFondo('nueva','liso');
  document.querySelectorAll('.fondo-option').forEach(btn=>{
    btn.addEventListener('click',()=>selectFondo(btn.closest('.fondo-picker').dataset.scope,btn.dataset.fondo));
  });

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

  initialRouteHandled=true;
  openRouteFromUrl();
});
