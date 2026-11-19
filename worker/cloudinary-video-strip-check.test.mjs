// Mock tests for cloudinary-video-strip-check.mjs: node cloudinary-video-strip-check.test.mjs (no network)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'TOPSECRET-video-VALUE', APIKEY = '424242';
const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./cloudinary-video-strip-check.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/synthetic-gps.mp4', import.meta.url));

// Removes the planted marks from the clip the way a successful strip would (same length, still an MP4).
function stripped(buf) {
  const out = Buffer.from(buf);
  for (const m of ['+12.3456+065.4321', 'FAKE_TEST_COMMENT', 'Fake_Person', 'Synthetic test clip']) {
    for (let i = out.indexOf(m); i >= 0; i = out.indexOf(m, i + 1)) out.fill(0x20, i, i + m.length);
  }
  for (let i = out.indexOf(Buffer.from([0xa9, 0x78, 0x79, 0x7a])); i >= 0; i = out.indexOf(Buffer.from([0xa9, 0x78, 0x79, 0x7a]), i + 1)) out.write('free', i, 'latin1');
  return out;
}

if (process.argv[2] === 'child') {
  const mode = process.argv[3];
  const original = fs.readFileSync(FIXTURE);
  const store = {};
  const call = (o) => process.stderr.write('CALL ' + JSON.stringify(o) + '\n');
  const sig = (p) => `s--${createHash('sha1').update(p + SECRET).digest('base64url').slice(0, 8)}--`;
  let derivedHits = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST' && /\/video\/(upload|destroy)$/.test(u)) {
      const f = init.body;
      const params = Object.fromEntries([...f.entries()].filter(([k]) => !['file', 'api_key', 'signature'].includes(k)));
      const ok = createHash('sha1').update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + SECRET).digest('hex') === f.get('signature');
      if (!ok || f.get('api_key') !== APIKEY) return Response.json({ error: { message: 'Invalid Signature' } }, { status: 401 });
      if (u.endsWith('/destroy')) {
        call({ op: 'destroy', id: params.public_id, type: params.type });
        if (mode === 'destroy-fails') return Response.json({ result: 'error' });
        if (mode === 'destroy-lies') return Response.json({ result: 'ok' }); // twierdzi, że usunął, a plik zostaje
        const had = params.public_id in store; delete store[params.public_id];
        return Response.json({ result: had ? 'ok' : 'not found' });
      }
      call({ op: 'upload', id: params.public_id, type: params.type, transformation: params.transformation, keys: Object.keys(params).sort() });
      if (mode === 'upload-fails') return Response.json({ error: { message: `bad ${SECRET} ${APIKEY} https://res.cloudinary.com/x/s--abcdefgh--/y` } }, { status: 400 });
      const data = Buffer.from(await f.get('file').arrayBuffer());
      const strips = params.transformation === 'fl_force_strip' && ['both', 'incoming-only', 'broken', 'truncated', 'unsigned-leak', 'destroy-fails', 'destroy-lies'].includes(mode);
      store[params.public_id] = mode === 'broken' && strips ? Buffer.from('not an mp4') : mode === 'truncated' && strips ? stripped(data).subarray(0, data.length - 300) : strips ? stripped(data) : data;
      return Response.json({ type: params.type, public_id: params.public_id, format: 'mp4', resource_type: 'video' });
    }
    const m = /^https:\/\/res\.cloudinary\.com\/demo-cloud\/video\/authenticated\/(s--[A-Za-z0-9_-]{8}--)\/(.+)$/.exec(u);
    if (mode === 'unsigned-leak' && !m && /\/video\/authenticated\/[^s]/.test(u)) return new Response(store[u.split('/authenticated/')[1].replace(/\.mp4$/, '')] ?? '', { status: 200 });
    if (!m || m[1] !== sig(m[2])) return new Response('', { status: 401 });
    const derived = m[2].startsWith('fl_force_strip/');
    const id = m[2].replace(/^fl_force_strip\//, '').replace(/\.mp4$/, '');
    if (!(id in store)) return new Response('', { status: 404 });
    call({ op: 'get', derived });
    if (derived) {
      if (mode === 'derived-423' && derivedHits++ < 2) return new Response('', { status: 423 });
      return new Response(['both', 'derived-423', 'derived-only', 'destroy-fails', 'destroy-lies'].includes(mode) ? stripped(store[id]) : store[id], { status: 200 });
    }
    return new Response(store[id], { status: 200 });
  };
  await import(script);
} else {
  const run = (mode) => {
    const r = spawnSync(process.execPath, [here, 'child', mode], {
      env: { PATH: process.env.PATH, CLOUDINARY_CLOUD: 'demo-cloud', CLOUDINARY_API_KEY: APIKEY, CLOUDINARY_API_SECRET: SECRET, STRIP_CHECK_POLL_MS: '10' },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout + r.stderr.split('\n').filter((l) => !l.startsWith('CALL ')).join('\n'),
      calls: r.stderr.split('\n').filter((l) => l.startsWith('CALL ')).map((l) => JSON.parse(l.slice(5))) };
  };
  const noLeak = (out) => {
    for (const bad of [SECRET, APIKEY]) assert.ok(!out.includes(bad), 'secret printed');
    assert.ok(!/https?:\/\//.test(out) && !/s--[A-Za-z0-9_-]{8}--/.test(out), 'url or signature printed');
  };
  const onlyOurAssets = (calls) => {
    const ups = calls.filter((c) => c.op === 'upload'), dels = calls.filter((c) => c.op === 'destroy');
    assert.ok(ups.every((c) => c.type === 'authenticated' && /^crewatlas-video-strip-check\/[0-9a-f-]{36}-(control|incoming)$/.test(c.id)), 'only private uploads under our prefix');
    const delIds = dels.map((c) => c.id);
    assert.ok(delIds.every((id) => /^crewatlas-video-strip-check\/[0-9a-f-]{36}-(control|incoming)$/.test(id)), 'deletes only ids of this run');
    assert.equal(new Set(delIds.map((id) => id.slice(27, 63))).size, 1, 'one run id only');
    assert.ok(ups.every((u) => delIds.includes(u.id)), 'everything it uploaded is deleted');
    assert.equal(new Set(delIds).size, delIds.length, 'no id deleted twice');
    assert.ok(dels.every((c) => c.type === 'authenticated'));
  };

  // the fixture really carries the marks, and the mock strip really removes them (validates the test itself)
  const fx = fs.readFileSync(FIXTURE);
  for (const m of ['+12.3456+065.4321', 'FAKE_TEST_COMMENT', 'Fake_Person']) assert.ok(fx.includes(m), `fixture has ${m}`);
  assert.ok(!stripped(fx).includes('+12.3456+065.4321') && stripped(fx).length === fx.length);

  let r = run('both');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  control \(no transformation\) keeps the test marks/);
  assert.match(r.out, /PASS  incoming fl_force_strip strips the stored original \(metadata removed/);
  assert.match(r.out, /PASS  derived fl_force_strip strips the delivered copy/);
  assert.match(r.out, /PASS  stripped asset stays private/);
  assert.match(r.out, /RESULT: control valid, incoming strip PASS, derived strip PASS, cleanup confirmed/);
  noLeak(r.out); onlyOurAssets(r.calls);
  assert.equal(r.calls.filter((c) => c.op === 'upload').find((c) => c.transformation).keys.join(), 'public_id,timestamp,transformation,type');

  r = run('none'); // account ignores the flag: metadata stays, and the check says so
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  incoming fl_force_strip strips the stored original \(metadata still present: \+12\.3456\+065\.4321/);
  assert.match(r.out, /FAIL  derived fl_force_strip/);
  assert.match(r.out, /Do not rely on server-side stripping/);
  noLeak(r.out); onlyOurAssets(r.calls);

  r = run('incoming-only');
  assert.equal(r.code, 0);
  assert.match(r.out, /incoming strip PASS, derived strip not confirmed/);
  onlyOurAssets(r.calls);

  r = run('derived-423'); // derived version still being generated: polls instead of failing
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  derived fl_force_strip/);
  assert.ok(r.calls.filter((c) => c.op === 'get' && c.derived).length >= 1);

  r = run('broken'); // stripped but the result is not a valid MP4: FAIL, not PASS
  assert.match(r.out, /FAIL  incoming fl_force_strip strips the stored original \(result is not a valid MP4/);
  assert.equal(r.code === 0 && /incoming strip PASS/.test(r.out), false);
  onlyOurAssets(r.calls);

  r = run('truncated'); // ucięty wynik nie przechodzi kontroli struktury MP4
  assert.match(r.out, /FAIL  incoming fl_force_strip strips the stored original \(result is not a valid MP4/);
  assert.ok(!(r.code === 0 && /incoming strip PASS/.test(r.out)));

  r = run('unsigned-leak'); // plik dostępny bez podpisu = nie jest prywatny
  assert.match(r.out, /FAIL  stripped asset stays private/);

  r = run('upload-fails'); // errors are redacted and nothing leaks; nothing to clean
  assert.equal(r.code, 1);
  noLeak(r.out); onlyOurAssets(r.calls);
  assert.match(r.out, /ERROR/);

  r = run('destroy-fails'); // strip works but the test assets were not confirmed deleted: the run fails and says what to do
  assert.equal(r.code, 1);
  assert.match(r.out, /WARN  delete the folder crewatlas-video-strip-check\//);
  assert.match(r.out, /cleanup NOT confirmed/);
  noLeak(r.out);

  r = run('destroy-lies'); // Cloudinary mówi "ok", ale plik dalej jest osiągalny: usunięcie nie jest uznane
  assert.equal(r.code, 1);
  assert.match(r.out, /WARN  .* still reachable after delete \(HTTP 200\)/);
  assert.match(r.out, /cleanup NOT confirmed/);

  const noEnv = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(noEnv.status, 2);
  const src = fs.readFileSync(script, 'utf8');
  assert.ok(!/writeFile|appendFile|createWriteStream/.test(src), 'script must not write files');
  assert.ok(!/delete_resources|delete_all|prefix=|resources\//.test(src), 'script must not list or bulk-delete');
  console.log('Video strip check script: all mock tests passed');
}
