import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';

interface PollState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True once a poll has failed and the interval has started backing off. */
  stale: boolean;
}

interface PollResult<T> extends PollState<T> {
  refresh: () => void;
  setData: (updater: (previous: T | null) => T | null) => void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Polls an endpoint on an interval, with three behaviours the dashboard needs
 * to be usable on a phone in a waiting room:
 *   - polling pauses while the tab is hidden and resumes immediately on return,
 *     so a backgrounded dashboard does not drain battery or burn requests;
 *   - transient failures back off exponentially instead of hammering a
 *     struggling backend, while the last good data stays on screen;
 *   - in-flight requests are aborted on unmount or dependency change.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  options: { enabled?: boolean; deps?: readonly unknown[] } = {},
): PollResult<T> {
  const { enabled = true, deps = [] } = options;

  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    loading: enabled,
    stale: false,
  });

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const failuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  const setData = useCallback((updater: (previous: T | null) => T | null) => {
    setState((previous) => ({ ...previous, data: updater(previous.data) }));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({ ...previous, loading: false }));
      return;
    }

    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = () => {
      clearTimer();
      if (cancelled || document.hidden) return;
      const backoff = Math.min(intervalMs * 2 ** failuresRef.current, MAX_BACKOFF_MS);
      timerRef.current = setTimeout(run, failuresRef.current === 0 ? intervalMs : backoff);
    };

    const run = async () => {
      if (cancelled || document.hidden) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled || !mountedRef.current) return;
        failuresRef.current = 0;
        setState({ data: result, error: null, loading: false, stale: false });
      } catch (error) {
        if (cancelled || !mountedRef.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;

        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError(0, 'unknown_error', 'Something went wrong. Retrying…');

        // Auth failures are terminal: backing off would just delay the redirect
        // to the sign-in screen that the app is about to perform.
        if (apiError.status === 401 || apiError.status === 403) {
          setState((previous) => ({ ...previous, error: apiError, loading: false, stale: true }));
          return;
        }

        failuresRef.current += 1;
        setState((previous) => ({ ...previous, error: apiError, loading: false, stale: true }));
      } finally {
        if (!cancelled) schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        clearTimer();
      } else {
        failuresRef.current = 0;
        void run();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    void run();

    return () => {
      cancelled = true;
      clearTimer();
      abortRef.current?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, tick, ...deps]);

  return { ...state, refresh, setData };
}
