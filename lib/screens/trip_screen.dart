import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../models/models.dart';
import '../services/repo.dart';
import 'expenses_tab.dart';
import 'map_tab.dart';
import 'people_tab.dart';
import 'plan_tab.dart';

Future<Position?> currentPosition(BuildContext context) async {
  var perm = await Geolocator.checkPermission();
  if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
  if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Brak zgody na lokalizację - włącz ją w ustawieniach')));
    }
    return null;
  }
  return Geolocator.getCurrentPosition();
}

class TripScreen extends StatefulWidget {
  final String tripId;
  const TripScreen({super.key, required this.tripId});

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  int _tab = 0;

  Future<void> _sos(Trip trip) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        icon: const Icon(Icons.sos, color: Colors.red, size: 40),
        title: const Text('Wysłać alarm SOS?'),
        content: const Text(
            'Wszyscy uczestnicy tej podróży dostaną głośny alarm i Twoją aktualną lokalizację.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Anuluj')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('WYŚLIJ SOS'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final pos = await currentPosition(context);
    await Repo.i.sendSos(trip.id, pos?.latitude ?? 0, pos?.longitude ?? 0);
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Alarm SOS wysłany do grupy')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<Trip>(
      stream: Repo.i.trip(widget.tripId),
      builder: (context, snap) {
        final trip = snap.data;
        if (trip == null) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        final tabs = [
          MapTab(trip: trip),
          PlanTab(trip: trip),
          ExpensesTab(trip: trip),
          PeopleTab(trip: trip),
        ];
        return Scaffold(
          appBar: AppBar(
            title: Text(trip.name),
            actions: [
              IconButton(
                tooltip: 'SOS',
                icon: const Icon(Icons.sos, color: Colors.red),
                onPressed: () => _sos(trip),
              ),
            ],
          ),
          body: IndexedStack(index: _tab, children: tabs),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            destinations: const [
              NavigationDestination(icon: Icon(Icons.map_outlined), label: 'Mapa'),
              NavigationDestination(icon: Icon(Icons.flight_outlined), label: 'Plan'),
              NavigationDestination(icon: Icon(Icons.payments_outlined), label: 'Wydatki'),
              NavigationDestination(icon: Icon(Icons.groups_outlined), label: 'Ekipa'),
            ],
          ),
        );
      },
    );
  }
}
