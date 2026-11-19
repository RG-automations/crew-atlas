// Kontrola wstępna testowego workera: tylko żądania BEZ logowania, nic nie zapisuje.
// Sprawdza, że to właściwa wersja workera (prywatne media, bez proxy mapy), że sekrety są ustawione i że to nie produkcja.
//
//   WORKER_URL=https://... [PROD_WORKER_URL=https://...] [MAPTILER_KEY=...] node tools/e2e-preflight.mjs
//
// Wypisuje tylko PASS/FAIL i statusy. Adresów i kluczy nie wypisuje. MAPTILER_KEY (opcjonalny) służy do jednego
// zapytania o styl mapy (zużywa pojedyncze żądanie z puli darmowego planu).
const { WORKER_URL, PROD_WORKER_URL, MAPTILER_KEY } = process.env;
if (!WORKER_URL || !/^https:\/\//.test(WORKER_URL)) {
  console.error('Ustaw WORKER_URL (https) testowego workera.');
  process.exit(2);
}
const base = WORKER_URL.replace(/\/$/, '');
if (PROD_WORKER_URL && PROD_WORKER_URL.replace(/\/$/, '') === base) {
  console.error('ODMOWA: WORKER_URL to adres produkcyjny.');
  process.exit(2);
}
const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};
const http = (p, init = {}) => fetch(`${base}${p}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
const id = 'abcdefgh12';
try {
  let r = await http('/health');
  check('worker odpowiada', r.status === 200 && (await r.json().catch(() => ({}))).ok === true, `HTTP ${r.status}`);
  r = await http('/sign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"folder":"wycieczka/X","v":2}' });
  check('/sign bez tokenu: 401', r.status === 401, `HTTP ${r.status}`);
  r = await http('/media/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tripId":"X"}' });
  check('/media/token bez tokenu: 401 (500 oznacza brak MEDIA_TOKEN_SECRET lub starą wersję)', r.status === 401, `HTTP ${r.status}`);
  r = await http(`/media/image/X/${id}.jpg`);
  check('plik bez tokenu: 401 (500 oznacza brak MEDIA_TOKEN_SECRET)', r.status === 401, `HTTP ${r.status}`);
  check('odpowiedź o odmowie nie trafia do pamięci podręcznej', r.headers.get('cache-control') === 'private, no-store', `cache-control=${r.headers.get('cache-control')}`);
  r = await http(`/media/memory/X/abc`, { method: 'DELETE' });
  check('usuwanie bez tokenu: 401', r.status === 401, `HTTP ${r.status}`);
  r = await http('/session');
  check('dawne proxy mapy nie istnieje (/session: 404)', r.status === 404, `HTTP ${r.status}`);
  r = await http('/m/tiles/v3/1/2/3.pbf?t=x');
  check('dawne proxy kafelków nie istnieje (/m/*: 404)', r.status === 404, `HTTP ${r.status}`);
  if (MAPTILER_KEY) {
    const m = await fetch(`https://api.maptiler.com/maps/streets-v2/style.json?key=${encodeURIComponent(MAPTILER_KEY)}`, { signal: AbortSignal.timeout(20_000) });
    check('klucz MapTiler działa (styl mapy)', m.status === 200, `HTTP ${m.status}`);
  } else console.log('INFO  MAPTILER_KEY nie ustawiony: sprawdzenie klucza pominięte');
} catch (e) {
  console.error(`BŁĄD: ${String(e.message).replace(/https?:\/\/\S+/g, '<url>').slice(0, 150)}`);
  results.push(false);
}
const ok = results.length > 0 && results.every(Boolean);
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
