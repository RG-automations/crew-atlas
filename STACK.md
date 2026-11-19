# CrewAtlas (dawniej BMB, Wycieczka) - darmowy stos technologiczny

Aplikacja na Androida dla osób podróżujących razem. Stan na 2026-10-10. Żadna z usług poniżej nie wymaga karty płatniczej.

Limity podaję z pamięci, więc mogą być nieaktualne. Sprawdź aktualne cenniki (linki na końcu). Jak działają poszczególne funkcje i którędy płyną dane, opisuje `USLUGI.md`.

## Co wyszło inaczej niż w pierwotnym planie

| Pierwotny plan | Co jest naprawdę | Dlaczego |
|---|---|---|
| Firebase Storage (5 GB) | **Cloudinary** | Storage wymaga teraz planu Blaze, czyli karty |
| Klucz MapTiler w aplikacji | **Worker Cloudflare** trzyma klucz | klucz w aplikacji da się wyciągnąć z APK |
| Wysyłanie plików bez podpisu | **Podpisane wysyłanie** (podpis robi worker) | API Secret nie może być w aplikacji |
| Push FCM przy zamkniętej aplikacji | **Nasłuch Firestore** (działa przy uruchomionej aplikacji) | wysyłanie FCM z chmury wymaga Cloud Functions, czyli Blaze |
| Logowanie telefonem | pominięte | SMS-y są płatne |

## Aplikacja (telefon)

| Element | Wybór |
|---|---|
| Framework | **Flutter 3.47** (Dart 3.13), tylko Android |
| Mapa | **MapLibre** (`maplibre_gl`) - darmowa mapa wektorowa, bez Google Maps SDK |
| Lokalizacja | `geolocator` (z usługą pierwszoplanową, żeby działało w tle) |
| Nagrywanie i odtwarzanie | `record`, `audioplayers`, `video_player`, `image_picker` |
| Powiadomienia i alarm | `flutter_local_notifications`, syrena generowana w kodzie (strumień alarmowy) |
| Inne | `provider`, `http`, `intl`, `url_launcher` (otwieranie linków rezerwacji w aplikacji Booking itp.) |
| Narzędzia | Android Studio, Flutter SDK, Android SDK (NDK 28.2, `compileSdk` 37) |

Wszystko powyżej jest darmowe.

## Backend i dane

| Usługa | Do czego | Plan | Limity (orientacyjnie) |
|---|---|---|---|
| **Firebase Authentication** | logowanie e-mailem i przez Google | Spark | bez limitu istotnego dla nas (SMS pominięte) |
| **Cloud Firestore** | podróże, miejsca, przeloty, noclegi, wydatki, SOS, lokalizacje na żywo | Spark | ok. 1 GiB danych, 50 tys. odczytów, 20 tys. zapisów, 20 tys. usunięć dziennie |
| **Cloudflare Workers** | pośrednik z sekretami (mapa, podpisy) | Free | 100 tys. żądań dziennie |

Reguły bezpieczeństwa Firestore są w `firestore.rules`. Kod workera w `worker/worker.js`.

## Pliki: zdjęcia, wideo, głosówki

| Usługa | Plan | Limity (orientacyjnie) |
|---|---|---|
| **Cloudinary** | Free | miesięczna pula „kredytów” wspólna dla miejsca, transferu i przetwarzania (rzędu 25 kredytów) |

Aplikacja prosi worker o podpis, wysyła plik prosto do Cloudinary i zapisuje link w Firestore. Miniatury na mapie generuje Cloudinary (parametry w adresie).

## Mapy i dane geograficzne

| Usługa | Do czego | Plan | Limity (orientacyjnie) |
|---|---|---|---|
| **MapTiler Cloud** | kafelki mapy z danymi OpenStreetMap, wyszukiwanie miejsc | Free | miesięczny limit żądań, **tylko użytek niekomercyjny**, wymagany podpis źródła |

Na mapie widać podpis „© MapTiler © OpenStreetMap contributors”.

## Waluty

| Usługa | Do czego | Limity |
|---|---|---|
| **API NBP** (`api.nbp.pl`) | średnie kursy walut do rozliczeń | bez klucza i bez rejestracji; nie nadużywać |

Aplikacja pobiera kurs przy dodawaniu wydatku i zapisuje go razem z wydatkiem. Rozliczenie liczy w groszach i minimalizuje liczbę przelewów.

## Opcjonalnie, nieużywane obecnie

| Usługa | Po co | Uwaga |
|---|---|---|
| **Cloud Functions + FCM** | alarm SOS po zamknięciu aplikacji | kod gotowy (`functions/index.js`), wymaga planu Blaze (karta) |
| **Darmowy VPS** (np. oferty typu Mikrus Frog) | mały przekaźnik SOS na własnym serwerze, bez Blaze | trzeba utrzymywać serwer, sprawdź koszt odnowienia po pierwszym roku |

## Gdzie leżą sekrety

Wszystkie sekrety są w Cloudflare (Secret): klucz MapTiler, API Key i API Secret Cloudinary, `HMAC_SECRET`. W aplikacji jest tylko publiczny adres workera i publiczna konfiguracja Firebase (`google-services.json`).

## Cenniki

- Firebase: https://firebase.google.com/pricing
- Cloudflare Workers: https://developers.cloudflare.com/workers/platform/limits/
- MapTiler: https://www.maptiler.com/cloud/pricing/
- Cloudinary: https://cloudinary.com/pricing
- NBP API: https://api.nbp.pl
