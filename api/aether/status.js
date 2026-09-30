// Vercel function: GET /api/aether/status -> { online, models, locked }. Never exposes the key.
import { status, guard } from '../../lib/brain.mjs';

export async function GET(request) {
  const denied = guard(request.headers, { host: request.headers.get('x-forwarded-host') || request.headers.get('host') });
  if (denied && denied.status !== 401) return Response.json({ error: denied.message }, { status: denied.status });
  return Response.json(await status(), { headers: { 'Cache-Control': 'no-store' } });   // "locked" tells the app to ask for the code
}
