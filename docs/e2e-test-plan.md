# Plan testów end-to-end dla prywatnych mediów

Dokument roboczy po polsku. **Plan wykonania z zasobami, limitami, oczekiwanymi wynikami i sprzątaniem: [e2e-execution-plan.md](e2e-execution-plan.md). Przebieg na telefonie krok po kroku: [phone-test-runbook.md](phone-test-runbook.md).** Wszystko tutaj dzieje się na **osobnym, darmowym środowisku testowym**, nigdy na produkcji i bez prawdziwych danych. Czego nie da się sprawdzić na atrapach, oznaczam **INFRA**: wymaga prawdziwego Firebase, Cloudflare, Cloudinary i telefonu.

## Środowisko testowe i kolejność uruchamiania

1. **Lokalnie, bez infrastruktury** (już działa w CI i na laptopie): `flutter analyze`, `flutter test`, `node worker/test.mjs`, `node worker/media.test.mjs`, `node worker/cloudinary-privacy-check.test.mjs`, `node tools/migrate-media-to-private.test.mjs`, `cd rules-test && npm ci && npm test` (emulator Firestore, Java 21).
2. **Osobny projekt Firebase (Spark)** `crewatlas-test`: Email/Password i Google, baza Firestore, wgraj `firestore.rules`. Dwa lub trzy konta demo (A: założyciel, B: członek, C: obcy). Własny `google-services.json` do `android/app/` (poza repo).
3. **Osobny Cloudinary** (drugie darmowe konto albo osobny folder-przestrzeń): jeśli używasz tego samego konta, pliki testowe trafiają do `wycieczka/<id testowej podróży>/`, a po testach usuwasz je ręcznie.
4. **Osobny worker** `crew-atlas-worker-test` z sekretami testowymi: `CLOUDINARY_*`, `FIREBASE_PROJECT_ID=<projekt testowy>`, `MEDIA_TOKEN_SECRET` (nowy), `MEDIA_TOKEN_TTL=120` (test z krótkim tokenem). Opcjonalnie `ALLOWED_UIDS`.
5. `cloudinary-privacy-check.mjs` na koncie testowym (PASS).
6. **Telefon (Android):** build debug z `config.local.json` (adres workera testowego, klucz MapTiler testowy). Nie publikuj tego APK.
7. Dopiero potem scenariusze poniżej. Konto C testuj `curl`em i drugim telefonem.

Ustawienie `curl` (bez wklejania tokenów do historii): token Firebase konta bierz z aplikacji w trybie debug albo z REST logowania Firebase (`accounts:signInWithPassword`) i trzymaj w zmiennej środowiskowej odczytanej przez `read -rs`.

## Co automatyzują skrypty (po stronie backendu, na środowisku testowym)

`tools/e2e-preflight.mjs` sprawdza testowego workera bez logowania. `tools/e2e-api-check.mjs` loguje konta demo (członek, obcy, opcjonalnie drugi członek) i wykonuje na prawdziwych usługach testowych: podpis, wysłanie PNG jako `authenticated`, odmowy Cloudinary dla adresu bez podpisu, reguły Firestore (obcy, zły folder, cudzy autor), token, plik, miniaturę, Range, token w adresie, wyjście z grupy (z pomiarem okna dostępu), usuwanie i sprzątanie. Oba działają na sucho, dopóki nie podasz `--i-am-using-test-services`, i odmawiają pracy na produkcji (`PROD_*`). Przetestowane tylko na atrapach wokół prawdziwego kodu workera. Wiersze 7 do 10 i 17 poniżej wykonuje głównie ten skrypt, UI i odtwarzacze zostają dla telefonu.

## Scenariusze

Kolumna Gdzie: **A** = atrapa w testach automatycznych (już zaliczone), **INFRA** = do wykonania na środowisku testowym.

| # | Scenariusz | Oczekiwany wynik | Gdzie |
|---|---|---|---|
| 1 | A wysyła zdjęcie | Cloudinary: zasób `authenticated` w `wycieczka/<id>/`, w Firestore `publicId`, `resourceType`, `format`, bez `url` | A (podpis, reguły, aplikacja), INFRA (prawdziwe wysyłanie) |
| 2 | Adres Cloudinary bez podpisu i adres typu `upload` | 401/403/404 | INFRA (`cloudinary-privacy-check.mjs`) |
| 3 | B (członek) otwiera galerię | Zdjęcia, miniatury na mapie, wideo i głosówka działają | INFRA |
| 4 | Wideo: start, pauza, wznowienie, przewijanie | Wznawia się bez ponownego pobierania całości (żądania Range), brak błędu | A (Range w workerze), INFRA (ExoPlayer) |
| 5 | Miniatury: obraz i klatka wideo | Okrągłe miniatury na mapie, brak własnych przekształceń od klienta | A, INFRA |
| 6 | Głosówka: nagraj, odtwórz | Odtwarza się z pamięci (pobrana przez worker) | INFRA |
| 7 | B opuszcza podróż | Nowy token: 403. Token wydany wcześniej działa najwyżej do końca ważności | A (logika), INFRA (czas na żywo, zmierz) |
| 8 | C (obcy) i bez tokenu, token innej podróży, token w adresie, podstawienie id lub `..` | 401/403/404, brak pliku | A, INFRA (`curl`) |
| 9 | Usuwanie przez autora i przez założyciela | Plik znika z Cloudinary, wpis z bazy | A, INFRA |
| 10 | Usuwanie cudzego wpisu przez zwykłego członka | 403, plik zostaje | A, INFRA |
| 11 | Wysyłanie: błąd sieci w środku, timeout, worker niedostępny, Cloudinary odmawia | Czytelny komunikat, brak zapisu wspomnienia, brak zawieszenia | INFRA |
| 12 | Stary worker (bez `params`) | Aplikacja odmawia i nie wysyła nic | A (kod), INFRA |
| 13 | Zdjęcie z GPS: czy plik w Cloudinary ma EXIF | Brak GPS, aparatu i numerów seryjnych. Orientacja poprawna | A (fixtures), INFRA (zdjęcie z prawdziwego aparatu) |
| 14 | Wideo nagrane z włączoną lokalizacją | **Nie zakładamy, że jest czyste.** Pobierz plik i sprawdź `exiftool` | INFRA |
| 15 | Token `MEDIA_TOKEN_TTL=120`: wideo 3 minuty, pauza 2,5 minuty, wznowienie | Wznawia się dzięki ponownemu otwarciu z nowym tokenem | INFRA |
| 16 | Krótka przerwa sieci w trakcie wideo dłuższego niż 2 minuty | Zapisz, czy odtwarzacz się odzyskuje (kandydat na błąd przy krótkim tokenie) | INFRA |
| 17 | `ALLOWED_UIDS` ustawione, konto spoza listy | 403 na `/sign`, `/media/token`, usuwanie | A, INFRA |

## Niepełne operacje (przerwania w środku)

| Moment przerwania | Skutek | Jak sprawdzić i naprawić |
|---|---|---|
| **Wysyłanie:** plik w Cloudinary jest, zapis wpisu w Firestore się nie udał | **Osierocony prywatny plik** bez wpisu: nikt go nie zobaczy, zajmuje miejsce w puli. Aplikacja nie ma jak go usunąć (usuwanie wymaga wpisu). | Ręcznie w konsoli Cloudinary (folder `wycieczka/<id>/`) lub raport osieroconych: porównaj listę zasobów z `publicId` w Firestore. Ryzyko małe, koszt to miejsce. |
| **Usuwanie:** plik w Cloudinary usunięty, zapis w Firestore (usunięcie wpisu) się nie udał | Wpis pozostaje i pokazuje zepsuty obraz. **Kolejna próba bezpiecznie kończy sprawę:** worker odpowiada sukcesem także gdy pliku już nie ma (`not found`), a potem usuwa się wpis. Aplikacja pokazuje komunikat „Nie udało się usunąć" i można ponowić. | Test 9 z odłączoną siecią przed krokiem usunięcia wpisu. Atrapa już sprawdza idempotencję workera. |
| **Usuwanie:** worker pada przed usunięciem w Cloudinary | Nic się nie zmienia, wpis zostaje, można ponowić | Test przy wyłączonym workerze |
| **Odwrotna kolejność** (najpierw wpis, potem plik) | Nie występuje. Zostawiałaby plik bez wpisu, którego nie da się usunąć. Dlatego aplikacja usuwa najpierw plik. | — |
| **Migracja:** przerwanie w dowolnym kroku | Stan zapisany po każdym wpisie, ponowne uruchomienie pomija zrobione. Ponowny upload do istniejącego zasobu jest odrzucany przez `overwrite=false` i traktowany jako zrobiony. | Test automatyczny (atrapa), potem próba na kilku plikach testowych |

## Warunki zaliczenia

- Wszystkie wiersze oznaczone INFRA mają zapisany wynik (OK lub opis błędu).
- Punkty 14 i 16 mają jawną decyzję (czyścić wideo, czy dokumentować jako ograniczenie, i czy skracać token).
- Dopiero po tym rozważ wdrożenie na produkcji (kolejność w [private-media.md](private-media.md)).
