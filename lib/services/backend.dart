import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

import '../config.dart';

/// Rozmowa z workerem Cloudflare (podpisy wysyłania plików). Worker weryfikuje token logowania
/// Firebase i dopiero wtedy używa sekretów Cloudinary.
class Backend {
  static String _reason(String body) {
    try {
      return (jsonDecode(body) as Map)['reason']?.toString() ?? '';
    } catch (_) {
      return '';
    }
  }

  static Future<Map<String, String>> _auth() async {
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    if (token == null) throw Exception('Nie jesteś zalogowany');
    return {'authorization': 'Bearer $token'};
  }

  /// Parametry podpisanego wysyłania do Cloudinary (v2: jeden podpis = jeden plik, ograniczone formaty).
  /// Worker podpisuje tylko dla członków podróży.
  static Future<Map<String, dynamic>> signUpload(String folder, {String? kind}) async {
    if (workerUrl.isEmpty) throw Exception('Brak adresu workera (WORKER_URL)');
    final res = await http
        .post(Uri.parse('$workerUrl/sign'),
            headers: {...await _auth(), 'content-type': 'application/json'},
            body: jsonEncode({'folder': folder, 'v': 2, 'kind': ?kind}))
        .timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('Worker: błąd ${res.statusCode} ${_reason(res.body)}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Krótki token dostępu do mediów podróży (worker sprawdza członkostwo). Zwraca token i czas wygaśnięcia.
  static Future<({String token, DateTime expires})> mediaToken(String tripId) async {
    if (workerUrl.isEmpty) throw Exception('Brak adresu workera (WORKER_URL)');
    final res = await http
        .post(Uri.parse('$workerUrl/media/token'),
            headers: {...await _auth(), 'content-type': 'application/json'},
            body: jsonEncode({'tripId': tripId}))
        .timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('Worker: błąd ${res.statusCode} ${_reason(res.body)}');
    final b = jsonDecode(res.body) as Map<String, dynamic>;
    return (
      token: b['token'] as String,
      expires: DateTime.fromMillisecondsSinceEpoch((b['expiresAt'] as num).toInt() * 1000),
    );
  }

  /// Usuwa plik wspomnienia z Cloudinary (autor wspomnienia albo założyciel podróży). Dokument usuwa osobno klient.
  static Future<void> deleteMedia(String tripId, String memoryId) async {
    if (workerUrl.isEmpty) throw Exception('Brak adresu workera (WORKER_URL)');
    final res = await http
        .delete(Uri.parse('$workerUrl/media/memory/$tripId/$memoryId'), headers: await _auth())
        .timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) throw Exception('Worker: błąd ${res.statusCode} ${_reason(res.body)}');
  }
}
