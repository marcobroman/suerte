/**
 * Maps over `items` with at most `limit` calls to `worker` in flight, preserving
 * input order in the result. Used to keep tag parsing from opening thousands of
 * file handles at once during a library scan.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results

  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0

  async function run(): Promise<void> {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()))
  return results
}
