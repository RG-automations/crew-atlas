import 'dart:async';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../models/models.dart';
import 'booking_parser.dart';
import 'image_metadata.dart';
import 'backend.dart';
import 'cloudinary.dart';
import 'media.dart';
import 'nbp.dart';
import 'shared_stream.dart';

/// Cała komunikacja z Firebase w jednym miejscu.
class Repo {
  Repo._();
  static final Repo i = Repo._();

  final _db = FirebaseFirestore.instance;
  final _auth = FirebaseAuth.instance;

  User get user => _auth.currentUser!;
  String get uid => user.uid;
  String get myName => user.displayName?.trim().isNotEmpty == true
      ? user.displayName!
      : (user.email?.split('@').first ?? 'Podróżnik');

  // Jeden nasłuch Firestore na dane, które czyta kilka miejsc w aplikacji. Zwracany obiekt
  // strumienia jest zawsze ten sam, więc StreamBuilder nie otwiera nasłuchu od nowa przy
  // każdym przebudowaniu ekranu (a każdy nowy nasłuch to dodatkowe odczyty).
  final _shared = <String, SharedStream<dynamic>>{};

  Stream<T> _share<T>(String key, Stream<T> Function() make) =>
      (_shared.putIfAbsent(key, () => SharedStream<T>(make)) as SharedStream<T>).stream;

  // ---------- Auth ----------
  Future<void> signInEmail(String email, String pass, {required bool register, String? name}) async {
    if (register) {
      final c = await _auth.createUserWithEmailAndPassword(email: email, password: pass);
      if (name != null && name.isNotEmpty) await c.user!.updateDisplayName(name);
    } else {
      await _auth.signInWithEmailAndPassword(email: email, password: pass);
    }
    await _saveProfile();
  }

  Future<void> signInGoogle() async {
    await GoogleSignIn.instance.initialize();
    final acc = await GoogleSignIn.instance.authenticate();
    final cred = GoogleAuthProvider.credential(idToken: acc.authentication.idToken);
    await _auth.signInWithCredential(cred);
    await _saveProfile();
  }

  Future<void> signOut() async {
    Media.forget();
    await _auth.signOut();
  }

  Future<void> _saveProfile() async {
    String? token;
    try {
      token = await FirebaseMessaging.instance.getToken();
    } catch (_) {}
    await _db.collection('users').doc(uid).set({
      'name': myName,
      'fcmToken': ?token,
    }, SetOptions(merge: true));
  }

  // ---------- Wyjazdy ----------
  Stream<List<Trip>> myTrips() => _share(
        'myTrips:$uid',
        () => _db
            .collection('trips')
            .where('memberIds', arrayContains: uid)
            .snapshots()
            .map((s) => s.docs.map(Trip.fromDoc).toList()
              ..sort((a, b) => (a.start ?? DateTime(2100)).compareTo(b.start ?? DateTime(2100)))),
      );

  Stream<Trip> trip(String id) =>
      _share('trip:$id', () => _db.collection('trips').doc(id).snapshots().map(Trip.fromDoc));

  static String _code() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    final r = Random.secure();
    return List.generate(6, (_) => chars[r.nextInt(chars.length)]).join();
  }

  /// Tworzy podróż razem z dokumentem zaproszenia `invites/<kod>` (kod -> id podróży).
  /// shortcut: kod losowany bez sprawdzania kolizji (1 na ~1 mld), przy kolizji zapis się nie uda.
  Future<void> createTrip({
    required String name,
    required String destination,
    DateTime? start,
    DateTime? end,
    required String baseCurrency,
  }) async {
    final ref = _db.collection('trips').doc();
    final code = _code();
    final batch = _db.batch();
    batch.set(ref, {
      'name': name,
      'destination': destination,
      'start': start == null ? null : Timestamp.fromDate(start),
      'end': end == null ? null : Timestamp.fromDate(end),
      'baseCurrency': baseCurrency,
      'inviteCode': code,
      'createdBy': uid,
      'memberIds': [uid],
      'memberNames': {uid: myName},
      'createdAt': FieldValue.serverTimestamp(),
    });
    batch.set(_db.collection('invites').doc(code), {'tripId': ref.id, 'createdBy': uid});
    await batch.commit();
  }

  /// Dołącza po kodzie zaproszenia. Zwraca false, gdy kod nie istnieje.
  /// Reguły Firestore wpuszczają tylko dopisanie siebie z poprawnym `joinCode`.
  Future<bool> joinTrip(String code) async {
    final c = code.trim().toUpperCase();
    final invite = await _db.collection('invites').doc(c).get();
    final tripId = invite.data()?['tripId'] as String?;
    if (tripId == null) return false;
    await _db.collection('trips').doc(tripId).update({
      'memberIds': FieldValue.arrayUnion([uid]),
      'memberNames.$uid': myName,
      'joinCode': c,
    });
    return true;
  }

  /// Podróże sprzed wprowadzenia kolekcji `invites` nie mają dokumentu zaproszenia - dopisujemy go.
  Future<void> ensureInvite(Trip t) async {
    if (t.inviteCode.isEmpty) return;
    try {
      final ref = _db.collection('invites').doc(t.inviteCode);
      if (!(await ref.get()).exists) await ref.set({'tripId': t.id, 'createdBy': uid});
    } catch (_) {} // ktoś inny mógł go już utworzyć - nic więcej nie trzeba
  }

  Future<void> leaveTrip(String tripId) {
    Media.forget();
    return _db.collection('trips').doc(tripId).update({
      'memberIds': FieldValue.arrayRemove([uid]),
    });
  }

  CollectionReference<Map<String, dynamic>> _col(String tripId, String name) =>
      _db.collection('trips').doc(tripId).collection(name);

  // ---------- Miejsca na mapie ----------
  Stream<List<Place>> places(String tripId) => _col(tripId, 'places')
      .snapshots()
      .map((s) => s.docs.map(Place.fromDoc).toList());

  Future<void> addPlace(String tripId, String title, String note, double lat, double lng) =>
      _col(tripId, 'places').add({
        'title': title,
        'note': note,
        'lat': lat,
        'lng': lng,
        'createdBy': uid,
        'createdAt': FieldValue.serverTimestamp(),
      });

  Future<void> deletePlace(String tripId, String placeId) =>
      _col(tripId, 'places').doc(placeId).delete();

  // ---------- Zdjęcia, filmy, głosówki ----------
  Stream<List<Memory>> memories(String tripId, String placeId) => _col(tripId, 'memories')
      .where('placeId', isEqualTo: placeId)
      .snapshots()
      .map((s) => s.docs.map(Memory.fromDoc).toList()
        ..sort((a, b) => (a.createdAt ?? DateTime.now()).compareTo(b.createdAt ?? DateTime.now())));

  /// Wszystkie wspomnienia podróży (do miniatur i przycisków play na mapie).
  Stream<List<Memory>> allMemories(String tripId) => _share(
        'memories:$tripId',
        () => _col(tripId, 'memories').snapshots().map((s) => s.docs.map(Memory.fromDoc).toList()
          ..sort((a, b) => (a.createdAt ?? DateTime.now()).compareTo(b.createdAt ?? DateTime.now()))),
      );

  Future<void> addMemory({
    required String tripId,
    required String placeId,
    required MemoryType type,
    required File file,
    required String description,
  }) async {
    // Zdjęcia: przed wysłaniem usuwamy EXIF (GPS, aparat, numery seryjne). Piksele i orientacja zostają.
    final toUpload = type == MemoryType.photo ? await _withoutMetadata(file) : file;
    final UploadedMedia up;
    try {
      up = await Cloudinary.upload(toUpload, type, 'wycieczka/$tripId');
    } finally {
      if (toUpload.path != file.path) {
        try {
          await toUpload.delete();
        } catch (_) {}
      }
    }
    // W dokumencie jest tylko identyfikator prywatnego pliku, nie adres: plik czyta się przez worker.
    await _col(tripId, 'memories').add({
      'placeId': placeId,
      'type': type.name,
      'publicId': up.publicId,
      'resourceType': up.resourceType,
      'format': up.format,
      'description': description,
      'createdBy': uid,
      'createdAt': FieldValue.serverTimestamp(),
    });
  }

  static Future<File> _withoutMetadata(File f) async {
    final Uint8List clean;
    try {
      clean = stripImageMetadata(await f.readAsBytes());
    } on FormatException catch (e) {
      throw Exception(e.message); // nie wysyłamy zdjęcia, którego nie umiemy oczyścić
    }
    final dir = await getTemporaryDirectory();
    final out = File('${dir.path}/upload_${DateTime.now().microsecondsSinceEpoch}.${clean[0] == 0xFF ? 'jpg' : 'png'}');
    await out.writeAsBytes(clean, flush: true);
    return out;
  }

  /// Usuwa plik z Cloudinary przez worker (autor albo założyciel podróży), a potem wpis z bazy.
  /// Stare wpisy z publicznym adresem (sprzed migracji) mają tylko wpis, pliku nie da się usunąć stąd.
  Future<void> deleteMemory(String tripId, Memory m) async {
    if (m.isPrivate) await Backend.deleteMedia(tripId, m.id);
    await _col(tripId, 'memories').doc(m.id).delete();
  }

  // ---------- Przeloty ----------
  Stream<List<TravelLeg>> legs(String tripId) => _share(
        'legs:$tripId',
        () => _col(tripId, 'legs').snapshots().map((s) => s.docs.map(TravelLeg.fromDoc).toList()
          ..sort((a, b) => a.departure.compareTo(b.departure))),
      );

  Future<void> addLeg(String tripId, Map<String, dynamic> data) => _col(tripId, 'legs').add(data);
  Future<void> deleteLeg(String tripId, String id) => _col(tripId, 'legs').doc(id).delete();

  // ---------- Noclegi ----------
  Stream<List<Stay>> stays(String tripId) => _share(
        'stays:$tripId',
        () => _col(tripId, 'stays').snapshots().map((s) => s.docs.map(Stay.fromDoc).toList()
          ..sort((a, b) => (a.checkIn ?? DateTime(2100)).compareTo(b.checkIn ?? DateTime(2100)))),
      );

  Future<void> addStay(String tripId, Map<String, dynamic> data) => _col(tripId, 'stays').add(data);
  Future<void> deleteStay(String tripId, String id) => _col(tripId, 'stays').doc(id).delete();

  /// Pobiera stronę rezerwacji i wyciąga z niej dane. Nie rzuca - przy błędzie
  /// zwraca tylko to, co da się odczytać z samego linku (np. daty).
  Future<ParsedStay> fetchStay(String url) async {
    try {
      final res = await http.get(Uri.parse(url), headers: {
        'User-Agent':
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36',
        'Accept-Language': 'pl,en;q=0.8',
      }).timeout(const Duration(seconds: 12));
      return parseStay(url, res.body);
    } catch (_) {
      return parseStay(url, '');
    }
  }

  // ---------- Wydatki ----------
  Stream<List<Expense>> expenses(String tripId) => _share(
        'expenses:$tripId',
        () => _col(tripId, 'expenses').snapshots().map((s) => s.docs.map(Expense.fromDoc).toList()
          ..sort((a, b) => (b.createdAt ?? DateTime.now()).compareTo(a.createdAt ?? DateTime.now()))),
      );

  Future<void> addExpense({
    required String tripId,
    required String description,
    required double amount,
    required String currency,
    required String paidBy,
    required List<String> participants,
  }) async {
    final rate = await Nbp.rateToPln(currency);
    await _col(tripId, 'expenses').add({
      'description': description,
      'amount': amount,
      'currency': currency,
      'rateToPln': rate,
      'paidBy': paidBy,
      'participants': participants,
      'createdBy': uid,
      'createdAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> deleteExpense(String tripId, String id) => _col(tripId, 'expenses').doc(id).delete();

  // ---------- Lokalizacja i SOS ----------
  Stream<List<SharedLocation>> locations(String tripId) => _share(
        'locations:$tripId',
        () => _col(tripId, 'locations').snapshots().map((s) => s.docs.map(SharedLocation.fromDoc).toList()),
      );

  Future<void> publishLocation(String tripId, double lat, double lng) =>
      _col(tripId, 'locations').doc(uid).set({
        'name': myName,
        'lat': lat,
        'lng': lng,
        'updatedAt': FieldValue.serverTimestamp(),
      });

  Future<void> stopSharing(String tripId) => _col(tripId, 'locations').doc(uid).delete();

  Future<void> sendSos(String tripId, double lat, double lng) => _col(tripId, 'sos').add({
        'uid': uid,
        'name': myName,
        'lat': lat,
        'lng': lng,
        'active': true,
        'createdAt': FieldValue.serverTimestamp(),
      });

  Future<void> resolveSos(String tripId, String id) =>
      _col(tripId, 'sos').doc(id).update({'active': false});

  Stream<List<SosAlert>> activeSos(String tripId) => _share(
        'sos:$tripId',
        () => _col(tripId, 'sos')
            .where('active', isEqualTo: true)
            .snapshots()
            .map((s) => s.docs.map(SosAlert.fromDoc).toList()),
      );
}
