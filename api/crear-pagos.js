// POST /api/crear-pago  { folio }  ->  { url }  (página de pago de Stripe Checkout)
const Stripe = require('stripe');
const admin = require('firebase-admin');

function db() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://isep-s-a.vercel.app/').replace(/\/?$/, '/');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const folio = String((req.body || {}).folio || '').toUpperCase().trim();
    if (!/^[A-Z0-9-]{6,40}$/.test(folio)) return res.status(400).json({ error: 'Folio inválido' });

    const snap = await db().collection('solicitudes').doc(folio).get();
    if (!snap.exists) return res.status(404).json({ error: 'Folio no encontrado' });
    const d = snap.data();
    if (d.cancelada) return res.status(409).json({ error: 'La solicitud está cancelada' });
    if (d.pagado) return res.status(409).json({ error: 'Este servicio ya está pagado' });

    // El monto SIEMPRE se lee de Firestore (nunca del navegador).
    const monto = Number(d.montoCobrado);
    if (!(monto > 0)) return res.status(400).json({ error: 'Aún no hay un monto por pagar' });

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: folio,
      metadata: { folio },
      payment_intent_data: { metadata: { folio }, description: `Servicio ISEP · ${folio}` },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: Math.round(monto * 100),
          product_data: { name: 'Servicio eléctrico ISEP', description: `Folio ${folio}` }
        }
      }],
      success_url: `${PUBLIC_URL}?folio=${encodeURIComponent(folio)}&pago=ok`,
      cancel_url: `${PUBLIC_URL}?folio=${encodeURIComponent(folio)}&pago=cancelado`
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('crear-pago', e);
    return res.status(500).json({ error: 'No se pudo iniciar el pago' });
  }
};
