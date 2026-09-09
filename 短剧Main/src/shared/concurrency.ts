export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      results[index] = await mapper(value as T, index);
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), values.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
