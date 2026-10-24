// Vercel Serverless Function: evaluación de aspirantes a técnico.
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT, ADMIN_UIDS, ORIGENES_EXTRA (las mismas de notificar.js),
// GEMINI_API_KEY (obligatoria para generar preguntas) y GEMINI_MODEL (opcional).
// Colecciones (solo el servidor las toca; en las reglas de Firestore deben quedar cerradas al cliente):
//   bancoPreguntas/{id}: categoria, pregunta, opciones[4], correcta, estado (pendiente|aprobada|rechazada)
//   aspirantes/{id}: datos, estado, preguntas[], indice, respuestas[], incidentes, puntaje
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  const c = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (c.private_key) c.private_key = c.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(c) });
}
const db = () => admin.firestore();
const TS = () => admin.firestore.FieldValue.serverTimestamp();

const ORIGENES = ['https://isep-s-a.vercel.app', 'https://tecnicosisep.netlify.app', 'https://administradoresisep.netlify.app',
  ...(process.env.ORIGENES_EXTRA || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)];
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

const CATS = {
  electricista_baja: 'electricista de baja tensión (instalaciones residenciales y comerciales pequeñas)',
  electricista_media: 'electricista de media tensión (subestaciones, transformadores, protecciones)',
  electricista_alta: 'electricista de alta tensión (líneas, subestaciones, maniobras y seguridad en alta tensión)',
  ayudante: 'ayudante de electricista o técnico (herramientas, seguridad básica, apoyo en obra)',
  clima: 'técnico en aire acondicionado y climatización (refrigerantes, mantenimiento, diagnóstico)'
};
const N = 10, SEG = 45, GRACIA = 4, APRUEBA = 70, MAX_INCIDENTES = 3, ESPERA_DIAS = 30;
const MODELO = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const mezclar = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ms = v => (v && v.toMillis ? v.toMillis() : 0);
class Err extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function esAdmin(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!t) throw new Err(401, 'No autorizado');
  let d; try { d = await admin.auth().verifyIdToken(t); } catch (e) { throw new Err(401, 'No autorizado'); }
  if (!ADMIN_UIDS.includes(d.uid)) throw new Err(403, 'Solo administración');
}

// El aspirante se identifica con un token secreto que solo recibe al iniciar.
async function cargar(b) {
  const ref = db().collection('aspirantes').doc(String(b.id || '/'));
  const s = await ref.get();
  if (!s.exists) throw new Err(404, 'Evaluación no encontrada');
  const a = s.data();
  const x = Buffer.from(sha(b.token || '')), y = Buffer.from(a.tokenHash || '');
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) throw new Err(403, 'No autorizado');
  return { ref, a };
}

async function finalizar(ref, a, correctas, motivo) {
  const puntaje = Math.round((correctas / N) * 100);
  const ok = !motivo && puntaje >= APRUEBA;
  await ref.update({ estado: ok ? 'aprobado' : 'rechazado', puntaje, motivoRechazo: motivo || null, finEn: TS() });
  return { fin: true, puntaje, estado: ok ? 'aprobado' : 'rechazado', motivo: motivo || null };
}

const acciones = {
  async iniciar(b) {
    const nombre = String(b.nombre || '').trim().slice(0, 80), correo = String(b.correo || '').trim().toLowerCase().slice(0, 120);
    const tel = String(b.telefono || '').replace(/\D/g, '');
    if (nombre.length < 3 || tel.length < 10 || tel.length > 15 || !/^\S+@\S+\.\S+$/.test(correo) || !CATS[b.categoria]) throw new Err(400, 'Revisa tus datos');
    const previos = await db().collection('aspirantes').where('telefono', '==', tel).get();
    for (const d of previos.docs) {
      const p = d.data();
      if (p.estado !== 'rechazado') throw new Err(409, 'Ya tienes una evaluación registrada con este teléfono.');
      if (Date.now() - ms(p.finEn) < ESPERA_DIAS * 86400000) throw new Err(409, `Podrás volver a intentarlo ${ESPERA_DIAS} días después de tu evaluación.`);
    }
    const banco = await db().collection('bancoPreguntas').where('categoria', '==', b.categoria).where('estado', '==', 'aprobada').get();
    if (banco.size < N) throw new Err(503, 'La evaluación de esta categoría aún no está disponible.');
    const token = crypto.randomBytes(24).toString('hex');
    const ref = await db().collection('aspirantes').add({
      nombre, telefono: tel, correo, categoria: b.categoria, estado: 'evaluando', tokenHash: sha(token),
      preguntas: mezclar(banco.docs.map(d => d.id)).slice(0, N), indice: 0, respuestas: [], correctas: 0, incidentes: 0,
      inicioPregunta: null, creadoEn: TS()
    });
    return { id: ref.id, token, total: N };
  },

  async siguiente(b) {
    const { ref, a } = await cargar(b);
    if (a.estado !== 'evaluando') return { fin: true, estado: a.estado, puntaje: a.puntaje };
    const q = (await db().collection('bancoPreguntas').doc(a.preguntas[a.indice]).get()).data();
    let ini = ms(a.inicioPregunta);
    if (!ini) { ini = Date.now(); await ref.update({ inicioPregunta: admin.firestore.Timestamp.fromMillis(ini) }); }  // recargar no reinicia el tiempo
    const resta = Math.max(0, SEG - Math.floor((Date.now() - ini) / 1000));
    return { n: a.indice + 1, total: N, pregunta: q.pregunta, opciones: q.opciones, segundos: resta };
  },

  async responder(b) {
    const { ref, a } = await cargar(b);
    if (a.estado !== 'evaluando') throw new Err(409, 'La evaluación ya terminó');
    const q = (await db().collection('bancoPreguntas').doc(a.preguntas[a.indice]).get()).data();
    const t = Date.now() - (ms(a.inicioPregunta) || 0);
    const opcion = Number.isInteger(b.opcion) ? b.opcion : null;
    const incidente = b.incidente === true;                     // salió de la pantalla, cambió de app, etc.
    const enTiempo = t <= (SEG + GRACIA) * 1000;
    const ok = !incidente && enTiempo && opcion === q.correcta;  // una pregunta anulada cuenta como incorrecta
    const incidentes = a.incidentes + (incidente ? 1 : 0);
    const correctas = a.correctas + (ok ? 1 : 0);
    const resp = [...a.respuestas, { q: a.preguntas[a.indice], o: opcion, ok, inc: incidente, ms: t }];
    await ref.update({ respuestas: resp, correctas, incidentes, indice: a.indice + 1, inicioPregunta: null });
    const fin = incidentes >= MAX_INCIDENTES ? 'incidentes' : null;
    if (fin || a.indice + 1 >= N) return finalizar(ref, a, correctas, fin);
    return { fin: false };
  },

  async enviar_admin(b) {
    const { ref, a } = await cargar(b);
    if (a.estado !== 'aprobado') throw new Err(409, 'Solo se envían evaluaciones aprobadas');
    await ref.update({ estado: 'enviado_admin', enviadoAdminEn: TS() });
    return { ok: true };
  },

  // ---------- administración ----------
  async admin_generar(b, req) {
    await esAdmin(req);
    if (!CATS[b.categoria]) throw new Err(400, 'Categoría inválida');
    if (!process.env.GEMINI_API_KEY) throw new Err(500, 'Falta GEMINI_API_KEY en Vercel');
    const n = Math.min(Math.max(parseInt(b.cantidad, 10) || 10, 1), 20);
    const prompt = `Genera ${n} preguntas de opción múltiple en español para evaluar a un aspirante a ${CATS[b.categoria]} en México (normas NOM-001-SEDE cuando aplique). ` +
      'Deben ser técnicamente correctas, con una sola respuesta correcta, 4 opciones y nivel práctico. Responde SOLO un arreglo JSON de objetos ' +
      '{"pregunta":string,"opciones":[4 strings],"correcta":número 0 a 3}.';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.7 } })
    });
    const j = await r.json();
    if (!r.ok) throw new Err(502, 'Gemini: ' + ((j.error && j.error.message) || r.status));
    let lista; try { lista = JSON.parse(j.candidates[0].content.parts[0].text); } catch (e) { throw new Err(502, 'La IA no devolvió un formato válido; intenta de nuevo'); }
    const buenas = (Array.isArray(lista) ? lista : []).filter(p => p && typeof p.pregunta === 'string' && Array.isArray(p.opciones) && p.opciones.length === 4 && Number.isInteger(p.correcta) && p.correcta >= 0 && p.correcta <= 3);
    const lote = db().batch();
    buenas.forEach(p => lote.set(db().collection('bancoPreguntas').doc(), { categoria: b.categoria, pregunta: p.pregunta.slice(0, 400), opciones: p.opciones.map(o => String(o).slice(0, 200)), correcta: p.correcta, estado: 'pendiente', creadoEn: TS() }));
    await lote.commit();
    return { creadas: buenas.length };
  },

  async admin_banco(b, req) {
    await esAdmin(req);
    let q = db().collection('bancoPreguntas');
    if (CATS[b.categoria]) q = q.where('categoria', '==', b.categoria);
    if (b.estado) q = q.where('estado', '==', b.estado);
    const s = await q.limit(200).get();
    return { preguntas: s.docs.map(d => { const x = d.data(); return { id: d.id, categoria: x.categoria, pregunta: x.pregunta, opciones: x.opciones, correcta: x.correcta, estado: x.estado }; }) };
  },

  async admin_revisar(b, req) {
    await esAdmin(req);
    if (!['aprobada', 'rechazada', 'pendiente'].includes(b.estado)) throw new Err(400, 'Estado inválido');
    await db().collection('bancoPreguntas').doc(String(b.id || '/')).update({ estado: b.estado, revisadoEn: TS() });
    return { ok: true };
  },

  async admin_aspirantes(b, req) {
    await esAdmin(req);
    let q = db().collection('aspirantes');
    if (b.estado) q = q.where('estado', '==', b.estado);
    const s = await q.limit(100).get();
    const lista = s.docs.map(d => { const x = d.data(); return { id: d.id, nombre: x.nombre, telefono: x.telefono, correo: x.correo, categoria: x.categoria, estado: x.estado, puntaje: x.puntaje ?? null, incidentes: x.incidentes, motivoRechazo: x.motivoRechazo || null, creado: ms(x.creadoEn) }; });
    return { aspirantes: lista.sort((a, c) => c.creado - a.creado) };
  },

  async admin_credenciales(b, req) {
    await esAdmin(req);
    const ref = db().collection('aspirantes').doc(String(b.id || '/'));
    const s = await ref.get();
    if (!s.exists || s.data().estado !== 'enviado_admin') throw new Err(409, 'El aspirante no está pendiente de credenciales');
    const a = s.data();
    const pass = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 12);
    let u; try { u = await admin.auth().createUser({ email: a.correo, password: pass, displayName: a.nombre }); }
    catch (e) { throw new Err(409, 'No se pudo crear la cuenta: ' + (e.code || e.message)); }
    await db().collection('tecnicos').doc(u.uid).set({ nombre: a.nombre, telefono: a.telefono, correo: a.correo, categoria: a.categoria, estado: 'pendiente_documentos', aspiranteId: ref.id, creadoEn: TS() }, { merge: true });
    await ref.update({ estado: 'credenciales', tecnicoUid: u.uid, credencialesEn: TS() });
    return { correo: a.correo, passwordTemporal: pass };   // se muestra una sola vez; no se guarda
  }
};

module.exports = async (req, res) => {
  const o = req.headers.origin;
  if (o && ORIGENES.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  const f = Object.prototype.hasOwnProperty.call(acciones, b.accion) ? acciones[b.accion] : null;
  if (!f) return res.status(400).json({ error: 'Acción no válida' });
  try { return res.status(200).json(await f(b, req)); }
  catch (e) {
    if (e instanceof Err) return res.status(e.code).json({ error: e.message });
    console.error('evaluacion error', e); return res.status(500).json({ error: 'Error interno' });
  }
};
