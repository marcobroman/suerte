export function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`no element at index ${index}`)
  return value
}

export interface WavOptions {
  readonly sampleRate?: number
  readonly channels?: number
  readonly seconds?: number
  readonly frequencyHz?: number
}

/**
 * Builds a real 16-bit PCM WAV so parser-dependent tests exercise music-metadata
 * rather than a stub. A quiet sine is used rather than silence so the data chunk
 * is never degenerate.
 */
export function createWavBytes(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 8000
  const channels = options.channels ?? 1
  const seconds = options.seconds ?? 1
  const frequencyHz = options.frequencyHz ?? 440

  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const frameCount = Math.max(1, Math.round(sampleRate * seconds))
  const dataSize = frameCount * blockAlign

  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  let offset = 0
  const ascii = (text: string): void => {
    for (const char of text) view.setUint8(offset++, char.charCodeAt(0))
  }

  ascii('RIFF')
  view.setUint32(offset, 36 + dataSize, true); offset += 4
  ascii('WAVE')
  ascii('fmt ')
  view.setUint32(offset, 16, true); offset += 4
  view.setUint16(offset, 1, true); offset += 2 // PCM
  view.setUint16(offset, channels, true); offset += 2
  view.setUint32(offset, sampleRate, true); offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4
  view.setUint16(offset, blockAlign, true); offset += 2
  view.setUint16(offset, bytesPerSample * 8, true); offset += 2
  ascii('data')
  view.setUint32(offset, dataSize, true); offset += 4

  for (let frame = 0; frame < frameCount; frame++) {
    const amplitude = Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate) * 8000
    for (let channel = 0; channel < channels; channel++) {
      view.setInt16(offset, Math.round(amplitude), true)
      offset += bytesPerSample
    }
  }

  return bytes
}

/** A 1x1 PNG: small enough to embed in a fixture, but still a real decodable image. */
export function createPngBytes(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
}

export interface Id3Tags {
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly year?: number
  readonly trackNo?: number
}

export interface WavWithTagsOptions extends WavOptions {
  readonly tags?: Id3Tags
  readonly mime?: string
  readonly coverBytes?: Uint8Array
}

function uint32be(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}

function uint32le(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

/** ID3v2 sizes use seven bits per byte so tags never contain a false sync word. */
function syncsafe(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer[0] = (value >>> 21) & 0x7f
  buffer[1] = (value >>> 14) & 0x7f
  buffer[2] = (value >>> 7) & 0x7f
  buffer[3] = value & 0x7f
  return buffer
}

function id3Frame(id: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(id, 'latin1'),
    uint32be(payload.length),
    Buffer.from([0x00, 0x00]),
    payload
  ])
}

function id3Text(id: string, value: string): Buffer {
  // Leading 0x00 selects ISO-8859-1, which keeps the fixture bytes ASCII-only.
  return id3Frame(id, Buffer.concat([Buffer.from([0x00]), Buffer.from(value, 'latin1')]))
}

function id3Picture(mime: string, image: Buffer): Buffer {
  return id3Frame(
    'APIC',
    Buffer.concat([
      Buffer.from([0x00]), // ISO-8859-1 text encoding
      Buffer.from(mime, 'latin1'),
      Buffer.from([0x00]), // MIME terminator
      Buffer.from([0x03]), // picture type: cover (front)
      Buffer.from([0x00]), // empty description
      image
    ])
  )
}

/**
 * Builds a WAV carrying tags and artwork in an extra `id3 ` RIFF chunk, as an
 * ID3v2.3 tag. music-metadata reads both out of WAV this way, so scanner and cover
 * tests can assert against genuinely parsed metadata instead of a stub.
 */
export function createWavWithTagsBytes(options: WavWithTagsOptions = {}): Uint8Array {
  const tags = options.tags
  const frames: Buffer[] = []
  if (tags?.title !== undefined) frames.push(id3Text('TIT2', tags.title))
  if (tags?.artist !== undefined) frames.push(id3Text('TPE1', tags.artist))
  if (tags?.album !== undefined) frames.push(id3Text('TALB', tags.album))
  if (tags?.year !== undefined) frames.push(id3Text('TYER', String(tags.year)))
  if (tags?.trackNo !== undefined) frames.push(id3Text('TRCK', String(tags.trackNo)))
  if (options.coverBytes !== undefined) {
    frames.push(id3Picture(options.mime ?? 'image/png', Buffer.from(options.coverBytes)))
  }

  const wav = createWavBytes(options)
  if (frames.length === 0) return wav

  const body = Buffer.concat(frames)
  const tag = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]), // v2.3
    syncsafe(body.length),
    body
  ])
  const chunk = Buffer.concat([
    Buffer.from('id3 ', 'latin1'),
    uint32le(tag.length),
    tag
  ])

  const bytes = new Uint8Array(wav.length + chunk.length)
  bytes.set(wav, 0)
  bytes.set(chunk, wav.length)
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  return bytes
}
