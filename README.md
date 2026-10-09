# Onda

Onda is a desktop music player and library app built with Electron, React, and TypeScript. Scan local music folders, browse by artist and album, manage a playback queue, shape the sound with a 10-band graphic EQ, and fix up MP3 tags — by hand or automatically via Discogs.

The project follows a local-first workflow: the main process owns the library index and filesystem access, exposes a narrow typed IPC surface to the sandboxed renderer, and persists settings between launches.

## Features

- Multi-folder music library scanning with progress, cancellation, and change detection
- Artist and album browsing, global search across artists/albums/tracks, and album sorting (artist, title, year)
- Queue-based playback: play, pause, seek, next/previous, repeat (off/all/one) and shuffle modes, play-next/add-to-queue/remove, chronological Queue bottom sheet (toggled from the now-playing area) that auto-scrolls to the playing track
- 10-band graphic EQ with a draggable response curve, presets, preamp/bass/treble controls, and auto-preamp anti-clipping
- MP3 tag editing (title, artist, album, track number, year, cover art) with backup/write/verify/rollback safety
- Discogs auto-tag: search releases, preview the track mapping, and apply fields plus cover art in one step (needs a free personal token)
- Embedded cover-art display for albums, tracks, and the player bar
- Eight color themes with persisted selection
- Missing/unavailable folder warnings (removable drives are never auto-pruned)
- Keyboard: spacebar toggles play/pause outside of inputs and menus
- Optional LAN server: stream the library to a phone browser over HTTPS (self-signed certificate, fingerprint trust on first connect), with per-device tokens, single-use pairing codes, cookie sessions, byte-range seeking, and live library updates. Served payloads carry opaque track ids only — absolute paths and roots never leave the machine.
- Phone client: the same bundle boots in a mobile browser against the LAN server (QR pairing flow with device naming, plus legacy token entry), streaming playback through the shared EQ chain, with desktop-only actions hidden and no volume slider (hardware buttons own it)

## Tech Stack

- Electron for the desktop shell and native integration
- React 19 for the renderer UI
- TypeScript (strict) for app code and shared contracts
- Vite and electron-vite for the dev/build workflow
- music-metadata for tag reading, node-id3 for MP3 tag writing, qrcode for pairing codes, selfsigned for the server TLS certificate
- Vitest for tests, ESLint for linting, electron-builder for packaging

## Project Structure

```text
.
├── src/
│   ├── main/                 # Electron main process (library, tags, Discogs, server, IPC, config)
│   │   ├── cert.ts
│   │   ├── config.ts
│   │   ├── discogs.ts
│   │   ├── index.ts
│   │   ├── ipc.ts
│   │   ├── server.ts         # Optional LAN server (library/stream/cover/events/pair/session API, HTTPS)
│   │   └── library/          # scan, group, cache, covers, roots, tags
│   ├── preload/              # Secure bridge exposed to the renderer
│   ├── renderer/src/         # React UI, playback engines, Web Audio graph
│   │   ├── audio/            # buffer + stream engines, EQ DSP, settings, response math
│   │   ├── library/          # views, queue, search/sort, auto-tag, themes, phone boot
│   │   ├── backend.ts        # Backend seam (Electron bridge vs HTTP)
│   │   ├── http-backend.ts   # Phone backend over fetch/SSE
│   │   ├── usePlaybackEngine.ts / useStreamEngine.ts
│   │   └── shared/           # IPC contract and shared type definitions
├── test/                     # Vitest suite (mirrors src layout)
├── .github/workflows/        # Release CI (Windows installer, macOS DMGs)
├── electron-builder.yml      # Packaging configuration
├── electron.vite.config.ts   # Electron Vite config
├── eslint.config.mjs         # ESLint configuration
├── package.json              # Scripts and dependencies
├── tsconfig.json             # TypeScript baseline config
├── tsconfig.node.json        # Node-side TypeScript config
├── tsconfig.web.json         # Renderer-side TypeScript config
├── vitest.config.ts          # Test configuration
└── README.md                 # Project overview and usage
```

## Getting Started

### Prerequisites

- Node.js and npm installed on your machine

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

This starts the Electron app using electron-vite with the renderer in development mode.

### Type checking

```bash
npm run typecheck
```

### Run tests

```bash
npm test
```

### Lint the project

```bash
npm run lint
```

### Production build

```bash
npm run build
```

This runs type checks and then builds the Electron app for production.

### Windows installer

```bash
npm run dist
```

This builds `release/Onda Setup <version>.exe` via electron-builder — the file an end user installs; no npm needed on their machine. macOS builds (DMG, Apple Silicon + Intel) are produced by the release CI workflow, since Apple requires Mac hardware.

## Typical Usage

1. Launch the app.
2. Add one or more folders from Settings (gear icon, top right) and let the scan populate the library.
3. Browse by artist or album, use global search, or sort the album grid.
4. Click an album or track to play; use the ⋯ menus for play-next, add-to-queue, reveal-in-Explorer, or auto-tag.
5. Open the equalizer from the sliders button in the player bar; drag nodes on the curve or pick a preset.
6. Paste a Discogs personal token in Settings to enable auto-tag with cover art.
7. Switch themes from Settings; everything persists across launches.
8. To play on a phone on the same Wi-Fi: enable “Serve library on the local network” in Settings, then use the QR code (or copy-link) button under the home-network address and name the device on the phone. The phone gets its own access token and an encrypted TLS connection — confirm the certificate fingerprint shown in Settings on first connect. The phone client streams through the shared EQ chain; desktop-only actions stay hidden.

## Remote access from anywhere (Tailscale)

The server binds all interfaces, so joining a private tailnet is enough for secure remote streaming with no open ports:

1. Install Tailscale on the PC and the phone, logging into the same account on both.
2. In Onda Settings, enable serving and pick the `https://100.x.x.x:…` address from the listed URLs (the tailnet one, not the home-LAN one).
3. Pair with the QR code as above; the browser warns about the self-signed certificate once — compare its fingerprint to Settings, then trust it. The boot screen shows the expected fingerprint and stays locked until you confirm the match.

Revoking a device in Settings logs that phone out immediately — including its open event streams; rotating the access token logs out every phone; rotating the certificate only asks phones to confirm the new fingerprint once (the boot link carries the expected fingerprint, and the phone refuses a changed server identity until re-paired knowingly). Each listed address has its own QR / copy-link buttons so remote pairing uses the tailnet URL; hiding a QR, generating a new code, or closing Settings kills its pairing code immediately (quitting the app wipes all outstanding codes). When the machine's addresses outgrow the certificate, Settings says so with a one-click server restart.

## Configuration and Persistence

Small preferences and library roots live in `library.json` inside the Electron user data directory, so the library restores automatically on the next launch. Persisted settings currently cover:

- selected music folders
- app theme
- Discogs token presence (the token itself never leaves the main process)
- equalizer curve (master volume stays session-only)
- LAN server settings (enabled, port, access token, login sessions, paired devices)
- TLS certificate (`server-cert.pem` / `server-key.pem` beside `library.json`, generated on first enable)

## Notes

- Tag writing supports MP3 files only; other formats open as read-only in tag flows.
- Auto-tag needs network access and a Discogs token; cover art embeds JPEG/PNG only.
- The server speaks HTTPS with a self-signed certificate (generated on first enable) once a certificate exists, and stays stopped otherwise unless unencrypted fallback is explicitly allowed in Settings. The certificate names the machine's LAN and tailnet addresses and renews automatically when they change. Phones authenticate with per-device tokens traded for an `HttpOnly` (`Secure` over TLS) session cookie, so tokens stay out of URLs; the phone verifies the server fingerprint before sending any credential and refuses a changed identity until re-paired knowingly. The master token never leaves the desktop — pairing codes are single-use, expire after 10 minutes, and die when their QR is hidden or the app quits. Sessions expire after 7 days (24 idle hours) and devices after 180 days (90 idle); expiry is silent while the device is valid, otherwise the phone returns to pairing with an explanation, and a Log-out button ends the pairing on demand. Handshake endpoints are per-IP rate-limited, event subscribers are capped, and all responses carry `nosniff` / `no-referrer` / same-origin hardening headers (plus HSTS over TLS).
- The suite is a local audio library workflow: substantial test coverage exists around scanning, cache behavior, metadata handling, queue/engine logic, streaming server, TLS/pairing/session auth, and EQ math. The phone client reuses the desktop UI over the LAN API; PWA offline support is future work.
