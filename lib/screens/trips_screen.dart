import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../config.dart';
import '../models/models.dart';
import '../services/location_sharing.dart';
import '../services/repo.dart';
import 'trip_screen.dart';

class TripsScreen extends StatelessWidget {
  const TripsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final df = DateFormat('d MMM yyyy', 'pl');
    return Scaffold(
      appBar: AppBar(
        title: const Text('Moje podróże'),
        actions: [
          IconButton(
            tooltip: 'Dołącz kodem',
            icon: const Icon(Icons.group_add),
            onPressed: () => _join(context),
          ),
          IconButton(
            tooltip: 'Wyloguj',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await LocationSharing.i.stopAll();
              await Repo.i.signOut();
            },
          ),
        ],
      ),
      body: StreamBuilder<List<Trip>>(
        stream: Repo.i.myTrips(),
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Text('Błąd: ${snap.error}'));
          final trips = snap.data;
          if (trips == null) return const Center(child: CircularProgressIndicator());
          if (trips.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(32),
                child: Text('Nie masz jeszcze podróży.\nUtwórz nową albo dołącz kodem od znajomych.',
                    textAlign: TextAlign.center),
              ),
            );
          }
          return ListView.builder(
            itemCount: trips.length,
            itemBuilder: (_, i) {
              final t = trips[i];
              final dates = t.start == null
                  ? 'Termin do ustalenia'
                  : '${df.format(t.start!)}${t.end == null ? '' : ' – ${df.format(t.end!)}'}';
              return Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: ListTile(
                  leading: const Icon(Icons.flight_takeoff),
                  title: Text(t.name),
                  subtitle: Text('${t.destination}\n$dates · ${t.memberIds.length} os.'),
                  isThreeLine: true,
                  onTap: () => Navigator.push(
                      context, MaterialPageRoute(builder: (_) => TripScreen(tripId: t.id))),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _create(context),
        icon: const Icon(Icons.add),
        label: const Text('Nowa podróż'),
      ),
    );
  }

  Future<void> _join(BuildContext context) async {
    final c = TextEditingController();
    final code = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Kod zaproszenia'),
        content: TextField(
          controller: c,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(hintText: 'np. K7M2QX'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Anuluj')),
          FilledButton(onPressed: () => Navigator.pop(context, c.text), child: const Text('Dołącz')),
        ],
      ),
    );
    if (code == null || code.trim().isEmpty) return;
    final ok = await Repo.i.joinTrip(code);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(ok ? 'Dołączono do podróży' : 'Nie znaleziono takiego kodu')));
    }
  }

  Future<void> _create(BuildContext context) async {
    final name = TextEditingController();
    final dest = TextEditingController();
    DateTimeRange? range;
    var currency = 'PLN';
    final df = DateFormat('d.MM.yyyy');
    await showDialog<void>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: const Text('Nowa podróż'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Nazwa')),
              TextField(
                  controller: dest,
                  decoration: const InputDecoration(labelText: 'Dokąd (miejsce spotkania)')),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                icon: const Icon(Icons.date_range),
                label: Text(range == null
                    ? 'Wybierz daty wyjazdu'
                    : '${df.format(range!.start)} – ${df.format(range!.end)}'),
                onPressed: () async {
                  final r = await showDateRangePicker(
                    context: ctx,
                    firstDate: DateTime.now().subtract(const Duration(days: 30)),
                    lastDate: DateTime.now().add(const Duration(days: 365 * 3)),
                  );
                  if (r != null) setS(() => range = r);
                },
              ),
              DropdownButtonFormField<String>(
                initialValue: currency,
                decoration: const InputDecoration(labelText: 'Waluta rozliczeń'),
                items: [for (final c in supportedCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                onChanged: (v) => setS(() => currency = v ?? 'PLN'),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Anuluj')),
            FilledButton(
              onPressed: () async {
                if (name.text.trim().isEmpty) return;
                await Repo.i.createTrip(
                  name: name.text.trim(),
                  destination: dest.text.trim(),
                  start: range?.start,
                  end: range?.end,
                  baseCurrency: currency,
                );
                if (ctx.mounted) Navigator.pop(ctx);
              },
              child: const Text('Utwórz'),
            ),
          ],
        ),
      ),
    );
  }
}
