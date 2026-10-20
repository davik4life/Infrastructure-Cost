// Zyria infrastructure cost register: one Worker serving the page and its JSON API on
// costs.zyria.ng. Cloudflare Access signs people in at the edge; this Worker checks the
// Access token on every request as well, so the app stays closed even if Access were
// misconfigured or the Worker were reached some other way. With no Access settings it
// refuses everything (fails closed).

const CATEGORIES = ['Hosting', 'Database', 'Storage & media', 'Email', 'Monitoring', 'Cache & rate limits', 'Domain & DNS', 'AI', 'Payments', 'Logistics', 'Dev tools', 'Other'];
const BILLING = ['MONTHLY', 'YEARLY', 'USAGE', 'FREE'];
const CURRENCIES = ['USD', 'NGN'];
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOADS_PER_ITEM = 10;

// Sent on every response: keep search engines, AI crawlers and link previewers out.
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
};

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/robots.txt') return withHeaders(new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain' } }));

      const problem = configProblem(env);
      if (problem) {
        console.error('Access settings problem:', problem);
        return withHeaders(json({ error: `This app's Cloudflare Access settings are wrong: ${problem}` }, 503));
      }
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
  // Uploaded files carry a locked-down policy of their own (see serveAttachment).
  const own = res.headers.get('X-Own-CSP');
  if (own) { out.headers.set('Content-Security-Policy', own); out.headers.delete('X-Own-CSP'); }
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

// Catches the usual setup mistakes so they show up as a clear message, not a silent 403.
// Returns null when the settings look right, or when they're blank (local development).
export function configProblem(env) {
  const team = (env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.ACCESS_AUD || '').trim();
  if (!team && !aud) return null;
  if (team.startsWith('REPLACE') || aud.startsWith('REPLACE')) return 'ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc still hold placeholders.';
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team)) return 'ACCESS_TEAM_DOMAIN must be your Zero Trust team domain, like yourteam.cloudflareaccess.com (no https://).';
  if (!/^[a-f0-9]{64}$/i.test(aud)) return 'ACCESS_AUD must be the application\'s "Application Audience (AUD) Tag", a 64-character code (not the application ID).';
  return null;
}

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
  if (!token) { console.warn('No Access sign-in token on the request. Is the Access application set up for this hostname?'); return null; }
  const payload = await verifyAccessJwt(token, team, aud);
  if (!payload) console.warn('Access sign-in token was refused (wrong AUD tag, team domain, or expired).');
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

  if (seg[0] === 'attachments') return attachmentsApi(request, env, url, email, seg);

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
        env.DB.prepare('INSERT INTO services (id, name, category, used_for, plan, billing, price_minor, currency, renews_on, status, next_tier, notes, priority, payment_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, s.name, s.category, s.usedFor, s.plan, s.billing, s.priceMinor, s.currency, s.renewsOn, s.status, s.nextTier, s.notes, s.priority, s.paymentUrl),
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
        await deleteAttachmentsOf(env, 'service', id);
        await env.DB.batch([env.DB.prepare('DELETE FROM services WHERE id = ?').bind(id), audit(env, email, 'SERVICE_DELETED', id, existing.name)]);
        return json({ ok: true });
      }
      const s = parseService(body);
      if (s.error) return json({ error: s.error }, 400);
      await env.DB.batch([
        env.DB.prepare("UPDATE services SET name=?, category=?, used_for=?, plan=?, billing=?, price_minor=?, currency=?, renews_on=?, status=?, next_tier=?, notes=?, priority=?, payment_url=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
          .bind(s.name, s.category, s.usedFor, s.plan, s.billing, s.priceMinor, s.currency, s.renewsOn, s.status, s.nextTier, s.notes, s.priority, s.paymentUrl, id),
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
      const newIds = [];
      for (const e of parsed) {
        const id = crypto.randomUUID();
        newIds.push(id);
        stmts.push(env.DB.prepare('INSERT INTO entries (id, service_id, period, amount_minor, currency, fx_x100, ngn_kobo, paid_on, note, created_by, priority, payment_url, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, e.serviceId, e.period, e.amountMinor, e.currency, e.fx, e.ngnKobo, e.paidOn, e.note, email, e.priority, e.paymentUrl, e.status));
      }
      stmts.push(audit(env, email, 'ENTRIES_CREATED', parsed[0].period, `${parsed.length} bill(s), ${parsed.reduce((a, e) => a + e.ngnKobo, 0) / 100} NGN`));
      await env.DB.batch(stmts);
      return json({ ok: true, count: parsed.length, ids: newIds }, 201);
    }
    if (seg.length === 2 && (m === 'PUT' || m === 'DELETE')) {
      const id = seg[1];
      const existing = await env.DB.prepare('SELECT period, ngn_kobo FROM entries WHERE id = ?').bind(id).first();
      if (!existing) return json({ error: 'That bill no longer exists.' }, 404);
      if (m === 'DELETE') {
        await deleteAttachmentsOf(env, 'entry', id);
        await env.DB.batch([env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id), audit(env, email, 'ENTRY_DELETED', id, `${existing.period}, ${existing.ngn_kobo / 100} NGN`)]);
        return json({ ok: true });
      }
      const e = parseEntry(body);
      if (e.error) return json({ error: e.error }, 400);
      const svc = await env.DB.prepare('SELECT id FROM services WHERE id = ?').bind(e.serviceId).first();
      if (!svc) return json({ error: 'That service no longer exists. Reload the page.' }, 400);
      await env.DB.batch([
        env.DB.prepare("UPDATE entries SET service_id=?, period=?, amount_minor=?, currency=?, fx_x100=?, ngn_kobo=?, paid_on=?, note=?, priority=?, payment_url=?, status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
          .bind(e.serviceId, e.period, e.amountMinor, e.currency, e.fx, e.ngnKobo, e.paidOn, e.note, e.priority, e.paymentUrl, e.status, id),
        audit(env, email, 'ENTRY_UPDATED', id, `${e.period}, ${e.ngnKobo / 100} NGN`),
      ]);
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found.' }, 404);
}

async function loadState(env, email) {
  const [services, entries, settings, files] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM services ORDER BY name'),
    env.DB.prepare('SELECT * FROM entries ORDER BY period DESC, created_at DESC'),
    env.DB.prepare("SELECT fx_x100 FROM settings WHERE id = 'default'"),
    env.DB.prepare('SELECT id, owner_type, owner_id, filename, content_type, size, created_by, created_at FROM attachments ORDER BY created_at'),
  ]);
  return {
    me: email,
    uploadsEnabled: Boolean(env.UPLOADS),
    attachments: files.results.map((a) => ({ id: a.id, ownerType: a.owner_type, ownerId: a.owner_id, filename: a.filename, contentType: a.content_type, size: a.size, createdBy: a.created_by, createdAt: a.created_at })),
    fxRate: (settings.results[0]?.fx_x100 ?? 133500) / 100,
    services: services.results.map((s) => ({
      id: s.id, name: s.name, category: s.category, usedFor: s.used_for, plan: s.plan, billing: s.billing,
      price: s.price_minor / 100, currency: s.currency, renewsOn: s.renews_on || '', status: s.status, nextTier: s.next_tier, notes: s.notes,
      priority: s.priority, paymentUrl: s.payment_url,
    })),
    entries: entries.results.map((e) => ({
      id: e.id, serviceId: e.service_id, period: e.period, amount: e.amount_minor / 100, currency: e.currency,
      fxRate: e.fx_x100 / 100, ngn: e.ngn_kobo / 100, paidOn: e.paid_on || '', note: e.note, createdBy: e.created_by,
      priority: e.priority, paymentUrl: e.payment_url, status: e.status,
    })),
  };
}

// ---------- screenshots ----------

// Only these image types are accepted, recognised from the file's first bytes rather than
// trusting the name or the browser's label. SVG is refused because it can carry scripts.
export function sniffImage(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...b.slice(0, 6)))) return 'image/gif';
  return null;
}

async function attachmentsApi(request, env, url, email, seg) {
  if (!env.UPLOADS) return json({ error: 'Screenshot storage isn\'t set up yet. See "Screenshots" in the README.' }, 503);
  const m = request.method;

  if (m === 'POST' && seg.length === 1) {
    const ownerType = url.searchParams.get('ownerType');
    const ownerId = url.searchParams.get('ownerId') || '';
    if (!['service', 'entry'].includes(ownerType) || !ownerId) return json({ error: 'Say which service or bill the screenshot belongs to.' }, 400);
    const table = ownerType === 'service' ? 'services' : 'entries';
    const owner = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(ownerId).first();
    if (!owner) return json({ error: 'That service or bill no longer exists. Reload the page.' }, 404);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ? AND owner_id = ?').bind(ownerType, ownerId).first();
    if (count.n >= MAX_UPLOADS_PER_ITEM) return json({ error: `Each item can hold up to ${MAX_UPLOADS_PER_ITEM} screenshots. Delete one first.` }, 400);

    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_UPLOAD_BYTES) return json({ error: 'That image is over 5 MB. Crop it or save it as JPEG and try again.' }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return json({ error: 'That file is empty.' }, 400);
    if (bytes.length > MAX_UPLOAD_BYTES) return json({ error: 'That image is over 5 MB. Crop it or save it as JPEG and try again.' }, 413);
    const type = sniffImage(bytes);
    if (!type) return json({ error: 'Only PNG, JPEG, WebP or GIF images can be uploaded.' }, 415);

    let filename = '';
    try { filename = decodeURIComponent(request.headers.get('X-Filename') || ''); } catch { /* keep blank */ }
    filename = filename.replace(/[\u0000-\u001f\\/]/g, '').trim().slice(0, 120) || 'screenshot';
    const id = crypto.randomUUID();
    const key = `${ownerType}/${ownerId}/${id}`;
    await env.UPLOADS.put(key, bytes, { httpMetadata: { contentType: type } });
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO attachments (id, owner_type, owner_id, r2_key, filename, content_type, size, created_by) VALUES (?,?,?,?,?,?,?,?)').bind(id, ownerType, ownerId, key, filename, type, bytes.length, email),
        audit(env, email, 'ATTACHMENT_ADDED', `${ownerType}:${ownerId}`, filename),
      ]);
    } catch (err) {
      await env.UPLOADS.delete(key); // don't leave an orphaned file behind
      throw err;
    }
    return json({ ok: true, id }, 201);
  }

  if (seg.length === 2) {
    const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(seg[1]).first();
    if (!row) return json({ error: 'That screenshot no longer exists.' }, 404);
    if (m === 'GET') {
      const obj = await env.UPLOADS.get(row.r2_key);
      if (!obj) return json({ error: 'That screenshot is missing from storage.' }, 404);
      return new Response(obj.body, {
        headers: {
          'Content-Type': row.content_type,
          'Content-Length': String(row.size),
          'Content-Disposition': `inline; filename="${row.filename.replace(/[^\w.\- ]/g, '_')}"`,
          'X-Own-CSP': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        },
      });
    }
    if (m === 'DELETE') {
      await env.UPLOADS.delete(row.r2_key);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(row.id),
        audit(env, email, 'ATTACHMENT_DELETED', `${row.owner_type}:${row.owner_id}`, row.filename),
      ]);
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found.' }, 404);
}

async function deleteAttachmentsOf(env, ownerType, ownerId) {
  const { results } = await env.DB.prepare('SELECT id, r2_key FROM attachments WHERE owner_type = ? AND owner_id = ?').bind(ownerType, ownerId).all();
  if (!results.length) return;
  if (env.UPLOADS) await env.UPLOADS.delete(results.map((r) => r.r2_key));
  await env.DB.prepare('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?').bind(ownerType, ownerId).run();
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
// Payment links must be ordinary https:// web addresses (no javascript:, no passwords in the link).
export function paymentUrl(v) {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (!raw) return '';
  if (raw.length > 500) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return u.toString();
}
const priority = (v) => { const p = String(v || 'MEDIUM').toUpperCase(); return PRIORITIES.includes(p) ? p : null; };

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
  const prio = priority(b.priority);
  if (!prio) return { error: 'Choose a priority.' };
  const link = paymentUrl(b.paymentUrl);
  if (link === null) return { error: 'The payment link must be a full web address starting with https://' };
  return {
    name, billing, currency, priceMinor, status, priority: prio, paymentUrl: link,
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
  const prio = priority(b.priority);
  if (!prio) return { error: 'Choose a priority.' };
  const link = paymentUrl(b.paymentUrl);
  if (link === null) return { error: 'The payment link must be a full web address starting with https://' };
  const status = String(b.status || 'PAID').toUpperCase();
  if (!['PAID', 'DUE'].includes(status)) return { error: 'Choose paid or due.' };
  return { serviceId, period, amountMinor, currency, fx, ngnKobo, paidOn: date(b.paidOn), note: text(b.note, 300), priority: prio, paymentUrl: link, status };
}
