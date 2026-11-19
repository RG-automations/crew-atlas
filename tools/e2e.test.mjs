// Testy skryptów e2e-api-check i e2e-preflight: node tools/e2e.test.mjs
// Skrypty działają w procesie potomnym przeciw fałszywemu światu, w którym stoi PRAWDZIWY kod workera (worker/worker.js),
// a Firebase Auth, Firestore (z odwzorowaniem reguł) i Cloudinary są atrapami. To sprawdza logikę skryptów i workera,
// nie prawdziwe usługi.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const dir = fileURLToPath(new URL('.', import.meta.url));
const SECRET = 'cld-secret-VALUE', APIKEY_CLD = 'cldkey777', FB_KEY = 'fb-api-key-VALUE', PW = 'Pass-VALUE-123';
const TRIP = 'TESTTRIP1';

if (process.argv[2] === 'child') {
  const script = process.argv[4];
  const brk = (process.env.BREAK ?? '').split(',');
  let src = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
  src = src.replace('export default {', 'const worker = {') + '\nexport { worker };';
  const { worker } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const wenv = { CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: APIKEY_CLD, CLOUDINARY_API_SECRET: SECRET, FIREBASE_PROJECT_ID: 'proj',
    ...(brk.includes('no-media-secret') ? {} : { MEDIA_TOKEN_SECRET: 'media-secret-VALUE' }) };
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const jwt = async (sub) => {
    const now = Math.floor(Date.now() / 1000), h = b64({ alg: 'RS256', kid: 'k1' }), p = b64({ aud: 'proj', iss: 'https://securetoken.google.com/proj', sub, iat: now, exp: now + 3000 });
    return `${h}.${p}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`))).toString('base64url')}`;
  };
  const users = { 'member@test.invalid': ['u-member', PW], 'stranger@test.invalid': ['u-stranger', PW], 'member2@test.invalid': ['u-member2', PW] };
  const db = { trips: { [TRIP]: { memberIds: ['u-member', 'u-member2'], createdBy: 'u-member' } }, memories: {} };
  const assets = {};
  const fxb = (f) => fs.readFileSync(new URL(`../worker/fixtures/${f}`, import.meta.url));
  const seed = (n, res, fmt, type, file) => { assets[`authenticated/${res}/wycieczka/${TRIP}/seedmedia${n}`] = fxb(file); db.memories[`${TRIP}/m${n}`] = { publicId: `wycieczka/${TRIP}/seedmedia${n}`, resourceType: res, format: fmt, type, createdBy: 'u-member' }; };
  if (process.env.SEED === 'dirty') { seed(1, 'image', 'jpg', 'photo', 'synthetic-gps.jpg'); seed(2, 'video', 'mp4', 'video', 'synthetic-gps.mp4'); }
  if (process.env.SEED === 'clean') { seed(1, 'image', 'jpg', 'photo', 'synthetic-orientation-only.jpg'); }
  const log = process.stderr;
  const st = (v) => ({ stringValue: v });
  const sig1 = (p) => `s--${createHash('sha1').update(p + SECRET).digest('base64url').slice(0, 8)}--`;
  const uidOf = (h) => JSON.parse(Buffer.from((h.authorization ?? '').split(' ')[1].split('.')[1], 'base64url').toString()).sub;

  async function firestore(u, init) {
    const method = init.method ?? 'GET';
    const caller = uidOf(init.headers);
    const lm = /documents\/trips\/([^/?]+)\/memories\?pageSize=/.exec(u);
    if (lm) {
      if (!db.trips[lm[1]]?.memberIds.includes(caller)) return new Response('{}', { status: 403 });
      return Response.json({ documents: Object.entries(db.memories).filter(([k]) => k.startsWith(`${lm[1]}/`)).map(([, mem]) => ({ fields: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, st(v)])) })) });
    }
    const m = /documents\/trips\/([^/?]+)(?:\/memories\/([^/?]+))?(?:\?(.*))?$/.exec(u) ?? /documents\/trips\/([^/?]+)\/memories\?documentId=(.+)$/.exec(u);
    const tripId = m[1];
    const trip = db.trips[tripId];
    const member = trip?.memberIds.includes(caller) || (brk.includes('stranger-is-member') && caller === 'u-stranger' && !u.includes('/memories'));
    const isCreate = method === 'POST';
    const memId = isCreate ? decodeURIComponent(/documentId=([^&]+)/.exec(u)[1]) : m[2];
    if (!trip) return new Response('{}', { status: 404 });
    if (!memId) { // dokument podróży
      if (method === 'GET') return member ? Response.json({ fields: { memberIds: { arrayValue: { values: [...trip.memberIds, ...(member && !trip.memberIds.includes(caller) ? [caller] : [])].map(st) } }, createdBy: st(trip.createdBy) } }) : new Response('{}', { status: 403 });
      if (method === 'PATCH') { // wyjście z grupy
        if (!member) return new Response('{}', { status: 403 });
        const ids = JSON.parse(init.body).fields.memberIds.arrayValue.values?.map((v) => v.stringValue) ?? [];
        if (ids.includes(caller) || ids.some((i) => !trip.memberIds.includes(i))) return new Response('{}', { status: 403 });
        trip.memberIds = ids;
        return Response.json({});
      }
    }
    const key = `${tripId}/${memId}`;
    if (isCreate) {
      const f = Object.fromEntries(Object.entries(JSON.parse(init.body).fields).map(([k, v]) => [k, v.stringValue]));
      const ok = (member && f.createdBy === caller && new RegExp(`^wycieczka/${tripId}/[A-Za-z0-9_-]{8,64}$`).test(f.publicId ?? '') && ['image', 'video'].includes(f.resourceType) && !('url' in f))
        || brk.includes('open-rules');
      if (!ok) return new Response('{}', { status: 403 });
      db.memories[key] = f;
      return Response.json({});
    }
    const mem = db.memories[key];
    if (method === 'GET') return !member ? new Response('{}', { status: 403 }) : mem ? Response.json({ fields: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, st(v)])) }) : new Response('{}', { status: 404 });
    if (method === 'DELETE') {
      if (!member || !mem) return new Response('{}', { status: member ? 404 : 403 });
      if (mem.createdBy !== caller && trip.createdBy !== caller) return new Response('{}', { status: 403 });
      delete db.memories[key];
      return Response.json({});
    }
    return new Response('{}', { status: 400 });
  }

  function cloudinaryApi(u, init) {
    const f = init.body;
    const params = Object.fromEntries([...f.entries()].filter(([k]) => !['file', 'api_key', 'signature'].includes(k)));
    const good = createHash('sha1').update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + SECRET).digest('hex') === f.get('signature') && f.get('api_key') === APIKEY_CLD;
    if (!good) return Response.json({ error: { message: 'Invalid Signature' } }, { status: 401 });
    const [, res, act] = /v1_1\/demo-cloud\/(image|video)\/(upload|destroy)$/.exec(u);
    const k = `${params.type}/${res}/${params.public_id}`;
    if (act === 'destroy') { const had = k in assets; delete assets[k]; return Response.json({ result: had ? 'ok' : 'not found' }); }
    return f.get('file').arrayBuffer().then((ab) => { assets[k] = Buffer.from(ab); return Response.json({ type: params.type, public_id: params.public_id, resource_type: res, format: 'png' }); });
  }

  function delivery(u, init) {
    const m = /^https:\/\/res\.cloudinary\.com\/demo-cloud\/(image|video)\/(upload|authenticated)\/(.+)$/.exec(u);
    const [, res, type, rest] = m;
    if (type === 'upload') return new Response('', { status: 404 });
    const parts = rest.split('/');
    if (!parts[0].startsWith('s--')) return new Response(brk.includes('unsigned-ok') ? 'leak' : '', { status: brk.includes('unsigned-ok') ? 200 : 401 });
    const p = parts.slice(1).join('/');
    if (parts[0] !== sig1(p)) return new Response('', { status: 401 });
    const pid = p.replace(/^c_fill[^/]*\//, '').replace(/\.[a-z0-9]+$/, '');
    const data = assets[`authenticated/${res}/${pid}`];
    if (!data) return new Response('', { status: 404 });
    const r = init.headers?.range && /^bytes=(\d*)-(\d*)$/.exec(init.headers.range);
    if (r) {
      const suffix = r[1] === '' ? Number(r[2]) : 0;
      const a = suffix ? Math.max(0, data.length - suffix) : Number(r[1]), b = suffix || !r[2] ? data.length - 1 : Number(r[2]), sl = data.subarray(a, b + 1);
      return new Response(sl, { status: 206, headers: { 'content-type': 'image/png', 'content-range': `bytes ${a}-${b}/${data.length}`, 'content-length': String(sl.length) } });
    }
    return new Response(data, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(data.length) } });
  }

  if (process.env.FAKE_CLOCK) { // czekanie na wygaśnięcie tokenu bez realnego czekania: zegar skacze
    let skew = 0;
    const realNow = Date.now, realTimeout = globalThis.setTimeout;
    Date.now = () => realNow() + skew;
    globalThis.setTimeout = (fn, ms, ...a) => (ms > 1000 ? (skew += ms, realTimeout(fn, 0, ...a)) : realTimeout(fn, ms, ...a));
  }
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls++;
    if (u.startsWith('https://identitytoolkit.googleapis.com/')) {
      const { email, password } = JSON.parse(init.body);
      const usr = users[email];
      if (process.env.REQUIRE_ANDROID && (init.headers['X-Android-Package'] !== 'pl.wycieczka.wycieczka' || init.headers['X-Android-Cert'] !== 'AABBCC0011')) {
        return Response.json({ error: { message: 'API_KEY_ANDROID_APP_BLOCKED' } }, { status: 403 }); // klucz ograniczony do aplikacji Android
      }
      if (!usr || usr[1] !== password || !u.includes(`key=${FB_KEY}`)) return Response.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 });
      return Response.json({ idToken: await jwt(usr[0]), localId: usr[0] });
    }
    if (u.startsWith('https://w.example')) {
      if (brk.includes('net-error-token') && u.endsWith('/media/token')) throw new Error('network down');
      return worker.fetch(new Request(u, init), wenv);
    }
    if (u.includes('googleapis.com/service_accounts')) return Response.json({ keys: [jwk] });
    if (u.startsWith('https://firestore.googleapis.com/')) return firestore(u, init);
    if (u.startsWith('https://api.cloudinary.com/')) return cloudinaryApi(u, init);
    if (u.startsWith('https://res.cloudinary.com/')) return delivery(u, init);
    if (u.startsWith('https://api.maptiler.com/')) return new Response('{}', { status: u.includes('key=goodkey') ? 200 : 403 });
    throw new Error('unexpected fetch ' + u);
  };
  process.on('exit', () => log.write('WORLD ' + JSON.stringify({ calls, memories: Object.keys(db.memories), assets: Object.keys(assets), members: db.trips[TRIP].memberIds }) + '\n'));
  process.argv.splice(2, 4, ...process.argv.slice(6));
  await import(fileURLToPath(new URL(script === 'preflight' ? './e2e-preflight.mjs' : script === 'inspect' ? './e2e-inspect-media.mjs' : './e2e-api-check.mjs', import.meta.url)));
} else {
  const run = (script, args = [], env = {}, brk = '') => {
    const r = spawnSync(process.execPath, [here, 'child', 'x', script, 'x', ...args], {
      env: { PATH: process.env.PATH, BREAK: brk, REQUIRE_ANDROID: process.env.TEST_REQUIRE_ANDROID ?? '', WORKER_URL: 'https://w.example', FIREBASE_API_KEY: FB_KEY, FIREBASE_PROJECT_ID: 'proj', E2E_TRIP_ID: TRIP,
        E2E_MEMBER_EMAIL: 'member@test.invalid', E2E_MEMBER_PASSWORD: PW, E2E_STRANGER_EMAIL: 'stranger@test.invalid', E2E_STRANGER_PASSWORD: PW,
        E2E_MEMBER2_EMAIL: 'member2@test.invalid', E2E_MEMBER2_PASSWORD: PW, ...env },
      encoding: 'utf8',
    });
    const w = /^WORLD (.*)$/m.exec(r.stderr);
    return { code: r.status, out: r.stdout + r.stderr.replace(/^WORLD .*$/m, ''), world: w ? JSON.parse(w[1]) : null };
  };
  const noLeak = (out) => {
    for (const bad of [PW, FB_KEY, SECRET, APIKEY_CLD, 'media-secret-VALUE']) assert.ok(!out.includes(bad), `sekret w wyjściu: ${bad}`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(out), 'token JWT w wyjściu');
    assert.ok(!/https?:\/\//.test(out) && !/s--[A-Za-z0-9_-]{8}--/.test(out), 'adres lub podpis w wyjściu');
  };
  const API = ['--i-am-using-test-services'];

  // ---- e2e-api-check ----
  let r = run('api');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Próba na sucho/);
  assert.equal(r.world.calls, 0, 'na sucho żadne żądanie nie wychodzi');

  for (const [env, label] of [[{ PROD_WORKER_URL: 'https://w.example/' }, 'worker produkcyjny'], [{ PROD_FIREBASE_PROJECT_ID: 'proj' }, 'projekt produkcyjny'], [{ WORKER_URL: 'http://w.example' }, 'http'], [{ E2E_TRIP_ID: '../x' }, 'zły id']]) {
    r = run('api', API, env);
    assert.equal(r.code, 2, label);
    assert.equal(r.world.calls, 0, `${label}: zero żądań`);
  }
  r = run('api', API, { E2E_MEMBER_PASSWORD: '' });
  assert.equal(r.code, 2);

  r = run('api', API);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: PASS/);
  assert.ok((r.out.match(/^PASS /gm) || []).length >= 28, `liczba PASS: ${(r.out.match(/^PASS /gm) || []).length}`);
  assert.ok(!/^FAIL/m.test(r.out));
  noLeak(r.out);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []], 'po teście nic nie zostaje w bazie ani w Cloudinary');

  r = run('api', [...API, '--leave-test']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  po wyjściu: nowy token odmówiony/);
  assert.match(r.out, /INFO  po wyjściu stary token daje HTTP 200/);
  assert.ok(!r.world.members.includes('u-member2'), 'drugi członek faktycznie opuścił podróż');
  noLeak(r.out);

  // błędy konfiguracji są wykrywane, a sprzątanie i tak działa
  r = run('api', API, {}, 'unsigned-ok');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  Cloudinary: adres typu authenticated bez podpisu/);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []]);
  noLeak(r.out);
  r = run('api', API, {}, 'open-rules');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  Firestore: obcy nie dodaje wspomnienia/);
  assert.match(r.out, /reguły przyjęły \d+ wpisów/);
  assert.deepEqual(r.world.memories, [], 'wpisy przyjęte przez błędne reguły też są sprzątane');
  assert.deepEqual(r.world.assets, []);
  r = run('api', API, {}, 'no-media-secret');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  token mediów: członek/);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []]);
  // wyjątek w środku przebiegu (po utworzeniu wpisu): sprzątanie dalej usuwa plik i wpis
  r = run('api', API, {}, 'net-error-token');
  assert.equal(r.code, 1);
  assert.match(r.out, /BŁĄD:/);
  assert.match(r.out, /sprzątanie: wpis testowy usunięty/);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []], 'po wyjątku nic nie zostaje');
  noLeak(r.out);
  // worker, który wpuszcza obcego, jest wykrywany
  r = run('api', API, {}, 'stranger-is-member');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  \/sign: obcy dostaje odmowę/);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []]);
  r = run('api', API, { E2E_MEMBER_PASSWORD: 'zle-haslo' });
  assert.equal(r.code, 1);
  noLeak(r.out);
  assert.ok(!r.out.includes('zle-haslo'));

  // klucz API ograniczony do aplikacji Android: bez nagłówków logowanie jest odrzucane, z nagłówkami aplikacji działa
  const prevReq = process.env.TEST_REQUIRE_ANDROID;
  process.env.TEST_REQUIRE_ANDROID = '1';
  r = run('api', API);
  assert.equal(r.code, 1);
  assert.match(r.out, /BŁĄD: logowanie: HTTP 403 API_KEY_ANDROID_APP_BLOCKED/);
  assert.equal(r.world.calls, 1, 'nic poza jedną próbą logowania');
  r = run('api', API, { E2E_ANDROID_PACKAGE: 'pl.wycieczka.wycieczka', E2E_ANDROID_CERT_SHA1: 'aa:bb:cc:00:11' });
  assert.equal(r.code, 0, r.out);
  noLeak(r.out);
  r = run('api', API, { E2E_ANDROID_PACKAGE: 'inny.pakiet', E2E_ANDROID_CERT_SHA1: 'AABBCC0011' });
  assert.equal(r.code, 1);
  if (prevReq === undefined) delete process.env.TEST_REQUIRE_ANDROID; else process.env.TEST_REQUIRE_ANDROID = prevReq;

  // ---- rodzaje plików i wygaśnięcie tokenu ----
  for (const kind of ['video', 'audio']) {
    r = run('api', [...API, `--media=${kind}`]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /RESULT: PASS/);
    assert.match(r.out, /zakres ze środka pliku \(przewijanie\)/);
    assert.match(r.out, /zakres od końca/);
    assert.equal(/worker: miniatura/.test(r.out), kind === 'video', `miniatura tylko dla wideo (${kind})`);
    assert.deepEqual([r.world.memories, r.world.assets], [[], []], `${kind}: po teście nic nie zostaje`);
    noLeak(r.out);
  }
  assert.equal(run('api', [...API, '--media=gif']).code, 2);
  r = run('api', [...API, '--expiry-test'], { FAKE_CLOCK: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  wygaśnięcie: po końcu ważności stary token jest odrzucony/);
  assert.match(r.out, /PASS  wygaśnięcie: nowy token działa/);
  assert.deepEqual([r.world.memories, r.world.assets], [[], []]);
  r = run('api', ['--expiry-test']);
  assert.match(r.out, /wygaśnięcie tokenu mediów/, 'plan na sucho wymienia test wygaśnięcia');

  // ---- e2e-inspect-media ----
  r = run('inspect', API, { SEED: 'clean' });
  assert.equal(r.code, 0, r.out); assert.match(r.out, /PASS  photo #1/);
  r = run('inspect', API, { SEED: 'dirty' });
  assert.equal(r.code, 1, 'zdjęcie z GPS ma dać FAIL'); assert.match(r.out, /FAIL  photo #1.*GPSIFD|FAIL  photo #1.*Make/);
  assert.match(r.out, /FINDING  video #2/); noLeak(r.out);
  r = run('inspect', [...API, '--require-video-clean'], { SEED: 'dirty' });
  assert.match(r.out, /FAIL  video #2/);
  r = run('inspect', API);
  assert.equal(r.code, 1, 'brak plików to nie sukces');
  r = run('inspect', API, { PROD_FIREBASE_PROJECT_ID: 'proj', SEED: 'clean' });
  assert.equal(r.code, 2); assert.equal(r.world.calls, 0);
  r = run('inspect', []);
  assert.equal(r.code, 0); assert.equal(r.world.calls, 0, 'bez zgody nic nie wychodzi');

  // ---- e2e-preflight ----
  const pre = (env = {}, brk = '') => run('preflight', [], { MAPTILER_KEY: '', ...env }, brk);
  r = pre();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: PASS/);
  assert.match(r.out, /INFO  MAPTILER_KEY nie ustawiony/);
  assert.equal(pre({ MAPTILER_KEY: 'goodkey' }).code, 0);
  r = pre({ MAPTILER_KEY: 'badkey' });
  assert.equal(r.code, 1); assert.match(r.out, /FAIL  klucz MapTiler/); assert.ok(!r.out.includes('badkey'));
  r = pre({}, 'no-media-secret');
  assert.equal(r.code, 1); assert.match(r.out, /FAIL  \/media\/token bez tokenu/);
  r = pre({ PROD_WORKER_URL: 'https://w.example' });
  assert.equal(r.code, 2); assert.equal(r.world.calls, 0);
  assert.equal(pre({ WORKER_URL: 'http://w.example' }).code, 2);
  noLeak(pre().out);

  // pliki skryptów nie zapisują na dysk i nie zawierają zaszytych adresów ani kluczy
  for (const f of ['e2e-api-check.mjs', 'e2e-preflight.mjs', 'e2e-inspect-media.mjs']) {
    const t = fs.readFileSync(dir + f, 'utf8');
    assert.ok(!/writeFile|appendFile|createWriteStream/.test(t), `${f} nie zapisuje na dysk`);
    assert.ok(!new RegExp('AI' + 'za[0-9A-Za-z_-]{20}|workers' + '\\.dev').test(t), `${f} bez zaszytych kluczy i adresów`);
  }
  console.log('Skrypty e2e: wszystkie testy na atrapach przeszły');
}
