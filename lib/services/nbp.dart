import 'dart:convert';

import 'package:http/http.dart' as http;

/// Kursy z darmowego API NBP (bez klucza). Zwraca ile PLN kosztuje 1 jednostka waluty.
class Nbp {
  static final Map<String, double> _cache = {};

  static Future<double> rateToPln(String code) async {
    code = code.toUpperCase();
    if (code == 'PLN') return 1;
    final cached = _cache[code];
    if (cached != null) return cached;
    var lastStatus = 0;
    for (final table in ['a', 'b']) {
      final res = await http
          .get(Uri.parse('https://api.nbp.pl/api/exchangerates/rates/$table/$code/?format=json'))
          .timeout(const Duration(seconds: 10));
      lastStatus = res.statusCode;
      if (res.statusCode == 200) {
        final mid = (jsonDecode(res.body)['rates'][0]['mid'] as num).toDouble();
        return _cache[code] = mid;
      }
    }
    throw Exception('Brak kursu NBP dla $code (HTTP $lastStatus)');
  }

  /// Kwota w walucie [from] przeliczona na [to] (przez PLN, kursy średnie NBP).
  static Future<({double amount, double rate})> convert(double amount, String from, String to) async {
    final rf = await rateToPln(from);
    final rt = await rateToPln(to);
    return (amount: amount * rf / rt, rate: rf / rt);
  }
}
