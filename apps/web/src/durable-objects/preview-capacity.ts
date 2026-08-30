/**
 * Admission control for preview containers — the pure decision half.
 *
 * `max_instances` in wrangler.toml is a hard, account-wide ceiling: the
 * platform refuses to start container N+1, and it refuses at the moment the
 * founder clicks Preview. Without admission control that refusal is the whole
 * user experience — a start that fails for a reason belonging to somebody
 * else's session, with no way to tell "your app is broken" from "the platform
 * is full". §3.2 asks for the other behaviour: concurrency above the ceiling
 * queues *visibly*, with a position.
 *
 * Split from the Durable Object so the interesting cases — a full pool, a
 * queued project asking twice, a slot whose container died holding it — are
 * testable without a container, a DO, or a network.
 *
 * The unit of capacity is the project, because the unit of container is the
 * project: `PREVIEW_SANDBOX.idFromName(projectId)`. A project already holding
 * a slot asking again is not a second claim.
 */

/**
 * Mirrors `max_instances` in wrangler.toml. Read from the `PREVIEW_MAX_INSTANCES`
 * var so the two cannot drift silently; this is the fallback for a local run
 * with no vars bound, and it is deliberately the same number.
 */
export const DEFAULT_MAX_ACTIVE = 20;

/**
 * How long an active slot survives without a heartbeat before it is reclaimed.
 *
 * A slot is held by a container, and a container can die in ways nothing tells
 * us about — the platform evicting it, the isolate being recycled, a crash
 * during install. If a dead container's slot were held forever, the pool would
 * drain to zero over days and every founder would queue behind ghosts. That is
 * the shape of the orphan problem already measured on this account: eight
 * instance records, all inactive, none reaped by anything.
 *
 * Set above `Sandbox.IDLE_TIMEOUT_MS` (15 min) plus room for a slow start, so a
 * live-but-idle container is never mistaken for a dead one. The container's own
 * inactivity timeout should always fire first; this is the backstop for when it
 * cannot.
 */
export const ACTIVE_SLOT_TTL_MS = 20 * 60 * 1000;

/**
 * How long a queued claim survives without being renewed.
 *
 * A queue position is only meaningful while somebody is still waiting for it.
 * The client renews by polling; a founder who closes the tab stops renewing and
 * drops out, rather than holding up everyone behind them. Short, because the
 * client polls every few seconds.
 */
export const QUEUED_SLOT_TTL_MS = 45 * 1000;

export type SlotState = 'active' | 'queued';

export interface Slot {
  projectId: string;
  state: SlotState;
  /** When this project first asked. Queue order — first asked, first served. */
  requestedAt: number;
  /** Last time the holder proved it still wants the slot. */
  seenAt: number;
}

export interface AdmissionGrant {
  admitted: true;
  /** Active previews after this grant, for telemetry and the admin view. */
  active: number;
  capacity: number;
}

export interface AdmissionQueued {
  admitted: false;
  /** 1-based: "you are 3rd in line", not "you are 2 away". */
  position: number;
  queueLength: number;
  active: number;
  capacity: number;
}

export type Admission = AdmissionGrant | AdmissionQueued;

/**
 * Drop slots whose holder has stopped proving it exists.
 *
 * Returns a new map rather than mutating, so a caller that decides not to
 * commit (an admission that throws before it writes) cannot leave the registry
 * half-expired.
 */
export function expireSlots(
  slots: Iterable<Slot>,
  now: number
): Map<string, Slot> {
  const live = new Map<string, Slot>();
  for (const slot of slots) {
    const ttl =
      slot.state === 'active' ? ACTIVE_SLOT_TTL_MS : QUEUED_SLOT_TTL_MS;
    if (now - slot.seenAt <= ttl) live.set(slot.projectId, slot);
  }
  return live;
}

export function countActive(slots: Iterable<Slot>): number {
  let n = 0;
  for (const slot of slots) if (slot.state === 'active') n += 1;
  return n;
}

/**
 * Where a queued project sits, 1-based, ordered by when it first asked.
 *
 * Ordering is by `requestedAt` and not by insertion, because a slot is rewritten
 * on every heartbeat: ordering by anything that a renewal touches would send a
 * waiting founder to the back of the line every time their browser polled.
 */
export function queuePosition(
  slots: Iterable<Slot>,
  projectId: string
): number {
  const queued = [...slots]
    .filter((s) => s.state === 'queued')
    .sort((a, b) =>
      a.requestedAt === b.requestedAt
        ? a.projectId.localeCompare(b.projectId)
        : a.requestedAt - b.requestedAt
    );
  return queued.findIndex((s) => s.projectId === projectId) + 1;
}

export interface AdmissionResult {
  admission: Admission;
  /** The registry to persist. Always write this, grant or not. */
  slots: Map<string, Slot>;
}

/**
 * Decide whether `projectId` may start a container right now.
 *
 * Re-entrant on purpose: a project that already holds an active slot is granted
 * again without consuming a second one, because the founder pressing Preview
 * twice, or the client retrying a request whose response was lost, must not
 * cost capacity. A queued project asking again renews its claim and keeps its
 * place.
 *
 * Promotion is pull, not push: a queued project becomes active on the ask that
 * finds room, not on somebody else's release. There is nothing to notify a
 * waiting browser with — it is polling — and a slot handed to a client that
 * never comes back would be a slot lost until its TTL.
 */
export function admit(
  existing: Iterable<Slot>,
  projectId: string,
  now: number,
  capacity: number = DEFAULT_MAX_ACTIVE
): AdmissionResult {
  const slots = expireSlots(existing, now);
  const current = slots.get(projectId);

  if (current?.state === 'active') {
    slots.set(projectId, { ...current, seenAt: now });
    return {
      admission: {
        admitted: true,
        active: countActive(slots.values()),
        capacity,
      },
      slots,
    };
  }

  const requestedAt = current?.requestedAt ?? now;

  if (countActive(slots.values()) < capacity) {
    slots.set(projectId, {
      projectId,
      state: 'active',
      requestedAt,
      seenAt: now,
    });
    return {
      admission: {
        admitted: true,
        active: countActive(slots.values()),
        capacity,
      },
      slots,
    };
  }

  slots.set(projectId, {
    projectId,
    state: 'queued',
    requestedAt,
    seenAt: now,
  });
  const queueLength = [...slots.values()].filter(
    (s) => s.state === 'queued'
  ).length;
  return {
    admission: {
      admitted: false,
      position: queuePosition(slots.values(), projectId),
      queueLength,
      active: countActive(slots.values()),
      capacity,
    },
    slots,
  };
}

/**
 * Re-assert an active slot for a container that is running right now.
 *
 * Not `admit`: this cannot queue and cannot refuse. The caller has just
 * observed a live container, and a live container occupies one of the
 * platform's instances whether or not this registry has a record of it. Marking
 * it active is the truthful accounting even if that momentarily puts the count
 * at capacity + 1 — the alternative is a registry that says a slot is free
 * while the platform refuses to start anything in it.
 *
 * This is how an active slot survives: the client polls status, every poll
 * renews, and a container whose founder has gone quiet falls out after
 * ACTIVE_SLOT_TTL_MS.
 */
export function renew(
  existing: Iterable<Slot>,
  projectId: string,
  now: number
): Map<string, Slot> {
  const slots = expireSlots(existing, now);
  const current = slots.get(projectId);
  slots.set(projectId, {
    projectId,
    state: 'active',
    requestedAt: current?.requestedAt ?? now,
    seenAt: now,
  });
  return slots;
}

/** Give up a slot — the container was destroyed, or never started. */
export function release(
  existing: Iterable<Slot>,
  projectId: string,
  now: number
): Map<string, Slot> {
  const slots = expireSlots(existing, now);
  slots.delete(projectId);
  return slots;
}

/**
 * Resolve the ceiling from the environment, refusing a value that would make
 * the queue meaningless.
 *
 * A misparsed or absent var falls back to the wrangler default rather than to
 * `Infinity` or `0`: unbounded would hand every request straight to a platform
 * refusal (the behaviour this exists to remove), and zero would queue everyone
 * forever.
 */
export function resolveCapacity(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_ACTIVE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_ACTIVE;
  return parsed;
}
