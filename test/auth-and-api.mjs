// Sign-in checks for the Worker, run in Node with a fake Cloudflare Access key server.
// No Cloudflare account or database needed: `npm test`.
import assert from 'node:assert/strict';
import worker, { parseEntry, parseService, configProblem, sniffImage, paymentUrl, auditPage } from '../src/worker.js';

const TEAM = 'zyria-test.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256' };

globalThis.fetch = async (url) => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
};

async function sign(payload, key = privateKey, kid = 'k1') {
  const head = enc({ alg: 'RS256', kid });
  const body = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], iss: `https://${TEAM}`, email: 'Founder@Zyria.ng', exp: now + 600, iat: now };

const env = (extra = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ASSETS: { fetch: async () => new Response('<h1>page</h1>', { status: 200 }) }, ...extra });
const req = (headers = {}, path = '/') => new Request(`https://costs.zyria.ng${path}`, { headers: { 'cf-connecting-ip': '102.89.1.1', ...headers } });
const status = async (r, e = env()) => (await worker.fetch(r, e)).status;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('valid Access token opens the page', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign(good) })), 200));
await t('token in CF_Authorization cookie works', async () => assert.equal(await status(req({ Cookie: `a=b; CF_Authorization=${await sign(good)}` })), 200));
await t('no token is refused', async () => assert.equal(await status(req()), 403));
await t('wrong audience is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign({ ...good, aud: ['other'] }) })), 403));
await t('wrong issuer is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }) })), 403));
await t('expired token is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign({ ...good, exp: now - 5 }) })), 403));
await t('token signed by another key is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign(good, other.privateKey) })), 403));
await t('unknown key id is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign(good, privateKey, 'k9') })), 403));
await t('alg none is refused', async () => {
  const tok = `${enc({ alg: 'none', kid: 'k1' })}.${enc(good)}.`;
  assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': tok })), 403);
});
await t('garbage token is refused', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': 'a.b.c' })), 403));
await t('placeholder settings fail closed', async () => assert.equal(await status(req({ 'Cf-Access-Jwt-Assertion': await sign(good) }), env({ ACCESS_TEAM_DOMAIN: 'REPLACE_WITH_TEAM_DOMAIN' })), 503));
await t('wrong settings are explained', async () => {
  assert.match(configProblem({ ACCESS_TEAM_DOMAIN: 'costs.zyria.ng', ACCESS_AUD: AUD }), /team domain/);
  assert.match(configProblem({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '2662a3f4-35f7-4f9e-b455-db1e62fd4625' }), /64-character/);
  assert.equal(configProblem({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }), null);
  assert.equal(await status(req(), env({ ACCESS_TEAM_DOMAIN: 'costs.zyria.ng' })), 503);
});
await t('dev bypass is ignored once Access is configured', async () => assert.equal(await status(req({ 'cf-connecting-ip': '127.0.0.1' }), env({ LOCAL_DEV_EMAIL: 'x@y.z' })), 403));
await t('dev bypass is ignored for visitors not on this machine', async () => assert.equal(await status(req(), env({ LOCAL_DEV_EMAIL: 'x@y.z', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' })), 403));
await t('dev bypass works on this machine without Access', async () => assert.equal(await status(req({ 'cf-connecting-ip': '127.0.0.1' }), env({ LOCAL_DEV_EMAIL: 'x@y.z', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' })), 200));

await t('every response tells crawlers to stay out', async () => {
  for (const r of [req(), req({ 'Cf-Access-Jwt-Assertion': await sign(good) })]) {
    const res = await worker.fetch(r, env());
    assert.match(res.headers.get('X-Robots-Tag'), /noindex/);
    assert.match(res.headers.get('X-Robots-Tag'), /nofollow/);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  }
  const robots = await worker.fetch(req({}, '/robots.txt'), env());
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
});

await t('cross-site API writes are blocked even when signed in', async () => {
  const r = new Request('https://costs.zyria.ng/api/settings', { method: 'PUT', headers: { 'cf-connecting-ip': '102.89.1.1', Origin: 'https://evil.example', 'Cf-Access-Jwt-Assertion': await sign(good), 'Content-Type': 'application/json' }, body: '{"fxRate":1}' });
  assert.equal(await status(r), 403);
});

await t('naira is worked out in whole kobo', async () => {
  const e = parseEntry({ serviceId: 's', period: '2026-10', amount: '12.34', currency: 'USD', fxRate: '1400.50' });
  assert.equal(e.ngnKobo, 1728217);
  assert.equal(parseEntry({ serviceId: 's', period: '2026-10', amount: 8500, currency: 'NGN' }).ngnKobo, 850000);
  assert.ok(parseEntry({ serviceId: 's', period: '2026-13', amount: 1, currency: 'NGN' }).error);
  assert.ok(parseEntry({ serviceId: 's', period: '2026-10', amount: -1, currency: 'NGN' }).error);
  assert.ok(parseEntry({ serviceId: 's', period: '2026-10', amount: 1, currency: 'USD' }).error, 'USD bills need a rate');
  assert.equal(parseService({ name: 'X', billing: 'FREE', price: 99 }).priceMinor, 0);
  assert.equal(parseService({ name: 'X', billing: 'YEARLY', price: 15600 }).spreadMonthly, 1, 'yearly costs spread monthly by default');
  assert.equal(parseService({ name: 'X', billing: 'YEARLY', price: 15600, spreadMonthly: false }).spreadMonthly, 0);
});

await t('priority, status and payment links are checked', async () => {
  const base = { serviceId: 's', period: '2026-10', amount: 1, currency: 'NGN' };
  assert.equal(parseEntry(base).priority, 'MEDIUM');
  assert.equal(parseEntry(base).status, 'PAID', 'bills default to paid');
  assert.equal(parseEntry({ ...base, priority: 'critical', status: 'due' }).priority, 'CRITICAL');
  assert.equal(parseEntry({ ...base, status: 'due' }).status, 'DUE');
  assert.ok(parseEntry({ ...base, priority: 'URGENT' }).error);
  assert.ok(parseEntry({ ...base, status: 'MAYBE' }).error);
  assert.equal(parseEntry(base).counted, 1, 'bills count in totals by default');
  assert.equal(parseEntry({ ...base, counted: false }).counted, 0);
  assert.equal(parseEntry({ ...base, counted: true }).counted, 1);
  assert.equal(paymentUrl(''), '');
  assert.equal(paymentUrl(' https://vercel.com/account/billing '), 'https://vercel.com/account/billing');
  for (const bad of ['javascript:alert(1)', 'http://pay.example.com', 'data:text/html,hi', 'https://user:pw@pay.example.com', 'vercel.com/billing', 'https://' + 'a'.repeat(600)]) {
    assert.equal(paymentUrl(bad), null, bad.slice(0, 40));
  }
  assert.ok(parseService({ name: 'X', billing: 'FREE', paymentUrl: 'javascript:alert(1)' }).error);
});

await t('only real images are accepted, whatever the file is called', async () => {
  const bytes = (...b) => new Uint8Array(b);
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('<html><script>')), null);
  assert.equal(sniffImage(bytes()), null);
});

await t('activity paging only allows 10, 20, 50 or 100 per page', async () => {
  const q = (s) => auditPage(new URLSearchParams(s));
  assert.deepEqual(q(''), { page: 1, size: 10 });
  assert.deepEqual(q('page=3&size=50'), { page: 3, size: 50 });
  assert.deepEqual(q('page=-2&size=7'), { page: 1, size: 10 });
  assert.deepEqual(q('page=abc&size=100'), { page: 1, size: 100 });
  assert.deepEqual(q('page=2.7&size=20'), { page: 2, size: 20 });
});

console.log(`\n${n} checks passed`);
