// A2 etap 1: autoryzacja testowego workera BEZ Cloudinary. Konta demo, prawdziwy Firebase Auth i Firestore (reguły), testowy worker.
// Niczego nie wysyła do Cloudinary i niczego nie zapisuje. Zaliczenie NIE znaczy, że media działają (to etap 2).
//
//   node tools/e2e-auth-check.mjs [--i-am-using-test-services] [--expiry-test] [--cloudinary-configured]
//
// Domyślnie próba na sucho. Domyślnie oczekuje, że worker NIE ma jeszcze Cloudinary (/sign i pliki odpowiadają 500 "not configured"):
// jeśli ma, skrypt zgłosi FAIL, bo to znak, że worker może być podłączony do prawdziwego konta. Po etapie 2 dodaj --cloudinary-configured.
// Środowisko jak w e2e-api-check.mjs: WORKER_URL, FIREBASE_API_KEY, FIREBASE_PROJECT_ID, E2E_TRIP_ID, E2E_MEMBER_*, E2E_STRANGER_*
// (opcjonalnie E2E_OTHER_TRIP_ID: podróż, do której członek NIE należy, E2E_WORKER_NAME, domyślnie crew-atlas-worker-test,
// E2E_ANDROID_PACKAGE/E2E_ANDROID_CERT_SHA1, PROD_WORKER_URL, PROD_FIREBASE_PROJECT_ID).
// Wypisuje tylko statusy: bez tokenów, haseł, adresów i treści odpowiedzi.
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const e = process.env;
const need = ['WORKER_URL', 'FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'E2E_TRIP_ID', 'E2E_MEMBER_EMAIL', 'E2E_MEMBER_PASSWORD', 'E2E_STRANGER_EMAIL', 'E2E_STRANGER_PASSWORD'];
const missing = need.filter((k) => !e[k]);
if (missing.length) { console.error(`Brak zmiennych środowiskowych: ${missing.join(', ')} (patrz nagłówek skryptu).`); process.exit(2); }
let host;
try { const u = new URL(e.WORKER_URL); if (u.protocol !== 'https:') throw new Error(); host = u.hostname; } catch { console.error('WORKER_URL musi być adresem https.'); process.exit(2); }
const name = e.E2E_WORKER_NAME || 'crew-atlas-worker-test';
if (!host.startsWith(`${name}.`)) { console.error(`ODMOWA: adres workera musi zaczynać się od "${name}." (osobny worker testowy).`); process.exit(2); }
if ((e.PROD_WORKER_URL && e.PROD_WORKER_URL.replace(/\/$/, '') === e.WORKER_URL.replace(/\/$/, '')) || (e.PROD_FIREBASE_PROJECT_ID && e.PROD_FIREBASE_PROJECT_ID === e.FIREBASE_PROJECT_ID)) {
  console.error('ODMOWA: to jest środowisko produkcyjne.'); process.exit(2);
}
if (!/^[A-Za-z0-9]{1,64}$/.test(e.E2E_TRIP_ID) || (e.E2E_OTHER_TRIP_ID && !/^[A-Za-z0-9]{1,64}$/.test(e.E2E_OTHER_TRIP_ID))) { console.error('Identyfikator podróży wygląda nieprawidłowo.'); process.exit(2); }
if (!flag('i-am-using-test-services')) {
  console.log('Próba na sucho. Scenariusz: /health, token mediów (członek, obcy, bez tokenu, uszkodzony, alg=none, nieistniejąca i cudza podróż), token mediów w obcej podróży i uszkodzony, /sign i usuwanie bez uprawnień, brak wycieku w odpowiedziach'
    + `${flag('expiry-test') ? ', wygaśnięcie tokenu' : ''}.`);
  console.log('Nic nie wykonano. Dodaj --i-am-using-test-services, jeśli WORKER_URL i projekt Firebase są TESTOWE.');
  process.exit(0);
}

const WORKER = e.WORKER_URL.replace(/\/$/, ''), TRIP = e.E2E_TRIP_ID;
const results = [];
const record = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` (${d})` : ''}`); };
const expect = (n, got, allowed) => record(n, allowed.includes(got), `oczekiwano ${allowed.join('/')}, jest HTTP ${got}`);
const bodies = [];
const http = async (url, init = {}) => {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  const text = await res.clone().text().catch(() => '');
  if (String(url).startsWith(WORKER)) bodies.push(text + JSON.stringify([...res.headers.entries()]));
  return res;
};
const redact = (t) => { let s = String(t); for (const v of [e.E2E_MEMBER_PASSWORD, e.E2E_STRANGER_PASSWORD, e.FIREBASE_API_KEY]) if (v) s = s.split(v).join('***'); return s.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200); };
async function signIn(email, password) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(e.FIREBASE_API_KEY)}`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', ...(e.E2E_ANDROID_PACKAGE && e.E2E_ANDROID_CERT_SHA1 ? { 'X-Android-Package': e.E2E_ANDROID_PACKAGE, 'X-Android-Cert': e.E2E_ANDROID_CERT_SHA1.replace(/:/g, '').toUpperCase() } : {}) },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const b = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`logowanie: HTTP ${res.status} ${redact(b.error?.message ?? '')}`);
  return b.idToken;
}
const post = (p, token, body) => http(`${WORKER}${p}`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const mediaToken = (t, trip = TRIP) => post('/media/token', t, { tripId: trip });
const flip = (s) => s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const file = (trip, t, extra = {}) => http(`${WORKER}/media/image/${trip}/abcdefgh12.png`, { headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra } });
const accepted = flag('cloudinary-configured') ? [200, 404] : [500]; // token przyjęty; bez Cloudinary worker mówi "not configured"

try {
  const member = await signIn(e.E2E_MEMBER_EMAIL, e.E2E_MEMBER_PASSWORD);
  const stranger = await signIn(e.E2E_STRANGER_EMAIL, e.E2E_STRANGER_PASSWORD);
  expect('worker odpowiada (/health)', (await http(`${WORKER}/health`)).status, [200]);

  // tokeny Firebase
  const mk = await mediaToken(member);
  const mt = mk.status === 200 ? await mk.json() : {};
  record('token mediów: członek testowej podróży', mk.status === 200 && !!mt.token, `HTTP ${mk.status}, ważny ${mt.expiresAt ? Math.round(mt.expiresAt - Date.now() / 1000) : '?'} s`);
  expect('token mediów: obcy (nie należy do podróży)', (await mediaToken(stranger)).status, [403]);
  expect('token mediów: bez tokenu logowania', (await mediaToken(null)).status, [401]);
  expect('token mediów: losowy ciąg zamiast tokenu', (await mediaToken('nie-jest-tokenem')).status, [401]);
  const [h, p, sg] = member.split('.');
  expect('token mediów: token Firebase z uszkodzonym podpisem', (await mediaToken(`${h}.${p}.${flip(sg)}`)).status, [401]);
  expect('token mediów: token z alg=none bez podpisu', (await mediaToken(`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`)).status, [401]);
  expect('token mediów: token z podmienioną treścią (inny uid)', (await mediaToken(`${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'ktos-inny' })}.${sg}`)).status, [401]);
  expect('token mediów: nieistniejąca podróż', (await mediaToken(member, `NIEMA${Date.now().toString(36)}`)).status, [403]);
  if (e.E2E_OTHER_TRIP_ID) expect('token mediów: cudza podróż (członek nie należy)', (await mediaToken(member, e.E2E_OTHER_TRIP_ID)).status, [403]);
  expect('token mediów: zły format identyfikatora podróży', (await mediaToken(member, '../x')).status, [400, 401, 403, 404]);

  // tokeny mediów
  if (mt.token) {
    expect('plik: ważny token własnej podróży jest przyjęty', (await file(TRIP, mt.token)).status, accepted);
    expect('plik: token tej podróży w obcej podróży', (await file(`${TRIP}X`, mt.token)).status, [403]);
    expect('plik: uszkodzony token mediów', (await file(TRIP, flip(mt.token))).status, [401]);
    expect('plik: token w adresie zamiast nagłówka', (await http(`${WORKER}/media/image/${TRIP}/abcdefgh12.png?t=${encodeURIComponent(mt.token)}`)).status, [401]);
    expect('plik: token Firebase zamiast tokenu mediów', (await file(TRIP, member)).status, [401]);
  }
  expect('plik: bez tokenu', (await file(TRIP, null)).status, [401]);

  // /sign i usuwanie
  const sgn = (t, body) => post('/sign', t, body);
  expect('/sign: bez tokenu', (await sgn(null, { folder: `wycieczka/${TRIP}`, v: 2 })).status, [401]);
  expect('/sign: obcy', (await sgn(stranger, { folder: `wycieczka/${TRIP}`, v: 2 })).status, [403]);
  expect('/sign: stary format', (await sgn(member, { folder: `wycieczka/${TRIP}` })).status, [426]);
  expect('/sign: zły folder', (await sgn(member, { folder: `wycieczka/${TRIP}/../x`, v: 2 })).status, [400]);
  const sm = await sgn(member, { folder: `wycieczka/${TRIP}`, v: 2 });
  if (flag('cloudinary-configured')) expect('/sign: członek dostaje podpis', sm.status, [200]);
  else expect('/sign: członek, ale worker bez Cloudinary odmawia podpisu ("not configured")', sm.status, [500]);
  const del = (t) => http(`${WORKER}/media/memory/${TRIP}/nieistniejace1`, { method: 'DELETE', headers: t ? { authorization: `Bearer ${t}` } : {} });
  expect('usuwanie: bez tokenu', (await del(null)).status, [401]);
  expect('usuwanie: obcy', (await del(stranger)).status, [403]);
  expect('usuwanie: nieistniejący wpis (członek)', (await del(member)).status, [403, 404]);
  expect('usuwanie: token mediów nie wystarcza', (await del(mt.token)).status, [401]);
  expect('dawne proxy mapy nie istnieje (/session)', (await http(`${WORKER}/session`)).status, [404]);
  expect('dawne proxy kafelków nie istnieje (/m/*)', (await http(`${WORKER}/m/x`)).status, [404]);

  // wygaśnięcie tokenu mediów
  if (flag('expiry-test') && mt.token) {
    const waitMs = Math.max(0, mt.expiresAt * 1000 - Date.now()) + 3000;
    console.log(`INFO  czekam ${Math.round(waitMs / 1000)} s na wygaśnięcie tokenu mediów`);
    await new Promise((r) => setTimeout(r, waitMs));
    expect('wygaśnięcie: stary token mediów jest odrzucony', (await file(TRIP, mt.token)).status, [401]);
    const fresh = await (await mediaToken(member)).json().catch(() => ({}));
    expect('wygaśnięcie: nowy token jest przyjęty', (await file(TRIP, fresh.token)).status, accepted);
  }

  // brak wycieku w żadnej odpowiedzi workera (treść i nagłówki)
  const all = bodies.join('\n');
  const secrets = [e.E2E_MEMBER_PASSWORD, e.E2E_STRANGER_PASSWORD, e.FIREBASE_API_KEY, member, stranger].filter(Boolean);
  record('odpowiedzi workera nie zawierają haseł, kluczy ani tokenów logowania', !secrets.some((s) => all.includes(s)));
  record('odpowiedzi workera nie zawierają adresów Cloudinary ani słowa secret', !/cloudinary\.com|secret/i.test(all.replace(/not configured/g, '')));
  record('odpowiedzi workera nie zawierają śladów stosu', !/\bat \w+.*\(.*:\d+:\d+\)|TypeError|ReferenceError/.test(all));
} catch (err) {
  console.error(`BŁĄD: ${redact(err.message)}`);
  results.push(false);
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length} z ${results.length} sprawdzeń; dotyczy autoryzacji, media NIE były sprawdzane)`);
process.exit(ok ? 0 : 1);
