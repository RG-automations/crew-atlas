// Test end-to-end po stronie backendu na ŚRODOWISKU TESTOWYM: konta demo wykonują scenariusze prywatnych mediów
// przez prawdziwy Firebase Auth, Firestore (reguły!), testowy Worker i Cloudinary. Telefon zostaje do interfejsu.
//
// Rodzaj pliku: --media=photo (domyślnie), --media=video lub --media=audio (syntetyczne pliki z worker/fixtures, głosówka to m4a).
// --expiry-test: czeka do końca ważności tokenu mediów i sprawdza, że stary token jest odrzucony, a nowy działa
// (przy MEDIA_TOKEN_TTL=120 trwa ok. 2 minut). Dla --media=video i audio sprawdza też zakres ze środka pliku (przewijanie).
//
// Domyślnie to próba na sucho (tylko wypisuje plan). Zapisuje cokolwiek dopiero z --i-am-using-test-services.
//
//   node tools/e2e-api-check.mjs [--i-am-using-test-services] [--media=photo|video|audio] [--leave-test] [--measure-window] [--expiry-test]
//
// Środowisko (hasła i klucze wpisuj przez `read -rs`, nigdy w argumentach polecenia):
//   WORKER_URL, FIREBASE_API_KEY, FIREBASE_PROJECT_ID  (testowe)
//   E2E_TRIP_ID                                         (podróż założona w aplikacji na koncie członka)
//   E2E_MEMBER_EMAIL,   E2E_MEMBER_PASSWORD             (członek tej podróży, najlepiej jej założyciel)
//   E2E_STRANGER_EMAIL, E2E_STRANGER_PASSWORD           (konto, które NIE należy do podróży)
//   E2E_MEMBER2_EMAIL,  E2E_MEMBER2_PASSWORD            (opcjonalnie, drugi członek: potrzebny do --leave-test)
//   E2E_ANDROID_PACKAGE, E2E_ANDROID_CERT_SHA1         (opcjonalnie: jeśli klucz API ma ograniczenie "aplikacje Android", logowanie
//                                                        przez REST musi podać pakiet i SHA-1 TWOJEJ aplikacji. Bez nich skrypt
//                                                        sprawdza właśnie to, że klucz bez nagłówków aplikacji jest odrzucany)
//   PROD_WORKER_URL, PROD_FIREBASE_PROJECT_ID           (opcjonalnie: skrypt odmówi, jeśli wskazują to samo co testowe)
//
// Tworzy jeden syntetyczny obraz PNG i jedno wspomnienie. Po sobie sprząta: usuwa plik przez Worker i dokument przez
// Firestore, zawsze, także po błędzie. Wypisuje tylko statusy, bez tokenów, haseł i adresów.
import fs from 'node:fs';
import { png } from './lib/png.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const e = process.env;
const MEDIA = (args.find((a) => a.startsWith('--media=')) ?? '--media=photo').slice(8);
const fixture = (f) => fs.readFileSync(new URL(`../worker/fixtures/${f}`, import.meta.url));
const PAY = {
  photo: { resource: 'image', format: 'png', mime: 'image/png', bytes: () => png(7) },
  video: { resource: 'video', format: 'mp4', mime: 'video/mp4', bytes: () => fixture('synthetic-gps.mp4') },
  audio: { resource: 'video', format: 'm4a', mime: 'audio/mp4', bytes: () => fixture('synthetic-voice.m4a') },
}[MEDIA];
if (!PAY) {
  console.error('--media musi mieć wartość photo, video albo audio.');
  process.exit(2);
}
const need = ['WORKER_URL', 'FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'E2E_TRIP_ID', 'E2E_MEMBER_EMAIL', 'E2E_MEMBER_PASSWORD', 'E2E_STRANGER_EMAIL', 'E2E_STRANGER_PASSWORD'];
const missing = need.filter((k) => !e[k]);
if (missing.length) {
  console.error(`Brak zmiennych środowiskowych: ${missing.join(', ')} (patrz nagłówek skryptu).`);
  process.exit(2);
}
if (!/^https:\/\//.test(e.WORKER_URL)) {
  console.error('WORKER_URL musi być adresem https.');
  process.exit(2);
}
if ((e.PROD_WORKER_URL && e.PROD_WORKER_URL.replace(/\/$/, '') === e.WORKER_URL.replace(/\/$/, '')) || (e.PROD_FIREBASE_PROJECT_ID && e.PROD_FIREBASE_PROJECT_ID === e.FIREBASE_PROJECT_ID)) {
  console.error('ODMOWA: to jest środowisko produkcyjne. Skrypt działa wyłącznie na testowym.');
  process.exit(2);
}
if (!/^[A-Za-z0-9]{1,64}$/.test(e.E2E_TRIP_ID)) {
  console.error('E2E_TRIP_ID wygląda nieprawidłowo.');
  process.exit(2);
}
const WORKER = e.WORKER_URL.replace(/\/$/, '');
const TRIP = e.E2E_TRIP_ID;
const STEPS = ['logowanie kont', '/sign: członek, obcy, bez tokenu, stary format', `wysłanie syntetycznego pliku (${MEDIA}) jako authenticated`, 'adres Cloudinary bez podpisu i publiczny typ',
  'reguły Firestore: obcy, zły folder, poprawny wpis', 'token mediów: członek, obcy', 'odczyt przez worker: plik, miniatura, Range, bez tokenu, token w adresie, nagłówki',
  ...(flag('expiry-test') ? ['wygaśnięcie tokenu mediów: stary odrzucony, nowy działa'] : []),
  'usuwanie: obcy, autor, ponowne, wpis', ...(flag('leave-test') ? ['opuszczenie grupy: nowy token odmówiony, okno starego tokenu'] : [])];
if (!flag('i-am-using-test-services')) {
  console.log('Próba na sucho. Scenariusz:');
  STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('Nic nie wykonano. Dodaj --i-am-using-test-services, jeśli WORKER_URL i projekt Firebase są TESTOWE.');
  process.exit(0);
}

const results = [];
const record = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};
const http = (url, init = {}, ms = 60_000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
const redact = (t) => {
  let s = String(t);
  for (const v of [e.E2E_MEMBER_PASSWORD, e.E2E_STRANGER_PASSWORD, e.E2E_MEMBER2_PASSWORD, e.FIREBASE_API_KEY]) if (v) s = s.split(v).join('***');
  return s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
};
const expectStatus = (name, got, allowed) => record(name, allowed.includes(got), `oczekiwano ${allowed.join('/')}, jest HTTP ${got}`);

async function signIn(email, password) {
  const res = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(e.FIREBASE_API_KEY)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(e.E2E_ANDROID_PACKAGE && e.E2E_ANDROID_CERT_SHA1
        ? { 'X-Android-Package': e.E2E_ANDROID_PACKAGE, 'X-Android-Cert': e.E2E_ANDROID_CERT_SHA1.replace(/:/g, '').toUpperCase() }
        : {}),
    },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const b = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`logowanie: HTTP ${res.status} ${redact(b.error?.message ?? '')}`);
  return { token: b.idToken, uid: b.localId };
}
const fsBase = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(e.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
const fsReq = (user, method, p, body) => http(`${fsBase}/${p}`, { method, headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const worker = (user, method, p, body, headers = {}) => http(`${WORKER}${p}`, {
  method, headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body),
});
const memDoc = (uid, publicId) => ({ fields: { placeId: { stringValue: 'e2e' }, type: { stringValue: MEDIA }, publicId: { stringValue: publicId }, resourceType: { stringValue: PAY.resource },
  format: { stringValue: PAY.format }, description: { stringValue: 'E2E synthetic' }, createdBy: { stringValue: uid } } });

let member, stranger, member2;
let publicId = null, docId = null, docCreated = false, assetDeleted = false;
const strayDocs = []; // wpisy, które reguły miały odrzucić, a ktoś je jednak przyjął: też sprzątamy

try {
  // 1
  member = await signIn(e.E2E_MEMBER_EMAIL, e.E2E_MEMBER_PASSWORD);
  stranger = await signIn(e.E2E_STRANGER_EMAIL, e.E2E_STRANGER_PASSWORD);
  record('logowanie członka i obcego', member.uid !== stranger.uid, 'dwa różne konta');
  if (flag('leave-test')) {
    if (!e.E2E_MEMBER2_EMAIL || !e.E2E_MEMBER2_PASSWORD) throw new Error('--leave-test wymaga E2E_MEMBER2_EMAIL i E2E_MEMBER2_PASSWORD');
    member2 = await signIn(e.E2E_MEMBER2_EMAIL, e.E2E_MEMBER2_PASSWORD);
  }

  // 2
  const folder = `wycieczka/${TRIP}`;
  const sg = await worker(member, 'POST', '/sign', { folder, v: 2, kind: MEDIA });
  const sig = sg.status === 200 ? await sg.json() : {};
  record('/sign: członek dostaje podpis `authenticated` w folderze podróży', sg.status === 200 && sig.params?.type === 'authenticated' && sig.params?.public_id?.startsWith(`${folder}/`),
    `HTTP ${sg.status}, type=${sig.params?.type}`);
  // Tryb folderów konta (E2E_FOLDER_MODE=dynamic|fixed): sprawdzamy, że worker faktycznie podpisuje to, co pasuje do konta.
  if (e.E2E_FOLDER_MODE) {
    if (!['fixed', 'dynamic'].includes(e.E2E_FOLDER_MODE)) throw new Error('E2E_FOLDER_MODE: fixed albo dynamic.');
    const dyn = e.E2E_FOLDER_MODE === 'dynamic';
    record(`/sign: tryb folderów ${e.E2E_FOLDER_MODE}: ${dyn ? 'asset_folder = folder podróży i prefiks public_id' : 'bez asset_folder'}`,
      sg.status === 200 && (dyn ? sig.params?.asset_folder === folder && sig.params?.public_id?.startsWith(`${folder}/`) : sig.params?.asset_folder === undefined),
      `HTTP ${sg.status}, asset_folder ${sig.params?.asset_folder === undefined ? 'brak' : 'jest'}`);
  }
  expectStatus('/sign: obcy dostaje odmowę', (await worker(stranger, 'POST', '/sign', { folder, v: 2 })).status, [403]);
  expectStatus('/sign: bez tokenu', (await worker(null, 'POST', '/sign', { folder, v: 2 })).status, [401]);
  expectStatus('/sign: stary format jest odrzucony', (await worker(member, 'POST', '/sign', { folder })).status, [426]);
  if (sg.status !== 200) throw new Error('bez podpisu nie da się iść dalej');

  // 3
  const bytes = PAY.bytes();
  const form = new FormData();
  form.set('api_key', sig.apiKey);
  form.set('signature', sig.signature);
  for (const [k, v] of Object.entries(sig.params)) form.set(k, v);
  form.set('file', new Blob([bytes], { type: PAY.mime }), `e2e.${PAY.format}`);
  const up = await http(`https://api.cloudinary.com/v1_1/${sig.cloud}/${PAY.resource}/upload`, { method: 'POST', body: form }, 120_000);
  const ub = await up.json().catch(() => ({}));
  publicId = ub.public_id ?? null;
  record(`wysłanie pliku (${MEDIA}): Cloudinary potwierdza typ authenticated i podpisany public_id`, up.status === 200 && ub.type === 'authenticated' && ub.public_id === sig.params.public_id,
    `HTTP ${up.status}, type=${ub.type}${ub.error ? `, ${redact(ub.error.message)}` : ''}`);
  if (up.status !== 200 || ub.public_id !== sig.params.public_id) throw new Error('upload nie powiódł się');
  const fileId = publicId.split('/').pop();

  // 4
  const base = `https://res.cloudinary.com/${sig.cloud}/${PAY.resource}`;
  expectStatus('Cloudinary: adres typu authenticated bez podpisu', (await http(`${base}/authenticated/${publicId}.${PAY.format}`, { redirect: 'manual' })).status, [401, 403, 404]);
  expectStatus('Cloudinary: ten sam plik jako publiczny `upload`', (await http(`${base}/upload/${publicId}.${PAY.format}`, { redirect: 'manual' })).status, [401, 403, 404]);

  // 5 (reguły Firestore na prawdziwej bazie)
  docId = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const mustReject = async (name, user, suffix, doc) => {
    const r = await fsReq(user, 'POST', `trips/${TRIP}/memories?documentId=${docId}${suffix}`, doc);
    if (r.status === 200) strayDocs.push(`${docId}${suffix}`);
    expectStatus(name, r.status, [403]);
  };
  await mustReject('Firestore: obcy nie dodaje wspomnienia do cudzej podróży', stranger, 'x', memDoc(stranger.uid, publicId));
  await mustReject('Firestore: wspomnienie ze złym folderem odrzucone', member, 'y', memDoc(member.uid, `wycieczka/INNA${TRIP}/${fileId}`));
  await mustReject('Firestore: wspomnienie w cudzym imieniu odrzucone', member, 'z', memDoc(stranger.uid, publicId));
  const created = await fsReq(member, 'POST', `trips/${TRIP}/memories?documentId=${docId}`, memDoc(member.uid, publicId));
  docCreated = created.status === 200;
  expectStatus('Firestore: członek dodaje wspomnienie z prywatnym plikiem', created.status, [200]);
  expectStatus('Firestore: obcy nie czyta wspomnienia', (await fsReq(stranger, 'GET', `trips/${TRIP}/memories/${docId}`)).status, [403]);

  // 6
  const tk = await worker(member, 'POST', '/media/token', { tripId: TRIP });
  const tok = tk.status === 200 ? await tk.json() : {};
  record('token mediów: członek', tk.status === 200 && !!tok.token, `HTTP ${tk.status}, ważny ${tok.expiresAt ? Math.round(tok.expiresAt - Date.now() / 1000) : '?'} s`);
  expectStatus('token mediów: obcy', (await worker(stranger, 'POST', '/media/token', { tripId: TRIP })).status, [403]);

  // 7
  const path = `/media/${PAY.resource}/${TRIP}/${fileId}.${PAY.format}`;
  let auth = { authorization: `Bearer ${tok.token}` };
  const full = await http(`${WORKER}${path}`, { headers: auth });
  const buf = Buffer.from(await full.arrayBuffer());
  record('worker: członek czyta plik, bajty zgodne z wysłanymi', full.status === 200 && buf.equals(bytes), `HTTP ${full.status}, ${buf.length} B`);
  record('worker: nagłówki prywatne, bez Location i adresu Cloudinary', full.headers.get('cache-control') === 'private, no-store' && !full.headers.has('location')
    && !JSON.stringify([...full.headers.entries()]).includes('cloudinary'), `cache-control=${full.headers.get('cache-control')}`);
  if (MEDIA !== 'audio') expectStatus('worker: miniatura', (await http(`${WORKER}${path}?thumb=1`, { headers: auth })).status, [200]);
  const rg = await http(`${WORKER}${path}`, { headers: { ...auth, range: 'bytes=0-9' } });
  const rb = Buffer.from(await rg.arrayBuffer());
  record('worker: Range zwraca 206 i dokładnie 10 bajtów', rg.status === 206 && rb.length === 10 && rb.equals(bytes.subarray(0, 10)), `HTTP ${rg.status}, ${rb.length} B, ${rg.headers.get('content-range')}`);
  if (MEDIA !== 'photo') {
    // przewijanie: odtwarzacz prosi o zakres ze środka pliku
    const a = Math.floor(bytes.length / 3), b = a + 99;
    const mid = await http(`${WORKER}${path}`, { headers: { ...auth, range: `bytes=${a}-${b}` } });
    const mb = Buffer.from(await mid.arrayBuffer());
    record('worker: zakres ze środka pliku (przewijanie) zwraca 206 i właściwe bajty', mid.status === 206 && mb.equals(bytes.subarray(a, b + 1)), `HTTP ${mid.status}, ${mb.length} B, ${mid.headers.get('content-range')}`);
    const tail = await http(`${WORKER}${path}`, { headers: { ...auth, range: 'bytes=-50' } });
    const tb = Buffer.from(await tail.arrayBuffer());
    record('worker: zakres od końca (moov na końcu pliku) zwraca 206 i ostatnie bajty', tail.status === 206 && tb.equals(bytes.subarray(bytes.length - 50)), `HTTP ${tail.status}, ${tb.length} B`);
  }
  expectStatus('worker: bez tokenu', (await http(`${WORKER}${path}`)).status, [401]);
  expectStatus('worker: token w adresie nie działa', (await http(`${WORKER}${path}?t=${encodeURIComponent(tok.token)}`)).status, [401]);
  expectStatus('worker: ścieżka innej podróży z tym tokenem', (await http(`${WORKER}/media/${PAY.resource}/${TRIP}X/${fileId}.${PAY.format}`, { headers: auth })).status, [403, 404]);
  expectStatus('worker: podstawiony identyfikator', (await http(`${WORKER}/media/${PAY.resource}/${TRIP}/..%2F${fileId}.${PAY.format}`, { headers: auth })).status, [400, 404]);

  // wygaśnięcie tokenu
  if (flag('expiry-test')) {
    const t1 = await (await worker(member, 'POST', '/media/token', { tripId: TRIP })).json().catch(() => ({}));
    const a1 = { authorization: `Bearer ${t1.token}` };
    expectStatus('wygaśnięcie: świeży token działa', (await http(`${WORKER}${path}`, { headers: a1 })).status, [200]);
    const waitMs = Math.max(0, t1.expiresAt * 1000 - Date.now()) + 3000;
    console.log(`INFO  czekam ${Math.round(waitMs / 1000)} s na wygaśnięcie tokenu`);
    await new Promise((r) => setTimeout(r, waitMs));
    expectStatus('wygaśnięcie: po końcu ważności stary token jest odrzucony', (await http(`${WORKER}${path}`, { headers: a1 })).status, [401]);
    const t2 = await (await worker(member, 'POST', '/media/token', { tripId: TRIP })).json().catch(() => ({}));
    auth = { authorization: `Bearer ${t2.token}` }; // dalsze kroki używają nowego tokenu
    expectStatus('wygaśnięcie: nowy token działa', (await http(`${WORKER}${path}`, { headers: auth })).status, [200]);
  }

  // opuszczenie grupy
  if (member2) {
    const t2 = await (await worker(member2, 'POST', '/media/token', { tripId: TRIP })).json().catch(() => ({}));
    if (!t2.token) {
      record('opuszczenie grupy: drugi członek nie ma tokenu (nie należy do podróży?)', false, 'dołącz konto kodem w aplikacji i powtórz');
    } else {
      const a2 = { authorization: `Bearer ${t2.token}` };
      expectStatus('drugi członek czyta plik przed wyjściem', (await http(`${WORKER}${path}`, { headers: a2 })).status, [200]);
      const trip = await (await fsReq(member2, 'GET', `trips/${TRIP}`)).json();
      const ids = (trip.fields?.memberIds?.arrayValue?.values ?? []).filter((v) => v.stringValue !== member2.uid);
      const t0 = Date.now();
      const leave = await fsReq(member2, 'PATCH', `trips/${TRIP}?updateMask.fieldPaths=memberIds`, { fields: { memberIds: { arrayValue: { values: ids } } } });
      expectStatus('drugi członek opuszcza podróż (reguły dopuszczają wyjście)', leave.status, [200]);
      expectStatus('po wyjściu: nowy token odmówiony', (await worker(member2, 'POST', '/media/token', { tripId: TRIP })).status, [403]);
      const stillOk = (await http(`${WORKER}${path}`, { headers: a2 })).status;
      console.log(`INFO  po wyjściu stary token daje HTTP ${stillOk} (200 jest dopuszczalne do końca jego ważności)`);
      if (flag('measure-window')) {
        const until = t2.expiresAt * 1000 + 60_000;
        let status = stillOk;
        while (status === 200 && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 5000));
          status = (await http(`${WORKER}${path}`, { headers: a2 })).status;
        }
        const win = Math.round((Date.now() - t0) / 1000);
        const ttl = Math.round(t2.expiresAt - t0 / 1000);
        record('okno dostępu po wyjściu nie przekracza ważności tokenu', status === 401 && win <= ttl + 10, `zmierzone ${win} s, ważność tokenu przy wyjściu ${ttl} s`);
      }
      // przywrócenie członkostwa nie jest możliwe z tego konta bez kodu zaproszenia: przypomnij o tym
      console.log('INFO  konto drugiego członka opuściło podróż. Dołącz je ponownie kodem zaproszenia, jeśli chcesz powtórzyć test.');
    }
  }

  // 8 usuwanie
  const delPath = `/media/memory/${TRIP}/${docId}`;
  expectStatus('usuwanie: obcy dostaje odmowę, plik zostaje', (await worker(stranger, 'DELETE', delPath)).status, [403]);
  expectStatus('plik nadal czytelny po próbie obcego', (await http(`${WORKER}${path}`, { headers: auth })).status, [200]);
  expectStatus('usuwanie: token mediów nie wystarcza', (await http(`${WORKER}${delPath}`, { method: 'DELETE', headers: auth })).status, [401]);
  const d1 = await worker(member, 'DELETE', delPath);
  assetDeleted = d1.status === 200;
  expectStatus('usuwanie: autor usuwa plik w Cloudinary', d1.status, [200]);
  expectStatus('po usunięciu worker zwraca 404', (await http(`${WORKER}${path}`, { headers: auth })).status, [404]);
  expectStatus('ponowne usuwanie jest idempotentne (wpis jeszcze istnieje)', (await worker(member, 'DELETE', delPath)).status, [200]);
  expectStatus('obcy nie usunie wpisu z Firestore', (await fsReq(stranger, 'DELETE', `trips/${TRIP}/memories/${docId}`)).status, [403]);
  const dd = await fsReq(member, 'DELETE', `trips/${TRIP}/memories/${docId}`);
  expectStatus('autor usuwa wpis z Firestore', dd.status, [200]);
  if (dd.status === 200) docCreated = false;
} catch (err) {
  console.error(`BŁĄD: ${redact(err.message)}`);
  results.push(false);
} finally {
  // sprzątanie: zawsze, dokładnie to, co ten przebieg utworzył
  try {
    if (member && docCreated && docId) {
      if (!assetDeleted) await worker(member, 'DELETE', `/media/memory/${TRIP}/${docId}`).catch(() => {});
      await fsReq(member, 'DELETE', `trips/${TRIP}/memories/${docId}`).catch(() => {});
      console.log('INFO  sprzątanie: wpis testowy usunięty');
    }
    for (const stray of strayDocs) await fsReq(member, 'DELETE', `trips/${TRIP}/memories/${stray}`).catch(() => {});
    if (strayDocs.length) console.log(`WARN  reguły przyjęły ${strayDocs.length} wpisów, które miały odrzucić: usunięte, ale popraw reguły`);
    if (publicId && !assetDeleted && !docCreated) console.log(`WARN  mógł zostać plik testowy ${publicId}: usuń go ręcznie w konsoli Cloudinary (folder wycieczka/${TRIP}/)`);
  } catch (err) {
    console.log(`WARN  sprzątanie: ${redact(err.message)}`);
  }
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length} z ${results.length} sprawdzeń)`);
process.exit(ok ? 0 : 1);
