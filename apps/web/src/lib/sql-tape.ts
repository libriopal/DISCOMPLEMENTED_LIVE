/**
 * SQL Tape — intercepts D1 queries and records them to the Glass Engine DO.
 */
import type { GlassEngineDO } from './glass-engine-do.js';

export interface SqlTapeEntry {
  sql: string;
  params: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

/**
 * Create a wrapped D1Database that records all queries to the Glass Engine DO.
 */
export function createSqlTapeInterceptor(
  db: D1Database,
  doStub: DurableObjectStub,
  userId: string,
  requestId: string
): D1Database {
  const handler: ProxyHandler<D1Database> = {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          const original = {
            bind: stmt.bind.bind(stmt),
            all: stmt.all.bind(stmt),
            first: stmt.first.bind(stmt),
            run: stmt.run.bind(stmt),
          };

          // Wrap the statement methods to record execution
          const wrappedStmt = new Proxy(stmt, {
            get(t, p) {
              if (p === 'all' || p === 'first' || p === 'run') {
                return async (...args: any[]) => {
                  const start = Date.now();
                  const result = await (original as any)[p](...args);
                  const durationMs = Date.now() - start;

                  try {
                    doStub.fetch(
                      new Request('https://internal/record/sql', {
                        method: 'POST',
                        body: JSON.stringify({
                          sql,
                          params: JSON.stringify(args).slice(0, 200),
                          durationMs,
                          userId,
                          requestId,
                        }),
                      })
                    );
                  } catch {
                    // Recording is best-effort, don't block on errors
                  }

                  return result;
                };
              }
              if (p === 'bind') {
                return (...args: unknown[]) => {
                  original.bind(...args);
                  return wrappedStmt;
                };
              }
              if (p === 'batch') {
                return async (statements: D1PreparedStatement[]) => {
                  const start = Date.now();
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const result = await (t as any).batch(statements);
                  const durationMs = Date.now() - start;
                  try {
                    doStub.fetch(
                      new Request('https://internal/record/sql', {
                        method: 'POST',
                        body: JSON.stringify({
                          sql: 'batch',
                          params: `${statements.length} statements`,
                          durationMs,
                          userId,
                          requestId,
                        }),
                      })
                    );
                  } catch (e) {
                    /* telemetry endpoint may be down */
                  }
                  return result;
                };
              }
              return t[p as keyof D1PreparedStatement];
            },
          });

          return wrappedStmt;
        };
      }
      return target[prop as keyof D1Database];
    },
  };

  return new Proxy(db, handler);
}

// Type alias for DO stub — Cloudflare Workers types
type DurableObjectStub = {
  fetch: (request: Request) => Promise<Response>;
};
