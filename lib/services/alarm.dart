import 'dart:async';
import 'dart:math';

import 'package:audioplayers/audioplayers.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../config.dart';
import '../models/models.dart';
import 'repo.dart';

final _notifications = FlutterLocalNotificationsPlugin();

Future<void> initNotifications() async {
  await _notifications.initialize(
    settings: const InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    ),
  );
  final android = _notifications
      .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await android?.createNotificationChannel(const AndroidNotificationChannel(
    sosChannelId,
    'Alarm SOS',
    description: 'Alarmy SOS od osób z Twojej podróży',
    importance: Importance.max,
    audioAttributesUsage: AudioAttributesUsage.alarm,
    enableVibration: true,
  ));
  await android?.requestNotificationsPermission();
}

Future<void> showSosNotification(String title, String body) => _notifications.show(
      id: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      title: title,
      body: body,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          sosChannelId,
          'Alarm SOS',
          importance: Importance.max,
          priority: Priority.max,
          category: AndroidNotificationCategory.alarm,
          fullScreenIntent: true,
          audioAttributesUsage: AudioAttributesUsage.alarm,
          // 4 = FLAG_INSISTENT: dźwięk powtarza się do zamknięcia powiadomienia.
          additionalFlags: Int32List.fromList([4]),
          ongoing: false,
        ),
      ),
    );

/// Obsługa wiadomości FCM (data-message) gdy aplikacja jest w tle/zamknięta.
/// Wiadomość musi zawierać pola `title` i `body` w sekcji data (bez `notification`).
@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {
  if (message.data['type'] != 'sos') return;
  await initNotifications();
  await showSosNotification(
    message.data['title'] ?? 'SOS!',
    message.data['body'] ?? 'Ktoś potrzebuje pomocy',
  );
}

/// Syrena generowana w pamięci (WAV 16-bit mono) - nie potrzeba pliku z dźwiękiem.
Uint8List _sirenWav() {
  const rate = 22050;
  const seconds = 2;
  final n = rate * seconds;
  final data = ByteData(44 + n * 2);
  void str(int off, String s) {
    for (var i = 0; i < s.length; i++) {
      data.setUint8(off + i, s.codeUnitAt(i));
    }
  }

  str(0, 'RIFF');
  data.setUint32(4, 36 + n * 2, Endian.little);
  str(8, 'WAVEfmt ');
  data.setUint32(16, 16, Endian.little);
  data.setUint16(20, 1, Endian.little);
  data.setUint16(22, 1, Endian.little);
  data.setUint32(24, rate, Endian.little);
  data.setUint32(28, rate * 2, Endian.little);
  data.setUint16(32, 2, Endian.little);
  data.setUint16(34, 16, Endian.little);
  str(36, 'data');
  data.setUint32(40, n * 2, Endian.little);
  var phase = 0.0;
  for (var i = 0; i < n; i++) {
    final t = i / rate;
    final freq = 700 + 500 * (0.5 + 0.5 * sin(2 * pi * t)); // 700-1200 Hz, 1 cykl/s
    phase += 2 * pi * freq / rate;
    data.setInt16(44 + i * 2, (sin(phase) * 30000).round(), Endian.little);
  }
  return data.buffer.asUint8List();
}

/// Nasłuchuje alarmów SOS ze wszystkich wyjazdów użytkownika i gra syrenę
/// (strumień alarmowy - głośno nawet przy wyciszonych dzwonkach).
class AlarmService extends ChangeNotifier {
  final _player = AudioPlayer();
  final Map<String, StreamSubscription> _subs = {};
  final Set<String> _handled = {};

  /// Aktywny, nieodrzucony alarm od innej osoby (null gdy brak).
  SosAlert? current;
  String currentTripName = '';
  StreamSubscription? _tripsSub;

  void start() {
    _tripsSub?.cancel();
    _tripsSub = Repo.i.myTrips().listen((trips) {
      final ids = trips.map((t) => t.id).toSet();
      for (final gone in _subs.keys.where((k) => !ids.contains(k)).toList()) {
        _subs.remove(gone)?.cancel();
      }
      for (final t in trips) {
        _subs.putIfAbsent(t.id, () => Repo.i.activeSos(t.id).listen((alerts) {
              for (final a in alerts) {
                if (a.uid == Repo.i.uid || _handled.contains(a.id)) continue;
                // Ignoruj stare alarmy sprzed uruchomienia aplikacji (>10 min).
                final age = DateTime.now().difference(a.createdAt ?? DateTime.now());
                if (age > const Duration(minutes: 10) && a.createdAt != null) continue;
                _trigger(a, t.name);
              }
              if (current != null && !alerts.any((x) => x.id == current!.id)) dismiss();
            }));
      }
    });
  }

  Future<void> _trigger(SosAlert a, String tripName) async {
    _handled.add(a.id);
    current = a;
    currentTripName = tripName;
    notifyListeners();
    await _player.setAudioContext(AudioContext(
      android: const AudioContextAndroid(
        usageType: AndroidUsageType.alarm,
        contentType: AndroidContentType.sonification,
        audioFocus: AndroidAudioFocus.gain,
      ),
    ));
    await _player.setReleaseMode(ReleaseMode.loop);
    await _player.setVolume(1);
    await _player.play(BytesSource(_sirenWav(), mimeType: 'audio/wav'));
  }

  Future<void> dismiss() async {
    await _player.stop();
    current = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _tripsSub?.cancel();
    for (final s in _subs.values) {
      s.cancel();
    }
    _player.dispose();
    super.dispose();
  }
}
