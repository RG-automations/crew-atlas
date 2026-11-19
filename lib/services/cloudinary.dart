import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../models/models.dart';
import 'backend.dart';

/// Plik wysłany do Cloudinary jako prywatny (typ `authenticated`).
class UploadedMedia {
  final String publicId;
  final String resourceType;
  final String format;
  const UploadedMedia(this.publicId, this.resourceType, this.format);
}

/// Wysyłanie plików na Cloudinary z podpisem wystawionym przez worker (API Secret zostaje na serwerze).
/// Zdjęcia -> image, wideo i dźwięk -> video. Worker podpisuje wyłącznie `type=authenticated`, a klient
/// odmawia zapisu, jeśli odpowiedź nie potwierdza prywatnego pliku we właściwym folderze.
class Cloudinary {
  static Future<UploadedMedia> upload(File file, MemoryType type, String folder) async {
    final sig = await Backend.signUpload(folder, kind: type.name); // photo, video lub audio
    final params = (sig['params'] as Map?)?.map((k, v) => MapEntry(k.toString(), v.toString()));
    if (params == null || params['type'] != 'authenticated') {
      // Stary worker podpisuje wysyłanie publiczne. Nie wysyłamy nic, co mogłoby być publiczne.
      throw Exception('Worker jest w starej wersji i nie obsługuje prywatnych plików. Zaktualizuj worker.');
    }
    final resource = type == MemoryType.photo ? 'image' : 'video';
    final req = http.MultipartRequest(
      'POST',
      Uri.parse('https://api.cloudinary.com/v1_1/${sig['cloud']}/$resource/upload'),
    )
      ..fields['api_key'] = sig['apiKey'].toString()
      ..fields['signature'] = sig['signature'].toString()
      ..fields.addAll(params) // dokładnie to, co worker podpisał
      ..files.add(await http.MultipartFile.fromPath('file', file.path));
    final res = await http.Response.fromStream(await req.send().timeout(const Duration(minutes: 3)));
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw Exception(body['error']?['message'] ?? 'Cloudinary: błąd ${res.statusCode}');
    }
    final publicId = body['public_id']?.toString() ?? '';
    final format = body['format']?.toString() ?? '';
    if (body['type'] != 'authenticated' || publicId != params['public_id'] || format.isEmpty) {
      throw Exception('Cloudinary nie potwierdził prywatnego pliku. Nie zapisano wspomnienia.');
    }
    return UploadedMedia(publicId, body['resource_type']?.toString() ?? resource, format);
  }
}
