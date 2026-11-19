# CrewAtlas: plan wykonania testów E2E

Dokument roboczy po polsku. **Nic z tego nie zostało wykonane.** Wszystkie skrypty były sprawdzone tylko na atrapach.
Zasoby zewnętrzne powstają dopiero po Twojej zgodzie (lista na końcu). Przebieg na telefonie krok po kroku:
[phone-test-runbook.md](phone-test-runbook.md). Scenariusze i niepełne operacje: [e2e-test-plan.md](e2e-test-plan.md).

## 1. Zasoby testowe, limity darmowych planów i kolizje z produkcją

| Zasób | Plan | Co ogranicza darmowy plan (z dokumentacji) | Kolizja z produkcją | Jak jej uniknąć |
|---|---|---|---|---|
| **Firebase** projekt testowy | Spark | Limity użycia są **na projekt**, więc osobny projekt ma własne limity. Liczba projektów na konto jest ograniczona (FAQ Firebase: „mała liczba", zwykle 5 do 10, dokładnej liczby nie podano), a usunięty projekt liczy się do limitu do 30 dni. | Brak, jeśli to inny projekt. Ryzyko to pomyłka z plikiem `google-services.json`. | Przed buildem sprawdź `project_id` w `android/app/google-services.json` (polecenie w kroku 3). Ten sam pakiet Androida w drugim projekcie powinien być dozwolony (nie sprawdzałem tego w dokumentacji). |
| **Firestore** reguły testowe | Spark | 50 tys. odczytów i 20 tys. zapisów dziennie na projekt | Brak | Reguły z `firestore.rules` wgrywasz tylko do projektu testowego |
| **Firebase Auth** konta | Spark | Brak istotnego limitu | Brak | Fikcyjne adresy (np. `a@test.invalid`) dla kont e-mail. Google wymaga prawdziwego konta: użyj własnego drugiego konta Google, nie kont znajomych |
| **Cloudflare Worker** testowy | Free | **100 000 żądań dziennie na całe konto** (reset o północy UTC), 10 ms CPU na żądanie, 50 podżądań, do 100 workerów, do 64 sekretów na workera | **Tak, limit dzienny jest wspólny z produkcyjnym workerem.** Test zużyje kilkaset żądań. | Testuj poza godzinami używania przez grupę, nie rób testów obciążeniowych |
| **Cloudinary** | Free | **Jedno środowisko produktowe, czyli jedna nazwa chmury, jedna pula kredytów i jedna para kluczy** (dokumentacja Cloudinary dla planu Free) | **Tak, wprost.** Testowy worker musiałby dostać produkcyjny `CLOUDINARY_API_SECRET`, a pliki testowe zużywają produkcyjną pulę. | Zalecane: **drugie darmowe konto Cloudinary** (osobna chmura i klucze, Twoja decyzja i zgoda). Wariant awaryjny: to samo konto, ale tylko foldery testowej podróży oraz prefiksy skryptów `crewatlas-*-check/`. Skrypty usuwają wyłącznie własne identyfikatory. Wtedy testowy worker trzyma produkcyjny sekret, więc po testach usuń go z workera testowego i rozważ rotację klucza. |
| **MapTiler** klucz testowy | Free | Kwota (5 tys. sesji i 100 tys. żądań miesięcznie) jest **na konto**, ruch ze wszystkich kluczy się sumuje | Niewielka: test zużywa ten sam miesięczny limit | Osobny klucz pozwala go odwołać po testach. Nie rób długich sesji mapy |
| Telefon | n/a | Debugowanie USB | Brak | `flutter run` instaluje wersję debug bez pliku APK do rozsyłania |

**Nie tworzymy:** kont serwisowych, kluczy administracyjnych, App Check, konta Play Console, rozliczeń ani niczego z kartą.

## 2. Kolejność wykonania, oczekiwane wyniki i znaczenie porażek

Zakładam, że krok 0 (testy lokalne) już przeszedł. Powtarzasz go tylko po zmianach w kodzie.

| Krok | Polecenie | Oczekiwany wynik | Jeśli się nie uda |
|---|---|---|---|
| 0 | `flutter analyze && flutter test`, `node worker/test.mjs`, `node worker/media.test.mjs`, `node tools/e2e.test.mjs`, `cd rules-test && npm test` | wszystko PASS | zmiana w kodzie zepsuła stan, nie idź dalej |
| 1 | utworzenie zasobów testowych (po zgodzie): projekt Firebase z Email/Password i Google, Firestore, 3 konta demo A (założyciel), B (członek), C (obcy), worker testowy, Cloudinary, klucz MapTiler | zasoby istnieją, nic produkcyjnego nie zmienione | n/a |
| 2 | wgranie reguł `firestore.rules` do projektu testowego (panel lub `npx firebase-tools deploy --only firestore:rules --project <TESTOWY>`), wklejenie `worker/worker.js` do workera testowego i ustawienie sekretów oraz zmiennych (`worker/README.md`) | reguły opublikowane, worker odpowiada | błąd publikacji reguł: popraw składnię. Worker bez `MEDIA_TOKEN_SECRET`: kroki 3 i 6 pokażą 500 |
| 3 | `python3 -c "import json;print(json.load(open('android/app/google-services.json'))['project_info']['project_id'])"` | id projektu **testowego** | id produkcyjne: **przerwij**, podmień plik |
| 4 | `WORKER_URL=… PROD_WORKER_URL=… node tools/e2e-preflight.mjs` | `RESULT: PASS`, 8 linii PASS | `500` na tokenie lub pliku: brak `MEDIA_TOKEN_SECRET` albo stary worker. `/session` różne od 404: wdrożony jest stary worker z proxy mapy. Odmowa `ODMOWA`: podałeś adres produkcyjny |
| 5 | `node worker/cloudinary-privacy-check.mjs` (poświadczenia przez `read -rs`, patrz poniżej) | `RESULT: PASS`, 5 linii PASS | Patrz tabela porażek poniżej |
| 6 | `node worker/cloudinary-video-strip-check.mjs` | patrz sekcja 3 | patrz sekcja 3 |
| 7 | przebieg na telefonie według [phone-test-runbook.md](phone-test-runbook.md) | wszystkie punkty tabeli kroku 4 runbooka | opis w runbooku, plus tabela sekcji 6 |
| 8 | `node tools/e2e-api-check.mjs --i-am-using-test-services [--leave-test --measure-window]` | `RESULT: PASS`, ok. 31 linii PASS | linia `FAIL` wskazuje mechanizm (tabela sekcji 6) |
| 9 | scenariusze bezpieczeństwa Firebase (sekcja 4) | zgodnie z opisem | sekcja 4 |
| 10 | test tokenu po wygaśnięciu i metadanych (sekcja 5) | zgodnie z opisem | sekcja 5 |
| 11 | próbna migracja (sekcja 7) | zgodnie z opisem | sekcja 7 |
| 12 | sprzątanie (sekcja 8) | czyste środowisko | sekcja 8 |

Poświadczenia dla kroków 5 i 6 (nigdy w argumentach polecenia i nigdy w plikach):

```bash
read -rs CLOUDINARY_API_SECRET && export CLOUDINARY_API_SECRET
read -r  CLOUDINARY_CLOUD   && export CLOUDINARY_CLOUD
read -rs CLOUDINARY_API_KEY && export CLOUDINARY_API_KEY
```

Znaczenie porażek kroku 5 (`cloudinary-privacy-check.mjs`):

| Linia FAIL | Co oznacza |
|---|---|
| upload `type=authenticated` | konto nie przyjmuje prywatnych plików albo podpis jest zły: **prywatne media nie zadziałają**, nie wdrażaj |
| adres bez podpisu odrzucony (ma być 401/403/404) | plik byłby publicznie dostępny: **wyciek**, nie wdrażaj |
| publiczny adres `upload` | ten sam problem w drugiej postaci |
| adres z podpisem działa | worker nie odczyta plików: media się nie załadują |
| zły podpis odrzucony | podpisy nic nie chronią: **nie wdrażaj** |
| sprzątanie (WARN) | w Cloudinary został plik testowy: usuń folder `crewatlas-privacy-check/` ręcznie |

## 3. Cloudinary Video: kryteria pozytywnego wyniku

Uruchomienie: ta sama trójka `read` co wyżej, potem `node worker/cloudinary-video-strip-check.mjs`. Test używa tylko
`worker/fixtures/synthetic-gps.mp4` (1 s, 13 KB, fałszywa lokalizacja nad morzem, fałszywy autor i komentarz), wysyła 2 pliki
jako `authenticated` i jedną transformację dostarczania. Zużycie to nieistotny ułamek puli (kilkadziesiąt KB przepływu i
kilka transformacji). Sprząta dokładnie swoje identyfikatory (`crewatlas-video-strip-check/<uuid>-control|incoming`) i
sprawdza, że po usunięciu podpisany adres daje 404. Nie zapisuje niczego na dysku i nie wypisuje sekretów ani adresów.

| Twoje kryterium | Linia w wyniku, która je potwierdza |
|---|---|
| Oryginał testowy zawierał kontrolne metadane | `PASS  control (no transformation) keeps the test marks` |
| Wynik nie zawiera kontrolnych metadanych lokalizacyjnych | `PASS  incoming fl_force_strip strips the stored original (metadata removed …)` |
| Film zachowuje prawidłowy format | ta sama linia: wynik przeszedł kontrolę struktury MP4 (pudełka `ftyp`, `moov`, `mdat` składają się dokładnie na plik) |
| Materiał pozostaje prywatny | `PASS  stripped asset stays private` oraz upload potwierdzony jako `authenticated` |
| Wszystkie pliki testowe usunięte | `INFO  cleanup … ok` i końcowe `cleanup confirmed` (podpisany adres po usunięciu: 404) |
| **Odtwarzanie jest możliwe** | **nie sprawdza tego skrypt** (struktura MP4 to nie odtwarzanie). Po pozytywnym wyniku ustaw na workerze testowym `VIDEO_STRIP=1`, nagraj film z włączoną lokalizacją, wyślij go z telefonu, odtwórz go w aplikacji, pobierz przez worker i sprawdź `exiftool` |

Końcowa linia: `RESULT: control valid, incoming strip PASS, derived strip …, cleanup confirmed.`

| Wynik | Znaczenie i decyzja |
|---|---|
| `incoming strip PASS` | wariant A działa na koncie: włącz `VIDEO_STRIP=1` na testowym workerze i zrób test z telefonem |
| `incoming strip not confirmed`, `derived strip PASS` | transformacja przy wysyłaniu nie czyści. Zostaje wariant B (czyszczenie przy dostarczaniu, oryginał z GPS pozostaje w Cloudinary), wymaga przeróbki workera. Zdecydujemy po wyniku |
| oba `not confirmed` | Cloudinary nie czyści filmów tym sposobem. Filmy zostają z metadanymi, README to mówi, a prośba do znajomych to wyłączenie lokalizacji w aparacie |
| `control INVALID` | kontrolny film nie miał znaczników po stronie Cloudinary (Cloudinary już czyści przy wysyłaniu?) albo test nic nie mówi. Wtedy przejrzyj wynik ręcznie |
| `FAIL … not a valid MP4` | transformacja uszkodziła film: **nie włączaj** `VIDEO_STRIP` |
| `ERROR HTTP 4xx` przy uploadzie | konto Free nie obsługuje takiej transformacji wideo (limit planu) |
| `cleanup NOT confirmed` | usuń ręcznie folder `crewatlas-video-strip-check/` w konsoli Cloudinary |

## 4. Firebase Security: scenariusze (wyłącznie projekt testowy)

| # | Co robisz | Oczekiwany wynik | Co oznacza porażka |
|---|---|---|---|
| S1 | Authentication, Settings, User actions: wyłącz tworzenie kont | Nowa rejestracja e-mail w aplikacji kończy się komunikatem „Zakładanie nowych kont jest wyłączone" | brak komunikatu lub konto powstaje: przełącznik jest w innym miejscu albo wymaga Identity Platform (dokumentacja tego nie rozstrzyga). Zapisz, co widzisz. Nie stosuj na produkcji, dopóki nie działa |
| S2 | Zaloguj konta A i B utworzone przed wyłączeniem | Logowanie e-mail działa | konta istniejące przestały działać: **nie wyłączaj na produkcji** |
| S3 | Zaloguj się Google kontem, które już było użyte, i kontem Google, które jeszcze nie logowało się do projektu | Pierwsze: działa. Drugie: dokumentacja nie opisuje, prawdopodobnie ten sam błąd (tworzenie konta) | Zapisz wynik. Jeśli nowe konto Google powstaje mimo wyłączenia, ta ochrona nie działa dla Google |
| S4 | Dostęp do Firestore bez logowania: `curl -s -o /dev/null -w "%{http_code}\n" "https://firestore.googleapis.com/v1/projects/$FIREBASE_PROJECT_ID/databases/(default)/documents/trips/$E2E_TRIP_ID"` | `403` | `200`: reguły są otwarte, **blokada** |
| S5 | Dostęp zalogowanych: `tools/e2e-api-check.mjs` (krok 8) | obcy dostaje 403 na podróż, wpis, token i plik | linie FAIL wskazują, która reguła zawodzi |
| S6 | Ograniczenie klucza API (zmiana w Google Cloud Console **projektu testowego**): Credentials, klucz, Application restrictions: Android apps, pakiet `pl.wycieczka.wycieczka` i SHA-1 klucza debug twojego komputera (`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`), API restrictions: tylko potrzebne API | Logowanie z telefonu nadal działa. `node tools/e2e-api-check.mjs` bez `E2E_ANDROID_*` kończy się `BŁĄD: logowanie: HTTP 403 API_KEY_ANDROID_APP_BLOCKED`. Z `E2E_ANDROID_PACKAGE` i `E2E_ANDROID_CERT_SHA1` przechodzi | Logowanie z telefonu przestaje działać: SHA-1 się nie zgadza (inny komputer, inny klucz debug). Skrypt bez nagłówków przechodzi: ograniczenie nie działa. Pamiętaj, że to utrudnienie, nie bariera: nagłówki da się podrobić |
| S7 | `ALLOWED_UIDS` na workerze testowym: uid konta A (z konsoli Users) | A: token i podpis działają. B (członek): 403 na `/media/token` i `/sign`. Pusta lista: wszyscy członkowie działają | B dostaje token: lista nie działa. A dostaje 403: zły uid |

**App Check z Play Integrity: ponowna ocena dla CrewAtlas.** Dokumentacja Firebase potwierdza, że dystrybucja poza Google Play jest
obsługiwana. Co to znaczy dla aplikacji:

| Element | Konfiguracja i ograniczenie dla CrewAtlas |
|---|---|
| Etykiety | Wyłączyć wymaganie `PLAY_RECOGNIZED` i `LICENSED` (aplikacje spoza Play ich nie dostają), wymagać poziomu device integrity. Na Androidzie 13 i nowszym telefony bez instalacji z Google Play mogą nie dostać opcjonalnych etykiet i zostać odrzucone, jeśli nie spełniają device integrity. |
| Certyfikat | SHA-256 certyfikatu podpisu, zarejestrowany dla aplikacji. Kompilacje podpisane kluczem debug (różnym na każdym komputerze) byłyby niezarejestrowane. Potrzebny byłby jeden stały klucz podpisujący. |
| Wymagania konta | Powiązanie projektu z Play Integrity API **w Play Console**, jako właściciel projektu. Koszt konta Play Console nie jest podany w przeczytanej dokumentacji (podejrzewam opłatę rejestracyjną, nie zweryfikowane), co może kolidować z zasadą braku płatnych usług. |
| Plan i limity | Dokumentacja nie podaje, czy App Check jest darmowy na Spark. Podaje dzienny limit Play Integrity: **10 000 wywołań** (poziom Standard) i że token ma ważność od 30 minut do 7 dni (domyślnie 1 godzina). |
| Zakres | Można egzekwować dla Firestore. **Authentication jest oznaczone jako Preview.** Worker byłby chroniony tylko wtedy, gdyby sam weryfikował tokeny App Check (niezbudowane). |
| Testy lokalne | Provider debug: token pojawia się w logach i rejestrujesz go w konsoli. Dokumentacja ostrzega, żeby go nie publikować ani nie commitować, bo pozwala nieweryfikowanym urządzeniom wejść do backendu. Czy biblioteka debug jest wyłączana w wydaniach, dokumentacja nie mówi. |
| Zmiany w aplikacji | Brak SDK App Check w CrewAtlas. Trzeba by dodać pakiet `firebase_app_check` i inicjalizację (nie zrobione, bo nie rozbudowuję aplikacji bez decyzji). |
| Ryzyko zablokowania | Egzekwowanie jest per produkt i blokuje wszystkie niezarejestrowane aplikacje: wszystkie obecne instalacje z kluczem debug i każdy fork. |

Wniosek: **nadal nie rekomenduję wdrożenia teraz.** Korzyść jest realna (odcina skrypty spoza aplikacji od Firestore), ale warunki
(stały klucz podpisu, konto Play Console, device integrity na telefonach znajomych) nie są spełnione, a egzekwowanie bez
etapu pomiarowego zablokowałoby grupę. Jeśli zdecydujesz się spróbować, to wyłącznie na projekcie testowym, **bez egzekwowania**,
w kolejności: konto Play Console i klucz podpisu (Twoja zgoda), SDK w aplikacji, obserwacja metryk, rejestracja certyfikatu,
egzekwowanie Firestore na samym końcu.

## 5. Tokeny po wygaśnięciu i metadane zdjęć i filmów

`MEDIA_TOKEN_TTL` na produkcji zostaje 600. **Testy poniżej wykonuje się na workerze testowym z `MEDIA_TOKEN_TTL=120`**, żeby
wygaśnięcie nastąpiło szybko (to ustawienie testowe, nie zmiana produkcyjna).

| # | Test | Oczekiwany wynik | Porażka oznacza |
|---|---|---|---|
| T1 | `e2e-api-check.mjs --leave-test --measure-window`: drugi członek opuszcza grupę | nowy token 403, stary działa do końca ważności, zmierzone okno ≤ ważność tokenu | okno dłuższe niż ważność: token nie wygasa, **błąd bezpieczeństwa** |
| T2 | Telefon: film ok. 3 min, 20 s odtwarzania, pauza 2,5 min, wznowienie | film wznawia się (aplikacja otwiera plik od nowa z nowym tokenem) | błąd lub pusty obraz: ponowne otwarcie nie działa |
| T3 | Film: w trakcie odtwarzania, po ponad 2 min od otwarcia, 5 s trybu samolotowego, powrót sieci | odtwarzacz się odzyskuje | 401 i zatrzymanie: dla długich filmów krótkie tokeny są ryzykowne, produkcja zostaje przy 600 |
| T4 | Zdjęcie i miniatury po wygaśnięciu: odśwież galerię po 3 min | ładują się (token odświeżony, jedno ponowienie po 401) | puste obrazy: odświeżanie tokenu nie działa |
| T5 | Zdjęcie z aparatu z lokalizacją: wyślij, pobierz przez worker (token mediów, `curl`), `exiftool plik.jpg` | brak GPS, `Make`, `Model`, numerów seryjnych, jest tylko `Orientation`. Zdjęcie w galerii ma właściwy obrót (zrób też pionowe i do góry nogami) | GPS lub model w pliku: czyszczenie nie działa na prawdziwych plikach, **blokada** |
| T6 | Zdjęcie z galerii (PNG ze zrzutu ekranu, jeśli masz): wyślij | działa, brak metadanych | komunikat o nieobsługiwanym formacie: akceptowalne (odmowa zamiast wysłania), zapisz format |
| T7 | Film z lokalizacją przy wyłączonym `VIDEO_STRIP`: wyślij, pobierz, `exiftool plik.mp4` | zapisz, czy są dane lokalizacji (wynik wyjściowy bez czyszczenia) | n/a (to pomiar) |
| T8 | To samo po `VIDEO_STRIP=1` (po pozytywnym kroku 6) | brak lokalizacji, film się odtwarza | lokalizacja nadal jest albo film nie gra: nie włączaj na produkcji |

## 6. Co oznacza niepowodzenie linii `tools/e2e-api-check.mjs`

| Linia FAIL | Co zawiodło |
|---|---|
| `/sign: obcy dostaje odmowę`, `token mediów: obcy`, `usuwanie: obcy` | worker lub reguły wpuszczają kogoś spoza podróży: **blokada** |
| `/sign: stary format odrzucony` | worker w starej wersji: można wysłać plik publiczny: **blokada** |
| `wysłanie PNG: Cloudinary potwierdza authenticated` | wysłanie nie jest prywatne: **blokada** |
| `Cloudinary: adres bez podpisu`, `publiczny upload` | plik dostępny bez podpisu: **blokada** |
| `Firestore: obcy nie dodaje…`, `zły folder`, `cudzy autor` | reguły Firestore nie działają jak w testach emulatora: **blokada**, wpisy są sprzątane automatycznie |
| `worker: bajty zgodne`, `Range 206`, `miniatura` | worker źle przekazuje plik: media będą się psuły |
| `nagłówki prywatne` | odpowiedź mogłaby trafić do pamięci podręcznej: **blokada** |
| `token w adresie nie działa`, `ścieżka innej podróży`, `podstawiony identyfikator` | luka w walidacji workera: **blokada** |
| `po wyjściu: nowy token odmówiony` | opuszczenie grupy nie odbiera dostępu do nowych tokenów: **blokada** |
| `usuwanie: autor usuwa plik`, `po usunięciu 404`, `ponowne usuwanie` | usuwanie nie działa albo nie jest idempotentne |

## 7. Próbna migracja kilku syntetycznych zasobów (tylko środowisko testowe)

Nie tworzymy kont serwisowych ani kluczy administracyjnych. Migracja potrzebuje tokenu właściciela projektu **testowego**
(`export GCLOUD_ACCESS_TOKEN=$(gcloud auth print-access-token)` po `gcloud auth login` jako Ty), bo reguły nie pozwalają
edytować wspomnień. Czy `gcloud` jest zainstalowany, nie sprawdzałem. Jeśli nie ma, instalacja to osobna zgoda.

| Krok | Polecenie (dla każdego ten sam `--backup-dir`, katalog poza projektem i folderami synchronizowanymi, np. `~/crewatlas-rehearsal`) | Oczekiwany wynik |
|---|---|---|
| 1 | `node tools/seed-synthetic-legacy-media.mjs seed --trip <TESTTRIP> --backup-dir ~/crewatlas-rehearsal` (na sucho), potem z `--apply --i-am-using-a-test-project --count 3` | 3 syntetyczne wpisy w starym kształcie (publiczne pliki plus `url`) |
| 2 | `node tools/migrate-media-to-private.mjs plan --backup-dir …` (na sucho), potem `plan --apply`, `backup --apply`, `copy --apply`, `link --apply`, `verify --apply` | `Do migracji: 3`, same `ok`, `verify`: 3 × PASS |
| 3 | w aplikacji otwórz galerię | zdjęcia ładują się przez worker |
| 4 | `finalize --apply --yes-delete-public`, sprawdź ponownie, potem `restore --apply` | publiczne pliki znikają i wracają z kopii (suma SHA-256 sprawdzona) |
| 5 | `seed-synthetic-legacy-media.mjs cleanup --backup-dir … --apply`, potem usuń katalog `~/crewatlas-rehearsal` | puste środowisko |

Porażka: `ODMOWA … leży w …` (katalog w repozytorium lub folderze synchronizowanym), `kopia zapasowa uszkodzona` (zmieniona po
backupie), `verify FAIL` (bajty różnią się, nie kończ `finalize`), `finalize ODMOWA` (nie wszystkie wpisy zweryfikowane lub brak kopii).
Rollback do `finalize`: `rollback --apply`. Szczegóły i właściwości bezpieczeństwa: [private-media.md](private-media.md).

## 8. Sprzątanie środowiska testowego

1. Telefon: `adb uninstall pl.wycieczka.wycieczka`. Usuń z dysku `config.local.json` testowy i `android/app/google-services.json` testowy (przywróć produkcyjny, jeśli go używasz lokalnie).
2. Cloudinary: usuń foldery `wycieczka/<TESTTRIP>/`, `crewatlas-privacy-check/`, `crewatlas-video-strip-check/` (jeśli zostały). Jeśli test używał produkcyjnego konta, usuń sekret z workera testowego i rozważ rotację klucza API.
3. Cloudflare: usuń workera testowego razem z jego sekretami.
4. Firebase: usuń dane testowe, a projekt testowy możesz zostawić na kolejne próby albo usunąć (usunięty projekt liczy się do limitu do 30 dni).
5. MapTiler: odwołaj klucz testowy.
6. Lokalnie: usuń `~/crewatlas-rehearsal`, wyczyść zmienne środowiskowe (`unset CLOUDINARY_API_SECRET CLOUDINARY_API_KEY CLOUDINARY_CLOUD FIREBASE_API_KEY E2E_MEMBER_PASSWORD E2E_STRANGER_PASSWORD GCLOUD_ACCESS_TOKEN`) lub zamknij terminal.
7. Konta demo: usuń z konsoli projektu testowego. Konto Google użyte do testu usuń z listy użytkowników.

## 9. Co nadal blokuje wdrożenie produkcyjne

1. Brak wykonanych testów INFRA (wszystkie kroki powyżej).
2. Stare publiczne pliki na produkcji z ich EXIF, dopóki nie nastąpi migracja.
3. Kolejność wdrożenia: nowy build na wszystkie telefony, potem worker z `MEDIA_TOKEN_SECRET`, potem reguły. Starsze aplikacje przestają wysyłać pliki i pokazywać mapę.
4. Otwarta rejestracja i brak sposobu na darmowe ograniczenie zapytań do Firestore od kogoś, kto ma konfigurację.
5. Zachowanie logowania Google po wyłączeniu rejestracji jest nieznane do czasu S3.
6. Wideo: metadane lokalizacji nieczyszczone do czasu kroku 6 i testu T8.
7. Test `cloudinary-privacy-check.mjs` Cloudinary Free już przeszedł (właściciel), ale na koncie, które jest wspólnym dla testu i produkcji, jeśli nie powstanie drugie.

## 10. Zasoby, których utworzenie wymaga Twojej zgody

| # | Zasób | Uwagi |
|---|---|---|
| 1 | Projekt Firebase testowy (Spark) z Email/Password, Google, Firestore i testowymi regułami | Limit liczby projektów na konto nie jest podany |
| 2 | Aplikacja Android w tym projekcie (pakiet `pl.wycieczka.wycieczka`) i pobranie testowego `google-services.json` | SHA-1 klucza debug twojego komputera |
| 3 | Trzy konta demo e-mail (fikcyjne adresy) i jedno testowe konto Google (Twoje własne drugie konto) | |
| 4 | Worker testowy w Cloudflare z nowym `MEDIA_TOKEN_SECRET` | wspólny dzienny limit 100 tys. żądań z produkcją |
| 5 | **Drugie darmowe konto Cloudinary** (zalecane) albo zgoda na użycie istniejącego konta z prefiksami testowymi | jedno środowisko na plan Free, kolizja z produkcją |
| 6 | Klucz MapTiler testowy | wspólna miesięczna kwota z produkcją |
| 7 | Zmiana ograniczeń klucza API w Google Cloud Console wyłącznie projektu testowego | |
| 8 | Włączenie debugowania USB na telefonie | |
| 9 | Opcjonalnie instalacja `gcloud` do próby migracji | tylko jeśli zdecydujesz się na próbę |

Nie tworzymy: kont serwisowych, kluczy administracyjnych, App Check, konta Play Console, rozliczeń.
