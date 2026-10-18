// Vercel Serverless Function: envía una notificación push al cliente
// cuando cambia el estatus de su folio.
// Requiere la variable de entorno FIREBASE_SERVICE_ACCOUNT (JSON de la cuenta de servicio).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const SITIO = 'https://isep-s-a.vercel.app/';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    // Solo personal con sesión de Firebase puede disparar avisos.
    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    await admin.auth().verifyIdToken(idToken);

    const folio = String((req.body && req.body.folio) || '');
    if (!folio) return res.status(400).json({ error: 'Falta el folio' });

    const ref = admin.firestore().collection('solicitudes').doc(folio);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Folio no encontrado' });

    const d = snap.data();
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
