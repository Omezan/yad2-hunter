'use client';

import { useCallback, useEffect, useState } from 'react';

export type TriggerStatus = 'idle' | 'pending' | 'success' | 'error';

export type TriggerState = {
  status: TriggerStatus;
  message: string | null;
  cooldownSecondsLeft: number;
  isDisabled: boolean;
  dispatchedAt: string | null;
  trigger: () => Promise<void>;
};

type Options = {
  /** Path to the trigger API route, e.g. `/api/trigger/scan` */
  endpoint: string;
  /** Cooldown in milliseconds after a successful dispatch (default 60s) */
  cooldownMs?: number;
  /** Optional callback fired with the dispatchedAt timestamp on success */
  onDispatched?: (dispatchedAt: string) => void;
};

type ApiResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  dispatchedAt?: string;
};

export function useTriggerWorkflow({
  endpoint,
  cooldownMs = 60_000,
  onDispatched
}: Options): TriggerState {
  const [status, setStatus] = useState<TriggerStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const [dispatchedAt, setDispatchedAt] = useState<string | null>(null);

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil, now]);

  const trigger = useCallback(async () => {
    if (status === 'pending') return;
    if (cooldownUntil > Date.now()) return;
    setStatus('pending');
    setMessage('מפעיל…');
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      const json = (await res.json().catch(() => ({}))) as ApiResponse;
      if (res.ok && json.ok) {
        setStatus('success');
        setMessage(json.message || 'הופעל. תוצאות יופיעו תוך כ-3 דקות.');
        setCooldownUntil(Date.now() + cooldownMs);
        if (json.dispatchedAt) {
          setDispatchedAt(json.dispatchedAt);
          onDispatched?.(json.dispatchedAt);
        }
      } else {
        setStatus('error');
        setMessage(json.error || `שגיאה (${res.status})`);
      }
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [cooldownMs, cooldownUntil, endpoint, onDispatched, status]);

  const cooldownSecondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const isDisabled = status === 'pending' || cooldownSecondsLeft > 0;

  return {
    status,
    message,
    cooldownSecondsLeft,
    isDisabled,
    dispatchedAt,
    trigger
  };
}
