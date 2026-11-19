import 'package:http/http.dart' as http;

import '../config.dart';
import '../models/models.dart';
import '../widgets/map_icons.dart';
import 'backend.dart';

/// Gdzie i z czym pobrać plik wspomnienia.
class MediaRef {
  final String url;
  final Map<String, String> headers;

  /// Do kiedy token w [headers] jest ważny (null: stary publiczny wpis bez tokenu).
  final DateTime? validUntil;
  const MediaRef(this.url, [this.headers = const {}, this.validUntil]);
}

/// Dostęp do prywatnych plików przez worker. Aplikacja nie dostaje adresów Cloudinary: wysyła krótki token
/// w nagłówku Authorization, a worker streamuje plik. Token jest ważny kilka minut i dotyczy jednej podróży.
class Media {
  // Wstrzykiwane w testach.
  static Future<({String token, DateTime expires})> Function(String tripId) fetcher = Backend.mediaToken;
  static DateTime Function() now = DateTime.now;
  static Future<http.Response> Function(Uri url, Map<String, String> headers) httpGet =
      (url, headers) => http.get(url, headers: headers);

  static final _tokens = <String, ({String token, DateTime expires, DateTime refreshAt})>{};

  /// Token odświeżamy z zapasem równym 1/4 jego życia (od 10 do 60 s), żeby nie wygasł w trakcie żądania.
  /// Stały zapas 60 s dawałby przy krótkim `MEDIA_TOKEN_TTL` (60 s) nowy token przy każdym pliku.
  static Duration refreshMargin(Duration ttl) => Duration(seconds: (ttl.inSeconds ~/ 4).clamp(10, 60));

  static Future<({String token, DateTime expires})> _token(String tripId) async {
    final c = _tokens[tripId];
    if (c != null && now().isBefore(c.refreshAt)) return (token: c.token, expires: c.expires);
    final t = await fetcher(tripId);
    final margin = refreshMargin(t.expires.difference(now()));
    _tokens[tripId] = (token: t.token, expires: t.expires, refreshAt: t.expires.subtract(margin));
    return t;
  }

  /// Po wylogowaniu lub wyjściu z podróży albo po odpowiedzi 401 (token odwołany lub wygasł).
  static void forget([String? tripId]) => tripId == null ? _tokens.clear() : _tokens.remove(tripId);

  /// Adres i nagłówki pliku (albo miniatury). Stare, publiczne wpisy zwracają ich dawny adres.
  /// null: brak takiego pliku (np. miniatura dźwięku) albo wpis wskazuje folder innej podróży.
  static Future<MediaRef?> ref(String tripId, Memory m, {bool thumb = false}) async {
    if (!m.isPrivate) {
      final u = thumb ? thumbnailUrl(m) : m.url;
      return u == null || u.isEmpty ? null : MediaRef(u);
    }
    if (thumb && m.type == MemoryType.audio) return null;
    final id = m.publicId.split('/').last;
    if (!m.publicId.startsWith('wycieczka/$tripId/') || m.format.isEmpty) return null;
    final t = await _token(tripId);
    return MediaRef(
      '$workerUrl/media/${m.resourceType}/$tripId/$id.${m.format}${thumb ? '?thumb=1' : ''}',
      {'authorization': 'Bearer ${t.token}'},
      t.expires,
    );
  }

  /// Cały plik do pamięci (miniatury, krótkie nagrania głosowe). Przy 401 pobiera nowy token i próbuje raz jeszcze.
  static Future<List<int>> fetch(String tripId, Memory m, {bool thumb = false}) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      final r = await ref(tripId, m, thumb: thumb);
      if (r == null) throw Exception('Brak pliku');
      final res = await httpGet(Uri.parse(r.url), r.headers).timeout(const Duration(seconds: 60));
      if (res.statusCode == 200) return res.bodyBytes;
      if (res.statusCode == 401 && m.isPrivate && attempt == 0) {
        forget(tripId);
        continue;
      }
      throw Exception('Nie udało się pobrać pliku (HTTP ${res.statusCode})');
    }
    throw Exception('Nie udało się pobrać pliku');
  }
}
