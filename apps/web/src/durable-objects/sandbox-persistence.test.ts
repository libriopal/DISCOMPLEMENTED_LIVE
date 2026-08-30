/**
 * Reuse-vs-reboot, which is what makes a preview survive a page reload.
 *
 * Every case below was previously the same code path: start over. The one that
 * matters most is the first — a reload of an unchanged app — because on the
 * old path it did not lose state quietly, it threw, and the founder was told
 * their working preview had failed to start.
 */
import { describe, it, expect } from 'vitest';
import { decideStart, fileSetSignature } from './sandbox-persistence.js';

const SIG = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('deciding what a repeat start should do', () => {
  it('reuses a running container serving the same files', () => {
    const decision = decideStart({
      containerRunning: true,
      phase: 'running',
      currentSignature: SIG,
      requestedSignature: SIG,
    });
    expect(decision.action).toBe('reuse');
  });

  it('boots when there is no container', () => {
    expect(
      decideStart({
        containerRunning: false,
        phase: 'booting',
        currentSignature: null,
        requestedSignature: SIG,
      }).action
    ).toBe('boot');
  });

  it('boots rather than reusing when the container is gone but state lingers', () => {
    // The platform's own inactivity reaper can take a container out from under
    // a DO that still remembers what it was running. Reusing on the strength
    // of that memory would proxy to nothing.
    expect(
      decideStart({
        containerRunning: false,
        phase: 'running',
        currentSignature: SIG,
        requestedSignature: SIG,
      }).action
    ).toBe('boot');
  });

  it('reboots when the files have changed, and says state will be lost', () => {
    const decision = decideStart({
      containerRunning: true,
      phase: 'running',
      currentSignature: SIG,
      requestedSignature: OTHER,
    });
    expect(decision.action).toBe('reboot');
    // Surfaced as a warning, because a new build silently discarding whatever
    // the founder entered into the last preview is the kind of thing that
    // reads as a bug when it is not.
    expect(decision.reason).toMatch(/discarded/);
  });

  it('reboots a container whose boot never finished, in every unsealed phase', () => {
    // `installing` is the dangerous one: egress is open in that phase, so
    // resuming would run generated code with the registry still reachable.
    for (const phase of ['booting', 'installing', 'sealed'] as const) {
      const decision = decideStart({
        containerRunning: true,
        phase,
        currentSignature: SIG,
        requestedSignature: SIG,
      });
      expect(decision.action).toBe('reboot');
      expect(decision.reason).toContain(phase);
    }
  });

  it('reboots a running container it cannot identify', () => {
    expect(
      decideStart({
        containerRunning: true,
        phase: 'running',
        currentSignature: null,
        requestedSignature: SIG,
      }).action
    ).toBe('reboot');
  });
});

describe('the file-set signature', () => {
  const files = [
    { path: 'src/App.jsx', content: 'export default () => <p>hi</p>;' },
    { path: 'server.js', content: 'console.log(1)' },
  ];

  it('is stable across emission order', async () => {
    expect(await fileSetSignature({ files })).toBe(
      await fileSetSignature({ files: [...files].reverse() })
    );
  });

  it('changes when any file content changes', async () => {
    expect(await fileSetSignature({ files })).not.toBe(
      await fileSetSignature({
        files: [files[0], { path: 'server.js', content: 'console.log(2)' }],
      })
    );
  });

  it('changes when a file is added', async () => {
    expect(await fileSetSignature({ files })).not.toBe(
      await fileSetSignature({
        files: [...files, { path: 'x.js', content: '' }],
      })
    );
  });

  it('separates content that would otherwise concatenate the same', async () => {
    // Without length prefixes and separators these two file sets flatten to
    // identical bytes, and one founder's build would be served from the
    // other's container while reporting itself current.
    expect(
      await fileSetSignature({ files: [{ path: 'a', content: 'bc' }] })
    ).not.toBe(
      await fileSetSignature({ files: [{ path: 'ab', content: 'c' }] })
    );
  });

  it('changes when the declared API routes change', async () => {
    // The routes decide what is proxied to the backend, so a container booted
    // without them is not running the same preview even with identical files.
    expect(await fileSetSignature({ files, apiRoutePaths: [] })).not.toBe(
      await fileSetSignature({ files, apiRoutePaths: ['/api/todos'] })
    );
  });

  it('changes when an env var value changes', async () => {
    expect(await fileSetSignature({ files, envVars: { A: '1' } })).not.toBe(
      await fileSetSignature({ files, envVars: { A: '2' } })
    );
  });

  it('is a hex sha-256', async () => {
    expect(await fileSetSignature({ files })).toMatch(/^[0-9a-f]{64}$/);
  });
});
