import { useCallback, useEffect, useMemo, useState } from "react";

interface Settled<T> {
  source: object;
  data: T | null;
  error: string | null;
}

export interface AsyncData<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data for the current `fetcher` and cancels the request when it changes or the
 * component unmounts.
 *
 * "Loading" is derived by comparing which request the stored result belongs to, rather than
 * held as its own state. That keeps every setState inside a promise callback, so no render
 * is triggered synchronously from the effect body. The last successful data stays on screen
 * while a new request is in flight, which avoids the list blanking out on every filter
 * change.
 *
 * `fetcher` and `toMessage` must be stable — wrap the fetcher in useCallback and define
 * toMessage at module scope.
 */
export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  toMessage: (error: unknown) => string,
): AsyncData<T> {
  const [reloadToken, setReloadToken] = useState(0);
  const source = useMemo(() => ({ fetcher, reloadToken }), [fetcher, reloadToken]);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    source.fetcher(controller.signal).then(
      (data) => setSettled({ source, data, error: null }),
      (caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setSettled({ source, data: null, error: toMessage(caught) });
      },
    );

    return () => controller.abort();
  }, [source, toMessage]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  const isFresh = settled?.source === source;

  return {
    data: settled?.data ?? null,
    error: isFresh ? (settled?.error ?? null) : null,
    loading: !isFresh,
    reload,
  };
}
