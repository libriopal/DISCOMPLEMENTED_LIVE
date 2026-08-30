/**
 * The cases that make admission control worth having: a full pool, the same
 * project asking twice, a queue that keeps its order across heartbeats, and a
 * slot whose container died holding it.
 *
 * Every one of these is a state that only occurs when several founders are
 * using the platform at once, which is exactly when nobody is watching a
 * terminal. They are pure functions so they can be pinned here rather than
 * discovered in production.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SLOT_TTL_MS,
  admit,
  countActive,
  DEFAULT_MAX_ACTIVE,
  expireSlots,
  QUEUED_SLOT_TTL_MS,
  queuePosition,
  release,
  renew,
  resolveCapacity,
  type Slot,
} from './preview-capacity.js';

const T0 = 1_700_000_000_000;

function activeSlot(projectId: string, at = T0): Slot {
  return { projectId, state: 'active', requestedAt: at, seenAt: at };
}

/** Fill the pool to `capacity` with projects that are not the one under test. */
function fullPool(capacity: number, at = T0): Slot[] {
  return Array.from({ length: capacity }, (_, i) =>
    activeSlot(`other-${i}`, at)
  );
}

describe('admit', () => {
  it('grants when there is room', () => {
    const { admission, slots } = admit([], 'p1', T0, 3);
    expect(admission).toEqual({ admitted: true, active: 1, capacity: 3 });
    expect(slots.get('p1')?.state).toBe('active');
  });

  it('queues when the pool is full, with a 1-based position', () => {
    const { admission } = admit(fullPool(2), 'p1', T0, 2);
    expect(admission).toMatchObject({
      admitted: false,
      position: 1,
      queueLength: 1,
      active: 2,
      capacity: 2,
    });
  });

  it('does not spend a second slot when the same project asks twice', () => {
    const first = admit(fullPool(1), 'p1', T0, 2);
    expect(first.admission.admitted).toBe(true);
    // The founder clicking Preview again, or a retry of a request whose
    // response was lost. Neither is a second container.
    const second = admit(first.slots.values(), 'p1', T0 + 1_000, 2);
    expect(second.admission).toEqual({
      admitted: true,
      active: 2,
      capacity: 2,
    });
    expect(countActive(second.slots.values())).toBe(2);
  });

  it('keeps a waiting project in its place across heartbeats', () => {
    let slots = admit(fullPool(1), 'first', T0, 1).slots;
    slots = admit(slots.values(), 'second', T0 + 100, 1).slots;

    // `first` polls again 5s later. Ordering by anything a renewal touches
    // would send it to the back of its own queue.
    const again = admit(slots.values(), 'first', T0 + 5_000, 1);
    expect(again.admission).toMatchObject({
      admitted: false,
      position: 1,
      queueLength: 2,
    });
    expect(queuePosition(again.slots.values(), 'second')).toBe(2);
  });

  it('promotes a waiting project once a slot is released', () => {
    let slots = admit(fullPool(1), 'waiting', T0, 1).slots;
    expect(admit(slots.values(), 'waiting', T0, 1).admission.admitted).toBe(
      false
    );

    slots = release(slots.values(), 'other-0', T0);
    const promoted = admit(slots.values(), 'waiting', T0 + 10, 1);
    expect(promoted.admission.admitted).toBe(true);
    expect(promoted.slots.get('waiting')?.state).toBe('active');
  });

  it('reclaims a slot whose container stopped reporting', () => {
    // The orphan case. Eight inactive instance records were measured on this
    // account with nothing reaping them; a registry that never expired would
    // drain the pool to zero and queue everyone behind containers that are
    // not there.
    const stale = fullPool(1, T0);
    const later = T0 + ACTIVE_SLOT_TTL_MS + 1;
    expect(admit(stale, 'p1', later, 1).admission.admitted).toBe(true);
  });

  it('drops a queued project that stopped polling', () => {
    const slots = admit(fullPool(1), 'gone', T0, 1).slots;
    const later = T0 + QUEUED_SLOT_TTL_MS + 1;
    expect(expireSlots(slots.values(), later).has('gone')).toBe(false);
    // …while the active container it was waiting behind is untouched: the two
    // TTLs are different on purpose.
    expect(expireSlots(slots.values(), later).has('other-0')).toBe(true);
  });
});

describe('renew', () => {
  it('re-asserts a running container even when the pool is at capacity', () => {
    // Truthful accounting beats a tidy count: the container is running, so it
    // is occupying an instance whether or not the registry remembers it.
    const slots = renew(fullPool(2), 'recovered', T0);
    expect(slots.get('recovered')?.state).toBe('active');
    expect(countActive(slots.values())).toBe(3);
  });

  it('keeps the original request time so a renewal cannot reorder a queue', () => {
    const first = admit([], 'p1', T0, 1).slots;
    const renewed = renew(first.values(), 'p1', T0 + 60_000);
    expect(renewed.get('p1')?.requestedAt).toBe(T0);
    expect(renewed.get('p1')?.seenAt).toBe(T0 + 60_000);
  });
});

describe('resolveCapacity', () => {
  it('falls back to the wrangler default rather than to unbounded or zero', () => {
    // Unbounded would hand the overflow straight back to a platform refusal —
    // the behaviour this exists to remove. Zero would queue everyone forever.
    expect(resolveCapacity(undefined)).toBe(DEFAULT_MAX_ACTIVE);
    expect(resolveCapacity('')).toBe(DEFAULT_MAX_ACTIVE);
    expect(resolveCapacity('not a number')).toBe(DEFAULT_MAX_ACTIVE);
    expect(resolveCapacity('0')).toBe(DEFAULT_MAX_ACTIVE);
    expect(resolveCapacity('-3')).toBe(DEFAULT_MAX_ACTIVE);
  });

  it('honours a real override', () => {
    expect(resolveCapacity('40')).toBe(40);
  });
});
