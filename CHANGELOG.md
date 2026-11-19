# CrewAtlas - dziennik zmian (dawniej BMB, Wycieczka)

Numer wersji jest w `pubspec.yaml` (`version: 0.5.1+6`: nazwa wersji + numer budowy) i widać go w ustawieniach Androida przy aplikacji. Numery 0.1.0-0.4.0 nadałem wstecz, więc starsze pliki APK mają w sobie `0.1.0+1`. Daty pochodzą z naszych sesji pracy i są orientacyjne.

## Unreleased - rebranding na CrewAtlas i przygotowanie do publikacji kodu
Zmiany lokalne, **nie wdrożone** na produkcję (reguły Firestore i worker wymagają ręcznego wdrożenia). Nie wydano nowego APK.

### Zmieniono
- Nazwa produktu: **CrewAtlas** (ekran logowania, nazwa aplikacji na telefonie, powiadomienie lokalizacji, dokumentacja). Starsze wpisy poniżej zachowują dawne nazwy.
- Pakiet Dart: `wycieczka` -> `crew_atlas`. Bez zmian: `applicationId` i `namespace` Androida (`pl.wycieczka.wycieczka`), projekt Firebase, kolekcje Firestore, prefiks folderu Cloudinary `wycieczka/`. Dzięki temu aktualizacja nadal jest tą samą aplikacją i logowanie Google działa.
- Przyciski usuwania w aplikacji pokazują się tylko osobom, które mogą usunąć wpis (autor lub założyciel podróży).

### Bezpieczeństwo (przygotowane, niewdrożone)
- Reguły Firestore: odczyt `users/*` tylko przez właściciela, zamknięte niewymienione podkolekcje, wpisy tylko we własnym imieniu (`createdBy`, `userId`, `uid`), czas SOS i lokalizacji nadaje serwer, członek nie zmienia `createdBy`, `inviteCode` ani cudzych nazw, SOS nie da się usunąć, zaproszenie można wystawić tylko dla własnej podróży. Rozbudowane testy emulatora (33 scenariusze).
- Worker `/sign`: wymaga członkostwa w podróży (Firestore REST z tokenem użytkownika, bez konta serwisowego). Nowy format v2: jeden podpis na jeden plik (`public_id` nadaje worker, `overwrite=false`) i lista dozwolonych formatów. Stary format działa, dopóki nie ustawisz `REQUIRE_V2=1`.
- Błąd tokenu nie zdradza już konfiguracji workera.

### Dodano
- Nowe logo CrewAtlas (koncepcja C2, SVG i PNG w `assets/brand/`), nowe ikony aplikacji (Adaptive Icon z wariantem monochromatycznym Android 13+), podgląd społecznościowy GitHub. Stare ikony zachowane lokalnie poza repozytorium. Prawa do logo opisane osobno od licencji kodu (`docs/branding.md`).
- Atrybucja MapTiler zgodna z wymaganiami planu Free: logo z linkiem i klikalne `© MapTiler` / `© OpenStreetMap contributors` (nowa zależność `flutter_svg`).
- `LICENSE` (PolyForm Noncommercial 1.0.0) i `NOTICE`, README po angielsku, `SECURITY.md`, `docs/`, szkielet CI, przykład `google-services.json.example`.

### Zmieniono (mapa)
- Aplikacja łączy się z MapTiler **bezpośrednio** (styl, kafelki, geokodowanie), klucz podawany przy budowaniu (`MAPTILER_KEY`). Z workera usunięto `/session` i `/m/*` (proxy z cache było niezgodne z regulaminem MapTiler Cloud). Stare aplikacje (do 0.5.1) przestaną pokazywać mapę po wdrożeniu nowego workera: najpierw nowy build, potem worker.

### Zmieniono (prywatne media)
- Nowe zdjęcia, filmy i głosówki trafiają do Cloudinary jako `authenticated` (test na koncie Free: PASS) i są czytane przez worker z krótkim tokenem jednej podróży (obsługa Range, miniatury, usuwanie). Aplikacja nie dostaje adresów Cloudinary. W Firestore jest tylko `publicId`, `resourceType`, `format`. Reguły wymagają, żeby nowe wspomnienie wskazywało plik w folderze własnej podróży. Starsze wpisy z publicznym `url` nadal działają do migracji. Szczegóły: `docs/private-media.md`.
- Stary format podpisu `/sign` jest odrzucany (426), więc starsze aplikacje nie wyślą już pliku. Kolejność wdrożenia: nowy build, worker, reguły.

### Zmieniono (metadane, tokeny, migracja, nadużycia)
- Nowe zdjęcia są przed wysłaniem oczyszczane z metadanych (GPS, aparat, numery seryjne, daty, XMP, IPTC, miniatury, dopisane obrazy) bez ponownego kodowania. Zostaje orientacja i profil kolorów. Wtyczka wybierania zdjęć kopiuje ok. 100 znaczników EXIF razem z GPS, więc wcześniej każde zdjęcie je zawierało. Formaty inne niż JPEG i PNG są odrzucane. Filmów to nie dotyczy.
- Odświeżanie tokenów mediów: zapas proporcjonalny do czasu życia tokenu (wcześniej stałe 60 s, co przy tokenie 60 s odświeżałoby go przy każdym pliku), jedno ponowienie po 401, wideo otwierane na nowo z nowym tokenem, gdy token zaraz wygaśnie. Domyślny `MEDIA_TOKEN_TTL` zostaje 600 s, 120 s po teście na telefonie.
- Usuwanie wspomnienia: najpierw plik, potem wpis. Błąd pokazuje komunikat i można ponowić (operacja idempotentna).
- Worker: opcjonalna lista dozwolonych kont `ALLOWED_UIDS`.
- Narzędzie migracji publicznych plików (`tools/migrate-media-to-private.mjs`) z trybem dry-run, wznawianiem, kontrolą sum SHA-256, rollbackiem i restore. Niewykonane.

### Zmieniono (zamknięta grupa, wideo, migracja, testy E2E)
- Komunikat przy wyłączonej rejestracji (`admin-restricted-operation`) i czytelne komunikaty logowania. Dokumentacja Firebase opisuje wyłączenie samodzielnego zakładania kont (Settings, User actions). App Check z Play Integrity nie pasuje do instalacji spoza Google Play, rekomendacja: nie wdrażać (`docs/security-model.md`).
- Worker: `VIDEO_STRIP=1` dodaje do podpisu wysyłania filmu transformację `fl_force_strip` (domyślnie wyłączone, wymaga testu na koncie). Skrypt `worker/cloudinary-video-strip-check.mjs` i syntetyczny film testowy z fałszywą lokalizacją.
- Narzędzie migracji: katalog kopii jest wymagany i nie może leżeć w repozytorium, projekcie ani w folderze synchronizowanym (ten projekt jest synchronizowany przez Syncthing), pliki z uprawnieniami 600, odczyt zwrotny kopii, finalize wymaga kompletnych kopii, obsługa wpisu usuniętego w trakcie migracji. Skrypt do próby generalnej na syntetycznych plikach.
- Skrypty testów E2E: `tools/e2e-preflight.mjs`, `tools/e2e-api-check.mjs`. Instrukcja dla telefonu: `docs/phone-test-runbook.md`.

### Znane problemy
- Istniejące pliki są publiczne pod adresem URL do czasu migracji (plan gotowy, niewykonany). Osoba usunięta z grupy zachowuje dostęp do mediów najwyżej do wygaśnięcia już wydanego tokenu (domyślnie 10 min).

## 0.5.1 (2026-10-21, noc) - widoczne błędy wysyłania
APK: `BMB.apk`, numer budowy 6.

### Naprawiono
- Błędy przy dodawaniu zdjęcia, wideo lub głosówki (brak zgody na mikrofon, za duży film, błąd wysyłania) pokazują się teraz w panelu miejsca. Wcześniej komunikat lądował pod panelem i był niewidoczny, więc wysyłanie kończyło się po cichu.

## 0.5.0 (2026-10-21, wieczór) - bezpieczeństwo i poprawki z audytu
APK: `BMB.apk`, numer budowy 5.

### Bezpieczeństwo
- **Podróże są prywatne.** Reguły Firestore: dokument podróży czytają tylko członkowie. Wcześniej każdy zalogowany użytkownik mógł czytać cudze podróże i wpisać się na listę członków, a przez to zobaczyć ich zdjęcia, wydatki, SOS i lokalizacje na żywo.
- **Kody zaproszeń w osobnej kolekcji `invites/<kod>`.** Dołączyć można tylko z poprawnym kodem i tylko dopisując siebie. Członek może wyjść, ale nie usunie innych.
- Testy reguł na emulatorze Firestore (14 scenariuszy, folder `rules-test/`).

### Naprawiono
- **Rozliczenie w walucie podróży** (np. EUR) liczyło zły kwoty, bo przeliczało wydatek po kursie z dnia dodania, a walutę rozliczeń po dzisiejszym. Wyniki zmieniały się z dnia na dzień.
- **„Opuść podróż”** wyłącza teraz udostępnianie lokalizacji (wcześniej usługa w tle i powiadomienie działały dalej).
- Wysyłanie plików na Cloudinary ma limit czasu 3 minuty (wcześniej mogło wisieć w nieskończoność).
- Przełączanie zakładek nie otwiera już od nowa nasłuchów bazy (mniej odczytów, brak mignięć).
- Zepsute polskie znaki w kodzie (m.in. awaryjna nazwa „Podróżnik”).

### Zmieniono
- Usunięty nieużywany kod i zależność `permission_handler`.

### Wymaga akcji
- Opublikować nowe `firestore.rules` w konsoli Firebase. Do tego czasu stare reguły nadal chronią tylko częściowo.
- Wszyscy użytkownicy muszą zainstalować nowe APK, żeby dołączać do nowych podróży kodem. Stara wersja nie dołączy.

## 0.4.0 (2026-10-21, popołudnie) - mniejsze zużycie limitów
APK: `BMB.apk` zbudowany 21.10 o 20:43 (numer budowy 4, w pliku wciąż `0.1.0+1`).

### Zmieniono
- Pozycja zapisuje się rzadziej: co 30 s i po przesunięciu o 50 m (było 10 s i 15 m).
- Mapa i zakładka Ekipa współdzielą jeden nasłuch lokalizacji zamiast dwóch. Razem szacunkowo ok. 6 razy mniej odczytów Firestore.
- Zdjęcia wysyłane w niższej jakości (75%, maks. 1600 px).
- Wideo: nagrywanie do 1 minuty, kompresja na telefonie do średniej jakości przed wysłaniem, limit ok. 90 MB.

### Dodano
- Dokument `limity.md` z oceną, który limit darmowych usług przekroczymy pierwszy.

## 0.3.0 (2026-10-05) - nowa nazwa BMB, mapa na żywo, linki
APK: `BMB.apk` zbudowany 5.10 o 18:45 (poprzedzające buildy `Wycieczka.apk` z 17:45 i 17:57), w pliku `0.1.0+1`.

### Dodano
- **Nowa nazwa BMB i nowe logo** (ikona klasyczna i adaptacyjna, logo na ekranie logowania).
- **Lokalizacja na żywo na mapie:** podpisy „Imię · 3 min temu”, własny punkt, szary punkt po 10 minutach bez aktualizacji, przycisk „Pokaż ekipę”.
- **Udostępnianie lokalizacji działa w tle** (usługa pierwszoplanowa z widocznym powiadomieniem) i po wyjściu z ekranu podróży.
- **Miniatury na mapie:** miejsce ze zdjęciem lub wideo ma okrągłą miniaturę zamiast zielonego punktu.
- **Przycisk play na mapie** dla głosówek: odtwarzanie wprost z mapy.
- **Link do rezerwacji jest klikalny:** otwiera aplikację Booking (lub inną obsługującą adres), a gdy jej nie ma, przeglądarkę. Dodany przycisk „Otwórz rezerwację” i kopiowanie linku.

## 0.2.0 (2026-10-04) - sekrety poza aplikacją
APK: `Wycieczka.apk` zbudowany 4.10 o 09:28, w pliku `0.1.0+1`.

### Dodano
- **Worker Cloudflare** trzyma klucze (MapTiler, Cloudinary). W aplikacji nie ma już żadnych kluczy, tylko publiczny adres workera.
- **Podpisane wysyłanie plików** do Cloudinary (podpis wystawia worker po sprawdzeniu tokenu logowania Firebase).
- **Przelicznik NBP widoczny w aplikacji:** w oknie „Nowy wydatek” pokazuje się przeliczenie na walutę podróży z kursem, a na liście wydatków kwota „≈ …”.
- **Ukryta niespodzianka** w zakładce Ekipa (5 stuknięć w ikonę klucza): miniatura filmu z linkiem do YouTube.
- Dokumenty `USLUGI.md` i `STACK.md` (usługi, przepływ danych, limity).

### Zmieniono
- Mapa startuje na miejscu podróży (pierwsze miejsce albo geokodowany cel podróży), podpowiedź ma przycisk zamknięcia, na mapie widać podpis źródła danych.

## 0.1.0 (2026-10-03) - pierwsze wydanie
APK: pierwsze budowy `Wycieczka.apk` (debug, potem release z 17:45), w pliku `0.1.0+1`.

### Dodano
- Aplikacja na Androida (Flutter) dla grupy znajomych w podróży:
  - logowanie e-mailem i przez Google, podróże z kodem zaproszenia,
  - mapa świata (MapLibre, dane MapTiler/OpenStreetMap), miejsca dodawane przytrzymaniem,
  - zdjęcia, wideo i głosówki z opisem przypisane do miejsc (Cloudinary),
  - przeloty każdego uczestnika osobno,
  - noclegi z linku rezerwacji (nazwa, adres, daty i godziny zameldowania, na ile da się odczytać ze strony),
  - wydatki w wielu walutach z kursami NBP i wyliczeniem „kto komu ile oddaje”,
  - udostępnianie lokalizacji i przycisk SOS z alarmem dźwiękowym u pozostałych.
- Ikona aplikacji (pierwsza wersja).

### Zmieniono względem pierwotnego planu
- Cloudinary zamiast Firebase Storage (Storage wymaga planu z kartą).
- Alarm SOS działa przy uruchomionej aplikacji, bo wysyłanie powiadomień przy zamkniętej wymaga Cloud Functions (plan z kartą).
- Logowanie telefonem pominięte (SMS-y są płatne).

## Znane ograniczenia (stan na 0.5.0)
- Alarm SOS nie dociera, gdy aplikacja jest zamknięta.
- Nie sprawdzono na urządzeniu: kompresja wideo, współdzielone nasłuchy, tworzenie zaproszenia i dołączanie po zmianie reguł.
- Rejestracja jest otwarta, a APK podpisany kluczem debug (do testów w gronie znajomych, nie do Google Play).
