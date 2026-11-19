import 'package:cloud_firestore/cloud_firestore.dart';

DateTime? _dt(dynamic v) => v is Timestamp ? v.toDate() : null;
Timestamp? _ts(DateTime? d) => d == null ? null : Timestamp.fromDate(d);

class Trip {
  final String id;
  final String name;
  final String destination;
  final DateTime? start;
  final DateTime? end;
  final List<String> memberIds;
  final Map<String, String> memberNames;
  final String inviteCode;
  final String baseCurrency;
  final String createdBy;

  const Trip({
    required this.id,
    required this.name,
    required this.destination,
    required this.start,
    required this.end,
    required this.memberIds,
    required this.memberNames,
    required this.inviteCode,
    required this.baseCurrency,
    this.createdBy = '',
  });

  factory Trip.fromDoc(DocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data() ?? {};
    return Trip(
      id: d.id,
      name: m['name'] ?? '',
      destination: m['destination'] ?? '',
      start: _dt(m['start']),
      end: _dt(m['end']),
      memberIds: List<String>.from(m['memberIds'] ?? const []),
      memberNames: Map<String, String>.from(m['memberNames'] ?? const {}),
      inviteCode: m['inviteCode'] ?? '',
      baseCurrency: m['baseCurrency'] ?? 'PLN',
      createdBy: m['createdBy'] ?? '',
    );
  }

  String nameOf(String uid) => memberNames[uid] ?? 'Nieznany';
}

class Place {
  final String id;
  final String title;
  final String note;
  final double lat;
  final double lng;
  final String createdBy;

  const Place({
    required this.id,
    required this.title,
    required this.note,
    required this.lat,
    required this.lng,
    required this.createdBy,
  });

  factory Place.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return Place(
      id: d.id,
      title: m['title'] ?? '',
      note: m['note'] ?? '',
      lat: (m['lat'] as num?)?.toDouble() ?? 0,
      lng: (m['lng'] as num?)?.toDouble() ?? 0,
      createdBy: m['createdBy'] ?? '',
    );
  }
}

enum MemoryType { photo, video, audio }

class Memory {
  final String id;
  final String placeId;
  final MemoryType type;
  /// Tylko stare wpisy (publiczny adres sprzed migracji do prywatnych plików). Nowe mają [publicId].
  final String url;
  final String publicId;
  final String resourceType; // image | video (dźwięk też jest typu video w Cloudinary)
  final String format;
  final String description;
  final String createdBy;
  final DateTime? createdAt;

  const Memory({
    required this.id,
    required this.placeId,
    required this.type,
    required this.url,
    required this.description,
    required this.createdBy,
    required this.createdAt,
    this.publicId = '',
    this.resourceType = '',
    this.format = '',
  });

  /// Prywatny plik czytany przez worker (nie ma adresu URL w dokumencie).
  bool get isPrivate => publicId.isNotEmpty;

  factory Memory.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return Memory(
      id: d.id,
      placeId: m['placeId'] ?? '',
      type: MemoryType.values.firstWhere(
        (t) => t.name == m['type'],
        orElse: () => MemoryType.photo,
      ),
      url: m['url'] ?? '',
      publicId: m['publicId'] ?? '',
      resourceType: m['resourceType'] ?? '',
      format: m['format'] ?? '',
      description: m['description'] ?? '',
      createdBy: m['createdBy'] ?? '',
      createdAt: _dt(m['createdAt']),
    );
  }
}

/// Przelot jednego uczestnika - każdy może lecieć z innego miejsca.
class TravelLeg {
  final String id;
  final String userId;
  final String from;
  final String to;
  final DateTime departure;
  final DateTime arrival;
  final String details;

  const TravelLeg({
    required this.id,
    required this.userId,
    required this.from,
    required this.to,
    required this.departure,
    required this.arrival,
    required this.details,
  });

  factory TravelLeg.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return TravelLeg(
      id: d.id,
      userId: m['userId'] ?? '',
      from: m['from'] ?? '',
      to: m['to'] ?? '',
      departure: _dt(m['departure']) ?? DateTime.now(),
      arrival: _dt(m['arrival']) ?? DateTime.now(),
      details: m['details'] ?? '',
    );
  }

  static Map<String, dynamic> toMap({
    required String userId,
    required String from,
    required String to,
    required DateTime departure,
    required DateTime arrival,
    required String details,
  }) =>
      {
        'userId': userId,
        'from': from,
        'to': to,
        'departure': _ts(departure),
        'arrival': _ts(arrival),
        'details': details,
      };
}

class Stay {
  final String id;
  final String url;
  final String title;
  final String address;
  final String imageUrl;
  final DateTime? checkIn;
  final DateTime? checkOut;
  final String checkInTime;
  final String checkOutTime;
  final String createdBy;

  const Stay({
    required this.id,
    required this.url,
    required this.title,
    required this.address,
    required this.imageUrl,
    required this.checkIn,
    required this.checkOut,
    required this.checkInTime,
    required this.checkOutTime,
    this.createdBy = '',
  });

  factory Stay.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return Stay(
      id: d.id,
      url: m['url'] ?? '',
      title: m['title'] ?? '',
      address: m['address'] ?? '',
      imageUrl: m['imageUrl'] ?? '',
      checkIn: _dt(m['checkIn']),
      checkOut: _dt(m['checkOut']),
      checkInTime: m['checkInTime'] ?? '',
      checkOutTime: m['checkOutTime'] ?? '',
      createdBy: m['createdBy'] ?? '',
    );
  }

  static Map<String, dynamic> toMap({
    required String url,
    required String title,
    required String address,
    required String imageUrl,
    required DateTime? checkIn,
    required DateTime? checkOut,
    required String checkInTime,
    required String checkOutTime,
    required String createdBy,
  }) =>
      {
        'url': url,
        'title': title,
        'address': address,
        'imageUrl': imageUrl,
        'checkIn': _ts(checkIn),
        'checkOut': _ts(checkOut),
        'checkInTime': checkInTime,
        'checkOutTime': checkOutTime,
        'createdBy': createdBy,
      };
}

class Expense {
  final String id;
  final String description;
  final double amount;
  final String currency;

  /// Ile PLN kosztuje 1 jednostka waluty wydatku (kurs NBP z dnia dodania).
  final double rateToPln;
  final String paidBy;
  final List<String> participants;
  final DateTime? createdAt;
  final String createdBy;

  const Expense({
    required this.id,
    required this.description,
    required this.amount,
    required this.currency,
    required this.rateToPln,
    required this.paidBy,
    required this.participants,
    required this.createdAt,
    this.createdBy = '',
  });

  factory Expense.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return Expense(
      id: d.id,
      description: m['description'] ?? '',
      amount: (m['amount'] as num?)?.toDouble() ?? 0,
      currency: m['currency'] ?? 'PLN',
      rateToPln: (m['rateToPln'] as num?)?.toDouble() ?? 1,
      paidBy: m['paidBy'] ?? '',
      participants: List<String>.from(m['participants'] ?? const []),
      createdAt: _dt(m['createdAt']),
      createdBy: m['createdBy'] ?? '',
    );
  }
}

class SosAlert {
  final String id;
  final String uid;
  final String name;
  final double lat;
  final double lng;
  final bool active;
  final DateTime? createdAt;

  const SosAlert({
    required this.id,
    required this.uid,
    required this.name,
    required this.lat,
    required this.lng,
    required this.active,
    required this.createdAt,
  });

  factory SosAlert.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return SosAlert(
      id: d.id,
      uid: m['uid'] ?? '',
      name: m['name'] ?? '',
      lat: (m['lat'] as num?)?.toDouble() ?? 0,
      lng: (m['lng'] as num?)?.toDouble() ?? 0,
      active: m['active'] ?? false,
      createdAt: _dt(m['createdAt']),
    );
  }
}

class SharedLocation {
  final String uid;
  final String name;
  final double lat;
  final double lng;
  final DateTime? updatedAt;

  const SharedLocation({
    required this.uid,
    required this.name,
    required this.lat,
    required this.lng,
    required this.updatedAt,
  });

  factory SharedLocation.fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> d) {
    final m = d.data();
    return SharedLocation(
      uid: d.id,
      name: m['name'] ?? '',
      lat: (m['lat'] as num?)?.toDouble() ?? 0,
      lng: (m['lng'] as num?)?.toDouble() ?? 0,
      updatedAt: _dt(m['updatedAt']),
    );
  }
}
