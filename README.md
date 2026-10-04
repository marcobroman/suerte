# Equalizer

Equalizer is a desktop music player and library app built with Electron, React, and TypeScript. It lets you scan local music folders, browse your collection by artist and album, search tracks, and play audio with a built-in Web Audio playback engine.

The project is organized around a local-first workflow: the app keeps a library index in the main process, exposes a narrow IPC surface to the renderer, and persists settings such as theme and Discogs token between launches.

## Features

- Multi-folder music library scanning for local audio files
- Artist and album browsing with track-level search and filtering
- Queue-based playback with play, pause, seek, skip, and repeat-like queue management
- Web Audio-based sound engine with volume and EQ settings support
- Album/cover art handling and Discogs metadata lookups
- Tag editing support for supported files
- Persistent app settings including library roots and theme
- Testing with Vitest and static checking with TypeScript ESLint

## Tech Stack

- Electron for desktop app shell and native integration
- React 19 for the renderer UI
- TypeScript for app and shared contracts
- Vite and electron-vite for build and dev workflow
- music-metadata and node-id3 for audio metadata and tag reading/writing

## Project Structure

```text
.
├── src/
│   ├── main/                 # Electron main process logic
│   │   ├── config.ts
│   │   ├── discogs.ts
│   │   ├── index.ts
│   │   ├── ipc.ts
│   │   └── library/
│   ├── preload/             # Secure preload bridge exposed to renderer
│   ├── renderer/            # React/UI code and playback engine
│   │   └── src/
│   ├── shared/              # Shared IPC and type definitions
│   └──
├── test/                    # Vitest test suite
├── electron-builder.yml     # Packaging configuration
├── electron.vite.config.ts  # Electron Vite config
├── eslint.config.mjs        # ESLint configuration
├── package.json             # Scripts and dependencies
├── tsconfig.json            # TypeScript baseline config
├── tsconfig.node.json       # Node-side TypeScript config
├── tsconfig.web.json        # Renderer-side TypeScript config
├── vitest.config.ts         # Test configuration
└── README.md                # Project overview and usage
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
npm run test
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
2. Choose one or more folders to index as your music library.
3. Let the scan populate the library.
4. Browse by artist or album, or use the search box to filter tracks.
5. Play tracks from the queue or open an album to queue its contents.
6. Adjust audio settings or theme in the app settings panel.
7. Optionally add a Discogs token to enrich metadata and cover art.

## Configuration and Persistence

The app stores small user preferences and chosen library roots in the Electron user data directory, so the library can be restored automatically on the next launch. Settings currently cover:

- selected music folders
- app theme
- Discogs token status

## Notes

This repository is actively structured around a local audio library workflow and includes substantial test coverage around scanning, cache behavior, metadata handling, and playback graph logic. It is best suited for desktop-based music listening and local collection management rather than streaming or cloud-based music services.
