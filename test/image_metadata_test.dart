import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crew_atlas/services/image_metadata.dart';
import 'package:flutter_test/flutter_test.dart';

// Fixtures are synthetic: fake camera, fake serial, fake person, coordinates in the open sea.
Uint8List fx(String name) => File('test/fixtures/$name').readAsBytesSync();

int indexOfSeq(Uint8List b, List<int> s, [int from = 0]) {
  for (var i = from; i + s.length <= b.length; i++) {
    var ok = true;
    for (var j = 0; j < s.length; j++) {
      if (b[i + j] != s[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

bool contains(Uint8List b, String s) => indexOfSeq(b, s.codeUnits) >= 0;

/// Dane obrazu głównego: od jego SOS (po przejściu segmentów według długości, więc miniatura w EXIF nie myli)
/// do pierwszego EOI. Bez zmian oznacza brak ponownego kodowania.
Uint8List imageData(Uint8List b) {
  var i = 2;
  while (!(b[i] == 0xFF && b[i + 1] == 0xDA)) {
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  final eoi = indexOfSeq(b, const [0xFF, 0xD9], i);
  return b.sublist(i, eoi + 2);
}

int app1Count(Uint8List b) {
  var n = 0;
  var i = 2;
  while (i + 4 <= b.length && b[i] == 0xFF && b[i + 1] != 0xDA) {
    if (b[i + 1] == 0xE1) n++;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return n;
}

const secrets = [
  'FakeCam', 'TestPhone', 'SN-TEST', 'Fake_Person', 'fake_comment', 'fake_user_comment', 'ns.adobe.com', 'fake description',
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final outDir = Platform.environment['STRIP_OUT_DIR'];
  void export(String name, Uint8List b) {
    if (outDir != null) File('$outDir/$name').writeAsBytesSync(b);
  }

  for (final name in ['exif_gps_rot6.jpg', 'progressive_rot3.jpg']) {
    test('$name: GPS, aparat, numer seryjny, autor, komentarze i XMP znikają, orientacja zostaje', () {
      final src = fx(name);
      for (final s in ['FakeCam', 'TestPhone', 'SN-TEST', 'Fake_Person', 'ns.adobe.com']) {
        expect(contains(src, s), isTrue, reason: 'fixture powinien zawierać "$s"');
      }
      final out = stripImageMetadata(src);
      export('stripped_$name', out);
      for (final s in secrets) {
        expect(contains(out, s), isFalse, reason: '"$s" nie może zostać w pliku');
      }
      expect(out.sublist(0, 2), [0xFF, 0xD8]);
      expect(out.sublist(out.length - 2), [0xFF, 0xD9]);
      expect(app1Count(out), 1, reason: 'jeden minimalny segment z samą orientacją');
      expect(readJpegOrientation(out), readJpegOrientation(src));
      expect(readJpegOrientation(out), name.contains('rot6') ? 6 : 3);
      expect(imageData(out), imageData(src), reason: 'piksele bez ponownego kodowania');
      expect(out.length, lessThan(src.length));
    });
  }

  test('dane dopisane za końcem JPEG (dodatkowe obrazy) są odrzucane', () {
    final src = fx('exif_gps_rot6.jpg');
    expect(indexOfSeq(src, const [0xFF, 0xD8], src.length - 700), greaterThan(0), reason: 'fixture ma dopisany obraz na końcu');
    final out = stripImageMetadata(src);
    expect(indexOfSeq(out, const [0xFF, 0xD8], 2), -1, reason: 'drugi obraz nie może zostać');
  });

  test('JPEG bez EXIF: nie powstaje żaden segment APP1', () {
    final out = stripImageMetadata(fx('no_exif.jpg'));
    expect(app1Count(out), 0);
    expect(readJpegOrientation(out), isNull);
    expect(imageData(out), imageData(fx('no_exif.jpg')));
  });

  test('PNG: teksty, eXIf i tIME znikają, obraz zostaje', () {
    final src = fx('meta.png');
    expect(contains(src, 'Fake_Person'), isTrue);
    final out = stripImageMetadata(src);
    export('stripped_meta.png', out);
    for (final chunk in ['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']) {
      expect(contains(out, chunk), isFalse, reason: chunk);
    }
    for (final s in secrets) {
      expect(contains(out, s), isFalse);
    }
    for (final chunk in ['IHDR', 'IDAT', 'IEND']) {
      expect(contains(out, chunk), isTrue, reason: chunk);
    }
    expect(out.sublist(0, 8), src.sublist(0, 8));
  });

  test('nieobsługiwany lub uszkodzony plik jest odrzucany, nie wysyłamy go', () {
    expect(() => stripImageMetadata(fx('unsupported.webp')), throwsFormatException);
    expect(() => stripImageMetadata(Uint8List.fromList([1, 2, 3, 4, 5, 6, 7, 8, 9])), throwsFormatException);
    expect(() => stripImageMetadata(Uint8List(0)), throwsFormatException);
    final jpg = fx('exif_gps_rot6.jpg');
    expect(() => stripImageMetadata(jpg.sublist(0, 40)), throwsFormatException);
    expect(() => stripImageMetadata(jpg.sublist(0, jpg.length ~/ 3)), throwsFormatException);
    final png = fx('meta.png');
    expect(() => stripImageMetadata(png.sublist(0, 30)), throwsFormatException);
  });

  testWidgets('oczyszczone obrazy dekodują się do tych samych pikseli', (tester) async {
    await tester.runAsync(() async {
      Future<(int, int, Uint8List)> decode(Uint8List b) async {
        final codec = await ui.instantiateImageCodec(b);
        final img = (await codec.getNextFrame()).image;
        final data = (await img.toByteData())!;
        return (img.width, img.height, data.buffer.asUint8List());
      }

      for (final name in ['exif_gps_rot6.jpg', 'progressive_rot3.jpg', 'no_exif.jpg', 'meta.png']) {
        final src = fx(name);
        final a = await decode(src);
        final b = await decode(stripImageMetadata(src));
        expect((b.$1, b.$2), (a.$1, a.$2), reason: name);
        expect(b.$3, a.$3, reason: '$name: piksele muszą być identyczne');
      }
    });
  });
}
