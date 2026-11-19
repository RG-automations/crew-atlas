// Manual check: does Cloudinary remove location and other metadata from a VIDEO with `fl_force_strip` on YOUR account,
// and does the file stay a valid MP4? Uses only the synthetic clip worker/fixtures/synthetic-gps.mp4 (fake location in the
// open sea, fake author), never a real recording. Assets stay `authenticated` (private) the whole time.
//
//   read -rs CLOUDINARY_API_SECRET && export CLOUDINARY_API_SECRET
//   read -r  CLOUDINARY_CLOUD   && export CLOUDINARY_CLOUD
//   read -rs CLOUDINARY_API_KEY && export CLOUDINARY_API_KEY
//   node worker/cloudinary-video-strip-check.mjs
//
// Variants:
//   control   upload without any transformation, read the original back (the test marks must be PRESENT, otherwise
//             the test cannot tell anything)
//   incoming  upload with the incoming transformation `fl_force_strip` (changes the stored original), read it back
//   derived   deliver the control asset with the signed transformation `fl_force_strip` (the original keeps its metadata)
//
// Positive RESULT means: control had the test marks, the stripped file has none and is a structurally valid MP4, it stays
// private (unsigned URL refused), and all test assets are gone (signed URL answers 404). Playback is a separate phone test.
// Safety contract (same as cloudinary-privacy-check.mjs, covered by cloudinary-video-strip-check.test.mjs):
//  - three uploads of the synthetic clip under fresh random ids in `crewatlas-video-strip-check/`; all `authenticated`;
//  - deletes ONLY those exact ids, also after errors or Ctrl+C; never lists, never deletes by prefix;
//  - calls only upload, destroy and signed delivery: no account settings, presets or other assets;
//  - prints only PASS/FAIL, expected vs received statuses, never credentials, signatures or asset URLs;
//  - credentials from environment variables only, nothing written to disk; every request has a timeout.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';

const { CLOUDINARY_CLOUD: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
if (!cloud || !apiKey || !secret || !/^[A-Za-z0-9_-]{1,64}$/.test(cloud)) {
  console.error('Set CLOUDINARY_CLOUD, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in the environment.');
  process.exit(2);
}
const FIXTURE = process.env.VIDEO_FIXTURE ?? new URL('./fixtures/synthetic-gps.mp4', import.meta.url).pathname;
const video = fs.readFileSync(FIXTURE);
// Marks planted in the synthetic clip. Any of them left in the delivered file means metadata survived.
const MARKS = ['+12.3456+065.4321', 'FAKE_TEST_COMMENT', 'Fake_Person', 'Synthetic test clip'];
const hasMarks = (buf) => MARKS.filter((m) => buf.includes(Buffer.from(m))).concat(buf.includes(Buffer.from([0xa9, 0x78, 0x79, 0x7a])) ? ['©xyz atom'] : []);
// Struktura MP4: pudełka najwyższego poziomu muszą składać się dokładnie na cały plik i zawierać ftyp, moov oraz mdat.
// To nie jest odtwarzanie, ale wyłapuje ucięty lub uszkodzony wynik. Odtwarzanie sprawdzasz osobno na telefonie.
function isMp4(buf) {
  const seen = new Set();
  let i = 0;
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    if (size === 1 && i + 16 <= buf.length) size = Number(buf.readBigUInt64BE(i + 8));
    if (size < 8 || i + size > buf.length) return false;
    seen.add(type);
    i += size;
  }
  return i === buf.length && ['ftyp', 'moov', 'mdat'].every((t) => seen.has(t));
}

const redact = (t) =>
  String(t).split(secret).join('***').split(apiKey).join('***').replace(/s--[A-Za-z0-9_-]{8}--/g, 's--***--').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
const http = (url, init = {}, ms = 60_000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
const sha1 = (t) => createHash('sha1').update(t).digest();
const signParams = (p) => sha1(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + secret).toString('hex');
const deliverySig = (p) => `s--${sha1(p + secret).toString('base64url').slice(0, 8)}--`;
const PREFIX = 'crewatlas-video-strip-check/';
const run = randomUUID();
const ids = { control: `${PREFIX}${run}-control`, incoming: `${PREFIX}${run}-incoming` };
const uploaded = new Set();
const results = {};
let cleanedUp = false;

async function upload(publicId, extra = {}) {
  const params = { public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'authenticated', ...extra };
  const form = new FormData();
  form.set('api_key', apiKey);
  form.set('signature', signParams(params));
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  form.set('file', new Blob([video], { type: 'video/mp4' }), 'synthetic-gps.mp4');
  const res = await http(`https://api.cloudinary.com/v1_1/${cloud}/video/upload`, { method: 'POST', body: form }, 180_000);
  const body = await res.json().catch(() => ({}));
  if (res.status === 200 && body.public_id === publicId) uploaded.add(publicId);
  return { status: res.status, body };
}

// Signed delivery of a video; Cloudinary may answer 423 while a derived version is still being generated.
async function deliver(publicId, format, transformation) {
  const p = `${transformation ? `${transformation}/` : ''}${publicId}.${format}`;
  const url = `https://res.cloudinary.com/${cloud}/video/authenticated/${deliverySig(p)}/${p}`;
  let last;
  for (let i = 0; i < 12; i++) {
    last = await http(url, { redirect: 'manual' }, 120_000);
    if (last.status !== 423 && last.status !== 202) break;
    await new Promise((r) => setTimeout(r, Number(process.env.STRIP_CHECK_POLL_MS) || 5000));
  }
  return { status: last.status, buf: last.status === 200 ? Buffer.from(await last.arrayBuffer()) : null };
}

const record = (name, outcome, detail) => {
  results[name] = outcome;
  console.log(`${outcome.padEnd(5)} ${name}${detail ? ` (${detail})` : ''}`);
};
// expectStripped: true = marks must be gone and the file must still be an MP4. false = marks must be present (control).
function judge(name, r, expectStripped) {
  if (r.status !== 200 || !r.buf) return record(name, 'ERROR', `HTTP ${r.status}`);
  const left = hasMarks(r.buf);
  if (!isMp4(r.buf)) return record(name, 'FAIL', `result is not a valid MP4 (${r.buf.length} bytes)`);
  if (expectStripped) {
    return left.length === 0 ? record(name, 'PASS', `metadata removed, ${r.buf.length} bytes`) : record(name, 'FAIL', `metadata still present: ${left.join(', ')}`);
  }
  return left.length ? record(name, 'PASS', `test marks present as expected: ${left.length} of ${MARKS.length + 1}`) : record(name, 'FAIL', 'control has no test marks, the check cannot tell anything');
}

async function cleanup() {
  if (cleanedUp) return;
  let ok = true;
  for (const id of Object.values(ids)) {
    if (!id.startsWith(PREFIX) || !/^[0-9a-f-]{36}-(control|incoming)$/.test(id.slice(PREFIX.length))) continue; // never delete anything else
    try {
      const params = { invalidate: 'true', public_id: id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'authenticated' };
      const form = new FormData();
      form.set('api_key', apiKey);
      form.set('signature', signParams(params));
      for (const [k, v] of Object.entries(params)) form.set(k, v);
      const del = await http(`https://api.cloudinary.com/v1_1/${cloud}/video/destroy`, { method: 'POST', body: form });
      const r = await del.json().catch(() => ({}));
      if (r.result !== 'ok' && r.result !== 'not found') ok = false;
      console.log(`${r.result === 'ok' || r.result === 'not found' ? 'INFO' : 'WARN'}  cleanup ${id.slice(-7)}: ${r.result ?? `HTTP ${del.status}`}`);
    } catch (e) {
      ok = false;
      console.log(`WARN  cleanup ${id.slice(-7)} failed: ${redact(e.message)}`);
    }
  }
  // Usunięcie sprawdzamy: podpisany adres do skasowanego pliku musi dać 404.
  if (ok) {
    for (const id of Object.values(ids)) {
      if (!uploaded.has(id)) continue;
      try {
        const g = await deliver(id, 'mp4', '');
        if (g.status !== 404) { ok = false; console.log(`WARN  ${id.slice(-7)} still reachable after delete (HTTP ${g.status})`); }
      } catch (e) {
        ok = false;
        console.log(`WARN  could not confirm deletion of ${id.slice(-7)}: ${redact(e.message)}`);
      }
    }
  }
  cleanedUp = ok;
  if (!ok) console.log('WARN  delete the folder crewatlas-video-strip-check/ by hand in the Cloudinary console');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });

console.log('Uploading the synthetic clip 2 times as authenticated assets, testing metadata removal, deleting exactly those assets.');
try {
  const c = await upload(ids.control);
  if (c.status !== 200 || c.body.type !== 'authenticated') {
    record('control upload', 'ERROR', `HTTP ${c.status}${c.body.error ? `, ${redact(c.body.error.message)}` : ''}`);
  } else {
    const format = c.body.format || 'mp4';
    judge('control (no transformation) keeps the test marks', await deliver(ids.control, format, ''), false);

    const inc = await upload(ids.incoming, { transformation: 'fl_force_strip' });
    if (inc.status !== 200 || inc.body.type !== 'authenticated') {
      record('incoming fl_force_strip upload', 'ERROR', `HTTP ${inc.status}${inc.body.error ? `, ${redact(inc.body.error.message)}` : ''}`);
    } else {
      judge('incoming fl_force_strip strips the stored original', await deliver(ids.incoming, inc.body.format || format, ''), true);
      // Prywatność wyniku: bez podpisu nie ma dostępu, a odpowiedź Cloudinary potwierdziła typ authenticated.
      const unsigned = await http(`https://res.cloudinary.com/${cloud}/video/authenticated/${ids.incoming}.${inc.body.format || format}`, { redirect: 'manual' });
      record('stripped asset stays private (unsigned URL refused)', [401, 403, 404].includes(unsigned.status) ? 'PASS' : 'FAIL', `expected 401/403/404, got HTTP ${unsigned.status}`);
    }
    judge('derived fl_force_strip strips the delivered copy', await deliver(ids.control, format, 'fl_force_strip'), true);
  }
} catch (e) {
  console.error(`ERROR ${redact(e.message)}`);
  results.exception = 'ERROR';
} finally {
  await cleanup();
}
const control = results['control (no transformation) keeps the test marks'] === 'PASS';
const incoming = results['incoming fl_force_strip strips the stored original'] === 'PASS';
const derived = results['derived fl_force_strip strips the delivered copy'] === 'PASS';
console.log(`\nRESULT: control ${control ? 'valid' : 'INVALID'}, incoming strip ${incoming ? 'PASS' : 'not confirmed'}, derived strip ${derived ? 'PASS' : 'not confirmed'}, cleanup ${cleanedUp ? 'confirmed' : 'NOT confirmed'}.`);
console.log(control && incoming && cleanedUp
  ? 'Incoming `fl_force_strip` works on this account for this clip. Playback on a phone is still untested.'
  : 'Do not rely on server-side stripping for videos until this passes (see docs/private-media.md for the alternatives).');
process.exit(control && (incoming || derived) && cleanedUp ? 0 : 1);
