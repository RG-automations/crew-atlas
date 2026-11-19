# Security model

Status of this document: 2026-11-17, written from the code in this repository and from the providers' public documentation read on that date. Items marked **open** are decisions or checks that are not done.

## Assets and who may do what

| Asset | Who may read | Who may write | Enforced by |
|---|---|---|---|
| `users/<uid>` (display name, FCM token) | the owner | the owner (only `name`, `fcmToken`) | Firestore rules |
| `trips/<id>` | members | create: any signed-in user (as sole member); leave: a member; join: with the invite code; delete: the creator | Firestore rules |
| Trip data (`places`, `memories`, `legs`, `stays`, `expenses`) | members | add: a member in their own name; delete: the author or the trip creator; no edits | Firestore rules |
| `locations/<uid>` | members | the owner only, server timestamp | Firestore rules |
| `sos/<id>` | members | create: a member in their own name, `active` can only be set to `false` by its author, no deletes | Firestore rules |
| Upload signature | trip members | - | Worker `/sign` (membership checked in Firestore with the caller's token) |
| Media files | trip members, through the Worker with a short token (new files). Existing public files stay public until migrated. | signed upload, `type=authenticated` only | Worker, Cloudinary |
| Map tiles | anyone holding the MapTiler key shipped in the APK | - | MapTiler quota only (see decision 1) |

Rules are tested in `rules-test/` on the Firestore emulator (33 scenarios). The Worker is tested in `worker/test.mjs` with mocked upstreams. Neither has been exercised against the real services from this repository.

## Decision 1 (implemented locally, not deployed): map delivery and the MapTiler terms

MapTiler Cloud terms (read 2026-11-17, https://www.maptiler.com/terms/cloud/):

- Clause 6.1: end users must make requests directly to MapTiler infrastructure. Using a customer proxy server is possible only on request, with MapTiler's approval and additional fees.
- Clause 7.2: storing or redistributing map content from a server-side cache is prohibited.
- Clause 5.7: a temporary personal cache on the end user's device is allowed.
- Clause 3.2: the service must be used with your own API key.
- Clause 1.2: the Free plan is limited to non-commercial use and R&D for commercial products.

The former Worker routes `/session` and `/m/*` proxied and cached every tile, which conflicts with 6.1 and 7.2. They are removed. The app now loads the style, tiles and geocoding directly from MapTiler with a key passed at build time (`MAPTILER_KEY`).

Consequences, checked against MapTiler's documentation (read 2026-11-17):

| Topic | State |
|---|---|
| Key exposure | The key is in the APK and in network traffic. It is a public client key. Never commit it, and rotate it if abused. |
| Restricting the key | MapTiler documents **allowed HTTP origins** (web) and an **allowed User-Agent substring**. App-id or bundle-id restrictions are not documented. Whether MapLibre Native's User-Agent can be matched reliably was **not tested**, so the restriction is not claimed as protection. |
| Quota | Free plan: 5k sessions and 100k API requests per month, no card (pricing page). When exceeded, the service pauses until the next month, nothing is billed. Worst case of a leaked key is therefore a paused map, not a bill. |
| Attribution | The app shows "(c) MapTiler (c) OpenStreetMap contributors". The pricing page lists a MapTiler logo on Free-plan maps, which the app does not draw itself. Whether the style adds it was **not checked** (open). |
| Rollout | Old apps (up to 0.5.1) call `/session`. Ship the new build first, deploy the Worker second, otherwise their maps break. |

## Decision 2 (implemented locally, not deployed): private media

A manual check on a real Cloudinary Free account (2026-11-17) showed that `authenticated` uploads, signed delivery URLs and signed transformations work there, and that unsigned and public-type URLs are refused. Media therefore move to Cloudinary's `authenticated` type behind a Cloudflare Worker gateway: the phone gets a short-lived token for one trip, never a Cloudinary URL. Full design, comparison with `private_download_url`, limits, migration plan and deployment order: **[private-media.md](private-media.md)**.

What remains open: the migration of existing public files (planned, not run), the 10-minute window in which a token issued before someone leaves a trip still works, EXIF metadata (not stripped, whether the Android image picker keeps location tags was not verified), and everything that was only tested with mocks.

## Other findings

| Topic | State |
|---|---|
| Open registration | See [Open registration and quota abuse](#open-registration-and-quota-abuse). |
| Invite codes | 6 characters from a 32-character alphabet (about 30 bits), readable by any signed-in user through `invites/<code>`, no rate limit. Joining also requires the code to match the trip. Acceptable for a private friends' app, weak for anything larger. |
| Photo metadata | New photos are stripped of EXIF before upload (see [private-media.md](private-media.md#photo-metadata-exif)). Older uploads are untouched and may carry GPS. Videos are not stripped. |
| Live location retention | The last position stays in Firestore until sharing is stopped. If a phone dies or the app is killed, the old position remains visible to members. No expiry is implemented. Rules require server timestamps, so the age of a position can be trusted. |
| Impersonation by name | A member can write any display name in their own location or SOS document. The uid is bound by the rules, the name is not. |
| App Check | Not used. Whether it fits sideloaded APKs was not evaluated. |
| Worker rate limiting | None. `/m/*` forwards any MapTiler path. |
| SOS delivery | Firestore listener only. Alerts older than 10 minutes are ignored by the client. Push when the app is closed is inactive. |
| Function `functions/` | Inactive, needs the paid Blaze plan. It reads FCM tokens with the Admin SDK, which bypasses rules. |

## Dependency advisories in `rules-test` (test tooling)

`npm audit` on the committed lockfile reported 38 findings (1 critical, 20 high). "Dev dependency" is not treated as proof of safety: the install step runs on developer machines and CI runners, and these packages execute there.

| Finding | Where it comes from | Reachable from our usage? |
|---|---|---|
| `tar` (critical): file overwrite through hardlinks or symlinks **when extracting** a hostile archive | `firebase-tools` 14 (direct `tar@6`) and `node-gyp` | `tar@6` is used by `archiveDirectory.js` to **pack** deploy bundles, not to extract. `emulators:exec --only firestore` does not call it. `node-gyp` extracts Node headers only when building the native `re2` module at install time. Not reachable in the test flow, but exploitable in principle through the supply chain at install time. |
| `@grpc/grpc-js`, `@firebase/firestore` (high) | the `firebase` client SDK used by the tests | The tests are a client talking to a local emulator. The advisories concern server-side behaviour and exposed error text. Not reachable. |
| `picomatch`, `re2`, `fdir`, `tinyglobby`, `node-gyp` (high, still open after the upgrade); `body-parser`, `zod`, `basic-ftp` and `tar` (gone after it) | transitive packages of `firebase-tools` | They concern glob/regex parsing of attacker-chosen patterns, hosting, deploy and install-time builds. We pass no untrusted input and run none of those features. Not reachable in the test flow. |

Action taken (local, tests re-run): `firebase-tools` 14 -> 15.36.0, `firebase` 11 -> 13.4.0, `@firebase/rules-unit-testing` 4 -> 6.0.0. Result: **critical 1 -> 0, high 20 -> 10, total 38 -> 24**, and all 28 rules tests of that date still passed on the emulator with Java 21. The remaining highs are the transitive ones above. `npm audit` offers no fix for them except a nonsensical downgrade of `firebase` to 9, which is ignored. Dependabot will track them. Previous `package.json` and lockfile are kept next to them as ignored `*.pre-fb15.bak` files.

Not covered: Dart/Flutter packages (`pub` has no audit command, a scan through an external service was not run without permission), and `functions/` (no lockfile, not installed).

## Open registration and quota abuse

Hiding `google-services.json` is not a defence: the same configuration is inside every APK, and anyone who gets it can talk to the project's Firebase APIs. What matters is what a stranger can do with an account, or even without one.

| Resource | Can a stranger consume it? | How | What limits it today |
|---|---|---|---|
| Firestore reads (50,000/day, shared by the whole group) | **Yes** | Any signed-in user may `get` `invites/<code>` and query their own trips, unlimited. A script can issue thousands. | Nothing: rules cannot rate-limit. Whether a request denied by rules still counts as a read is **not confirmed** (Google's pricing page documents extra reads for `exists()`/`get()` inside rules, forum answers disagree on denied requests). Check on your own usage dashboard. |
| Firestore writes (20,000/day) and storage (1 GiB) | **Yes** | Any account can create trips, invites, its own `users/<uid>` and any permitted entries in its own trips. | Rules limit what, not how often. |
| Cloudinary storage and bandwidth | **Yes, without an allowlist** | An account creates its own trip, becomes a member, gets `/sign` signatures (one per file, any number) and `/media/token`. | Allowed formats only. No per-request size limit, no rate limit. Account-level limits of the plan. |
| Worker requests (100,000/day) | Yes | Same calls. | None. |

With `ALLOWED_UIDS` set on the Worker (implemented, tested), the last three rows are closed: only listed accounts get signatures, tokens or deletions. The Firestore rows stay open.

Options without paid services, strongest first:

1. **Keep the Firebase configuration private** (done for the repository: it is git-ignored, and no APK is published) and **restrict the Firebase API key in Google Cloud Console** to your Android app (package and SHA-1) and to the APIs the app needs. Free. The restriction relies on request headers that a determined attacker can imitate, so it raises the effort, it does not remove the risk.
2. **Switch off self sign-up if the group is closed** (documented, details in [Closed group](#closed-group-firebase-authentication-and-app-check) below).
3. **Worker allowlist** (`ALLOWED_UIDS`): protects Cloudinary and the Worker today, needs each friend's uid after they sign in once.
4. **Custom claims** set with the Admin SDK from your own machine (free, no Cloud Functions), checked by the rules and the Worker: would close the Firestore rows too, but needs a service account key stored locally and a small admin script. Not built.
5. **Watch usage**: Firebase and Cloudinary usage pages, and rotate the Firebase project (new configuration) if abuse starts. Budget alerts are not available without a billing account.

What no free option does: rate-limit Firestore calls from someone who has the configuration. App Check is the tool built for that, and it does not fit this app today (see below).

Recommendation: do 1 now, rehearse 2 on a test project and then apply it, turn on 3 once everyone has signed in once, and treat the remaining Firestore exposure as a known limit of a free private prototype.

## Closed group: Firebase Authentication and App Check

### Disabling self sign-up

What Firebase documents (https://firebase.google.com/docs/auth/users, read 2026-11-17): by default users can create and delete their own accounts. Where administrators should create users, you can disable *user actions* on the Firebase Authentication Settings page (console: Security, Authentication, Settings, User actions), which "prevents account creation and deletion by end-users". Someone who then tries gets `auth/admin-restricted-operation` (Android: `ERROR_ADMIN_RESTRICTED_OPERATION`). Administrators create users with the Admin SDK or the console. The Firebase manage-users page also lists creating a password user in the console's Users tab.

What the documentation I found does **not** say: how the setting treats Google sign-in, whether the console's *Add user* still works afterwards, and whether the Identity Platform upgrade is needed. Treat those as unverified until you try them on the test project.

Expected behaviour to confirm there: existing accounts keep signing in with e-mail and with Google. New e-mail registrations fail with the error above. A Google account that has never signed in before probably fails the same way, because signing in creates the account. Users can no longer delete their own account (the app has no such feature).

Closed-group procedure:

1. On the **test project**: disable user actions. Try a new e-mail registration (the app now shows "Zakładanie nowych kont jest wyłączone..."), a first-time Google sign-in, and an existing account. Note the real results.
2. On production: first make sure everybody has signed in at least once (or enable sign-up temporarily and let each friend sign in, then disable it again).
3. Adding a friend later: enable user actions for the moment they register, or create an e-mail account for them in the console.
4. Then add their uid to `ALLOWED_UIDS` on the Worker if you use the allowlist.

Effect: closes account creation by strangers. It does not stop someone who already has an account, and it does not stop requests that need no account (rules deny them, but whether a denied request costs a read is not confirmed). Nothing here changes production until you do it.

### App Check with the Play Integrity provider

From https://firebase.google.com/docs/app-check/android/play-integrity-provider (read 2026-11-17):

| Question | Documented | For CrewAtlas |
|---|---|---|
| Apps installed outside Google Play | Supported, but by default App Check requires the `PLAY_RECOGNIZED` label, and "apps not published on Google Play are not eligible to receive this label". For apps only outside Google Play the page recommends turning off `PLAY_RECOGNIZED` and `LICENSED` and requiring the device integrity level. | CrewAtlas is sideloaded, so those two checks must be off. |
| Android 13 and newer | Users who did not install or update from Google Play cannot get the optional basic or strong integrity labels, so they may be denied if the device does not meet device integrity. | Some friends' phones (custom ROMs, rooted, no Play services) may be locked out. |
| Certificates | You must register the SHA-256 of the app's signing certificate. After enforcement only registered apps can use the backend. | This repository signs release builds with the **debug key**, which differs per machine. Every fork and every rebuild on another computer would be unregistered. |
| Setup | Link the Cloud project to the Play Integrity API **in the Play Console**, and be an Owner of the project. | Needs a Play Console account. Whether it is free is not stated on the page, and I believe Google Play charges a registration fee (not verified here), which collides with the zero-paid-services rule. |
| Spark plan and quotas | Not stated on that page. | Unknown from the documentation I read. |
| Token lifetime | 30 minutes to 7 days, default 1 hour, refreshed at about half. | Fine. |
| Debug and local testing | A debug provider exists for emulators and CI (details are in a separate guide, not read). | Would be needed for every developer build. |
| Enforcement | Per product. Review metrics first, because enforcing can break legitimate users. | Switching it on for Firestore would immediately block every phone that is not registered, including your current installs. |

Verdict: **do not adopt App Check now.** The conditions are not met: sideloaded installs only get partial eligibility, it needs a Play Console account of unverified cost, and enforcement would lock out current users and forks. If you later publish through Google Play (even an internal track), revisit it in stages: ship the SDK and watch the unenforced metrics, register the certificates, enforce Firestore last. App Check tokens would protect the Worker only if the Worker verified them too, which is not built.

## Not verified

Flutter Android build, Worker against the real Firestore REST API (`mask.fieldPaths` is used in the request), Worker against real Cloudinary signatures, Firebase console settings, Cloudinary Free plan capabilities, EXIF behaviour of uploads.
