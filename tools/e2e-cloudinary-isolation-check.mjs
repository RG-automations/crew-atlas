// T6: czy sekret OGRANICZONEGO klucza Cloudinary podpisuje dostarczanie prywatnego pliku spoza folderu testowego?
// Dotyka wyłącznie jednego syntetycznego zasobu kontrolnego C2 (folder `crewatlas-a2-control-*`), tylko odczyt (GET z Range 0-0).
// Nigdy nie czyta ani nie zmienia plików `wycieczka/...` (zdjęcia podróży, także produkcyjne): odmawia takiego id.
//
//   node tools/e2e-cloudinary-isolation-check.mjs --i-am-using-test-services --manifest <plik poza repo> [--format png]
//
// Zmienne (wpisuj przez `read -rs`, nigdy w argumentach): CLOUDINARY_CLOUD, CTRL_PUBLIC_ID (np. crewatlas-a2-control-outside/<id>),
//   CLD_ADMIN_SECRET (sekret kontrolny: tylko liczy podpis lokalnie, żadnych wywołań Admin API), CLD_TEST_SECRET (sekret ograniczonego klucza).
//   PROD_CLOUDINARY_CLOUD: jeśli równe CLOUDINARY_CLOUD (wariant B), trzeba dodać --shared-cloud-variant-b.
// Wynik: tylko kody HTTP i PASS/FAIL. Adresów ani sekretów nie wypisuje. FAIL izolacji (200/206 z podpisem ograniczonego klucza)
// kończy się kodem 1 i komunikatem, że testów mediów nie wolno kontynuować.
import fs from 'node:fs';
import nodePath from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const e = process.env;
const fail = (m) => { console.error(`ODMOWA: ${m}`); process.exit(2); };

if (!flag('i-am-using-test-services')) fail('dodaj --i-am-using-test-services (to dotyka prawdziwego konta Cloudinary, tylko zasobu kontrolnego).');
for (const k of ['CLOUDINARY_CLOUD', 'CTRL_PUBLIC_ID', 'CLD_ADMIN_SECRET', 'CLD_TEST_SECRET']) if (!e[k]) fail(`brak zmiennej ${k}.`);
if (e.CLD_ADMIN_SECRET === e.CLD_TEST_SECRET) fail('sekrety kontrolny i ograniczony są takie same: test nic nie dowodzi.');
if (e.PROD_CLOUDINARY_CLOUD && e.PROD_CLOUDINARY_CLOUD === e.CLOUDINARY_CLOUD && !flag('shared-cloud-variant-b')) fail('to chmura produkcyjna; przy wariancie B dodaj --shared-cloud-variant-b.');
const id = e.CTRL_PUBLIC_ID;
const fmt = val('format', 'png');
if (!/^crewatlas-a2-control-[a-z0-9-]*\/[A-Za-z0-9_-]{8,64}$/.test(id)) fail('CTRL_PUBLIC_ID musi mieć postać crewatlas-a2-control-<nazwa>/<id>. Pliki wycieczka/... są zakazane.');
if (!/^(png|jpg)$/.test(fmt)) fail('--format: png albo jpg.');

// Id musi być wpisane w manifeście spoza repozytorium (ten sam, z którego potem sprzątamy).
const manifest = val('manifest');
if (!manifest) fail('podaj --manifest <plik>.');
const repo = fs.realpathSync(nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..'));
let real;
try { real = fs.realpathSync(manifest); } catch { fail('manifest nie istnieje.'); }
if (real === repo || real.startsWith(repo + nodePath.sep)) fail('plik manifestu leży w katalogu repozytorium.');
if (!fs.readFileSync(real, 'utf8').includes(id)) fail('identyfikator zasobu kontrolnego nie występuje w manifeście.');

const path = `${id}.${fmt}`;
const sign = (secret) => `s--${crypto.createHash('sha1').update(path + secret).digest('base64url').slice(0, 8)}--`;
const url = (sig) => `https://res.cloudinary.com/${encodeURIComponent(e.CLOUDINARY_CLOUD)}/image/authenticated/${sig ? `${sig}/` : ''}${path}`;
const status = async (u) => (await fetch(u, { redirect: 'manual', headers: { range: 'bytes=0-0', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })).status;
const ok = (s) => s === 200 || s === 206;

let bad = 0;
const rec = (pass, text, st) => { if (!pass) bad++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${text} (HTTP ${st})`); };

const sAdmin = await status(url(sign(e.CLD_ADMIN_SECRET)));
rec(ok(sAdmin), 'kontrola: podpis sekretem kontrolnym otwiera zasób kontrolny', sAdmin);
if (!ok(sAdmin)) { console.log('\nRESULT: INCONCLUSIVE (kontrola pozytywna nie działa: zły cloud, id lub format; test nic nie dowodzi)'); process.exit(1); }
const sNone = await status(url(null));
rec(!ok(sNone), 'adres bez podpisu jest odrzucony', sNone);
const sBad = await status(url('s--AAAAAAAA--'));
rec(!ok(sBad), 'adres ze złym podpisem jest odrzucony', sBad);
const sRestricted = await status(url(sign(e.CLD_TEST_SECRET)));
rec(!ok(sRestricted), 'podpis sekretem OGRANICZONEGO klucza jest odrzucony (izolacja od zasobów spoza folderu)', sRestricted);

if (ok(sRestricted)) {
  console.log('\nRESULT: FAIL: ograniczony klucz podpisuje dostarczanie zasobu spoza folderu. Izolacja od produkcji NIEspełniona; zatrzymaj testy mediów.');
  process.exit(1);
}
console.log(bad ? '\nRESULT: FAIL' : '\nRESULT: PASS (dotyczy podpisanego dostarczania jednego zasobu kontrolnego; nie zastępuje testów T1-T5, T7, T8)');
process.exit(bad ? 1 : 0);
