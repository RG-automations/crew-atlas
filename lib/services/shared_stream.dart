import 'dart:async';

/// Jeden nasłuch źródła dla wielu odbiorców; nowy odbiorca od razu dostaje ostatnią wartość,
/// a źródło jest zamykane, gdy zniknie ostatni odbiorca (i tworzone od nowa przy następnym).
/// [stream] to zawsze ten sam obiekt, dzięki czemu StreamBuilder nie odnawia subskrypcji.
class SharedStream<T> {
  SharedStream(this._make);
  final Stream<T> Function() _make;
  final _out = StreamController<T>.broadcast();
  StreamSubscription<T>? _sub;
  T? _last;
  bool _hasLast = false;

  late final Stream<T> stream = Stream<T>.multi((c) {
    if (_hasLast) c.add(_last as T);
    final listener = _out.stream.listen(c.add, onError: c.addError);
    _sub ??= _make().listen((v) {
      _last = v;
      _hasLast = true;
      _out.add(v);
    }, onError: _out.addError);
    c.onCancel = () async {
      await listener.cancel();
      if (!_out.hasListener) {
        await _sub?.cancel();
        _sub = null;
        _hasLast = false;
      }
    };
  });
}
