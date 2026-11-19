// A2: zakłada w TESTOWYM Firebase nową fikcyjną podróż "Lisbon A2 Media Test" z trzema członkami. Nie rusza istniejących dokumentów.
// Konta (Ada A2, Ben A2, Cleo A2, Dan A2) tworzysz ręcznie w Firebase Console. Skrypt tylko loguje się na nie i zapisuje dane pod regułami.
//
//   node tools/e2e-seed-a2-trip.mjs --expect-project <id projektu testowego> [--i-am-using-test-services]
//
// Domyślnie próba na sucho: wypisuje dokładny zakres zapisów i niczego nie zapisuje.
// Środowisko (hasła przez `read -rs`, nigdy w argumentach): FIREBASE_API_KEY, FIREBASE_PROJECT_ID, PROD_FIREBASE_PROJECT_ID (opcjonalnie),
//   A2_ADA_EMAIL/A2_ADA_PASSWORD, A2_BEN_EMAIL/A2_BEN_PASSWORD, A2_CLEO_EMAIL/A2_CLEO_PASSWORD, A2_DAN_EMAIL/A2_DAN_PASSWORD (Dan: tylko logowanie, bez zapisu).
// Zapisy: users/<uid> dla Ady, Bena i Cleo (nazwa); jedna paczka (commit) Ady: trips/<nowy id> + invites/<kod>, oba z warunkiem "nie istnieje";
// dołączenie Bena i Cleo kodem (PATCH memberIds, memberNames.<uid>, joinCode). Dan nie dostaje żadnego zapisu i nie jest członkiem.
// Wypisuje identyfikator nowej podróży (to nie sekret) i statusy. Bez haseł, tokenów i adresów.
import { randomInt } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const expect = args[args.indexOf('--expect-project') + 1];
const e = process.env;
const fail = (m, c = 2) => { console.error(m); process.exit(c); };
const who = [['ADA', 'Ada A2'], ['BEN', 'Ben A2'], ['CLEO', 'Cleo A2'], ['DAN', 'Dan A2']];
const miss = ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', ...who.flatMap(([k]) => [`A2_${k}_EMAIL`, `A2_${k}_PASSWORD`])].filter((k) => !e[k]);
if (!args.includes('--expect-project') || !expect) fail('Podaj --expect-project <id projektu testowego> (potwierdzenie środowiska).');
if (e.FIREBASE_PROJECT_ID !== expect) fail('ODMOWA: FIREBASE_PROJECT_ID różni się od --expect-project.');
if (e.PROD_FIREBASE_PROJECT_ID && e.PROD_FIREBASE_PROJECT_ID === e.FIREBASE_PROJECT_ID) fail('ODMOWA: to jest projekt produkcyjny.');
const NAME = 'Lisbon A2 Media Test';
const plan = [`projekt: ${expect}`, `logowanie: ${who.map(([, n]) => n).join(', ')} (Dan tylko logowanie)`, 'users/<uid>: nazwa, dla Ady, Bena i Cleo (zapis własnego profilu)',
  `trips/<nowy id> + invites/<nowy kod> jedną paczką jako Ada A2 (name="${NAME}", destination="Lisbon", baseCurrency="EUR", warunek: dokument nie istnieje)`,
  'Ben A2 i Cleo A2 dołączają kodem (PATCH memberIds, memberNames.<uid>, joinCode)', 'Dan A2: bez zapisów, poza podróżą', 'istniejące dokumenty (np. "Lisbon Group Trip") nie są dotykane'];
if (!flag('i-am-using-test-services')) {
  console.log('Próba na sucho. Zakres zapisów:'); plan.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('Nic nie zapisano. Dodaj --i-am-using-test-services, jeśli projekt jest TESTOWY.'); process.exit(0);
}
if (miss.length) fail(`Brak zmiennych środowiskowych: ${miss.join(', ')}`);

const http = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(expect)}/databases/(default)/documents`;
const root = `projects/${expect}/databases/(default)/documents`;
const s = (v) => ({ stringValue: v });
async function signIn(email, password) {
  const r = await http(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(e.FIREBASE_API_KEY)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const b = await r.json().catch(() => ({}));
  if (r.status !== 200) throw new Error(`logowanie ${email.split('@')[0]}: HTTP ${r.status} ${String(b.error?.message ?? '').slice(0, 60)}`);
  return { token: b.idToken, uid: b.localId };
}
const auth = (u) => ({ authorization: `Bearer ${u.token}`, 'content-type': 'application/json' });
const alnum = (n, alphabet) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
const results = [];
const rec = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` (${d})` : ''}`); };
try {
  const u = {};
  for (const [k] of who) u[k] = await signIn(e[`A2_${k}_EMAIL`], e[`A2_${k}_PASSWORD`]);
  if (new Set(Object.values(u).map((x) => x.uid)).size !== 4) throw new Error('konta muszą być czterema różnymi użytkownikami');
  rec('logowanie czterech kont testowych', true);
  for (const [k, n] of who.slice(0, 3)) {
    const r = await http(`${base}/users/${u[k].uid}?updateMask.fieldPaths=name`, { method: 'PATCH', headers: auth(u[k]), body: JSON.stringify({ fields: { name: s(n) } }) });
    rec(`profil ${n}`, r.status === 200, `HTTP ${r.status}`);
  }
  const tripId = alnum(20, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const code = alnum(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  const tripName = `${root}/trips/${tripId}`;
  const commit = await http(`${base}:commit`, { method: 'POST', headers: auth(u.ADA), body: JSON.stringify({ writes: [
    { update: { name: tripName, fields: { name: s(NAME), destination: s('Lisbon'), start: { nullValue: null }, end: { nullValue: null }, baseCurrency: s('EUR'), inviteCode: s(code), createdBy: s(u.ADA.uid),
      memberIds: { arrayValue: { values: [s(u.ADA.uid)] } }, memberNames: { mapValue: { fields: { [u.ADA.uid]: s('Ada A2') } } } } },
      currentDocument: { exists: false }, updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] },
    { update: { name: `${root}/invites/${code}`, fields: { tripId: s(tripId), createdBy: s(u.ADA.uid) } }, currentDocument: { exists: false } },
  ] }) });
  rec('Ada A2 zakłada podróż i zaproszenie (jedna paczka, nowe dokumenty)', commit.status === 200, `HTTP ${commit.status}`);
  if (commit.status !== 200) throw new Error('bez podróży nie da się iść dalej');
  for (const [k, n] of [['BEN', 'Ben A2'], ['CLEO', 'Cleo A2']]) {
    const cur = await (await http(`${base}/trips/${tripId}`, { headers: auth(u.ADA) })).json();
    const ids = [...(cur.fields.memberIds.arrayValue.values ?? []).map((v) => v.stringValue), u[k].uid];
    const r = await http(`${base}/trips/${tripId}?updateMask.fieldPaths=memberIds&updateMask.fieldPaths=memberNames.${u[k].uid}&updateMask.fieldPaths=joinCode`, { method: 'PATCH', headers: auth(u[k]),
      body: JSON.stringify({ fields: { memberIds: { arrayValue: { values: ids.map(s) } }, memberNames: { mapValue: { fields: { [u[k].uid]: s(n) } } }, joinCode: s(code) } }) });
    rec(`${n} dołącza kodem`, r.status === 200, `HTTP ${r.status}`);
  }
  const fin = await (await http(`${base}/trips/${tripId}`, { headers: auth(u.ADA) })).json().catch(() => ({}));
  const members = (fin.fields?.memberIds?.arrayValue?.values ?? []).map((v) => v.stringValue);
  rec('skład podróży: Ada, Ben, Cleo, bez Dana', members.length === 3 && ['ADA', 'BEN', 'CLEO'].every((k) => members.includes(u[k].uid)) && !members.includes(u.DAN.uid), `${members.length} członków`);
  const dan = await http(`${base}/trips/${tripId}`, { headers: auth(u.DAN) });
  rec('Dan A2 nie ma dostępu do podróży (reguły)', dan.status === 403, `HTTP ${dan.status}`);
  console.log(`INFO  E2E_TRIP_ID=${tripId}`);
} catch (err) {
  console.error(`BŁĄD: ${String(err.message).slice(0, 160)}`);
  results.push(false);
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
