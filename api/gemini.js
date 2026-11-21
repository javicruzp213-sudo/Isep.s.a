// api/gemini.js — Ampi: asistente que responde, crea / consulta / reagenda / cancela solicitudes y pasa con una persona.
// Requiere: firebase-admin (ya está en tu package.json).
// Variables de entorno en Vercel: GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT (JSON completo),
//   opcionales: GEMINI_MODEL, GEMINI_THINKING, ISEP_DEBUG=1 (muestra el error técnico en el chat mientras pruebas)
import crypto from 'crypto';
import admin from 'firebase-admin';

// Si falta FIREBASE_SERVICE_ACCOUNT, el chat sigue respondiendo preguntas pero sin acciones sobre solicitudes.
let db = null;
try {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = admin.firestore();
} catch (e) { console.warn('Firebase Admin no configurado: Ampi no podrá hacer acciones', e.message); }
const CREAR_OK = !!db;

const MODELO = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const THINKING = process.env.GEMINI_THINKING || 'medium';
const TZ = 'America/Mexico_City';

// ---- Reglas de negocio (ajústalas aquí) ----
const MAX_SOLICITUDES_POR_HORA = 3;   // solicitudes nuevas por IP
const MAX_ESCALACIONES_POR_HORA = 5;  // "pasar con una persona" por IP
const MAX_FALLOS_POR_HORA = 5;        // folio/teléfono incorrectos por IP
const CANCELAR_HASTA_IDX = 1;         // 0 sin asignar, 1 técnico asignado  (después: lo ve una persona)
const REAGENDAR_HASTA_IDX = 2;        // hasta "Confirmado"; si ya va en camino: lo ve una persona
const HORA_INI = 8, HORA_FIN = 20;      // la visita se agenda en horas exactas, de 8:00 a. m. a 8:00 p. m.
const STATUS = ['Técnico sin asignar', 'Técnico asignado', 'Confirmado', 'En camino', 'En servicio', 'Finalizado'];

// Tus instrucciones de siempre para Ampi:
const INFO_EMPRESA = `Eres el asistente de ISEP, S.A., una empresa de electricistas que da servicio a domicilio en toda la República Mexicana, con mayor cobertura en Tabasco. Responde breve y claro en español, en tono profesional y amable. Escribe en texto plano: no uses Markdown, no uses asteriscos, guiones bajos, numerales ni tablas.`;

const SERVICIOS = {
  corto:'Corto circuito / emergencia', sin_luz:'Me quedé sin luz en casa o en una parte', falla_tierra:'Descargas o toques eléctricos',
  olor_quemado:'Olor a quemado, chispas o cables calientes', se_botan:'Se botan las pastillas / el interruptor', baja_tension:'Variaciones de voltaje, luces que parpadean',
  instalacion:'Instalación eléctrica', inst_casa_nueva:'Instalación eléctrica completa (casa, local u oficina)', ampliacion:'Ampliación o nuevos circuitos',
  contactos:'Contactos y apagadores nuevos o cambio', contacto_gfci:'Contactos con protección (baños, cocina, exterior)', linea_dedicada:'Línea dedicada para equipos de alto consumo',
  canalizacion:'Canalización, tubería y registros', cableado_red:'Cableado estructurado / red y datos', medidor:'Cambio de medidor',
  acometida:'Acometida, mufa y base de medidor', panel:'Revisión de panel', cambio_panel:'Cambio o ampliación de centro de carga',
  pastillas:'Cambio de pastillas / interruptores', tierra_fisica:'Sistema de tierra física', supresor:'Protección contra descargas y picos de voltaje',
  transferencia:'Planta de emergencia / transferencia', iluminacion:'Iluminación y contactos', lamparas:'Instalación de lámparas, plafones y ventiladores de techo',
  led:'Cambio a iluminación LED', iluminacion_ext:'Iluminación de jardín, fachada y estacionamiento', fotocelda:'Fotoceldas, sensores de movimiento y temporizadores',
  regulador_luz:'Reguladores de intensidad (dimmers)', clima:'Aire acondicionado', minisplit:'Instalación o conexión eléctrica de minisplit',
  boiler:'Boiler eléctrico / calentador', bomba_agua:'Bomba de agua e hidroneumático', motores:'Motores, portones y compresores',
  cargador_ev:'Cargador para auto eléctrico', tinaco:'Control de nivel para tinaco / cisterna', paneles_solares:'Paneles solares: conexión eléctrica',
  ups:'Reguladores, no-break y UPS', camaras:'Cámaras y alarmas: alimentación eléctrica', intercomunicador:'Timbres, intercomunicadores y cerraduras eléctricas',
  pararrayos:'Pararrayos y protección atmosférica', revision_general:'Revisión eléctrica general', dictamen:'Dictamen o verificación de instalación eléctrica',
  termografia:'Detección de puntos calientes / termografía', mantenimiento:'Mantenimiento preventivo', cambio_cable:'Cambio de cableado viejo o de aluminio',
  ahorro:'Asesoría para bajar el recibo de luz', otro:'Otro (especifícalo abajo)'
};
const IDS = Object.keys(SERVICIOS);

/* ---------- herramientas que Ampi puede usar ---------- */
const S = (description) => ({ type: 'STRING', description });
const DECLS = [
  {
    name: 'crear_solicitud',
    description: 'Registra una solicitud NUEVA de servicio eléctrico. Llámala SOLO con todos los datos y después de que el cliente confirme el resumen con un "sí".',
    parameters: { type: 'OBJECT', properties: {
      nombre: S('Nombre completo'), telefono: S('Teléfono a 10 dígitos'), correo: S('Correo electrónico'),
      servicios: { type: 'ARRAY', items: { type: 'STRING', enum: IDS }, description: 'Ids de servicio' },
      servicio_otro: S('Descripción si eligió "otro"'), detalle: S('Detalles de la falla (opcional)'),
      direccion: S('Dirección completa: calle, número, colonia, ciudad'),
      fecha: S('Fecha de la visita YYYY-MM-DD'), hora: S('Hora exacta de la visita HH:00 (24 h), entre 08:00 y 20:00'),
      urgente: { type: 'BOOLEAN', description: 'true si hay corto, chispas u olor a quemado' },
      factura: { type: 'BOOLEAN', description: 'true si el cliente pidió factura' },
      rfc: S('RFC (solo si pidió factura)'), tipo_persona: { type: 'STRING', enum: ['fisica', 'moral'], description: 'Persona física (RFC de 13 caracteres) o moral (12). Solo si pidió factura' },
      confirmado: { type: 'BOOLEAN', description: 'true SOLO si el cliente ya confirmó el resumen' }
    }, required: ['nombre', 'telefono', 'correo', 'servicios', 'direccion', 'fecha', 'hora', 'confirmado'] }
  },
  {
    name: 'consultar_estatus',
    description: 'Consulta el estatus de una solicitud existente. Requiere el folio y el teléfono con el que se hizo.',
    parameters: { type: 'OBJECT', properties: { folio: S('Folio, ej. CC-20261114-AB12CD34'), telefono: S('Teléfono de 10 dígitos de la solicitud') }, required: ['folio', 'telefono'] }
  },
  {
    name: 'reagendar_solicitud',
    description: 'Cambia la fecha y hora de la visita de una solicitud existente. Llámala SOLO después de que el cliente confirme la nueva fecha y hora con un "sí".',
    parameters: { type: 'OBJECT', properties: {
      folio: S('Folio'), telefono: S('Teléfono de 10 dígitos de la solicitud'),
      fecha: S('Nueva fecha YYYY-MM-DD'), hora: S('Nueva hora exacta HH:00 (24 h), entre 08:00 y 20:00'),
      confirmado: { type: 'BOOLEAN', description: 'true SOLO si el cliente ya confirmó' }
    }, required: ['folio', 'telefono', 'fecha', 'hora', 'confirmado'] }
  },
  {
    name: 'cancelar_solicitud',
    description: 'Cancela una solicitud existente. Llámala SOLO después de que el cliente confirme con un "sí" que quiere cancelarla.',
    parameters: { type: 'OBJECT', properties: {
      folio: S('Folio'), telefono: S('Teléfono de 10 dígitos de la solicitud'), motivo: S('Motivo de la cancelación (opcional)'),
      confirmado: { type: 'BOOLEAN', description: 'true SOLO si el cliente ya confirmó' }
    }, required: ['folio', 'telefono', 'confirmado'] }
  },
  {
    name: 'pasar_a_humano',
    description: 'Registra el caso y pasa al cliente con una persona (botones de llamada y WhatsApp). Úsala cuando no puedas resolver, haya queja, enojo, pago o cobro en disputa, emergencia, cambio de dirección o de servicio, o el cliente pida hablar con alguien.',
    parameters: { type: 'OBJECT', properties: {
      destino: { type: 'STRING', enum: ['administracion', 'tecnico'], description: 'administracion por defecto; tecnico si es algo de la visita en curso (retraso, ubicación, llegada) y ya hay técnico asignado' },
      motivo: S('Motivo corto'), resumen: S('Resumen de lo hablado para que la persona no tenga que preguntar de nuevo'),
      folio: S('Folio si lo conoces'), telefono: S('Teléfono del cliente si lo dio'),
      urgente: { type: 'BOOLEAN', description: 'true si hay riesgo eléctrico o es una emergencia' }
    }, required: ['destino', 'motivo', 'resumen'] }
  }
];

/* ---------- utilidades ---------- */
const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const horaMx = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
function fechaLegible(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function horaLegible(h) { const [H, M] = h.split(':').map(Number); return `${H % 12 || 12}:${String(M).padStart(2, '0')} ${H >= 12 ? 'p. m.' : 'a. m.'}`; }
const tel10 = (x) => { let t = String(x || '').replace(/\D/g, ''); if (t.length === 12 && t.startsWith('52')) t = t.slice(2); return t; };
function genFolio() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = ''; while (code.length < 8) code += abc[crypto.randomInt(abc.length)];
  return `CC-${hoyMx().replace(/-/g, '')}-${code}`;
}
function validarFechaHora(fecha, hora) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || isNaN(new Date(fecha + 'T12:00:00Z'))) return 'La fecha no es válida (usa YYYY-MM-DD).';
  if (!/^([01]\d|2[0-3]):00$/.test(hora || '') || Number(hora.slice(0, 2)) < HORA_INI || Number(hora.slice(0, 2)) > HORA_FIN) return 'Las visitas se agendan en horas exactas entre las 8:00 a. m. y las 8:00 p. m. (formato HH:00).';
  if (fecha < hoyMx()) return 'Esa fecha ya pasó.';
  if (fecha === hoyMx() && hora < horaMx()) return 'Esa hora ya pasó.';
  return null;
}
async function geocodificar(direccion) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=${encodeURIComponent(direccion)}`,
      { signal: ctl.signal, headers: { 'User-Agent': 'ISEP-Ampi/1.0 (contacto: isep)' } });
    const d = await r.json();
    return d && d[0] ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) } : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
// Estatus 0-5 (misma lógica que la página del cliente)
function idxEstatus(d) {
  const quitar = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias = { sinasignar: 0, tecnicosinasignar: 0, sintecnico: 0, pendiente: 0, recibido: 0, nuevo: 0, solicitado: 0, asignado: 1, tecnicoasignado: 1, confirmado: 2, aceptado: 2, programado: 2, encamino: 3, enruta: 3, camino: 3, enservicio: 4, enproceso: 4, iniciado: 4, trabajando: 4, llegue: 4, llegado: 4, finalizado: 5, completado: 5, terminado: 5, concluido: 5, listo: 5, hecho: 5 };
  const campos = [d.estatus, d.status, d.estado, d.statusNombre, d.estatusNombre, d.statusIdx, d.statusIndex];
  for (const v of campos) { if (typeof v !== 'string' || !v) continue; const k = quitar(v); if (k in alias) return alias[k]; }
  for (const v of campos) { if (v === undefined || v === null || v === '') continue; const n = Number(v); if (Number.isInteger(n) && n >= 0 && n <= 5) return n; }
  return d.tecnicoNombre ? 1 : 0;
}

/* ---------- límites por IP (guardados en Firestore: ' limites_chat ') ---------- */
const idIp = (ip, clave) => crypto.createHash('sha256').update((ip || 'sin-ip') + ':' + clave).digest('hex').slice(0, 32);
async function tomarCupo(ip, clave, max) {
  const ref = db.collection('limites_chat').doc(idIp(ip, clave));
  return db.runTransaction(async tx => {
    const s = await tx.get(ref), ahora = Date.now();
    const ts = (s.exists ? s.data().ts : []).filter(x => ahora - x < 3600000);
    if (ts.length >= max) return false;
    ts.push(ahora); tx.set(ref, { ts }); return true;
  });
}
async function fallosBloqueado(ip) {
  const s = await db.collection('limites_chat').doc(idIp(ip, 'fallos')).get();
  const ahora = Date.now(); return (s.exists ? s.data().ts : []).filter(x => ahora - x < 3600000).length >= MAX_FALLOS_POR_HORA;
}
async function registrarFallo(ip) {
  const ref = db.collection('limites_chat').doc(idIp(ip, 'fallos'));
  await db.runTransaction(async tx => {
    const s = await tx.get(ref), ahora = Date.now();
    const ts = (s.exists ? s.data().ts : []).filter(x => ahora - x < 3600000); ts.push(ahora); tx.set(ref, { ts });
  });
}

/* ---------- aviso push al técnico asignado (mismo sitio e ícono que api/avisar-tecnico.js) ---------- */
const SITIO_TECNICO = 'https://tecnicosisep.netlify.app/';
const TOKEN_INVALIDO = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];
async function avisarTecnico(d, folio, titulo, texto, tag) {
  if (!db || !d || !d.tecnicoUid) return false;
  try {
    const ref = db.collection('tecnicos').doc(d.tecnicoUid), t = await ref.get();
    const token = t.exists ? t.data().fcmToken : null;
    if (!token) return false;
    try {
      await admin.messaging().send({
        token, notification: { title: titulo, body: String(texto).slice(0, 180) },
        webpush: { notification: { icon: `${SITIO_TECNICO}icon-192.png`, tag: `${tag}-${folio}`, renotify: true, vibrate: [200, 100, 200] }, fcmOptions: { link: SITIO_TECNICO } }
      });
      return true;
    } catch (e) {
      if (TOKEN_INVALIDO.includes(e.code)) await ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
      else console.warn('push al técnico', e.message);
      return false;
    }
  } catch (e) { console.warn('push al técnico', e.message); return false; }   // un fallo del aviso nunca rompe la acción principal
}

/* ---------- acciones (aquí decide el servidor, no el modelo) ---------- */
const AFIRMA = /(^|[^a-záéíóúñ])(s[ií]|claro|confirm\w*|correcto|adelante|dale|ok|env[ií]a\w*|cancela\w*|perfecto|as[ií] es)(?![a-záéíóúñ])/i;
const necesitaConfirmar = (a, ctx) => (a.confirmado !== true || !AFIRMA.test(ctx.ultimoUsuario || ''))
  ? { error: 'Falta que el cliente confirme con un "sí". Muéstrale el resumen de lo que vas a hacer y pídele confirmación.' } : null;

async function crearSolicitud(a, ctx) {
  const c = necesitaConfirmar(a, ctx); if (c) return c;
  const nombre = String(a.nombre || '').trim(); if (nombre.length < 3) return { error: 'Falta el nombre completo.' };
  const tel = tel10(a.telefono); if (tel.length !== 10) return { error: 'El teléfono debe tener 10 dígitos.' };
  const correo = String(a.correo || '').trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return { error: 'El correo no es válido.' };
  const servicios = [...new Set(Array.isArray(a.servicios) ? a.servicios : [])].filter(id => SERVICIOS[id]);
  if (!servicios.length) return { error: 'Falta al menos un servicio de la lista.' };
  const otro = String(a.servicio_otro || '').trim().slice(0, 120);
  if (servicios.includes('otro') && otro.length < 3) return { error: 'Describe qué servicio es "otro".' };
  const direccion = String(a.direccion || '').trim(); if (direccion.length < 6) return { error: 'Falta la dirección completa.' };
  const errFH = validarFechaHora(String(a.fecha || ''), String(a.hora || '')); if (errFH) return { error: errFH };
  let factura = null;
  if (a.factura === true) {
    const rfc = String(a.rfc || '').trim().toUpperCase(), tipo = a.tipo_persona === 'moral' ? 'moral' : (a.tipo_persona === 'fisica' ? 'fisica' : '');
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(rfc)) return { error: 'El RFC no es válido (persona física 13 caracteres, persona moral 12).' };
    if (!tipo) return { error: 'Pregunta si es persona física o persona moral.' };
    if ((tipo === 'fisica' && rfc.length !== 13) || (tipo === 'moral' && rfc.length !== 12)) return { error: `El RFC no coincide con persona ${tipo === 'fisica' ? 'física (13 caracteres)' : 'moral (12 caracteres)'}. Verifícalo con el cliente.` };
    factura = { rfc, tipoPersona: tipo, correo };
  }
  if (!(await tomarCupo(ctx.ip, 'nuevas', MAX_SOLICITUDES_POR_HORA))) return { error: 'Se alcanzó el límite de solicitudes por chat. Pasa al cliente con administración.' };
  const fecha = String(a.fecha), hora = String(a.hora);
  const geo = await geocodificar(direccion);
  const base = {
    nombre, telefono: tel, correo, servicios, serviciosNombres: servicios.map(id => SERVICIOS[id]),
    servicioOtro: servicios.includes('otro') ? otro : '', detalleServicio: String(a.detalle || '').trim().slice(0, 500),
    direccion, geo: geo || null, tecnicoGeo: null,
    fecha, hora, fechaLegible: fechaLegible(fecha), horaLegible: horaLegible(hora),
    urgente: a.urgente === true, factura, fotosCount: 0,
    pin: String(crypto.randomInt(1000, 10000)), statusIdx: 0, estatus: STATUS[0], tecnicoNombre: null,
    fcmToken: null, cotizacion: null, descuento: null, origen: 'ampi-chat', createdAt: Date.now()
  };
  for (let i = 0; i < 5; i++) {
    const folio = genFolio();
    try {
      await db.collection('solicitudes').doc(folio).create({ folio, ...base });
      return { ok: true, final: true, extra: { folio },
        texto: `✅ Listo, ${nombre.split(' ')[0]}. Tu solicitud quedó registrada con el folio ${folio}. Un electricista la revisará y confirmará pronto. Puedes seguirla en "Rastrear mi folio".` };
    } catch (e) { if (e.code !== 6) { console.error('crear_solicitud', e); return { error: 'No se pudo guardar. Intenta de nuevo.' }; } }
  }
  return { error: 'No se pudo generar el folio. Intenta de nuevo.' };
}

// Verifica folio + teléfono (con límite de intentos fallidos por IP)
async function verificar(a, ctx) {
  const folio = String(a.folio || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(folio)) return { error: 'El folio no tiene un formato válido. Pídeselo al cliente (está en su ticket).' };
  const tel = tel10(a.telefono); if (tel.length !== 10) return { error: 'Falta el teléfono de 10 dígitos con el que se hizo la solicitud.' };
  if (await fallosBloqueado(ctx.ip)) return { error: 'Demasiados intentos de verificación. Usa pasar_a_humano con destino "administracion".' };
  const ref = db.collection('solicitudes').doc(folio), s = await ref.get();
  if (!s.exists || tel10(s.data().telefono) !== tel) { await registrarFallo(ctx.ip); return { error: 'No encontré una solicitud con ese folio y teléfono. Pídele al cliente que los revise.' }; }
  return { ref, d: s.data(), folio, tel };
}

async function consultarEstatus(a, ctx) {
  const v = await verificar(a, ctx); if (v.error) return v;
  const d = v.d, idx = idxEstatus(d), monto = Number(d.montoCobrado) || 0;
  return { ok: true, datos: {
    folio: v.folio, estatus: d.cancelada ? 'Cancelada' : STATUS[idx], tecnico: d.tecnicoNombre || null,
    visita: d.fecha && d.hora ? `${fechaLegible(d.fecha)} a las ${horaLegible(d.hora)}` : null,
    urgente: !!d.urgente, reprogramada: !!d.reprogramada,
    pago: monto > 0 ? (d.pagado ? 'pagado' : `pendiente: $${monto} MXN`) : 'sin cobro registrado',
    puedeReagendar: !d.cancelada && idx <= REAGENDAR_HASTA_IDX, puedeCancelar: !d.cancelada && idx <= CANCELAR_HASTA_IDX
  } };
}

async function reagendar(a, ctx) {
  const c = necesitaConfirmar(a, ctx); if (c) return c;
  const v = await verificar(a, ctx); if (v.error) return v;
  const fecha = String(a.fecha || ''), hora = String(a.hora || '');
  const errFH = validarFechaHora(fecha, hora); if (errFH) return { error: errFH };
  let datos = null;
  const r = await db.runTransaction(async t => {
    const s = await t.get(v.ref), d = s.data(), idx = idxEstatus(d);
    if (d.cancelada) return { error: 'Esa solicitud ya está cancelada.' };
    if (idx > REAGENDAR_HASTA_IDX) return { error: `Ya no se puede reagendar por el chat (estatus: ${STATUS[idx]}). Usa pasar_a_humano con destino "tecnico".` };
    t.update(v.ref, { fecha, hora, fechaLegible: fechaLegible(fecha), horaLegible: horaLegible(hora),
      reprogramada: true, reprogramaciones: admin.firestore.FieldValue.increment(1), reprogramadaEn: Date.now(), reprogramadaPor: 'ampi-chat' });
    datos = d;
    return { ok: true, final: true, extra: { folio: v.folio },
      texto: `✅ Listo. Tu visita del folio ${v.folio} quedó para el ${fechaLegible(fecha)} a las ${horaLegible(hora)}.${idx >= 1 ? ' La nueva fecha ya está actualizada en el sistema para tu técnico.' : ''}` };
  });
  if (r.ok && datos) await avisarTecnico(datos, v.folio, `ISEP · El cliente cambió la fecha · Folio ${v.folio}`, `Nueva visita: ${fechaLegible(fecha)} a las ${horaLegible(hora)}.`, 'reprogramada');
  return r;
}

async function cancelar(a, ctx) {
  const c = necesitaConfirmar(a, ctx); if (c) return c;
  const v = await verificar(a, ctx); if (v.error) return v;
  let datos = null;
  const r = await db.runTransaction(async t => {
    const s = await t.get(v.ref), d = s.data(), idx = idxEstatus(d);
    if (d.cancelada) return { error: 'Esa solicitud ya estaba cancelada.' };
    if (idx > CANCELAR_HASTA_IDX) return { error: `Ya no se puede cancelar por el chat (estatus: ${STATUS[idx]}). Usa pasar_a_humano con destino "administracion".` };
    t.update(v.ref, { cancelada: true, estatus: 'Cancelado', canceladaEn: Date.now(), canceladaPor: 'ampi-chat', motivoCancelacion: String(a.motivo || '').trim().slice(0, 200) });
    datos = d;
    return { ok: true, final: true, extra: { folio: v.folio }, texto: `Tu solicitud ${v.folio} quedó cancelada. Si necesitas un servicio más adelante, aquí estaré para ayudarte.` };
  });
  if (r.ok && datos) await avisarTecnico(datos, v.folio, `ISEP · Solicitud cancelada · Folio ${v.folio}`, 'El cliente canceló esta solicitud. Ya no necesitas ir.', 'cancelada');
  return r;
}

// Registra el caso para que administración lo vea y devuelve los botones de llamada/WhatsApp al cliente
async function registrarEscalacion({ destino, motivo, resumen, folio, telefono, urgente }, ctx) {
  destino = destino === 'tecnico' ? 'tecnico' : 'administracion';
  if (db && await tomarCupo(ctx.ip, 'humano', MAX_ESCALACIONES_POR_HORA)) {
    const doc = { estado: 'pendiente', destino, motivo: String(motivo || '').slice(0, 200), resumen: String(resumen || '').slice(0, 600),
      folio: null, urgente: urgente === true, origen: 'ampi-chat', createdAt: Date.now() };
    try {
      if (folio) {
        const f = String(folio).trim().toUpperCase(), ref = db.collection('solicitudes').doc(f), s = await ref.get();
        if (s.exists && tel10(s.data().telefono) === tel10(telefono)) {      // solo se marca si folio y teléfono coinciden
          doc.folio = f; doc.telefonoCliente = tel10(telefono);
          await ref.update({ requiereAtencion: true, atencionDestino: destino, atencionMotivo: doc.motivo, atencionEn: Date.now() });
          if (destino === 'tecnico') await avisarTecnico(s.data(), f, `ISEP · El cliente quiere hablar contigo · Folio ${f}`, `${doc.motivo || 'Atención requerida'}. Llámale desde tu panel.`, 'atencion');
        }
      }
      await db.collection('escalaciones').add(doc);
    } catch (e) { console.error('escalacion', e); }
  }
  return { destino, motivo: String(motivo || '').slice(0, 200), resumen: String(resumen || '').slice(0, 400), folio: folio ? String(folio).trim().toUpperCase() : null, urgente: urgente === true };
}
async function pasarAHumano(a, ctx) {
  const h = await registrarEscalacion(a, ctx);
  const quien = h.destino === 'tecnico' ? 'tu técnico' : 'administración de ISEP';
  return { ok: true, final: true, extra: { handoff: h },
    texto: `Te paso con ${quien}. Ya dejé registrado tu caso con un resumen para que no tengas que repetirlo. Toca «Llamar ahora» o escribe por WhatsApp.${h.urgente ? ' Si hay chispas, humo u olor a quemado: aleja a todos, no toques nada y, si es seguro, baja el interruptor general.' : ''}` };
}

async function ejecutar(nombre, args, ctx) {
  try {
    if (!CREAR_OK) return { error: 'Las acciones no están disponibles por ahora. Usa pasar_a_humano.' };
    switch (nombre) {
      case 'crear_solicitud': return await crearSolicitud(args, ctx);
      case 'consultar_estatus': return await consultarEstatus(args, ctx);
      case 'reagendar_solicitud': return await reagendar(args, ctx);
      case 'cancelar_solicitud': return await cancelar(args, ctx);
      case 'pasar_a_humano': return await pasarAHumano(args, ctx);
      default: return { error: 'Herramienta desconocida.' };
    }
  } catch (e) { console.error('herramienta', nombre, e); return { error: 'Ocurrió un error al hacerlo. Si se repite, usa pasar_a_humano.' }; }
}

/* ---------- Gemini ---------- */
function sistema(folios) {
  const hoy = hoyMx();
  const acciones = CREAR_OK ? `
TIENES ESTAS ACCIONES REALES (usa las herramientas, no las simules):
1) crear_solicitud: para un servicio NUEVO. Pide los datos que falten, máximo 2 por mensaje: nombre completo, teléfono (10 dígitos), correo, servicio, dirección completa, fecha y hora. Si pide factura: su RFC y si es persona física o moral (nada más; administración le pedirá después su constancia fiscal). Las visitas se agendan en horas exactas (por ejemplo 10:00) entre las 8:00 a. m. y las 8:00 p. m. Elige ids de esta lista (si no encaja, "otro"):
${IDS.map(id => `   ${id}: ${SERVICIOS[id]}`).join('\n')}
2) consultar_estatus, reagendar_solicitud y cancelar_solicitud: SIEMPRE pide el folio y el teléfono de 10 dígitos con el que se hizo la solicitud (es la verificación). No des datos de una solicitud sin verificar.${folios.length ? `\n   Folios guardados en el dispositivo del cliente (confírmalos con él antes de usarlos): ${folios.join(', ')}.` : ''}
3) pasar_a_humano: registra el caso y le muestra al cliente los botones para llamar o escribir por WhatsApp.
REGLAS:
- Antes de crear, reagendar o cancelar, resume lo que harás y pregunta "¿Confirmas?". Llama a la herramienta con confirmado=true SOLO después de un sí explícito.
- Reagendar: se puede hasta que el técnico esté confirmado; cancelar: solo si aún no tiene técnico o apenas lo asignaron. Si la herramienta dice que ya no se puede, explícalo y usa pasar_a_humano.
- Usa pasar_a_humano SIN insistir en intentarlo tú cuando: el cliente lo pida, haya queja o enojo, discusión de cobros/pagos/reembolsos/descuentos, cambio de dirección o de servicio, retraso o problema con la visita en curso (destino "tecnico" si ya hay técnico asignado), una emergencia eléctrica, o si tus herramientas fallan dos veces. Con riesgo eléctrico marca urgente=true.
- No inventes datos ni los supongas. No prometas precios ni horas exactas de llegada; el técnico confirma.` : '';
  return `${INFO_EMPRESA}
Eres Ampi, la cuija electricista, asistente virtual de ISEP. Máximo 4 líneas por mensaje.
Hoy es ${fechaLegible(hoy)} (${hoy}) y son las ${horaMx()} en hora de México.${acciones}
Texto plano: sin Markdown, sin asteriscos, sin guiones bajos, sin numerales, sin tablas.`;
}
async function llamarGemini(contents, folios, { tools = true, thinking = true } = {}) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema(folios) }] }, contents,
      ...(CREAR_OK && tools ? { tools: [{ functionDeclarations: DECLS }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      ...(thinking ? { generationConfig: { thinkingConfig: { thinkingLevel: THINKING } } } : {})
    })
  });
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
// Si Gemini rechaza algo (nivel de pensamiento o esquema de herramientas), reintenta más simple para que el chat NUNCA se caiga
async function gemini(contents, folios) {
  const intentos = [{}, { thinking: false }, { tools: false, thinking: false }];
  let ultimo;
  for (const opt of intentos) { try { return await llamarGemini(contents, folios, opt); } catch (e) { ultimo = e; console.warn('Gemini falló con', JSON.stringify(opt), e.message); } }
  throw ultimo;
}

function limpiarMarkdown(texto) {
  return texto.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/__(.*?)__/g, '$1').replace(/_(.*?)_/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^[-*]\s+/gm, '• ').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ texto: 'Método no permitido.' });
  if (!process.env.GEMINI_API_KEY) return res.status(200).json({ texto: 'El asistente aún no está activado: falta configurar GEMINI_API_KEY en Vercel.' });

  const HANDOFF_FALLA = { destino: 'administracion', motivo: 'El asistente no pudo resolver el caso', resumen: '', folio: null, urgente: false };
  try {
    const body = req.body || {};
    let msgs = Array.isArray(body.mensajes) ? body.mensajes : (body.mensaje ? [{ role: 'user', text: body.mensaje }] : []);
    msgs = msgs.slice(-20).map(m => ({ role: m.role === 'bot' ? 'model' : 'user', text: String(m.text || '').slice(0, 1000) })).filter(m => m.text);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const ultimoUsuario = [...msgs].reverse().find(m => m.role === 'user')?.text || '';
    if (!ultimoUsuario) return res.status(400).json({ texto: 'Escribe tu pregunta.' });
    const folios = (Array.isArray(body.contexto?.folios) ? body.contexto.folios : []).map(String).filter(f => /^[A-Z0-9-]{6,40}$/.test(f)).slice(0, 3);

    const ctx = { ultimoUsuario, ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() };
    const contents = msgs.map(m => ({ role: m.role, parts: [{ text: m.text }] }));

    for (let i = 0; i < 4; i++) {
      const data = await gemini(contents, folios);
      const content = data.candidates?.[0]?.content;
      const parts = content?.parts || [];
      const llamadas = parts.filter(p => p.functionCall);
      if (!llamadas.length) return res.json({ texto: limpiarMarkdown(parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()) || 'No obtuve respuesta, intenta de nuevo.' });

      const respuestas = []; let final = null;
      for (const p of llamadas) {
        const r = await ejecutar(p.functionCall.name, p.functionCall.args || {}, ctx);
        if (r.ok && r.final && !final) final = r;
        respuestas.push({ functionResponse: { id: p.functionCall.id, name: p.functionCall.name, response: r.ok ? (r.datos || { ok: true }) : { error: r.error } } });
      }
      if (final) return res.json({ texto: final.texto, ...(final.extra || {}) });
      contents.push(content);   // se devuelve tal cual (con las firmas de pensamiento), como exige Gemini 3.x
      contents.push({ role: 'user', parts: respuestas });
    }
    // No se resolvió en varios intentos: pasa automáticamente a una persona
    const h = await registrarEscalacion({ destino: 'administracion', motivo: 'Ampi no pudo resolver la consulta', resumen: ultimoUsuario }, ctx);
    return res.json({ texto: 'No pude resolver esto por el chat. Te paso con administración: toca «Llamar ahora» o escribe por WhatsApp.', handoff: h });
  } catch (e) {
    console.error('api/gemini', e);
    return res.status(500).json({ texto: 'El asistente no está disponible por ahora. Puedes llamar o escribir a administración.', handoff: HANDOFF_FALLA,
      ...(process.env.ISEP_DEBUG === '1' ? { error: String(e.message || e).slice(0, 400) } : {}) });
  }
}
