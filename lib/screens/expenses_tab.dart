import 'package:flutter/material.dart';

import '../config.dart';
import '../models/models.dart';
import '../services/nbp.dart';
import '../services/repo.dart';
import '../services/settlement.dart';

class ExpensesTab extends StatelessWidget {
  final Trip trip;
  const ExpensesTab({super.key, required this.trip});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: StreamBuilder<List<Expense>>(
        stream: Repo.i.expenses(trip.id),
        builder: (context, snap) {
          final expenses = snap.data ?? [];
          return ListView(padding: const EdgeInsets.only(bottom: 88), children: [
            _Settlement(trip: trip, expenses: expenses),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text('Wydatki', style: TextStyle(fontWeight: FontWeight.bold)),
            ),
            if (expenses.isEmpty)
              const Padding(padding: EdgeInsets.all(16), child: Text('Brak wydatków.')),
            for (final e in expenses)
              ListTile(
                leading: const Icon(Icons.receipt_long),
                title: Text(e.description),
                subtitle: Text('Zapłacił(a): ${trip.nameOf(e.paidBy)}\n'
                    'Dzielone na: ${e.participants.map(trip.nameOf).join(', ')}'),
                isThreeLine: true,
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Text('${e.amount.toStringAsFixed(2)} ${e.currency}',
                        style: const TextStyle(fontWeight: FontWeight.bold)),
                    if (e.currency != trip.baseCurrency) _Converted(trip: trip, expense: e),
                  ]),
                  if (e.createdBy == Repo.i.uid || trip.createdBy == Repo.i.uid)
                    IconButton(
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () => Repo.i.deleteExpense(trip.id, e.id)),
                ]),
              ),
          ]);
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'expense',
        onPressed: () => _add(context),
        icon: const Icon(Icons.add),
        label: const Text('Wydatek'),
      ),
    );
  }

  Future<void> _add(BuildContext context) async {
    final desc = TextEditingController();
    final amount = TextEditingController();
    var currency = trip.baseCurrency;
    var paidBy = Repo.i.uid;
    final selected = {...trip.memberIds};
    var busy = false;
    var preview = '';
    var previewSeq = 0;
    await showDialog<void>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setS) {
          Future<void> updatePreview() async {
            final seq = ++previewSeq;
            final value = double.tryParse(amount.text.replaceAll(',', '.'));
            if (value == null || value <= 0 || currency == trip.baseCurrency) {
              setS(() => preview = '');
              return;
            }
            setS(() => preview = 'Pobieram kurs NBP...');
            String text;
            try {
              final r = await Nbp.convert(value, currency, trip.baseCurrency);
              text = '≈ ${r.amount.toStringAsFixed(2)} ${trip.baseCurrency}'
                  '  (kurs NBP: 1 $currency = ${r.rate.toStringAsFixed(4)} ${trip.baseCurrency})';
            } catch (e) {
              text = 'Nie udało się pobrać kursu NBP: $e';
            }
            if (seq == previewSeq && ctx.mounted) setS(() => preview = text);
          }

          return AlertDialog(
          title: const Text('Nowy wydatek'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              TextField(controller: desc, decoration: const InputDecoration(labelText: 'Za co zapłacono?')),
              Row(children: [
                Expanded(
                  flex: 2,
                  child: TextField(
                    controller: amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(labelText: 'Kwota'),
                    onChanged: (_) => updatePreview(),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: currency,
                    decoration: const InputDecoration(labelText: 'Waluta'),
                    items: [for (final c in supportedCurrencies) DropdownMenuItem(value: c, child: Text(c))],
                    onChanged: (v) {
                      setS(() => currency = v ?? currency);
                      updatePreview();
                    },
                  ),
                ),
              ]),
              if (preview.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(preview, style: Theme.of(ctx).textTheme.bodySmall),
                ),
              DropdownButtonFormField<String>(
                initialValue: paidBy,
                decoration: const InputDecoration(labelText: 'Kto zapłacił'),
                items: [for (final id in trip.memberIds) DropdownMenuItem(value: id, child: Text(trip.nameOf(id)))],
                onChanged: (v) => setS(() => paidBy = v ?? paidBy),
              ),
              const SizedBox(height: 8),
              const Text('Dzielone na:'),
              for (final id in trip.memberIds)
                CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(trip.nameOf(id)),
                  value: selected.contains(id),
                  onChanged: (v) => setS(() => v == true ? selected.add(id) : selected.remove(id)),
                ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Anuluj')),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      final value = double.tryParse(amount.text.replaceAll(',', '.'));
                      if (desc.text.trim().isEmpty || value == null || value <= 0 || selected.isEmpty) {
                        ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(
                            content: Text('Podaj opis, kwotę i przynajmniej jedną osobę')));
                        return;
                      }
                      setS(() => busy = true);
                      try {
                        await Repo.i.addExpense(
                          tripId: trip.id,
                          description: desc.text.trim(),
                          amount: value,
                          currency: currency,
                          paidBy: paidBy,
                          participants: selected.toList(),
                        );
                        if (ctx.mounted) Navigator.pop(ctx);
                      } catch (e) {
                        setS(() => busy = false);
                        if (ctx.mounted) {
                          ScaffoldMessenger.of(ctx)
                              .showSnackBar(SnackBar(content: Text('Nie udało się pobrać kursu NBP: $e')));
                        }
                      }
                    },
              child: const Text('Dodaj'),
            ),
          ],
        );
        },
      ),
    );
  }
}

/// Podsumowanie: kto komu ile oddaje, w walucie rozliczeń podróży.
class _Settlement extends StatelessWidget {
  final Trip trip;
  final List<Expense> expenses;
  const _Settlement({required this.trip, required this.expenses});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<double>(
      future: Nbp.rateToPln(trip.baseCurrency),
      builder: (context, snap) {
        if (snap.hasError) {
          return const Card(child: ListTile(title: Text('Nie udało się pobrać kursu NBP waluty rozliczeń')));
        }
        final base = snap.data;
        if (base == null) return const LinearProgressIndicator();
        final transfers = settle(computeBalances(
          [
            for (final e in expenses)
              ExpenseInput(
                  amount: e.amount,
                  currency: e.currency,
                  rateToPln: e.rateToPln,
                  paidBy: e.paidBy,
                  participants: e.participants),
          ],
          base,
          trip.memberIds,
          baseCurrency: trip.baseCurrency,
        ));
        return Card(
          margin: const EdgeInsets.all(12),
          color: Theme.of(context).colorScheme.primaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Rozliczenie (${trip.baseCurrency})', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              if (transfers.isEmpty) const Text('Wszyscy są kwita 🎉'),
              for (final t in transfers)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Text('${trip.nameOf(t.from)} oddaje ${trip.nameOf(t.to)}: '
                      '${t.amount.toStringAsFixed(2)} ${trip.baseCurrency}'),
                ),
              const SizedBox(height: 4),
              const Text('Kursy średnie NBP z dnia dodania wydatku.', style: TextStyle(fontSize: 11)),
            ]),
          ),
        );
      },
    );
  }
}

/// "≈ 43.75 PLN" pod kwotą wydatku w obcej walucie (kurs zapisany przy wydatku).
class _Converted extends StatelessWidget {
  final Trip trip;
  final Expense expense;
  const _Converted({required this.trip, required this.expense});

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<double>(
      future: Nbp.rateToPln(trip.baseCurrency),
      builder: (context, snap) {
        final base = snap.data;
        if (base == null) return const SizedBox.shrink();
        final v = convert(expense.amount, expense.rateToPln, base);
        return Text('≈ ${v.toStringAsFixed(2)} ${trip.baseCurrency}',
            style: Theme.of(context).textTheme.bodySmall);
      },
    );
  }
}
