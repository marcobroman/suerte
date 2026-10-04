import type { PreloadApi } from '@shared/ipc'

declare global {
  interface Window {
    equalizer: PreloadApi
  }
}

export {}
