# CrewAtlas (dawniej BMB, Wycieczka) - usługi, przepływ danych i limity

Stan na 2026-10-04. **Limity poniżej podaję z pamięci i mogą się zmienić - przed poleganiem na nich sprawdź aktualne cenniki** (linki na końcu). Żadna usługa nie wymaga obecnie karty płatniczej.

## 1. Schemat

```
                      ┌────────────────────────────┐
  Telefon (Flutter) ──►  Firebase Auth  (logowanie)  │
        │             └────────────────────────────┘
        │  dane na żywo        ┌──────────────────────┐
        ├─────────────────────►  Cloud Firestore       │  podróże, miejsca, przeloty,
        │                      └──────────────────────┘  noclegi, wydatki, SOS, lokalizacje
        │  token Firebase      ┌──────────────────────┐   klucz       ┌───────────┐
        ├─────────────────────►  Worker Cloudflare     ├──────────────►  MapTiler  │ mapa, geokodowanie
        │                      │  (trzyma sekrety)     │   podpis      ├───────────┤
        │                      └──────────────────────┘ ─────────────►  Cloudinary│ (tylko podpis)
        │  plik + podpis
        ├──────────────────────────────────────────────────────────►  Cloudinary   zdjęcia/wideo/głosówki
        │  kursy walut
        └──────────────────────────────────────────────────────────►  API NBP
```

Zasada: **w aplikacji nie ma żadnego klucza API.** Aplikacja zna tylko adres workera i konfigurację Firebase (`google-services.json`, to są publiczne identyfikatory). Sekrety są w Cloudflare.

## 2. Usługi

| Usługa | Do czego | Plan | Karta? | Limity (orientacyjnie) |
|---|---|---|---|---|
| **Firebase Authentication** | logowanie e-mail/hasło i Google | Spark (darmowy) | nie | e-mail i Google bez limitu istotnego dla nas; logowanie telefonem (SMS) pominięte, bo płatne |
| **Cloud Firestore** | baza danych w czasie rzeczywistym | Spark | nie | ok. 1 GiB danych, 50 tys. odczytów, 20 tys. zapisów i 20 tys. usunięć dziennie |
| **Cloudflare Workers** | pośrednik z sekretami (mapa, podpis wysyłania) | Free | nie | 100 tys. żądań dziennie, krótki czas CPU na żądanie |
| **MapTiler Cloud** | kafelki mapy (dane OpenStreetMap), wyszukiwanie miejsc | Free | nie | miesięczny limit żądań/sesji, **tylko użytek niekomercyjny**; wymagany podpis źródła |
| **Cloudinary** | przechowywanie zdjęć, wideo i głosówek | Free | nie | miesięczna pula „kredytów” wspólna dla miejsca, transferu i przetwarzania (rzędu 25 kredytów); limity rozmiaru pojedynczego pliku |
| **API NBP** | średnie kursy walut do rozliczeń | publiczne | nie | brak klucza; nie nadużywać (zapytanie na wydatek) |
| **Firebase Cloud Messaging** | push SOS przy zamkniętej aplikacji | - | - | **nieużywane w praktyce**, patrz sekcja 5 |

Co świadomie pominięto: **Firebase Storage** (od niedawna wymaga planu Blaze, czyli karty) - zastąpiony przez Cloudinary.

## 3. Jak działają poszczególne funkcje

### Logowanie
Aplikacja loguje przez Firebase Auth (e-mail/hasło lub Google). Do Google potrzebny jest odcisk SHA-1 klucza podpisującego APK, dodany w ustawieniach projektu Firebase. Konto zapisuje się w kolekcji `users`.

### Podróże i dołączanie
Podróż to dokument w `trips` z listą `memberIds` i 6-znakowym `inviteCode`. Dołączasz, wpisując kod: aplikacja dopisuje Twoje id do `memberIds`. Reguły Firestore (`firestore.rules`) wpuszczają do podkolekcji tylko członków.

### Mapa
1. Aplikacja wysyła token Firebase do workera (`GET /session`).
2. Worker sprawdza podpis tokenu (klucze publiczne Google, projekt `YOUR_FIREBASE_PROJECT_ID`), pobiera styl mapy z MapTiler **z Twoim kluczem** i przepisuje wszystkie adresy tak, by wskazywały na worker. Zwraca styl i krótki token (ważny 24 h, podpisany HMAC).
3. Kafelki, czcionki i ikony idą przez `GET /m/...?t=<token>`; worker dopisuje klucz MapTiler i przekazuje odpowiedź (z pamięcią podręczną Cloudflare).
4. Start mapy: pierwsze dodane miejsce albo geokodowanie pola „Dokąd” (też przez worker).

Miejsca na mapie to dokumenty w `trips/<id>/places`; dodajesz je przytrzymaniem mapy.

### Zdjęcia, wideo i głosówki
1. Aplikacja prosi worker o podpis (`POST /sign`, folder `wycieczka/<id podróży>` - prefiks historyczny, zostaje dla zgodności z zainstalowanymi aplikacjami).
2. Worker sprawdza token Firebase i podpisuje żądanie **API Secretem Cloudinary** (sekret nie opuszcza workera).
3. Aplikacja wysyła plik bezpośrednio do Cloudinary z tym podpisem. Zdjęcia idą jako `image`, wideo i dźwięk jako `video`.
4. Zwrócony link zapisuje się w `trips/<id>/memories` razem z opisem.

Usunięcie wspomnienia kasuje tylko wpis w bazie; **plik zostaje w Cloudinary** (usuwanie wymaga API Secret, którego nie ma w aplikacji) i zajmuje limit.

### Przeloty
Każdy uczestnik dodaje własne przeloty (skąd, dokąd, wylot, przylot, uwagi) w `trips/<id>/legs`. Widok grupuje je po osobach.

### Noclegi z linku
Aplikacja **bezpośrednio z telefonu** pobiera stronę z podanego linku i wyciąga: nazwę i adres (JSON-LD / tagi OpenGraph), zdjęcie, godziny zameldowania i wymeldowania (z tekstu strony), daty (z parametrów adresu). Wynik można poprawić ręcznie. To **best-effort**: serwisy rezerwacyjne często blokują automatyczne pobieranie albo ładują dane skryptem, wtedy część pól zostanie pusta. Nie sprawdzano na prawdziwych stronach Booking/Cozycozy.

### Wydatki i rozliczenia
Wydatek ma kwotę, walutę, opis, płacącego i uczestników. Przy dodaniu aplikacja pobiera średni kurs z NBP (tabela A, a w razie braku B) i zapisuje go przy wydatku. Rozliczenie liczone jest w groszach w walucie podróży, a liczba przelewów jest minimalizowana (zachłannie). Logika jest w `lib/services/settlement.dart` i ma testy jednostkowe.

### Lokalizacja i SOS
- **Lokalizacja na żywo:** przełącznik w zakładce Ekipa zapisuje Twoje położenie do `trips/<id>/locations`; inni widzą je na mapie. Działa tylko, gdy aplikacja jest uruchomiona.
- **SOS:** przycisk tworzy dokument w `trips/<id>/sos`. Aplikacje pozostałych uczestników nasłuchują zmian w Firestore i odtwarzają syrenę (strumień alarmowy) z pełnoekranowym komunikatem i lokalizacją.

## 4. Gdzie leżą sekrety

| Wartość | Gdzie | Jawna? |
|---|---|---|
| `MAPTILER_KEY` | Cloudflare (Secret) | nie |
| `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudflare (Secret) | nie |
| `HMAC_SECRET` | Cloudflare (Secret) | nie |
| `CLOUDINARY_CLOUD`, `FIREBASE_PROJECT_ID` | Cloudflare (zwykłe zmienne) | nie są sekretami |
| Adres workera (`WORKER_URL`) | w aplikacji (parametr budowania) | tak, to nie sekret |
| Konfiguracja Firebase | `android/app/google-services.json` | publiczne identyfikatory |

Wszystkie sekrety, które kiedykolwiek trafiły do czatu, należy traktować jako ujawnione i wymienić (stare klucze MapTiler i Cloudinary).

## 5. Znane ograniczenia

- **SOS po zamknięciu aplikacji nie działa.** Wymagałby Cloud Functions (`functions/index.js`, gotowe, niewdrożone), a to wymaga planu Blaze (karta). Teraz alarm dochodzi, gdy aplikacja działa (także w tle, dopóki system jej nie zabije).
- **Rejestracja jest otwarta, ale podróże są prywatne.** Dokument podróży czytają tylko jej członkowie. Kod zaproszenia jest w osobnej kolekcji `invites/<kod>` (kod -> id podróży); dołączyć można tylko z poprawnym kodem i tylko dopisując siebie. Reguły sprawdzają testy w `rules-test/` (`npm test`, wymaga Node i Javy). Nadal każdy, kto ma aplikację (albo wyciągnie z APK adres workera i konfigurację Firebase), może założyć konto i korzystać z workera (mapa, podpisy Cloudinary), zużywając limity. Świadomie to zostawiamy, bo APK dostają tylko wybrane osoby; opcją na później jest wymóg potwierdzonego e-maila.
- **Limit workera (100 tys. żądań/dzień).** Każde otwarcie mapy to dziesiątki kafelków; przy wielu użytkownikach limit da się wyczerpać.
- **Pliki w Cloudinary nie są usuwane** przy kasowaniu wspomnień.
- **APK jest podpisany kluczem debug** - nadaje się do testów wśród znajomych, nie do Google Play.
- **Niesprawdzone na urządzeniu:** wysyłanie plików przez podpisane żądanie, noclegi z prawdziwych linków, wydatki z NBP, SOS na drugim telefonie, lokalizacja na żywo.

## 6. Budowanie i wdrażanie

- **Build:** folder projektu nie może mieć `!` w ścieżce (Gradle się wywraca); buduj w kopii bez wykrzyknika. Wymagane: Flutter, Android SDK z NDK 28.2 i `compileSdk` 37.
  `flutter build apk --release --dart-define=WORKER_URL=https://YOUR_WORKER_URL`
- **Worker:** kod w `worker/worker.js`, wklejany w panelu Cloudflare (Edit code → Deploy). Testy lokalne: `node worker/test.mjs`. Po zmianie sekretów trzeba kliknąć Deploy.
- **Reguły:** `firestore.rules` wklejane w konsoli Firebase (Firestore → Rules → Publish).
- **Testy aplikacji:** `flutter test` (rozliczenia i parser linków rezerwacji).

## 7. Cenniki i dokumentacja

- Firebase: https://firebase.google.com/pricing
- Cloudflare Workers: https://developers.cloudflare.com/workers/platform/limits/
- MapTiler: https://www.maptiler.com/cloud/pricing/
- Cloudinary: https://cloudinary.com/pricing
- NBP API: https://api.nbp.pl
- Dane map: © MapTiler © OpenStreetMap contributors

## Znane problemy bezpieczeństwa i zgodności (stan na 2026-11-17)

Te punkty wynikają z przeglądu przed publikacją repozytorium. Część poprawek jest przygotowana lokalnie, ale **nie wdrożona**.

| Obszar | Stan | Status |
|---|---|---|
| Reguły Firestore | Nowe reguły (`firestore.rules`) zamykają odczyt cudzych profili `users/*` i ograniczają zapis i usuwanie w podróży do autora wpisu lub założyciela. 33 testy na emulatorze. | przygotowane, **niewdrożone** |
| Worker `/sign` | Podpis tylko dla członków podróży (sprawdzenie w Firestore z tokenem użytkownika), v2: jeden podpis = jeden plik, lista formatów. Rozmiaru pliku podpis nie ogranicza. | przygotowane, **niewdrożone** |
| Media Cloudinary | Nowe pliki są prywatne (`authenticated`) i czytane przez worker z krótkim tokenem (test na koncie Free: PASS). Stare pliki są publiczne, dopóki nie zostaną zmigrowane (plan w `docs/private-media.md`, niewykonany). | przygotowane, **niewdrożone** |
| Mapa | Proxy z cache przez worker było niezgodne z regulaminem MapTiler Cloud (pkt 6.1 i 7.2). Usunięte lokalnie: aplikacja łączy się z MapTiler bezpośrednio (klucz w buildzie, publiczny). Kolejność wdrożenia: najpierw nowy build, potem worker (`worker/README.md`). | przygotowane, **niewdrożone** |
| Rejestracja w Firebase Auth | Nie sprawdzono ustawień w konsoli. Konto może założyć każdy, kto zna konfigurację projektu. | do sprawdzenia w konsoli |
