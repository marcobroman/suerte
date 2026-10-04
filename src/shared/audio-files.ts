export const AUDIO_EXTENSIONS: readonly string[] = [
  '.mp3',
  '.flac',
  '.wav',
  '.wave',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.m4b',
  '.mp4',
  '.aac',
  '.aiff',
  '.aif',
  '.ape',
  '.wma',
  '.webm'
]

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return ''
  return path.slice(dot).toLowerCase()
}

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.includes(extensionOf(path))
}
