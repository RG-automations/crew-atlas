// Test lokalny: node test.mjs   (nie jest wdrażany na Cloudflare)
import fs from 'node:fs';
import assert from 'node:assert/strict';

let src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
src = src.replace('export default {', 'const worker = {') + '\nexport { worker };';
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { worker } = mod;

const env = {
  CLOUDINARY_CLOUD: 'chmura', CLOUDINARY_API_KEY: 'k123',
  CLOUDINARY_API_SECRET: 'sekret', FIREBASE_PROJECT_ID: 'proj',
};

// --- klucz RSA i JWKS udające Google ---
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
async function makeJwt(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: 'k1' });
  const p = b64({ aud: 'proj', iss: 'https://securetoken.google.com/proj', sub: 'uid1', iat: now, exp: now + 600, ...over });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

const firestoreCalls = [];
let firestoreDown = false;
// Atrapa Firestore REST: odwzorowuje to, co robią reguły (czyta tylko członek) - członkiem T-OK jest uid1,
// T-OTHER należy do kogoś innego (403, jak z reguł), T-LIAR zwraca 200 bez uid1 (obrona w głębi).
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('googleapis.com/service_accounts')) return new Response(JSON.stringify({ keys: [jwk] }));
  if (u.startsWith('https://firestore.googleapis.com/')) {
    if (firestoreDown) throw new Error('network');
    firestoreCalls.push({ url: u, auth: init?.headers?.authorization });
    const ids = (u.match(/\/trips\/([^?]+)/) || [])[1];
    if (ids === 'T-OK') return new Response(JSON.stringify({ fields: { memberIds: { arrayValue: { values: [{ stringValue: 'uid0' }, { stringValue: 'uid1' }] } } } }));
    if (ids === 'T-LIAR') return new Response(JSON.stringify({ fields: { memberIds: { arrayValue: { values: [{ stringValue: 'uid0' }] } } } }));
    return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 });
  }
  throw new Error('nieoczekiwane wywołanie: ' + u);
};

const call = (path, init = {}) => worker.fetch(new Request('https://w.example' + path, init), env);

// health + 404
assert.equal((await call('/health')).status, 200);
assert.equal((await call('/nic')).status, 404);

// mapa nie przechodzi już przez worker: dawne ścieżki nie istnieją (404), nic nie jest pobierane z MapTilera
assert.equal((await call('/session', { headers: { authorization: 'Bearer ' + await makeJwt() } })).status, 404);
assert.equal((await call('/m/tiles/v3/1/2/3.pbf?t=1.x')).status, 404);

// /sign
const { createHash } = await import('node:crypto');
const sha1 = (t) => createHash('sha1').update(t).digest('hex');
const jwt = await makeJwt();
const auth = { authorization: 'Bearer ' + jwt, 'content-type': 'application/json' };
const sign = (body, headers = auth, e = env) =>
  worker.fetch(new Request('https://w.example/sign', { method: 'POST', headers, body: JSON.stringify(body) }), e);

assert.equal((await call('/sign', { method: 'POST' })).status, 401);
assert.equal((await sign({ folder: 'wycieczka/T-OK' }, { 'content-type': 'application/json' })).status, 401);

// nieprawidłowe foldery nie dochodzą nawet do Firestore
const before = firestoreCalls.length;
for (const folder of ['../x', 'wycieczka/', 'wycieczka/a/b', 'inny/T-OK', 'wycieczka/..', 'wycieczka/a b', 'wycieczka/' + 'x'.repeat(65), 5, null, undefined, ['wycieczka/T-OK']]) {
  assert.equal((await sign({ folder })).status, 400, `folder ${JSON.stringify(folder)}`);
}
assert.equal(firestoreCalls.length, before, 'Firestore nie powinien być pytany o zły folder');

// obca podróż (403 z reguł), kłamliwa odpowiedź bez uid, Firestore niedostępny - zawsze bez podpisu
const denied = await sign({ folder: 'wycieczka/T-OTHER', v: 2 });
assert.equal(denied.status, 403);
assert.ok(!JSON.stringify(await denied.json()).includes('signature'));
assert.equal((await sign({ folder: 'wycieczka/T-LIAR', v: 2 })).status, 403);
firestoreDown = true;
assert.equal((await sign({ folder: 'wycieczka/T-OK', v: 2 })).status, 502);
firestoreDown = false;

// członek: token użytkownika jest przekazany do Firestore (to on poddaje żądanie regułom)
assert.equal((await sign({ folder: 'wycieczka/T-OK', v: 2 })).status, 200);
const last = firestoreCalls.at(-1);
assert.equal(last.auth, 'Bearer ' + jwt);
assert.ok(last.url.includes('/projects/proj/databases/(default)/documents/trips/T-OK'));

// stary format podpisu (bez typu dostępu) jest odrzucany: nie da się nim wysłać prywatnego pliku
const old = await sign({ folder: 'wycieczka/T-OK' });
assert.equal(old.status, 426);
assert.ok(!JSON.stringify(await old.json()).includes('signature'));

// v2: jeden podpis = jeden plik, ograniczone formaty, brak sekretu w odpowiedzi
const a = await (await sign({ folder: 'wycieczka/T-OK', v: 2 })).json();
const b = await (await sign({ folder: 'wycieczka/T-OK', v: 2 })).json();
const p = a.params;
assert.deepEqual(Object.keys(p).sort(), ['allowed_formats', 'overwrite', 'public_id', 'timestamp', 'type']);
assert.equal(p.type, 'authenticated', 'nowe pliki zawsze prywatne');
assert.equal(p.overwrite, 'false');
assert.match(p.public_id, /^wycieczka\/T-OK\/[0-9a-f-]{36}$/);
assert.notEqual(p.public_id, b.params.public_id, 'public_id musi być unikalny');
assert.ok(p.allowed_formats.split(',').includes('jpg') && !p.allowed_formats.includes('exe') && !p.allowed_formats.includes('svg'));
assert.equal(a.signature, sha1(`allowed_formats=${p.allowed_formats}&overwrite=false&public_id=${p.public_id}&timestamp=${p.timestamp}&type=authenticated` + 'sekret'));
assert.equal(a.apiKey, 'k123');
assert.ok(!JSON.stringify(a).includes('sekret'));
// klient nie wpływa na parametry podpisu: nie wymusi publicznego typu, własnego id ani formatów
const forged = await (await sign({ folder: 'wycieczka/T-OK', v: 2, public_id: 'x', allowed_formats: 'exe', type: 'upload', access_mode: 'public', overwrite: true, resource_type: 'raw' })).json();
assert.notEqual(forged.params.public_id, 'x');
assert.ok(!forged.params.allowed_formats.includes('exe'));
assert.equal(forged.params.type, 'authenticated');
assert.deepEqual(Object.keys(forged.params).sort(), ['allowed_formats', 'overwrite', 'public_id', 'timestamp', 'type']);

// VIDEO_STRIP: transformacja usuwająca metadane tylko dla filmów i tylko gdy włączona w workerze
const sgn = async (body, e) => (await (await sign({ folder: 'wycieczka/T-OK', v: 2, ...body }, auth, e)).json()).params;
assert.equal((await sgn({ kind: 'video' }, env)).transformation, undefined, 'domyślnie wyłączone');
const envStrip = { ...env, VIDEO_STRIP: '1' };
const pv = await sgn({ kind: 'video' }, envStrip);
assert.equal(pv.transformation, 'fl_force_strip');
assert.equal(pv.type, 'authenticated');
assert.equal((await sgn({ kind: 'photo' }, envStrip)).transformation, undefined);
assert.equal((await sgn({ kind: 'audio' }, envStrip)).transformation, undefined, 'głosówki bez transformacji wideo');
assert.equal((await sgn({}, envStrip)).transformation, undefined);
assert.equal((await sgn({ kind: 'photo', transformation: 'fl_force_strip' }, envStrip)).transformation, undefined, 'klient nie dokłada transformacji');
assert.equal((await sgn({ kind: 'video', transformation: 'e_blur:2000' }, envStrip)).transformation, 'fl_force_strip', 'klient nie podmienia transformacji');
{
  const cr = await (await sign({ folder: 'wycieczka/T-OK', v: 2, kind: 'video' }, auth, envStrip)).json();
  const pp = cr.params;
  assert.equal(cr.signature, sha1(`allowed_formats=${pp.allowed_formats}&overwrite=false&public_id=${pp.public_id}&timestamp=${pp.timestamp}&transformation=fl_force_strip&type=authenticated` + 'sekret'), 'transformacja jest w podpisie');
}

// zły token / zła grupa odbiorców: 401 i komunikat nie zdradza konfiguracji workera
for (const over of [{ aud: 'inny' }, { exp: 1 }, { iss: 'https://evil.example/proj' }]) {
  const r = await sign({ folder: 'wycieczka/T-OK', v: 2 }, { authorization: 'Bearer ' + await makeJwt(over), 'content-type': 'application/json' });
  assert.equal(r.status, 401);
  assert.ok(!JSON.stringify(await r.json()).includes('proj'));
}
assert.equal((await sign({ folder: 'wycieczka/T-OK', v: 2 }, { authorization: 'Bearer a.b.c', 'content-type': 'application/json' })).status, 401);

console.log('Wszystkie testy workera przeszły');
