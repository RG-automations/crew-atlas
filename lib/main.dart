import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:provider/provider.dart';

import 'screens/login_screen.dart';
import 'screens/trips_screen.dart';
import 'services/alarm.dart';
import 'widgets/sos_overlay.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(); // konfiguracja z android/app/google-services.json
  FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
  await initializeDateFormatting('pl');
  await initNotifications();
  runApp(ChangeNotifierProvider(
    create: (_) => AlarmService(),
    child: const CrewAtlasApp(),
  ));
}

class CrewAtlasApp extends StatelessWidget {
  const CrewAtlasApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CrewAtlas',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF00897B),
        useMaterial3: true,
      ),
      builder: (context, child) => SosOverlay(child: child ?? const SizedBox()),
      home: const AuthGate(),
    );
  }
}

class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  bool _started = false;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        if (snap.data == null) {
          _started = false;
          return const LoginScreen();
        }
        if (!_started) {
          _started = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            context.read<AlarmService>().start();
          });
        }
        return const TripsScreen();
      },
    );
  }
}
