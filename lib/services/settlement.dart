/// Czysta logika rozliczeń - bez zależności od Fluttera/Firebase (łatwe testy).
///
/// Wszystkie obliczenia na groszach (int), żeby uniknąć błędów zmiennoprzecinkowych.
class ExpenseInput {
  final double amount;
  final String currency;
  final double rateToPln;
  final String paidBy;
  final List<String> participants;

  const ExpenseInput({
    required this.amount,
    required this.currency,
    required this.rateToPln,
    required this.paidBy,
    required this.participants,
  });
}

class Transfer {
  final String from;
  final String to;
  final double amount;
  const Transfer(this.from, this.to, this.amount);

  @override
  String toString() => '$from -> $to: ${amount.toStringAsFixed(2)}';
}

/// Przelicza kwotę z waluty o kursie [rateFrom] na walutę o kursie [rateTo]
/// (kursy: ile PLN za 1 jednostkę).
double convert(double amount, double rateFrom, double rateTo) =>
    amount * rateFrom / rateTo;

/// Saldo każdego uczestnika w groszach waluty bazowej.
/// Dodatnie = inni mu są winni, ujemne = on jest winien.
Map<String, int> computeBalances(
  List<ExpenseInput> expenses,
  double baseRateToPln,
  Iterable<String> members, {
  required String baseCurrency,
}) {
  final bal = {for (final m in members) m: 0};
  for (final e in expenses) {
    if (e.participants.isEmpty) continue;
    // Wydatek w walucie rozliczeń bierzemy bez przeliczania (kurs z dnia dodania nie jest dzisiejszym).
    final rate = e.currency == baseCurrency ? baseRateToPln : e.rateToPln;
    final total = (convert(e.amount, rate, baseRateToPln) * 100).round();
    final n = e.participants.length;
    final share = total ~/ n;
    var rest = total - share * n; // reszta groszy rozdzielana po jednym
    bal[e.paidBy] = (bal[e.paidBy] ?? 0) + total;
    for (final p in e.participants) {
      final extra = rest > 0 ? 1 : 0;
      if (rest > 0) rest--;
      bal[p] = (bal[p] ?? 0) - share - extra;
    }
  }
  return bal;
}

/// Minimalizuje liczbę przelewów (zachłannie: największy dłużnik -> największy wierzyciel).
List<Transfer> settle(Map<String, int> balances) {
  final debtors = <MapEntry<String, int>>[];
  final creditors = <MapEntry<String, int>>[];
  balances.forEach((k, v) {
    if (v < 0) debtors.add(MapEntry(k, -v));
    if (v > 0) creditors.add(MapEntry(k, v));
  });
  debtors.sort((a, b) => b.value.compareTo(a.value));
  creditors.sort((a, b) => b.value.compareTo(a.value));

  final out = <Transfer>[];
  var i = 0, j = 0;
  var d = debtors.isEmpty ? 0 : debtors[0].value;
  var c = creditors.isEmpty ? 0 : creditors[0].value;
  while (i < debtors.length && j < creditors.length) {
    final x = d < c ? d : c;
    if (x > 0) out.add(Transfer(debtors[i].key, creditors[j].key, x / 100));
    d -= x;
    c -= x;
    if (d == 0) {
      i++;
      if (i < debtors.length) d = debtors[i].value;
    }
    if (c == 0) {
      j++;
      if (j < creditors.length) c = creditors[j].value;
    }
  }
  return out;
}
