# Worker Cloudflare (sekrety poza aplikacją)

Worker trzyma sekret Cloudinary i klucz tokenów mediów. Aplikacja wysyła mu token logowania Firebase,
a on sprawdza podpis tokenu (projekt `YOUR_FIREBASE_PROJECT_ID`) i dopiero wtedy podpisuje wysyłanie plików
do Cloudinary (`/sign`), wydaje krótki token dostępu do mediów podróży (`/media/token`) i streamuje prywatne pliki
(`/media/...`). Szczegóły architektury: `docs/private-media.md`. Mapa **nie** przechodzi przez worker:
aplikacja łączy się z MapTiler bezpośrednio (klucz `MAPTILER_KEY` w buildzie, patrz `docs/setup.md`).

## Wdrożenie (panel Cloudflare, bez karty)
1. Konto: https://dash.cloudflare.com (plan Free).
2. **Workers & Pages → Create → Create Worker**, nazwa np. `crew-atlas-worker`, **Deploy**.
3. **Edit code**: zaznacz całą zawartość, wklej `worker.js` z tego folderu, **Deploy**.
4. **Settings → Variables and Secrets → Add**:

   | Nazwa | Typ | Wartość |
   |---|---|---|
   | `CLOUDINARY_API_KEY` | Secret | Cloudinary → Settings → API Keys |
   | `CLOUDINARY_API_SECRET` | Secret | tamże |
   | `MEDIA_TOKEN_SECRET` | Secret | długi losowy tekst (np. 48 znaków szesnastkowych). Zmiana unieważnia wszystkie tokeny. |
   | `MEDIA_TOKEN_TTL` | Text (opcjonalnie) | ważność tokenu w sekundach, 60 do 3600, domyślnie 600. Krótszy (120) skraca dostęp po opuszczeniu grupy, ale wymaga testu wideo na telefonie, patrz `docs/private-media.md`. |
   | `VIDEO_STRIP` | Text (opcjonalnie) | `1`: filmy dostają transformację `fl_force_strip` przy wysyłaniu (usuwa metadane). Włącz dopiero po teście `cloudinary-video-strip-check.mjs` na swoim koncie i po odtworzeniu wyniku na telefonie. |
   | `ALLOWED_UIDS` | Text (opcjonalnie) | uid kont po przecinku. Gdy ustawione, tylko te konta dostają podpisy, tokeny i mogą usuwać media. Ogranicza nadużycia przez obce konta. |
   | `CLOUDINARY_CLOUD` | Text | `YOUR_CLOUDINARY_CLOUD_NAME` |
   | `FIREBASE_PROJECT_ID` | Text | `YOUR_FIREBASE_PROJECT_ID` |

5. **Deploy**. Otwórz `https://YOUR_WORKER_URL/health` - powinno zwrócić `{"ok":true}`.

Adres workera (bez końcowego `/`) podajesz przy budowaniu aplikacji:
`flutter build apk --release --dart-define-from-file=config.local.json` (patrz `config.example.json`)

## Punkty końcowe
- `POST /sign` `{"folder": "wycieczka/<id>", "v": 2}`: podpis wysyłania **jednego** pliku. Tylko dla członków podróży (worker pyta Firestore z tokenem użytkownika, decydują reguły). Zawsze `type=authenticated`, `public_id` nadaje worker, `overwrite=false`, lista `allowed_formats`. Klient niczego nie dokłada. Stary format (bez `v: 2`) zwraca 426.
- `POST /media/token` `{"tripId": "..."}`: krótki token (domyślnie 10 min) dla jednej podróży, po sprawdzeniu członkostwa.
- `GET|HEAD /media/<image|video>/<tripId>/<id>.<format>[?thumb=1]` z nagłówkiem `Authorization: Bearer <token mediów>`: strumień pliku z obsługą Range. Odpowiedź `private, no-store`. Token **nie** może być w adresie.
- `DELETE /media/memory/<tripId>/<memoryId>` z tokenem Firebase: usuwa plik w Cloudinary, jeśli wołający jest autorem wspomnienia lub założycielem podróży (metadane z dokumentu Firestore).
- Rozmiaru pliku podpis nie ogranicza. Obowiązują limity konta Cloudinary i limit w aplikacji.

## Kolejność wdrożenia po usunięciu proxy mapy
Nowy worker nie ma ścieżek `/session` i `/m/*` i odrzuca stary format `/sign` (426). **Starsze aplikacje** (do 0.5.1) pobierają mapę przez dawne ścieżki i przestaną ją pokazywać, a wysyłanie plików też przestanie u nich działać. Najpierw rozdaj nowy build aplikacji, potem wdróż worker, potem reguły Firestore (`docs/private-media.md`). Sekrety `MAPTILER_KEY` i `HMAC_SECRET` można wtedy usunąć z Cloudflare, a klucz MapTiler warto obrócić, bo był używany po stronie serwera.

## Testy
`node test.mjs` (podpisy wysyłania) i `node media.test.mjs` (bramka mediów), Node 20+: weryfikacja tokenów, członkostwo, podpisy, Range i strumień, usuwanie, brak wycieku adresów, na atrapach zewnętrznych usług (Firestore REST, klucze Firebase, Cloudinary).

## Limity
Plan Free: 100 000 żądań dziennie. Przez worker idzie teraz każde wyświetlenie pliku (zdjęcie, miniatura, żądania Range filmu). Oszacowanie dla małej grupy: `docs/private-media.md`.

## Ręczny test prywatności Cloudinary
`cloudinary-privacy-check.mjs` sprawdza na Twoim koncie, czy działa dostęp `authenticated` z podpisanymi adresami. Wysyła jeden syntetyczny plik testowy 1x1, usuwa dokładnie ten jeden plik, nie wypisuje sekretów ani adresów i niczego nie zapisuje na dysku. Bezpieczeństwo skryptu sprawdza `cloudinary-privacy-check.test.mjs` (atrapa, bez sieci).

```bash
read -rs CLOUDINARY_API_SECRET && export CLOUDINARY_API_SECRET   # wpisz po cichu, bez historii powłoki
read -r  CLOUDINARY_CLOUD   && export CLOUDINARY_CLOUD
read -rs CLOUDINARY_API_KEY && export CLOUDINARY_API_KEY
node worker/cloudinary-privacy-check.mjs
```
Wyniki: pięć linii PASS/FAIL (upload, odmowa bez podpisu, odmowa adresu publicznego, działanie podpisanego adresu, odmowa złego podpisu), linia INFO o transformacji i `RESULT: PASS` albo `FAIL`. Jeśli sprzątanie się nie powiedzie, skrypt wypisze, że folder `crewatlas-privacy-check/` trzeba usunąć ręcznie w konsoli Cloudinary. Przekaż mi tylko wynik (linie PASS/FAIL i RESULT), nigdy poświadczenia.
