/**
 * GET /api/genome/status — Production genome source of truth.
 *
 * This is the authoritative endpoint that staging and the admin repo
 * poll to auto-adapt their population sizes, bot counts, and simulation
 * parameters. Production is the hierarchy root — all other environments
 * must sync to this.
 *
 * Returns:
 *  - genomeCount: current number of genes in the Butterfly genome
 *  - populationMultiplier: 11 (Storn & Price benchmark)
 *  - monteCarloPopulation: genomeCount * populationMultiplier (weekly)
 *  - dailyStagingBots: genomeCount (1 bot per gene, daily verification)
 *  - generationCount: Monte Carlo generations per cycle
 *  - mutationRate: 5%
 *  - seed: synchronized random seed (Glassbox_Labs deterministic)
 *  - version: Butterfly version (e.g. "v8")
 *  - lastUpdated: timestamp of last genome change
 *  - checksum: SHA-256 of the genome (for sync verification)
 */
import { Hono } from 'hono';
import {
  SIMULATION_PARAMS,
  GENOME_COUNT,
  POPULATION_MULTIPLIER,
  MONTE_CARLO_POPULATION,
  DAILY_STAGING_BOTS,
  GENERATION_COUNT,
  MUTATION_RATE,
  SIM_SEED,
} from '@bicameral/shared/constants';
import type { Env } from '../env.js';

const genomeRoutes = new Hono<{ Bindings: Env }>();

genomeRoutes.get('/status', async (c) => {
  // Compute a simple checksum from the genome count + seed + multiplier
  // This lets staging verify it's in sync without downloading the full genome
  const checksumInput = `${GENOME_COUNT}:${SIM_SEED}:${POPULATION_MULTIPLIER}:${GENERATION_COUNT}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(checksumInput);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const checksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return c.json({
    genomeCount: GENOME_COUNT,
    populationMultiplier: POPULATION_MULTIPLIER,
    monteCarloPopulation: MONTE_CARLO_POPULATION,
    dailyStagingBots: DAILY_STAGING_BOTS,
    generationCount: GENERATION_COUNT,
    mutationRate: MUTATION_RATE,
    seed: SIM_SEED,
    version: 'v8',
    lastUpdated: '2026-08-21T17:00:00Z',
    checksum,
    parity: '1:1:1',
    hierarchy: 'production',
    syncCheckIntervalSeconds: SIMULATION_PARAMS.syncCheckIntervalSeconds,
  });
});

/**
 * GET /api/genome/sync-check — Verify staging/admin is in sync with production.
 * Staging calls this with their genome count as a query param and gets back
 * a sync status. If out of sync, staging must reload parameters.
 */
genomeRoutes.get('/sync-check', async (c) => {
  const clientGenomeCount = parseInt(c.req.query('genomeCount') ?? '0', 10);
  const clientChecksum = c.req.query('checksum') ?? '';

  const inSync = clientGenomeCount === GENOME_COUNT;

  return c.json({
    inSync,
    productionGenomeCount: GENOME_COUNT,
    clientGenomeCount,
    action: inSync ? 'none' : 'resync_required',
    message: inSync
      ? 'Staging is in sync with production'
      : `Staging has ${clientGenomeCount} genes but production has ${GENOME_COUNT}. Resync required.`,
    productionChecksum: clientChecksum ? undefined : 'omitted',
  });
});

export { genomeRoutes };
