// Vercel Serverless Function: avisa por push al TÉCNICO cuando el CLIENTE cambia la fecha de su visita desde la página.
// Variables de entorno: FIREBASE_SERVICE_ACCOUNT (la misma de las demás funciones). ORIGENES_EXTRA (opcional).
// Seguridad: no se confía en lo que manda el navegador; se revisa en Firestore que el cambio sea reciente y reciente-no-avisado,
// se avisa una sola vez por cambio y como máximo una vez cada 2 minutos por folio.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (cuenta.private_key) cuenta.private_key = cuenta.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
}

const SITIO_TECNICO = 'https://tecnicosisep.netlify.app/';
const ORIGENES_PERMITIDOS = [
  'https://isep-s-a.vercel.app',
  ...(process.env.ORIGENES_EXTRA || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
];
const TOKEN_INVALIDO = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_PERMITIDOS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const folio = String((body && body.folio) || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,40}$/.test(folio)) return res.status(400).json({ error: 'Folio no válido' });
    if ((body && body.tipo) !== 'reprogramada') return res.status(400).json({ error: 'Tipo no válido' });

    const db = admin.firestore(), ref = db.collection('solicitudes').doc(folio);
    // Transacción: decide si se debe avisar y deja la marca para no repetir
    const decision = await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists) return { motivo: 'Folio no encontrado' };
      const d = s.data(), en = Number(d.reprogramadaEn) || 0, ahora = Date.now();
      if (!en || d.reprogramadaPor !== 'cliente') return { motivo: 'No hay un cambio del cliente' };
      if (Math.abs(ahora - en) > 30 * 60 * 1000) return { motivo: 'El cambio ya no es reciente' };
      if (d.cancelada === true) return { motivo: 'La solicitud está cancelada' };
      if (Number(d.avisoReprogramadaEn) === en) return { motivo: 'Ese cambio ya se avisó' };
      if (ahora - (Number(d.avisoReprogramadaAt) || 0) < 2 * 60 * 1000) return { motivo: 'Se avisó hace menos de 2 minutos' };
      if (!d.tecnicoUid) return { motivo: 'El folio no tiene técnico asignado' };
      t.update(ref, { avisoReprogramadaEn: en, avisoReprogramadaAt: ahora });
      return { d };
    });
    if (!decision.d) return res.status(200).json({ enviado: false, motivo: decision.motivo });

    const d = decision.d;
    const refTec = db.collection('tecnicos').doc(d.tecnicoUid), tec = await refTec.get();
    const token = tec.exists ? tec.data().fcmToken : null;
    if (!token) return res.status(200).json({ enviado: false, motivo: 'El técnico no activó notificaciones' });

    const visita = [d.fechaLegible || d.fecha, d.horaLegible || d.hora].filter(Boolean).join(' · ');
    try {
      await admin.messaging().send({
        token,
        notification: { title: `ISEP · El cliente cambió la fecha · Folio ${folio}`, body: `Nueva visita: ${visita}`.slice(0, 180) },
        webpush: {
          notification: { icon: `${SITIO_TECNICO}icon-192.png`, tag: `reprogramada-${folio}`, renotify: true, vibrate: [200, 100, 200] },
          fcmOptions: { link: SITIO_TECNICO }
        }
      });
    } catch (e) {
      if (TOKEN_INVALIDO.includes(e.code)) {
        await refTec.update({ fcmToken: admin.firestore.FieldValue.delete() });
        return res.status(200).json({ enviado: false, motivo: 'El token del técnico ya no es válido' });
      }
      throw e;
    }
    return res.status(200).json({ enviado: true });
  } catch (e) {
    console.error('avisar-cambio error', e);
    return res.status(500).json({ error: e.code || e.message });
  }
};
