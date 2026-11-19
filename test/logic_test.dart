import 'package:flutter_test/flutter_test.dart';
import 'package:crew_atlas/services/booking_parser.dart';
import 'package:crew_atlas/services/settlement.dart';

void main() {
  group('settlement', () {
    test('równy podział i jeden przelew', () {
      final bal = computeBalances(
        [
          const ExpenseInput(
              amount: 90, currency: 'PLN', rateToPln: 1, paidBy: 'a', participants: ['a', 'b', 'c']),
        ],
        1,
        ['a', 'b', 'c'],
        baseCurrency: 'PLN',
      );
      expect(bal, {'a': 6000, 'b': -3000, 'c': -3000});
      final t = settle(bal);
      expect(t.length, 2);
      expect(t.every((x) => x.to == 'a' && x.amount == 30), isTrue);
    });

    test('reszta groszy nie ginie', () {
      final bal = computeBalances(
        [
          const ExpenseInput(
              amount: 100, currency: 'PLN', rateToPln: 1, paidBy: 'a', participants: ['a', 'b', 'c']),
        ],
        1,
        ['a', 'b', 'c'],
        baseCurrency: 'PLN',
      );
      expect(bal.values.fold<int>(0, (s, v) => s + v), 0);
    });

    test('waluty: EUR rozliczane w PLN', () {
      final bal = computeBalances(
        [
          const ExpenseInput(
              amount: 10, currency: 'EUR', rateToPln: 4.3, paidBy: 'a', participants: ['a', 'b']),
        ],
        1,
        ['a', 'b'],
        baseCurrency: 'PLN',
      );
      expect(bal['b'], -2150);
      expect(settle(bal).single.amount, 21.5);
    });

    test('wzajemne długi się znoszą', () {
      final bal = computeBalances(
        [
          const ExpenseInput(
              amount: 50, currency: 'PLN', rateToPln: 1, paidBy: 'a', participants: ['a', 'b']),
          const ExpenseInput(
              amount: 50, currency: 'PLN', rateToPln: 1, paidBy: 'b', participants: ['a', 'b']),
        ],
        1,
        ['a', 'b'],
        baseCurrency: 'PLN',
      );
      expect(settle(bal), isEmpty);
    });

    test('wydatek w walucie rozliczeń nie zależy od dzisiejszego kursu', () {
      // 100 EUR zapisane po 4,3745; dziś kurs EUR to 4,40. Wynik ma zostać 100 EUR, nie 99,43.
      final bal = computeBalances(
        [
          const ExpenseInput(
              amount: 100, currency: 'EUR', rateToPln: 4.3745, paidBy: 'a', participants: ['a', 'b']),
        ],
        4.40,
        ['a', 'b'],
        baseCurrency: 'EUR',
      );
      expect(bal['b'], -5000);
      expect(settle(bal).single.amount, 50);
    });
  });

  group('booking_parser', () {
    test('daty z linku Booking', () {
      final d = datesFromUrl(
          'https://www.booking.com/hotel/pl/x.html?checkin=2026-08-01&checkout=2026-08-05');
      expect(d.from, DateTime(2026, 8, 1));
      expect(d.to, DateTime(2026, 8, 5));
    });

    test('JSON-LD + godziny', () {
      const html = '''
<html><head><title>Fallback</title>
<script type="application/ld+json">
{"@type":"Hotel","name":"Hotel Test","image":"http://x/y.jpg",
 "address":{"streetAddress":"Główna 1","addressLocality":"Kraków","addressCountry":"PL"}}
</script></head>
<body>Zameldowanie od 15:00 <b>Wymeldowanie</b> do 11:30</body></html>''';
      final p = parseStay('https://x.com/?check_in=2026-09-10&check_out=2026-09-12', html);
      expect(p.title, 'Hotel Test');
      expect(p.address, 'Główna 1, Kraków, PL');
      expect(p.checkInTime, '15:00');
      expect(p.checkOutTime, '11:30');
      expect(p.checkIn, DateTime(2026, 9, 10));
    });

    test('og:title jako zapas', () {
      final p = parseStay('https://x.com',
          '<meta property="og:title" content="Apartament &amp; Spa">');
      expect(p.title, 'Apartament & Spa');
    });
  });
}
