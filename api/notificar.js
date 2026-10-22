// Vercel Serverless Function: envía una notificación push al cliente
// cuando cambia el estatus de su folio.
// Variables de entorno:
//   FIREBASE_SERVICE_ACCOUNT (obligatoria): JSON de la cuenta de servicio.
//   ADMIN_UIDS (opcional): uids de administración/logística separados por comas.
//   ORIGENES_EXTRA (opcional): dominios extra permitidos, separados por comas.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // Vercel a veces guarda los saltos de línea de la llave como "\n" literal.
  if (cuenta.private_key) cuenta.private_key = cuenta.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
}

const SITIO = 'https://isep-s-a.vercel.app/';

// Páginas autorizadas para llamar a esta función (sin "/" al final).
const ORIGENES_PERMITIDOS = [
  'https://isep-s-a.vercel.app',
  'https://tecnicoadm.netlify.app',
  ...(process.env.ORIGENES_EXTRA || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
];

const ADMIN_UIDS = (process.env.ADMIN_UIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Errores de FCM que significan que el token del cliente ya no sirve.
const TOKEN_INVALIDO = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token'
];

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
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!idToken) return res.status(401).json({ error: 'No autorizado' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // El body puede llegar como string si el Content-Type no es JSON.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }

    const folio = String((body && body.folio) || '').trim();
    if (!folio || folio.length > 100 || folio.includes('/')) {
      return res.status(400).json({ error: 'Falta el folio' });
    }

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

    if (!d.fcmToken) {
      return res.status(200).json({ enviado: false, motivo: 'El cliente no activó notificaciones' });
    }

    // El texto sale del estatus guardado en Firestore, no de lo que mande el panel.
    const estatus = String(d.estatus || 'Tu solicitud se actualizó');
    const cuerpo = d.tecnicoNombre ? `${estatus} · Técnico: ${d.tecnicoNombre}` : estatus;

    try {
      await admin.messaging().send({
        token: d.fcmToken,
        notification: { title: `ISEP · Folio ${folio}`, body: cuerpo },
        webpush: {
          notification: {
            icon: `${SITIO}icon-192.png`,
            badge: `${SITIO}badge-72.png`,
            tag: folio,
            renotify: true,
            vibrate: [200, 100, 200]
          },
          fcmOptions: { link: `${SITIO}?folio=${encodeURIComponent(folio)}` }
        }
      });
    } catch (e) {
      if (TOKEN_INVALIDO.includes(e.code)) {
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
