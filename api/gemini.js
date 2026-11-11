// api/gemini.js — Asistente Ampi con herramienta para crear solicitudes.
// Requiere: npm i firebase-admin
// Variables de entorno en Vercel: GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT (JSON completo), GEMINI_MODEL (opcional)
import crypto from 'crypto';
import admin from 'firebase-admin';

// Si falta FIREBASE_SERVICE_ACCOUNT, el chat sigue respondiendo preguntas pero sin crear solicitudes.
let db = null;
try {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = admin.firestore();
} catch (e) { console.warn('Firebase Admin no configurado: Ampi no podrá crear solicitudes', e.message); }
const CREAR_OK = !!db;
const MODELO = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Flash-Lite 3.5 usa por defecto thinking "minimal"; con herramientas conviene "medium" para que no se salte la llamada.
const THINKING = process.env.GEMINI_THINKING || 'medium';
const TZ = 'America/Mexico_City';
const MAX_SOLICITUDES_POR_HORA = 3;

// ===== PEGA AQUÍ tu línea 20 vieja =====
// Borra la línea "const instrucciones = ..." de abajo y pega en su lugar la línea 20 completa de tu archivo anterior
// (empieza con: const instrucciones = `Eres el asistente de ISEP...  y termina con ${mensaje}`; ).
const mensaje = ''; // (necesario para que tu línea vieja funcione; no lo borres)

  const instrucciones = `Eres el asistente de ISEP, S.A., una empresa de electricistas que da servicio a domicilio en toda la República Mexicana, con mayor cobertura en Tabasco. Responde breve y claro en español, en tono profesional y amable. Escribe en texto plano: no uses Markdown, no uses asteriscos, guiones bajos, numerales ni tablas. Mensaje del cliente: ${mensaje}`;

// ===== FIN =====
const INFO_EMPRESA = instrucciones.replace(/\s*Mensaje del cliente:\s*$/i, '');

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

const DECL = {
  name: 'crear_solicitud',
  description: 'Registra una solicitud de servicio eléctrico en administración. Llámala SOLO cuando tengas todos los datos y el cliente haya confirmado el resumen con un "sí" explícito.',
  parameters: {
    type: 'OBJECT',
    properties: {
      nombre: { type: 'STRING', description: 'Nombre completo del cliente' },
      telefono: { type: 'STRING', description: 'Teléfono a 10 dígitos' },
      correo: { type: 'STRING', description: 'Correo electrónico' },
      servicios: { type: 'ARRAY', items: { type: 'STRING', enum: IDS }, description: 'Ids de los servicios que necesita' },
      servicio_otro: { type: 'STRING', description: 'Descripción si eligió "otro"' },
      detalle: { type: 'STRING', description: 'Detalles de la falla o trabajo (opcional)' },
      direccion: { type: 'STRING', description: 'Dirección completa: calle, número, colonia, ciudad' },
      fecha: { type: 'STRING', description: 'Fecha de la visita en formato YYYY-MM-DD' },
      hora: { type: 'STRING', description: 'Hora de la visita en formato HH:MM de 24 horas' },
      urgente: { type: 'BOOLEAN', description: 'true si hay corto, chispas u olor a quemado' },
      confirmado: { type: 'BOOLEAN', description: 'true SOLO si el cliente ya confirmó el resumen' }
    },
    required: ['nombre', 'telefono', 'correo', 'servicios', 'direccion', 'fecha', 'hora', 'confirmado']
  }
};

/* ---------- utilidades ---------- */
const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const horaMx = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
function fechaLegible(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function horaLegible(h) { const [H, M] = h.split(':').map(Number); return `${H % 12 || 12}:${String(M).padStart(2, '0')} ${H >= 12 ? 'p. m.' : 'a. m.'}`; }
function genFolio() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = ''; while (code.length < 8) code += abc[crypto.randomInt(abc.length)];
  return `CC-${hoyMx().replace(/-/g, '')}-${code}`;
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
async function limiteOk(ip) {
  const id = crypto.createHash('sha256').update(ip || 'sin-ip').digest('hex').slice(0, 32);
  const ref = db.collection('limites_chat').doc(id);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref), ahora = Date.now();
    const ts = (s.exists ? s.data().ts : []).filter(x => ahora - x < 3600000);
    if (ts.length >= MAX_SOLICITUDES_POR_HORA) return false;
    ts.push(ahora); tx.set(ref, { ts }); return true;
  });
}

/* ---------- validación + creación (aquí decide el servidor, no el modelo) ---------- */
const AFIRMA = /(^|[^a-záéíóúñ])(s[ií]|claro|confirm\w*|correcto|adelante|dale|ok|env[ií]a\w*|perfecto|as[ií] es)(?![a-záéíóúñ])/i;

async function crearSolicitud(a, ultimoUsuario, ip) {
  if (a.confirmado !== true || !AFIRMA.test(ultimoUsuario || '')) return { error: 'Falta que el cliente confirme el resumen con un "sí". Muéstrale el resumen y pídele confirmación.' };
  const nombre = String(a.nombre || '').trim();
  if (nombre.length < 3) return { error: 'Falta el nombre completo.' };
  let tel = String(a.telefono || '').replace(/\D/g, ''); if (tel.length === 12 && tel.startsWith('52')) tel = tel.slice(2);
  if (tel.length !== 10) return { error: 'El teléfono debe tener 10 dígitos.' };
  const correo = String(a.correo || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return { error: 'El correo no es válido.' };
  const servicios = [...new Set(Array.isArray(a.servicios) ? a.servicios : [])].filter(id => SERVICIOS[id]);
  if (!servicios.length) return { error: 'Falta al menos un servicio de la lista.' };
  const otro = String(a.servicio_otro || '').trim().slice(0, 120);
  if (servicios.includes('otro') && otro.length < 3) return { error: 'Describe qué servicio es "otro".' };
  const direccion = String(a.direccion || '').trim();
  if (direccion.length < 6) return { error: 'Falta la dirección completa.' };
  const fecha = String(a.fecha || ''), hora = String(a.hora || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + 'T12:00:00Z'))) return { error: 'La fecha no es válida (usa YYYY-MM-DD).' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return { error: 'La hora no es válida (usa HH:MM).' };
  if (fecha < hoyMx()) return { error: 'Esa fecha ya pasó.' };
  if (fecha === hoyMx() && hora < horaMx()) return { error: 'Esa hora ya pasó.' };

  if (!(await limiteOk(ip))) return { error: 'Se alcanzó el límite de solicitudes por chat. Pide al cliente que escriba por WhatsApp.' };

  const geo = await geocodificar(direccion);
  const base = {
    nombre, telefono: tel, correo, servicios,
    serviciosNombres: servicios.map(id => SERVICIOS[id]),
    servicioOtro: servicios.includes('otro') ? otro : '',
    detalleServicio: String(a.detalle || '').trim().slice(0, 500),
    direccion, geo: geo || null, tecnicoGeo: null,
    fecha, hora, fechaLegible: fechaLegible(fecha), horaLegible: horaLegible(hora),
    urgente: a.urgente === true,
    pin: String(crypto.randomInt(1000, 10000)),
    statusIdx: 0, estatus: 'Técnico sin asignar', tecnicoNombre: null,
    fcmToken: null, cotizacion: null, descuento: null,
    origen: 'ampi-chat', createdAt: Date.now()
  };
  for (let i = 0; i < 5; i++) {
    const folio = genFolio();
    try { await db.collection('solicitudes').doc(folio).create({ folio, ...base }); return { ok: true, folio, nombre }; }
    catch (e) { if (e.code !== 6 /* ALREADY_EXISTS */) { console.error('crear_solicitud', e); return { error: 'No se pudo guardar. Intenta de nuevo.' }; } }
  }
  return { error: 'No se pudo generar el folio. Intenta de nuevo.' };
}

/* ---------- Gemini ---------- */
function sistema() {
  const hoy = hoyMx();
  return `Eres Ampi, la cuija electricista, asistente virtual de ISEP. Habla en español, cálida y breve (máx. 4 líneas por mensaje).
${INFO_EMPRESA}
Hoy es ${fechaLegible(hoy)} (${hoy}) y son las ${horaMx()} en hora de México.

${CREAR_OK ? `SI EL CLIENTE QUIERE UN SERVICIO, puedes registrarle la solicitud con la herramienta crear_solicitud:
- Pide los datos que falten, máximo 2 por mensaje: nombre completo, teléfono (10 dígitos), correo, qué servicio necesita, dirección completa, fecha y hora de la visita.
- Elige los ids de servicio de esta lista (si no encaja, usa "otro"):
${IDS.map(id => `  ${id}: ${SERVICIOS[id]}`).join('\n')}
- Marca urgente=true solo si hay corto, chispas u olor a quemado, y recuérdale: aleje a todos, no toque nada y baje el interruptor general si es seguro.
- No inventes datos ni los supongas. Cuando los tengas todos, muestra un resumen y pregunta "¿Confirmas que la envíe?".
- Llama a crear_solicitud con confirmado=true SOLO después de que el cliente responda que sí. Nunca la llames antes.
- No prometas precios ni horarios exactos de llegada; el técnico confirma.` : ''}
No uses formato Markdown (nada de asteriscos, negritas ni encabezados): escribe texto plano.`;
}
async function gemini(contents) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema() }] },
      contents,
      ...(CREAR_OK ? { tools: [{ functionDeclarations: [DECL] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
      generationConfig: { thinkingConfig: { thinkingLevel: THINKING } } // sin temperature/top_p/top_k: Gemini 3.5 los ignora
    })
  });
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ texto: 'Método no permitido.' });

  if (!process.env.GEMINI_API_KEY) return res.status(200).json({ texto: 'El asistente aún no está activado: falta configurar GEMINI_API_KEY en Vercel.' });

  try {
    const body = req.body || {};
    let msgs = Array.isArray(body.mensajes) ? body.mensajes : (body.mensaje ? [{ role: 'user', text: body.mensaje }] : []);
    msgs = msgs.slice(-20).map(m => ({ role: m.role === 'bot' ? 'model' : 'user', text: String(m.text || '').slice(0, 1000) })).filter(m => m.text);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const ultimoUsuario = [...msgs].reverse().find(m => m.role === 'user')?.text || '';
    if (!ultimoUsuario) return res.status(400).json({ texto: 'Escribe tu pregunta.' });

    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const contents = msgs.map(m => ({ role: m.role, parts: [{ text: m.text }] }));

    for (let i = 0; i < 3; i++) {
      const data = await gemini(contents);
      const content = data.candidates?.[0]?.content;
      const parts = content?.parts || [];
      const fc = parts.find(p => p.functionCall);
      if (!fc) return res.json({ texto: limpiarMarkdown(parts.filter(p => !p.thought).map(p => p.text || '').join('').trim()) || 'No obtuve respuesta, intenta de nuevo.' });

      const r = fc.functionCall.name === 'crear_solicitud'
        ? await crearSolicitud(fc.functionCall.args || {}, ultimoUsuario, ip)
        : { error: 'Herramienta desconocida.' };
      if (r.ok) {
        return res.json({
          folio: r.folio,
          texto: `✅ Listo, ${r.nombre.split(' ')[0]}. Tu solicitud quedó registrada con el folio ${r.folio}. Un electricista la revisará y confirmará pronto. Puedes seguirla en "Rastrear mi folio".`
        });
      }
      contents.push(content); // se devuelve tal cual (con las firmas de pensamiento), como exige Gemini 3.x
      contents.push({ role: 'user', parts: [{ functionResponse: { id: fc.functionCall.id, name: fc.functionCall.name, response: { error: r.error } } }] });
    }
    return res.json({ texto: 'No pude completar la solicitud por el chat. Puedes llenarla en el formulario o escribirnos por WhatsApp.' });
  } catch (e) {
    console.error('api/gemini', e);
    return res.status(500).json({ texto: 'El asistente no está disponible por ahora. Escríbenos por WhatsApp.' });
  }
}

// Quita formato Markdown por si el modelo lo agrega (negritas, cursivas, encabezados, código, viñetas).
function limpiarMarkdown(texto) {
  return texto
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*]\s+/gm, '• ')
    .trim();
}
