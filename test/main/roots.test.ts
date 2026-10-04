import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findMissingRoots } from '@main/library/roots'

describe('findMissingRoots', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roots-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports nothing when every root exists', async () => {
    const sub = join(dir, 'music')
    await mkdir(sub)

    expect(await findMissingRoots([dir, sub])).toEqual([])
  })

  it('reports a root that does not exist', async () => {
    expect(await findMissingRoots([join(dir, 'gone')])).toEqual([join(dir, 'gone')])
  })

  it('keeps the original order', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    await mkdir(a)
    await mkdir(b)

    expect(await findMissingRoots([b, join(dir, 'x'), a])).toEqual([join(dir, 'x')])
  })

  it('accepts a file as a root', async () => {
    const file = join(dir, 'track.wav')
    await writeFile(file, 'x')

    expect(await findMissingRoots([file])).toEqual([])
  })

  it('reports every missing root', async () => {
    expect(await findMissingRoots([join(dir, 'x'), join(dir, 'y')])).toHaveLength(2)
  })

  it('returns nothing for an empty list', async () => {
    expect(await findMissingRoots([])).toEqual([])
  })

  it('handles a large list without dropping entries', async () => {
    const roots = Array.from({ length: 50 }, (_, index) => join(dir, `missing-${index}`))

    expect(await findMissingRoots(roots)).toHaveLength(50)
  })
})