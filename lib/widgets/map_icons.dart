import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../models/models.dart';

const _teal = Color(0xFF00897B);

/// Adres miniatury z Cloudinary (kwadrat 160 px). Dla wideo - klatka z początku filmu.
String? thumbnailUrl(Memory m) {
  const marker = '/upload/';
  final i = m.url.indexOf(marker);
  if (i < 0 || m.type == MemoryType.audio) return null;
  final head = m.url.substring(0, i + marker.length);
  var tail = m.url.substring(i + marker.length);
  if (m.type == MemoryType.video) {
    tail = tail.replaceFirst(RegExp(r'\.[A-Za-z0-9]+$'), '.jpg');
    return '${head}so_0,w_160,h_160,c_fill/$tail';
  }
  return '${head}w_160,h_160,c_fill,g_auto/$tail';
}

Future<Uint8List> _toPng(ui.PictureRecorder rec, int size) async {
  final img = await rec.endRecording().toImage(size, size);
  final data = await img.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

/// Okrągła miniatura zdjęcia z białą i zieloną obwódką - znacznik miejsca na mapie.
Future<Uint8List> circleThumbnail(Uint8List bytes, {bool video = false}) async {
  const size = 112.0;
  final codec = await ui.instantiateImageCodec(bytes, targetWidth: 104, targetHeight: 104);
  final img = (await codec.getNextFrame()).image;
  final rec = ui.PictureRecorder();
  final c = Canvas(rec);
  const center = Offset(size / 2, size / 2);
  c.drawCircle(center, size / 2, Paint()..color = Colors.white);
  c.save();
  c.clipPath(Path()..addOval(Rect.fromCircle(center: center, radius: size / 2 - 4)));
  c.drawImageRect(
    img,
    Rect.fromLTWH(0, 0, img.width.toDouble(), img.height.toDouble()),
    const Rect.fromLTWH(4, 4, size - 8, size - 8),
    Paint()..filterQuality = FilterQuality.medium,
  );
  c.restore();
  c.drawCircle(
    center,
    size / 2 - 2,
    Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..color = _teal,
  );
  if (video) _playTriangle(c, center, 18, Colors.white.withValues(alpha: 0.9));
  return _toPng(rec, size.toInt());
}

void _playTriangle(Canvas c, Offset center, double r, Color color) {
  final path = Path()
    ..moveTo(center.dx - r * 0.45, center.dy - r)
    ..lineTo(center.dx + r * 0.95, center.dy)
    ..lineTo(center.dx - r * 0.45, center.dy + r)
    ..close();
  c.drawPath(path, Paint()..color = color);
}

/// Przycisk play/pauza dla głosówki.
Future<Uint8List> playButton({required bool playing}) async {
  const size = 96.0;
  final rec = ui.PictureRecorder();
  final c = Canvas(rec);
  const center = Offset(size / 2, size / 2);
  c.drawCircle(center, size / 2, Paint()..color = Colors.white);
  c.drawCircle(center, size / 2 - 5, Paint()..color = playing ? const Color(0xFFE53935) : _teal);
  final white = Paint()..color = Colors.white;
  if (playing) {
    c.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(31, 28, 12, 40), const Radius.circular(3)), white);
    c.drawRRect(RRect.fromRectAndRadius(const Rect.fromLTWH(53, 28, 12, 40), const Radius.circular(3)), white);
  } else {
    _playTriangle(c, const Offset(size / 2 + 2, size / 2), 22, Colors.white);
  }
  return _toPng(rec, size.toInt());
}
