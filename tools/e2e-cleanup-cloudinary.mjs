// Sprzątanie po A2 w wariancie B (testy na obecnym koncie Cloudinary). Usuwa WYŁĄCZNIE dokładnie wskazane syntetyczne pliki,
// zapisane w manifeście konkretnego przebiegu testów. Nigdy folderu, prefiksu ani wildcardu.
//
//   1) manifest: lista plików z wspomnień TESTOWEJ podróży (Firestore testowy, konto członka) na standardowe wyjście:
//      node tools/e2e-cleanup-cloudinary.mjs manifest --i-am-using-test-services --since <początek testów, ISO> [--add-id image:wycieczka/<podróż>/<id>] > manifest.json
//   2) sprawdzenie (domyślnie na sucho, nic nie jest usuwane):
//      node tools/e2e-cleanup-cloudinary.mjs delete --manifest manifest.json --confirm-cloud <nazwa chmury> --confirm-project <id projektu testowego>
//   3) usunięcie: to samo z dodatkowym --delete
//
// Zmienne (poświadczenia wpisuj przez `read -rs`, nigdy w argumentach):
//   manifest: WORKER_URL niepotrzebny; FIREBASE_API_KEY, FIREBASE_PROJECT_ID, E2E_TRIP_ID, E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD (+ PROD_FIREBASE_PROJECT_ID)
//   delete:   CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//   PROD_FIREBASE_PROJECT_ID, PROD_TRIP_IDS (lista po przecinku), PROD_CLOUDINARY_CLOUD: wartości produkcyjne, na które skrypt odmawia działania.
//   Wariant B używa tego samego konta Cloudinary co produkcja, więc przy PROD_CLOUDINARY_CLOUD równym CLOUDINARY_CLOUD trzeba świadomie dodać
//   --shared-cloud-variant-b. Reszta zabezpieczeń nie zależy od nazwy chmury, tylko od dokładnych identyfikatorów i dat plików.
// Zabezpieczenia przy delete: manifest musi zgadzać się z CLOUDINARY_CLOUD, --confirm-cloud i --confirm-project; każdy identyfikator ma kształt
// wycieczka/<podróż z manifestu>/<id>; każdy plik musi istnieć w Cloudinary, mieć typ authenticated i powstać po `since`
// (jeśli choć jeden jest starszy lub nieznany, nic nie jest usuwane); najwyżej 50 plików; usuwane są tylko te identyfikatory.
// Odmawia, jeśli plik manifestu leży w katalogu repozytorium. Nie zapisuje plików na dysk (manifest idzie na stdout), nie wypisuje poświadczeń, adresów ani identyfikatorów plików.
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (n) => args.includes(`--${n}`);
const vals = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const e = process.env;
const fail = (m, c = 2) => { console.error(m); process.exit(c); };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const prodTrips = (e.PROD_TRIP_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const assetRe = (trip) => new RegExp(`^wycieczka/${trip}/[A-Za-z0-9_-]{8,64}$`);
const http = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });

if (mode === 'manifest') {
  if (!flag('i-am-using-test-services')) fail('Dodaj --i-am-using-test-services, jeśli projekt Firebase jest TESTOWY.');
  const since = Date.parse(vals('since')[0] ?? '');
  if (Number.isNaN(since)) fail('Podaj --since <czas ISO>: początek testów.');
  for (const k of ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'E2E_TRIP_ID', 'E2E_MEMBER_EMAIL', 'E2E_MEMBER_PASSWORD']) if (!e[k]) fail(`Brak zmiennej środowiskowej ${k}.`);
  if (!ID.test(e.E2E_TRIP_ID)) fail('E2E_TRIP_ID wygląda nieprawidłowo.');
  if (e.PROD_FIREBASE_PROJECT_ID === e.FIREBASE_PROJECT_ID) fail('ODMOWA: to jest projekt produkcyjny.');
  if (prodTrips.includes(e.E2E_TRIP_ID)) fail('ODMOWA: to id produkcyjnej podróży.');
  const trip = e.E2E_TRIP_ID;
  const si = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(e.FIREBASE_API_KEY)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e.E2E_MEMBER_EMAIL, password: e.E2E_MEMBER_PASSWORD, returnSecureToken: true }),
  });
  if (si.status !== 200) fail(`logowanie: HTTP ${si.status}`, 1);
  const idToken = (await si.json()).idToken;
  const list = await http(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(e.FIREBASE_PROJECT_ID)}/databases/(default)/documents/trips/${trip}/memories?pageSize=300`, { headers: { authorization: `Bearer ${idToken}` } });
  if (list.status !== 200) fail(`lista wspomnień: HTTP ${list.status}`, 1);
  const resources = [];
  for (const d of (await list.json()).documents ?? []) {
    const pid = d.fields?.publicId?.stringValue, rt = d.fields?.resourceType?.stringValue;
    if (assetRe(trip).test(pid ?? '') && ['image', 'video'].includes(rt)) resources.push({ rt, id: pid });
  }
  for (const a of vals('add-id')) {
    const [rt, id] = String(a).split(':');
    if (!['image', 'video'].includes(rt) || !assetRe(trip).test(id ?? '')) fail('--add-id musi mieć postać image|video:wycieczka/<ta podróż>/<id>.');
    if (!resources.some((r) => r.id === id)) resources.push({ rt, id });
  }
  process.stdout.write(`${JSON.stringify({ version: 1, firebaseProject: e.FIREBASE_PROJECT_ID, tripId: trip, since: new Date(since).toISOString(), resources }, null, 2)}\n`);
  console.error(`INFO  manifest: ${resources.length} plików testowej podróży (wypisano na stdout, zapisz do pliku przekierowaniem)`);
  process.exit(0);
}

if (mode !== 'delete') fail('Użycie: e2e-cleanup-cloudinary.mjs manifest|delete (patrz nagłówek skryptu).');
const path = vals('manifest')[0];
if (!path) fail('Podaj --manifest <plik>.');
// Manifest nie może leżeć w repozytorium (łatwo go wtedy przypadkiem zacommitować): trzymaj go poza nim.
const repoRoot = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
let manifestReal;
try { manifestReal = fs.realpathSync(path); } catch { fail('Manifest nieczytelny lub nie jest JSON.'); }
if (manifestReal === repoRoot || manifestReal.startsWith(repoRoot + nodePath.sep)) fail('ODMOWA: manifest leży w katalogu repozytorium. Zapisz go poza nim, np. w ~/.cache/crewatlas-e2e/.');
let m;
try { m = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { fail('Manifest nieczytelny lub nie jest JSON.'); }
for (const k of ['CLOUDINARY_CLOUD', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) if (!e[k]) fail(`Brak zmiennej środowiskowej ${k}.`);
if (!ID.test(e.CLOUDINARY_CLOUD)) fail('CLOUDINARY_CLOUD wygląda nieprawidłowo.');
const since = Date.parse(m.since ?? '');
if (m.version !== 1 || !ID.test(m.tripId ?? '') || !ID.test(m.firebaseProject ?? '') || Number.isNaN(since) || !Array.isArray(m.resources)) fail('Manifest ma nieprawidłowy kształt.');
if (vals('confirm-cloud')[0] !== e.CLOUDINARY_CLOUD) fail('ODMOWA: --confirm-cloud musi być równe CLOUDINARY_CLOUD (potwierdź, na którym koncie działasz).');
if (vals('confirm-project')[0] !== m.firebaseProject) fail('ODMOWA: --confirm-project musi być równe projektowi Firebase zapisanemu w manifeście.');
if (e.PROD_FIREBASE_PROJECT_ID === m.firebaseProject) fail('ODMOWA: manifest pochodzi z projektu produkcyjnego.');
if (prodTrips.includes(m.tripId)) fail('ODMOWA: manifest dotyczy produkcyjnej podróży.');
if (e.PROD_CLOUDINARY_CLOUD && e.PROD_CLOUDINARY_CLOUD === e.CLOUDINARY_CLOUD && !flag('shared-cloud-variant-b')) {
  fail('ODMOWA: to jest chmura produkcyjna. Wariant B świadomie używa tego samego konta: dodaj --shared-cloud-variant-b, jeśli o to chodzi.');
}
if (m.resources.length === 0) fail('Manifest nie zawiera plików.', 1);
if (m.resources.length > 50) fail('ODMOWA: ponad 50 plików, to nie jest mały test.', 1);
const seen = new Set();
for (const r of m.resources) {
  if (!['image', 'video'].includes(r.rt) || !assetRe(m.tripId).test(r.id ?? '') || seen.has(r.id)) fail('ODMOWA: manifest zawiera identyfikator spoza podróży testowej, zły albo powtórzony.', 1);
  seen.add(r.id);
}
const base = `https://api.cloudinary.com/v1_1/${e.CLOUDINARY_CLOUD}`;
const headers = { authorization: `Basic ${Buffer.from(`${e.CLOUDINARY_API_KEY}:${e.CLOUDINARY_API_SECRET}`).toString('base64')}` };

// Każdy plik z osobna: istnieje, jest authenticated, powstał po początku testów. Wystarczy jedna niezgodność, żeby nic nie usuwać.
let bad = 0;
for (const r of m.resources) {
  const res = await http(`${base}/resources/${r.rt}/authenticated/${r.id.split('/').map(encodeURIComponent).join('/')}`, { headers });
  if (res.status === 404) { console.log('INFO  plik z manifestu już nie istnieje (pomijam)'); r.gone = true; continue; }
  if (res.status !== 200) fail(`Cloudinary: szczegóły pliku: HTTP ${res.status}`, 1);
  const d = await res.json();
  if (d.public_id !== r.id || d.type !== 'authenticated' || d.resource_type !== r.rt || !(Date.parse(d.created_at) >= since)) bad++;
}
if (bad) fail(`ODMOWA: ${bad} plików nie zgadza się z manifestem (typ, identyfikator albo starszy niż początek testów). Niczego nie usunięto.`, 1);
const todo = m.resources.filter((r) => !r.gone);
console.log(`INFO  do usunięcia: ${todo.length} plików, wszystkie zgodne z manifestem`);
if (!flag('delete')) { console.log('Próba na sucho: nic nie usunięto. Dodaj --delete, aby usunąć dokładnie te pliki.'); process.exit(0); }

let failed = 0;
for (const rt of ['image', 'video']) {
  const ids = todo.filter((r) => r.rt === rt).map((r) => r.id);
  if (!ids.length) continue;
  const q = ids.map((i) => `public_ids[]=${encodeURIComponent(i)}`).join('&');
  const res = await http(`${base}/resources/${rt}/authenticated?${q}&invalidate=true`, { method: 'DELETE', headers });
  if (res.status !== 200) failed++;
  console.log(`${res.status === 200 ? 'PASS' : 'FAIL'}  usunięto ${ids.length} plików typu ${rt} (HTTP ${res.status})`);
}
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
