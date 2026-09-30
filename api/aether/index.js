// Vercel function: POST /api/aether -> one chat turn for AETHER's agents (same logic as the local server).
import { chat, guard, HttpError, BODY_LIMIT } from '../../lib/brain.mjs';

export async function POST(request) {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const denied = guard(request.headers, { host });
  if (denied) return Response.json({ error: denied.message }, { status: denied.status });
  try {
    const text = await request.text();
    if (text.length > BODY_LIMIT) throw new HttpError(413, 'request too large');
    let body;
    try { body = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'bad JSON'); }
    return Response.json(await chat(body, { referer: `https://${host}` }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: e.status || 502 });
  }
}
