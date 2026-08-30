/**
 * Tier 2 preview hook — owns the esbuild.worker.ts Web Worker and exposes a
 * simple promise-based `bundle()` call keyed by request id so overlapping
 * bundle requests (e.g. the founder editing while a previous bundle is
 * still running) don't cross-resolve.
 */
import { useCallback, useEffect, useRef } from 'react';
import type {
  BundleRequest,
  BundleResponse,
  WorkerFile,
} from '../workers/esbuild.worker.js';

export interface BundleOutcome {
  code: string | null;
  errors: string[];
}

/**
 * @param enabled Whether this caller will actually bundle. Defaults to true so
 *   existing callers are unchanged.
 *
 *   Starting the worker downloads esbuild's 12 MB wasm binary. That was
 *   acceptable while nothing rendered PreviewFrame; now that it is on the
 *   Generation view, a Tier 1 or Tier 3 project would pay for a bundler it
 *   never calls. `bundle()` still answers on a disabled hook — with the
 *   "not ready" error below rather than silently hanging.
 */
export function useEsbuild(enabled = true) {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<string, (result: BundleOutcome) => void>());

  useEffect(() => {
    if (!enabled) return;
    const worker = new Worker(
      new URL('../workers/esbuild.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<BundleResponse>) => {
      const resolve = pending.current.get(event.data.id);
      if (resolve) {
        resolve({ code: event.data.code, errors: event.data.errors });
        pending.current.delete(event.data.id);
      }
    };
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
      pending.current.clear();
    };
  }, [enabled]);

  const bundle = useCallback(
    (files: WorkerFile[], entryPoint: string): Promise<BundleOutcome> => {
      return new Promise((resolve) => {
        const worker = workerRef.current;
        if (!worker) {
          resolve({ code: null, errors: ['esbuild worker not ready'] });
          return;
        }
        const id = crypto.randomUUID();
        pending.current.set(id, resolve);
        const request: BundleRequest = {
          id,
          type: 'bundle',
          files,
          entryPoint,
        };
        worker.postMessage(request);
      });
    },
    []
  );

  return { bundle };
}
