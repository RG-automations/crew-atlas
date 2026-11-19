import 'package:crew_atlas/models/models.dart';
import 'package:crew_atlas/services/media.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

Memory priv([String tripId = 'T1']) => Memory(
      id: 'm1',
      placeId: 'p1',
      type: MemoryType.photo,
      url: '',
      description: '',
      createdBy: 'u1',
      createdAt: null,
      publicId: 'wycieczka/$tripId/abcdefgh12',
      resourceType: 'image',
      format: 'jpg',
    );

void main() {
  late DateTime clock;
  late int fetches;
  late int ttlSeconds;

  setUp(() {
    clock = DateTime(2030, 1, 1, 12);
    fetches = 0;
    ttlSeconds = 120;
    Media.forget();
    Media.now = () => clock;
    Media.fetcher = (trip) async {
      fetches++;
      return (token: 'tok-$trip-$fetches', expires: clock.add(Duration(seconds: ttlSeconds)));
    };
  });

  Future<MediaRef> ref([Memory? m]) async => (await Media.ref('T1', m ?? priv()))!;
  void at(int seconds) => clock = DateTime(2030, 1, 1, 12).add(Duration(seconds: seconds));

  test('TTL 120 s: odświeżenie 30 s przed wygaśnięciem (po 90 s), nie przy każdym pliku', () async {
    await ref();
    at(89);
    await ref();
    await ref();
    expect(fetches, 1);
    at(91);
    await ref();
    expect(fetches, 2);
  });

  test('TTL 600 s: zapas 60 s, odświeżenie po 540 s', () async {
    ttlSeconds = 600;
    await ref();
    at(539);
    await ref();
    expect(fetches, 1);
    at(541);
    await ref();
    expect(fetches, 2);
  });

  test('TTL 60 s (minimum): zapas 15 s, a nie stałe 60 s, które odświeżałoby token przy każdym pliku', () async {
    ttlSeconds = 60;
    await ref();
    at(10);
    await ref();
    expect(fetches, 1);
    at(46);
    await ref();
    expect(fetches, 2);
    expect(Media.refreshMargin(const Duration(seconds: 60)), const Duration(seconds: 15));
    expect(Media.refreshMargin(const Duration(seconds: 120)), const Duration(seconds: 30));
    expect(Media.refreshMargin(const Duration(seconds: 3600)), const Duration(seconds: 60));
    expect(Media.refreshMargin(const Duration(seconds: 20)), const Duration(seconds: 10));
  });

  test('token jest tylko w nagłówku, wygasa razem z tokenem serwera, a podróże mają osobne tokeny', () async {
    final r = await ref();
    expect(r.headers['authorization'], 'Bearer tok-T1-1');
    expect(r.url, isNot(contains('tok-')));
    expect(r.validUntil, clock.add(const Duration(seconds: 120)));
    await Media.ref('T2', priv('T2'));
    expect(fetches, 2, reason: 'drugi token dla innej podróży');
    await ref();
    expect(fetches, 2);
    Media.forget('T1');
    await ref();
    expect(fetches, 3);
    Media.forget();
    await ref();
    await Media.ref('T2', priv('T2'));
    expect(fetches, 5);
  });

  test('fetch: przy 401 pobiera nowy token i ponawia dokładnie raz', () async {
    final seen = <String>[];
    Media.httpGet = (url, headers) async {
      seen.add(headers['authorization']!);
      return seen.length == 1 ? http.Response('', 401) : http.Response('bytes', 200);
    };
    final data = await Media.fetch('T1', priv());
    expect(String.fromCharCodes(data), 'bytes');
    expect(seen, ['Bearer tok-T1-1', 'Bearer tok-T1-2'], reason: 'drugie żądanie z nowym tokenem');
    expect(fetches, 2);
  });

  test('fetch: stałe 401 kończy się błędem po dwóch próbach, 404 nie jest ponawiane', () async {
    var calls = 0;
    Media.httpGet = (url, headers) async {
      calls++;
      return http.Response('', 401);
    };
    await expectLater(Media.fetch('T1', priv()), throwsException);
    expect(calls, 2);
    calls = 0;
    Media.httpGet = (url, headers) async {
      calls++;
      return http.Response('', 404);
    };
    await expectLater(Media.fetch('T1', priv()), throwsException);
    expect(calls, 1);
  });

  test('stary publiczny wpis: bez tokenu i bez ponawiania 401', () async {
    var calls = 0;
    Media.httpGet = (url, headers) async {
      calls++;
      expect(headers, isEmpty);
      return http.Response('', 401);
    };
    final legacy = Memory(
        id: 'm', placeId: 'p', type: MemoryType.photo, url: 'https://example.invalid/a.jpg',
        description: '', createdBy: 'u', createdAt: null);
    await expectLater(Media.fetch('T1', legacy), throwsException);
    expect(calls, 1);
    expect(fetches, 0);
  });
}
