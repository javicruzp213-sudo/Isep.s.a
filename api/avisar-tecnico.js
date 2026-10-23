// Vercel Serverless Function: envía una notificación push al TÉCNICO asignado a un folio
// cuando administración marca un pago como no recibido o le manda un recordatorio.
// Variables de entorno (las mismas que api/notificar.js):
//   FIREBASE_SERVICE_ACCOUNT (obligatoria)
//   ADMIN_UIDS (obligatoria aquí): uids de administración separados por comas
//   ORIGENES_EXTRA (opcional): dominios extra permitidos; agrega aquí el del panel de administración
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (cuenta.private_key) cuenta.private_key = cuenta.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
}

const SITIO_TECNICO = 'https://tecnicosisep.netlify.app/';

const ORIGENES_PERMITIDOS = [
  'https://isep-s-a.vercel.app',
  'https://tecnicosisep.netlify.app',
  ...(process.env.ORIGENES_EXTRA || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
];

const ADMIN_UIDS = (process.env.ADMIN_UIDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

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
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!idToken) return res.status(401).json({ error: 'No autorizado' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Solo administración puede avisar al técnico.
    if (!ADMIN_UIDS.includes(decoded.uid)) {
      return res.status(403).json({ error: 'Solo administración puede enviar este aviso' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    const folio = String((body && body.folio) || '').trim();
    const TIPOS = ['pago', 'asignacion', 'pago_recibido', 'garantia'];
    const tipo = TIPOS.includes(body && body.tipo) ? body.tipo : 'pago';
    if (!folio || folio.length > 100 || folio.includes('/')) {
      return res.status(400).json({ error: 'Falta el folio' });
    }

    const snap = await admin.firestore().collection('solicitudes').doc(folio).get();
    if (!snap.exists) return res.status(404).json({ error: 'Folio no encontrado' });
    const d = snap.data();

    if (!d.tecnicoUid) {
      return res.status(200).json({ enviado: false, motivo: 'El folio no tiene técnico asignado' });
    }

    const refTec = admin.firestore().collection('tecnicos').doc(d.tecnicoUid);
    const tec = await refTec.get();
    const token = tec.exists ? tec.data().fcmToken : null;
    if (!token) {
      return res.status(200).json({ enviado: false, motivo: 'El técnico no activó notificaciones en su celular' });
    }

    // El texto sale de lo que hay guardado en la solicitud, no de lo que mande el navegador.
    let titulo, texto;
    if (tipo === 'asignacion') {
      const lugar = typeof d.direccion === 'string' ? d.direccion : '';
      titulo = `ISEP · Nueva solicitud asignada · Folio ${folio}`;
      texto = (lugar ? `Dirección: ${lugar}. ` : '') + 'Ábrela en tu panel.';
    } else if (tipo === 'pago_recibido') {
      titulo = `ISEP · Pago recibido · Folio ${folio}`;
      texto = String(d.pagoRecibidoAvisoTecnicoTexto ||
        'Administración registró el pago de este servicio como recibido.');
    } else if (tipo === 'garantia') {
      titulo = `ISEP · Garantía lista para enviar · Folio ${folio}`;
      texto = String(d.garantiaAvisoTecnicoTexto ||
        'Administración registró la garantía. Envíala al cliente desde tu panel.');
    } else {
      titulo = `ISEP · Pago pendiente · Folio ${folio}`;
      texto = String(d.recordatorioPagoTecnicoTexto ||
        'Administración marcó este pago en línea como no recibido. Revisa tu panel.');
    }
    texto = texto.slice(0, 180);

    try {
      await admin.messaging().send({
        token,
        notification: { title: titulo, body: texto },
        webpush: {
          notification: {
            icon: `${SITIO_TECNICO}icon-192.png`,
            tag: `${tipo}-${folio}`,
            renotify: true,
            requireInteraction: tipo === 'asignacion',
            vibrate: [200, 100, 200]
          },
          fcmOptions: { link: SITIO_TECNICO }
        }
      });
    } catch (e) {
      if (TOKEN_INVALIDO.includes(e.code)) {
        await refTec.update({ fcmToken: admin.firestore.FieldValue.delete() });
        return res.status(200).json({ enviado: false, motivo: 'El token del técnico ya no es válido; debe activar notificaciones otra vez' });
      }
      throw e;
    }

    return res.status(200).json({ enviado: true });
  } catch (e) {
    console.error('avisar-tecnico error', e);
    return res.status(500).json({ error: e.code || e.message });
  }
};
