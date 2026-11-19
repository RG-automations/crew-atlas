# Setup: run CrewAtlas on your own backend

You need your own free accounts. Nothing here requires a payment card on the plans mentioned, but check each provider's current terms: MapTiler Free is for non-commercial use only.

Requirements: Flutter 3.47.x (Dart ^3.13.5), Android SDK, Node 22 and Java 21 (only for the rules tests).

## 1. Firebase (Spark plan)

1. Create a project and add an Android app with package name `pl.wycieczka.wycieczka` (the historical id, kept in this repository). If you change `applicationId` and `namespace` in `android/app/build.gradle.kts`, also move `android/app/src/main/kotlin/...`.
2. Authentication: enable **Email/Password** and **Google**.
3. Add the SHA-1 of your signing key (debug builds: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`). Note that release builds in this repository are signed with the debug key.
4. Download `google-services.json` into `android/app/`. The file is git-ignored. `google-services.json.example` shows the expected structure.
5. Firestore: create a database and publish `firestore.rules` (console, or `firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID`).
6. Do not enable Storage. Media go to Cloudinary.

## 2. Cloudinary (Free)

Create an account. Note the cloud name, API key and API secret. No upload preset is needed because uploads are signed by the Worker, and all files are uploaded as private (`authenticated`). Before relying on it, run `worker/cloudinary-privacy-check.mjs` against your account (see `worker/README.md`): it confirms that your account really refuses unsigned access.

## 3. MapTiler (Free)

Create a key. The app calls MapTiler directly (style, tiles, geocoding), so the key is shipped inside the APK and is effectively public. In the MapTiler dashboard, set an **Allowed User-Agent** restriction for your build and rotate the key if it leaks. MapTiler documents restrictions by HTTP origin (web) and by User-Agent, not by Android app id. Whether MapLibre's native User-Agent can be matched reliably was not tested. On the Free plan an exhausted quota pauses maps until the next month, nothing is billed. Free is for non-commercial use only.

## 4. Cloudflare Worker (Free)

Follow [worker/README.md](../worker/README.md). Secrets (`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `MEDIA_TOKEN_SECRET`, the last one a long random value) are stored as Cloudflare Secrets. Variables: `CLOUDINARY_CLOUD`, `FIREBASE_PROJECT_ID`.

## 5. Run

```bash
cp config.example.json config.local.json   # set WORKER_URL and MAPTILER_KEY
flutter pub get
flutter run --dart-define-from-file=config.local.json
```

## 6. Verify

```bash
flutter analyze && flutter test
node worker/test.mjs
node worker/media.test.mjs
cd rules-test && npm ci && npm test
```
