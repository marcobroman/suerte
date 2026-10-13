import { createHash } from 'node:crypto'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

/**
 * True when the requested path is a library root itself or lives under one.
 * relative() collapses `..` lexically, so anything escaping a root starts
 * with `..` (or resolves absolute on another drive) and is rejected.
 * Case folds on Windows, where the filesystem itself is case-insensitive.
 */
export function insideRoots(roots: readonly string[], candidate: string): boolean {
  const fold = process.platform === 'win32'
  const normalized = fold ? normalize(candidate).toLowerCase() : normalize(candidate)
  for (const root of roots) {
    const base = fold ? normalize(root).toLowerCase() : root
    const rel = relative(base, normalized)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * Opaque track id: a one-way hash of the absolute path. Deterministic, so it
 * survives rescans and restarts, and irreversible, so absolute paths (drives,
 * usernames, folder layout) never leave the machine. Remote clients use ids
 * everywhere local code uses paths.
 */
export function trackId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/** Pinned inside the client dir: `..` collapses lexically, so escapes fail the prefix check. Exported for tests. */
export function clientPathIn(clientDir: string, requestPath: string): string | null {
  // resolve() absolutizes and normalizes both sides alike, so a relative base
  // and mixed separators compare correctly on every platform.
  const base = resolve(clientDir)
  const resolved = resolve(base, `.${requestPath}`)
  // The separator-joined prefix keeps a sibling like `<dir>-other` out.
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) return null
  return resolved
}
