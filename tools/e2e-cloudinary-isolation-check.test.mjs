// node tools/e2e-cloudinary-isolation-check.test.mjs : atrapa dostarczania Cloudinary, bez sieci
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./e2e-cloudinary-isolation-check.mjs', import.meta.url));
const ADMIN = 'admin-secret-VALUE', TEST = 'test-secret-VALUE', ID = 'crewatlas-a2-control-outside/ctrlfile0001', CLOUD = 'demo-cloud';
const sig = (s) => `s--${crypto.createHash('sha1').update(`${ID}.png${s}`).digest('base64url').slice(0, 8)}--`;

if (process.argv[2] === 'child') {
  const accept = new Set((process.env.ACCEPT || '').split(',').filter(Boolean).map((n) => sig(n === 'admin' ? ADMIN : TEST)));
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.hostname, method: init.method || 'GET', path: u.pathname, range: init.headers?.range });
    const m = /\/image\/authenticated\/(s--[^/]+--)?\/?(.+)$/.exec(u.pathname);
    return new Response(null, { status: m && m[1] && m[2] === `${ID}.png` && accept.has(m[1]) ? 206 : 401 });
  };
  process.argv.splice(2, 1);
  process.on('exit', () => console.error(`WORLD ${JSON.stringify(calls.map((c) => ({ ...c, path: c.path.includes(ID) ? 'CTRL' : 'OTHER' })))}`));
  await import(script);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isol-test-'));
  const manifest = path.join(dir, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ resources: [{ id: ID }] }));
  const ENV = { CLOUDINARY_CLOUD: CLOUD, CTRL_PUBLIC_ID: ID, CLD_ADMIN_SECRET: ADMIN, CLD_TEST_SECRET: TEST };
  const run = (extra = [], env = {}, accept = '') => {
    const r = spawnSync(process.execPath, [here, 'child', ...extra], { env: { PATH: process.env.PATH, ACCEPT: accept, ...ENV, ...env }, encoding: 'utf8' });
    const w = /^WORLD (.*)$/m.exec(r.stderr);
    return { code: r.status, out: r.stdout + r.stderr.replace(/^WORLD .*$/m, ''), calls: w ? JSON.parse(w[1]) : [] };
  };
  const OK = ['--i-am-using-test-services', '--manifest', manifest];
  const noLeak = (x) => { for (const s of [ADMIN, TEST, 'ctrlfile0001']) assert.ok(!x.includes(s), `wyciek: ${s.slice(0, 6)}…`); assert.ok(!/https?:\/\/|s--/.test(x)); };

  // izolacja spełniona: tylko sekret kontrolny jest przyjęty
  let r = run(OK, {}, 'admin');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /RESULT: PASS/); assert.equal((r.out.match(/^PASS/gm) || []).length, 4); noLeak(r.out);
  assert.ok(r.calls.length === 4 && r.calls.every((c) => c.host === 'res.cloudinary.com' && c.method === 'GET' && c.path === 'CTRL' && c.range === 'bytes=0-0'), 'tylko GET Range 0-0 na zasób kontrolny');
  // izolacja NIEspełniona: ograniczony sekret też podpisuje
  r = run(OK, {}, 'admin,test');
  assert.equal(r.code, 1); assert.match(r.out, /FAIL.*OGRANICZONEGO/); assert.match(r.out, /NIEspełniona/); noLeak(r.out);
  // kontrola pozytywna nie działa: wynik nierozstrzygający, nie PASS
  r = run(OK, {}, '');
  assert.equal(r.code, 1); assert.match(r.out, /INCONCLUSIVE/); assert.ok(!/RESULT: PASS/.test(r.out)); assert.equal(r.calls.length, 1, 'po nieudanej kontroli nie testujemy dalej');
  // ograniczony przyjęty, kontrolny nie: też nie jest PASS
  r = run(OK, {}, 'test'); assert.equal(r.code, 1); assert.ok(!/RESULT: PASS/.test(r.out));

  // odmowy bez żadnego żądania sieciowego
  const neg = (extra, env, re) => { const x = run(extra, env, 'admin'); assert.equal(x.code, 2, x.out); assert.match(x.out, re); assert.equal(x.calls.length, 0, 'odmowa przed siecią'); noLeak(x.out); };
  neg(['--manifest', manifest], {}, /i-am-using-test-services/);
  neg(OK, { CTRL_PUBLIC_ID: 'wycieczka/PRODTRIP/photofile0001' }, /zakazane/);
  neg(OK, { CTRL_PUBLIC_ID: 'crewatlas-a2-control-x/../wycieczka/T/photofile0001' }, /musi mieć postać/);
  neg(OK, { CTRL_PUBLIC_ID: 'inny-folder/ctrlfile0001' }, /musi mieć postać/);
  neg(OK, { CLD_TEST_SECRET: ADMIN }, /takie same/);
  neg(OK, { CLD_TEST_SECRET: '' }, /brak zmiennej/);
  neg(OK, { PROD_CLOUDINARY_CLOUD: CLOUD }, /chmura produkcyjna/);
  neg(['--i-am-using-test-services'], {}, /manifest/);
  neg(['--i-am-using-test-services', '--manifest', path.join(dir, 'brak.json')], {}, /nie istnieje/);
  const other = path.join(dir, 'other.json'); fs.writeFileSync(other, '{"resources":[]}');
  neg(['--i-am-using-test-services', '--manifest', other], {}, /nie występuje w manifeście/);
  const inRepo = fileURLToPath(new URL('./.iso-manifest-test.json', import.meta.url));
  try { fs.writeFileSync(inRepo, JSON.stringify({ resources: [{ id: ID }] })); neg(['--i-am-using-test-services', '--manifest', inRepo], {}, /katalogu repozytorium/); } finally { fs.rmSync(inRepo, { force: true }); }
  // wspólna chmura (wariant B) przechodzi tylko z jawną flagą
  r = run([...OK, '--shared-cloud-variant-b'], { PROD_CLOUDINARY_CLOUD: CLOUD }, 'admin'); assert.equal(r.code, 0, r.out);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('e2e-cloudinary-isolation-check: wszystkie testy na atrapach przeszły');
}
