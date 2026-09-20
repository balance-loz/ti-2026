"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type PolledState<T> = {
  data: T | null;
  error: string | null;
  reload: () => void;
};

/**
 * Load a resource on mount and re-load it on an interval.
 *
 * The in-flight request is aborted on unmount and the result of a stale request
 * is discarded, so a slow response can never overwrite a newer one.
 */
export function usePolled<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number, key: string = ""): PolledState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  // Callers pass a memoized loader, so depending on it directly is stable.
  const run = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current;
    try {
      const result = await load(signal ?? new AbortController().signal);
      // A slower earlier request must never overwrite a newer result.
      if (mine !== generation.current || signal?.aborted) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (mine !== generation.current || (cause as Error)?.name === "AbortError") return;
      setError(String((cause as Error)?.message ?? cause));
    }
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- run() is async and every setState in it happens after an await, so nothing is set during this effect. Fetching on mount is exactly what an effect is for.
    run(controller.signal);
    const timer = setInterval(() => run(), intervalMs);
    return () => { controller.abort(); clearInterval(timer); };
  }, [run, intervalMs, key]);

  return { data, error, reload: () => run() };
}

// The path is browser state that exists before React hydrates, so it is read
// through a store rather than copied into component state inside an effect.
const pathListeners = new Set<() => void>();
const subscribePath = (onChange: () => void) => {
  pathListeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => { pathListeners.delete(onChange); window.removeEventListener("popstate", onChange); };
};

/** Last path segment of the current URL, decoded. Empty string on the server. */
export function useLastPathSegment(): string {
  return useSyncExternalStore(
    subscribePath,
    () => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] ?? "");
    },
    () => "",
  );
}
