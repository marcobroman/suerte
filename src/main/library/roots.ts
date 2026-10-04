import { stat } from 'node:fs/promises'
import { mapLimit } from '../util/map-limit'

/**
 * Roots that cannot be reached. A missing root is not removed from the config on
 * purpose: on a removable drive the folder reappears when it is plugged back in, and
 * the caller's next scan repopulates the library.
 */
export async function findMissingRoots(roots: readonly string[]): Promise<string[]> {
  const checks = await mapLimit(roots, 8, async (path) => {
    try {
      const stats = await stat(path)
      return stats.isFile() || stats.isDirectory() ? null : path
    } catch {
      return path
    }
  })
  return checks.filter((path): path is string => path !== null)
}