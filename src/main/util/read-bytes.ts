import { readFile, stat } from 'node:fs/promises'

/** Largest single file the renderer may pull into its decoder. */
export const MAX_READ_BYTES = 100 * 1024 * 1024

/**
 * Reads a file for the renderer's decoder. Returning the exact byte range matters:
 * a Node Buffer is often a view into a larger pooled ArrayBuffer, and handing that
 * view to structured clone would ship the pool along with the audio.
 */
export async function readAudioBytes(path: string): Promise<ArrayBuffer> {
  const stats = await stat(path)
  if (!stats.isFile() || stats.size > MAX_READ_BYTES) {
    throw new Error('unreadable file')
  }
  const buffer = await readFile(path)
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}
