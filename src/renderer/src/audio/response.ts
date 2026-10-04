import { BANDS, BAND_Q, BASS_SHELF_HZ, SHELF_Q, TREBLE_SHELF_HZ } from './bands'

export type FilterKind = 'peaking' | 'lowshelf' | 'highshelf'

export interface Coefficients {
  readonly b0: number
  readonly b1: number
  readonly b2: number
  readonly a1: number
  readonly a2: number
}

export interface FilterSpec {
  readonly kind: FilterKind
  readonly frequencyHz: number
  readonly gainDb: number
  readonly q: number
}

export interface EqCurveParams {
  readonly sampleRate: number
  readonly filters: readonly FilterSpec[]
}

/**
 * RBJ audio-EQ-cookbook biquad, with a0 normalised away so the denominator is
 * `1 + a1 z^-1 + a2 z^-2`. w0 is clamped into (0, pi) so an out-of-range centre
 * frequency yields a stable filter rather than garbage.
 */
export function designBiquad(
  kind: FilterKind,
  sampleRate: number,
  frequencyHz: number,
  q: number,
  gainDb: number
): Coefficients {
  const rawW0 = (2 * Math.PI * frequencyHz) / sampleRate
  const w0 = Math.min(Math.max(rawW0, 1e-6), Math.PI - 1e-6)
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const a = Math.pow(10, gainDb / 40)
  const sqrtA = Math.sqrt(a)

  let b0: number
  let b1: number
  let b2: number
  let a0: number
  let a1: number
  let a2: number

  if (kind === 'peaking') {
    const alpha = sinW0 / (2 * q)
    b0 = 1 + alpha * a
    b1 = -2 * cosW0
    b2 = 1 - alpha * a
    a0 = 1 + alpha / a
    a1 = -2 * cosW0
    a2 = 1 - alpha / a
  } else {
    const alpha = (sinW0 / 2) * Math.sqrt((a + 1 / a) * (q - 1) + 2)
    if (kind === 'lowshelf') {
      b0 = a * (a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = 2 * a * (a - 1 - (a + 1) * cosW0)
      b2 = a * (a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = -2 * (a - 1 + (a + 1) * cosW0)
      a2 = a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha
    } else {
      b0 = a * (a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = -2 * a * (a - 1 + (a + 1) * cosW0)
      b2 = a * (a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = 2 * (a - 1 - (a + 1) * cosW0)
      a2 = a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha
    }
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/**
 * Magnitude of a designed biquad at an arbitrary frequency, in dB. Passing 0 Hz
 * evaluates at DC, which is how the shelf endpoints are checked.
 */
export function magnitudeDbAt(
  coefficients: Coefficients,
  sampleRate: number,
  frequencyHz: number
): number {
  const w = (2 * Math.PI * frequencyHz) / sampleRate
  const cosW = Math.cos(w)
  const sinW = Math.sin(w)
  const cos2W = Math.cos(2 * w)
  const sin2W = Math.sin(2 * w)

  const numReal = coefficients.b0 + coefficients.b1 * cosW + coefficients.b2 * cos2W
  const numImag = -(coefficients.b1 * sinW + coefficients.b2 * sin2W)
  const denReal = 1 + coefficients.a1 * cosW + coefficients.a2 * cos2W
  const denImag = -(coefficients.a1 * sinW + coefficients.a2 * sin2W)

  const numerator = Math.hypot(numReal, numImag)
  const denominator = Math.hypot(denReal, denImag)

  if (denominator === 0) return Number.POSITIVE_INFINITY
  if (numerator === 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(numerator / denominator)
}

/** Zero-gain filters are dropped: they are exactly unity and only cost time. */
export function designEq(params: EqCurveParams): Coefficients[] {
  const coefficients: Coefficients[] = []
  for (const filter of params.filters) {
    if (filter.gainDb === 0) continue
    coefficients.push(
      designBiquad(filter.kind, params.sampleRate, filter.frequencyHz, filter.q, filter.gainDb)
    )
  }
  return coefficients
}

/**
 * Response of the whole cascade. dB magnitudes add across a serial chain of
 * filters, so summing per-filter dB is the combined curve.
 */
export function responseCurveDb(
  params: EqCurveParams,
  frequencies: readonly number[]
): number[] {
  const coefficients = designEq(params)
  return frequencies.map((frequencyHz) => {
    let sumDb = 0
    for (const c of coefficients) {
      sumDb += magnitudeDbAt(c, params.sampleRate, frequencyHz)
    }
    return sumDb
  })
}

export function defaultEqParams(
  sampleRate: number,
  bandGainsDb: readonly number[],
  bassDb: number,
  trebleDb: number
): EqCurveParams {
  const filters: FilterSpec[] = []
  for (const band of BANDS) {
    const gainDb = bandGainsDb[band.index]
    if (gainDb === undefined || gainDb === 0) continue
    filters.push({ kind: 'peaking', frequencyHz: band.frequencyHz, gainDb, q: BAND_Q })
  }
  if (bassDb !== 0) {
    filters.push({ kind: 'lowshelf', frequencyHz: BASS_SHELF_HZ, gainDb: bassDb, q: SHELF_Q })
  }
  if (trebleDb !== 0) {
    filters.push({ kind: 'highshelf', frequencyHz: TREBLE_SHELF_HZ, gainDb: trebleDb, q: SHELF_Q })
  }
  return { sampleRate, filters }
}
