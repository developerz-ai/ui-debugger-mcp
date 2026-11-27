/**
 * Make a wait abortable — raced against an `AbortSignal`, rejecting with an
 * `AbortError`-named {@link DOMException} (the contract's `WaitOptions.signal` shape).
 * The listener is removed on every path.
 */
export async function abortable<T>(
  signal: AbortSignal | undefined,
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new DOMException(message, 'AbortError');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException(message, 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(), aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
