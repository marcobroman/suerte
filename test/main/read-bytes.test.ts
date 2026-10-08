import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_READ_BYTES, readAudioBytes } from '@main/util/read-bytes'

describe('readAudioBytes', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'read-bytes-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the exact bytes without the buffer pool', async () => {
    const path = join(dir, 'a.bin')
    await writeFile(path, Buffer.from([1, 2, 3, 4]))

    const result = await readAudioBytes(path)

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('refuses oversized files instead of loading them', async () => {
    const path = join(dir, 'big.bin')
    await writeFile(path, Buffer.alloc(MAX_READ_BYTES + 1, 9))

    await expect(readAudioBytes(path)).rejects.toThrow()
  })

  it('refuses missing files', async () => {
    await expect(readAudioBytes(join(dir, 'gone.bin'))).rejects.toThrow()
  })
})
