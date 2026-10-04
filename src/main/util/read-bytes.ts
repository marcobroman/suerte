import { readFile } from 'node:fs/promises'

/**
 * Reads a file for the renderer's decoder. Returning the exact byte range matters:
 * a Node Buffer is often a view into a larger pooled ArrayBuffer, and handing that
 * view to structured clone would ship the pool along with the audio.
 */
export async function readAudioBytes(path: string): Promise<ArrayBuffer> {
  const buffer = await readFile(path)
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}
