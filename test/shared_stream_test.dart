import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:crew_atlas/services/shared_stream.dart';

void main() {
  test('dwóch odbiorców = jeden nasłuch źródła, późny dostaje ostatnią wartość', () async {
    var listens = 0;
    var cancels = 0;
    final src = StreamController<int>.broadcast(
      onListen: () => listens++,
      onCancel: () => cancels++,
    );
    final shared = SharedStream<int>(() => src.stream);

    expect(identical(shared.stream, shared.stream), isTrue); // ten sam obiekt = brak odnawiania w StreamBuilder

    final a = <int>[];
    final b = <int>[];
    final subA = shared.stream.listen(a.add);
    src.add(1);
    await Future<void>.delayed(Duration.zero);
    final subB = shared.stream.listen(b.add); // dołącza po pierwszej wartości
    src.add(2);
    await Future<void>.delayed(Duration.zero);

    expect(a, [1, 2]);
    expect(b, [1, 2]); // 1 z powtórki, 2 na żywo
    expect(listens, 1);

    await subA.cancel();
    expect(cancels, 0); // jeszcze jest odbiorca B
    await subB.cancel();
    expect(cancels, 1); // źródło zamknięte po odejściu ostatniego
  });
}
