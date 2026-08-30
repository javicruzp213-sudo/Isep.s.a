// Vercel la detecta automáticamente como endpoint: POST /api/gemini
// La clave NUNCA viaja al navegador: vive solo aquí, como variable de entorno.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ texto: 'Método no permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

  if (!apiKey) {
    return res.status(200).json({
      texto: 'El asistente aún no está activado: falta configurar GEMINI_API_KEY en Vercel (Project Settings → Environment Variables). Mientras tanto, escríbenos por WhatsApp.'
    });
  }

  const { mensaje } = req.body || {};
  if (!mensaje) return res.status(400).json({ texto: 'Falta el mensaje.' });

  const instrucciones = `Eres el asistente de ISEP, S.A., una empresa de electricistas que da servicio a domicilio en toda la República Mexicana, con mayor cobertura en Tabasco. Responde breve y claro en español, en tono profesional y amable. Escribe en texto plano: no uses Markdown, no uses asteriscos, guiones bajos, numerales ni tablas. Mensaje del cliente: ${mensaje}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: instrucciones }] }] })
    });
    const data = await r.json();
    let texto = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No obtuve respuesta, intenta de nuevo.';
    texto = limpiarMarkdown(texto);
    return res.status(200).json({ texto });
  } catch (e) {
    return res.status(500).json({ texto: 'No pude conectar con el asistente en este momento. Intenta más tarde o escríbenos por WhatsApp.' });
  }
}

// Quita formato Markdown por si el modelo lo agrega de todas formas
// (negritas, cursivas, encabezados, código, viñetas).
function limpiarMarkdown(texto){
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
