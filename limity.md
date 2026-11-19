# CrewAtlas - który limit przekroczymy pierwszy

Stan na 2026-10-21. Założenie: grupa 5 osób, podróż z intensywnym zwiedzaniem.

**Co jest potwierdzone, a co nie.** Limity Firestore sprawdziłem w dokumentacji Google (https://firebase.google.com/docs/firestore/quotas). Limity Cloudinary, MapTiler i Cloudflare podaję z pamięci. Strona pomocy Cloudinary nie podała liczb, a MapTilera nie sprawdzałem. Zużycie poniżej to szacunek z kodu, a nie pomiar.

## Wniosek

Pierwszy limit, który nas dotknie, to **dzienny limit odczytów Firestore (50 000)**. Zużywa go udostępnianie lokalizacji na żywo. Po jego przekroczeniu przestaje działać cała aplikacja, także SOS, bo alarm przechodzi przez Firestore.

## Szacunek odczytów przy lokalizacji na żywo

Każda zmiana pozycji to 1 zapis, ale 10 odczytów. Pozycję pobiera 5 telefonów, a na każdym nasłuchują dwa miejsca w aplikacji (mapa i zakładka Ekipa).

| Założenie | Wynik |
|---|---|
| Pozycja zapisuje się co ok. 11 s podczas marszu (przy ruchu o 15 m) | ok. 330 zapisów na godzinę na osobę |
| 5 osób idzie ok. 4 h dziennie i wszyscy udostępniają | ok. 6 500 zapisów dziennie (limit 20 000) |
| 10 odczytów na każdy zapis | **ok. 65 000 odczytów dziennie (limit 50 000)** |

Przy 3 osobach wychodzi ok. 23 000 odczytów, więc limit raczej się utrzyma. Przy 5 osobach intensywnie chodzących i dzielących lokalizację zostanie przekroczony.

**Skutek przekroczenia:** Firestore odmawia dalszych operacji do północy czasu pacyficznego (u nas ok. 9:00 rano, od końca października ok. 8:00). W tym czasie nie działa nic, co korzysta z bazy, w tym SOS.

## Wszystkie limity w kolejności zagrożenia

| Miejsce | Limit | Ryzyko | Uwagi |
|---|---|---|---|
| **Firestore, odczyty** | 50 000 dziennie | **wysokie** | patrz wyżej; potwierdzone w dokumentacji |
| **Cloudinary, wideo** | z pamięci: limit wielkości pliku (rzędu 100 MB dla wideo) i miesięczna pula kredytów (rzędu 25) | **średnie** | nagrania do 2 min mają zwykle 100-250 MB, więc pierwszy dłuższy film może zostać odrzucony; odtwarzanie filmów zjada transfer; niezweryfikowane |
| **Firestore, zapisy** | 20 000 dziennie | niskie do średniego | zbliżymy się do nich dopiero przy ok. 8 osobach; potwierdzone w dokumentacji |
| **Firestore, dane** | 1 GiB | niskie | tekst i linki, pliki są w Cloudinary |
| **Cloudflare Workers** | z pamięci: 100 000 żądań dziennie | niskie | kilka tysięcy żądań dziennie na grupę |
| **MapTiler** | z pamięci: miesięczny limit żądań, tylko użytek niekomercyjny | niskie | zużycie mapy przez 5 osób jest niewielkie; niezweryfikowane |

## Co zmniejszyłoby ryzyko

Obie zmiany są małe i zmniejszą odczyty ok. 6-krotnie (z ok. 65 000 do ok. 11 000):

1. Zapisywać pozycję rzadziej (co 30 s i 50 m zamiast 10 s i 15 m).
2. Połączyć dwa nasłuchy lokalizacji w jeden.

Dla wideo: skrócić maksymalną długość nagrania albo obniżyć jakość przy wysyłaniu.

## Jak to sprawdzać

- Firebase → Firestore → zakładka Usage: odczyty, zapisy i usunięcia z podziałem na dni.
- Cloudflare → Workers & Pages → (nazwa Twojego workera) → Metrics: liczba żądań i błędów.
- Cloudinary → panel główny: zużycie kredytów w bieżącym miesiącu.
- MapTiler → Analytics: zużycie kafelków.

Szerszy opis usług i przepływu danych jest w `USLUGI.md`, a zestawienie stosu w `STACK.md`.
