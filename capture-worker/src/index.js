/**
 * Snapshot capture Worker.
 *
 *   POST /submit          — from the site forms (CORS-restricted to the site origins)
 *   GET  /leads?since=ID  — GRIPP OS pulls new leads (Bearer PULL_TOKEN)
 *   POST /ack             — GRIPP OS marks ids as imported (Bearer PULL_TOKEN)
 *   GET  /health
 *
 * Storage: KV. Key `lead:<id>` holds the lead; `pending` holds the id list
 * still waiting for GRIPP OS. Ids are time-ordered so `since` works.
 */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] || '',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'origin',
    '__originOk': ok ? '1' : '0',
  };
}

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const newId = () => `${Date.now().toString(36).padStart(9, '0')}-${crypto.randomUUID().slice(0, 8)}`;

async function notify(env, lead) {
  if (!env.RESEND_API_KEY) return;
  const text = [
    `New Snapshot lead (${lead.source})`,
    '',
    `Name:     ${lead.name}`,
    `Email:    ${lead.email}`,
    `Business: ${lead.company || '—'}`,
    '',
    'The one workflow eating their week:',
    lead.workflow,
    '',
    `Page: ${lead.page}   UTM: ${JSON.stringify(lead.utm || {})}`,
    `Received: ${lead.receivedAt}`,
  ].join('\n');
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.NOTIFY_FROM, to: [env.NOTIFY_TO], reply_to: lead.email, subject: `Snapshot lead — ${lead.name}${lead.company ? ' (' + lead.company + ')' : ''}`, text }),
  }).catch(() => {});
}

async function handleSubmit(req, env) {
  const cors = corsHeaders(req, env);
  const originOk = cors.__originOk === '1';
  delete cors.__originOk;
  if (!originOk) return json({ error: 'origin not allowed' }, 403, cors);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'expected json' }, 400, cors); }

  // Honeypot: real people never fill the hidden "website" field.
  if (clean(body.website, 200)) return json({ ok: true }, 200, cors);

  const lead = {
    id: newId(),
    name: clean(body.name, 120),
    email: clean(body.email, 200).toLowerCase(),
    company: clean(body.company, 120),
    workflow: clean(body.workflow, 1500),
    source: clean(body.source, 40) || 'unknown',
    page: clean(body.page, 200),
    utm: typeof body.utm === 'object' && body.utm ? Object.fromEntries(Object.entries(body.utm).slice(0, 8).map(([k, v]) => [clean(k, 40), clean(String(v), 200)])) : {},
    receivedAt: new Date().toISOString(),
    ip: req.headers.get('cf-connecting-ip') || null,
    country: req.cf?.country || null,
  };
  if (!lead.name || !isEmail(lead.email) || !lead.workflow) return json({ error: 'name, valid email, and workflow are required' }, 400, cors);

  // Cheap rate limit: 5 submissions per IP per hour.
  if (lead.ip) {
    const rlKey = `rl:${lead.ip}:${new Date().toISOString().slice(0, 13)}`;
    const n = Number((await env.LEADS.get(rlKey)) || 0);
    if (n >= 5) return json({ error: 'too many submissions' }, 429, cors);
    await env.LEADS.put(rlKey, String(n + 1), { expirationTtl: 3600 });
  }

  await env.LEADS.put(`lead:${lead.id}`, JSON.stringify(lead));
  const pending = JSON.parse((await env.LEADS.get('pending')) || '[]');
  pending.push(lead.id);
  await env.LEADS.put('pending', JSON.stringify(pending));
  await notify(env, lead);
  return json({ ok: true, id: lead.id }, 200, cors);
}

function authed(req, env) {
  const h = req.headers.get('authorization') || '';
  return env.PULL_TOKEN && h === `Bearer ${env.PULL_TOKEN}`;
}

async function handleLeads(req, env) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  const pending = JSON.parse((await env.LEADS.get('pending')) || '[]');
  const leads = [];
  for (const id of pending.slice(0, 100)) {
    const raw = await env.LEADS.get(`lead:${id}`);
    if (raw) leads.push(JSON.parse(raw));
  }
  return json({ leads, pending: pending.length });
}

async function handleAck(req, env) {
  if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'expected json' }, 400); }
  const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
  const pending = JSON.parse((await env.LEADS.get('pending')) || '[]');
  const left = pending.filter((id) => !ids.has(id));
  await env.LEADS.put('pending', JSON.stringify(left));
  return json({ ok: true, acked: pending.length - left.length, pending: left.length });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(req, env); delete cors.__originOk;
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === '/health') return json({ ok: true, service: 'snapshot-capture' });
    if (url.pathname === '/submit' && req.method === 'POST') return handleSubmit(req, env);
    if (url.pathname === '/leads' && req.method === 'GET') return handleLeads(req, env);
    if (url.pathname === '/ack' && req.method === 'POST') return handleAck(req, env);
    return json({ error: 'not found' }, 404);
  },
};
