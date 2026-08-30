/**
 * GlassEngineDO — Durable Object for admin observability.
 * Holds ring buffers: sql_tape[100], function_log[100], auth_traces[100].
 * Admin-only reads. SSE via WebSocket hibernation API.
 * See 03_ARCHITECTURE_SPECIFICATION/DESIGN-DECISIONS.md §GlassEngineDO.
 */
import { DurableObject } from 'cloudflare:workers';

interface SqlTapeEntry {
  sql: string;
  params: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

interface FunctionLogEntry {
  functionName: string;
  argsSummary: string;
  resultSummary: string;
  durationMs: number;
  userId: string;
  requestId: string;
  timestamp: string;
}

interface AuthTraceEntry {
  action: string;
  userId: string;
  requestId: string;
  success: boolean;
  detail: string;
  timestamp: string;
}

const RING_BUFFER_SIZE = 100;

export class GlassEngineDO extends DurableObject {
  private sqlTape: SqlTapeEntry[] = [];
  private functionLog: FunctionLogEntry[] = [];
  private authTraces: AuthTraceEntry[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for SSE
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      // Send initial data
      const buffer = url.pathname.includes('sql-tape')
        ? this.sqlTape
        : url.pathname.includes('function-log')
          ? this.functionLog
          : this.authTraces;

      server.send(JSON.stringify({ type: 'initial', entries: buffer }));

      // Set timeout for max connection duration (30 seconds)
      setTimeout(() => {
        try {
          server.close();
        } catch (e) {
          /* connection already closed */
        }
      }, 30000);

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP reads (admin-only — auth check happens in the route handler)
    const path = url.pathname;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    if (path.includes('sql-tape')) {
      return Response.json({ entries: this.sqlTape.slice(-limit).reverse() });
    }
    if (path.includes('function-log')) {
      return Response.json({
        entries: this.functionLog.slice(-limit).reverse(),
      });
    }
    if (path.includes('auth-trace')) {
      return Response.json({
        entries: this.authTraces.slice(-limit).reverse(),
      });
    }

    return new Response('Not found', { status: 404 });
  }

  recordSql(entry: Omit<SqlTapeEntry, 'timestamp'>): void {
    const fullEntry = { ...entry, timestamp: new Date().toISOString() };
    this.sqlTape.push(fullEntry);
    if (this.sqlTape.length > RING_BUFFER_SIZE) {
      this.sqlTape = this.sqlTape.slice(-RING_BUFFER_SIZE);
    }
    (this.ctx.storage as any).putSql?.('sql_tape', this.sqlTape);
  }

  recordFunction(entry: Omit<FunctionLogEntry, 'timestamp'>): void {
    const fullEntry = { ...entry, timestamp: new Date().toISOString() };
    this.functionLog.push(fullEntry);
    if (this.functionLog.length > RING_BUFFER_SIZE) {
      this.functionLog = this.functionLog.slice(-RING_BUFFER_SIZE);
    }
    (this.ctx.storage as any).putSql?.('function_log', this.functionLog);
  }

  recordAuth(entry: Omit<AuthTraceEntry, 'timestamp'>): void {
    const fullEntry = { ...entry, timestamp: new Date().toISOString() };
    this.authTraces.push(fullEntry);
    if (this.authTraces.length > RING_BUFFER_SIZE) {
      this.authTraces = this.authTraces.slice(-RING_BUFFER_SIZE);
    }
    (this.ctx.storage as any).putSql?.('auth_traces', this.authTraces);
  }

  getSqlTape(limit = 100): SqlTapeEntry[] {
    return this.sqlTape.slice(-limit).reverse();
  }

  getFunctionLog(limit = 100): FunctionLogEntry[] {
    return this.functionLog.slice(-limit).reverse();
  }

  getAuthTraces(limit = 100): AuthTraceEntry[] {
    return this.authTraces.slice(-limit).reverse();
  }

  async webSocketMessage(
    ws: WebSocket,
    message: ArrayBuffer | string
  ): Promise<void> {
    // Handle heartbeat
    if (typeof message === 'string' && message === 'ping') {
      ws.send('pong');
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string
  ): Promise<void> {
    ws.close(code, reason);
  }
}
