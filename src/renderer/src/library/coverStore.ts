import { createContext, useContext } from 'react'
import { CoverStore } from './covers'

/** Reads artwork through the preload bridge, which proxies the main-process cache. */
export const coverStore = new CoverStore((path) => window.equalizer.readCover(path))

/**
 * Cover source for the tree. It defaults to the Electron singleton so existing
 * consumers work untouched; App provides a backend-bound store instead, which
 * is what lets a streaming backend serve covers without code changes downstream.
 */
export const CoverStoreContext = createContext<CoverStore>(coverStore)

export function useCoverStore(): CoverStore {
  return useContext(CoverStoreContext)
}
