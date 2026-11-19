# Security policy

CrewAtlas is a private prototype published for study. There is no production service, no bug bounty and no response-time guarantee.

## Reporting a vulnerability

Please do not open a public issue with exploit details.

- Use GitHub's private vulnerability reporting (repository **Security** tab, **Report a vulnerability**) once it is enabled for this repository.
- If it is not available, open an issue that only asks for a private contact channel and contains no technical details.

## What helps

A description of the impact, the affected file or endpoint, and steps to reproduce against your own Firebase, Cloudflare and Cloudinary setup. Please do not test against anyone else's deployment.

## Scope

In scope: `firestore.rules`, `worker/worker.js`, the Flutter app and the CI workflow.

Out of scope: the availability of third-party services (Firebase, Cloudflare, Cloudinary, MapTiler, NBP), and the SOS feature as a safety guarantee. It is explicitly not one, see the README.

## Secrets

No real secret may be committed. If you find one in the history, report it privately, without pasting the value. Cloudinary and MapTiler secrets belong in Cloudflare Secrets, CI secrets in GitHub Actions Secrets. Firebase client configuration (`google-services.json`) is not a server secret but is deliberately not published.

Known gaps and open decisions are tracked in [docs/security-model.md](docs/security-model.md).
