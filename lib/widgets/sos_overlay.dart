import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/alarm.dart';

/// Pełnoekranowy alarm gdy ktoś z podróży wciśnie SOS.
class SosOverlay extends StatelessWidget {
  final Widget child;
  const SosOverlay({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final alarm = context.watch<AlarmService>();
    final a = alarm.current;
    return Stack(
      children: [
        child,
        if (a != null)
          Positioned.fill(
            child: Material(
              color: Colors.red.shade700,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(Icons.sos, size: 120, color: Colors.white),
                      const SizedBox(height: 16),
                      Text('${a.name} potrzebuje pomocy!',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 8),
                      Text('Podróż: ${alarm.currentTripName}',
                          style: const TextStyle(color: Colors.white70, fontSize: 16)),
                      const SizedBox(height: 8),
                      Text('Lokalizacja: ${a.lat.toStringAsFixed(5)}, ${a.lng.toStringAsFixed(5)}',
                          style: const TextStyle(color: Colors.white, fontSize: 16)),
                      const SizedBox(height: 32),
                      FilledButton.icon(
                        style: FilledButton.styleFrom(
                            backgroundColor: Colors.white, foregroundColor: Colors.red.shade800),
                        onPressed: alarm.dismiss,
                        icon: const Icon(Icons.volume_off),
                        label: const Text('Wycisz alarm'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
