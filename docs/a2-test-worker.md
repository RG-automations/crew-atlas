# A2: prywatne media na środowisku testowym (instrukcja)

Dokument roboczy po polsku. Cel: sprawdzić **Flutter → Cloudflare Worker TEST → Firebase TEST → Cloudinary `authenticated`** na prawdziwych usługach, z samymi syntetycznymi plikami, bez dotykania produkcji.
Nic z poniższych kroków wdrożeniowych nie zostało jeszcze wykonane. Skrypty przetestowano **tylko na atrapach** (`node tools/e2e.test.mjs` i pokrewne). Ogólny plan: [e2e-execution-plan.md](e2e-execution-plan.md), scenariusze: [e2e-test-plan.md](e2e-test-plan.md).

## Wariant B: osobny folder na obecnym koncie Cloudinary

Plan Free ma jedno środowisko, więc worker testowy używa **tego samego konta** (te same `CLOUDINARY_*`). Co to oznacza w praktyce:

- Pliki testowe trafiają wyłącznie do `wycieczka/<id testowej podróży>/`. Identyfikator podróży pochodzi z **testowego** projektu Firebase, a worker testowy czyta członkostwo tylko z testowego Firebase (`FIREBASE_PROJECT_ID`), więc nie ma jak podpisać pliku w folderze prawdziwej podróży.
- **Ryzyko, którego nie usuwa żaden skrypt:** klucze API Cloudinary dają pełny dostęp do całego konta, także do plików produkcyjnych. Chroni tylko kod workera (ścieżki zawsze z `wycieczka/<tripId>/`) i to, że nic poza nim nie dostaje tych kluczy. Klucze wpisujesz **wyłącznie** w panelu Cloudflare i terminalu przez `read -rs`.
- Sprzątanie to usunięcie jednego folderu testowego: `tools/e2e-cleanup-cloudinary.mjs` (poniżej). Produkcyjnych plików nie rusza: odmawia, jeśli w folderze jest plik starszy niż początek testów albo id jest na liście `PROD_TRIP_IDS`.
- Limity Free (kredyty, transfer) są wspólne z produkcją. Test używa kilku małych plików, ale pomiar okna dostępu i film liczą się do puli.

## Krok 1 (wymaga Twojej zgody): worker testowy w Cloudflare

Produkcyjny worker zostaje nietknięty. Nowy worker ma **inną nazwę i inny adres**.

1. Panel Cloudflare → Workers & Pages → Create → Create Worker, nazwa `crew-atlas-worker-test`, Deploy.
2. Edit code: wklej zawartość `worker/worker.js` z tego repozytorium, Deploy. (Wdrożenie przez `wrangler` jest możliwe, ale repozytorium nie ma `wrangler.toml`, więc panel jest prostszy.)
3. Settings → Variables and Secrets:

   | Nazwa | Typ | Wartość testowa |
   |---|---|---|
   | `CLOUDINARY_CLOUD`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | **etap 2, na razie NIE ustawiaj** | Etap 1 sprawdza autoryzację bez Cloudinary. Worker bez nich odpowiada 500 `not configured` na `/sign`, pliki i usuwanie (po autoryzacji). |
   | `FIREBASE_PROJECT_ID` | Text | id projektu **testowego** (`crewatlas-test-…`) |
   | `MEDIA_TOKEN_SECRET` | Secret | **nowy** losowy ciąg, np. `openssl rand -hex 24`, inny niż produkcyjny |
   | `MEDIA_TOKEN_TTL` | Text | `120` na czas testów wygaśnięcia (minimum workera to 60) |
   | `VIDEO_STRIP` | Text | brak na początku. `1` dopiero po teście z kroku 4 |

4. Sprawdź `https://<adres-workera-testowego>/health` (powinno zwrócić `{"ok":true}`).
5. Wpisz adres do `~/crewatlas-test/config.local.json` jako `WORKER_URL` (nie jest sekretem, ale nie commitujemy go). Klucz MapTiler już tam jest.

Po testach: usuń workera testowego i wpisz `MEDIA_TOKEN_TTL` z powrotem na 600 w każdym workerze, który zostaje.

### Etap 1: autoryzacja bez Cloudinary

```bash
export WORKER_URL=https://crew-atlas-worker-test.<twoja-subdomena>.workers.dev
export PROD_WORKER_URL=<adres produkcyjnego workera> PROD_FIREBASE_PROJECT_ID=<id projektu produkcyjnego>
node tools/e2e-preflight.mjs
# zmienne E2E_* i FIREBASE_*: jak w kroku 3 (hasła przez read -rs). Potrzebne konto spoza podróży (obcy).
node tools/e2e-auth-check.mjs                                   # na sucho
node tools/e2e-auth-check.mjs --i-am-using-test-services        # wykonanie
node tools/e2e-auth-check.mjs --i-am-using-test-services --expiry-test   # po zmianie TTL na 120: ok. 2 minut
```

Skrypt odmawia, jeśli adres nie zaczyna się od `crew-atlas-worker-test.` albo jest produkcyjny, i zgłasza FAIL, jeśli worker ma już skonfigurowane Cloudinary (na etapie 1 nie powinien). Zaliczenie dotyczy wyłącznie autoryzacji. **`ALLOWED_UIDS` nie ustawiaj na etapie 1:** ukryłoby test członkostwa (obcy dostałby 403 z innego powodu). Fikcyjne konta chroni wyłączenie samodzielnej rejestracji w testowym Firebase (Authentication, ustawienia akcji użytkownika).

## Krok 2: kontrola workera (bez logowania)

```bash
export WORKER_URL=https://<adres-workera-testowego>
export PROD_WORKER_URL=https://<adres-workera-produkcyjnego>   # skrypt odmówi, jeśli to to samo
node tools/e2e-preflight.mjs
```

Oczekiwane: `RESULT: PASS`.

## Krok 3: testy API na prawdziwych usługach testowych

Najpierw w aplikacji (emulator, konto Ada Demo, build z `WORKER_URL` testowego) zakładasz podróż testową i odczytujesz jej id z Firestore. Zmienne i hasła jak w [phone-test-runbook.md](phone-test-runbook.md), krok 5. Zapisz moment rozpoczęcia testów (`date -u +%Y-%m-%dT%H:%M:%SZ`), będzie potrzebny do sprzątania.

```bash
node tools/e2e-api-check.mjs --i-am-using-test-services --media=photo
node tools/e2e-api-check.mjs --i-am-using-test-services --media=video
node tools/e2e-api-check.mjs --i-am-using-test-services --media=audio
node tools/e2e-api-check.mjs --i-am-using-test-services --media=photo --expiry-test   # ok. 2 minut przy TTL=120
node tools/e2e-api-check.mjs --i-am-using-test-services --leave-test --measure-window  # wymaga konta drugiego członka
```

Zakres: upload prywatnego pliku (`authenticated`), odmowa adresu bez podpisu i adresu publicznego, reguły Firestore (obcy, zły folder, cudzy autor), token, plik, miniatura, Range w tym zakres ze środka i od końca pliku (przewijanie), brak tokenu w adresie, odmowa dla obcego, wyjście z grupy z pomiarem okna, wygaśnięcie tokenu, usuwanie przez autora i odmowa dla innych. Skrypt sprząta po sobie plik i wpis.

## Krok 4: metadane

- **Zdjęcia:** aplikacja czyści EXIF przed wysłaniem, więc tego **nie da się** przetestować skryptem API (omija aplikację). Test: na emulatorze wgraj `worker/fixtures/synthetic-gps.jpg` (fałszywy GPS, aparat, numer seryjny; `adb push` do `/sdcard/Pictures/` i skan mediów), wyślij ją z aplikacji, potem:
  `node tools/e2e-inspect-media.mjs --i-am-using-test-services`. Zdjęcie jest zaliczone tylko, gdy zostaje samo `Orientation`.
- **Wideo i głosówka:** nie zakładamy, że są czyste. `e2e-inspect-media` zgłasza `FINDING`, jeśli w pobranym pliku zostały współrzędne (z `--require-video-clean` to błąd). Fixture z fałszywą lokalizacją: `worker/fixtures/synthetic-gps.mp4` i `synthetic-voice.m4a`. Emulator nagrywa bez prawdziwego GPS, więc prawdziwe wideo z lokalizacją wymaga telefonu (osobny, niewykonany test).
- **Transformacja Cloudinary dla wideo:** `node worker/cloudinary-video-strip-check.mjs` na koncie, a przy wyniku pozytywnym `VIDEO_STRIP=1` na workerze testowym i ponowne wysłanie wideo oraz sprawdzenie `e2e-inspect-media`. Odtwarzanie wyniku sprawdza się osobno w aplikacji.

## Krok 5: interfejs na emulatorze (zrzuty ekranu)

Dopiero po pozytywnych krokach 2–4. Zdjęcia, miniatury na mapie, wideo (start, pauza, przewijanie), głosówka (emulator ma wirtualny mikrofon, wymaga zgody w ustawieniach emulatora), usuwanie. Do zrzutów tylko pliki syntetyczne, bez ludzi i bez EXIF.

## Krok 6: sprzątanie (wariant B)

Usuwanie idzie **wyłącznie po dokładnych identyfikatorach** z manifestu tego przebiegu testów, nigdy po folderze ani prefiksie. Manifest powstaje z wspomnień **testowej** podróży w **testowym** Firebase.

```bash
# poświadczenia: read -rs, nigdy w argumentach
export PROD_FIREBASE_PROJECT_ID=<id projektu produkcyjnego>
export PROD_TRIP_IDS=<id prawdziwych podróży, jeśli je znasz>
export PROD_CLOUDINARY_CLOUD=<nazwa chmury produkcyjnej>      # w wariancie B to ta sama chmura
# 1. manifest (zmienne jak w kroku 3: FIREBASE_API_KEY, FIREBASE_PROJECT_ID, E2E_TRIP_ID, E2E_MEMBER_*)
node tools/e2e-cleanup-cloudinary.mjs manifest --i-am-using-test-services --since <czas rozpoczęcia testów> > ~/.cache/crewatlas-e2e/manifest.json
#    (pliki, które wysłał nieudany przebieg i nie mają wspomnienia: --add-id image:wycieczka/<podróż>/<id>)
# 2. na sucho: sprawdza każdy plik osobno, nic nie usuwa
export CLOUDINARY_CLOUD CLOUDINARY_API_KEY CLOUDINARY_API_SECRET
node tools/e2e-cleanup-cloudinary.mjs delete --manifest ~/.cache/crewatlas-e2e/manifest.json --confirm-cloud <nazwa chmury> --confirm-project <id projektu testowego> --shared-cloud-variant-b
# 3. usunięcie: to samo z --delete
```

Zabezpieczenia: manifest, `--confirm-cloud` i `CLOUDINARY_CLOUD` muszą się zgadzać, `--confirm-project` musi równać się projektowi z manifestu, a ten nie może być projektem produkcyjnym ani podróżą z `PROD_TRIP_IDS`. Każdy identyfikator musi mieć postać `wycieczka/<podróż z manifestu>/<id>`, być typu `authenticated` i powstać po `since`. Jedna niezgodność oznacza, że **nic** nie jest usuwane. Najwyżej 50 plików. Wariant B dzieli chmurę z produkcją, więc przy `PROD_CLOUDINARY_CLOUD` równym `CLOUDINARY_CLOUD` trzeba świadomie dodać `--shared-cloud-variant-b`. Manifest zawiera identyfikatory plików testowych: nie commituj go (zapisuj poza repozytorium, np. w ~/.cache/crewatlas-e2e/). Skrypt jest przetestowany tylko na atrapach (każdy z 12 bezpieczników ma test, który się wywala po jego usunięciu). Wywołania Admin API (szczegóły zasobu, usuwanie po `public_ids[]`) nie były sprawdzone na prawdziwym koncie, więc zacznij od próby na sucho i zweryfikuj wynik w konsoli Cloudinary.

## Czego ta instrukcja NIE zalicza

Zaliczone w A2 jest tylko to, co faktycznie wykona i zapisze któryś z powyższych kroków. Do czasu ich wykonania README i dokumenty muszą mówić, że prywatne media nie były weryfikowane na prawdziwych usługach.
