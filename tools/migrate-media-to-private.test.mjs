// Testy skryptu migracji na atrapach Firestore i Cloudinary: node tools/migrate-media-to-private.test.mjs
// Skrypt działa w procesie potomnym przeciw fałszywemu światu zapisanemu w pliku (stan przeżywa kolejne polecenia).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./migrate-media-to-private.mjs', import.meta.url));
const seedScript = fileURLToPath(new URL('./seed-synthetic-legacy-media.mjs', import.meta.url));
const SECRET = 'cld-secret-VALUE', KEY = '555111', TOKEN = 'gcloud-token-VALUE';

if (process.argv[2] === 'child') {
  // ---------------- atrapa świata ----------------
  const worldFile = process.env.WORLD_FILE;
  const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
  const save = () => fs.writeFileSync(worldFile, JSON.stringify(world));
  const log = (o) => { world.calls.push(o); save(); };
  const bytesOf = (b64) => Buffer.from(b64, 'base64');
  const sig1 = (p) => `s--${createHash('sha1').update(p + SECRET).digest('base64url').slice(0, 8)}--`;
  let uploads = 0;
  const fsName = (k) => `projects/p/databases/(default)/documents/trips/${k.split('/')[0]}/memories/${k.split('/')[1]}`;
  const toFields = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { stringValue: v }]));
  const res = (obj, status = 200) => Response.json(obj, { status });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith('https://firestore.googleapis.com/')) {
      if (init.headers.authorization !== `Bearer ${TOKEN}`) return res({}, 401);
      if (u.endsWith(':runQuery')) {
        log({ kind: 'runQuery' });
        return res(Object.entries(world.docs).map(([k, d]) => ({ document: { name: fsName(k), fields: toFields(d) } })));
      }
      if (method === 'GET' && /\/trips\/[^/?]+$/.test(u)) {
        const t = u.split('/trips/')[1];
        return world.trips?.[t] ? res({ name: `trips/${t}`, fields: {} }) : res({}, 404);
      }
      if (method === 'POST' && /\/trips\/[^/]+\/memories\?documentId=/.test(u)) {
        const [, t, docId] = /trips\/([^/]+)\/memories\?documentId=([^&]+)/.exec(u);
        const fields = Object.fromEntries(Object.entries(JSON.parse(init.body).fields).map(([k, v]) => [k, v.stringValue]));
        log({ kind: 'doc-create', key: `${t}/${docId}`, fields: Object.keys(fields).sort() });
        world.docs[`${t}/${docId}`] = fields; save();
        return res({});
      }
      if (method === 'DELETE') {
        const k = /trips\/([^/]+)\/memories\/([^/?]+)/.exec(u).slice(1, 3).join('/');
        log({ kind: 'doc-delete', key: k });
        delete world.docs[k]; save();
        return res({});
      }
      const key = /trips\/([^/]+)\/memories\/([^/?]+)/.exec(u).slice(1, 3).join('/');
      if (method === 'GET') return world.docs[key] ? res({ name: fsName(key), fields: toFields(world.docs[key]) }) : res({}, 404);
      if (method === 'PATCH') {
        if (!world.docs[key]) return res({}, 404);
        const mask = [...u.matchAll(/updateMask\.fieldPaths=([A-Za-z]+)/g)].map((m) => m[1]);
        const body = JSON.parse(init.body).fields ?? {};
        log({ kind: 'patch', key, set: Object.keys(body).sort(), removed: mask.filter((m) => !(m in body)).sort() });
        for (const m of mask) {
          if (m in body) world.docs[key][m] = body[m].stringValue;
          else delete world.docs[key][m];
        }
        save();
        return res({});
      }
    }
    let m = /^https:\/\/api\.cloudinary\.com\/v1_1\/demo-cloud\/(image|video)\/(upload|destroy)$/.exec(u);
    if (m) {
      const f = init.body;
      const params = Object.fromEntries([...f.entries()].filter(([k]) => !['file', 'api_key', 'signature'].includes(k)));
      const good = createHash('sha1').update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + SECRET).digest('hex') === f.get('signature') && f.get('api_key') === KEY;
      if (!good) return res({ error: { message: 'Invalid Signature' } }, 401);
      const akey = `${params.type}/${m[1]}/${params.public_id}`;
      if (m[2] === 'destroy') {
        log({ kind: 'destroy', asset: akey });
        if (!world.assets[akey]) return res({ result: 'not found' });
        delete world.assets[akey]; save();
        return res({ result: 'ok' });
      }
      uploads++;
      if (params.overwrite !== 'false') return res({ error: { message: 'overwrite must be false' } }, 400);
      if (process.env.MOCK_FAIL_UPLOAD_N && uploads === Number(process.env.MOCK_FAIL_UPLOAD_N)) throw new Error('network down');
      if (world.assets[akey]) return res({ error: { message: 'Resource already exists' } }, 400);
      const file = f.get('file');
      let data;
      if (typeof file === 'string') {
        const src = /\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/.exec(file)[1];
        const pub = world.assets[`upload/${m[1]}/${src}`];
        if (!pub) return res({ error: { message: 'Resource not found' } }, 400);
        data = pub;
      } else data = Buffer.from(await file.arrayBuffer()).toString('base64');
      log({ kind: 'upload', asset: akey, source: typeof file === 'string' ? 'url' : 'file', png: typeof file !== 'string' && data.startsWith('iVBORw0KGgo') });
      world.assets[akey] = data; save();
      return res({ type: params.type, public_id: params.public_id, resource_type: m[1], format: 'x',
        secure_url: `https://res.cloudinary.com/demo-cloud/${m[1]}/${params.type}/v1700000000/${params.public_id}.png` });
    }
    m = /^https:\/\/res\.cloudinary\.com\/demo-cloud\/(image|video)\/(upload|authenticated)\/(.+)$/.exec(u);
    if (m) {
      const [, resource, type, rest] = m;
      if (type === 'upload') {
        const pid = /^(?:v\d+\/)?(.+)\.[a-z0-9]+$/.exec(rest)[1];
        const a = world.assets[`upload/${resource}/${pid}`];
        return a ? new Response(bytesOf(a), { status: 200, headers: { 'content-length': String(bytesOf(a).length) } }) : new Response('', { status: 404 });
      }
      const parts = rest.split('/');
      if (!parts[0].startsWith('s--')) return new Response(process.env.MOCK_UNSIGNED_OK ? 'leak' : '', { status: process.env.MOCK_UNSIGNED_OK ? 200 : 401 });
      const p = parts.slice(1).join('/');
      if (parts[0] !== sig1(p)) return new Response('', { status: 401 });
      const pid = p.replace(/\.[a-z0-9]+$/, '');
      const a = world.assets[`authenticated/${resource}/${pid}`];
      if (!a) return new Response('', { status: 404 });
      const out = process.env.MOCK_CORRUPT && pid.includes(process.env.MOCK_CORRUPT) ? Buffer.from('CORRUPTED') : bytesOf(a);
      return new Response(out, { status: 200 });
    }
    throw new Error('unexpected fetch ' + u);
  };
  process.argv.splice(2, 2, ...process.argv.slice(4)); // [child, <world>] -> argumenty skryptu
  await import(process.env.SCRIPT === 'seed' ? seedScript : script);
} else {
  // ---------------- test ----------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewatlas-migr-'));
  const mk = (b) => Buffer.from(b).toString('base64');
  const pubUrl = (res, pid, ext) => `https://res.cloudinary.com/demo-cloud/${res}/upload/v1700000000/${pid}.${ext}`;
  const freshWorld = () => ({
    calls: [],
    docs: {
      'T1/m1': { url: pubUrl('image', 'wycieczka/T1/abcdefgh12', 'jpg'), createdBy: 'u1', type: 'photo' },
      'T1/m2': { url: pubUrl('video', 'wycieczka/T1/vvvvvvvv22', 'mp4'), createdBy: 'u1', type: 'video' },
      'T2/m3': { url: pubUrl('image', 'wycieczka/T2/cccccccc33', 'jpeg'), createdBy: 'u2', type: 'photo' },
      'T1/m4': { publicId: 'wycieczka/T1/already4444', resourceType: 'image', format: 'jpg', createdBy: 'u1' },
      'T1/m5': { createdBy: 'u1', type: 'photo' },
      'T1/m6': { url: pubUrl('image', 'wycieczka/T2/foreign9999', 'jpg'), createdBy: 'u1' },
      'T1/m7': { url: 'https://res.cloudinary.com/other-cloud/image/upload/v1/wycieczka/T1/otherother', createdBy: 'u1' },
    },
    assets: {
      'upload/image/wycieczka/T1/abcdefgh12': mk('image-bytes-1'),
      'upload/video/wycieczka/T1/vvvvvvvv22': mk('video-bytes-2-'.repeat(50)),
      'upload/image/wycieczka/T2/cccccccc33': mk('image-bytes-3'),
      'authenticated/image/wycieczka/T1/already4444': mk('private-already'),
    },
  });
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(tmp, 's-'));
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(freshWorld()));
    return dir;
  };
  const run = (dir, cmd, extra = [], env = {}) => {
    const r = spawnSync(process.execPath, [here, 'child', path.join(dir, 'world.json'), cmd, '--state', path.join(dir, 'state.json'), '--backup-dir', path.join(dir, 'backup'), ...extra], {
      env: { PATH: process.env.PATH, WORLD_FILE: path.join(dir, 'world.json'), CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: KEY,
        CLOUDINARY_API_SECRET: SECRET, FIREBASE_PROJECT_ID: 'p', GCLOUD_ACCESS_TOKEN: TOKEN, ...env }, encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr, world: JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')) };
  };
  const noLeak = (out) => {
    for (const bad of [SECRET, KEY, TOKEN]) assert.ok(!out.includes(bad), 'sekret w wyjściu');
    assert.ok(!/https?:\/\//.test(out), 'adres w wyjściu');
    assert.ok(!/s--[A-Za-z0-9_-]{8}--/.test(out), 'podpis w wyjściu');
  };
  const mutating = (w) => w.calls.filter((c) => ['upload', 'destroy', 'patch'].includes(c.kind));
  const A = ['--apply'];
  const pipeline = (dir, env) => ['plan', 'backup', 'copy', 'link', 'verify'].map((c) => run(dir, c, A, env));

  // 1. plan na sucho: tylko odczyt, nic nie zapisuje
  let d = setup();
  let r = run(d, 'plan');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Do migracji: 3\. Pominięte: 2\./);
  assert.match(r.out, /pominięto T1\/m6: public_id poza folderem tej podróży/);
  assert.match(r.out, /pominięto T1\/m7: adres nie pasuje do tego konta/);
  assert.ok(!r.out.includes('T1/m4') && !r.out.includes('T1/m5'), 'już prywatny wpis i wpis bez pliku są pomijane po cichu');
  assert.equal(mutating(r.world).length, 0);
  assert.ok(!fs.existsSync(path.join(d, 'state.json')), 'dry-run nie tworzy pliku stanu');
  noLeak(r.out);

  // 2. komendy bez stanu odmawiają, bez --apply nic się nie zmienia
  r = run(d, 'backup', A); assert.equal(r.code, 2);
  run(d, 'plan', A);
  for (const c of ['backup', 'copy', 'link', 'finalize', 'rollback', 'restore']) {
    r = run(d, c);
    assert.equal(mutating(r.world).length, 0, `${c} na sucho nic nie zmienia`);
    assert.ok(!fs.existsSync(path.join(d, 'backup')), `${c} na sucho nie pobiera plików`);
  }
  assert.match(run(d, 'backup').out, /\[dry-run\] backup: T1\/m1/);

  // 3. pełna ścieżka: backup, copy, link, verify, finalize
  d = setup();
  for (const x of pipeline(d)) { assert.equal(x.code, 0, x.out); noLeak(x.out); }
  r = run(d, 'status'); assert.match(r.out, /wpisów 3: backup 3, copy 3, link 3, verified 3, publiczne usunięte 0/);
  const orig = fs.readFileSync(path.join(d, 'backup', 'T1', 'm1.jpg'));
  assert.equal(orig.toString(), 'image-bytes-1', 'kopia zapasowa ma oryginalne bajty');
  assert.ok(fs.existsSync(path.join(d, 'backup', 'T1', 'm1.doc.json')));
  let st = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  assert.equal(st.items['T1/m1'].sha256, createHash('sha256').update('image-bytes-1').digest('hex'));
  r = run(d, 'finalize', A);
  assert.equal(r.code, 1, 'bez --yes-delete-public odmowa');
  assert.match(r.out, /--yes-delete-public/);
  assert.equal(Object.keys(r.world.assets).filter((k) => k.startsWith('upload/')).length, 3, 'publiczne pliki nietknięte');
  r = run(d, 'finalize', [...A, '--yes-delete-public']);
  assert.equal(r.code, 0, r.out);
  noLeak(r.out);
  assert.deepEqual(Object.keys(r.world.assets).sort(), [
    'authenticated/image/wycieczka/T1/abcdefgh12', 'authenticated/image/wycieczka/T1/already4444', 'authenticated/image/wycieczka/T2/cccccccc33',
    'authenticated/video/wycieczka/T1/vvvvvvvv22']);
  assert.equal(r.world.docs['T1/m1'].url, undefined);
  assert.equal(r.world.docs['T1/m1'].publicId, 'wycieczka/T1/abcdefgh12');
  assert.equal(r.world.docs['T2/m3'].format, 'jpg', 'jpeg normalizowane do jpg');
  assert.ok(r.world.docs['T1/m6'].url && r.world.docs['T1/m7'].url, 'pominięte wpisy nietknięte');
  assert.equal(r.world.docs['T1/m4'].publicId, 'wycieczka/T1/already4444');
  // wywołania mutujące to tylko oczekiwane typy i tylko dla wpisów z planu
  for (const c of mutating(r.world)) {
    const t = c.asset ?? c.key;
    assert.ok(/abcdefgh12|vvvvvvvv22|cccccccc33|T1\/m1|T1\/m2|T2\/m3/.test(t), `nieoczekiwane wywołanie ${JSON.stringify(c)}`);
  }
  // ponowne uruchomienie wszystkiego jest idempotentne
  const before = mutating(r.world).length;
  for (const c of ['backup', 'copy', 'link']) assert.equal(run(d, c, A).code, 0);
  assert.equal(mutating(run(d, 'status').world).length, before, 'nic nie zrobiono drugi raz');

  // 4. wznowienie po błędzie: padnie drugi upload, ponowne uruchomienie kończy bez duplikatów
  d = setup();
  run(d, 'plan', A); run(d, 'backup', A);
  r = run(d, 'copy', A, { MOCK_FAIL_UPLOAD_N: '2' });
  assert.equal(r.code, 1);
  assert.match(r.out, /BŁĄD: T1\/m2/);
  assert.equal(r.world.calls.filter((c) => c.kind === 'upload').length, 2, 'dwa wpisy zdążyły, jeden (T1/m2) nie, skrypt idzie dalej mimo błędu');
  noLeak(r.out);
  r = run(d, 'copy', A);
  assert.equal(r.code, 0, r.out);
  const ups = r.world.calls.filter((c) => c.kind === 'upload').map((c) => c.asset);
  assert.equal(new Set(ups).size, 3, 'trzy różne zasoby');
  assert.equal(ups.length, 3, 'wznowienie wysłało tylko brakujący zasób, żaden dwa razy');
  // przerwanie po uploadzie, a przed zapisem stanu: ponowny upload dostaje "already exists" i traktuje to jako zrobione
  const s2 = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  s2.items['T1/m1'].copied = false;
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(s2));
  assert.equal(run(d, 'copy', A).code, 0, 'already exists nie jest błędem');

  // 5. niezgodność bajtów blokuje finalize i nic nie usuwa
  d = setup();
  const x = ['plan', 'backup', 'copy', 'link'].map((c) => run(d, c, A));
  r = run(d, 'verify', A, { MOCK_CORRUPT: 'vvvvvvvv22' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: T1\/m2 \(bajty różnią się od kopii zapasowej\)/);
  assert.match(r.out, /PASS: T1\/m1/);
  r = run(d, 'finalize', [...A, '--yes-delete-public']);
  assert.equal(r.code, 1);
  assert.match(r.out, /finalize ODMOWA: 1 wpisów nie przeszło verify/);
  assert.equal(Object.keys(r.world.assets).filter((k) => k.startsWith('upload/')).length, 3, 'żaden publiczny plik nie został usunięty');
  assert.ok(r.world.docs['T1/m2'].url, 'url zostaje');

  // 6. dokument bez pól po linkowaniu nie przechodzi verify
  d = setup();
  ['plan', 'backup', 'copy'].forEach((c) => run(d, c, A)); // bez link
  const s3 = JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'));
  for (const it of Object.values(s3.items)) it.linked = true; // stan twierdzi, że zlinkowane, dokument nie
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(s3));
  r = run(d, 'verify', A);
  assert.equal(r.code, 1); assert.match(r.out, /dokument nie ma poprawnych pól/);

  // 7. rollback przed finalize: prywatne kopie i pola znikają, publiczne pliki i url nietknięte
  d = setup();
  pipeline(d);
  r = run(d, 'rollback', A);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(r.world.assets).filter((k) => k.startsWith('authenticated/')), ['authenticated/image/wycieczka/T1/already4444'], 'tylko cudza prywatna kopia została');
  assert.equal(Object.keys(r.world.assets).filter((k) => k.startsWith('upload/')).length, 3);
  assert.ok(r.world.docs['T1/m1'].url && r.world.docs['T1/m1'].publicId === undefined && r.world.docs['T1/m1'].format === undefined);
  assert.equal(r.world.docs['T1/m4'].publicId, 'wycieczka/T1/already4444', 'wpis spoza planu nietknięty');
  assert.ok(!r.world.calls.some((c) => c.kind === 'destroy' && c.asset.includes('already4444')), 'cudzy zasób nie jest usuwany');

  // 8. po finalize rollback jest odmowny, a restore odtwarza publiczne pliki i url z kopii lokalnej
  d = setup();
  pipeline(d);
  run(d, 'finalize', [...A, '--yes-delete-public']);
  r = run(d, 'rollback', A);
  assert.match(r.out, /rollback: 0 z 3/, 'po finalize nie ma czego cofać rollbackiem');
  r = run(d, 'restore', A);
  assert.equal(r.code, 0, r.out);
  assert.equal(Object.keys(r.world.assets).filter((k) => k.startsWith('upload/')).length, 3);
  assert.equal(r.world.docs['T1/m1'].url, pubUrl('image', 'wycieczka/T1/abcdefgh12', 'jpg'));
  assert.equal(Buffer.from(r.world.assets['upload/image/wycieczka/T1/abcdefgh12'], 'base64').toString(), 'image-bytes-1', 'bajty z kopii zapasowej');
  // zmieniona kopia lokalna nie zostanie wgrana
  d = setup();
  pipeline(d);
  run(d, 'finalize', [...A, '--yes-delete-public']);
  fs.writeFileSync(path.join(d, 'backup', 'T1', 'm1.jpg'), 'tampered');
  r = run(d, 'restore', A);
  assert.equal(r.code, 1);
  assert.match(r.out, /kopia lokalna nie zgadza się/);

  // 5b. publicznie dostępny adres bez podpisu (np. zły typ) nie przechodzi verify
  d = setup();
  ['plan', 'backup', 'copy', 'link'].forEach((c) => run(d, c, A));
  r = run(d, 'verify', A, { MOCK_UNSIGNED_OK: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: T1\/m1 \(adres bez podpisu: HTTP 200\)/);
  r = run(d, 'finalize', [...A, '--yes-delete-public']);
  assert.equal(r.code, 1, 'finalize odmawia');

  // 5c. copy bez kopii zapasowej nic nie wysyła
  d = setup();
  run(d, 'plan', A);
  r = run(d, 'copy', A);
  assert.match(r.out, /copy: 0 z 3/);
  assert.equal(r.world.calls.filter((c) => c.kind === 'upload').length, 0);

  // 10. lokalizacja kopii: odmowa w repozytorium, projekcie i folderach synchronizowanych, uprawnienia 600/700
  d = setup();
  const runIn = (backupDir, extra = []) => {
    const r2 = spawnSync(process.execPath, [here, 'child', path.join(d, 'world.json'), 'plan', '--apply', '--backup-dir', backupDir, ...extra], {
      env: { PATH: process.env.PATH, WORLD_FILE: path.join(d, 'world.json'), CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: KEY,
        CLOUDINARY_API_SECRET: SECRET, FIREBASE_PROJECT_ID: 'p', GCLOUD_ACCESS_TOKEN: TOKEN }, encoding: 'utf8' });
    return { code: r2.status, out: r2.stdout + r2.stderr };
  };
  const unsafe = {
    syncthing: ['sync-root/.stfolder', 'sync-root/photos/backup'],
    git: ['repo/.git', 'repo/out'],
    flutterProject: ['proj/pubspec.yaml', 'proj/backup'],
    firebaseProject: ['fb/firebase.json', 'fb/x'],
    dropboxMarker: ['db/.dropbox', 'db/backup'],
  };
  for (const [label, [marker, target]] of Object.entries(unsafe)) {
    const base = fs.mkdtempSync(path.join(tmp, 'u-'));
    fs.mkdirSync(path.dirname(path.join(base, marker)), { recursive: true });
    fs.writeFileSync(path.join(base, marker), '');
    const rr = runIn(path.join(base, target));
    assert.equal(rr.code, 2, `${label}: odmowa`);
    assert.match(rr.out, /ODMOWA: Katalog kopii leży w/);
    assert.ok(!fs.existsSync(path.join(base, target)), `${label}: nic nie utworzono w niebezpiecznym miejscu`);
  }
  const named = fs.mkdtempSync(path.join(tmp, 'u-'));
  fs.mkdirSync(path.join(named, 'Dropbox', 'backup'), { recursive: true });
  assert.equal(runIn(path.join(named, 'Dropbox', 'backup')).code, 2, 'folder o nazwie Dropbox');
  const stateInUnsafe = runIn(path.join(tmp, 'ok-backup'), ['--state', path.join(named, 'Dropbox', 'state.json')]);
  assert.equal(stateInUnsafe.code, 2);
  assert.match(stateInUnsafe.out, /Plik stanu leży w/);
  const forced = fs.mkdtempSync(path.join(tmp, 'u-'));
  fs.mkdirSync(path.join(forced, 'repo'), { recursive: true }); fs.mkdirSync(path.join(forced, 'repo', '.git'));
  assert.equal(runIn(path.join(forced, 'repo', 'b'), ['--allow-unsafe-location']).code, 0, 'świadome obejście działa');
  const cleanCwd = fs.mkdtempSync(path.join(tmp, 'cwd-')); // katalog bez znaczników, żeby odmowa nie wynikała z lokalizacji
  r = spawnSync(process.execPath, [here, 'child', path.join(d, 'world.json'), 'plan'], { cwd: cleanCwd, env: { PATH: process.env.PATH, WORLD_FILE: path.join(d, 'world.json'), CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: KEY,
    CLOUDINARY_API_SECRET: SECRET, FIREBASE_PROJECT_ID: 'p', GCLOUD_ACCESS_TOKEN: TOKEN }, encoding: 'utf8' });
  assert.equal(r.status, 2, 'bez --backup-dir: odmowa');
  assert.match(r.stderr, /Podaj --backup-dir/);
  assert.deepEqual(fs.readdirSync(cleanCwd), [], 'nic nie utworzono w bieżącym katalogu');

  d = setup();
  pipeline(d);
  const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
  assert.equal(mode(path.join(d, 'state.json')), '600');
  assert.equal(mode(path.join(d, 'backup', 'T1', 'm1.jpg')), '600');
  assert.equal(mode(path.join(d, 'backup', 'T1', 'm1.doc.json')), '600');
  assert.equal(mode(path.join(d, 'backup', 'T1')), '700');

  // 11. kopia zapasowa zmieniona po backupie: copy odmawia, finalize odmawia, nic nie jest kasowane
  d = setup();
  run(d, 'plan', A); run(d, 'backup', A);
  fs.writeFileSync(path.join(d, 'backup', 'T1', 'm1.jpg'), 'zmieniony');
  r = run(d, 'copy', A);
  assert.equal(r.code, 1);
  assert.match(r.out, /BŁĄD: T1\/m1: kopia zapasowa uszkodzona lub jej brak/);
  assert.equal(r.world.calls.filter((c) => c.kind === 'upload' && c.asset.includes('abcdefgh12')).length, 0, 'uszkodzonej kopii nie kopiujemy');
  assert.equal(r.world.calls.filter((c) => c.kind === 'upload').length, 2, 'pozostałe wpisy skopiowane');

  d = setup();
  pipeline(d);
  fs.rmSync(path.join(d, 'backup', 'T2', 'm3.jpeg'), { force: true });
  fs.rmSync(path.join(d, 'backup', 'T2', 'm3.jpg'), { force: true });
  r = run(d, 'finalize', [...A, '--yes-delete-public']);
  assert.equal(r.code, 1);
  assert.match(r.out, /finalize ODMOWA: 1 wpisów nie ma kompletnej kopii zapasowej \(T2\/m3\)/);
  assert.equal(r.world.calls.filter((c) => c.kind === 'destroy').length, 0, 'nic nie skasowano');
  assert.equal(Object.keys(r.world.assets).filter((k) => k.startsWith('upload/')).length, 3);

  // 12. wspomnienie usunięte w trakcie migracji
  d = setup();
  run(d, 'plan', A); run(d, 'backup', A); run(d, 'copy', A);
  const edit = (fn) => { const w = JSON.parse(fs.readFileSync(path.join(d, 'world.json'), 'utf8')); fn(w); fs.writeFileSync(path.join(d, 'world.json'), JSON.stringify(w)); };
  edit((w) => delete w.docs['T1/m1']); // użytkownik usuwa wpis po skopiowaniu, przed powiązaniem
  r = run(d, 'link', A);
  assert.equal(r.code, 0, r.out);
  assert.ok(!('authenticated/image/wycieczka/T1/abcdefgh12' in r.world.assets), 'prywatna kopia bez wpisu została posprzątana');
  assert.ok('upload/image/wycieczka/T1/abcdefgh12' in r.world.assets, 'publiczny oryginał nietknięty');
  assert.match(run(d, 'status').out, /usunięte w międzyczasie 1/);
  for (const c of ['verify', 'finalize']) r = run(d, c, c === 'finalize' ? [...A, '--yes-delete-public'] : A);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.world.docs['T1/m2'].url, undefined);
  // usunięty przed backupem: oznaczony, nie pobierany
  d = setup();
  run(d, 'plan', A);
  edit((w) => delete w.docs['T2/m3']);
  r = run(d, 'backup', A);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(d, 'backup', 'T2')), 'nic nie pobrano dla usuniętego wpisu');
  // rollback gdy dokument zniknął
  d = setup();
  pipeline(d);
  edit((w) => delete w.docs['T1/m1']);
  r = run(d, 'rollback', A);
  assert.equal(r.code, 0, r.out);
  assert.ok(!('authenticated/image/wycieczka/T1/abcdefgh12' in r.world.assets));

  // 13. próba generalna: seed syntetycznych wspomnień, migracja ich, cleanup
  const seedWorld = () => { const dd = fs.mkdtempSync(path.join(tmp, 'seed-')); fs.writeFileSync(path.join(dd, 'world.json'), JSON.stringify({ calls: [], trips: { TST1: true }, docs: {}, assets: {} })); return dd; };
  const runSeed = (dd, args2, env = {}) => {
    const r2 = spawnSync(process.execPath, [here, 'child', path.join(dd, 'world.json'), ...args2], {
      env: { PATH: process.env.PATH, SCRIPT: 'seed', WORLD_FILE: path.join(dd, 'world.json'), CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: KEY,
        CLOUDINARY_API_SECRET: SECRET, FIREBASE_PROJECT_ID: 'p', GCLOUD_ACCESS_TOKEN: TOKEN, ...env }, encoding: 'utf8' });
    return { code: r2.status, out: r2.stdout + r2.stderr, world: JSON.parse(fs.readFileSync(path.join(dd, 'world.json'), 'utf8')) };
  };
  d = seedWorld();
  const bdir = path.join(d, 'out');
  r = runSeed(d, ['seed', '--trip', 'TST1', '--backup-dir', bdir]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /\[dry-run\]/); assert.equal(mutating(r.world).length + r.world.calls.filter((c) => c.kind === 'doc-create').length, 0, 'dry-run nic nie tworzy');
  r = runSeed(d, ['seed', '--trip', 'TST1', '--backup-dir', bdir, '--apply']);
  assert.equal(r.code, 2, 'bez potwierdzenia, że to projekt testowy: odmowa'); assert.equal(r.world.calls.filter((c) => c.kind === 'upload').length, 0);
  r = runSeed(d, ['seed', '--trip', 'NOPE', '--backup-dir', bdir, '--apply', '--i-am-using-a-test-project']);
  assert.equal(r.code, 1, 'nieistniejąca podróż'); assert.equal(r.world.calls.filter((c) => c.kind === 'upload').length, 0);
  r = runSeed(d, ['seed', '--trip', 'TST1', '--backup-dir', bdir, '--count', '3', '--apply', '--i-am-using-a-test-project']);
  assert.equal(r.code, 0, r.out); noLeak(r.out);
  const seeded = r.world.calls.filter((c) => c.kind === 'upload');
  assert.equal(seeded.length, 3);
  assert.ok(seeded.every((c) => c.asset.startsWith('upload/image/wycieczka/TST1/') && c.png), 'publiczne syntetyczne PNG w folderze testowej podróży');
  assert.deepEqual(Object.values(r.world.docs).map((x) => Object.keys(x).sort().join()), Array(3).fill('createdBy,description,placeId,type,url'));
  assert.ok(Object.keys(r.world.docs).every((k) => /^TST1\/seed[0-9a-f]{16}$/.test(k)));
  assert.equal(mode(path.join(bdir, 'seed-state.json')), '600');
  // migracja zasianych wpisów od początku do końca
  const mdir = path.join(d, 'migr');
  const mig = (c, extra = A) => spawnSync(process.execPath, [here, 'child', path.join(d, 'world.json'), c, '--state', path.join(mdir, 'state.json'), '--backup-dir', mdir, ...extra], {
    env: { PATH: process.env.PATH, WORLD_FILE: path.join(d, 'world.json'), CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: KEY, CLOUDINARY_API_SECRET: SECRET,
      FIREBASE_PROJECT_ID: 'p', GCLOUD_ACCESS_TOKEN: TOKEN }, encoding: 'utf8' });
  r = mig('plan'); assert.match(r.stdout, /Do migracji: 3\./);
  for (const c of ['plan', 'backup', 'copy', 'link', 'verify']) assert.equal(mig(c).status, 0, c);
  assert.equal(mig('finalize', [...A, '--yes-delete-public']).status, 0);
  let w2 = JSON.parse(fs.readFileSync(path.join(d, 'world.json'), 'utf8'));
  assert.equal(Object.keys(w2.assets).filter((k) => k.startsWith('authenticated/')).length, 3);
  assert.equal(Object.keys(w2.assets).filter((k) => k.startsWith('upload/')).length, 0);
  assert.ok(Object.values(w2.docs).every((x) => x.publicId && !x.url));
  // cleanup: na sucho nic nie zmienia, potem usuwa dokładnie zasiane wpisy i pliki (oba typy)
  r = runSeed(d, ['cleanup', '--backup-dir', bdir]);
  assert.match(r.out, /\[dry-run\] usuwam/); assert.equal(Object.keys(r.world.docs).length, 3);
  r = runSeed(d, ['cleanup', '--backup-dir', bdir, '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.world.docs, {}); assert.deepEqual(r.world.assets, {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(bdir, 'seed-state.json'), 'utf8')).created.length, 0);
  // cleanup nie rusza cudzych wpisów: dopisany ręcznie dokument i plik zostają
  d = seedWorld();
  r = runSeed(d, ['seed', '--trip', 'TST1', '--backup-dir', path.join(d, 'o'), '--count', '1', '--apply', '--i-am-using-a-test-project']);
  const foreign = JSON.parse(fs.readFileSync(path.join(d, 'world.json'), 'utf8'));
  foreign.docs['TST1/realmemory'] = { url: 'x', createdBy: 'u' }; foreign.assets['upload/image/wycieczka/TST1/real-real-real'] = mk('real');
  fs.writeFileSync(path.join(d, 'world.json'), JSON.stringify(foreign));
  r = runSeed(d, ['cleanup', '--backup-dir', path.join(d, 'o'), '--apply']);
  assert.deepEqual(Object.keys(r.world.docs), ['TST1/realmemory']); assert.deepEqual(Object.keys(r.world.assets), ['upload/image/wycieczka/TST1/real-real-real']);
  // niebezpieczny katalog stanu
  const sy = fs.mkdtempSync(path.join(tmp, 'sy-')); fs.mkdirSync(path.join(sy, '.stfolder'));
  r = runSeed(d, ['seed', '--trip', 'TST1', '--backup-dir', path.join(sy, 'x')]);
  assert.equal(r.code, 2); assert.match(r.out, /ODMOWA/);

  // 9. brak środowiska
  const bare = spawnSync(process.execPath, [script, 'plan'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(bare.status, 2);
  console.log('Skrypt migracji: wszystkie testy na atrapach przeszły');
}
