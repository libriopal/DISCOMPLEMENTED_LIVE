/**
 * Function Log — records function calls to the Glass Engine DO.
 */
export interface FunctionLogEntry {
  functionName: string;
  argsSummary: string;
  resultSummary: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

type DurableObjectStub = {
  fetch: (request: Request) => Promise<Response>;
};

/**
 * Log a function call to the Glass Engine DO.
 */
export async function logFunctionCall(
  doStub: DurableObjectStub,
  entry: Omit<FunctionLogEntry, 'timestamp'>
): Promise<void> {
  try {
    await doStub.fetch(new Request('https://internal/record/function', {
      method: 'POST',
      body: JSON.stringify(entry),
    }));
  } catch {
    // Best-effort logging
  }
}

/**
 * Wrap an async function to automatically log its execution.
 */
export function withFunctionLog<T extends (...args: unknown[]) => Promise<unknown>>(
  doStub: DurableObjectStub,
  functionName: string,
  fn: T,
  userId: string,
  requestId: string
): T {
  return (async (...args: unknown[]) => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      const durationMs = Date.now() - start;
      await logFunctionCall(doStub, {
        functionName,
        argsSummary: JSON.stringify(args).slice(0, 200),
        resultSummary: JSON.stringify(result).slice(0, 200),
        durationMs,
        userId,
        requestId,
      });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      await logFunctionCall(doStub, {
        functionName,
        argsSummary: JSON.stringify(args).slice(0, 200),
        resultSummary: `ERROR: ${err instanceof Error ? err.message : 'unknown'}`,
        durationMs,
        userId,
        requestId,
      });
      throw err;
    }
  }) as T;
}
