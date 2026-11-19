# Lista testów na telefonie z Androidem

Dokument roboczy po polsku. Wyniki zapisuj przy każdym punkcie (OK / BŁĄD + krótka notatka). Nie publikuj APK i nie wysyłaj go nikomu: budujesz go tylko do własnych testów i po testach usuwasz z telefonu i z dysku.

## Co jest już zaliczone, a co wymaga prawdziwej infrastruktury

| Obszar | Zaliczone bez infrastruktury (atrapy, emulator) | Wymaga prawdziwego środowiska i telefonu |
|---|---|---|
| Reguły Firestore | 33 scenariusze na emulatorze | działanie reguł z prawdziwą aplikacją (sekcja 8) |
| Worker (podpisy, token, strumień, Range, usuwanie, lista kont) | `worker/test.mjs`, `worker/media.test.mjs` | prawdziwy Cloudflare, Cloudinary, limity CPU, czasy (sekcje 5, 10) |
| Czyszczenie EXIF | fixtures syntetyczne, ExifTool, Pillow | prawdziwe zdjęcia z aparatu telefonu (5.17) |
| Odświeżanie tokenów w aplikacji | testy jednostkowe (zapas, retry 401, osobne podróże) | wideo z długą pauzą i krótką przerwą sieci (5.19, 5.20) |
| Migracja | `tools/migrate-media-to-private.test.mjs` (atrapy) | próba na kilku plikach testowych (e2e-test-plan.md) |
| Android: build, ikona, interfejs, ExoPlayer, `audioplayers`, lokalizacja, SOS | tylko `flutter analyze` i testy logiki | **wszystko w tej liście** |

**Najprostszy przebieg:** [phone-test-runbook.md](phone-test-runbook.md) (jeden telefon, a konta B i C wykonuje skrypt `tools/e2e-api-check.mjs`).

Wyniki z lewej kolumny nie dowodzą, że działa cała integracja. Kolejność uruchamiania środowiska testowego i scenariusze end-to-end: [e2e-test-plan.md](e2e-test-plan.md).

## 0. Przygotowanie (kolejność, bez dotykania produkcji)

1. Lokalnie: `flutter analyze`, `flutter test`, testy workera i skryptów, `cd rules-test && npm ci && npm test` (Java 21).
2. Osobny projekt Firebase testowy (Spark): Email/Password i Google, Firestore, reguły z `firestore.rules`. Konta demo A (założyciel), B (członek), C (obcy). `google-services.json` testowego projektu do `android/app/` (poza repo).
3. Cloudinary testowy lub osobny folder na istniejącym koncie. Uruchom `worker/cloudinary-privacy-check.mjs`: musi dać `RESULT: PASS`.
4. Osobny worker testowy: `CLOUDINARY_*`, `FIREBASE_PROJECT_ID` projektu testowego, `MEDIA_TOKEN_SECRET`, `MEDIA_TOKEN_TTL=120` (do testów 5.19 i 5.20; dla reszty możesz zostawić 600).
5. Klucz MapTiler testowy. `config.local.json` z adresem testowego workera i kluczem.
6. Build: `flutter build apk --debug --dart-define-from-file=config.local.json`, instalacja `adb install`. Użyj dwóch telefonów (lub telefonu i emulatora), bo SOS, lokalizacja, uprawnienia i media wymagają co najmniej dwóch osób. Fikcyjne dane (patrz [demo-and-screenshots.md](demo-and-screenshots.md)). Nie publikuj APK i nie wysyłaj go nikomu, po testach usuń go z telefonu i z dysku.
7. Dopiero teraz sekcje 1 do 12.

Zanotuj: model telefonu, wersja Androida, wersja aplikacji, czy aplikacja jest zainstalowana po raz pierwszy.

## 1. Uruchomienie i wygląd

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 1.1 | Zainstaluj i uruchom aplikację | Nazwa na ekranie aplikacji: **CrewAtlas**. Ekran logowania z nową ikoną i napisem CrewAtlas | |
| 1.2 | Obejrzyj ikonę na ekranie głównym telefonu | Ikona: biały glob z trasami i koralowym punktem, na teal. Nie ma starej ilustracji | |
| 1.3 | Włącz motyw ikon (Android 13+, Ustawienia → Tapeta i styl → Ikony motywowane) | Ikona przyjmuje kolory motywu i jest czytelna | |
| 1.4 | Zmień kształt ikon, jeśli launcher pozwala | Glob mieści się w masce (okrąg, kwadrat, zaokrąglony) | |

## 2. Logowanie

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 2.1 | Rejestracja e-mail: imię/pseudonim, e-mail, hasło min. 6 znaków | Konto utworzone, widać ekran „Moje podróże" | |
| 2.2 | Wyloguj, zaloguj e-mailem | OK | |
| 2.3 | Złe hasło | Komunikat „Nie udało się zalogować" | |
| 2.4 | „Zaloguj przez Google" | Zalogowanie działa. Jeśli nie: sprawdź SHA-1 w projekcie Firebase | |
| 2.5 | **Tylko projekt testowy:** wyłącz samodzielną rejestrację (Authentication, Settings, User actions). Spróbuj założyć nowe konto e-mail, zalogować się pierwszy raz nowym kontem Google, i zalogować się istniejącym kontem | Nowe konto: komunikat „Zakładanie nowych kont jest wyłączone". Istniejące konta działają. **Zapisz, co dokładnie robi pierwsze logowanie Google**: dokumentacja tego nie opisuje | |

## 3. Podróże i zaproszenia

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 3.1 | „Nowa podróż": nazwa, dokąd, daty, waluta rozliczeń | Podróż na liście | |
| 3.2 | Zakładka Ekipa: kod zaproszenia, skopiuj | „Skopiowano kod" | |
| 3.3 | Telefon B: „Dołącz kodem" z kodem z telefonu A | B widzi podróż. A widzi B na liście Ekipy | |
| 3.4 | Telefon B: wpisz błędny kod | Komunikat o błędzie, brak dołączenia | |

## 4. Mapa i geokodowanie

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 4.1 | Zakładka Mapa, nowa podróż z „Dokąd" np. Lizbona | Mapa się ładuje, kamera ustawia się na Lizbonę (geokodowanie MapTiler) | |
| 4.2 | Dolny lewy róg mapy | **Logo MapTiler** oraz klikalne „© MapTiler" i „© OpenStreetMap contributors". Dotknięcie otwiera przeglądarkę (maptiler.com/copyright, openstreetmap.org/copyright) | |
| 4.3 | Zbuduj aplikację **bez** `MAPTILER_KEY` | Zamiast mapy komunikat o braku klucza | |
| 4.4 | Przytrzymaj mapę: „Nowe miejsce" z nazwą i notatką | Pinezka na mapie, miejsce na „Lista miejsc" | |
| 4.5 | Zbliż, oddal, przesuń mapę | Płynnie, kafelki wczytują się | |
| 4.6 | W trakcie testu sprawdź w panelu MapTiler wykorzystanie | Żądania liczą się na kluczu testowym. Brak ruchu przez worker | |

## 5. Miejsca, wspomnienia, zdjęcia i nagrania

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 5.1 | Otwórz miejsce, „Zrób zdjęcie" (zgoda na aparat) | Zdjęcie przesłane, miniatura na mapie | |
| 5.2 | „Zdjęcie z galerii" | Jak wyżej | |
| 5.3 | „Nagraj wideo" do 1 min i „Wideo z galerii" | Wideo wysłane i odtwarza się w miejscu | |
| 5.4 | Film powyżej ok. 90 MB | „Film jest za duży..." widoczne w panelu miejsca | |
| 5.5 | Nagranie głosowe (zgoda na mikrofon), „Zakończ nagranie" | Wysłane, przycisk play działa także z mapy | |
| 5.6 | Odmów zgody na mikrofon | „Brak zgody na mikrofon" w panelu | |
| 5.7 | Opis „Co to za chwila?" | Opis widoczny pod wspomnieniem | |
| 5.8 | Telefon B (członek) otwiera to samo miejsce | Widzi wspomnienia A | |
| 5.9 | Test zabezpieczenia: wyślij plik, gdy worker jest wyłączony lub błędny adres | Komunikat o błędzie wysyłania, brak zawieszenia | |

Nowe pliki są prywatne i idą przez worker ([private-media.md](private-media.md)). Do testów używaj mimo to tylko zdjęć bez ludzi i bez wrażliwej lokalizacji.

| # | Krok (prywatne media) | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 5.10 | Po wysłaniu zdjęcia sprawdź dokument wspomnienia w konsoli testowego Firebase | Są `publicId`, `resourceType`, `format`. **Nie ma** adresu URL | |
| 5.11 | Telefon B (członek) otwiera galerię, mapę z miniaturami, wideo i głosówkę | Wszystko się ładuje (zdjęcia, miniatury, wideo z przewijaniem, głosówka) | |
| 5.12 | Przewiń wideo w środek i do końca | Odtwarzanie wznawia się bez ponownego pobierania od początku (Range) | |
| 5.13 | Konto spoza podróży: spróbuj zażądać pliku cudzą ścieżką (np. `curl` bez tokenu na adres workera) | 401 lub 403, brak pliku | |
| 5.14 | Telefon B opuszcza podróż, od razu otwiera starą galerię | Przez najwyżej 10 minut już załadowane pliki mogą działać, potem 403. Zapisz czas | |
| 5.15 | Usuń własne wspomnienie | Znika z galerii, a w panelu Cloudinary (testowe konto) nie ma pliku w `wycieczka/<id>/` | |
| 5.17 | Zrób zdjęcie aparatem **z włączoną lokalizacją w aparacie**, wyślij, pobierz plik z podróży (przez worker, `curl` z tokenem) i sprawdź `exiftool plik.jpg` | Brak GPS, `Make`, `Model`, numerów seryjnych. Jest tylko `Orientation`. Zdjęcie w galerii ma właściwy obrót (zrób też zdjęcie w pionie i do góry nogami) | |
| 5.18 | Nagraj wideo z włączoną lokalizacją, wyślij, pobierz i sprawdź `exiftool plik.mp4` | **Zapisz, czy są dane lokalizacji (©xyz, GPS).** Wideo nie jest czyszczone, to jedyny sposób, żeby się dowiedzieć | |
| 5.19 | Test worker z `MEDIA_TOKEN_TTL=120`: otwórz wideo ok. 3 minuty, odtwarzaj 20 s, pauza 2,5 min, wznów | Wznawia się (aplikacja otwiera plik na nowo z nowym tokenem od tej samej pozycji), bez błędu | |
| 5.20 | To samo wideo, w trakcie odtwarzania na 5 s tryb samolotowy, potem sieć wraca (po ponad 2 min od otwarcia) | Zapisz, czy odtwarzacz się odzyskuje. Błąd 401 oznacza, że przy tokenie 120 s trzeba zostać przy 600 | |
| 5.21 | Usuń własne wspomnienie przy **wyłączonej sieci tuż po tym, jak plik zniknie** (np. włącz tryb samolotowy w chwili komunikatu) albo przerwij worker po usunięciu pliku | Komunikat „Nie udało się usunąć". Po powrocie sieci druga próba kończy się sukcesem i wpis znika | |
| 5.22 | Konto spoza `ALLOWED_UIDS` (jeśli ustawione na teście) | 403 przy wysyłaniu i tokenie | |
| 5.16 | Starszy build aplikacji (jeśli masz): wyślij zdjęcie do nowego workera | Odmowa (wymagana aktualizacja), brak publicznego pliku | |

## 6. Wydatki

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 6.1 | „Nowy wydatek": opis, kwota, waluta EUR, kto zapłacił, uczestnicy | Pozycja na liście, w PLN lub w walucie podróży zgodnie z kursem NBP | |
| 6.2 | Wydatek w walucie rozliczeń | Bez przeliczeń | |
| 6.3 | Brak internetu przy dodawaniu wydatku w obcej walucie | Komunikat o kursie NBP, bez zawieszenia | |
| 6.4 | Rozliczenie „kto komu ile" | Sumy zgadzają się z ręcznym rachunkiem, grosze nie giną | |

## 7. Przeloty i noclegi

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 7.1 | „Mój przelot": skąd, dokąd, daty, godziny, uwagi | Przelot widoczny dla wszystkich członków | |
| 7.2 | Telefon B dodaje własny przelot z innego miasta | Osobne wpisy, każdy przy właściwej osobie | |
| 7.3 | „Dodaj nocleg" z linkiem (Booking lub Cozycozy), „Pobierz dane z linku" | Nazwa, adres, daty, godziny zameldowania uzupełnione lub zostają do ręcznej poprawki | |
| 7.4 | „Otwórz rezerwację" i „Kopiuj link" | Otwiera Booking lub przeglądarkę. „Skopiowano link" | |

## 8. Uprawnienia usuwania (nowe reguły)

Wymaga trzech ról: założyciel podróży (A), członek (B) i obcy (C, bez zaproszenia).

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 8.1 | B dodaje miejsce, wspomnienie, wydatek, przelot i nocleg | OK | |
| 8.2 | A (założyciel) otwiera wpisy B | Przyciski usuwania widoczne dla miejsca, wydatku, przelotu i noclegu. Dla wspomnienia B przycisk jest tylko u autora | |
| 8.3 | B otwiera wpisy A | **Brak** przycisków usuwania przy cudzych wpisach | |
| 8.4 | B usuwa własne wpisy | OK | |
| 8.5 | A usuwa wpis B (np. wydatek) | OK | |
| 8.6 | C próbuje wejść do podróży bez kodu | Brak dostępu, podróży nie widać | |
| 8.7 | B klika „Opuść podróż" | B znika z listy członków, podróż znika z listy B | |

## 9. Lokalizacja

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 9.1 | Ekipa: „Udostępniaj moją lokalizację" | Prośba o zgodę. Widoczne powiadomienie usługi pierwszoplanowej „CrewAtlas" | |
| 9.2 | Telefon B | Widzi pozycję A w Ekipie i „Pokaż ekipę" na mapie | |
| 9.3 | A idzie lub symuluje ruch | Pozycja aktualizuje się z opóźnieniem (30 s, filtr 50 m), nie częściej | |
| 9.4 | A wyłącza udostępnianie | Powiadomienie znika, B nie widzi pozycji A | |
| 9.5 | A włącza i wychodzi z podróży („Opuść podróż") | Udostępnianie wyłączone, powiadomienie znika, pozycja A znika u B | |
| 9.6 | A włącza udostępnianie i zamyka aplikację, ekran zablokowany | Notuj: czy usługa działa w tle, po jakim czasie system ją zatrzymuje (oszczędzanie baterii) | |
| 9.7 | A wyłącza telefon bez zatrzymania udostępniania | **Znane ograniczenie:** ostatnia pozycja pozostaje u B (brak wygasania). Zapisz, jak wygląda (szara po 10 minutach) | |
| 9.8 | Odmowa zgody na lokalizację | Komunikat „Brak zgody na lokalizację" | |

## 10. SOS

Do testu użyj dwóch telefonów w tej samej podróży. Nie traktuj wyniku jako dowodu, że SOS jest systemem ratunkowym.

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 10.1 | A: przycisk SOS i potwierdzenie „Wysłać alarm SOS?" | „Alarm SOS wysłany do grupy" | |
| 10.2 | B ma aplikację otwartą | Syrena i nakładka alarmu, w Ekipie „A prosi o pomoc" z pozycją | |
| 10.3 | B ma aplikację w tle (ekran włączony) | Zanotuj: czy alarm dociera | |
| 10.4 | B ma aplikację **zamkniętą** lub zabitą | **Oczekiwane: brak alarmu** (push FCM nieaktywny). Zapisz wynik | |
| 10.5 | B ma telefon w trybie Nie przeszkadzać lub wyciszony | Zanotuj: syrena na strumieniu alarmowym, zapisz zachowanie | |
| 10.6 | A: „Już OK" | Alarm znika u wszystkich. Tylko A widzi ten przycisk | |
| 10.7 | B próbuje zamknąć alarm A | Brak takiej możliwości w interfejsie | |
| 10.8 | Alarm starszy niż 10 minut | Nowo uruchomiona aplikacja nie odtwarza go | |

## 11. Obsługa błędów połączenia

| # | Krok | Oczekiwany wynik | Wynik |
|---|---|---|---|
| 11.1 | Tryb samolotowy, uruchom aplikację | Brak awarii. Komunikaty zamiast pustych ekranów | |
| 11.2 | Tryb samolotowy na mapie | Wcześniej wczytane kafelki mogą być w pamięci urządzenia, reszta pusta. Brak crashu | |
| 11.3 | Wyłącz internet w trakcie wysyłania zdjęcia | Komunikat o błędzie wysyłania, możliwość ponowienia | |
| 11.4 | Wyłącz internet przy dodawaniu wpisu | Brak awarii. Zapis nadrabia się po powrocie sieci (Firestore) lub jest błąd | |
| 11.5 | Błędny `WORKER_URL` lub wyłączony worker | Komunikat o błędzie wysyłania mediów, reszta aplikacji działa | |
| 11.6 | Wyczerpany limit MapTiler (symulacja: zły klucz) | Mapa się nie ładuje, aplikacja działa dalej | |

## 12. Po testach

1. Odinstaluj aplikację testową i usuń zbudowany APK z dysku. Nie wysyłaj go nigdzie.
2. Usuń testowe dane (podróże, konta demo) z projektu testowego.
3. Zapisz wyniki, szczególnie punkty 9.6, 9.7, 10.3-10.5 i 11.2-11.6, bo opisują ograniczenia, które trafią do README.
4. Dopiero po testach rozważ wdrożenie reguł i workera na produkcję. Kolejność: najpierw nowy build aplikacji, potem worker, potem reguły.
