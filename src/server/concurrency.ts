/**
 * Bounded parallelism for provider fan-out.
 *
 * A wallet with hundreds of tokens must not turn into hundreds of simultaneous
 * upstream requests: that is how a client gets itself rate-limited, and how one
 * portfolio load starves every other in-flight request. Every fan-out in
 * Nuxfolio goes through here with an explicit limit.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer: ${limit}`);
  }
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // `index` is bounded by items.length, so the element is present.
      results[index] = await worker(items[index] as TInput, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Splits a list into fixed-size chunks, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`Chunk size must be a positive integer: ${size}`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
