/**
 * SSE streaming hook for pipeline events — see routes/pipeline.ts
 * `GET /api/pipeline/:id` and @agent_docs/api-spec.md "Pipeline".
 *
 * Auto-reconnect with exponential backoff, event buffering,
 * and reconnection status tracking. If the SSE connection drops, the hook
 * automatically reconnects (1s → 2s → 4s → 8s → 16s → 30s cap, max 10 attempts)
 * and provides reconnection status (`reconnecting`, `reconnectStatus`, `reconnectAttempt`).
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import type { ProjectFile } from '@bicameral/shared/types';

export interface PipelineEvent {
  type:
    | 'pipeline:context'
    | 'step:start'
    | 'step:progress'
    | 'step:complete'
    | 'gate:awaiting_approval'
    | 'iteration:complete'
    | 'pipeline:complete'
    | 'error';
  step?: number;
  agent?: string;
  model?: string;
  progress?: number;
  message?: string;
  output?: unknown;
  error?: string;
  iteration?: number;
  errors?: number;
  fixed?: boolean;
  deploymentUrl?: string | null;
  files?: ProjectFile[];
  /** `pipeline:context` only — the project the run belongs to, which is what
   * addresses its preview container. */
  projectId?: string | null;
  /** `pipeline:context` only — when the run began, from `pipeline_runs`. The
   * header's elapsed clock reads this rather than the moment the component
   * mounted, so a reload does not restart it at zero. */
  startedAt?: string | null;
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_ATTEMPTS = 10;

export function useGenerationStream(url: string | null) {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnectStatus, setReconnectStatus] =
    useState<ConnectionStatus>('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectAttemptRef = useRef(0);
  const urlRef = useRef(url);
  const manuallyClosedRef = useRef(false);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!urlRef.current || manuallyClosedRef.current) {
      setConnected(false);
      setReconnectStatus('disconnected');
      return;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    const source = new EventSource(urlRef.current, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      setConnected(true);
      setReconnectStatus('connected');
      setReconnectAttempt(0);
      reconnectAttemptRef.current = 0;
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
    };

    source.onmessage = (message) => {
      if (message.data === '[DONE]') {
        manuallyClosedRef.current = true;
        source.close();
        sourceRef.current = null;
        setConnected(false);
        setReconnectStatus('disconnected');
        return;
      }
      try {
        const parsed = JSON.parse(message.data) as PipelineEvent;
        setEvents((prev) => [...prev, parsed]);
      } catch {
        // ignore parse errors
      }
    };

    source.onerror = () => {
      setConnected(false);
      source.close();
      sourceRef.current = null;

      if (manuallyClosedRef.current) {
        setReconnectStatus('disconnected');
        return;
      }

      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setReconnectStatus('disconnected');
        return;
      }

      const nextAttempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = nextAttempt;
      setReconnectAttempt(nextAttempt);
      setReconnectStatus('reconnecting');

      const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY);
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * 2,
        MAX_RECONNECT_DELAY
      );

      reconnectTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, []);

  useEffect(() => {
    setEvents([]);
    manuallyClosedRef.current = false;
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    urlRef.current = url;
    cleanup();

    if (!url) {
      setConnected(false);
      setReconnectStatus('disconnected');
      return;
    }

    connect();

    return () => {
      manuallyClosedRef.current = true;
      cleanup();
    };
  }, [url, cleanup, connect]);

  const reconnecting = reconnectStatus === 'reconnecting';

  return {
    events,
    connected,
    reconnecting,
    reconnectStatus,
    reconnectAttempt,
  };
}
