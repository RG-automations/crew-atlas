// Migracja istniejących PUBLICZNYCH plików Cloudinary (type=upload) do prywatnych (type=authenticated).
// Domyślnie wszystko jest próbą na sucho: bez --apply skrypt tylko czyta i mówi, co by zrobił.
//
//   node tools/migrate-media-to-private.mjs <polecenie> --backup-dir <KATALOG POZA PROJEKTEM> [--apply] [--yes-delete-public] [--state plik]
//
// --backup-dir jest WYMAGANY i nie ma wartości domyślnej: kopie to prywatne zdjęcia grupy. Skrypt odmawia, jeśli katalog leży
// w repozytorium Git, w katalogu projektu (pubspec.yaml, firebase.json), w folderze synchronizowanym (marker Syncthing
// .stfolder, Dropbox, OneDrive, Google Drive, iCloud, Nextcloud) albo jeśli to ten sam katalog co projekt.
// Pliki powstają z uprawnieniami 600, katalogi 700. Plik stanu domyślnie leży w katalogu kopii (--state <plik> to zmienia).
//
//   plan       lista wpisów do migracji (tylko odczyt). Z --apply zapisuje plik stanu.
//   backup     pobiera oryginały do katalogu kopii (SHA-256 i JSON dokumentu). Wymagane przed copy.
//   copy       kopiuje plik do Cloudinary jako authenticated (ten sam public_id). Publiczny oryginał zostaje.
//   link       dopisuje do dokumentu publicId, resourceType i format. Pole url zostaje (starsze aplikacje).
//   verify     sprawdza: adres bez podpisu odrzucony, plik z podpisem ma te same bajty co kopia, dokument ma pola.
//   finalize   usuwa publiczne oryginały i pole url. Wymaga --apply --yes-delete-public i tego, żeby KAŻDY wpis
//              przeszedł verify. Dopiero tego kroku nie da się cofnąć poleceniem rollback (jest restore z kopii).
//   rollback   (przed finalize) usuwa prywatne kopie i dopisane pola. Publiczne pliki nigdy nie były ruszone.
//   restore    (po finalize) odtwarza publiczne pliki i pole url z kopii lokalnej.
//   status     podsumowanie pliku stanu.
//
// Wznawianie: stan zapisuje się po każdym wpisie. Ponowne uruchomienie pomija to, co już zrobione.
//
// Środowisko (nigdy w argumentach polecenia): CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
// FIREBASE_PROJECT_ID, GCLOUD_ACCESS_TOKEN (token właściciela projektu: export GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token);
// działa z uprawnieniami właściciela i omija reguły, więc plik klucza konta serwisowego nie jest potrzebny).
//
// Wyjście zawiera tylko identyfikatory wpisów i statusy: bez adresów, tokenów i sekretów.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const APPLY = flag('apply');
const BACKUP = opt('backup-dir', null);
const STATE = opt('state', BACKUP ? path.join(BACKUP, 'state.json') : null);

// Kopie i stan zawierają prywatne zdjęcia i adresy. Nie mogą trafić do Gita, do katalogu projektu ani do folderu,
// który ktoś synchronizuje z innymi urządzeniami.
const MARKERS = ['.stfolder', '.git', '.dropbox', '.dropbox.cache', '.nextcloudsync.log', 'pubspec.yaml', 'firebase.json'];
const SYNC_NAMES = /^(dropbox|onedrive.*|google ?drive|googledrive|icloud.*|nextcloud|syncthing|mega|megasync)$/i;
function assertSafeLocation(target, label) {
  if (flag('allow-unsafe-location')) return;
  for (let d = path.resolve(target); ; d = path.dirname(d)) {
    const hit = MARKERS.find((m) => fs.existsSync(path.join(d, m))) ?? (SYNC_NAMES.test(path.basename(d)) ? `folder o nazwie ${path.basename(d)}` : null);
    if (hit) {
      throw new Error(`${label} leży w ${d}, gdzie jest ${hit} (repozytorium, projekt albo folder synchronizowany). Wskaż katalog poza nimi. `
        + 'Świadome obejście: --allow-unsafe-location.');
    }
    if (path.dirname(d) === d) break;
  }
}

const { CLOUDINARY_CLOUD: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret, FIREBASE_PROJECT_ID: project, GCLOUD_ACCESS_TOKEN: gtoken } = process.env;
const COMMANDS = ['plan', 'backup', 'copy', 'link', 'verify', 'finalize', 'rollback', 'restore', 'status'];
if (!COMMANDS.includes(cmd)) {
  console.error(`Użycie: node tools/migrate-media-to-private.mjs <${COMMANDS.join('|')}> [--apply] ...`);
  process.exit(2);
}
if (!BACKUP) {
  console.error('Podaj --backup-dir <katalog poza projektem i poza folderami synchronizowanymi>.');
  process.exit(2);
}
try {
  assertSafeLocation(BACKUP, 'Katalog kopii');
  assertSafeLocation(path.dirname(path.resolve(STATE)), 'Plik stanu');
} catch (e) {
  console.error(`ODMOWA: ${e.message}`);
  process.exit(2);
}
if (cmd !== 'status' && (!cloud || !apiKey || !secret || !project || !gtoken || !/^[A-Za-z0-9_-]{1,64}$/.test(cloud))) {
  console.error('Ustaw CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, FIREBASE_PROJECT_ID i GCLOUD_ACCESS_TOKEN w środowisku.');
  process.exit(2);
}

const redact = (t) => {
  let s = String(t);
  for (const v of [secret, apiKey, gtoken]) if (v) s = s.split(v).join('***');
  return s.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
};
const http = (url, init = {}, ms = 60_000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha1 = (t) => createHash('sha1').update(t).digest();
const signParams = (p) => sha1(Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&') + secret).toString('hex');
const deliverySig = (p) => `s--${sha1(p + secret).toString('base64url').slice(0, 8)}--`;

// ---------- stan (zapis atomowy po każdym wpisie) ----------
const loadState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
function saveState(st) {
  const tmp = `${STATE}.tmp`;
  fs.mkdirSync(path.dirname(path.resolve(STATE)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

// ---------- Firestore (REST, token właściciela) ----------
const fsBase = () => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents`;
const fsAuth = () => ({ authorization: `Bearer ${gtoken}`, 'content-type': 'application/json' });
const sval = (doc, k) => doc?.fields?.[k]?.stringValue;

async function listMemories() {
  const res = await http(`${fsBase()}:runQuery`, {
    method: 'POST', headers: fsAuth(),
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'memories', allDescendants: true }] } }),
  });
  if (res.status !== 200) throw new Error(`Firestore runQuery: HTTP ${res.status}`);
  return (await res.json()).filter((r) => r.document).map((r) => r.document);
}
async function getDoc(tripId, memId, { missingOk = false } = {}) {
  const res = await http(`${fsBase()}/trips/${tripId}/memories/${memId}`, { headers: fsAuth() });
  if (res.status === 404 && missingOk) return null; // wspomnienie usunięte w międzyczasie
  if (res.status !== 200) throw new Error(`Firestore get: HTTP ${res.status}`);
  return res.json();
}
// Zmienia tylko wymienione pola; pola z maski bez wartości w body są usuwane. Dokument musi istnieć.
async function patchDoc(tripId, memId, set, remove = [], { missingOk = false } = {}) {
  const mask = [...Object.keys(set), ...remove].map((f) => `updateMask.fieldPaths=${f}`).join('&');
  const fields = Object.fromEntries(Object.entries(set).map(([k, v]) => [k, { stringValue: v }]));
  const res = await http(`${fsBase()}/trips/${tripId}/memories/${memId}?${mask}&currentDocument.exists=true`, {
    method: 'PATCH', headers: fsAuth(), body: JSON.stringify({ fields }),
  });
  if (res.status === 404 && missingOk) return 'missing';
  if (res.status !== 200) throw new Error(`Firestore patch: HTTP ${res.status}`);
  return 'ok';
}

// ---------- Cloudinary ----------
const deliveryUrl = (it, type) => {
  if (type === 'upload') return it.url;
  const p = `${it.publicId}.${it.format}`;
  return `https://res.cloudinary.com/${cloud}/${it.resource}/authenticated/${deliverySig(p)}/${p}`;
};
async function cldPost(resource, action, params, file) {
  const form = new FormData();
  form.set('api_key', apiKey);
  form.set('signature', signParams(params));
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  if (file !== undefined) form.set('file', file);
  const res = await http(`https://api.cloudinary.com/v1_1/${cloud}/${resource}/${action}`, { method: 'POST', body: form }, 120_000);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const ts = () => String(Math.floor(Date.now() / 1000));
async function destroy(it, type) {
  const { body } = await cldPost(it.resource, 'destroy', { invalidate: 'true', public_id: it.publicId, timestamp: ts(), type });
  if (body.result !== 'ok' && body.result !== 'not found') throw new Error(`destroy ${type}: ${redact(body.result ?? body.error?.message ?? 'błąd')}`);
}

// ---------- plan ----------
function parseLegacy(doc, cloudName) {
  const parts = doc.name.split('/');
  const memId = parts.at(-1), tripId = parts.at(-3);
  const url = sval(doc, 'url');
  if (!url) return null; // nowy wpis albo bez pliku
  if (sval(doc, 'publicId')) return null; // już prywatny
  const m = new RegExp(`^https://res\\.cloudinary\\.com/${cloudName}/(image|video)/upload/(?:v\\d+/)?(.+)\\.([A-Za-z0-9]{2,5})$`).exec(url);
  const base = { key: `${tripId}/${memId}`, tripId, memId };
  if (!m) return { ...base, skip: 'adres nie pasuje do tego konta Cloudinary' };
  const [, resource, publicId, format] = m;
  if (!new RegExp(`^wycieczka/${tripId}/[A-Za-z0-9_-]{8,64}$`).test(publicId)) {
    return { ...base, skip: 'public_id poza folderem tej podróży' };
  }
  return { ...base, url, resource, publicId, format: format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase() };
}

async function plan() {
  const docs = await listMemories();
  const found = docs.map((d) => parseLegacy(d, cloud)).filter(Boolean);
  const items = found.filter((x) => !x.skip), skipped = found.filter((x) => x.skip);
  console.log(`Wspomnień w bazie: ${docs.length}. Do migracji: ${items.length}. Pominięte: ${skipped.length}.`);
  for (const s of skipped) console.log(`  pominięto ${s.key}: ${s.skip}`);
  for (const i of items) console.log(`  ${APPLY ? 'zapisano' : '[dry-run] byłoby zapisane'}: ${i.key} (${i.resource}, .${i.format})`);
  if (!APPLY) return console.log('Dry-run: nic nie zapisano. Dodaj --apply, żeby zapisać plik stanu.');
  const st = loadState() ?? { version: 1, items: {} };
  for (const i of items) st.items[i.key] ??= { ...i };
  st.skipped = skipped.map((s) => ({ key: s.key, reason: s.skip }));
  saveState(st);
  console.log(`Stan zapisany (${Object.keys(st.items).length} wpisów).`);
}

// ---------- polecenia na wpisach ----------
let failures = 0;
async function eachItem(st, label, eligible, work) {
  const todo = Object.values(st.items).filter(eligible);
  console.log(`${label}: ${todo.length} z ${Object.keys(st.items).length} wpisów do zrobienia.`);
  if (!APPLY) {
    for (const it of todo) console.log(`  [dry-run] ${label}: ${it.key}`);
    return console.log('Dry-run: nic nie zmieniono. Dodaj --apply.');
  }
  for (const it of todo) {
    try {
      await work(it);
      delete it.error;
      console.log(`  ok: ${it.key}`);
    } catch (e) {
      it.error = redact(e.message);
      failures++;
      console.log(`  BŁĄD: ${it.key}: ${it.error}`);
    }
    saveState(st); // wznowienie po przerwaniu
  }
}

const backupPath = (it) => path.join(BACKUP, it.tripId, `${it.memId}.${it.format}`);
// Kopia zapasowa jest kompletna tylko wtedy, gdy plik istnieje i ma zapisaną sumę. Sprawdzamy to przed każdym
// krokiem, który od niej zależy (copy, finalize), bo plik mógł zniknąć lub zostać zmieniony po backupie.
const backupOk = (it) => {
  try {
    return sha256(fs.readFileSync(backupPath(it))) === it.sha256;
  } catch {
    return false;
  }
};

async function backup(st) {
  await eachItem(st, 'backup', (i) => !i.backup && !i.gone, async (it) => {
    const doc = await getDoc(it.tripId, it.memId, { missingOk: true });
    if (!doc) {
      it.gone = true; // wspomnienie usunięte po planie: nie ma czego migrować
      return;
    }
    const res = await http(it.url, { redirect: 'manual' });
    if (res.status !== 200) throw new Error(`pobranie oryginału: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const len = Number(res.headers.get('content-length'));
    if (len && len !== buf.length) throw new Error('niepełne pobranie');
    const dir = path.join(BACKUP, it.tripId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(backupPath(it), buf, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, `${it.memId}.doc.json`), JSON.stringify(doc, null, 2), { mode: 0o600 });
    it.sha256 = sha256(buf);
    it.size = buf.length;
    if (!backupOk(it)) throw new Error('kopia zapasowa nie zgadza się z pobranym plikiem po zapisie na dysk'); // odczyt zwrotny
    it.backup = true;
  });
}
const copy = (st) => eachItem(st, 'copy', (i) => i.backup && !i.copied && !i.gone, async (it) => {
  if (!backupOk(it)) throw new Error('kopia zapasowa uszkodzona lub jej brak: nie kopiuję');
  // Źródłem jest publiczny adres: Cloudinary pobiera plik sam. Ten sam public_id, ale inny typ dostępu.
  const params = { overwrite: 'false', public_id: it.publicId, timestamp: ts(), type: 'authenticated' };
  const { status, body } = await cldPost(it.resource, 'upload', { ...params }, it.url);
  const exists = /already exists/i.test(body.error?.message ?? ''); // poprzednia próba zdążyła
  if (!exists && (status !== 200 || body.type !== 'authenticated' || body.public_id !== it.publicId)) {
    throw new Error(`upload: ${redact(body.error?.message ?? `HTTP ${status}`)}`);
  }
  it.copied = true;
});
const link = (st) => eachItem(st, 'link', (i) => i.copied && !i.linked && !i.gone, async (it) => {
  const r = await patchDoc(it.tripId, it.memId, { publicId: it.publicId, resourceType: it.resource, format: it.format }, [], { missingOk: true });
  if (r === 'missing') {
    // Wspomnienie usunięte między kopiowaniem a powiązaniem: sprzątamy prywatną kopię, żeby nie została bez wpisu.
    await destroy(it, 'authenticated');
    it.gone = true;
    it.copied = false;
    return;
  }
  it.linked = true;
});

async function verifyOne(it) {
  const problems = [];
  const status = async (u) => (await http(u, { redirect: 'manual' })).status;
  const unsigned = await status(`https://res.cloudinary.com/${cloud}/${it.resource}/authenticated/${it.publicId}.${it.format}`);
  if (![401, 403, 404].includes(unsigned)) problems.push(`adres bez podpisu: HTTP ${unsigned}`);
  const signed = await http(deliveryUrl(it, 'authenticated'), { redirect: 'manual' });
  if (signed.status !== 200) problems.push(`adres z podpisem: HTTP ${signed.status}`);
  else if (sha256(Buffer.from(await signed.arrayBuffer())) !== it.sha256) problems.push('bajty różnią się od kopii zapasowej');
  const doc = await getDoc(it.tripId, it.memId);
  if (sval(doc, 'publicId') !== it.publicId || sval(doc, 'resourceType') !== it.resource || sval(doc, 'format') !== it.format) {
    problems.push('dokument nie ma poprawnych pól publicId, resourceType, format');
  }
  return problems;
}
async function verify(st) {
  const todo = Object.values(st.items).filter((i) => i.linked && !i.gone);
  console.log(`verify: ${todo.length} wpisów.`);
  for (const it of todo) {
    let problems;
    try {
      problems = await verifyOne(it);
    } catch (e) {
      problems = [redact(e.message)];
    }
    it.verified = problems.length === 0;
    it.error = problems.length ? problems.join('; ') : undefined;
    if (problems.length) failures++;
    console.log(`  ${it.verified ? 'PASS' : 'FAIL'}: ${it.key}${problems.length ? ` (${problems.join('; ')})` : ''}`);
    saveState(st);
  }
  if (APPLY === false) console.log('(verify nie zmienia nic poza plikiem stanu)');
}

async function finalize(st) {
  const items = Object.values(st.items);
  const live = items.filter((i) => !i.gone);
  const bad = live.filter((i) => !i.verified && !i.publicDeleted);
  const noBackup = live.filter((i) => !backupOk(i));
  if (noBackup.length) {
    console.log(`finalize ODMOWA: ${noBackup.length} wpisów nie ma kompletnej kopii zapasowej (${noBackup.slice(0, 5).map((b) => b.key).join(', ')}). Bez niej restore nie byłby możliwy. Nic nie usunięto.`);
    failures++;
    return;
  }
  if (bad.length) {
    console.log(`finalize ODMOWA: ${bad.length} wpisów nie przeszło verify (${bad.slice(0, 5).map((b) => b.key).join(', ')}). Nic nie usunięto.`);
    failures++;
    return;
  }
  if (APPLY && !flag('yes-delete-public')) {
    console.log('finalize ODMOWA: to usuwa publiczne oryginały. Dodaj --yes-delete-public, jeśli to zamierzasz.');
    failures++;
    return;
  }
  await eachItem(st, 'finalize', (i) => !i.publicDeleted && !i.gone, async (it) => {
    await destroy(it, 'upload'); // publiczny oryginał
    await patchDoc(it.tripId, it.memId, {}, ['url'], { missingOk: true }); // starsze aplikacje przestają widzieć martwy adres
    const after = (await http(it.url, { redirect: 'manual' })).status;
    if (after === 200) throw new Error('publiczny adres nadal działa (CDN?), sprawdź za chwilę');
    it.publicDeleted = true;
  });
}

const rollback = (st) => eachItem(st, 'rollback', (i) => (i.copied || i.linked) && !i.publicDeleted, async (it) => {
  await destroy(it, 'authenticated');
  await patchDoc(it.tripId, it.memId, {}, ['publicId', 'resourceType', 'format'], { missingOk: true });
  it.copied = it.linked = it.verified = false;
});
const restore = (st) => eachItem(st, 'restore', (i) => i.publicDeleted && !i.gone, async (it) => {
  const file = fs.readFileSync(path.join(BACKUP, it.tripId, `${it.memId}.${it.format}`));
  if (sha256(file) !== it.sha256) throw new Error('kopia lokalna nie zgadza się z zapisaną sumą');
  const { status, body } = await cldPost(it.resource, 'upload', { overwrite: 'false', public_id: it.publicId, timestamp: ts(), type: 'upload' },
    new Blob([file]));
  if (status !== 200 && !/already exists/i.test(body.error?.message ?? '')) throw new Error(`upload: ${redact(body.error?.message ?? `HTTP ${status}`)}`);
  await patchDoc(it.tripId, it.memId, { url: it.url });
  it.publicDeleted = false;
});

function status(st) {
  const v = Object.values(st.items);
  const n = (f) => v.filter(f).length;
  console.log(`wpisów ${v.length}: backup ${n((i) => i.backup)}, copy ${n((i) => i.copied)}, link ${n((i) => i.linked)}, verified ${n((i) => i.verified)}, publiczne usunięte ${n((i) => i.publicDeleted)}, z błędem ${n((i) => i.error)}, usunięte w międzyczasie ${n((i) => i.gone)}`);
}

try {
  if (cmd === 'plan') await plan();
  else {
    const st = loadState();
    if (!st) {
      console.error('Brak pliku stanu. Najpierw: plan --apply');
      process.exit(2);
    }
    await { backup, copy, link, verify, finalize, rollback, restore, status: async (s) => status(s) }[cmd](st);
  }
} catch (e) {
  console.error(`BŁĄD: ${redact(e.message)}`);
  failures++;
}
process.exit(failures ? 1 : 0);
