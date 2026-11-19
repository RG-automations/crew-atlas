# Test na telefonie: jeden scenariusz od zera

Dokument roboczy po polsku. Cel: sprawdzić CrewAtlas na **swoim fizycznym telefonie** na łańcuchu
**Flutter, Firebase (projekt testowy), Cloudflare (worker testowy), Cloudinary `authenticated`**, bez ruszania produkcji
i bez sekretów w repozytorium. Szczegółowe listy kroków: [android-test-checklist.md](android-test-checklist.md),
scenariusze i niepełne operacje: [e2e-test-plan.md](e2e-test-plan.md).

## Najprostszy sposób, żeby nie mieć trzech telefonów

Interfejs sprawdzasz na jednym telefonie (konto A). Pozostałych aktorów (członek B, obcy C) i wszystko, co nie wymaga
oglądania ekranu, wykonuje skrypt `tools/e2e-api-check.mjs`: loguje się kontami demo, rozmawia z prawdziwym Firebase Auth,
Firestore (z regułami), workerem testowym i Cloudinary, i sprawdza odmowy, token, plik, Range, wyjście z grupy i usuwanie.
Skrypty `tools/e2e-preflight.mjs` i `tools/e2e-api-check.mjs` przetestowałem tylko na atrapach.

| Część | Kto wykonuje |
|---|---|
| Logowanie, mapa, miniatury, wideo i głosówki w odtwarzaczu, ikona, lokalizacja, SOS, uprawnienia widoczne w interfejsie | **telefon (Ty)** |
| Odmowy dla obcego, token, plik przez worker, Range, wyjście z grupy, usuwanie, reguły Firestore na prawdziwej bazie | `tools/e2e-api-check.mjs` |
| Drugi telefon jest potrzebny tylko do SOS (alarm u drugiej osoby) i do oglądania lokalizacji drugiej osoby | drugi telefon lub emulator (opcjonalnie) |

## Czynności, które wymagają osobnej zgody (zmiany w zewnętrznych kontach)

Niczego z tej listy nie wykonałem. Każdy punkt to nowy zasób w usłudze zewnętrznej:

1. **Projekt Firebase testowy** (plan Spark), aplikacja Android o tym samym pakiecie, logowanie Email/Password i Google, baza Firestore, reguły z `firestore.rules`. Ewentualnie wyłączenie samodzielnej rejestracji po założeniu kont.
2. **Trzy konta demo** (fikcyjne adresy lub aliasy, bez prawdziwych danych): A (założyciel), B (członek), C (obcy).
3. **Worker testowy** w Cloudflare (Free) z sekretami testowymi i nowym `MEDIA_TOKEN_SECRET`.
4. **Cloudinary**: plan Free ma jedno środowisko (jedna chmura, jedna pula, jedna para kluczy), więc test i produkcja by się zderzały. Zalecane drugie darmowe konto. Wariant awaryjny i konsekwencje: [e2e-execution-plan.md](e2e-execution-plan.md).
5. **Klucz MapTiler testowy.**
6. **Włączenie debugowania USB na telefonie** (zmiana ustawień telefonu).

Po testach: usuń projekt Firebase testowy, workera, konta demo i klucz, albo zostaw do kolejnych prób.

## Krok 0: pliki konfiguracji bez sekretów w repozytorium

- `android/app/google-services.json` z projektu **testowego** (plik jest w `.gitignore`).
- `config.local.json` (w `.gitignore`), skopiowany z `config.example.json`: `{"WORKER_URL": "<adres workera testowego>", "MAPTILER_KEY": "<klucz testowy>"}`. Adres workera i klucz MapTiler nie są sekretami serwerowymi, ale i tak nie commitujemy ich.
- Sekretów Cloudflare (`CLOUDINARY_API_SECRET`, `MEDIA_TOKEN_SECRET`) nigdy nie zapisujesz w plikach: wpisujesz je w panelu Cloudflare.
- Hasła kont demo i klucz API Firebase wpisujesz w terminalu przez `read -rs` (poniżej), więc nie trafiają do historii powłoki.

## Krok 1: kontrola lokalna (bez infrastruktury)

```bash
flutter analyze && flutter test
node worker/test.mjs && node worker/media.test.mjs
node tools/migrate-media-to-private.test.mjs && node tools/e2e.test.mjs
cd rules-test && npm ci && npm test      # emulator Firestore, Java 21
```

## Krok 2: kontrola workera testowego

```bash
export WORKER_URL=https://<adres-workera-testowego>
export PROD_WORKER_URL=https://<adres-workera-produkcyjnego>   # skrypt odmówi, jeśli to to samo
node tools/e2e-preflight.mjs
```

Oczekiwane: `RESULT: PASS`. `500` przy tokenie lub pliku oznacza brak `MEDIA_TOKEN_SECRET` albo starą wersję workera.
`/session` i `/m/*` muszą zwracać 404.

## Krok 3: build i instalacja na telefonie (APK nie jest publikowany)

```bash
adb devices                                   # telefon z debugowaniem USB
flutter run --debug --dart-define-from-file=config.local.json -d <id-urządzenia>
```

`flutter run` instaluje wersję debug bezpośrednio na telefonie, bez tworzenia pliku do rozsyłania. Po testach:
`adb uninstall pl.wycieczka.wycieczka`.

## Krok 4: scenariusz na telefonie (konto A), w tej kolejności

| # | Co robisz | Oczekujesz |
|---|---|---|
| 1 | Uruchamiasz aplikację | Nazwa i ikona CrewAtlas (glob z trasami), ekran logowania |
| 2 | Rejestracja e-mail (konto A) i wylogowanie, logowanie e-mailem, potem „Zaloguj przez Google" | Wszystko działa. Przy wyłączonej rejestracji nowe konto daje komunikat „Zakładanie nowych kont jest wyłączone" |
| 3 | „Nowa podróż" (np. Lizbona), kod zaproszenia z zakładki Ekipa | Podróż na liście, mapa ustawia się na Lizbonę, w rogu logo MapTiler i klikalne „© MapTiler" i „© OpenStreetMap contributors" |
| 4 | Przytrzymaj mapę: nowe miejsce | Pinezka na mapie i na liście miejsc |
| 5 | W miejscu: zdjęcie z aparatu (lokalizacja w aparacie włączona), zdjęcie z galerii, wideo do 1 min, głosówka | Miniatury na mapie, galeria działa, wideo odtwarza i przewija, głosówka gra |
| 6 | Wydatki: kilka wydatków, w tym w EUR | Rozliczenie „kto komu ile" zgodne z rachunkiem |
| 7 | Przeloty i nocleg (z linku Booking) | Wpisy widoczne, link otwiera aplikację lub przeglądarkę |
| 8 | Lokalizacja: włącz udostępnianie, zatrzymaj, ponownie włącz i „Opuść podróż" | Powiadomienie CrewAtlas znika po zatrzymaniu |
| 9 | SOS (potrzebny drugi telefon lub emulator w tej samej podróży) | Alarm tylko przy działającej aplikacji. Zapisz zachowanie przy aplikacji w tle i zamkniętej |
| 10 | Tryb samolotowy: otwórz galerię, spróbuj wysłać zdjęcie | Czytelne komunikaty, brak awarii |

Pobierz jedno zdjęcie z aparatu przez worker (`curl` z tokenem mediów) i sprawdź `exiftool plik.jpg`:
ma nie być GPS, aparatu ani numerów seryjnych, tylko `Orientation`. Zrób też wideo z lokalizacją i sprawdź je tak samo
(wideo nie jest czyszczone, to jedyna droga, żeby wiedzieć).

## Krok 5: scenariusze backendu skryptem (konta B i C bez telefonów)

Podróż z kroku 4 musi istnieć. Konto C nie może do niej należeć. Dla testu opuszczenia grupy dołącz konto B do podróży
kodem w aplikacji (albo emulatorze).

```bash
read -rs FIREBASE_API_KEY && export FIREBASE_API_KEY          # klucz API projektu TESTOWEGO
read -r  FIREBASE_PROJECT_ID && export FIREBASE_PROJECT_ID    # id projektu testowego
export E2E_TRIP_ID=<id podróży z kroku 4>
export E2E_MEMBER_EMAIL=<A>;  read -rs E2E_MEMBER_PASSWORD && export E2E_MEMBER_PASSWORD
export E2E_STRANGER_EMAIL=<C>; read -rs E2E_STRANGER_PASSWORD && export E2E_STRANGER_PASSWORD
export PROD_FIREBASE_PROJECT_ID=<id projektu produkcyjnego>   # odmowa, jeśli to ten sam projekt

node tools/e2e-api-check.mjs                                   # próba na sucho: tylko plan
node tools/e2e-api-check.mjs --i-am-using-test-services        # wykonanie
```

Dla wyjścia z grupy (drugi członek) dodaj `E2E_MEMBER2_EMAIL`, `E2E_MEMBER2_PASSWORD` i uruchom z `--leave-test`.
Z `--measure-window` skrypt zmierzy, ile naprawdę trwa dostęp starego tokenu po wyjściu (do końca ważności tokenu,
domyślnie 10 minut). Skrypt tworzy jeden syntetyczny PNG i jeden wpis, a po sobie sprząta (plik przez worker, wpis przez Firestore).

Oczekiwane: `RESULT: PASS`. Każda linia `FAIL` opisuje, który mechanizm zawiódł (np. reguły przyjęły wpis obcego,
Cloudinary odpowiada 200 na adres bez podpisu, worker wpuszcza obcego).

## Krok 6: wideo, token 120 s i metadane (osobne testy)

- Z `MEDIA_TOKEN_TTL=120` na workerze testowym: film 3 minuty, odtwarzaj 20 s, pauza 2,5 minuty, wznów. Potem krótka przerwa sieci w trakcie odtwarzania po ponad 2 minutach od otwarcia (checklista 5.19 i 5.20).
- `node worker/cloudinary-video-strip-check.mjs` na koncie testowym (opis w [private-media.md](private-media.md)). Jeśli `RESULT` jest pozytywny, ustaw na workerze testowym `VIDEO_STRIP=1`, nagraj wideo z lokalizacją, wyślij je, pobierz i sprawdź `exiftool` oraz odtwarzanie na telefonie.
- `node worker/cloudinary-privacy-check.mjs` (powinien dać `RESULT: PASS`).

## Wynik i sprzątanie

Zapisuj wynik przy każdym punkcie checklisty. Po testach usuń aplikację z telefonu (`adb uninstall`), dane testowe z projektu
Firebase, pliki z folderu `wycieczka/<id testowej podróży>/` w Cloudinary i testowy klucz MapTiler, jeśli nie jest już potrzebny.
Dopiero po zaliczeniu wierszy oznaczonych INFRA w [e2e-test-plan.md](e2e-test-plan.md) wolno rozważyć wdrożenie na produkcję.
