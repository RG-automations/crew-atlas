// node tools/e2e-cleanup-cloudinary.test.mjs : atrapy Firebase i Cloudinary Admin API, bez sieci i bez zapisu na dysk
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./e2e-cleanup-cloudinary.mjs', import.meta.url));
const SECRET = 'cld-secret-VALUE', PW = 'Pass-VALUE-123', FBKEY = 'fb-key-VALUE', T = 'TESTTRIP1';
const A = `wycieczka/${T}/imgfile0001`, V = `wycieczka/${T}/vidfile0001`;

if (process.argv[2] === 'child') {
  const now = Date.now();
  const iso = (min) => new Date(now - min * 60000).toISOString();
  const world = { assets: { [`image/${A}`]: { created_at: iso(5), type: 'authenticated' }, [`video/${V}`]: { created_at: iso(3), type: 'authenticated' },
    'image/wycieczka/OTHER/prodfile0001': { created_at: iso(60 * 24 * 90), type: 'authenticated' } }, deleted: [], calls: [] };
  if (process.env.OLD) world.assets[`image/${A}`].created_at = iso(60 * 24 * 30);
  if (process.env.UPLOADTYPE) world.assets[`image/${A}`].type = 'upload';
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    world.calls.push(`${init.method ?? 'GET'} ${u.hostname}`);
    if (u.hostname === 'identitytoolkit.googleapis.com') return Response.json({ idToken: 'tok' });
    if (u.hostname === 'firestore.googleapis.com') {
      return Response.json({ documents: [
        { fields: { publicId: { stringValue: A }, resourceType: { stringValue: 'image' } } },
        { fields: { publicId: { stringValue: V }, resourceType: { stringValue: 'video' } } },
        { fields: { publicId: { stringValue: 'wycieczka/OTHER/prodfile0001' }, resourceType: { stringValue: 'image' } } }, // cudzy folder: nie trafia do manifestu
        { fields: { url: { stringValue: 'https://legacy.example/x.jpg' } } },
      ] });
    }
    assert.equal(u.hostname, 'api.cloudinary.com', 'żadnego innego hosta');
    assert.ok(init.headers.authorization.startsWith('Basic '));
    const parts = u.pathname.split('/').slice(3); // resources, rt, type, ...id
    if (init.method === 'DELETE') {
      assert.equal(parts.length, 3, 'usuwanie po dokładnych public_ids, nie po prefiksie');
      assert.equal(u.searchParams.has('prefix'), false);
      const ids = u.searchParams.getAll('public_ids[]');
      for (const i of ids) { assert.ok(i === A || i === V, 'usuwany tylko identyfikator z manifestu'); world.deleted.push(i); }
      return Response.json({ deleted: {} });
    }
    assert.equal(parts.length > 3, true, 'bez listowania folderów: tylko pojedyncze zasoby');
    const key = `${parts[1]}/${decodeURIComponent(parts.slice(3).join('/'))}`;
    const a = world.assets[key];
    if (!a) return new Response('{}', { status: 404 });
    return Response.json({ public_id: decodeURIComponent(parts.slice(3).join('/')), resource_type: parts[1], type: a.type, created_at: a.created_at });
  };
  process.on('exit', () => process.stderr.write(`WORLD ${JSON.stringify({ deleted: world.deleted, calls: world.calls.length, hosts: world.calls })}\n`));
  process.argv.splice(2, 1);
  await import(script);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  const since = new Date(Date.now() - 3600_000).toISOString();
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [here, 'child', ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    const w = /^WORLD (.*)$/m.exec(r.stderr);
    return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr.replace(/^WORLD .*$/m, ''), world: w ? JSON.parse(w[1]) : null };
  };
  const FB = { FIREBASE_API_KEY: FBKEY, FIREBASE_PROJECT_ID: 'crewatlas-test', E2E_TRIP_ID: T, E2E_MEMBER_EMAIL: 'm@test.invalid', E2E_MEMBER_PASSWORD: PW };
  const CL = { CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: 'k123', CLOUDINARY_API_SECRET: SECRET };
  const noLeak = (x) => { for (const s of [SECRET, PW, FBKEY, A, V]) assert.ok(!x.includes(s), `wyciek: ${s.slice(0, 6)}…`); assert.ok(!/https?:\/\//.test(x)); };

  // --- manifest ---
  let r = run(['manifest', '--since', since], FB);
  assert.equal(r.code, 2, 'bez --i-am-using-test-services odmowa'); assert.equal(r.world.calls, 0);
  r = run(['manifest', '--i-am-using-test-services', '--since', since], { ...FB, PROD_FIREBASE_PROJECT_ID: 'crewatlas-test' });
  assert.equal(r.code, 2); assert.equal(r.world.calls, 0, 'projekt produkcyjny: zero żądań');
  assert.equal(run(['manifest', '--i-am-using-test-services', '--since', since], { ...FB, PROD_TRIP_IDS: `X,${T}` }).code, 2);
  assert.equal(run(['manifest', '--i-am-using-test-services'], FB).code, 2, 'bez --since odmowa');
  assert.equal(run(['manifest', '--i-am-using-test-services', '--since', since, '--add-id', 'image:wycieczka/OTHER/zzzzzzzz1'], FB).code, 2, 'cudzy folder w --add-id');
  r = run(['manifest', '--i-am-using-test-services', '--since', since], FB);
  assert.equal(r.code, 0, r.out);
  const man = JSON.parse(r.stdout);
  assert.deepEqual(man.resources.map((x) => x.id).sort(), [A, V].sort(), 'tylko pliki tej podróży');
  assert.equal(man.firebaseProject, 'crewatlas-test');
  noLeak(r.out.replace(r.stdout, ''));
  const mf = path.join(dir, 'manifest.json');
  fs.writeFileSync(mf, r.stdout);
  const okArgs = ['delete', '--manifest', mf, '--confirm-cloud', 'demo-cloud', '--confirm-project', 'crewatlas-test'];

  // --- delete: domyślnie na sucho ---
  r = run(okArgs, CL);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /do usunięcia: 2 plików/); assert.deepEqual(r.world.deleted, []); noLeak(r.out);
  r = run([...okArgs, '--delete'], CL);
  assert.equal(r.code, 0, r.out); assert.deepEqual(r.world.deleted.sort(), [A, V].sort()); noLeak(r.out);
  assert.ok(r.world.hosts.every((h) => h.endsWith('api.cloudinary.com')), 'tylko Cloudinary');

  // --- testy negatywne: nic nie jest usuwane ---
  const neg = (args, env, code, re) => {
    const x = run(args, env);
    assert.equal(x.code, code, `${args.join(' ')} -> ${x.out}`);
    if (re) assert.match(x.out, re);
    assert.deepEqual(x.world.deleted, [], 'nic nie usunięto'); noLeak(x.out);
    return x;
  };
  neg([...okArgs.slice(0, 3), '--delete'], CL, 2, /confirm-cloud/);
  neg(['delete', '--manifest', mf, '--confirm-cloud', 'inna-chmura', '--confirm-project', 'crewatlas-test', '--delete'], CL, 2, /confirm-cloud/);
  neg(['delete', '--manifest', mf, '--confirm-cloud', 'demo-cloud', '--confirm-project', 'inny-projekt', '--delete'], CL, 2, /confirm-project/);
  neg([...okArgs, '--delete'], { ...CL, PROD_FIREBASE_PROJECT_ID: 'crewatlas-test' }, 2, /produkcyjn/);
  neg([...okArgs, '--delete'], { ...CL, PROD_TRIP_IDS: T }, 2, /produkcyjn/);
  const shared = neg([...okArgs, '--delete'], { ...CL, PROD_CLOUDINARY_CLOUD: 'demo-cloud' }, 2, /shared-cloud-variant-b/);
  assert.equal(shared.world.calls, 0, 'odmowa przed jakimkolwiek żądaniem');
  r = run([...okArgs, '--delete', '--shared-cloud-variant-b'], { ...CL, PROD_CLOUDINARY_CLOUD: 'demo-cloud' });
  assert.equal(r.code, 0, 'świadome potwierdzenie wariantu B działa');
  neg([...okArgs, '--delete'], { ...CL, CLOUDINARY_API_SECRET: '' }, 2);
  neg([...okArgs, '--delete'], { ...CL, CLOUDINARY_CLOUD: '../x' }, 2);
  neg([...okArgs, '--delete'], { ...CL, OLD: '1' }, 1, /Niczego nie usunięto/);
  neg([...okArgs, '--delete'], { ...CL, UPLOADTYPE: '1' }, 1, /Niczego nie usunięto/);
  const evil = (mut, re) => {
    const p = path.join(dir, `evil-${Math.random().toString(36).slice(2)}.json`);
    const b = JSON.parse(JSON.stringify(man)); mut(b); fs.writeFileSync(p, JSON.stringify(b));
    const x = run(['delete', '--manifest', p, '--confirm-cloud', 'demo-cloud', '--confirm-project', 'crewatlas-test', '--delete'], CL);
    assert.notEqual(x.code, 0, JSON.stringify(b.resources)); assert.deepEqual(x.world?.deleted ?? [], []); if (re) assert.match(x.out, re);
  };
  evil((b) => b.resources.push({ rt: 'image', id: 'wycieczka/OTHER/prodfile0001' }), /spoza podróży/);
  evil((b) => b.resources.push({ rt: 'image', id: `wycieczka/${T}/../OTHER/prodfile0001` }), /spoza podróży/);
  evil((b) => b.resources.push({ rt: 'image', id: `wycieczka/${T}/*` }), /spoza podróży/);
  evil((b) => b.resources.push({ rt: 'image', id: `wycieczka/${T}/` }), /spoza podróży/);
  evil((b) => b.resources.push({ rt: 'image', id: A }), /powtórzony/);
  evil((b) => { b.tripId = 'OTHER'; }, /spoza podróży/);
  evil((b) => { b.resources = []; }, /nie zawiera/);
  evil((b) => { b.since = 'nie-data'; }, /kształt/);
  evil((b) => { b.since = new Date(Date.now() + 86400000).toISOString(); }, /nie zgadza/); // plik starszy niż początek testów
  evil((b) => { b.resources = Array.from({ length: 51 }, (_, i) => ({ rt: 'image', id: `wycieczka/${T}/file${String(i).padStart(6, '0')}` })); }, /ponad 50/);
  const inRepo = fileURLToPath(new URL('./.manifest-in-repo-test.json', import.meta.url));
  fs.writeFileSync(inRepo, JSON.stringify(man));
  try { neg(['delete', '--manifest', inRepo, '--confirm-cloud', 'demo-cloud', '--confirm-project', 'crewatlas-test', '--delete'], CL, 2, /w katalogu repozytorium/); } finally { fs.rmSync(inRepo, { force: true }); }
  neg(['delete', '--manifest', path.join(dir, 'brak.json'), '--confirm-cloud', 'demo-cloud', '--confirm-project', 'crewatlas-test'], CL, 2);
  neg(['delete', '--confirm-cloud', 'demo-cloud'], CL, 2);
  neg(['wipe'], CL, 2);

  // skrypt: brak wildcardów po stronie kodu i brak zapisu na dysk
  const src = fs.readFileSync(script, 'utf8');
  assert.ok(!/writeFile|appendFile|createWriteStream|delete_by_prefix|prefix=/.test(src.replace(/^\/\/.*$/gm, '')), 'bez zapisu na dysk i bez usuwania po prefiksie');
  fs.rmSync(dir, { recursive: true });
  console.log('e2e-cleanup-cloudinary: wszystkie testy na atrapach przeszły');
}
