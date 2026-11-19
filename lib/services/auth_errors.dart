import 'package:firebase_auth/firebase_auth.dart';

/// Czytelny komunikat dla błędu logowania. `admin-restricted-operation` to odpowiedź Firebase, gdy właściciel
/// wyłączył samodzielne zakładanie kont (Authentication, Settings, User actions): wtedy konta tworzy właściciel.
String authErrorText(Object e) {
  if (e is FirebaseAuthException) {
    switch (e.code) {
      case 'admin-restricted-operation':
        return 'Zakładanie nowych kont jest wyłączone. Poproś właściciela grupy o utworzenie konta '
            'albo zaloguj się kontem, które już istnieje.';
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
      case 'invalid-email':
        return 'Nieprawidłowy e-mail lub hasło.';
      case 'network-request-failed':
        return 'Brak połączenia z internetem.';
      case 'too-many-requests':
        return 'Zbyt wiele prób. Spróbuj za chwilę.';
      case 'user-disabled':
        return 'To konto jest wyłączone.';
    }
  }
  final t = '$e';
  // Konto Google bez istniejącego konta w Firebase przy wyłączonej rejestracji bywa zgłaszane tekstem.
  if (t.contains('ERROR_ADMIN_RESTRICTED_OPERATION') || t.contains('admin-restricted-operation')) {
    return authErrorText(FirebaseAuthException(code: 'admin-restricted-operation'));
  }
  return t;
}
