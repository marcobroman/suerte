import { CoverStore } from './covers'

/** Reads artwork through the preload bridge, which proxies the main-process cache. */
export const coverStore = new CoverStore((path) => window.equalizer.readCover(path))
