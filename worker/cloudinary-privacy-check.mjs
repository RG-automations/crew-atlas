// Manual check: does YOUR Cloudinary account support `authenticated` assets and signed delivery URLs?
// Uploads one 1x1 test PNG (not private data), probes access, then deletes it. Nothing else is touched.
//
//   read -rs CLOUDINARY_API_SECRET && export CLOUDINARY_API_SECRET   # typed silently, not in shell history
//   export CLOUDINARY_CLOUD=... CLOUDINARY_API_KEY=...
//   node worker/cloudinary-privacy-check.mjs
//
// Safety contract (reviewed, and covered by the mock tests in worker/cloudinary-privacy-check.test.mjs):
//  - uploads ONE synthetic 1x1 PNG built into this file, under a fresh random id in `crewatlas-privacy-check/`;
//  - deletes ONLY that exact id (never lists, never deletes by prefix or pattern), also after errors or Ctrl+C;
//  - calls only the upload and destroy endpoints: no account settings, presets or other assets are read or changed;
//  - prints only PASS/FAIL, expected vs received HTTP status, never credentials, signatures or asset URLs
//    (error text from Cloudinary is passed through a redaction filter);
//  - reads credentials from environment variables only and writes nothing to disk;
//  - every request has a 30 s timeout.
import { createHash, randomUUID } from 'node:crypto';

const { CLOUDINARY_CLOUD: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
if (!cloud || !apiKey || !secret) {
  console.error('Set CLOUDINARY_CLOUD, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in the environment.');
  process.exit(2);
}

if (!/^[A-Za-z0-9_-]{1,64}$/.test(cloud)) {
  console.error('CLOUDINARY_CLOUD does not look like a cloud name.');
  process.exit(2);
}
// Redact credentials from anything we print.
const redact = (t) =>
  String(t).split(secret).join('***').split(apiKey).join('***').replace(/s--[A-Za-z0-9_-]{8}--/g, 's--***--')
    .replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
const http = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

const sha1 = (t) => createHash('sha1').update(t).digest();
const signParams = (p) =>
  sha1(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + secret).toString('hex');
// Delivery URL signature: first 8 chars of URL-safe base64 of SHA-1(path + secret).
const deliverySig = (path) => `s--${sha1(path + secret).toString('base64url').slice(0, 8)}--`;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PREFIX = 'crewatlas-privacy-check/';
const publicId = `${PREFIX}${randomUUID()}`;
const results = [];
const record = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};
const status = async (url) => (await http(url, { redirect: 'manual' })).status;
// A refusal only counts when the status is exactly one of the expected ones (401/403/404), so a 5xx or a
// redirect is a FAIL, not a pass.
const expectStatus = async (name, url, allowed) => {
  const got = await status(url);
  record(name, allowed.includes(got), `expected ${allowed.join('/')}, got HTTP ${got}`);
};
console.log(`Uploading 1 synthetic test image as authenticated asset, then deleting exactly that asset.`);

let uploaded = null;
let cleanedUp = false;
// Deletes exactly the asset this run generated. Runs even if the upload response was lost (the id is ours),
// and is safe to call when nothing was uploaded ("not found").
async function cleanup() {
  if (cleanedUp) return;
  if (!publicId.startsWith(PREFIX) || !/^[0-9a-f-]{36}$/.test(publicId.slice(PREFIX.length))) return; // never delete anything else
  try {
    const params = { invalidate: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'authenticated' };
    const form = new FormData();
    form.set('api_key', apiKey);
    form.set('signature', signParams(params));
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    const del = await http(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: 'POST', body: form });
    const r = await del.json().catch(() => ({}));
    cleanedUp = r.result === 'ok' || r.result === 'not found';
    console.log(`${r.result === 'ok' ? 'INFO' : cleanedUp ? 'INFO' : 'WARN'}  test asset cleanup: ${r.result ?? `HTTP ${del.status}`}${cleanedUp ? '' : ' - delete the folder crewatlas-privacy-check/ by hand in the Cloudinary console'}`);
  } catch (e) {
    console.log(`WARN  test asset cleanup failed: ${redact(e.message)} - delete the folder crewatlas-privacy-check/ by hand in the Cloudinary console`);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });

try {
  // 1. Signed upload with type=authenticated
  const params = { public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'authenticated' };
  const form = new FormData();
  form.set('api_key', apiKey);
  form.set('signature', signParams(params));
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  form.set('file', new Blob([PNG_1X1], { type: 'image/png' }), 'check.png');
  const up = await http(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form });
  const body = await up.json().catch(() => ({}));
  record('upload with type=authenticated',
    up.status === 200 && body.type === 'authenticated' && body.public_id === publicId,
    `HTTP ${up.status}${body.error ? `, ${redact(body.error.message)}` : ''}${up.status === 200 ? `, type=${body.type}` : ''}`);
  if (up.status !== 200 || body.public_id !== publicId) throw new Error('upload failed or returned an unexpected id, cannot continue');
  uploaded = body;

  const base = `https://res.cloudinary.com/${cloud}/image`;
  const v = `v${body.version}`;
  const file = `${body.public_id}.${body.format}`;

  // 2. Unsigned access must be refused (both as authenticated and as the public `upload` type)
  await expectStatus('unsigned authenticated URL is refused', `${base}/authenticated/${v}/${file}`, [401, 403, 404]);
  await expectStatus('public `upload` URL for the same id does not work', `${base}/upload/${v}/${file}`, [401, 403, 404]);

  // 3. Signed URL works, tampered signature does not
  const path = `${v}/${file}`;
  await expectStatus('signed authenticated URL works', `${base}/authenticated/${deliverySig(path)}/${path}`, [200]);
  const good = deliverySig(path);
  const bad = good.slice(0, 3) + (good[3] === 'A' ? 'B' : 'A') + good.slice(4);
  await expectStatus('tampered signature is refused', `${base}/authenticated/${bad}/${path}`, [401, 403]);

  // 4. Informational: a signed on-the-fly transformation (thumbnails). Not a pass/fail criterion.
  const tpath = `c_fill,h_32,w_32/${path}`;
  const s5 = await status(`${base}/authenticated/${deliverySig(tpath)}/${tpath}`);
  console.log(`INFO  signed on-the-fly transformation: HTTP ${s5} (200 = thumbnails possible without eager derivations)`);
} catch (e) {
  console.error(`ERROR ${redact(e.message)}`);
  results.push(false);
} finally {
  await cleanup();
}
const ok = results.length > 0 && results.every(Boolean) && cleanedUp;
console.log(ok ? '\nRESULT: PASS - authenticated delivery with signed URLs works on this account and the test asset was removed.' : '\nRESULT: FAIL - at least one check failed or the test asset was not confirmed deleted. Do not rely on authenticated delivery before understanding why.');
process.exit(ok ? 0 : 1);
