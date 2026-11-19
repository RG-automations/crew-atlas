import 'dart:convert';

/// Wynik analizy linku rezerwacji (Booking.com, Cozycozy, Airbnb...).
/// Pola mogą być puste - użytkownik poprawia je ręcznie w formularzu.
class ParsedStay {
  final String title;
  final String address;
  final String imageUrl;
  final DateTime? checkIn;
  final DateTime? checkOut;
  final String checkInTime;
  final String checkOutTime;

  const ParsedStay({
    this.title = '',
    this.address = '',
    this.imageUrl = '',
    this.checkIn,
    this.checkOut,
    this.checkInTime = '',
    this.checkOutTime = '',
  });
}

DateTime? _parseDate(String? s) {
  if (s == null || s.isEmpty) return null;
  return DateTime.tryParse(s.length > 10 ? s.substring(0, 10) : s);
}

String _ymd(String ym, String day) {
  final p = ym.split('-');
  if (p.length != 2) return '';
  return '${p[0]}-${p[1].padLeft(2, '0')}-${day.padLeft(2, '0')}';
}

/// Daty z parametrów zapytania, np. Booking: ?checkin=2026-08-01&checkout=2026-08-05
/// albo checkin_year_month + checkin_monthday; inne serwisy: check_in, dateFrom...
({DateTime? from, DateTime? to}) datesFromUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return (from: null, to: null);
  final q = {
    for (final e in uri.queryParameters.entries) e.key.toLowerCase(): e.value
  };
  String? pick(List<String> keys) {
    for (final k in keys) {
      if (q[k] != null && q[k]!.isNotEmpty) return q[k];
    }
    return null;
  }

  var from =
      _parseDate(pick(['checkin', 'check_in', 'datefrom', 'arrival', 'from']));
  var to =
      _parseDate(pick(['checkout', 'check_out', 'dateto', 'departure', 'to']));
  if (from == null &&
      q['checkin_year_month'] != null &&
      q['checkin_monthday'] != null) {
    from = _parseDate(_ymd(q['checkin_year_month']!, q['checkin_monthday']!));
  }
  if (to == null &&
      q['checkout_year_month'] != null &&
      q['checkout_monthday'] != null) {
    to = _parseDate(_ymd(q['checkout_year_month']!, q['checkout_monthday']!));
  }
  return (from: from, to: to);
}

String? _meta(String html, String property) {
  final r1 = RegExp(
      '<meta[^>]+(?:property|name)=["\']$property["\'][^>]*content=["\']([^"\']*)["\']',
      caseSensitive: false);
  final r2 = RegExp(
      '<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']$property["\']',
      caseSensitive: false);
  return (r1.firstMatch(html) ?? r2.firstMatch(html))?.group(1);
}

String _unescape(String s) => s
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .trim();

/// Szuka godzin zameldowania/wymeldowania w tekście strony (PL/EN).
({String checkIn, String checkOut}) timesFromText(String text) {
  final t = text
      .replaceAll(RegExp(r'<[^>]+>'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ');
  String find(List<String> labels) {
    for (final l in labels) {
      final m = RegExp('$l[^0-9]{0,40}?(\\d{1,2})[:.](\\d{2})',
              caseSensitive: false)
          .firstMatch(t);
      if (m != null) {
        final h = int.parse(m[1]!);
        if (h < 24) return '${h.toString().padLeft(2, '0')}:${m[2]}';
      }
    }
    return '';
  }

  return (
    checkIn: find(['zameldowanie', 'check-in', 'check in', 'checkin']),
    checkOut: find(['wymeldowanie', 'check-out', 'check out', 'checkout']),
  );
}

String _hhmm(String s) {
  final m = RegExp(r'(\d{1,2}):(\d{2})').firstMatch(s);
  return m == null ? '' : '${m[1]!.padLeft(2, '0')}:${m[2]}';
}

/// Czysta funkcja: URL + HTML strony -> najważniejsze dane noclegu.
ParsedStay parseStay(String url, String html) {
  var title = '';
  var address = '';
  var image = '';
  var inTime = '';
  var outTime = '';

  void visit(dynamic n) {
    if (n is List) {
      n.forEach(visit);
    } else if (n is Map) {
      if (title.isEmpty && n['name'] is String) title = n['name'];
      final a = n['address'];
      if (address.isEmpty && a is Map) {
        address = [
          a['streetAddress'],
          a['postalCode'],
          a['addressLocality'],
          a['addressCountry']
        ]
            .whereType<String>()
            .where((s) => s.isNotEmpty)
            .join(', ');
      } else if (address.isEmpty && a is String) {
        address = a;
      }
      final img = n['image'];
      if (image.isEmpty) {
        if (img is String) image = img;
        if (img is List && img.isNotEmpty && img.first is String) {
          image = img.first;
        }
      }
      if (inTime.isEmpty && n['checkinTime'] is String) {
        inTime = _hhmm(n['checkinTime']);
      }
      if (outTime.isEmpty && n['checkoutTime'] is String) {
        outTime = _hhmm(n['checkoutTime']);
      }
      n.values.forEach(visit);
    }
  }

  final ld = RegExp(
          r'<script[^>]+type=["' "'" r']application/ld\+json["' "'" r'][^>]*>(.*?)</script>',
          caseSensitive: false,
          dotAll: true)
      .allMatches(html);
  for (final m in ld) {
    try {
      visit(jsonDecode(m.group(1)!));
    } catch (_) {}
  }

  if (title.isEmpty) title = _meta(html, 'og:title') ?? '';
  if (title.isEmpty) {
    title = RegExp(r'<title[^>]*>(.*?)</title>',
                caseSensitive: false, dotAll: true)
            .firstMatch(html)
            ?.group(1) ??
        '';
  }
  if (image.isEmpty) image = _meta(html, 'og:image') ?? '';
  if (address.isEmpty) address = _meta(html, 'og:street-address') ?? '';

  final times = timesFromText(html);
  if (inTime.isEmpty) inTime = times.checkIn;
  if (outTime.isEmpty) outTime = times.checkOut;

  final d = datesFromUrl(url);
  return ParsedStay(
    title: _unescape(title),
    address: _unescape(address),
    imageUrl: image,
    checkIn: d.from,
    checkOut: d.to,
    checkInTime: inTime,
    checkOutTime: outTime,
  );
}
