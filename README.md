# Suerte

Suerte is a desktop music player and library app built with Electron, React, and TypeScript. Scan local music folders, browse by artist and album, manage a playback queue, shape the sound with a 10-band graphic EQ, and fix up MP3 tags — by hand or automatically via Discogs.

The project follows a local-first workflow: the main process owns the library index and filesystem access, exposes a narrow typed IPC surface to the sandboxed renderer, and persists settings between launches.

## Features

- Multi-folder music library scanning with progress, cancellation, and change detection
- Artist and album browsing, global search across artists/albums/tracks, and album sorting (artist, title, year)
- Queue-based playback: play, pause, seek, next/previous, play-next/add-to-queue/remove, collapsible Up-next panel
- 10-band graphic EQ with a draggable response curve, presets, preamp/bass/treble controls, and auto-preamp anti-clipping
- MP3 tag editing (title, artist, album, track number, year, cover art) with backup/write/verify/rollback safety
- Discogs auto-tag: search releases, preview the track mapping, and apply fields plus cover art in one step (needs a free personal token)
- Embedded cover-art display for albums, tracks, and the player bar
- Eight color themes with persisted selection
- Missing/unavailable folder warnings (removable drives are never auto-pruned)
- Keyboard: spacebar toggles play/pause outside of inputs and menus

## Tech Stack

- Electron for the desktop shell and native integration
- React 19 for the renderer UI
- TypeScript (strict) for app code and shared contracts
- Vite and electron-vite for the dev/build workflow
- music-metadata for tag reading, node-id3 for MP3 tag writing
- Vitest for tests, ESLint for linting, electron-builder for packaging

## Project Structure

```text
.
├── src/
│   ├── main/                 # Electron main process (library, tags, Discogs, IPC, config)
│   │   ├── config.ts
│   │   ├── discogs.ts
│   │   ├── index.ts
│   │   ├── ipc.ts
│   │   └── library/          # scan, group, cache, covers, roots, tags
│   ├── preload/              # Secure bridge exposed to the renderer
│   ├── renderer/src/         # React UI, playback engine, Web Audio graph
│   │   ├── audio/            # engine, EQ DSP, settings, response math
│   │   └── library/          # views, queue, search/sort, auto-tag, themes
│   └── shared/               # IPC contract and shared type definitions
├── test/                     # Vitest suite (mirrors src layout)
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

## Typical Usage

1. Launch the app.
2. Add one or more folders from Settings (gear icon, top right) and let the scan populate the library.
3. Browse by artist or album, use global search, or sort the album grid.
4. Click an album or track to play; use the ⋯ menus for play-next, add-to-queue, reveal-in-Explorer, or auto-tag.
5. Open the equalizer from the sliders button in the player bar; drag nodes on the curve or pick a preset.
6. Paste a Discogs personal token in Settings to enable auto-tag with cover art.
7. Switch themes from Settings; everything persists across launches.

## Configuration and Persistence

Small preferences and library roots live in `library.json` inside the Electron user data directory, so the library restores automatically on the next launch. Persisted settings currently cover:

- selected music folders
- app theme
- Discogs token presence (the token itself never leaves the main process)
- equalizer curve (master volume stays session-only)

## Notes

- Tag writing supports MP3 files only; other formats open as read-only in tag flows.
- Auto-tag needs network access and a Discogs token; cover art embeds JPEG/PNG only.
- The suite is a local audio library workflow: substantial test coverage exists around scanning, cache behavior, metadata handling, queue/engine logic, and EQ math. It is built for desktop listening and collection management, not streaming.
