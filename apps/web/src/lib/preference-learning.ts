/**
 * Preference Learning — nightly clustering of correction texts into
 * project rules. Threshold-based agglomerative clustering with cosine
 * similarity >= 0.85 and minimum cluster size of 3.
 *
 * Runs via cron at 0 4 * * * UTC. See PHASE-0-PREFLIGHT.md "Preference
 * Learning" and 04_DATA_SCHEMA_CONTRACT/schema-contract.yaml.
 */
import type { Env } from '../env.js';

export interface PreferenceMatrixEntry {
  id: string;
  project_id: string;
  feature: string;
  weight: number;
  accept_count: number;
  reject_count: number;
  updated_date: string;
}

export interface PreferenceCorrection {
  id: string;
  project_id: string;
  feature: string;
  correction_text: string;
  embedding: string | null;
  embedding_model: string;
  source_pipeline_run_id: string | null;
  created_date: string;
}

export interface ProjectRule {
  id: string;
  project_id: string;
  rule_text: string;
  cluster_size: number;
  rule_hash: string;
  created_date: string;
  active: number;
}

const CLUSTER_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 3;

/**
 * Run nightly preference learning across all projects with corrections.
 * For each project: cluster corrections by cosine similarity, extract
 * rules from clusters, store them in project_rules.
 */
export async function runNightlyPreferenceLearning(env: Env): Promise<{
  projectsProcessed: number;
  rulesExtracted: number;
}> {
  const { results: projects } = await env.DB.prepare(
    `SELECT DISTINCT project_id FROM preference_corrections
     WHERE embedding IS NOT NULL
     ORDER BY project_id`
  ).all<{ project_id: string }>();

  let totalRules = 0;

  for (const { project_id } of projects) {
    const rules = await processProjectCorrections(env, project_id);
    totalRules += rules;
  }

  return {
    projectsProcessed: projects.length,
    rulesExtracted: totalRules,
  };
}

/**
 * Process corrections for a single project — cluster them and extract rules.
 */
async function processProjectCorrections(
  env: Env,
  projectId: string
): Promise<number> {
  const { results: corrections } = await env.DB.prepare(
    `SELECT id, project_id, feature, correction_text, embedding, embedding_model,
            source_pipeline_run_id, created_date
     FROM preference_corrections
     WHERE project_id = ? AND embedding IS NOT NULL
     ORDER BY created_date ASC`
  )
    .bind(projectId)
    .all<PreferenceCorrection>();

  if (corrections.length < MIN_CLUSTER_SIZE) return 0;

  const clusters = agglomerativeCluster(corrections, CLUSTER_THRESHOLD);
  let rulesCreated = 0;

  for (const cluster of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue;

    const ruleText = extractRuleText(cluster);
    const ruleHash = await sha256Hex(ruleText + projectId);

    // Check if rule already exists (idempotent)
    const existing = await env.DB.prepare(
      `SELECT id FROM project_rules WHERE project_id = ? AND rule_hash = ?`
    )
      .bind(projectId, ruleHash)
      .first<{ id: string }>();

    if (existing) continue;

    await env.DB.prepare(
      `INSERT INTO project_rules (id, project_id, rule_text, cluster_size, rule_hash, created_date, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        crypto.randomUUID(),
        projectId,
        ruleText,
        cluster.length,
        ruleHash,
        new Date().toISOString()
      )
      .run();

    rulesCreated++;
  }

  return rulesCreated;
}

/**
 * Threshold-based agglomerative clustering using cosine similarity.
 * Each correction's embedding is a JSON array of floats (1536 dims).
 */
function agglomerativeCluster(
  corrections: PreferenceCorrection[],
  threshold: number
): PreferenceCorrection[][] {
  const embeddings = corrections.map((c) => {
    try {
      return JSON.parse(c.embedding!) as number[];
    } catch {
      return [] as number[];
    }
  });

  // Start with each correction as its own cluster
  const clusters: number[][] = corrections.map((_, i) => [i]);

  // Merge clusters with highest similarity until no pair exceeds threshold
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    let bestSim = -1;
    let bestPair = [-1, -1];

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = clusterSimilarity(clusters[i], clusters[j], embeddings);
        if (sim > bestSim) {
          bestSim = sim;
          bestPair = [i, j];
        }
      }
    }

    if (bestSim >= threshold && bestPair[0] >= 0) {
      clusters[bestPair[0]] = [
        ...clusters[bestPair[0]],
        ...clusters[bestPair[1]],
      ];
      clusters.splice(bestPair[1], 1);
      merged = true;
    }
  }

  return clusters.map((cluster) => cluster.map((i) => corrections[i]));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function clusterSimilarity(
  clusterA: number[],
  clusterB: number[],
  embeddings: number[][]
): number {
  // Average linkage: average pairwise cosine similarity
  let total = 0;
  let count = 0;
  for (const i of clusterA) {
    for (const j of clusterB) {
      total += cosineSimilarity(embeddings[i], embeddings[j]);
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

/**
 * Extract a human-readable rule from a cluster of corrections.
 * Groups by feature and generates a summary rule text.
 */
function extractRuleText(cluster: PreferenceCorrection[]): string {
  const features = new Map<string, string[]>();
  for (const c of cluster) {
    if (!features.has(c.feature)) features.set(c.feature, []);
    features.get(c.feature)!.push(c.correction_text);
  }

  const parts: string[] = [];
  for (const [feature, texts] of features) {
    parts.push(`${feature}: ${texts.slice(0, 3).join('; ')}`);
  }
  return `Prefer ${parts.join('. ')}`;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Record a preference correction from a pipeline run.
 */
export async function recordCorrection(
  env: Env,
  projectId: string,
  feature: string,
  correctionText: string,
  embedding: string | null,
  sourcePipelineRunId: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO preference_corrections (id, project_id, feature, correction_text, embedding, embedding_model, source_pipeline_run_id, created_date)
     VALUES (?, ?, ?, ?, ?, 'embed-v4.0', ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      projectId,
      feature,
      correctionText,
      embedding,
      sourcePipelineRunId,
      new Date().toISOString()
    )
    .run();
}

/**
 * Update preference matrix weight based on accept/reject feedback.
 */
export async function updatePreferenceWeight(
  env: Env,
  projectId: string,
  feature: string,
  accepted: boolean
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id, accept_count, reject_count, weight FROM preference_matrix WHERE project_id = ? AND feature = ?`
  )
    .bind(projectId, feature)
    .first<{
      id: string;
      accept_count: number;
      reject_count: number;
      weight: number;
    }>();

  if (existing) {
    const acceptCount = existing.accept_count + (accepted ? 1 : 0);
    const rejectCount = existing.reject_count + (accepted ? 0 : 1);
    const total = acceptCount + rejectCount;
    const weight = total === 0 ? 0.5 : acceptCount / total;

    await env.DB.prepare(
      `UPDATE preference_matrix SET accept_count = ?, reject_count = ?, weight = ?, updated_date = ? WHERE id = ?`
    )
      .bind(
        acceptCount,
        rejectCount,
        weight,
        new Date().toISOString(),
        existing.id
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO preference_matrix (id, project_id, feature, weight, accept_count, reject_count, updated_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        projectId,
        feature,
        accepted ? 1.0 : 0.0,
        accepted ? 1 : 0,
        accepted ? 0 : 1,
        new Date().toISOString()
      )
      .run();
  }
}
