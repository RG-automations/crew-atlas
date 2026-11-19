import 'package:crew_atlas/models/models.dart';
import 'package:crew_atlas/services/media.dart';
import 'package:flutter_test/flutter_test.dart';

Memory mem({
  MemoryType type = MemoryType.photo,
  String url = '',
  String publicId = '',
  String resourceType = '',
  String format = '',
}) =>
    Memory(
      id: 'm1',
      placeId: 'p1',
      type: type,
      url: url,
      description: '',
      createdBy: 'u1',
      createdAt: null,
      publicId: publicId,
      resourceType: resourceType,
      format: format,
    );

void main() {
  test('stary wpis z publicznym adresem: dawny adres i dawna miniatura', () async {
    final m = mem(url: 'https://res.cloudinary.com/c/image/upload/v1/wycieczka/T1/abc.jpg');
    expect((await Media.ref('T1', m))!.url, m.url);
    expect((await Media.ref('T1', m))!.headers, isEmpty);
    expect((await Media.ref('T1', m, thumb: true))!.url, contains('/upload/w_160,h_160,c_fill,g_auto/'));
    expect(m.isPrivate, isFalse);
  });

  test('prywatny wpis wskazujący folder innej podróży nie jest pobierany (bez tokenu i bez żądania)', () async {
    final m = mem(publicId: 'wycieczka/OTHER/abcdefgh12', resourceType: 'image', format: 'jpg');
    expect(m.isPrivate, isTrue);
    expect(await Media.ref('T1', m), isNull);
    expect(await Media.ref('T1', mem(publicId: 'wycieczka/T1/abcdefgh12', resourceType: 'image')), isNull,
        reason: 'brak formatu');
  });

  test('miniatura nagrania głosowego nie istnieje', () async {
    final m = mem(type: MemoryType.audio, publicId: 'wycieczka/T1/abcdefgh12', resourceType: 'video', format: 'm4a');
    expect(await Media.ref('T1', m, thumb: true), isNull);
  });
}
