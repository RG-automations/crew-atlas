import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/models.dart';
import '../services/booking_parser.dart';
import '../services/repo.dart';

/// Otwiera link rezerwacji w zewnętrznej aplikacji (np. Booking), a gdy jej nie ma - w przeglądarce.
Future<void> openBookingLink(BuildContext context, String raw) async {
  var text = raw.trim();
  if (!text.contains('://')) text = 'https://$text';
  final uri = Uri.tryParse(text);
  var ok = false;
  if (uri != null) {
    try {
      ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Nie udało się otworzyć linku')));
  }
}

final _dt = DateFormat('EEE d MMM, HH:mm', 'pl');
final _d = DateFormat('EEE d MMM yyyy', 'pl');

class PlanTab extends StatelessWidget {
  final Trip trip;
  const PlanTab({super.key, required this.trip});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Column(children: [
        const TabBar(tabs: [Tab(text: 'Przeloty'), Tab(text: 'Nocleg')]),
        Expanded(
          child: TabBarView(children: [
            _LegsView(trip: trip),
            _StaysView(trip: trip),
          ]),
        ),
      ]),
    );
  }
}

// ---------------- Przeloty ----------------

class _LegsView extends StatelessWidget {
  final Trip trip;
  const _LegsView({required this.trip});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: StreamBuilder<List<TravelLeg>>(
        stream: Repo.i.legs(trip.id),
        builder: (context, snap) {
          final legs = snap.data ?? [];
          if (legs.isEmpty) {
            return const Center(
                child: Padding(
              padding: EdgeInsets.all(24),
              child: Text('Każdy dodaje swój przelot - skąd, dokąd i o której.\nMożecie wylatywać z różnych miejsc.',
                  textAlign: TextAlign.center),
            ));
          }
          // Grupowanie po uczestniku.
          final byUser = <String, List<TravelLeg>>{};
          for (final l in legs) {
            byUser.putIfAbsent(l.userId, () => []).add(l);
          }
          return ListView(padding: const EdgeInsets.only(bottom: 88), children: [
            for (final e in byUser.entries) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                child: Text(trip.nameOf(e.key), style: Theme.of(context).textTheme.titleMedium),
              ),
              for (final l in e.value)
                Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: ListTile(
                    leading: const Icon(Icons.flight),
                    title: Text('${l.from} → ${l.to}'),
                    subtitle: Text('Wylot: ${_dt.format(l.departure)}\nPrzylot: ${_dt.format(l.arrival)}'
                        '${l.details.isEmpty ? '' : '\n${l.details}'}'),
                    isThreeLine: true,
                    trailing: l.userId == Repo.i.uid || trip.createdBy == Repo.i.uid
                        ? IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => Repo.i.deleteLeg(trip.id, l.id))
                        : null,
                  ),
                ),
            ],
          ]);
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'leg',
        onPressed: () => _add(context),
        icon: const Icon(Icons.add),
        label: const Text('Mój przelot'),
      ),
    );
  }

  Future<DateTime?> _pickDateTime(BuildContext context, DateTime? initial) async {
    final date = await showDatePicker(
      context: context,
      initialDate: initial ?? trip.start ?? DateTime.now(),
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now().add(const Duration(days: 365 * 3)),
    );
    if (date == null || !context.mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial ?? DateTime(2000, 1, 1, 8)),
    );
    if (time == null) return null;
    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }

  Future<void> _add(BuildContext context) async {
    final from = TextEditingController();
    final to = TextEditingController(text: trip.destination);
    final details = TextEditingController();
    DateTime? dep, arr;
    await showDialog<void>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: const Text('Mój przelot'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: from, decoration: const InputDecoration(labelText: 'Skąd (miasto / lotnisko)')),
              TextField(controller: to, decoration: const InputDecoration(labelText: 'Dokąd')),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.flight_takeoff),
                label: Text(dep == null ? 'Data i godzina wylotu' : _dt.format(dep!)),
                onPressed: () async {
                  final v = await _pickDateTime(ctx, dep);
                  if (v != null) setS(() => dep = v);
                },
              ),
              OutlinedButton.icon(
                icon: const Icon(Icons.flight_land),
                label: Text(arr == null ? 'Data i godzina przylotu' : _dt.format(arr!)),
                onPressed: () async {
                  final v = await _pickDateTime(ctx, arr ?? dep);
                  if (v != null) setS(() => arr = v);
                },
              ),
              TextField(controller: details, decoration: const InputDecoration(labelText: 'Nr lotu / uwagi')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Anuluj')),
            FilledButton(
              onPressed: () async {
                if (from.text.trim().isEmpty || to.text.trim().isEmpty || dep == null || arr == null) {
                  ScaffoldMessenger.of(ctx).showSnackBar(
                      const SnackBar(content: Text('Uzupełnij skąd, dokąd i obie daty')));
                  return;
                }
                await Repo.i.addLeg(
                  trip.id,
                  TravelLeg.toMap(
                    userId: Repo.i.uid,
                    from: from.text.trim(),
                    to: to.text.trim(),
                    departure: dep!,
                    arrival: arr!,
                    details: details.text.trim(),
                  ),
                );
                if (ctx.mounted) Navigator.pop(ctx);
              },
              child: const Text('Zapisz'),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------- Noclegi ----------------

class _StaysView extends StatelessWidget {
  final Trip trip;
  const _StaysView({required this.trip});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: StreamBuilder<List<Stay>>(
        stream: Repo.i.stays(trip.id),
        builder: (context, snap) {
          final stays = snap.data ?? [];
          if (stays.isEmpty) {
            return const Center(
                child: Padding(
              padding: EdgeInsets.all(24),
              child: Text('Wklej link do rezerwacji (Booking, Cozycozy...) - pobierzemy najważniejsze dane.',
                  textAlign: TextAlign.center),
            ));
          }
          return ListView(padding: const EdgeInsets.only(bottom: 88), children: [
            for (final s in stays)
              Card(
                margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                clipBehavior: Clip.antiAlias,
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (s.imageUrl.isNotEmpty)
                    Image.network(s.imageUrl, height: 140, width: double.infinity, fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => const SizedBox()),
                  ListTile(
                    title: Text(s.title.isEmpty ? 'Nocleg' : s.title),
                    subtitle: Text([
                      if (s.address.isNotEmpty) s.address,
                      'Zameldowanie: ${s.checkIn == null ? '?' : _d.format(s.checkIn!)}'
                          '${s.checkInTime.isEmpty ? '' : ', od ${s.checkInTime}'}',
                      'Wymeldowanie: ${s.checkOut == null ? '?' : _d.format(s.checkOut!)}'
                          '${s.checkOutTime.isEmpty ? '' : ', do ${s.checkOutTime}'}',
                    ].join('\n')),
                    isThreeLine: true,
                    onTap: s.url.isEmpty ? null : () => openBookingLink(context, s.url),
                    trailing: s.createdBy == Repo.i.uid || trip.createdBy == Repo.i.uid
                        ? IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => Repo.i.deleteStay(trip.id, s.id))
                        : null,
                  ),
                  if (s.url.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                      child: Row(children: [
                        FilledButton.tonalIcon(
                          onPressed: () => openBookingLink(context, s.url),
                          icon: const Icon(Icons.open_in_new, size: 18),
                          label: const Text('Otwórz rezerwację'),
                        ),
                        IconButton(
                          tooltip: 'Kopiuj link',
                          icon: const Icon(Icons.copy, size: 18),
                          onPressed: () {
                            Clipboard.setData(ClipboardData(text: s.url));
                            ScaffoldMessenger.of(context)
                                .showSnackBar(const SnackBar(content: Text('Skopiowano link')));
                          },
                        ),
                      ]),
                    ),
                ]),
              ),
          ]);
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'stay',
        onPressed: () => _add(context),
        icon: const Icon(Icons.add_link),
        label: const Text('Dodaj nocleg'),
      ),
    );
  }

  Future<void> _add(BuildContext context) async {
    final url = TextEditingController();
    final title = TextEditingController();
    final address = TextEditingController();
    final inTime = TextEditingController();
    final outTime = TextEditingController();
    var image = '';
    DateTime? from, to;
    var loading = false;
    await showDialog<void>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setS) => AlertDialog(
          title: const Text('Nowy nocleg'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(
                controller: url,
                keyboardType: TextInputType.url,
                decoration: InputDecoration(
                  labelText: 'Link do rezerwacji',
                  suffixIcon: loading
                      ? const Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator(strokeWidth: 2))
                      : IconButton(
                          icon: const Icon(Icons.auto_fix_high),
                          tooltip: 'Pobierz dane z linku',
                          onPressed: () async {
                            setS(() => loading = true);
                            final ParsedStay p = await Repo.i.fetchStay(url.text.trim());
                            setS(() {
                              loading = false;
                              if (p.title.isNotEmpty) title.text = p.title;
                              if (p.address.isNotEmpty) address.text = p.address;
                              if (p.checkInTime.isNotEmpty) inTime.text = p.checkInTime;
                              if (p.checkOutTime.isNotEmpty) outTime.text = p.checkOutTime;
                              image = p.imageUrl;
                              from = p.checkIn ?? from;
                              to = p.checkOut ?? to;
                            });
                          },
                        ),
                ),
              ),
              const Text('Strony rezerwacji nie zawsze podają wszystko - uzupełnij brakujące pola.',
                  style: TextStyle(fontSize: 12)),
              TextField(controller: title, decoration: const InputDecoration(labelText: 'Nazwa')),
              TextField(controller: address, decoration: const InputDecoration(labelText: 'Adres')),
              Row(children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      final v = await showDatePicker(
                          context: ctx,
                          initialDate: from ?? trip.start ?? DateTime.now(),
                          firstDate: DateTime(2020),
                          lastDate: DateTime(2100));
                      if (v != null) setS(() => from = v);
                    },
                    child: Text(from == null ? 'Od (data)' : DateFormat('d.MM.yyyy').format(from!)),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () async {
                      final v = await showDatePicker(
                          context: ctx,
                          initialDate: to ?? from ?? DateTime.now(),
                          firstDate: DateTime(2020),
                          lastDate: DateTime(2100));
                      if (v != null) setS(() => to = v);
                    },
                    child: Text(to == null ? 'Do (data)' : DateFormat('d.MM.yyyy').format(to!)),
                  ),
                ),
              ]),
              Row(children: [
                Expanded(
                    child: TextField(
                        controller: inTime,
                        decoration: const InputDecoration(labelText: 'Zamel. od', hintText: '15:00'))),
                const SizedBox(width: 8),
                Expanded(
                    child: TextField(
                        controller: outTime,
                        decoration: const InputDecoration(labelText: 'Wymel. do', hintText: '11:00'))),
              ]),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Anuluj')),
            FilledButton(
              onPressed: () async {
                if (title.text.trim().isEmpty && url.text.trim().isEmpty) return;
                await Repo.i.addStay(
                  trip.id,
                  Stay.toMap(
                    url: url.text.trim(),
                    title: title.text.trim(),
                    address: address.text.trim(),
                    imageUrl: image,
                    checkIn: from,
                    checkOut: to,
                    checkInTime: inTime.text.trim(),
                    checkOutTime: outTime.text.trim(),
                    createdBy: Repo.i.uid,
                  ),
                );
                if (ctx.mounted) Navigator.pop(ctx);
              },
              child: const Text('Zapisz'),
            ),
          ],
        ),
      ),
    );
  }
}
