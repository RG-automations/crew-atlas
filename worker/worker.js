// Cloudflare Worker dla aplikacji CrewAtlas: bramka do prywatnych mediów i podpisy wysyłania.
// Sekrety Cloudinary i klucz tokenów mediów są tylko tutaj (Cloudflare Secrets), aplikacja ich nie zna.
// Mapa nie przechodzi przez worker: aplikacja łączy się z MapTiler bezpośrednio (regulamin MapTiler
// Cloud nie dopuszcza proxy ani cache po stronie serwera bez zgody dostawcy).
//
// Wszystkie pliki są w Cloudinary jako `authenticated` (bez podpisu nie ma dostępu). Aplikacja nigdy nie dostaje
// adresu Cloudinary: czyta pliki przez ten worker.
//
//   POST   /sign                  (Bearer: token Firebase)  { folder, v: 2, kind?: photo|video|audio }
//        -> podpis wysyłania jednego pliku typu `authenticated`. Tylko dla członków podróży.
//   POST   /media/token           (Bearer: token Firebase)  { tripId }
//        -> krótki token dostępu do mediów tej podróży (członkostwo sprawdzane w Firestore z tokenem użytkownika).
//   GET|HEAD /media/<image|video>/<tripId>/<id>.<format>[?thumb=1]   (Bearer: token mediów)
//        -> strumień pliku (obsługuje Range). Adres Cloudinary i jego podpis nie opuszczają workera.
//   DELETE /media/memory/<tripId>/<memoryId>   (Bearer: token Firebase)
//        -> usuwa plik z Cloudinary, jeśli wołający jest autorem wspomnienia lub założycielem podróży
//           (metadane z dokumentu Firestore czytanego z tokenem użytkownika).
//   GET    /health
//
// Zmienne (Settings -> Variables and Secrets):
//   ALLOWED_UIDS (opcjonalnie: uid kont po przecinku; tylko one dostają podpisy i tokeny mediów),
//   CLOUDINARY_FOLDER_MODE (opcjonalnie: `dynamic` gdy konto ma dynamic folders (podpis obejmuje asset_folder), `fixed` albo brak = dotychczas; inna wartość = błąd 500),
//   VIDEO_STRIP (opcjonalnie, 1: filmy wysyłane z incoming `fl_force_strip`; włącz dopiero po teście na koncie),
//   CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET (Secret), FIREBASE_PROJECT_ID,
//   MEDIA_TOKEN_SECRET (Secret, długi losowy tekst), opcjonalnie MEDIA_TOKEN_TTL (sekundy, domyślnie 600, 60-3600).

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- Firebase ID token ----------
async function verifyFirebaseToken(token, env, fetchFn = fetch) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('bad alg');

  const jwks = await (await fetchFn(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('expired');
  if (payload.iat > now + 300) throw new Error('issued in the future');
  const project = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (payload.aud !== project) {
    throw new Error('bad audience');
  }
  if (payload.iss !== `https://securetoken.google.com/${project}`) {
    throw new Error('bad issuer');
  }
  if (!payload.sub) throw new Error('no subject');
  return payload;
}

// Opcjonalna lista dozwolonych kont (ALLOWED_UIDS, uid po przecinku). Gdy jest ustawiona, tylko te konta dostają
// podpisy wysyłania i tokeny mediów. Ogranicza nadużycia przez obcych, którzy założyli konto w otwartej rejestracji
// Firebase Auth i sami założyli podróż. Pusta lub brak: bez ograniczenia.
const allowedUids = (env) => String(env.ALLOWED_UIDS || '').split(',').map((x) => x.trim()).filter(Boolean);

async function requireUser(request, env) {
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return { error: 'missing token' };
  let user;
  try {
    user = await verifyFirebaseToken(m[1], env);
  } catch (e) {
    return { error: String(e && e.message) };
  }
  const allow = allowedUids(env);
  if (allow.length && !allow.includes(user.sub)) return { error: 'not allowed', forbidden: true };
  return { user, token: m[1] };
}

const unauthorized = (reason) => json({ error: 'unauthorized', reason }, 401);
const denied = (auth) => (auth.forbidden ? json({ error: 'forbidden' }, 403) : unauthorized(auth.error));

// ---------- narzędzia ----------
async function sha1Hex(text) {
  return hex(await crypto.subtle.digest('SHA-1', enc.encode(text)));
}
async function sha1Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', enc.encode(text)));
}
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Prefiks `wycieczka/` to historyczna nazwa folderu: zostaje, bo używają go już zainstalowane aplikacje.
const TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRIP_FOLDER = /^wycieczka\/([A-Za-z0-9_-]{1,64})$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Cloudinary odrzuca pliki spoza listy (parametr allowed_formats jest częścią podpisu).
// Rozmiaru pliku podpis nie ogranicza: obowiązują tylko limity konta Cloudinary i limit w aplikacji.
const FORMATS = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
  video: ['mp4', 'mov', 'm4a', 'aac', 'mp3', 'wav', 'ogg', '3gp', 'webm'], // dźwięk też jest typu video w Cloudinary
};
const ALLOWED_FORMATS = [...FORMATS.image, ...FORMATS.video].join(',');

// Członkostwo i metadane czyta Firestore (REST) z tokenem użytkownika, więc o odczycie decydują reguły Firestore.
// Bez konta serwisowego. Zwraca sparsowany dokument albo null (brak dostępu lub brak dokumentu).
async function readDoc(env, idToken, path, fieldPaths) {
  const project = encodeURIComponent(String(env.FIREBASE_PROJECT_ID || '').trim());
  const mask = fieldPaths.map((f) => `mask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}?${mask}`,
    { headers: { authorization: `Bearer ${idToken}` } },
  );
  if (res.status !== 200) return null;
  return res.json();
}
// Bez konfiguracji Cloudinary worker nie podpisuje i nie pobiera niczego (a nie podpisuje z pustym sekretem). Sprawdzane po autoryzacji.
const cloudinaryReady = (env) => !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
const field = (doc, name) => doc?.fields?.[name]?.stringValue;

async function isTripMember(env, idToken, uid, tripId) {
  const doc = await readDoc(env, idToken, `trips/${tripId}`, ['memberIds']);
  const ids = doc?.fields?.memberIds?.arrayValue?.values ?? [];
  return ids.some((v) => v.stringValue === uid);
}

// ---------- Cloudinary: podpisane wysyłanie ----------
async function handleSign(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return denied(auth);
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const m = TRIP_FOLDER.exec(typeof body.folder === 'string' ? body.folder : '');
  if (!m) return json({ error: 'bad folder' }, 400);
  // Stary format podpisu nie zawierał typu dostępu, więc nie da się nim wysłać prywatnego pliku.
  if (body.v !== 2) return json({ error: 'update required' }, 426);

  let member;
  try {
    member = await isTripMember(env, auth.token, auth.user.sub, m[1]);
  } catch {
    return json({ error: 'upstream' }, 502);
  }
  if (!member) return json({ error: 'forbidden' }, 403);
  if (!cloudinaryReady(env)) return json({ error: 'not configured' }, 500);
  // Tryb folderów: brak zmiennej = dotychczasowe zachowanie (fixed). Każda inna wartość niż `fixed`/`dynamic` to błąd
  // konfiguracji, a nie ciche założenie trybu: plik trafiłby do roota albo poza folder klucza.
  if (env.CLOUDINARY_FOLDER_MODE !== undefined && !['fixed', 'dynamic'].includes(env.CLOUDINARY_FOLDER_MODE)) {
    console.error('CLOUDINARY_FOLDER_MODE: nieprawidłowa wartość (dozwolone: fixed, dynamic)');
    return json({ error: 'not configured' }, 500);
  }

  // Jeden podpis = jeden plik (public_id losuje worker, overwrite=false), tylko dozwolone formaty i
  // zawsze `type=authenticated`. Wszystkie parametry pochodzą z workera, klient nie dokłada żadnego.
  const params = {
    allowed_formats: ALLOWED_FORMATS,
    overwrite: 'false',
    public_id: `${m[0]}/${crypto.randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'authenticated',
  };
  // Opcjonalnie (VIDEO_STRIP=1): filmy dostają transformację przychodzącą `fl_force_strip`, która usuwa metadane
  // (GPS itd.) z zapisywanego oryginału. Wymaga potwierdzenia na koncie testem `cloudinary-video-strip-check.mjs`.
  // Decyduje worker na podstawie rodzaju pliku z żądania, klient nie wpływa na samą transformację.
  if (env.VIDEO_STRIP === '1' && body.kind === 'video') params.transformation = 'fl_force_strip';
  // Konto w trybie dynamic folders: folder nie wynika z public_id, więc podpisujemy też `asset_folder`.
  // Wartość pochodzi tylko z zwalidowanego id podróży (m[0]), klient jej nie podaje. W trybie fixed
  // Cloudinary nie przyjmuje tego parametru, dlatego (fixed lub zmienna nieustawiona) go nie dodajemy.
  if (env.CLOUDINARY_FOLDER_MODE === 'dynamic') params.asset_folder = m[0];
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = await sha1Hex(toSign + env.CLOUDINARY_API_SECRET);
  return json({ cloud: env.CLOUDINARY_CLOUD, apiKey: env.CLOUDINARY_API_KEY, signature, params });
}

// ---------- krótki token dostępu do mediów podróży ----------
// Token wiąże użytkownika z jedną podróżą i wygasa. Członkostwo sprawdzamy przy wydawaniu (jeden odczyt Firestore),
// a nie przy każdym żądaniu o plik, bo odczyty Firestore mają dzienny limit, a film to wiele żądań Range.
// Skutek: osoba usunięta z grupy zachowuje dostęp co najwyżej do końca ważności już wydanego tokenu.
const mediaTtl = (env) => Math.min(3600, Math.max(60, Number(env.MEDIA_TOKEN_TTL) || 600));

async function makeMediaToken(env, uid, tripId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + mediaTtl(env);
  const payload = b64url(enc.encode(JSON.stringify({ u: uid, t: tripId, e: exp })));
  return { token: `${payload}.${await hmacHex(env.MEDIA_TOKEN_SECRET, `media.${payload}`)}`, expiresAt: exp };
}

// Zwraca 'ok', 'denied' (zły, obcy lub wygasły token) albo 'other-trip'.
async function checkMediaToken(env, token, tripId, now = Date.now()) {
  const [payload, sig, extra] = String(token || '').split('.');
  if (!payload || !sig || extra !== undefined) return 'denied';
  if (!timingSafeEqual(await hmacHex(env.MEDIA_TOKEN_SECRET, `media.${payload}`), sig)) return 'denied';
  let p;
  try {
    p = b64urlToJson(payload);
  } catch {
    return 'denied';
  }
  if (!p || typeof p.e !== 'number' || p.e < Math.floor(now / 1000)) return 'denied';
  return p.t === tripId ? 'ok' : 'other-trip';
}

async function handleMediaToken(request, env) {
  if (!env.MEDIA_TOKEN_SECRET) return json({ error: 'not configured' }, 500);
  const auth = await requireUser(request, env);
  if (!auth.user) return denied(auth);
  let body = {};
  try {
    body = await request.json();
  } catch {}
  if (typeof body.tripId !== 'string' || !TRIP_ID.test(body.tripId)) return json({ error: 'bad trip' }, 400);
  let member;
  try {
    member = await isTripMember(env, auth.token, auth.user.sub, body.tripId);
  } catch {
    return json({ error: 'upstream' }, 502);
  }
  if (!member) return json({ error: 'forbidden' }, 403);
  return json(await makeMediaToken(env, auth.user.sub, body.tripId));
}

// ---------- strumień prywatnego pliku ----------
const MEDIA_PATH = /^\/media\/(image|video)\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{8,64})\.([a-z0-9]{2,5})$/;
const SAFE_TYPE = /^(image|video|audio)\/[a-z0-9.+-]+$/i;
// Miniatura ma stałe, narzucone przez worker przekształcenie: klient nie może zażądać innego (zużycie kredytów).
const THUMB = { image: 'c_fill,g_auto,h_160,w_160', video: 'c_fill,h_160,so_0,w_160' };
const mediaError = (status, error) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

async function handleMedia(request, env, url) {
  const m = MEDIA_PATH.exec(url.pathname);
  if (!m) return json({ error: 'not found' }, 404);
  const [, resource, tripId, id, format] = m;
  if (!FORMATS[resource].includes(format)) return json({ error: 'not found' }, 404);
  if (!env.MEDIA_TOKEN_SECRET) return json({ error: 'not configured' }, 500);

  // Token tylko w nagłówku (adresy trafiają do logów i historii), nigdy w zapytaniu URL.
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
  const verdict = await checkMediaToken(env, bearer && bearer[1], tripId);
  if (verdict === 'denied') return mediaError(401, 'unauthorized');
  if (verdict === 'other-trip') return mediaError(403, 'forbidden');

  if (!cloudinaryReady(env)) return mediaError(500, 'not configured');
  let transform = '';
  let outFormat = format;
  if (url.searchParams.get('thumb') === '1') {
    transform = THUMB[resource];
    if (resource === 'video') outFormat = 'jpg';
  }
  // Ścieżka składa się wyłącznie ze zwalidowanych części. Folder jest zawsze `wycieczka/<tripId>/`, tym samym
  // którego tokenu użyto, więc plik innej podróży jest nieosiągalny.
  const path = `${transform ? `${transform}/` : ''}wycieczka/${tripId}/${id}.${outFormat}`;
  const sig = `s--${b64url(await sha1Bytes(path + env.CLOUDINARY_API_SECRET)).slice(0, 8)}--`;
  const upstreamUrl = `https://res.cloudinary.com/${encodeURIComponent(env.CLOUDINARY_CLOUD)}/${resource}/authenticated/${sig}/${path}`;

  const headers = {};
  const range = request.headers.get('range');
  if (range && /^bytes=(\d+-\d*|-\d+)$/.test(range)) headers.range = range; // jeden prosty zakres
  let up;
  try {
    // redirect: 'manual' - odpowiedź z przekierowaniem (a z nią adres) nigdy nie trafia do klienta.
    up = await fetch(upstreamUrl, { method: request.method, headers, redirect: 'manual' });
  } catch {
    return mediaError(502, 'upstream');
  }
  if (up.status === 404) return mediaError(404, 'not found');
  if (![200, 206, 416].includes(up.status)) return mediaError(502, 'upstream');

  const out = new Headers({
    // Prywatne: bez współdzielonej pamięci podręcznej i bez zapisu na dysku. Dostęp zależy od tokenu.
    'cache-control': 'private, no-store',
    vary: 'Authorization',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'referrer-policy': 'no-referrer',
    'accept-ranges': 'bytes',
  });
  const type = up.headers.get('content-type') || '';
  out.set('content-type', SAFE_TYPE.test(type) ? type : 'application/octet-stream');
  for (const h of ['content-length', 'content-range']) {
    const v = up.headers.get(h);
    if (v) out.set(h, v);
  }
  // Treść jest przekazywana strumieniem, bez wczytywania do pamięci workera.
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}

// ---------- usuwanie pliku ----------
async function handleMediaDelete(request, env, url) {
  const m = /^\/media\/memory\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9]{1,64})$/.exec(url.pathname);
  if (!m) return json({ error: 'not found' }, 404);
  const [, tripId, memoryId] = m;
  const auth = await requireUser(request, env);
  if (!auth.user) return denied(auth);

  let memory, trip;
  try {
    // Metadane z dokumentu Firestore czytanego z tokenem użytkownika (reguły: tylko członek), nie od klienta.
    memory = await readDoc(env, auth.token, `trips/${tripId}/memories/${memoryId}`, ['publicId', 'resourceType', 'createdBy']);
    trip = memory && (await readDoc(env, auth.token, `trips/${tripId}`, ['createdBy']));
  } catch {
    return json({ error: 'upstream' }, 502);
  }
  if (!memory || !trip) return json({ error: 'forbidden' }, 403);
  const uid = auth.user.sub;
  if (uid !== field(memory, 'createdBy') && uid !== field(trip, 'createdBy')) return json({ error: 'forbidden' }, 403);

  if (!cloudinaryReady(env)) return json({ error: 'not configured' }, 500);
  const publicId = field(memory, 'publicId');
  const resource = field(memory, 'resourceType');
  if (!publicId || !Object.hasOwn(FORMATS, resource)) return json({ error: 'not a private media entry' }, 400);
  const mm = /^wycieczka\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{8,64})$/.exec(publicId);
  if (!mm || mm[1] !== tripId) return json({ error: 'forbidden' }, 403); // wpis wskazuje plik spoza tej podróży

  const params = { invalidate: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'authenticated' };
  const signature = await sha1Hex(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') + env.CLOUDINARY_API_SECRET);
  const form = new FormData();
  form.set('api_key', env.CLOUDINARY_API_KEY);
  form.set('signature', signature);
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD)}/${resource}/destroy`, { method: 'POST', body: form });
  } catch {
    return json({ error: 'upstream' }, 502);
  }
  const result = (await res.json().catch(() => ({}))).result;
  if (result !== 'ok' && result !== 'not found') return json({ error: 'upstream' }, 502);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/health') return json({ ok: true });
      if (pathname === '/sign' && request.method === 'POST') return await handleSign(request, env);
      if (pathname === '/media/token' && request.method === 'POST') return await handleMediaToken(request, env);
      if (pathname.startsWith('/media/memory/') && request.method === 'DELETE') return await handleMediaDelete(request, env, url);
      if (pathname.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) return await handleMedia(request, env, url);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  },
};
