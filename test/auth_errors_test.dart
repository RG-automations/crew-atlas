import 'package:crew_atlas/services/auth_errors.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('wyłączona rejestracja daje zrozumiały komunikat (także jako tekst z Androida)', () {
    final m = authErrorText(FirebaseAuthException(code: 'admin-restricted-operation'));
    expect(m, contains('Zakładanie nowych kont jest wyłączone'));
    expect(authErrorText(Exception('PlatformException(ERROR_ADMIN_RESTRICTED_OPERATION, x)')), m);
  });

  test('typowe błędy logowania', () {
    expect(authErrorText(FirebaseAuthException(code: 'wrong-password')), contains('Nieprawidłowy e-mail'));
    expect(authErrorText(FirebaseAuthException(code: 'network-request-failed')), contains('Brak połączenia'));
    expect(authErrorText(Exception('inne')), 'Exception: inne');
  });
}
