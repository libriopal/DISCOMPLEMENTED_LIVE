/**
 * PreviewCapacity — one global Durable Object holding the preview pool's
 * admission registry.
 *
 * A single instance (`idFromName('global')`) on purpose. The whole point is a
 * count that nothing can race: `max_instances` is account-wide, so a per-project
 * or per-user shard could each admit up to the ceiling and the platform would
 * refuse the overflow exactly as it does today. A DO is single-threaded, so
 * "count the actives and decide" is atomic here and is not atomic in D1.
 *
 * The decisions live in preview-capacity.ts; this class is storage and routing
 * only. It holds no container and starts nothing — Sandbox does that, after
 * being told it may.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import {
  admit,
  expireSlots,
  release,
  renew,
  resolveCapacity,
  type Slot,
} from './preview-capacity.js';

const SLOTS_KEY = 'slots';

export class PreviewCapacity extends DurableObject<Env> {
  private async load(): Promise<Slot[]> {
    const stored = await this.ctx.storage.get<Slot[]>(SLOTS_KEY);
    return stored ?? [];
  }

  private async save(slots: Map<string, Slot>): Promise<void> {
    await this.ctx.storage.put(SLOTS_KEY, [...slots.values()]);
  }

  private capacity(): number {
    return resolveCapacity(this.env.PREVIEW_MAX_INSTANCES);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admit' && request.method === 'POST') {
      const { projectId } = await request.json<{ projectId: string }>();
      const result = admit(
        await this.load(),
        projectId,
        Date.now(),
        this.capacity()
      );
      await this.save(result.slots);
      // 202 for a queued caller, not 503: the request was accepted and is
      // waiting its turn. A 5xx would tell every client library in the world
      // that the platform is broken, and this is the opposite — it is the
      // platform declining to break.
      return Response.json(result.admission, {
        status: result.admission.admitted ? 200 : 202,
      });
    }

    if (url.pathname === '/renew' && request.method === 'POST') {
      const { projectId } = await request.json<{ projectId: string }>();
      await this.save(renew(await this.load(), projectId, Date.now()));
      return Response.json({ renewed: true });
    }

    if (url.pathname === '/release' && request.method === 'POST') {
      const { projectId } = await request.json<{ projectId: string }>();
      await this.save(release(await this.load(), projectId, Date.now()));
      return Response.json({ released: true });
    }

    if (url.pathname === '/state') {
      const live = expireSlots(await this.load(), Date.now());
      return Response.json({
        capacity: this.capacity(),
        slots: [...live.values()],
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
