/**
 * Sandbox (Tier 3) management hook — start/stop the project's Container and
 * track its status against routes/preview.ts. Used when a founder opens the
 * full-stack preview (API routes present, or Designer marked the project
 * complex) rather than the client-only Babel/esbuild tiers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectFile } from '@bicameral/shared/types';
import type { HealthReport } from '../durable-objects/sandbox-health.js';

export interface SandboxStatus {
  running: boolean;
  previewUrl: string | null;
  /**
   * The frontend is up but the blueprint's API is not.
   *
   * Separate from `running` on purpose: a full-stack preview whose server
   * never started still serves its pages, so reporting it as simply running is
   * accurate and useless — every fetch in the app 503s and the founder is left
   * looking at a working-looking page. The UI must show this.
   */
  degraded: boolean;
  backendRunning: boolean;
  /** Human-readable reasons the preview is not what was asked for. */
  warnings: string[];
  /**
   * The evidence behind `degraded` — what was requested inside the container
   * and what came back. Null when the container is not running, or when the
   * probe could not be reached; the server falls back to the weaker
   * process-liveness signal in that case and says so here by omission.
   *
   * Carried through to the UI rather than collapsed into `degraded` because
   * "the API returned 404" and "the API returned HTML instead of JSON" send a
   * founder to two different files.
   */
  health: HealthReport | null;
}

export interface QueuePosition {
  /** 1-based — "3rd in line", not "2 away". */
  position: number;
  queueLength: number;
  capacity: number;
}

/** How long to wait before asking for a slot again. The server suggests 5s. */
const QUEUE_POLL_MS = 5000;

const IDLE_STATUS: SandboxStatus = {
  running: false,
  previewUrl: null,
  degraded: false,
  backendRunning: false,
  warnings: [],
  health: null,
};

export function useSandboxPreview(projectId: string | null) {
  const [status, setStatus] = useState<SandboxStatus>(IDLE_STATUS);
  const [starting, setStarting] = useState(false);
  // A failed start used to be swallowed: `start` checked `res.ok` and, when it
  // was false, simply did not refresh. The UI then showed "not running" with
  // no reason, which is indistinguishable from never having asked. §3.2's rule
  // is that a preview never degrades silently, and that includes failing to
  // exist.
  const [error, setError] = useState<string | null>(null);
  /**
   * Where this project sits in the queue for a container, or null when it is
   * not waiting. `max_instances` is a hard account-wide ceiling; above it the
   * platform refuses to start a container, and the founder who happens to ask
   * at that moment would otherwise see a failure caused by other people's
   * sessions. Waiting is fine. Not knowing you are waiting is not.
   */
  const [queue, setQueue] = useState<QueuePosition | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logSourceRef = useRef<EventSource | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!projectId) return;
    const res = await fetch(`/api/preview/${projectId}`, {
      credentials: 'include',
    });
    if (res.ok) setStatus({ ...IDLE_STATUS, ...(await res.json()) });
  }, [projectId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  /**
   * Reap on close.
   *
   * When the founder moves to a different project (or to none), the container
   * they left behind is destroyed. `max_instances` is a hard global ceiling
   * and there is one container per project, so an abandoned sandbox is
   * capacity taken from someone else.
   *
   * Deliberately keyed on `projectId` changing while this hook stays mounted,
   * NOT on unmount. A page reload unmounts too, and destroying there would
   * make the preview disappear on every refresh — the opposite of the
   * persistence this workstream is supposed to deliver. Session end is covered
   * by the container's own inactivity timeout (Sandbox.ts, IDLE_TIMEOUT_MS),
   * which is the only reap a browser cannot lie about.
   */
  const previousProjectId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousProjectId.current;
    previousProjectId.current = projectId;
    if (previous === null || previous === projectId) return;

    void fetch(`/api/preview/${previous}`, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: true,
    }).catch(() => {
      // The idle timeout is the backstop; a failed reap is not worth an error
      // in the founder's face while they are looking at a different project.
    });
  }, [projectId]);

  // Held so the queue poll can retry the same start without the caller having
  // to keep asking. The files are whatever the founder's project was when they
  // asked; a newer build restarts the whole flow through `start`.
  const queuedFilesRef = useRef<ProjectFile[] | null>(null);

  const attemptStart = useCallback(
    async (files: ProjectFile[], visible: boolean) => {
      if (!projectId) return;
      // A background queue poll must not flip the panel back to "Starting" —
      // the founder is already being told they are waiting, and alternating
      // between two truthful messages reads as a glitch.
      if (visible) setStarting(true);
      setError(null);
      try {
        const res = await fetch(`/api/preview/${projectId}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });

        if (res.status === 202) {
          const body = (await res.json()) as QueuePosition;
          queuedFilesRef.current = files;
          setQueue({
            position: body.position,
            queueLength: body.queueLength,
            capacity: body.capacity,
          });
          return;
        }

        setQueue(null);
        queuedFilesRef.current = null;

        if (res.ok) {
          await refreshStatus();
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `Preview failed to start (HTTP ${res.status})`);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Preview failed to start'
        );
      } finally {
        if (visible) setStarting(false);
      }
    },
    [projectId, refreshStatus]
  );

  const start = useCallback(
    (files: ProjectFile[]) => attemptStart(files, true),
    [attemptStart]
  );

  // Ask again until the pool has room. Promotion is pull, not push: there is
  // no channel to notify a waiting browser on, and a slot handed to a client
  // that never came back would be capacity lost to nobody.
  useEffect(() => {
    if (!queue) return;
    const timer = setTimeout(() => {
      const files = queuedFilesRef.current;
      if (files) void attemptStart(files, false);
    }, QUEUE_POLL_MS);
    return () => clearTimeout(timer);
  }, [queue, attemptStart]);

  const stop = useCallback(async () => {
    if (!projectId) return;
    await fetch(`/api/preview/${projectId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    logSourceRef.current?.close();
    setStatus(IDLE_STATUS);
    setError(null);
    // Stopping also abandons a queue place. Leaving it would keep polling for
    // a container the founder just said they did not want.
    setQueue(null);
    queuedFilesRef.current = null;
  }, [projectId]);

  useEffect(() => {
    logSourceRef.current?.close();
    setLogs([]);
    if (!projectId || !status.running) return;

    const source = new EventSource(`/api/preview/${projectId}/logs`, {
      withCredentials: true,
    });
    logSourceRef.current = source;
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as { message: string };
        setLogs((prev) => [...prev.slice(-199), parsed.message]);
      } catch {
        // Ignore malformed frames.
      }
    };

    return () => source.close();
  }, [projectId, status.running]);

  return { status, starting, error, queue, logs, start, stop, refreshStatus };
}
