import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

import 'repo.dart';

/// Udostępnianie lokalizacji na żywo. Jedna usługa na całą aplikację, więc udostępnianie
/// trwa po wyjściu z ekranu podróży, a na Androidzie działa też w tle dzięki usłudze
/// pierwszoplanowej (widoczne powiadomienie).
class LocationSharing extends ChangeNotifier {
  LocationSharing._();
  static final LocationSharing i = LocationSharing._();

  final Set<String> _trips = {};
  StreamSubscription<Position>? _sub;

  bool isSharing(String tripId) => _trips.contains(tripId);

  /// Zwraca komunikat błędu albo null, gdy się udało.
  Future<String?> start(String tripId) async {
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      return 'Brak zgody na lokalizację - włącz ją w ustawieniach telefonu';
    }
    if (!await Geolocator.isLocationServiceEnabled()) {
      return 'Lokalizacja jest wyłączona w telefonie';
    }
    _trips.add(tripId);
    try {
      final pos = await Geolocator.getCurrentPosition();
      await Repo.i.publishLocation(tripId, pos.latitude, pos.longitude);
    } catch (e) {
      _trips.remove(tripId);
      return 'Nie udało się ustalić pozycji: $e';
    }
    _ensureStream();
    notifyListeners();
    return null;
  }

  Future<void> stop(String tripId) async {
    _trips.remove(tripId);
    await Repo.i.stopSharing(tripId);
    if (_trips.isEmpty) {
      await _sub?.cancel();
      _sub = null;
    }
    notifyListeners();
  }

  /// Zatrzymuje wszystko (np. przy wylogowaniu).
  Future<void> stopAll() async {
    for (final t in _trips.toList()) {
      await stop(t);
    }
  }

  void _ensureStream() {
    if (_sub != null) return;
    _sub = Geolocator.getPositionStream(
      locationSettings: AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 50,
        intervalDuration: const Duration(seconds: 30),
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'CrewAtlas',
          notificationText: 'Udostępniasz swoją lokalizację ekipie',
          notificationChannelName: 'Udostępnianie lokalizacji',
          setOngoing: true,
        ),
      ),
    ).listen((p) {
      for (final t in _trips) {
        Repo.i.publishLocation(t, p.latitude, p.longitude);
      }
    });
  }
}
