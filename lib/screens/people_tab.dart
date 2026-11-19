import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/models.dart';
import '../services/location_sharing.dart';
import '../services/repo.dart';

class PeopleTab extends StatefulWidget {
  final Trip trip;
  const PeopleTab({super.key, required this.trip});

  @override
  State<PeopleTab> createState() => _PeopleTabState();
}

class _PeopleTabState extends State<PeopleTab> {
  int _eggTaps = 0;

  @override
  void initState() {
    super.initState();
    Repo.i.ensureInvite(widget.trip);
  }

  Future<void> _toggleShare(bool on) async {
    final id = widget.trip.id;
    if (!on) {
      await LocationSharing.i.stop(id);
      return;
    }
    final err = await LocationSharing.i.start(id);
    if (err != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    }
  }

  static const _eggVideoId = 'KZWKkgDpCHY';

  /// Easter egg: 5 stuknięć w ikonę klucza.
  void _egg() {
    if (++_eggTaps < 5) return;
    _eggTaps = 0;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('Niespodzianka 🎬', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: InkWell(
              onTap: () => launchUrl(
                Uri.parse('https://www.youtube.com/watch?v=$_eggVideoId'),
                mode: LaunchMode.externalApplication,
              ),
              child: Stack(alignment: Alignment.center, children: [
                Image.network(
                  'https://img.youtube.com/vi/$_eggVideoId/hqdefault.jpg',
                  width: double.infinity,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => Container(
                      height: 180, color: Colors.black12, child: const Icon(Icons.movie, size: 48)),
                ),
                const Icon(Icons.play_circle_fill, size: 72, color: Colors.white),
              ]),
            ),
          ),
          const SizedBox(height: 8),
          const Text('Stuknij, żeby obejrzeć'),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final trip = widget.trip;
    final time = DateFormat('HH:mm');
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Card(
          child: ListTile(
            leading: GestureDetector(onTap: _egg, child: const Icon(Icons.vpn_key)),
            title: const Text('Kod zaproszenia'),
            subtitle: Text(trip.inviteCode, style: const TextStyle(fontSize: 22, letterSpacing: 4)),
            trailing: IconButton(
              icon: const Icon(Icons.copy),
              onPressed: () {
                Clipboard.setData(ClipboardData(text: trip.inviteCode));
                ScaffoldMessenger.of(context)
                    .showSnackBar(const SnackBar(content: Text('Skopiowano kod')));
              },
            ),
          ),
        ),
        ListenableBuilder(
          listenable: LocationSharing.i,
          builder: (context, _) => SwitchListTile(
            secondary: const Icon(Icons.my_location),
            title: const Text('Udostępniaj moją lokalizację'),
            subtitle: const Text('Ekipa widzi Cię na mapie na żywo, także gdy aplikacja działa w tle'),
            value: LocationSharing.i.isSharing(widget.trip.id),
            onChanged: _toggleShare,
          ),
        ),
        const SizedBox(height: 8),
        StreamBuilder<List<SosAlert>>(
          stream: Repo.i.activeSos(trip.id),
          builder: (context, snap) {
            final alerts = snap.data ?? [];
            if (alerts.isEmpty) return const SizedBox();
            return Column(children: [
              for (final a in alerts)
                Card(
                  color: Colors.red.shade100,
                  child: ListTile(
                    leading: const Icon(Icons.sos, color: Colors.red),
                    title: Text('${a.name} prosi o pomoc'),
                    subtitle: Text('${a.lat.toStringAsFixed(5)}, ${a.lng.toStringAsFixed(5)}'),
                    trailing: a.uid == Repo.i.uid
                        ? TextButton(
                            onPressed: () => Repo.i.resolveSos(trip.id, a.id),
                            child: const Text('Już OK'))
                        : null,
                  ),
                ),
            ]);
          },
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 8, 4, 4),
          child: Text('Uczestnicy', style: TextStyle(fontWeight: FontWeight.bold)),
        ),
        StreamBuilder<List<SharedLocation>>(
          stream: Repo.i.locations(trip.id),
          builder: (context, snap) {
            final locs = {for (final l in snap.data ?? <SharedLocation>[]) l.uid: l};
            return Column(children: [
              for (final id in trip.memberIds)
                ListTile(
                  leading: const CircleAvatar(child: Icon(Icons.person)),
                  title: Text(trip.nameOf(id) + (id == Repo.i.uid ? ' (Ty)' : '')),
                  subtitle: Text(locs[id] == null
                      ? 'Lokalizacja nieudostępniana'
                      : 'Lokalizacja: ${locs[id]!.lat.toStringAsFixed(4)}, ${locs[id]!.lng.toStringAsFixed(4)}'
                          '${locs[id]!.updatedAt == null ? '' : ' (${time.format(locs[id]!.updatedAt!)})'}'),
                ),
            ]);
          },
        ),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          onPressed: () async {
            await LocationSharing.i.stop(trip.id); // przed wyjściem: usunięcie pozycji wymaga członkostwa
            await Repo.i.leaveTrip(trip.id);
            if (context.mounted) Navigator.pop(context);
          },
          icon: const Icon(Icons.exit_to_app),
          label: const Text('Opuść podróż'),
        ),
      ],
    );
  }
}
