// POST /api/webhook-pago  <- Stripe avisa aquí cuando un pago se confirma.
const Stripe = require('stripe');
const admin = require('firebase-admin');

function db() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}
const leerRaw = req => new Promise((ok, err) => {
  const c = []; req.on('data', x => c.push(x)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', err);
});
const FORMA = { card: 'Tarjeta', oxxo: 'Efectivo', customer_balance: 'Transferencia', spei: 'Transferencia' };

async function marcarPagado(stripe, s) {
  const folio = s.client_reference_id || (s.metadata && s.metadata.folio);
  if (!folio || s.currency !== 'mxn') return;
  const ref = db().collection('solicitudes').doc(folio);
  const snap = await ref.get();
  if (!snap.exists || snap.data().pagado) return; // idempotente: Stripe puede reenviar el aviso

  let forma = 'Otro';
  try {
    const pi = await stripe.paymentIntents.retrieve(s.payment_intent, { expand: ['payment_method'] });
    forma = FORMA[pi.payment_method && pi.payment_method.type] || 'Otro';
  } catch (_) {}

  const now = admin.firestore.FieldValue.serverTimestamp();
  await ref.update({
    pagado: true,
    montoCobrado: s.amount_total / 100,
    formaPago: forma,
    pagadoEn: now,
    pagadoPor: 'Stripe',
    stripeSessionId: s.id,
    stripePaymentIntent: s.payment_intent || null,
    actualizadoEn: now
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const raw = await leerRaw(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send('Firma inválida');
  }
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data.object;
      if (s.payment_status === 'paid') await marcarPagado(stripe, s);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook-pago', e);
    return res.status(500).end(); // Stripe reintentará
  }
};
module.exports.config = { api: { bodyParser: false } }; // Stripe necesita el cuerpo sin procesar
