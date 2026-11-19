/// Adres workera Cloudflare (nie jest sekretem - sekrety są tylko na serwerze). Worker podpisuje wysyłanie plików.
/// Podaj przy budowaniu:  --dart-define=WORKER_URL=https://YOUR_WORKER_URL
const workerUrl = String.fromEnvironment('WORKER_URL', defaultValue: '');

/// Klucz MapTiler Cloud podawany przy budowaniu (--dart-define). Aplikacja łączy się z MapTiler bezpośrednio:
/// klucz trafia do APK, więc to klucz publiczny. Chroń go limitami i ograniczeniem w panelu MapTiler.
/// Nie commituj prawdziwego klucza (patrz config.example.json).
const maptilerKey = String.fromEnvironment('MAPTILER_KEY', defaultValue: '');

const supportedCurrencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK', 'CHF', 'HUF', 'NOK', 'SEK', 'DKK', 'TRY'];

const sosChannelId = 'sos_channel';
