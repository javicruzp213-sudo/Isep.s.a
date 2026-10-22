// Vercel Serverless Function: envía una notificación push al cliente
// cuando cambia el estatus de su folio.
// Requiere la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).
// Opcional: ADMIN_UIDS = uids de administración/logística separados por comas
// (también pueden disparar avisos de cualquier folio).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const SITIO = 'https://isep-s-a.vercel.app/';
const ORIGENES_PERMITIDOS = ['https://isep-s-a.vercel.app'];
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGENES_PERMITIDOS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    // 1) Debe venir con una sesión válida de Firebase.
    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const folio = String((req.body && req.body.folio) || '').trim();
    if (!folio || folio.includes('/')) return res.status(400).json({ error: 'Falta el folio' });

    const ref = admin.firestore().collection('solicitudes').doc(folio);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Folio no encontrado' });

    const d = snap.data();

    // 2) Solo el técnico asignado a ese folio (o administración) puede disparar el aviso.
    const esTecnicoDelFolio = !!d.tecnicoUid && d.tecnicoUid === decoded.uid;
    const esAdmin = ADMIN_UIDS.includes(decoded.uid);
    if (!esTecnicoDelFolio && !esAdmin) {
      return res.status(403).json({ error: 'Sin permiso para este folio' });
    }

    if (!d.fcmToken) return res.status(200).json({ enviado: false, motivo: 'El cliente no activó notificaciones' });

    // El texto sale del estatus guardado en Firestore, no de lo que mande el panel.
    const cuerpo = d.tecnicoNombre
      ? `${d.estatus} · Técnico: ${d.tecnicoNombre}`
      : String(d.estatus || 'Tu solicitud se actualizó');

    try {
      await admin.messaging().send({
        token: d.fcmToken,
        notification: { title: `ISEP · Folio ${folio}`, body: cuerpo },
        webpush: { fcmOptions: { link: `${SITIO}?folio=${encodeURIComponent(folio)}` } }
      });
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered') {
        await ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
        return res.status(200).json({ enviado: false, motivo: 'El token ya no es válido' });
      }
      throw e;
    }
    return res.status(200).json({ enviado: true });
  } catch (e) {
    console.error('notificar error', e);
    return res.status(500).json({ error: e.code || e.message });
  }
};
