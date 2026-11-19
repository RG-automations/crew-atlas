// Mock tests for cloudinary-privacy-check.mjs: node cloudinary-privacy-check.test.mjs
// The script runs in a child process against a fake Cloudinary. Nothing here touches the network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECRET = 'TOPSECRET-value-123';
const APIKEY = '987654321';
const here = fileURLToPath(import.meta.url);
const script = fileURLToPath(new URL('./cloudinary-privacy-check.mjs', import.meta.url));

if (process.argv[2] === 'child') {
  const scenario = process.argv[3];
  const calls = [];
  const sig = (p) => `s--${createHash('sha1').update(p + SECRET).digest('base64url').slice(0, 8)}--`;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const log = (o) => process.stderr.write('CALL ' + JSON.stringify(o) + '\n');
    if (init.method === 'POST' && u.endsWith('/image/upload')) {
      const f = init.body;
      log({ op: 'upload', id: f.get('public_id'), type: f.get('type'), keys: [...f.keys()].sort() });
      if (scenario === 'upload-fails') {
        return Response.json({ error: { message: `Invalid Signature ${SECRET} ${APIKEY} see https://res.cloudinary.com/x/s--abcdefgh--/y` } }, { status: 400 });
      }
      return Response.json({ type: 'authenticated', version: 7, public_id: f.get('public_id'), format: 'png' });
    }
    if (init.method === 'POST' && u.endsWith('/image/destroy')) {
      const f = init.body;
      log({ op: 'destroy', id: f.get('public_id'), type: f.get('type'), keys: [...f.keys()].sort() });
      if (scenario === 'destroy-fails') return Response.json({ result: 'error' });
      return Response.json({ result: scenario === 'upload-fails' ? 'not found' : 'ok' });
    }
    log({ op: 'get', kind: u.includes('/authenticated/') ? (u.includes('/s--') ? 'signed' : 'unsigned') : 'public' });
    const m = u.match(/\/image\/(\w+)\/(.*)$/);
    const [, type, rest] = m;
    if (scenario === 'net-error' && rest.startsWith('s--')) throw new Error(`socket hang up for ${u} using ${SECRET}`);
    if (scenario === 'unsigned-200') return new Response('', { status: 200 });
    if (scenario === 'server-error') return new Response('', { status: 500 });
    if (type === 'upload') return new Response('', { status: 404 });
    const parts = rest.split('/');
    if (!parts[0].startsWith('s--')) return new Response('', { status: 401 });
    return new Response('', { status: sig(parts.slice(1).join('/')) === parts[0] ? 200 : 401 });
  };
  await import(script);
} else {
  const run = (scenario) => {
    const r = spawnSync(process.execPath, [here, 'child', scenario], {
      env: { PATH: process.env.PATH, CLOUDINARY_CLOUD: 'fakecloud', CLOUDINARY_API_KEY: APIKEY, CLOUDINARY_API_SECRET: SECRET },
      encoding: 'utf8',
    });
    const calls = r.stderr.split('\n').filter((l) => l.startsWith('CALL ')).map((l) => JSON.parse(l.slice(5)));
    return { code: r.status, out: r.stdout + r.stderr.split('\n').filter((l) => !l.startsWith('CALL ')).join('\n'), calls };
  };
  const never = (out) => {
    assert.ok(!out.includes(SECRET), 'secret printed');
    assert.ok(!out.includes(APIKEY), 'api key printed');
    assert.ok(!/s--[A-Za-z0-9_-]{8}--/.test(out), 'signature printed');
    assert.ok(!/https?:\/\//.test(out), 'URL printed');
  };
  const onlyOurDestroy = (calls) => {
    const up = calls.find((c) => c.op === 'upload');
    const destroys = calls.filter((c) => c.op === 'destroy');
    assert.equal(destroys.length, 1, 'exactly one destroy call');
    assert.match(destroys[0].id, /^crewatlas-privacy-check\/[0-9a-f-]{36}$/);
    assert.equal(destroys[0].type, 'authenticated');
    assert.deepEqual(destroys[0].keys, ['api_key', 'invalidate', 'public_id', 'signature', 'timestamp', 'type']);
    if (up) assert.equal(destroys[0].id, up.id, 'destroys only the asset it uploaded');
    return destroys[0];
  };

  // happy path
  let r = run('ok');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /RESULT: PASS/);
  assert.equal((r.out.match(/^PASS /gm) || []).length, 5);
  never(r.out);
  const up = r.calls.find((c) => c.op === 'upload');
  assert.equal(r.calls.filter((c) => c.op === 'upload').length, 1, 'one upload only');
  assert.equal(up.type, 'authenticated');
  assert.deepEqual(up.keys, ['api_key', 'file', 'public_id', 'signature', 'timestamp', 'type']);
  onlyOurDestroy(r.calls);

  // upload rejected: error text is redacted, cleanup still targets only our id
  r = run('upload-fails');
  assert.equal(r.code, 1);
  assert.match(r.out, /RESULT: FAIL/);
  never(r.out);
  onlyOurDestroy(r.calls);

  // network error in the middle: cleanup runs, nothing leaks
  r = run('net-error');
  assert.equal(r.code, 1);
  never(r.out);
  onlyOurDestroy(r.calls);

  // unsigned URL returning 200 is a FAIL (the asset would be public)
  r = run('unsigned-200');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  unsigned authenticated URL is refused \(expected 401\/403\/404, got HTTP 200\)/);
  onlyOurDestroy(r.calls);

  // a 5xx is not accepted as "refused"
  r = run('server-error');
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL  unsigned authenticated URL is refused \(expected 401\/403\/404, got HTTP 500\)/);

  // cleanup failure is reported with manual instructions and fails the run
  r = run('destroy-fails');
  assert.equal(r.code, 1);
  assert.match(r.out, /WARN  test asset cleanup: error - delete the folder/);
  never(r.out);

  // missing credentials: exits before any request
  const noEnv = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(noEnv.status, 2);

  // the script never writes files and never lists or bulk-deletes
  const src = (await import('node:fs')).readFileSync(script, 'utf8');
  assert.ok(!/node:fs|writeFile|appendFile|createWriteStream/.test(src), 'script must not touch the disk');
  assert.ok(!/resources\/|delete_resources|delete_all|prefix=/.test(src), 'script must not list or bulk-delete');
  console.log('Cloudinary check script: all mock tests passed');
}
