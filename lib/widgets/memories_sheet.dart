import 'dart:typed_data';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:video_compress/video_compress.dart';
import 'package:video_player/video_player.dart';

import '../models/models.dart';
import '../services/media.dart';
import '../services/repo.dart';

void showPlaceSheet(BuildContext context, Trip trip, Place place) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      maxChildSize: 0.95,
      builder: (ctx, scroll) => _PlaceSheet(trip: trip, place: place, scroll: scroll),
    ),
  );
}

class _PlaceSheet extends StatefulWidget {
  final Trip trip;
  final Place place;
  final ScrollController scroll;
  const _PlaceSheet({required this.trip, required this.place, required this.scroll});

  @override
  State<_PlaceSheet> createState() => _PlaceSheetState();
}

class _PlaceSheetState extends State<_PlaceSheet> {
  final _recorder = AudioRecorder();
  bool _recording = false;
  bool _uploading = false;
  // Błędy pokazujemy w panelu: SnackBar z ekranu pod spodem jest przysłonięty przez ten panel.
  String? _error;

  @override
  void dispose() {
    _recorder.dispose();
    super.dispose();
  }

  Future<String?> _askDescription() async {
    final c = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Krótki opis'),
        content: TextField(controller: c, autofocus: true, maxLength: 200,
            decoration: const InputDecoration(hintText: 'Co to za chwila?')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Anuluj')),
          FilledButton(onPressed: () => Navigator.pop(context, c.text.trim()), child: const Text('Zapisz')),
        ],
      ),
    );
  }

  Future<void> _upload(File file, MemoryType type) async {
    final desc = await _askDescription();
    if (desc == null) return;
    setState(() {
      _uploading = true;
      _error = null;
    });
    try {
      await Repo.i.addMemory(
        tripId: widget.trip.id,
        placeId: widget.place.id,
        type: type,
        file: file,
        description: desc,
      );
    } catch (e) {
      if (mounted) setState(() => _error = 'Błąd wysyłania: $e');
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  // Limit pliku na darmowym Cloudinary (z pamięci ~100 MB dla wideo) - zostawiamy zapas.
  static const _maxVideoBytes = 90 * 1024 * 1024;

  Future<void> _pick(MemoryType type, ImageSource source) async {
    final picker = ImagePicker();
    final XFile? f = type == MemoryType.photo
        ? await picker.pickImage(source: source, imageQuality: 75, maxWidth: 1600)
        : await picker.pickVideo(source: source, maxDuration: const Duration(minutes: 1));
    if (f == null) return;
    var file = File(f.path);
    if (type == MemoryType.video) {
      setState(() => _uploading = true);
      try {
        final info = await VideoCompress.compressVideo(f.path,
            quality: VideoQuality.MediumQuality, deleteOrigin: false);
        if (info?.file != null) file = info!.file!;
      } catch (_) {} // nie udało się skompresować: spróbujemy wysłać oryginał
      if (mounted) setState(() => _uploading = false);
      if (await file.length() > _maxVideoBytes) {
        if (mounted) setState(() => _error = 'Film jest za duży (limit ok. 90 MB). Nagraj krótszy.');
        return;
      }
    }
    await _upload(file, type);
  }

  Future<void> _toggleRecord() async {
    if (_recording) {
      final path = await _recorder.stop();
      setState(() => _recording = false);
      if (path != null) await _upload(File(path), MemoryType.audio);
      return;
    }
    if (!await _recorder.hasPermission()) {
      if (mounted) setState(() => _error = 'Brak zgody na mikrofon');
      return;
    }
    final dir = await getTemporaryDirectory();
    await _recorder.start(const RecordConfig(encoder: AudioEncoder.aacLc),
        path: '${dir.path}/glosowka_${DateTime.now().millisecondsSinceEpoch}.m4a');
    setState(() => _recording = true);
  }

  void _addMenu() {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
              leading: const Icon(Icons.photo_camera),
              title: const Text('Zrób zdjęcie'),
              onTap: () { Navigator.pop(context); _pick(MemoryType.photo, ImageSource.camera); }),
          ListTile(
              leading: const Icon(Icons.photo_library),
              title: const Text('Zdjęcie z galerii'),
              onTap: () { Navigator.pop(context); _pick(MemoryType.photo, ImageSource.gallery); }),
          ListTile(
              leading: const Icon(Icons.videocam),
              title: const Text('Nagraj wideo'),
              onTap: () { Navigator.pop(context); _pick(MemoryType.video, ImageSource.camera); }),
          ListTile(
              leading: const Icon(Icons.video_library),
              title: const Text('Wideo z galerii'),
              onTap: () { Navigator.pop(context); _pick(MemoryType.video, ImageSource.gallery); }),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.place;
    return ListView(
      controller: widget.scroll,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
      children: [
        Row(children: [
          Expanded(child: Text(p.title, style: Theme.of(context).textTheme.titleLarge)),
          if (p.createdBy == Repo.i.uid || widget.trip.createdBy == Repo.i.uid)
            IconButton(
              tooltip: 'Usuń miejsce',
              icon: const Icon(Icons.delete_outline),
              onPressed: () async {
                await Repo.i.deletePlace(widget.trip.id, p.id);
                if (context.mounted) Navigator.pop(context);
              },
            ),
        ]),
        if (p.note.isNotEmpty) Text(p.note),
        const SizedBox(height: 12),
        Wrap(spacing: 8, children: [
          FilledButton.icon(
            onPressed: _uploading ? null : _addMenu,
            icon: const Icon(Icons.add_a_photo),
            label: const Text('Zdjęcie / wideo'),
          ),
          FilledButton.tonalIcon(
            onPressed: _uploading ? null : _toggleRecord,
            icon: Icon(_recording ? Icons.stop : Icons.mic, color: _recording ? Colors.red : null),
            label: Text(_recording ? 'Zakończ nagranie' : 'Głosówka'),
          ),
        ]),
        if (_uploading) const Padding(padding: EdgeInsets.all(12), child: LinearProgressIndicator()),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectableText(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 12),
        StreamBuilder<List<Memory>>(
          stream: Repo.i.memories(widget.trip.id, p.id),
          builder: (context, snap) {
            final items = snap.data ?? [];
            if (items.isEmpty) return const Text('Brak wspólnych wspomnień - dodaj pierwsze!');
            return Column(children: [
              for (final m in items)
                _MemoryCard(memory: m, author: widget.trip.nameOf(m.createdBy), tripId: widget.trip.id),
            ]);
          },
        ),
      ],
    );
  }
}

class _MemoryCard extends StatelessWidget {
  final Memory memory;
  final String author;
  final String tripId;
  const _MemoryCard({required this.memory, required this.author, required this.tripId});

  /// Najpierw plik w Cloudinary (operacja idempotentna: brak pliku to też sukces), potem wpis. Jeśli zapis wpisu
  /// się nie uda, plik jest już usunięty, a kolejna próba bezpiecznie dokończy usuwanie. Odwrotna kolejność
  /// zostawiałaby plik bez wpisu, którego nikt już nie usunie.
  Future<void> _delete(BuildContext context) async {
    try {
      await Repo.i.deleteMemory(tripId, memory);
    } catch (e) {
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('Nie udało się usunąć'),
          content: const Text('Sprawdź połączenie i spróbuj ponownie. Jeśli plik został już usunięty, '
              'kolejna próba dokończy usuwanie wpisu.'),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final Widget body = switch (memory.type) {
      MemoryType.photo => ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: _PrivateImage(tripId: tripId, memory: memory),
        ),
      MemoryType.video => _VideoPlayer(tripId: tripId, memory: memory),
      MemoryType.audio => _AudioPlayer(tripId: tripId, memory: memory),
    };
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          body,
          if (memory.description.isNotEmpty)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text(memory.description)),
          Row(children: [
            Expanded(child: Text(author, style: Theme.of(context).textTheme.bodySmall)),
            if (memory.createdBy == Repo.i.uid)
              IconButton(
                  icon: const Icon(Icons.delete_outline, size: 20),
                  onPressed: () => _delete(context)),
          ]),
        ]),
      ),
    );
  }
}

/// Zdjęcie czytane przez worker (nagłówek z krótkim tokenem). Stare wpisy używają dawnego adresu.
class _PrivateImage extends StatefulWidget {
  final String tripId;
  final Memory memory;
  const _PrivateImage({required this.tripId, required this.memory});

  @override
  State<_PrivateImage> createState() => _PrivateImageState();
}

class _PrivateImageState extends State<_PrivateImage> {
  late final Future<MediaRef?> _ref = Media.ref(widget.tripId, widget.memory);

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<MediaRef?>(
      future: _ref,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const SizedBox(height: 160, child: Center(child: CircularProgressIndicator()));
        }
        final ref = snap.data;
        if (ref == null) return const Icon(Icons.broken_image);
        return Image.network(ref.url,
            headers: ref.headers, fit: BoxFit.cover, errorBuilder: (_, _, _) => const Icon(Icons.broken_image));
      },
    );
  }
}

class _VideoPlayer extends StatefulWidget {
  final String tripId;
  final Memory memory;
  const _VideoPlayer({required this.tripId, required this.memory});

  @override
  State<_VideoPlayer> createState() => _VideoPlayerState();
}

class _VideoPlayerState extends State<_VideoPlayer> {
  VideoPlayerController? _c;
  MediaRef? _ref;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init({Duration? startAt}) async {
    try {
      final ref = await Media.ref(widget.tripId, widget.memory);
      if (ref == null) throw Exception('brak pliku');
      // Nagłówki z tokenem dostają też żądania Range, więc przewijanie działa przez worker.
      final c = VideoPlayerController.networkUrl(Uri.parse(ref.url), httpHeaders: ref.headers);
      await c.initialize();
      if (startAt != null) await c.seekTo(startAt);
      _ref = ref;
      _c = c;
      if (mounted) {
        setState(() {});
      } else {
        await c.dispose();
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  /// Nagłówki odtwarzacza są stałe, a token wygasa. Jeśli do wznowienia zostało mało czasu, otwieramy plik na nowo
  /// z nowym tokenem od tej samej pozycji, żeby kolejne żądania Range nie dostały 401.
  Future<void> _play(VideoPlayerController c) async {
    final until = _ref?.validUntil;
    if (until != null && Media.now().isAfter(until.subtract(const Duration(seconds: 15)))) {
      final pos = c.value.position;
      await c.pause();
      final old = c;
      await _init(startAt: pos);
      await old.dispose();
      await _c?.play();
      return;
    }
    await c.play();
  }

  @override
  void dispose() {
    _c?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = _c;
    if (_failed) return const SizedBox(height: 160, child: Center(child: Icon(Icons.broken_image)));
    if (c == null || !c.value.isInitialized) {
      return const SizedBox(height: 160, child: Center(child: CircularProgressIndicator()));
    }
    return Stack(alignment: Alignment.center, children: [
      AspectRatio(aspectRatio: c.value.aspectRatio, child: VideoPlayer(c)),
      ValueListenableBuilder(
        valueListenable: c,
        builder: (_, v, _) => IconButton.filled(
          icon: Icon(v.isPlaying ? Icons.pause : Icons.play_arrow),
          onPressed: () => v.isPlaying ? c.pause() : _play(c),
        ),
      ),
    ]);
  }
}

class _AudioPlayer extends StatefulWidget {
  final String tripId;
  final Memory memory;
  const _AudioPlayer({required this.tripId, required this.memory});

  @override
  State<_AudioPlayer> createState() => _AudioPlayerState();
}

class _AudioPlayerState extends State<_AudioPlayer> {
  final _p = AudioPlayer();
  bool _playing = false;
  bool _loading = false;
  String? _error;
  Uint8List? _bytes;

  @override
  void initState() {
    super.initState();
    _p.onPlayerStateChanged.listen((s) {
      if (mounted) setState(() => _playing = s == PlayerState.playing);
    });
  }

  @override
  void dispose() {
    _p.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_playing) return _p.pause();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (widget.memory.isPrivate) {
        // Odtwarzacz dźwięku nie przyjmuje nagłówków, a głosówki są krótkie: pobieramy je do pamięci.
        _bytes ??= Uint8List.fromList(await Media.fetch(widget.tripId, widget.memory));
        await _p.play(BytesSource(_bytes!));
      } else {
        final ref = await Media.ref(widget.tripId, widget.memory);
        if (ref == null) throw Exception('brak pliku');
        await _p.play(UrlSource(ref.url));
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Nie udało się odtworzyć nagrania');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      IconButton.filledTonal(
        icon: _loading
            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : Icon(_playing ? Icons.pause : Icons.play_arrow),
        onPressed: _loading ? null : _toggle,
      ),
      const SizedBox(width: 8),
      Text(_error ?? 'Głosówka'),
    ]);
  }
}
