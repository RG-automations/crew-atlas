import 'package:flutter/material.dart';

import '../services/auth_errors.dart';
import '../services/repo.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _pass = TextEditingController();
  bool _register = false;
  bool _busy = false;

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Nie udało się zalogować: ${authErrorText(e)}')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                children: [
                  ClipOval(child: Image.asset('assets/icon.png', width: 112, height: 112)),
                  const SizedBox(height: 8),
                  Text('CrewAtlas', style: Theme.of(context).textTheme.headlineMedium),
                  const Text('Planujcie podróże razem'),
                  const SizedBox(height: 32),
                  if (_register)
                    TextField(
                      controller: _name,
                      decoration: const InputDecoration(labelText: 'Imię / pseudonim'),
                    ),
                  TextField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(labelText: 'E-mail'),
                  ),
                  TextField(
                    controller: _pass,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Hasło (min. 6 znaków)'),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _busy
                          ? null
                          : () => _run(() => Repo.i.signInEmail(_email.text.trim(), _pass.text,
                              register: _register, name: _name.text.trim())),
                      child: Text(_register ? 'Załóż konto' : 'Zaloguj'),
                    ),
                  ),
                  TextButton(
                    onPressed: () => setState(() => _register = !_register),
                    child: Text(_register ? 'Mam już konto' : 'Nie mam konta - zarejestruj'),
                  ),
                  const Divider(height: 32),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : () => _run(Repo.i.signInGoogle),
                      icon: const Icon(Icons.login),
                      label: const Text('Zaloguj przez Google'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
