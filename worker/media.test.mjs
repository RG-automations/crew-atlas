// Testy bramki mediów: node media.test.mjs   (atrapy Firebase JWKS, Firestore REST i Cloudinary, bez sieci).
// Atrapy dowodzą logiki workera, nie działania prawdziwych usług.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
src = src.replace('export default {', 'const worker = {') + '\nexport { worker };';
const { worker } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const SECRET = 'cld-api-secret-VALUE';
const MEDIA_SECRET = 'media-token-secret-VALUE';
const env = {
  CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: 'key123', CLOUDINARY_API_SECRET: SECRET,
  FIREBASE_PROJECT_ID: 'proj', MEDIA_TOKEN_SECRET: MEDIA_SECRET,
};

// ---------- logi: nic nie może zawierać adresów Cloudinary ani sekretów ----------
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = (...a) => logged.push(a.map(String).join(' '));
const realLog = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---------- klucz RSA udający Google ----------
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function jwt(sub, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const p = b64({ aud: 'proj', iss: 'https://securetoken.google.com/proj', sub, iat: now, exp: now + 600, ...over });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}
const subOf = (auth) => JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1], 'base64url').toString()).sub;

// ---------- atrapa Firestore REST: odwzorowuje reguły (czyta tylko członek) ----------
const db = {
  trips: {
    T1: { memberIds: ['alice', 'bob', 'owner'], createdBy: 'owner' },
    T2: { memberIds: ['carol'], createdBy: 'carol' },
  },
  memories: {
    'T1/memOwn1': { publicId: 'wycieczka/T1/abcdefgh12', resourceType: 'image', createdBy: 'alice' },
    'T1/memBob1': { publicId: 'wycieczka/T1/zzzzzzzz34', resourceType: 'video', createdBy: 'bob' },
    'T1/memLegacy': { createdBy: 'alice', url: 'https://example.invalid/legacy.jpg' },
    'T1/memForged': { publicId: 'wycieczka/T2/victimfile99', resourceType: 'image', createdBy: 'alice' }, // wskazuje plik obcej podróży
    'T2/memCarol': { publicId: 'wycieczka/T2/carolfile11', resourceType: 'image', createdBy: 'carol' },
  },
};
let firestoreDown = false;
const str = (v) => ({ stringValue: v });
function firestore(u, init) {
  if (firestoreDown) throw new Error('network');
  const caller = subOf(init.headers.authorization);
  const tm = /documents\/trips\/([^/?]+)(?:\/memories\/([^/?]+))?\?/.exec(u);
  const trip = db.trips[tm[1]];
  if (!trip || !trip.memberIds.includes(caller)) return new Response('{}', { status: 403 }); // reguły: tylko członek
  if (!tm[2]) {
    return Response.json({ fields: { memberIds: { arrayValue: { values: trip.memberIds.map(str) } }, createdBy: str(trip.createdBy) } });
  }
  const mem = db.memories[`${tm[1]}/${tm[2]}`];
  if (!mem) return new Response('{}', { status: 404 });
  return Response.json({ fields: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, str(v)])) });
}

// ---------- atrapa Cloudinary ----------
const FILE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const cld = { urls: [], ranges: [], methods: [], destroys: [], mode: 'ok', pulls: 0, chunks: 10 };
const expectedSig = (path) => `s--${createHash('sha1').update(path + SECRET).digest('base64url').slice(0, 8)}--`;
function cloudinaryDelivery(u, init) {
  cld.urls.push(u);
  cld.methods.push(init.method || 'GET');
  cld.ranges.push(init.headers?.range);
  if (init.redirect !== 'manual') throw new Error('worker must not follow redirects');
  const m = /^https:\/\/res\.cloudinary\.com\/demo-cloud\/(image|video)\/authenticated\/(s--[A-Za-z0-9_-]{8}--)\/(.+)$/.exec(u);
  if (!m) return new Response('', { status: 400 });
  if (m[2] !== expectedSig(m[3])) return new Response('', { status: 401 }); // zły podpis = odmowa Cloudinary
  if (cld.mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://res.cloudinary.com/signed-secret-redirect' } });
  if (cld.mode === 'html') return new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (cld.mode === 'missing') return new Response('', { status: 404 });
  if (cld.mode === 'error') return new Response('boom', { status: 500 });
  let start = 0, end = FILE.length - 1, status = 200;
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: '"x"', 'set-cookie': 'a=b', 'x-cld-secret': 'leak', location: 'nope' };
  const r = init.headers?.range && /^bytes=(\d*)-(\d*)$/.exec(init.headers.range);
  if (r) { start = Number(r[1]); end = r[2] ? Number(r[2]) : end; status = 206; headers['content-range'] = `bytes ${start}-${end}/${FILE.length}`; }
  const slice = FILE.subarray(start, end + 1);
  headers['content-length'] = String(slice.length);
  if (init.method === 'HEAD') return new Response(null, { status, headers });
  const size = Math.ceil(slice.length / cld.chunks);
  let i = 0;
  const stream = new ReadableStream({ pull(c) { cld.pulls++; if (i >= slice.length) return c.close(); c.enqueue(slice.subarray(i, i + size)); i += size; } });
  return new Response(stream, { status, headers });
}
function cloudinaryApi(u, init) {
  const f = init.body;
  const params = Object.fromEntries([...f.entries()].filter(([k]) => !['api_key', 'signature'].includes(k)));
  const resource = /\/(image|video)\/destroy$/.exec(u)[1];
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const ok = createHash('sha1').update(toSign + SECRET).digest('hex') === f.get('signature');
  cld.destroys.push({ resource, params, signatureOk: ok, apiKey: f.get('api_key') });
  if (!ok) return Response.json({ error: { message: 'Invalid Signature' } }, { status: 401 });
  if (cld.mode === 'api-error') return Response.json({ result: 'error' });
  return Response.json({ result: cld.mode === 'not-found' ? 'not found' : 'ok' });
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('googleapis.com/service_accounts')) return Response.json({ keys: [jwk] });
  if (u.startsWith('https://firestore.googleapis.com/')) return firestore(u, init);
  if (u.startsWith('https://res.cloudinary.com/')) return cloudinaryDelivery(u, init);
  if (u.startsWith('https://api.cloudinary.com/')) return cloudinaryApi(u, init);
  throw new Error('unexpected fetch: ' + u);
};

const call = (path, init = {}, e = env) => worker.fetch(new Request('https://w.example' + path, init), e);
const bearer = (t) => ({ authorization: 'Bearer ' + t });
const mediaToken = async (user, tripId = 'T1') => {
  const r = await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt(user)), 'content-type': 'application/json' }, body: JSON.stringify({ tripId }) });
  return { status: r.status, ...(r.status === 200 ? await r.json() : {}) };
};
const noLeak = async (res, label) => {
  const text = res.headers.get('content-type')?.startsWith('application/json') ? await res.clone().text() : '';
  const all = JSON.stringify([...res.headers.entries()]) + text;
  for (const bad of ['res.cloudinary.com', 's--', SECRET, MEDIA_SECRET, 'api.cloudinary']) assert.ok(!all.includes(bad), `${label}: wyciek "${bad}"`);
  assert.ok(!res.headers.has('location'), `${label}: nagłówek Location`);
  assert.ok(!res.headers.has('set-cookie'), `${label}: Set-Cookie`);
};
const IMG = '/media/image/T1/abcdefgh12.jpg';
const VID = '/media/video/T1/zzzzzzzz34.mp4';

// ================= token dostępu =================
let t = await mediaToken('alice');
assert.equal(t.status, 200, 'uczestnik dostaje token');
assert.ok(t.token && t.expiresAt > Date.now() / 1000);
assert.ok(!t.token.includes(MEDIA_SECRET));
assert.equal((await mediaToken('stranger')).status, 403, 'osoba spoza podróży: odmowa');
assert.equal((await mediaToken('alice', 'T2')).status, 403, 'członek T1 nie dostaje tokenu T2');
assert.equal((await mediaToken('alice', '../T1')).status, 400);
assert.equal((await call('/media/token', { method: 'POST', body: '{"tripId":"T1"}' })).status, 401);
assert.equal((await call('/media/token', { method: 'POST', headers: bearer('a.b.c'), body: '{"tripId":"T1"}' })).status, 401);
assert.equal((await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('alice', { exp: 1 })), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' })).status, 401, 'wygasły token Firebase');
assert.equal((await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('alice', { aud: 'inny' })), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' })).status, 401);
firestoreDown = true;
assert.equal((await mediaToken('alice')).status, 502, 'Firestore niedostępny: bez tokenu');
firestoreDown = false;
assert.equal((await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('alice')), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, { ...env, MEDIA_TOKEN_SECRET: '' })).status, 500, 'bez sekretu nie wydaje tokenów');

// ================= odczyt pliku =================
const A = bearer((await mediaToken('alice')).token);
let r = await call(IMG, { headers: A });
assert.equal(r.status, 200, 'uczestnik czyta plik');
assert.equal(Buffer.from(await r.arrayBuffer()).length, 1000);
await noLeak(r, 'GET 200');
// podpisany adres Cloudinary ma dokładnie oczekiwany kształt i typ authenticated (w atrapie zły podpis = 401)
assert.equal(cld.urls.at(-1), `https://res.cloudinary.com/demo-cloud/image/authenticated/${expectedSig('wycieczka/T1/abcdefgh12.jpg')}/wycieczka/T1/abcdefgh12.jpg`);
// nagłówki prywatnej odpowiedzi
assert.equal(r.headers.get('cache-control'), 'private, no-store');
assert.equal(r.headers.get('vary'), 'Authorization');
assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
assert.equal(r.headers.get('content-type'), 'video/mp4');
assert.ok(!r.headers.has('etag') && !r.headers.has('x-cld-secret'), 'tylko biała lista nagłówków');

// brak tokenu, zły token, token w adresie, token cudzej podróży, token obcego klucza
assert.equal((await call(IMG)).status, 401);
assert.equal((await call(IMG, { headers: bearer('abc.def') })).status, 401);
assert.equal((await call(`${IMG}?t=${(await mediaToken('alice')).token}`)).status, 401, 'token w URL nie jest akceptowany');
assert.equal((await call(IMG, { headers: bearer(await jwt('alice')) })).status, 401, 'token Firebase nie jest tokenem mediów');
const tok = (await mediaToken('alice')).token;
assert.equal((await call(IMG, { headers: bearer(tok.slice(0, -2) + (tok.endsWith('aa') ? 'bb' : 'aa')) })).status, 401, 'zmieniony podpis');
const [pl, sg] = tok.split('.');
const forgedPayload = Buffer.from(JSON.stringify({ u: 'alice', t: 'T2', e: 9999999999 })).toString('base64url');
assert.equal((await call('/media/image/T2/carolfile11.jpg', { headers: bearer(`${forgedPayload}.${sg}`) })).status, 401, 'podmieniony payload');
assert.equal((await call('/media/image/T2/carolfile11.jpg', { headers: A })).status, 403, 'token T1 nie otwiera plików T2');
const strangerTok = await mediaToken('carol', 'T2');
assert.equal((await call(IMG, { headers: bearer(strangerTok.token) })).status, 403, 'token T2 nie otwiera plików T1');

// podstawianie identyfikatora: zawsze prefiks wycieczka/<tripId>/, nic spoza walidowanych znaków
const before = cld.urls.length;
for (const p of ['/media/image/T1/..%2Ft2%2Ffile.jpg', '/media/image/T1/abc.jpg', '/media/image/T1/abcdefgh12.php', '/media/raw/T1/abcdefgh12.jpg',
  '/media/image/T1/abcdefgh12.jpg/extra', '/media/image/T1/a%2Fb12345678.jpg', '/media/image/%2e%2e/abcdefgh12.jpg', '/media/image/T1//abcdefgh12.jpg',
  '/media/image/T1/abcdefgh12.mp4', '/media/video/T1/abcdefgh12.jpg', '/media/image/T1/abcdefgh12.JPG']) {
  const x = await call(p, { headers: A });
  assert.ok([404, 400].includes(x.status), `${p} -> ${x.status}`);
}
assert.equal(cld.urls.length, before, 'zły identyfikator nie dociera do Cloudinary');
// klient nie dokłada parametrów do adresu Cloudinary
await call(`${IMG}?transformation=w_5000&type=upload&public_id=other&api_key=1&sig=2`, { headers: A });
assert.ok(!cld.urls.at(-1).includes('w_5000') && cld.urls.at(-1).includes('/authenticated/') && !cld.urls.at(-1).includes('other'));

// miniatury: stałe przekształcenie, klient nie wybiera własnego
await call(`${IMG}?thumb=1`, { headers: A });
assert.ok(cld.urls.at(-1).endsWith('/c_fill,g_auto,h_160,w_160/wycieczka/T1/abcdefgh12.jpg'));
assert.equal(cld.urls.at(-1).match(/s--[A-Za-z0-9_-]{8}--/)[0], expectedSig('c_fill,g_auto,h_160,w_160/wycieczka/T1/abcdefgh12.jpg'));
await call(`${VID}?thumb=1`, { headers: A });
assert.ok(cld.urls.at(-1).endsWith('/c_fill,h_160,so_0,w_160/wycieczka/T1/zzzzzzzz34.jpg'), 'miniatura wideo to klatka jpg');
await call(`${IMG}?thumb=c_scale,w_9000`, { headers: A });
assert.ok(!cld.urls.at(-1).includes('9000') && !cld.urls.at(-1).includes('c_fill'), 'thumb przyjmuje tylko 1');

// ================= Range, HEAD, strumień =================
r = await call(VID, { headers: { ...A, range: 'bytes=100-199' } });
assert.equal(r.status, 206);
assert.equal(cld.ranges.at(-1), 'bytes=100-199');
assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
assert.equal(r.headers.get('content-length'), '100');
assert.equal(r.headers.get('accept-ranges'), 'bytes');
assert.deepEqual(Buffer.from(await r.arrayBuffer()), FILE.subarray(100, 200));
r = await call(VID, { headers: { ...A, range: 'bytes=900-' } });
assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 900-999/1000');
r = await call(VID, { headers: { ...A, range: 'bytes=-50' } });
assert.equal(r.status, 206);
for (const bad of ['bytes=0-1,5-9', 'bytes=abc', 'items=0-5', 'bytes=0-5; evil', 'bytes=0-5\n x']) {
  try {
    await call(VID, { headers: { ...A, range: bad } });
    assert.equal(cld.ranges.at(-1), undefined, `nieprawidłowy Range "${bad}" nie jest przekazywany`);
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; /* nagłówek odrzucony już przez Request */ }
}
r = await call(VID, { method: 'HEAD', headers: A });
assert.equal(r.status, 200); assert.equal(r.headers.get('content-length'), '1000'); assert.equal(await r.text(), '');
assert.equal(cld.methods.at(-1), 'HEAD');
assert.equal((await call(VID, { method: 'POST', headers: A })).status, 404, 'tylko GET/HEAD');
// strumień: po zwróceniu odpowiedzi worker nie wczytał całego pliku (nie buforuje w pamięci)
cld.pulls = 0;
r = await call(VID, { headers: A });
assert.ok(cld.pulls < cld.chunks, `worker przeczytał ${cld.pulls} z ${cld.chunks} porcji przed oddaniem odpowiedzi`);
assert.equal(Buffer.from(await r.arrayBuffer()).length, 1000);

// ================= odpowiedzi Cloudinary, które nie mogą trafić do klienta =================
cld.mode = 'redirect';
r = await call(IMG, { headers: A });
assert.equal(r.status, 502); await noLeak(r, 'redirect');
cld.mode = 'html';
r = await call(IMG, { headers: A });
assert.equal(r.headers.get('content-type'), 'application/octet-stream', 'nieznany typ nie jest przekazywany');
assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
cld.mode = 'missing';
r = await call(IMG, { headers: A }); assert.equal(r.status, 404); await noLeak(r, '404');
cld.mode = 'error';
r = await call(IMG, { headers: A }); assert.equal(r.status, 502); await noLeak(r, '500');
cld.mode = 'ok';

// ================= usunięcie z grupy i wygasanie =================
const bobTok = await mediaToken('bob');
assert.equal((await call(IMG, { headers: bearer(bobTok.token) })).status, 200);
db.trips.T1.memberIds = db.trips.T1.memberIds.filter((x) => x !== 'bob'); // Bob opuszcza grupę
assert.equal((await mediaToken('bob')).status, 403, 'po opuszczeniu grupy nie dostaje nowego tokenu');
assert.equal((await call(IMG, { headers: bearer(bobTok.token) })).status, 200,
  'znane ograniczenie: już wydany token działa do końca ważności (domyślnie 10 min)');
const realNow = Date.now;
Date.now = () => realNow() + 11 * 60 * 1000;
assert.equal((await call(IMG, { headers: bearer(bobTok.token) })).status, 401, 'po wygaśnięciu token nie działa');
Date.now = realNow;
// krótszy czas życia z konfiguracji, z dolnym i górnym ograniczeniem
const short = await (await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('alice')), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, { ...env, MEDIA_TOKEN_TTL: '1' })).json();
assert.ok(short.expiresAt - Math.floor(Date.now() / 1000) >= 59 && short.expiresAt - Math.floor(Date.now() / 1000) <= 61, 'minimum 60 s');
const long = await (await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('alice')), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, { ...env, MEDIA_TOKEN_TTL: '999999' })).json();
assert.ok(long.expiresAt - Math.floor(Date.now() / 1000) <= 3601, 'maksimum 1 h');
db.trips.T1.memberIds.push('bob');

// ================= usuwanie mediów =================
const del = (user, path, token) => call(path, { method: 'DELETE', headers: bearer(token ?? user) });
const aliceFb = await jwt('alice'), bobFb = await jwt('bob'), ownerFb = await jwt('owner'), strangerFb = await jwt('stranger');
cld.destroys.length = 0;
r = await del(aliceFb, '/media/memory/T1/memOwn1');
assert.equal(r.status, 200, 'autor usuwa własne medium');
assert.deepEqual(cld.destroys.at(-1).params.type, 'authenticated');
assert.equal(cld.destroys.at(-1).params.public_id, 'wycieczka/T1/abcdefgh12');
assert.equal(cld.destroys.at(-1).params.invalidate, 'true');
assert.equal(cld.destroys.at(-1).resource, 'image');
assert.ok(cld.destroys.at(-1).signatureOk && cld.destroys.at(-1).apiKey === 'key123');
await noLeak(r, 'delete');
cld.destroys.length = 0;
assert.equal((await del(ownerFb, '/media/memory/T1/memBob1')).status, 200, 'założyciel usuwa cudze medium');
assert.equal(cld.destroys.at(-1).resource, 'video');
for (const [label, fb, path, status] of [
  ['inny członek cudzego wpisu', bobFb, '/media/memory/T1/memOwn1', 403],
  ['obcy', strangerFb, '/media/memory/T1/memOwn1', 403],
  ['nieistniejący wpis', aliceFb, '/media/memory/T1/nope', 403],
  ['wpis starego typu (bez publicId)', aliceFb, '/media/memory/T1/memLegacy', 400],
  ['wpis wskazuje plik innej podróży', aliceFb, '/media/memory/T1/memForged', 403],
]) {
  cld.destroys.length = 0;
  assert.equal((await del(fb, path)).status, status, label);
  assert.equal(cld.destroys.length, 0, `${label}: Cloudinary nie może być wywołane`);
}
assert.equal((await call('/media/memory/T1/memOwn1', { method: 'DELETE' })).status, 401);
assert.equal((await del(null, '/media/memory/T1/memOwn1', 'a.b.c')).status, 401);
assert.equal((await del(null, '/media/memory/T1/memOwn1', (await mediaToken('alice')).token)).status, 401, 'token mediów nie pozwala usuwać');
cld.mode = 'not-found';
assert.equal((await del(aliceFb, '/media/memory/T1/memOwn1')).status, 200, 'brak pliku to też sukces (idempotentnie)');
cld.mode = 'api-error';
assert.equal((await del(aliceFb, '/media/memory/T1/memOwn1')).status, 502);
cld.mode = 'ok';
firestoreDown = true;
assert.equal((await del(aliceFb, '/media/memory/T1/memOwn1')).status, 502);
firestoreDown = false;

// ================= krótszy token (MEDIA_TOKEN_TTL=120) =================
{
  const env120 = { ...env, MEDIA_TOKEN_TTL: '120' };
  const issue = async (user) => (await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt(user)), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, env120)).json();
  const tk = await issue('alice');
  const left = tk.expiresAt - Math.floor(Date.now() / 1000);
  assert.ok(left >= 119 && left <= 121, `ważność 120 s, jest ${left}`);
  const real = Date.now;
  Date.now = () => real() + 119 * 1000;
  assert.equal((await call(IMG, { headers: bearer(tk.token) }, env120)).status, 200, 'przed końcem ważności działa');
  Date.now = () => real() + 122 * 1000;
  assert.equal((await call(IMG, { headers: bearer(tk.token) }, env120)).status, 401, 'po 2 minutach nie działa');
  Date.now = real;
  // okno dostępu po opuszczeniu grupy równa się ważności tokenu
  const carolLike = await issue('bob');
  db.trips.T1.memberIds = db.trips.T1.memberIds.filter((x) => x !== 'bob');
  const again = await call('/media/token', { method: 'POST', headers: { ...bearer(await jwt('bob')), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, env120);
  assert.equal(again.status, 403);
  Date.now = () => real() + 121 * 1000;
  assert.equal((await call(IMG, { headers: bearer(carolLike.token) }, env120)).status, 401, 'po opuszczeniu grupy dostęp kończy się najpóźniej po TTL');
  Date.now = real;
  db.trips.T1.memberIds.push('bob');
}

// ================= opcjonalna lista dozwolonych kont (otwarta rejestracja) =================
{
  const envA = { ...env, ALLOWED_UIDS: ' alice , owner ' };
  const tokReq = async (user, e) => call('/media/token', { method: 'POST', headers: { ...bearer(await jwt(user)), 'content-type': 'application/json' }, body: '{"tripId":"T1"}' }, e);
  assert.equal((await tokReq('alice', envA)).status, 200);
  assert.equal((await tokReq('bob', envA)).status, 403, 'członek spoza listy nie dostaje tokenu');
  assert.equal((await tokReq('bob', { ...env, ALLOWED_UIDS: '' })).status, 200, 'pusta lista: bez ograniczenia');
  assert.equal((await call('/sign', { method: 'POST', headers: { ...bearer(await jwt('bob')), 'content-type': 'application/json' }, body: '{"folder":"wycieczka/T1","v":2}' }, envA)).status, 403);
  assert.equal((await call('/sign', { method: 'POST', headers: { ...bearer(await jwt('alice')), 'content-type': 'application/json' }, body: '{"folder":"wycieczka/T1","v":2}' }, envA)).status, 200);
  cld.destroys.length = 0;
  assert.equal((await call('/media/memory/T1/memBob1', { method: 'DELETE', headers: bearer(await jwt('bob')) }, envA)).status, 403);
  assert.equal(cld.destroys.length, 0);
  // złe konto nie dostaje przy tym treści błędu zdradzającej listę
  const body = await (await tokReq('bob', envA)).text();
  assert.ok(!body.includes('alice') && !body.includes('owner'));
  // token wydany wcześniej działa do końca ważności (jak w przypadku opuszczenia grupy)
}

// ================= bez konfiguracji Cloudinary (np. worker testowy przed podłączeniem konta) =================
{
  const noCld = { ...env, CLOUDINARY_CLOUD: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '' };
  const j = { 'content-type': 'application/json' };
  const before = cld.destroys.length;
  const sg = async (u, e) => call('/sign', { method: 'POST', headers: { ...bearer(await jwt(u)), ...j }, body: '{"folder":"wycieczka/T1","v":2}' }, e);
  assert.equal((await sg('alice', noCld)).status, 500, '/sign bez Cloudinary: 500, nie podpis z pustym sekretem');
  assert.equal((await sg('stranger', noCld)).status, 403, 'autoryzacja jest sprawdzana przed konfiguracją');
  const tok = (await mediaToken('alice')).token;
  const file = await call('/media/image/T1/abcdefgh12.png', { headers: { authorization: `Bearer ${tok}` } }, noCld);
  assert.equal(file.status, 500, 'ważny token, ale brak Cloudinary: 500');
  assert.equal((await call('/media/image/T1/abcdefgh12.png', {}, noCld)).status, 401, 'bez tokenu nadal 401');
  assert.equal((await call('/media/image/OTHER/abcdefgh12.png', { headers: { authorization: `Bearer ${tok}` } }, noCld)).status, 403, 'cudza podróż nadal 403');
  assert.equal((await call('/media/memory/T1/memBob1', { method: 'DELETE', headers: bearer(await jwt('owner')) }, noCld)).status, 500);
  assert.equal(cld.destroys.length, before, 'bez konfiguracji nic nie jest usuwane');
  await noLeak(file, 'brak konfiguracji');
}

// ================= logi =================
for (const line of logged) for (const bad of ['res.cloudinary.com', 's--', SECRET, MEDIA_SECRET]) assert.ok(!line.includes(bad), 'wyciek w logach');
assert.equal(logged.length, 0, 'worker niczego nie loguje');
realLog('Testy bramki mediów przeszły');
