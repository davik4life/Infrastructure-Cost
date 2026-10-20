// Zyria infrastructure cost register: one Worker serving the page and its JSON API on
// costs.zyria.ng. Cloudflare Access signs people in at the edge; this Worker checks the
// Access token on every request as well, so the app stays closed even if Access were
// misconfigured or the Worker were reached some other way. With no Access settings it
// refuses everything (fails closed).

const CATEGORIES = ['Hosting', 'Database', 'Storage & media', 'Email', 'Monitoring', 'Cache & rate limits', 'Domain & DNS', 'AI', 'Payments', 'Logistics', 'Dev tools', 'Other'];
const BILLING = ['MONTHLY', 'YEARLY', 'USAGE', 'FREE'];
const CURRENCIES = ['USD', 'NGN'];

// Sent on every response: keep search engines, AI crawlers and link previewers out.
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
};

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt') return withHeaders(new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain' } }));

      const email = await signedInEmail(request, env, url);
      if (!email) return withHeaders(json({ error: 'Sign in through Cloudflare Access to use this app.' }, 403));

      if (url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && !sameOrigin(request, url)) return withHeaders(json({ error: 'Request blocked.' }, 403));
        return withHeaders(await api(request, env, url, email));
      }
      return withHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error('unhandled', err && err.stack || err);
      return withHeaders(json({ error: 'Something went wrong. Try again.' }, 500));
    }
  },
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE_HEADERS)) out.headers.set(k, v);
  return out;
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  const site = request.headers.get('Sec-Fetch-Site');
  return site === 'same-origin';
}

// ---------- Cloudflare Access token check ----------

let certCache = { at: 0, keys: null, team: '' };

async function signedInEmail(request, env, url) {
  const team = (env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.ACCESS_AUD || '').trim();
  const configured = team && aud && !team.startsWith('REPLACE') && !aud.startsWith('REPLACE');

  // Local development only: `wrangler dev` with LOCAL_DEV_EMAIL in .dev.vars (never deployed).
  // Ignored whenever Access is configured, and only for requests from this machine. Cloudflare
  // sets cf-connecting-ip itself at the edge, so a real visitor can never present 127.0.0.1.
  const ip = request.headers.get('cf-connecting-ip');
  if (env.LOCAL_DEV_EMAIL && !configured && (ip === '127.0.0.1' || ip === '::1')) return String(env.LOCAL_DEV_EMAIL).toLowerCase();

  if (!configured) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) return null;
  const payload = await verifyAccessJwt(token, team, aud);
  return payload && typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
}

function cookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function accessKeys(team) {
  if (certCache.keys && certCache.team === team && Date.now() - certCache.at < 10 * 60 * 1000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Could not load Access signing keys');
  const { keys } = await res.json();
  certCache = { at: Date.now(), keys, team };
  return keys;
}

async function verifyAccessJwt(token, team, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  return payload;
}

// ---------- API ----------

async function api(request, env, url, email) {
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  const seg = path.split('/').slice(2); // ['state'] | ['services', id] | ...

  if (m === 'GET' && path === '/api/state') return json(await loadState(env, email));
  if (m === 'GET' && path === '/api/audit') {
    const { results } = await env.DB.prepare('SELECT at, email, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 100').all();
    return json({ audit: results });
  }

  const body = m === 'GET' || m === 'DELETE' ? null : await request.json().catch(() => undefined);
  if (body === undefined) return json({ error: 'Send the details as JSON.' }, 400);

  if (seg[0] === 'settings' && m === 'PUT') {
    const fx = rate(body.fxRate);
    if (!fx) return json({ error: 'Enter an exchange rate above zero.' }, 400);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO settings (id, fx_x100) VALUES (\'default\', ?) ON CONFLICT(id) DO UPDATE SET fx_x100 = excluded.fx_x100').bind(fx),
      audit(env, email, 'SETTINGS_FX', 'default', String(fx / 100)),
    ]);
    return json({ ok: true });
  }

  if (seg[0] === 'services') {
    if (m === 'POST' && seg.length === 1) {
      const s = parseService(body);
      if (s.error) return json({ error: s.error }, 400);
      const id = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO services (id, name, category, used_for, plan, billing, price_minor, currency, renews_on, status, next_tier, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, s.name, s.category, s.usedFor, s.plan, s.billing, s.priceMinor, s.currency, s.renewsOn, s.status, s.nextTier, s.notes),
        audit(env, email, 'SERVICE_CREATED', id, s.name),
      ]);
      return json({ ok: true, id }, 201);
    }
    if (seg.length === 2 && (m === 'PUT' || m === 'DELETE')) {
      const id = seg[1];
      const existing = await env.DB.prepare('SELECT name FROM services WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'That service no longer exists.' }, 404);
      if (m === 'DELETE') {
        const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries WHERE service_id = ?').bind(id).first();
        if (used.n > 0) return json({ error: `This service has ${used.n} recorded bill${used.n === 1 ? '' : 's'}. Mark it as cancelled instead, so past totals stay correct.` }, 409);
        await env.DB.batch([env.DB.prepare('DELETE FROM services WHERE id = ?').bind(id), audit(env, email, 'SERVICE_DELETED', id, existing.name)]);
        return json({ ok: true });
      }
      const s = parseService(body);
      if (s.error) return json({ error: s.error }, 400);
      await env.DB.batch([
        env.DB.prepare("UPDATE services SET name=?, category=?, used_for=?, plan=?, billing=?, price_minor=?, currency=?, renews_on=?, status=?, next_tier=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
          .bind(s.name, s.category, s.usedFor, s.plan, s.billing, s.priceMinor, s.currency, s.renewsOn, s.status, s.nextTier, s.notes, id),
        audit(env, email, 'SERVICE_UPDATED', id, s.name),
      ]);
      return json({ ok: true });
    }
  }

  if (seg[0] === 'entries') {
    if (m === 'POST' && seg.length === 1) {
      // One bill, or { entries: [...] } from "Record a month".
      const list = Array.isArray(body.entries) ? body.entries : [body];
      if (list.length === 0 || list.length > 100) return json({ error: 'Send between 1 and 100 bills at a time.' }, 400);
      const parsed = [];
      for (const raw of list) {
        const e = parseEntry(raw);
        if (e.error) return json({ error: e.error }, 400);
        parsed.push(e);
      }
      const ids = [...new Set(parsed.map((e) => e.serviceId))];
      const { results } = await env.DB.prepare(`SELECT id FROM services WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
      if (results.length !== ids.length) return json({ error: 'One of those services no longer exists. Reload the page.' }, 400);
      const stmts = [];
      for (const e of parsed) {
        const id = crypto.randomUUID();
        stmts.push(env.DB.prepare('INSERT INTO entries (id, service_id, period, amount_minor, currency, fx_x100, ngn_kobo, paid_on, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .bind(id, e.serviceId, e.period, e.amountMinor, e.currency, e.fx, e.ngnKobo, e.paidOn, e.note, email));
      }
      stmts.push(audit(env, email, 'ENTRIES_CREATED', parsed[0].period, `${parsed.length} bill(s), ${parsed.reduce((a, e) => a + e.ngnKobo, 0) / 100} NGN`));
      await env.DB.batch(stmts);
      return json({ ok: true, count: parsed.length }, 201);
    }
    if (seg.length === 2 && (m === 'PUT' || m === 'DELETE')) {
      const id = seg[1];
      const existing = await env.DB.prepare('SELECT period, ngn_kobo FROM entries WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'That bill no longer exists.' }, 404);
      if (m === 'DELETE') {
        await env.DB.batch([env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id), audit(env, email, 'ENTRY_DELETED', id, `${existing.period}, ${existing.ngn_kobo / 100} NGN`)]);
        return json({ ok: true });
      }
      const e = parseEntry(body);
      if (e.error) return json({ error: e.error }, 400);
      const svc = await env.DB.prepare('SELECT id FROM services WHERE id = ?').bind(e.serviceId).first();
      if (!svc) return json({ error: 'That service no longer exists. Reload the page.' }, 400);
      await env.DB.batch([
        env.DB.prepare("UPDATE entries SET service_id=?, period=?, amount_minor=?, currency=?, fx_x100=?, ngn_kobo=?, paid_on=?, note=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
          .bind(e.serviceId, e.period, e.amountMinor, e.currency, e.fx, e.ngnKobo, e.paidOn, e.note, id),
        audit(env, email, 'ENTRY_UPDATED', id, `${e.period}, ${e.ngnKobo / 100} NGN`),
      ]);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found.' }, 404);
}

async function loadState(env, email) {
  const [services, entries, settings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM services ORDER BY name'),
    env.DB.prepare('SELECT * FROM entries ORDER BY period DESC, created_at DESC'),
    env.DB.prepare("SELECT fx_x100 FROM settings WHERE id = 'default'"),
  ]);
  return {
    me: email,
    fxRate: (settings.results[0]?.fx_x100 ?? 133500) / 100,
    services: services.results.map((s) => ({
      id: s.id, name: s.name, category: s.category, usedFor: s.used_for, plan: s.plan, billing: s.billing,
      price: s.price_minor / 100, currency: s.currency, renewsOn: s.renews_on || '', status: s.status, nextTier: s.next_tier, notes: s.notes,
    })),
    entries: entries.results.map((e) => ({
      id: e.id, serviceId: e.service_id, period: e.period, amount: e.amount_minor / 100, currency: e.currency,
      fxRate: e.fx_x100 / 100, ngn: e.ngn_kobo / 100, paidOn: e.paid_on || '', note: e.note, createdBy: e.created_by,
    })),
  };
}

function audit(env, email, action, target, detail) {
  return env.DB.prepare('INSERT INTO audit_log (email, action, target, detail) VALUES (?,?,?,?)').bind(email, action, target, String(detail).slice(0, 500));
}

// ---------- validation ----------

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null);
function minor(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e11) return null;
  return Math.round(n * 100);
}
function rate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e6) return null;
  return Math.round(n * 100);
}

export function parseService(b) {
  if (!b || typeof b !== 'object') return { error: 'Send the service details.' };
  const name = text(b.name, 120);
  if (!name) return { error: 'Give the service a name.' };
  const billing = String(b.billing || '').toUpperCase();
  if (!BILLING.includes(billing)) return { error: 'Choose how the service bills.' };
  const currency = String(b.currency || 'USD').toUpperCase();
  if (!CURRENCIES.includes(currency)) return { error: 'Choose USD or NGN.' };
  const priceMinor = billing === 'FREE' ? 0 : minor(b.price ?? 0);
  if (priceMinor === null) return { error: 'Enter the planned cost as a number of zero or more.' };
  const status = String(b.status || 'ACTIVE').toUpperCase();
  if (!['ACTIVE', 'CANCELLED'].includes(status)) return { error: 'Choose active or cancelled.' };
  return {
    name, billing, currency, priceMinor, status,
    category: CATEGORIES.includes(b.category) ? b.category : 'Other',
    usedFor: text(b.usedFor, 300), plan: text(b.plan, 120), nextTier: text(b.nextTier, 300), notes: text(b.notes, 500),
    renewsOn: date(b.renewsOn),
  };
}

export function parseEntry(b) {
  if (!b || typeof b !== 'object') return { error: 'Send the bill details.' };
  const serviceId = text(b.serviceId, 64);
  if (!serviceId) return { error: 'Choose a service.' };
  const period = typeof b.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(b.period) ? b.period : null;
  if (!period) return { error: 'Choose the month the bill covers.' };
  const amountMinor = minor(b.amount);
  if (amountMinor === null) return { error: 'Enter the amount as a number of zero or more.' };
  const currency = String(b.currency || '').toUpperCase();
  if (!CURRENCIES.includes(currency)) return { error: 'Choose USD or NGN.' };
  let fx = 100;
  if (currency === 'USD') {
    fx = rate(b.fxRate);
    if (!fx) return { error: 'Enter the naira rate used on the bill.' };
  }
  // amount (cents) x rate (NGN x100) / 100 = kobo
  const ngnKobo = currency === 'USD' ? Math.round((amountMinor * fx) / 100) : amountMinor;
  return { serviceId, period, amountMinor, currency, fx, ngnKobo, paidOn: date(b.paidOn), note: text(b.note, 300) };
}
