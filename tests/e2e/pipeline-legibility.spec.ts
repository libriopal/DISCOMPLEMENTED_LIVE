import { test, expect, type Page } from '@playwright/test';

/**
 * §3.4, asserted on the rendered surface.
 *
 * "A user watching the pipeline should be able to answer, at any moment, what
 * is happening, why, and what happens next — without opening dev tools." The
 * sentences themselves are pinned in src/lib/pipeline-legibility.test.ts, and
 * the frames that feed them in tests/integration/pipeline-stream.test.ts.
 * Neither of those can see the two claims that are only true of a rendered
 * page: that the rail is on screen *while* a run is going (it used to render
 * only on the empty screen and vanish the moment a run started), and that the
 * review gate is reachable without scrolling (it used to be the fourth card
 * down a 360px sidebar).
 *
 * The API is stubbed, and the honest description of that is: this grades the
 * UI layer against frames in the shapes routes/pipeline.ts really sends —
 * every fixture below is copied from that route's `send()` calls, and the
 * integration test is what holds those shapes to the database. It does not
 * grade the backend, and a green run here is not evidence a real pipeline
 * works. That evidence is the §5 acceptance applications.
 */

const RUN_ID = 'e2e-legibility-run';
const PROJECT_ID = 'e2e-legibility-project';

/** Four minutes before the page loads, so the elapsed clock has something to
 * be wrong about. A run that displays "0s" after a reload is the defect. */
const startedAt = () => new Date(Date.now() - 252_000).toISOString();

function sse(frames: unknown[]): string {
  return (
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') +
    'data: [DONE]\n\n'
  );
}

/**
 * Stubs everything under /api, then seeds the run id the way a real session
 * leaves it: usePipeline persists it to localStorage precisely so a reload
 * rejoins the run, and that is the state this spec is describing.
 */
async function openRun(page: Page, frames: unknown[]): Promise<void> {
  // Registration order is load-bearing and backwards from the obvious one:
  // Playwright matches the *most recently* registered route first, so the
  // catch-all has to go on first or it answers everything — including the
  // session, which lands the page on the marketing site instead.
  await page.route('**/api/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' })
  );

  await page.route('**/api/auth/get-session**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'e2e-user', email: 'e2e@example.com', name: 'E2E' },
        session: { id: 'e2e-session', userId: 'e2e-user' },
      }),
    })
  );

  await page.route(`**/api/pipeline/${RUN_ID}`, (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: sse(frames) })
  );

  // A run already exists, so App.tsx does not open the onboarding overlay.
  await page.route('**/api/pipeline', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ runs: [{ id: RUN_ID }] }),
    })
  );

  await page.addInitScript(
    ([runId, projectId]) => {
      localStorage.setItem('bicameral:activePipelineId', runId);
      localStorage.setItem('bicameral:activeProjectId', projectId);
    },
    [RUN_ID, PROJECT_ID]
  );

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // A readiness barrier, not a longer assertion. Every test below is about
  // what the surface says once it is up; none of them is about how long a
  // cold client takes to boot, and the generation view boots a lot — the
  // route chunk, the 2.9 MB Babel chunk behind the Tier 1 preview, the
  // iframe. On a loaded machine that has exceeded the 5s expect timeout, and
  // when it did, the failure landed on the gate assertion and read as a
  // missing gate: the page snapshot taken at that moment had the gate on it,
  // fully rendered. Waiting once here, with the test's own timeout, means the
  // assertions after it measure the thing they name. Nothing is loosened —
  // if the surface never mounts, this still fails, and it fails saying so.
  await expect(page.getByLabel('Pipeline status')).toBeVisible({
    timeout: 20_000,
  });
}

/** The frames a run mid-Verify has actually emitted by that point. */
const MID_RUN = [
  { type: 'pipeline:context', projectId: PROJECT_ID, startedAt: startedAt() },
  {
    type: 'step:complete',
    step: 1,
    agent: 'researcher',
    model: 'command-a-03-2025',
  },
  {
    type: 'step:complete',
    step: 2,
    agent: 'auditor',
    model: 'nvidia/nemotron-3-super-120b-a12b',
  },
  {
    type: 'step:start',
    step: 3,
    agent: 'verifier',
    model: 'command-a-03-2025',
  },
];

test.describe('what is happening, why, and what happens next', () => {
  test('shows the rail during a run, not only before one', async ({ page }) => {
    await openRun(page, MID_RUN);

    const status = page.getByLabel('Pipeline status');
    await expect(status).toBeVisible();

    // Five stages, the pipeline's own names. The flagship brief forbids a
    // second vocabulary and this is where one would appear first.
    const stages = status.locator('.pipe-rail__stage');
    await expect(stages).toHaveCount(5);
    await expect(stages.nth(2)).toHaveClass(/pipe-rail__stage--active/);
    await expect(stages.nth(1)).toHaveClass(/pipe-rail__stage--done/);
    await expect(stages.nth(3)).toHaveClass(/pipe-rail__stage--pending/);
  });

  test('counts the stage and the elapsed time from the run’s own start', async ({
    page,
  }) => {
    await openRun(page, MID_RUN);

    const status = page.getByLabel('Pipeline status');
    await expect(status).toContainText('Stage 3 of 5');

    // 4m, because pipeline:context carried when the run began. A clock
    // started on mount would read a few seconds here and be believed.
    await expect(status.locator('.pipe-status__elapsed')).toContainText('4m');

    // No percentage, anywhere on the surface. The constraint is repo-wide and
    // a progress bar is the most likely place to break it by accident.
    await expect(status).not.toContainText('%');
  });

  test('says who the run is waiting on, and what runs next', async ({
    page,
  }) => {
    await openRun(page, MID_RUN);

    const status = page.getByLabel('Pipeline status');
    // The line says what the stage is doing, not which agent is doing it —
    // "Checking dependencies and constraints", not "Verifier...". The agent
    // name is already on the rail; repeating it here would answer "what is
    // happening" with a job title.
    await expect(status.locator('.pipe-status__now')).toContainText(
      /dependencies/i
    );
    await expect(status.locator('.pipe-status__now')).toHaveClass(
      /pipe-status__now--pipeline/
    );
    await expect(status.locator('.pipe-status__next')).toContainText(/Design/);
  });

  test('withholds the model until verbose asks for it', async ({ page }) => {
    // §3.3's promise, kept on this surface too: `normal` does not show model
    // ids, so the header must not either. The stream carries the model at
    // every level, so this is a display decision and worth pinning as one.
    await openRun(page, MID_RUN);
    const status = page.getByLabel('Pipeline status');
    await expect(status).toBeVisible();
    await expect(status.locator('.pipe-status__model')).toHaveCount(0);
  });
});

test.describe('the review gate is the centre of the experience', () => {
  const AT_GATE = [
    { type: 'pipeline:context', projectId: PROJECT_ID, startedAt: startedAt() },
    { type: 'step:complete', step: 1, agent: 'researcher' },
    { type: 'step:complete', step: 2, agent: 'auditor' },
    { type: 'step:complete', step: 3, agent: 'verifier' },
    { type: 'step:start', step: 4, agent: 'designer' },
    {
      type: 'gate:awaiting_approval',
      message: 'Review your blueprint to continue',
    },
  ];

  test('is on screen without scrolling, and says what each choice does', async ({
    page,
  }) => {
    await openRun(page, AT_GATE);

    const gate = page.getByRole('region', {
      name: /Review gate/i,
    });
    await expect(gate).toBeVisible();

    // Not `toBeVisible` — Playwright scrolls into view before checking, so a
    // gate below the fold passes that. This asks whether it was already in
    // the viewport, which is the actual claim.
    const box = await gate.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeLessThan(viewport!.height);

    await expect(gate).toContainText('Approve');
    await expect(gate).toContainText('start the build');
    await expect(gate).toContainText('Request changes');
  });

  test('marks the gate in the rail as stopped, not as working', async ({
    page,
  }) => {
    await openRun(page, AT_GATE);
    const stages = page
      .getByLabel('Pipeline status')
      .locator('.pipe-rail__stage');
    await expect(stages.nth(3)).toHaveClass(/pipe-rail__stage--gate/);
    // A stage waiting on a human is not a stage in progress. Rendering both
    // the same way tells the founder to wait when the run is waiting on them.
    await expect(stages.nth(3)).not.toHaveClass(/pipe-rail__stage--active/);
  });

  test('offers a change request that has to say something', async ({
    page,
  }) => {
    await openRun(page, AT_GATE);
    const gate = page.getByRole('region', { name: /Review gate/i });

    await gate.getByRole('button', { name: /Request changes/i }).click();
    const send = gate.getByRole('button', { name: /Send back to Design/i });
    await expect(send).toBeDisabled();

    await gate.getByRole('textbox').fill('Use Postgres, not SQLite.');
    await expect(send).toBeEnabled();
  });
});

test.describe('errors say what failed, where, and what to do', () => {
  test('names the stage and a remedy instead of a bare message', async ({
    page,
  }) => {
    await openRun(page, [
      {
        type: 'pipeline:context',
        projectId: PROJECT_ID,
        startedAt: startedAt(),
      },
      { type: 'step:complete', step: 1, agent: 'researcher' },
      { type: 'step:start', step: 2, agent: 'auditor' },
      {
        type: 'error',
        step: 2,
        message: '429 Too Many Requests from the auditor provider',
      },
    ]);

    const panel = page.getByRole('alert');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Audit');

    // The raw message survives under the explanation — it is the only part a
    // support conversation can act on.
    await expect(panel).toContainText('429 Too Many Requests');
    await expect(panel).toContainText(/Wait a minute/i);
    await expect(
      panel.getByRole('button', { name: /Retry the run/i })
    ).toBeVisible();
  });
});
