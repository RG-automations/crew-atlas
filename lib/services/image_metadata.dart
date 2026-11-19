import 'dart:typed_data';

/// Usuwa z obrazu metadane, które ujawniają osobę lub miejsce (GPS, model i numer seryjny aparatu, daty,
/// komentarze, XMP, IPTC, miniatury, dodatkowe obrazy dopisane za końcem pliku), **bez ponownego kodowania
/// pikseli**: jakość jest identyczna. Zostaje orientacja (potrzebna do poprawnego obrotu) i profil kolorów ICC.
///
/// Wtyczka wybierania zdjęć na Androidzie kopiuje do zmniejszonego zdjęcia ok. 100 znaczników EXIF razem z GPS,
/// więc bez tego kroku wysłany plik zdradza, gdzie zrobiono zdjęcie.
///
/// Obsługuje JPEG i PNG. Inny format to [FormatException]: nie wysyłamy pliku, którego nie umiemy oczyścić.
Uint8List stripImageMetadata(Uint8List input) {
  try {
    if (input.length > 3 && input[0] == 0xFF && input[1] == 0xD8) return _stripJpeg(input);
    if (input.length > 8 && input[0] == 0x89 && input[1] == 0x50 && input[2] == 0x4E && input[3] == 0x47) {
      return _stripPng(input);
    }
  } on RangeError {
    throw const FormatException('Uszkodzony plik obrazu'); // ucięty plik: nie wysyłamy go
  }
  throw const FormatException('Nieobsługiwany format zdjęcia (obsługiwane: JPEG, PNG)');
}

/// Orientacja EXIF (1-8) z pierwszego segmentu Exif w JPEG albo null.
int? readJpegOrientation(Uint8List b) {
  var i = 2;
  while (i + 4 <= b.length && b[i] == 0xFF) {
    final m = b[i + 1];
    if (m == 0xFF) {
      i++;
      continue;
    }
    if (m == 0xD9 || m == 0xDA) return null;
    final len = (b[i + 2] << 8) | b[i + 3];
    if (m == 0xE1 && len >= 8 && _isExif(b, i + 4)) {
      return _tiffOrientation(b, i + 10, i + 2 + len);
    }
    i += 2 + len;
  }
  return null;
}

bool _isExif(Uint8List b, int p) =>
    p + 6 <= b.length &&
    b[p] == 0x45 && b[p + 1] == 0x78 && b[p + 2] == 0x69 && b[p + 3] == 0x66 && b[p + 4] == 0 && b[p + 5] == 0;

int? _tiffOrientation(Uint8List b, int tiff, int segEnd) {
  final end = segEnd < b.length ? segEnd : b.length;
  if (tiff + 8 > end) return null;
  final little = b[tiff] == 0x49 && b[tiff + 1] == 0x49;
  if (!little && !(b[tiff] == 0x4D && b[tiff + 1] == 0x4D)) return null;
  int u16(int p) => little ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1];
  int u32(int p) => little
      ? b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)
      : (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  if (u16(tiff + 2) != 42) return null;
  final ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  final count = u16(ifd);
  for (var n = 0; n < count; n++) {
    final e = ifd + 2 + n * 12;
    if (e + 12 > end) return null;
    if (u16(e) == 0x0112 && u16(e + 2) == 3 && u32(e + 4) == 1) {
      final v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/// Minimalny segment APP1 z samą orientacją (big endian).
Uint8List _orientationApp1(int orientation) => Uint8List.fromList([
      0xFF, 0xE1, 0x00, 0x22, //
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // TIFF header, IFD0 at 8
      0x00, 0x01, // jeden wpis
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT
      0x00, 0x00, 0x00, 0x00, // brak kolejnego IFD
    ]);

bool _startsWith(Uint8List b, int p, List<int> ascii) {
  if (p + ascii.length > b.length) return false;
  for (var i = 0; i < ascii.length; i++) {
    if (b[p + i] != ascii[i]) return false;
  }
  return true;
}

Uint8List _stripJpeg(Uint8List b) {
  final out = BytesBuilder(copy: false);
  out.add(const [0xFF, 0xD8]);
  final orientation = readJpegOrientation(b);
  // Orientacja 1 (normalnie) i brak orientacji nie wymagają żadnego segmentu Exif.
  Uint8List? pending = orientation != null && orientation != 1 ? _orientationApp1(orientation) : null;
  void flushExif() {
    final p = pending;
    if (p != null) out.add(p);
    pending = null;
  }

  var i = 2;
  var sawImage = false;
  while (i < b.length) {
    if (b[i] != 0xFF) throw const FormatException('Uszkodzony plik JPEG');
    final m = b[i + 1];
    if (m == 0xFF) {
      i++;
      continue;
    }
    if (m == 0xD9) {
      // Koniec obrazu: wszystko za nim (dodatkowe obrazy, MPF, mapy HDR) odrzucamy.
      if (!sawImage) throw const FormatException('Pusty plik JPEG');
      out.add(const [0xFF, 0xD9]);
      return out.toBytes();
    }
    if (m == 0x01 || (m >= 0xD0 && m <= 0xD8)) {
      out.add(b.sublist(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) throw const FormatException('Uszkodzony plik JPEG');
    final len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) throw const FormatException('Uszkodzony plik JPEG');
    final bodyStart = i + 4;

    // Zostaje to, co potrzebne do dekodowania, plus profil ICC. Odpadają: APP1 (Exif, XMP), APP13 (IPTC),
    // komentarze, MPF, rozszerzenie JFXX (miniatura) i producenckie APPn.
    final keep = switch (m) {
      0xE0 => _startsWith(b, bodyStart, const [0x4A, 0x46, 0x49, 0x46, 0x00]), // JFIF
      0xE2 => _startsWith(b, bodyStart, const [0x49, 0x43, 0x43, 0x5F, 0x50, 0x52, 0x4F, 0x46, 0x49, 0x4C, 0x45]), // ICC_PROFILE
      0xEE => _startsWith(b, bodyStart, const [0x41, 0x64, 0x6F, 0x62, 0x65]), // Adobe
      >= 0xE1 && <= 0xEF => false,
      0xFE => false,
      _ => true, // DQT, DHT, SOFn, DRI, SOS itd.
    };
    if (keep) {
      if (m != 0xE0) flushExif();
      out.add(b.sublist(i, i + 2 + len));
      if (m == 0xE0) flushExif(); // orientacja zaraz po JFIF
    }
    i += 2 + len;

    if (m == 0xDA) {
      // Dane skompresowane (do następnego znacznika) kopiujemy bez zmian: piksele się nie zmieniają.
      sawImage = true;
      final start = i;
      while (i + 1 < b.length) {
        if (b[i] == 0xFF) {
          final n = b[i + 1];
          if (n == 0x00 || (n >= 0xD0 && n <= 0xD7)) {
            i += 2;
            continue;
          }
          if (n == 0xFF) {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      out.add(b.sublist(start, i));
    }
  }
  throw const FormatException('Plik JPEG bez znacznika końca');
}

// Segmenty PNG potrzebne do wyświetlenia obrazu. Teksty (tEXt, zTXt, iTXt), eXIf i tIME odpadają.
const _pngKeep = {
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT',
};

Uint8List _stripPng(Uint8List b) {
  final out = BytesBuilder(copy: false);
  out.add(b.sublist(0, 8));
  var i = 8;
  var sawEnd = false;
  while (i + 12 <= b.length) {
    final len = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
    final end = i + 12 + len;
    if (len < 0 || end > b.length) throw const FormatException('Uszkodzony plik PNG');
    final type = String.fromCharCodes(b.sublist(i + 4, i + 8));
    if (_pngKeep.contains(type)) out.add(b.sublist(i, end));
    i = end;
    if (type == 'IEND') {
      sawEnd = true;
      break; // dane za IEND odrzucamy
    }
  }
  if (!sawEnd) throw const FormatException('Plik PNG bez IEND');
  return out.toBytes();
}
