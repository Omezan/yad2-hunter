'use client';

import { useEffect, useRef } from 'react';
import type { LastRun, StateResponse } from '../lib/types';

type Options = {
  /** ISO timestamp returned by the dispatch API; clears after we resolve. */
  dispatchedAt: string | null;
  /** Called when a fresh run is detected. */
  onComplete: (snapshot: { state: StateResponse; lastRun: NonNullable<LastRun> }) => void;
  /** Called when the watcher gives up. */
  onTimeout?: () => void;
  /** Poll interval in ms (default 10s). */
  intervalMs?: number;
  /** Total time to keep polling in ms (default 5 min). */
  timeoutMs?: number;
  /** Optional snapshot setter so callers can refresh their main view too. */
  onSnapshot?: (state: StateResponse) => void;
};

export function useCompletionWatcher({
  dispatchedAt,
  onComplete,
  onTimeout,
  intervalMs = 10_000,
  timeoutMs = 5 * 60_000,
  onSnapshot
}: Options): void {
  const onCompleteRef = useRef(onComplete);
  const onTimeoutRef = useRef(onTimeout);
  const onSnapshotRef = useRef(onSnapshot);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    if (!dispatchedAt) return;
    const dispatchedMs = Date.parse(dispatchedAt);
    if (Number.isNaN(dispatchedMs)) return;

    let cancelled = false;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as StateResponse;
        if (cancelled) return false;
        onSnapshotRef.current?.(json);
        const lastRun = json.lastRun;
        if (lastRun && lastRun.startedAt) {
          const lastStartedMs = Date.parse(lastRun.startedAt);
          if (!Number.isNaN(lastStartedMs) && lastStartedMs >= dispatchedMs) {
            onCompleteRef.current({ state: json, lastRun });
            return true;
          }
        }
      } catch {
        // swallow; we'll retry on the next interval
      }
      return false;
    };

    let timer: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      const done = await poll();
      if (cancelled) return;
      if (done) return;
      if (Date.now() - startedAt >= timeoutMs) {
        onTimeoutRef.current?.();
        return;
      }
      timer = window.setTimeout(tick, intervalMs);
    };

    tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [dispatchedAt, intervalMs, timeoutMs]);
}
