// A2: czy pliki WYSŁANE przez prawdziwą aplikację (zdjęcie z fałszywym GPS z worker/fixtures/synthetic-gps.jpg, nagrane wideo i głosówka)
// mają jeszcze wrażliwe metadane po drodze telefon -> worker -> Cloudinary -> worker. Tylko do odczytu, tylko środowisko testowe.
//
//   node tools/e2e-inspect-media.mjs --file plik.jpg [--file inny.mp4]        (offline, bez sieci)
//   node tools/e2e-inspect-media.mjs --i-am-using-test-services [--require-video-clean]
//
// Wariant sieciowy pobiera wszystkie wspomnienia podróży E2E_TRIP_ID kontem członka (przez Firestore z regułami i worker z tokenem mediów).
// Zmienne jak w e2e-api-check.mjs: WORKER_URL, FIREBASE_API_KEY, FIREBASE_PROJECT_ID, E2E_TRIP_ID, E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD
// (opcjonalnie E2E_ANDROID_PACKAGE, E2E_ANDROID_CERT_SHA1, PROD_WORKER_URL, PROD_FIREBASE_PROJECT_ID).
// Zdjęcia: FAIL, jeśli jest cokolwiek poza Orientation. Wideo i dźwięk: GPS to FINDING (nie zakładamy, że są czyste); z --require-video-clean to FAIL.
// Nie zapisuje plików na dysk, nie wypisuje tokenów, adresów ani identyfikatorów plików.
import fs from 'node:fs';
import { inspectMedia } from './lib/inspect-media.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const files = args.flatMap((a, i) => (a === '--file' ? [args[i + 1]] : []));
const e = process.env;
const results = [];
const report = (label, buf, strictMedia) => {
  const r = inspectMedia(buf);
  const photo = r.format === 'jpeg' || r.format === 'png';
  let ok = r.bad.length === 0;
  let word = ok ? 'PASS' : 'FAIL';
  if (!photo && !ok && !strictMedia) { word = 'FINDING'; ok = true; }
  if (r.format === 'unknown') { word = 'FAIL'; ok = false; }
  results.push(ok);
  console.log(`${word}  ${label} (${r.format}, ${buf.length} B): ${r.bad.length ? `znaleziono ${r.bad.join(', ')}` : 'brak wrażliwych metadanych'}${r.info?.length ? `; informacyjnie: ${r.info.join(', ')}` : ''}`);
};

if (files.length) {
  for (const f of files) report(`plik ${files.indexOf(f) + 1}`, fs.readFileSync(f), true);
} else {
  const need = ['WORKER_URL', 'FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'E2E_TRIP_ID', 'E2E_MEMBER_EMAIL', 'E2E_MEMBER_PASSWORD'];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) { console.error(`Brak zmiennych środowiskowych: ${missing.join(', ')}`); process.exit(2); }
  if (!/^https:\/\//.test(e.WORKER_URL) || !/^[A-Za-z0-9_-]{1,64}$/.test(e.E2E_TRIP_ID)) { console.error('WORKER_URL (https) lub E2E_TRIP_ID nieprawidłowe.'); process.exit(2); }
  if ((e.PROD_WORKER_URL && e.PROD_WORKER_URL.replace(/\/$/, '') === e.WORKER_URL.replace(/\/$/, '')) || (e.PROD_FIREBASE_PROJECT_ID && e.PROD_FIREBASE_PROJECT_ID === e.FIREBASE_PROJECT_ID)) {
    console.error('ODMOWA: to jest środowisko produkcyjne.'); process.exit(2);
  }
  if (!flag('i-am-using-test-services')) { console.log('Nic nie wykonano. Dodaj --i-am-using-test-services, jeśli WORKER_URL i projekt Firebase są TESTOWE.'); process.exit(0); }
  const WORKER = e.WORKER_URL.replace(/\/$/, '');
  const http = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  try {
    const si = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(e.FIREBASE_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(e.E2E_ANDROID_PACKAGE && e.E2E_ANDROID_CERT_SHA1 ? { 'X-Android-Package': e.E2E_ANDROID_PACKAGE, 'X-Android-Cert': e.E2E_ANDROID_CERT_SHA1.replace(/:/g, '').toUpperCase() } : {}) },
      body: JSON.stringify({ email: e.E2E_MEMBER_EMAIL, password: e.E2E_MEMBER_PASSWORD, returnSecureToken: true }),
    });
    const sb = await si.json().catch(() => ({}));
    if (si.status !== 200) throw new Error(`logowanie: HTTP ${si.status}`);
    const idToken = sb.idToken;
    const list = await http(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(e.FIREBASE_PROJECT_ID)}/databases/(default)/documents/trips/${e.E2E_TRIP_ID}/memories?pageSize=300`, { headers: { authorization: `Bearer ${idToken}` } });
    if (list.status !== 200) throw new Error(`lista wspomnień: HTTP ${list.status}`);
    const docs = (await list.json()).documents ?? [];
    const tk = await http(`${WORKER}/media/token`, { method: 'POST', headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ tripId: e.E2E_TRIP_ID }) });
    const token = (await tk.json().catch(() => ({}))).token;
    if (tk.status !== 200 || !token) throw new Error(`token mediów: HTTP ${tk.status}`);
    console.log(`INFO  wspomnień w podróży: ${docs.length}`);
    let n = 0;
    for (const d of docs) {
      const f = (k) => d.fields?.[k]?.stringValue;
      const id = /^wycieczka\/[^/]+\/([A-Za-z0-9_-]{8,64})$/.exec(f('publicId') ?? '')?.[1];
      if (!id || !['image', 'video'].includes(f('resourceType')) || !/^[a-z0-9]{2,5}$/.test(f('format') ?? '')) { console.log('INFO  pominięto wpis bez poprawnego pliku'); continue; }
      const res = await http(`${WORKER}/media/${f('resourceType')}/${e.E2E_TRIP_ID}/${id}.${f('format')}`, { headers: { authorization: `Bearer ${token}` } });
      n++;
      if (res.status !== 200) { results.push(false); console.log(`FAIL  ${f('type') ?? f('resourceType')} #${n}: worker zwrócił HTTP ${res.status}`); continue; }
      report(`${f('type') ?? f('resourceType')} #${n}`, Buffer.from(await res.arrayBuffer()), flag('require-video-clean'));
    }
    if (!n) { results.push(false); console.log('FAIL  brak plików do sprawdzenia (wyślij zdjęcie, wideo i głosówkę z aplikacji)'); }
  } catch (err) {
    console.error(`BŁĄD: ${String(err.message).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200)}`);
    results.push(false);
  }
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length} z ${results.length} sprawdzeń; FINDING liczy się jako zaliczone, ale wymaga decyzji)`);
process.exit(ok ? 0 : 1);
