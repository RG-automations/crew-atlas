// Próba generalna migracji: tworzy w TESTOWYM projekcie kilka SYNTETYCZNYCH wspomnień w starym kształcie
// (publiczny plik Cloudinary + dokument z polem url), żeby przećwiczyć na nich tools/migrate-media-to-private.mjs.
// Nie używa prawdziwych zdjęć: obrazy to proste wzory generowane w kodzie.
//
//   node tools/seed-synthetic-legacy-media.mjs seed    --trip <id testowej podróży> --backup-dir <katalog> [--count 3] [--apply --i-am-using-a-test-project]
//   node tools/seed-synthetic-legacy-media.mjs cleanup --backup-dir <katalog> [--apply]
//
// Bez --apply tylko mówi, co by zrobił. Podróż testowa musi już istnieć (załóż ją w aplikacji na koncie testowym).
// Wszystko, co powstało, jest zapisane w pliku stanu (<katalog>/seed-state.json), więc `cleanup` usuwa dokładnie to,
// co zasiano, i nic więcej. Środowisko: CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, FIREBASE_PROJECT_ID,
// GCLOUD_ACCESS_TOKEN (jak w skrypcie migracji). Katalog stanu podlega tym samym zakazom co kopie zapasowe.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { png } from './lib/png.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const APPLY = flag('apply');
const DIR = opt('backup-dir', null);
const TRIP = opt('trip', null);
const COUNT = Math.min(10, Math.max(1, Number(opt('count', 3)) || 3));
const { CLOUDINARY_CLOUD: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret, FIREBASE_PROJECT_ID: project, GCLOUD_ACCESS_TOKEN: gtoken } = process.env;

const fail = (m, code = 2) => { console.error(m); process.exit(code); };
if (!['seed', 'cleanup'].includes(cmd)) fail('Użycie: seed|cleanup --backup-dir <katalog> ...');
if (!DIR) fail('Podaj --backup-dir <katalog poza projektem i folderami synchronizowanymi>.');
if (!cloud || !apiKey || !secret || !project || !gtoken || !/^[A-Za-z0-9_-]{1,64}$/.test(cloud)) fail('Ustaw zmienne środowiskowe (patrz nagłówek skryptu).');
if (cmd === 'seed' && (!TRIP || !/^[A-Za-z0-9]{1,64}$/.test(TRIP))) fail('Podaj --trip <id testowej podróży>.');
for (let d = path.resolve(DIR); ; d = path.dirname(d)) {
  const hit = ['.stfolder', '.git', '.dropbox', 'pubspec.yaml', 'firebase.json'].find((m) => fs.existsSync(path.join(d, m)));
  if (hit && !flag('allow-unsafe-location')) fail(`ODMOWA: ${d} zawiera ${hit} (repozytorium, projekt albo folder synchronizowany). Wskaż inny katalog.`);
  if (path.dirname(d) === d) break;
}
if (APPLY && cmd === 'seed' && !flag('i-am-using-a-test-project')) fail('ODMOWA: seed zapisuje do bazy i Cloudinary. Dodaj --i-am-using-a-test-project, jeśli to projekt TESTOWY.');

const STATE = path.join(DIR, 'seed-state.json');
const redact = (t) => String(t).split(secret).join('***').split(apiKey).join('***').split(gtoken).join('***').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
const http = (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(60_000) });
const sha1 = (t) => createHash('sha1').update(t).digest('hex');
const signParams = (p) => sha1(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + secret);
const fsBase = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
const fsAuth = { authorization: `Bearer ${gtoken}`, 'content-type': 'application/json' };

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { created: [] };
const save = () => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 }); };
let failures = 0;

async function seed() {
  const tripRes = await http(`${fsBase}/trips/${TRIP}`, { headers: fsAuth });
  if (tripRes.status !== 200) fail(`Podróż testowa o tym id nie istnieje w tym projekcie (HTTP ${tripRes.status}). Załóż ją w aplikacji.`, 1);
  for (let n = 1; n <= COUNT; n++) {
    const id = randomUUID();
    const publicId = `wycieczka/${TRIP}/${id}`;
    const docId = `seed${id.replace(/-/g, '').slice(0, 16)}`;
    console.log(`${APPLY ? '' : '[dry-run] '}syntetyczne wspomnienie ${n} z ${COUNT}: plik publiczny + dokument ${docId}`);
    if (!APPLY) continue;
    try {
      const params = { overwrite: 'false', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'upload' };
      const form = new FormData();
      form.set('api_key', apiKey); form.set('signature', signParams(params));
      for (const [k, v] of Object.entries(params)) form.set(k, v);
      form.set('file', new Blob([png(n)], { type: 'image/png' }), `synthetic-${n}.png`);
      const up = await http(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form });
      const body = await up.json().catch(() => ({}));
      if (up.status !== 200 || body.public_id !== publicId || !body.secure_url) throw new Error(`upload: ${redact(body.error?.message ?? `HTTP ${up.status}`)}`);
      state.created.push({ publicId, docId, tripId: TRIP, doc: false });
      save();
      const doc = await http(`${fsBase}/trips/${TRIP}/memories?documentId=${docId}`, {
        method: 'POST', headers: fsAuth,
        body: JSON.stringify({ fields: { placeId: { stringValue: 'synthetic' }, type: { stringValue: 'photo' }, url: { stringValue: body.secure_url },
          description: { stringValue: `Syntetyczny plik ${n}` }, createdBy: { stringValue: 'synthetic-user' } } }),
      });
      if (doc.status !== 200) throw new Error(`dokument: HTTP ${doc.status}`);
      state.created.at(-1).doc = true;
      save();
    } catch (e) { failures++; console.log(`BŁĄD: ${redact(e.message)}`); }
  }
  if (!APPLY) console.log('Dry-run: nic nie utworzono.');
}

async function cleanup() {
  console.log(`cleanup: ${state.created.length} zasianych wpisów.`);
  for (const c of [...state.created]) {
    console.log(`${APPLY ? '' : '[dry-run] '}usuwam ${c.docId} i plik`);
    if (!APPLY) continue;
    try {
      if (!/^wycieczka\/[A-Za-z0-9]+\/[0-9a-f-]{36}$/.test(c.publicId) || !/^seed[0-9a-f]{16}$/.test(c.docId)) throw new Error('wpis nie wygląda na zasiany przez ten skrypt, pomijam');
      const d = await http(`${fsBase}/trips/${c.tripId}/memories/${c.docId}`, { method: 'DELETE', headers: fsAuth });
      if (d.status !== 200 && d.status !== 404) throw new Error(`dokument: HTTP ${d.status}`);
      for (const type of ['upload', 'authenticated']) { // plik mógł zostać zmigrowany, usuwamy dokładnie te dwa identyfikatory
        const params = { invalidate: 'true', public_id: c.publicId, timestamp: String(Math.floor(Date.now() / 1000)), type };
        const form = new FormData();
        form.set('api_key', apiKey); form.set('signature', signParams(params));
        for (const [k, v] of Object.entries(params)) form.set(k, v);
        const r = await (await http(`https://api.cloudinary.com/v1_1/${cloud}/image/destroy`, { method: 'POST', body: form })).json().catch(() => ({}));
        if (r.result !== 'ok' && r.result !== 'not found') throw new Error(`plik (${type}): ${redact(r.result ?? r.error?.message ?? 'błąd')}`);
      }
      state.created = state.created.filter((x) => x !== c);
      save();
    } catch (e) { failures++; console.log(`BŁĄD: ${redact(e.message)}`); }
  }
  if (!APPLY) console.log('Dry-run: nic nie usunięto.');
}

try { await (cmd === 'seed' ? seed() : cleanup()); } catch (e) { failures++; console.error(`BŁĄD: ${redact(e.message)}`); }
process.exit(failures ? 1 : 0);
