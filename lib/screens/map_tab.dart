import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../models/models.dart';
import '../services/media.dart';
import '../services/repo.dart';
import '../widgets/map_icons.dart';
import '../widgets/memories_sheet.dart';

class MapTab extends StatefulWidget {
  final Trip trip;
  const MapTab({super.key, required this.trip});

  @override
  State<MapTab> createState() => _MapTabState();
}

class _MapTabState extends State<MapTab> {
  MapLibreMapController? _map;
  bool _styleReady = false;
  bool _showHint = true;
  bool _cameraSet = false;
  List<Place> _places = [];
  List<SharedLocation> _people = [];
  List<SosAlert> _sos = [];
  List<Memory> _memories = [];
  final _imageNames = <String>{}; // obrazy już dodane do mapy
  final _imageFailed = <String>{};
  final _player = AudioPlayer();
  String? _playingId;
  bool _drawing = false;
  bool _again = false;
  final _subs = <StreamSubscription>[];
  Timer? _ageTimer;

  @override
  void initState() {
    super.initState();
    _ageTimer = Timer.periodic(const Duration(seconds: 30), (_) => _redraw());
    final id = widget.trip.id;
    _subs.add(Repo.i.places(id).listen((p) {
      _places = p;
      _redraw();
    }));
    _subs.add(Repo.i.locations(id).listen((p) {
      _people = p;
      _redraw();
    }));
    _subs.add(Repo.i.activeSos(id).listen((p) {
      _sos = p;
      _redraw();
    }));
    _subs.add(Repo.i.allMemories(id).listen((p) {
      _memories = p;
      _redraw();
    }));
    _player.onPlayerComplete.listen((_) {
      _playingId = null;
      _redraw();
    });
  }

  @override
  void dispose() {
    _ageTimer?.cancel();
    _player.dispose();
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }

  /// Start mapy na miejscu podróży: pierwsze dodane miejsce albo geokodowany cel podróży.
  Future<void> _initCamera() async {
    if (_cameraSet || _map == null) return;
    _cameraSet = true;
    if (_places.isNotEmpty) {
      final p = _places.first;
      _map!.moveCamera(CameraUpdate.newLatLngZoom(LatLng(p.lat, p.lng), 11));
      return;
    }
    final q = widget.trip.destination.trim().isEmpty ? widget.trip.name : widget.trip.destination;
    if (maptilerKey.isEmpty || q.trim().isEmpty) return;
    try {
      final res = await http
          .get(Uri.parse(
              'https://api.maptiler.com/geocoding/${Uri.encodeComponent(q)}.json?limit=1&key=$maptilerKey'))
          .timeout(const Duration(seconds: 8));
      final f = (jsonDecode(res.body)['features'] as List?)?.firstOrNull;
      final c = f?['center'] as List?;
      if (c != null && mounted) {
        _map!.animateCamera(CameraUpdate.newLatLngZoom(
            LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()), 8));
      }
    } catch (_) {}
  }

  Future<void> _redraw() async {
    if (_drawing) {
      _again = true;
      return;
    }
    _drawing = true;
    try {
      do {
        _again = false;
        await _drawOnce();
      } while (_again);
    } finally {
      _drawing = false;
    }
  }

  /// Dodaje obraz do mapy (raz). Zwraca nazwę obrazu albo null, gdy się nie udało.
  Future<String?> _ensureThumb(Memory m) async {
    final name = 'm_${m.id}';
    if (_imageNames.contains(name)) return name;
    if (_imageFailed.contains(name)) return null;
    try {
      if (await Media.ref(widget.trip.id, m, thumb: true) == null) return null;
      final bytes = await Media.fetch(widget.trip.id, m, thumb: true); // przy 401 odświeża token i ponawia raz
      final png = await circleThumbnail(Uint8List.fromList(bytes), video: m.type == MemoryType.video);
      await _map!.addImage(name, png);
      _imageNames.add(name);
      return name;
    } catch (_) {
      _imageFailed.add(name);
      return null;
    }
  }

  Future<String> _ensurePlayIcon(bool playing) async {
    final name = playing ? 'btn_pause' : 'btn_play';
    if (!_imageNames.contains(name)) {
      final Uint8List png = await playButton(playing: playing);
      await _map!.addImage(name, png);
      _imageNames.add(name);
    }
    return name;
  }

  Future<void> _toggleAudio(Memory m) async {
    if (_playingId == m.id) {
      await _player.stop();
      _playingId = null;
    } else {
      _playingId = m.id;
      try {
        // Prywatne pliki: odtwarzacz dźwięku nie przyjmuje nagłówków, a głosówki są krótkie, więc idą przez pamięć.
        if (m.isPrivate) {
          await _player.play(BytesSource(Uint8List.fromList(await Media.fetch(widget.trip.id, m))));
        } else {
          final ref = await Media.ref(widget.trip.id, m);
          if (ref == null) throw Exception('brak pliku');
          await _player.play(UrlSource(ref.url));
        }
      } catch (_) {
        _playingId = null;
      }
    }
    _redraw();
  }

  Future<void> _drawOnce() async {
    final m = _map;
    if (m == null || !_styleReady) return;
    await m.clearCircles();
    await m.clearSymbols();
    for (final p in _places) {
      final here = _memories.where((x) => x.placeId == p.id);
      final visual = here.where((x) => x.type != MemoryType.audio).firstOrNull;
      final audio = here.where((x) => x.type == MemoryType.audio).firstOrNull;
      final at = LatLng(p.lat, p.lng);
      final placeData = {'type': 'place', 'id': p.id};

      final thumb = visual == null ? null : await _ensureThumb(visual);
      if (thumb != null) {
        await m.addSymbol(SymbolOptions(geometry: at, iconImage: thumb, iconSize: 0.8), placeData);
      } else {
        await m.addCircle(
          CircleOptions(
            geometry: at,
            circleRadius: 9,
            circleColor: '#00897B',
            circleStrokeColor: '#FFFFFF',
            circleStrokeWidth: 2,
          ),
          placeData,
        );
      }
      if (audio != null) {
        final icon = await _ensurePlayIcon(_playingId == audio.id);
        await m.addSymbol(
          SymbolOptions(
            geometry: at,
            iconImage: icon,
            iconSize: 0.55,
            // przycisk obok miniatury albo nad zwykłym punktem
            iconOffset: thumb != null ? const Offset(38, 38) : const Offset(0, -34),
          ),
          {'type': 'audio', 'id': audio.id},
        );
      }
    }
    final now = DateTime.now();
    for (final l in _people) {
      final mine = l.uid == Repo.i.uid;
      final age = l.updatedAt == null ? Duration.zero : now.difference(l.updatedAt!);
      final stale = age > const Duration(minutes: 10);
      final color = stale ? '#9E9E9E' : (mine ? '#1565C0' : '#1E88E5');
      await m.addCircle(
        CircleOptions(
          geometry: LatLng(l.lat, l.lng),
          circleRadius: mine ? 9 : 8,
          circleColor: color,
          circleStrokeColor: '#FFFFFF',
          circleStrokeWidth: 3,
        ),
        {'type': 'person', 'name': l.name, 'age': _ageText(age)},
      );
      await m.addSymbol(SymbolOptions(
        geometry: LatLng(l.lat, l.lng),
        textField: '${mine ? 'Ty' : l.name} · ${_ageText(age)}',
        textSize: 12,
        textColor: color,
        textHaloColor: '#FFFFFF',
        textHaloWidth: 2,
        textAnchor: 'top',
        textOffset: const Offset(0, 1),
        fontNames: const ['Noto Sans Regular'],
      ));
    }
    for (final s in _sos) {
      await m.addCircle(
        CircleOptions(
          geometry: LatLng(s.lat, s.lng),
          circleRadius: 14,
          circleColor: '#E53935',
          circleStrokeColor: '#FFFFFF',
          circleStrokeWidth: 3,
        ),
        {'type': 'sos', 'name': s.name},
      );
    }
  }

  static String _ageText(Duration d) {
    if (d.inSeconds < 90) return 'teraz';
    if (d.inMinutes < 60) return '${d.inMinutes} min temu';
    if (d.inHours < 24) return '${d.inHours} godz. temu';
    return '${d.inDays} dn. temu';
  }

  /// Dopasowuje widok do wszystkich osób, które udostępniają lokalizację.
  void _showCrew() {
    if (_people.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Nikt jeszcze nie udostępnia lokalizacji (Ekipa → przełącznik)')));
      return;
    }
    final lats = _people.map((p) => p.lat), lngs = _people.map((p) => p.lng);
    if (_people.length == 1) {
      _map?.animateCamera(CameraUpdate.newLatLngZoom(LatLng(_people.first.lat, _people.first.lng), 15));
      return;
    }
    _map?.animateCamera(CameraUpdate.newLatLngBounds(
      LatLngBounds(
        southwest: LatLng(lats.reduce(min), lngs.reduce(min)),
        northeast: LatLng(lats.reduce(max), lngs.reduce(max)),
      ),
      left: 60, right: 60, top: 120, bottom: 120,
    ));
  }

  void _onSymbolTapped(Symbol sym) {
    final data = sym.data ?? {};
    if (data['type'] == 'audio') {
      final mem = _memories.where((x) => x.id == data['id']).firstOrNull;
      if (mem != null) _toggleAudio(mem);
    } else if (data['type'] == 'place') {
      final place = _places.where((p) => p.id == data['id']).firstOrNull;
      if (place != null) showPlaceSheet(context, widget.trip, place);
    }
  }

  void _onCircleTapped(Circle c) {
    final data = c.data ?? {};
    if (data['type'] == 'place') {
      final place = _places.where((p) => p.id == data['id']).firstOrNull;
      if (place != null) showPlaceSheet(context, widget.trip, place);
    } else {
      final msg = data['type'] == 'sos' ? 'SOS: ${data['name']}' : '${data['name']} - lokalizacja na żywo, ${data['age']}';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }

  Future<void> _addPlace(LatLng at) async {
    final title = TextEditingController();
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Nowe miejsce'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: title, autofocus: true, decoration: const InputDecoration(labelText: 'Nazwa miejsca')),
          TextField(controller: note, decoration: const InputDecoration(labelText: 'Notatka (opcjonalnie)')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Anuluj')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Dodaj')),
        ],
      ),
    );
    if (ok == true && title.text.trim().isNotEmpty) {
      await Repo.i.addPlace(widget.trip.id, title.text.trim(), note.text.trim(), at.latitude, at.longitude);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (maptilerKey.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('Brak klucza mapy (MAPTILER_KEY). Zbuduj aplikację z --dart-define-from-file.',
              textAlign: TextAlign.center),
        ),
      );
    }
    return Stack(
      children: [
        MapLibreMap(
          styleString: 'https://api.maptiler.com/maps/streets-v2/style.json?key=$maptilerKey',
          initialCameraPosition: const CameraPosition(target: LatLng(30, 10), zoom: 1.5),
          onMapCreated: (c) {
            _map = c;
            c.onCircleTapped.add(_onCircleTapped);
            c.onSymbolTapped.add(_onSymbolTapped);
          },
          onStyleLoadedCallback: () {
            _styleReady = true;
            _redraw();
            _initCamera();
          },
          onMapLongClick: (_, latLng) => _addPlace(latLng),
        ),
        if (_showHint)
          Positioned(
            left: 12,
            right: 12,
            top: 8,
            child: Card(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
                child: Row(children: [
                  Expanded(
                    child: Text(
                      'Przytrzymaj mapę, by dodać miejsce. Stuknij zielony punkt, by zobaczyć wspomnienia.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => setState(() => _showHint = false),
                  ),
                ]),
              ),
            ),
          ),
        // Wymagane przez MapTiler (plan Free): logo MapTiler z linkiem oraz widoczna atrybucja tekstowa z linkami.
        const Positioned(left: 6, bottom: 4, child: _MapAttribution()),
        Positioned(
          right: 12,
          bottom: 12,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            FloatingActionButton.small(
              heroTag: 'crew',
              tooltip: 'Pokaż ekipę',
              onPressed: _showCrew,
              child: const Icon(Icons.groups),
            ),
            const SizedBox(height: 8),
            FloatingActionButton.small(
              heroTag: 'places',
              tooltip: 'Lista miejsc',
              onPressed: _showList,
              child: const Icon(Icons.list),
            ),
          ]),
        ),
      ],
    );
  }

  void _showList() {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => _places.isEmpty
          ? const Padding(padding: EdgeInsets.all(32), child: Text('Brak miejsc - dodaj pierwsze na mapie.'))
          : ListView(
              children: [
                for (final p in _places)
                  ListTile(
                    leading: const Icon(Icons.place),
                    title: Text(p.title),
                    subtitle: p.note.isEmpty ? null : Text(p.note),
                    onTap: () {
                      Navigator.pop(context);
                      _map?.animateCamera(CameraUpdate.newLatLngZoom(LatLng(p.lat, p.lng), 13));
                      showPlaceSheet(context, widget.trip, p);
                    },
                  ),
              ],
            ),
    );
  }
}

/// Logo MapTiler (ładowane z adresu podanego w dokumentacji MapTiler) i atrybucja z linkami do
/// https://www.maptiler.com/copyright/ oraz https://www.openstreetmap.org/copyright.
class _MapAttribution extends StatelessWidget {
  const _MapAttribution();

  static void _open(String url) => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(fontSize: 10, color: Colors.black87, decoration: TextDecoration.underline);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      color: Colors.white70,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        GestureDetector(
          onTap: () => _open('https://www.maptiler.com'),
          child: SvgPicture.network(
            'https://api.maptiler.com/resources/logo.svg',
            height: 18,
            semanticsLabel: 'MapTiler logo',
            placeholderBuilder: (_) => const SizedBox(width: 54, height: 18),
          ),
        ),
        const SizedBox(width: 6),
        GestureDetector(
          onTap: () => _open('https://www.maptiler.com/copyright/'),
          child: const Text('© MapTiler', style: style),
        ),
        const SizedBox(width: 6),
        GestureDetector(
          onTap: () => _open('https://www.openstreetmap.org/copyright'),
          child: const Text('© OpenStreetMap contributors', style: style),
        ),
      ]),
    );
  }
}
