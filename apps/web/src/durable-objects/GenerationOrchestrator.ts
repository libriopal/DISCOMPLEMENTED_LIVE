/**
 * GenerationOrchestrator — Durable Object that drives the 5-agent
 * consensus pipeline:
 *
 *   [Researcher] → [Auditor] → [Veriﬁer] → [Designer] → [Coder]
 *
 * State machine:
 *   idle → researching → auditing → verifying → designing →
 *   awaiting_approval → implementing → scanning → deployed → error
 *
 * Inter-agent gates between every step. Execution modes:
 *   ask_first   — pause at every gate, require user approval
 *   auto_accept — auto-advance through gates, log everything
 *
 * This header used to list a third mode, `dangerously_automated`, eight lines
 * above the code that collapsed it into the second one. It has been deleted —
 * see ExecutionMode in @bicameral/shared for why.
 *
 * The approval gate (awaiting_approval) sits between Designer and Coder —
 * it always pauses regardless of execution mode (code generation is the
 * expensive, hard-to-reverse step). Inter-agent gates (between steps 1-2,
 * 2-3, 3-4) only pause in `ask_first` mode.
 *
 * The Group Chat UI reads agent_messages (published via publishAgentMessage)
 * to show all 5 agents' reasoning, outputs, and consensus states in a single
 * shared thread.
 */
import { DurableObject } from 'cloudflare:workers';
import type {
  ProjectBrief,
  ProjectFile,
  ResearchFindings,
  SystemBlueprint,
  AgentRole,
  SubscriptionTier,
} from '@bicameral/shared';
import { normalizeExecutionMode } from '@bicameral/shared/types';
import { PIPELINE_DEFAULTS } from '@bicameral/shared/constants';
// Step records store the model that ran. Resolve it from the router instead
// of a literal — the literal 'command-a-03-2025' stayed behind when the
// router moved to command-a-reasoning-08-2025 (finding M-19), so every
// persisted record said the wrong thing. runX() below dispatch through
// callAgentModel(role, 'simple', ...), so these arguments match.
import { selectModel } from '../lib/cohere.js';
import { runArchitect } from '../pipeline/agents/architect.js';
import { runResearcher } from '../pipeline/agents/researcher.js';
import { runAuditor, type AuditResult } from '../pipeline/agents/auditor.js';
import {
  runVerifier,
  type VerificationResult,
} from '../pipeline/agents/verifier.js';
import { runDesigner } from '../pipeline/agents/designer.js';
import {
  runCoder,
  type CoderIterationResult,
} from '../pipeline/agents/coder.js';
import { describeFindings } from '../pipeline/audit-summary.js';
import { enrichLattice } from '../pipeline/lattice-enrich.js';
import { expireGateIfPending } from '../pipeline/gates.js';
import { finalizeGeneration } from '../pipeline/finalize-generation.js';
import { dispatchSecurityGateWorkflow } from '../pipeline/tools/security-scan-gh.js';
import type { Env } from '../env.js';

interface PipelineRunRow {
  id: string;
  user_id: string;
  project_id: string | null;
  prompt: string;
  status: string;
  execution_mode: string | null;
  current_gate: string | null;
  gate_feedback: string | null;
  pending_security_errors: string | null;
  brief: string | null;
  research: string | null;
  audit_result: string | null;
  verification_result: string | null;
  security_retry_count: number;
  // Iterative Agent Loop state (Migration 022)
  research_brief: string | null;
  iteration_count: number | null;
  pipeline_phase: string | null;
  gate_results: string | null;
  final_verdict: string | null;
}

interface UserTierRow {
  tier: SubscriptionTier;
}

export class GenerationOrchestrator extends DurableObject<Env> {
  private static readonly SECURITY_GATE_TIMEOUT_MS = 3 * 60 * 1000;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/run') {
      this.ctx.waitUntil(
        this.runPipeline().catch((err) => this.recordFailure(err))
      );
      return new Response('accepted', { status: 202 });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const gateExpired = await expireGateIfPending(
      this.env.DB,
      this.pipelineRunId()
    );
    if (gateExpired) return;

    const run = await this.loadRun();
    if (run && run.status === 'scanning') {
      console.warn(
        'Security gate timeout — auto-finalizing',
        this.pipelineRunId()
      );
      await this.autoFinalizeStuckScan(run);
    }
  }

  private pipelineRunId(): string {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private async loadRun(): Promise<PipelineRunRow | null> {
    return this.env.DB.prepare('SELECT * FROM pipeline_runs WHERE id = ?')
      .bind(this.pipelineRunId())
      .first<PipelineRunRow>();
  }

  private async recordFailure(err: unknown) {
    const message = err instanceof Error ? err.message : 'Pipeline failed';
    await this.env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'error', error_message = ?, updated_date = ? WHERE id = ?"
    )
      .bind(message, new Date().toISOString(), this.pipelineRunId())
      .run();
  }

  // ============ GROUP CHAT: publish agent messages ============

  private async publishAgentMessage(
    step: AgentRole,
    messageType: 'reasoning' | 'output' | 'consensus' | 'error' | 'gate',
    // `tool` rows exist too, written by lib/tool-record.ts from inside the
    // agents themselves — the orchestrator does not call the tools, so it is
    // not the thing that can honestly report them.
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO agent_messages (id, pipeline_run_id, step, message_type, content, metadata, created_at, created_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        this.pipelineRunId(),
        step,
        messageType,
        content,
        metadata ? JSON.stringify(metadata) : null,
        now,
        now
      )
      .run();
  }

  // ============ GATE LOGIC ============

  private shouldPauseAtGate(run: PipelineRunRow): boolean {
    // normalizeExecutionMode rather than a cast: execution_mode is a TEXT
    // column, so the cast asserted a shape the database does not enforce, and
    // rows written before `dangerously_automated` was retired still hold it.
    return normalizeExecutionMode(run.execution_mode) === 'ask_first';
  }

  /** Set the gate state and return true if the pipeline should pause. */
  private async setGate(
    run: PipelineRunRow,
    agent: AgentRole,
    summary: string
  ): Promise<boolean> {
    await this.publishAgentMessage(
      agent,
      'gate',
      `Gate: ${agent} complete. ${summary}`
    );

    if (this.shouldPauseAtGate(run)) {
      await this.env.DB.prepare(
        'UPDATE pipeline_runs SET current_gate = ?, updated_date = ? WHERE id = ?'
      )
        .bind(agent, new Date().toISOString(), this.pipelineRunId())
        .run();
      return true; // pause
    }
    return false; // auto-advance
  }

  // ============ PIPELINE ENTRY POINT ============

  async runPipeline(): Promise<void> {
    const run = await this.loadRun();
    if (!run) return;

    // Fresh start or resuming from gate approval
    if (
      run.status === 'pending' ||
      run.status === 'ideating' ||
      run.status === 'researching'
    ) {
      await this.runResearcherStep(run);
      return;
    }

    // Resume from auditor gate
    if (run.status === 'auditing') {
      await this.runAuditorStep(run);
      return;
    }

    // Resume from verifier gate
    if (run.status === 'verifying') {
      await this.runVerifierStep(run);
      return;
    }

    // Resume from designer (main gate before Coder)
    if (run.status === 'designing' || run.status === 'awaiting_approval') {
      await this.runDesignerStep(run);
      return;
    }

    // Resume from coder (after approval)
    if (run.status === 'implementing') {
      await this.runCoderStep(run);
      return;
    }
  }

  // ============ STEP 1: RESEARCHER (creates brief + researches) ============

  private async runResearcherStep(run: PipelineRunRow): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `UPDATE pipeline_runs
       SET status = 'researching', current_step = 1, current_agent = 'researcher',
           pipeline_phase = 'research',
           iteration_count = CASE WHEN COALESCE(iteration_count, 0) = 0 THEN 1 ELSE iteration_count END,
           updated_date = ?
       WHERE id = ?`
    )
      .bind(now, this.pipelineRunId())
      .run();

    await this.publishAgentMessage(
      'researcher',
      'reasoning',
      `Starting research for: "${run.prompt.slice(0, 200)}"`
    );

    // The tier has to be resolved before the step row is written: `model_used`
    // is what the admin panel and every post-mortem read back, and a tier-less
    // selectModel() records the pro model for an enterprise run that in fact
    // dispatched command-a-plus. Chasing a 429 against the wrong model name is
    // exactly the wrong turn that lie causes.
    const tier = await this.userTier(run.user_id);

    const stepId = await this.startStep(
      1,
      'researcher',
      selectModel('researcher', 'simple', tier),
      1
    );

    try {
      // Step 1a: Create structured brief (was Architect's job)
      const briefResult = await runArchitect(
        run.prompt,
        this.env,
        run.project_id,
        run.gate_feedback,
        tier
      );
      const brief = briefResult.brief;
      let totalTokensIn = briefResult.tokensIn;
      let totalTokensOut = briefResult.tokensOut;

      await this.publishAgentMessage(
        'researcher',
        'reasoning',
        `Brief created: ${brief.appName} (${brief.complexity}, ${brief.estimatedComponents} components). Starting research.`
      );

      // Step 1b: Research patterns based on the brief
      const researchResult = await runResearcher(brief, this.env, {
        userId: run.user_id,
        tier,
        pipelineRunId: this.pipelineRunId(),
      });
      const research = researchResult.research;
      totalTokensIn += researchResult.tokensIn;
      totalTokensOut += researchResult.tokensOut;

      await this.completeStep(
        stepId,
        { brief, research },
        totalTokensIn,
        totalTokensOut
      );
      await this.publishAgentMessage(
        'researcher',
        'output',
        `Research complete. App: ${brief.appName} (${brief.complexity}). ${research.similarProjects.length} similar projects, ${research.techStack.length} tech stack recs.`,
        { brief, research }
      );

      // Persist brief and research to D1
      await this.env.DB.prepare(
        `UPDATE pipeline_runs
         SET brief = ?, research = ?, research_brief = ?,
             total_tokens_in = total_tokens_in + ?, total_tokens_out = total_tokens_out + ?,
             pipeline_phase = 'audit',
             updated_date = ?
         WHERE id = ?`
      )
        .bind(
          JSON.stringify(brief),
          JSON.stringify(research),
          JSON.stringify({ brief, research }),
          totalTokensIn,
          totalTokensOut,
          new Date().toISOString(),
          this.pipelineRunId()
        )
        .run();

      // Enrich lattice
      await enrichLattice(
        this.env,
        run.project_id,
        this.pipelineRunId(),
        1,
        'researcher',
        `Research: ${brief.appName}`,
        { patternCount: research.similarProjects.length },
        {}
      );

      // Gate: check if we should pause before Auditor
      const paused = await this.setGate(
        run,
        'researcher',
        `${research.similarProjects.length} similar projects, complexity: ${brief.complexity}`
      );
      if (paused) {
        await this.env.DB.prepare(
          "UPDATE pipeline_runs SET status = 'awaiting_approval', updated_date = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), this.pipelineRunId())
          .run();
        return;
      }

      // Auto-advance to Auditor
      await this.runAuditorStep(run);
    } catch (err) {
      await this.failStep(
        stepId,
        err instanceof Error ? err.message : 'Researcher failed'
      );
      await this.publishAgentMessage(
        'researcher',
        'error',
        `Research failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      throw err;
    }
  }

  // ============ STEP 2: AUDITOR ============

  private async runAuditorStep(_run: PipelineRunRow): Promise<void> {
    // Reload the run from D1 — the previous step may have written brief/research
    const run = await this.loadRun();
    if (!run) return;

    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'auditing', current_step = 2, current_agent = 'auditor', updated_date = ? WHERE id = ?"
    )
      .bind(now, this.pipelineRunId())
      .run();

    if (!run.brief || !run.research) {
      await this.recordFailure(new Error('No brief/research found for audit'));
      return;
    }

    const brief: ProjectBrief = JSON.parse(run.brief);
    const research: ResearchFindings = JSON.parse(run.research);

    await this.publishAgentMessage(
      'auditor',
      'reasoning',
      'Auditing research findings for coverage, bias, and feasibility.'
    );

    // Resolved before startStep so the recorded model matches the dispatched
    // one — see the note in the researcher step.
    const tier = await this.userTier(run.user_id);

    const stepId = await this.startStep(
      2,
      'auditor',
      selectModel('auditor', 'simple', tier, this.env),
      1
    );

    try {
      const { audit, tokensIn, tokensOut } = await runAuditor(
        brief,
        research,
        this.env,
        run.gate_feedback,
        run.project_id,
        tier
      );

      await this.completeStep(
        stepId,
        audit as unknown as Record<string, unknown>,
        tokensIn,
        tokensOut
      );
      await this.publishAgentMessage(
        'auditor',
        'output',
        // Counts, not a score. `Coverage: 87%` used to lead this line; see
        // auditor.ts for why it is gone. The severity breakdown says more
        // anyway — "2 critical" is actionable in a way that "87%" never was.
        `Audit ${audit.passed ? 'PASSED' : 'FAILED'}. ${describeFindings(audit.findings)}`,
        audit as unknown as Record<string, unknown>
      );

      await this.env.DB.prepare(
        'UPDATE pipeline_runs SET audit_result = ?, total_tokens_in = total_tokens_in + ?, total_tokens_out = total_tokens_out + ?, updated_date = ? WHERE id = ?'
      )
        .bind(
          JSON.stringify(audit),
          tokensIn,
          tokensOut,
          new Date().toISOString(),
          this.pipelineRunId()
        )
        .run();

      await enrichLattice(
        this.env,
        run.project_id,
        this.pipelineRunId(),
        2,
        'auditor',
        `Audit: ${audit.passed ? 'passed' : 'failed'}`,
        { findings: audit.findings.length },
        {}
      );

      // Force a gate regardless of execution mode when the audit failed, OR
      // when it reported a critical finding while still setting passed: true.
      //
      // Those are not the same condition, and only the first used to be
      // checked. `passed` and `findings` are two independent fields of one
      // model response, and nothing reconciles them — a model that lists a
      // critical gap and then answers "passed": true is producing a coherent
      // response by its own lights, and the run proceeded past a critical
      // finding without pausing. The severity is the auditor's own judgement
      // about consequence; the boolean is its judgement about whether that
      // consequence should stop anything. Only the first is evidence.
      const criticalFindings = audit.findings.filter(
        (f) => f.severity === 'critical'
      );
      if (!audit.passed || criticalFindings.length > 0) {
        await this.publishAgentMessage(
          'auditor',
          'gate',
          audit.passed
            ? `Audit reported passed but raised ${criticalFindings.length} critical finding(s) — forcing gate.`
            : `Audit FAILED — forcing gate. ${criticalFindings.length} critical findings.`
        );
        await this.env.DB.prepare(
          "UPDATE pipeline_runs SET status = 'awaiting_approval', current_gate = 'auditor', updated_date = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), this.pipelineRunId())
          .run();
        return;
      }

      // Gate: check if we should pause before Verifier
      const paused = await this.setGate(
        run,
        'auditor',
        describeFindings(audit.findings)
      );
      if (paused) {
        await this.env.DB.prepare(
          `UPDATE pipeline_runs
           SET status = 'awaiting_approval', gate_results = ?,
               pipeline_phase = 'audit', updated_date = ?
           WHERE id = ?`
        )
          .bind(
            JSON.stringify({ researcher: true, auditor: null }),
            new Date().toISOString(),
            this.pipelineRunId()
          )
          .run();
        return;
      }

      // Auto-advance to Verifier
      await this.runVerifierStep(run);
    } catch (err) {
      await this.failStep(
        stepId,
        err instanceof Error ? err.message : 'Auditor failed'
      );
      await this.publishAgentMessage(
        'auditor',
        'error',
        `Audit failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      throw err;
    }
  }

  // ============ STEP 3: VERIFIER ============

  private async runVerifierStep(_run: PipelineRunRow): Promise<void> {
    // Reload the run from D1 — the previous step may have written audit_result
    const run = await this.loadRun();
    if (!run) return;

    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'verifying', current_step = 3, current_agent = 'verifier', updated_date = ? WHERE id = ?"
    )
      .bind(now, this.pipelineRunId())
      .run();

    if (!run.brief || !run.research) {
      await this.recordFailure(
        new Error('No brief/research found for verification')
      );
      return;
    }

    const brief: ProjectBrief = JSON.parse(run.brief);
    const research: ResearchFindings = JSON.parse(run.research);
    const audit: AuditResult | null = run.audit_result
      ? JSON.parse(run.audit_result)
      : null;

    await this.publishAgentMessage(
      'verifier',
      'reasoning',
      'Verifying context limits and external dependencies.'
    );

    // Resolved before startStep so the recorded model matches the dispatched
    // one — see the note in the researcher step.
    const tier = await this.userTier(run.user_id);

    const stepId = await this.startStep(
      3,
      'verifier',
      selectModel('verifier', 'simple', tier),
      1
    );

    try {
      const { verification, tokensIn, tokensOut } = await runVerifier(
        brief,
        research,
        audit?.summary ?? 'No audit available',
        this.env,
        run.gate_feedback,
        run.project_id,
        tier
      );

      await this.completeStep(
        stepId,
        verification as unknown as Record<string, unknown>,
        tokensIn,
        tokensOut
      );
      await this.publishAgentMessage(
        'verifier',
        'output',
        `Verification ${verification.passed ? 'PASSED' : 'FAILED'}. Max files: ${verification.contextCheck.maxRecommendedFiles}. ${verification.constraints.length} constraints.`,
        verification as unknown as Record<string, unknown>
      );

      await this.env.DB.prepare(
        'UPDATE pipeline_runs SET verification_result = ?, total_tokens_in = total_tokens_in + ?, total_tokens_out = total_tokens_out + ?, updated_date = ? WHERE id = ?'
      )
        .bind(
          JSON.stringify(verification),
          tokensIn,
          tokensOut,
          new Date().toISOString(),
          this.pipelineRunId()
        )
        .run();

      await enrichLattice(
        this.env,
        run.project_id,
        this.pipelineRunId(),
        3,
        'verifier',
        `Verification: ${verification.passed ? 'passed' : 'failed'}`,
        { maxFiles: verification.contextCheck.maxRecommendedFiles },
        {}
      );

      // Gate: check if we should pause before Designer
      const paused = await this.setGate(
        run,
        'verifier',
        `Max files: ${verification.contextCheck.maxRecommendedFiles}, ${verification.constraints.length} constraints`
      );
      if (paused) {
        await this.env.DB.prepare(
          "UPDATE pipeline_runs SET status = 'awaiting_approval', updated_date = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), this.pipelineRunId())
          .run();
        return;
      }

      // Auto-advance to Designer
      await this.runDesignerStep(run);
    } catch (err) {
      await this.failStep(
        stepId,
        err instanceof Error ? err.message : 'Verifier failed'
      );
      await this.publishAgentMessage(
        'verifier',
        'error',
        `Verification failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      throw err;
    }
  }

  // ============ STEP 4: DESIGNER ============

  private async runDesignerStep(_run: PipelineRunRow): Promise<void> {
    // Reload the run from D1 — the previous step may have written verification_result
    const run = await this.loadRun();
    if (!run) return;

    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'designing', current_step = 4, current_agent = 'designer', updated_date = ? WHERE id = ?"
    )
      .bind(now, this.pipelineRunId())
      .run();

    if (!run.brief) {
      await this.recordFailure(new Error('No brief found for design'));
      return;
    }

    const brief: ProjectBrief = JSON.parse(run.brief);
    const research: ResearchFindings = run.research
      ? JSON.parse(run.research)
      : { patterns: [], citations: [], recommendations: [] };
    const verification: VerificationResult | null = run.verification_result
      ? JSON.parse(run.verification_result)
      : null;

    await this.publishAgentMessage(
      'designer',
      'reasoning',
      `Creating implementation blueprint for ${brief.appName}. ${verification ? `Following ${verification.constraints.length} constraints.` : ''}`
    );

    // Resolved before startStep so the recorded model matches the dispatched
    // one — see the note in the researcher step.
    const tier = await this.userTier(run.user_id);

    const stepId = await this.startStep(
      4,
      'designer',
      selectModel('designer', 'simple', tier),
      1
    );

    try {
      const { blueprint, tokensIn, tokensOut } = await runDesigner(
        brief,
        research,
        this.env,
        run.gate_feedback,
        // Pass verification constraints to the Designer
        verification?.constraints,
        run.project_id,
        tier
      );

      await this.completeStep(stepId, blueprint, tokensIn, tokensOut);
      await this.publishAgentMessage(
        'designer',
        'output',
        `Blueprint complete. ${blueprint.components.length} components, ${blueprint.apiRoutes.length} API routes.`,
        { componentCount: blueprint.components.length }
      );

      // Persist blueprint
      await this.env.DB.prepare(
        `INSERT INTO blueprints (id, pipeline_run_id, version, components, database_schema, api_routes, auth_strategy, env_vars, deploy_config, created_date, updated_date)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          this.pipelineRunId(),
          JSON.stringify(blueprint.components),
          JSON.stringify(blueprint.database),
          JSON.stringify(blueprint.apiRoutes),
          blueprint.authStrategy,
          JSON.stringify(blueprint.envVars),
          JSON.stringify(blueprint.deployConfig),
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();

      await this.env.DB.prepare(
        "UPDATE pipeline_runs SET status = 'awaiting_approval', gate_status = 'pending', blueprint_id = (SELECT id FROM blueprints WHERE pipeline_run_id = ? ORDER BY version DESC LIMIT 1), total_tokens_in = total_tokens_in + ?, total_tokens_out = total_tokens_out + ?, updated_date = ? WHERE id = ?"
      )
        .bind(
          this.pipelineRunId(),
          tokensIn,
          tokensOut,
          new Date().toISOString(),
          this.pipelineRunId()
        )
        .run();

      await enrichLattice(
        this.env,
        run.project_id,
        this.pipelineRunId(),
        4,
        'designer',
        `Blueprint: ${brief.appName}`,
        { components: blueprint.components.length },
        {}
      );

      await this.publishAgentMessage(
        'designer',
        'gate',
        'Blueprint ready for approval. Review before code generation begins.'
      );

      // Set approval timeout alarm
      await this.ctx.storage.setAlarm(
        Date.now() + PIPELINE_DEFAULTS.approvalGateTimeoutMs
      );
    } catch (err) {
      await this.failStep(
        stepId,
        err instanceof Error ? err.message : 'Designer failed'
      );
      await this.publishAgentMessage(
        'designer',
        'error',
        `Design failed: ${err instanceof Error ? err.message : 'unknown'}`
      );
      throw err;
    }
  }

  // ============ STEP 5: CODER ============

  private async runCoderStep(run: PipelineRunRow): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "UPDATE pipeline_runs SET status = 'implementing', current_step = 5, current_agent = 'coder', updated_date = ? WHERE id = ?"
    )
      .bind(now, this.pipelineRunId())
      .run();

    const briefRow = await this.env.DB.prepare(
      'SELECT brief FROM pipeline_runs WHERE id = ?'
    )
      .bind(this.pipelineRunId())
      .first<{ brief: string | null }>();
    const brief: ProjectBrief | null = briefRow?.brief
      ? JSON.parse(briefRow.brief)
      : null;

    const blueprintRow = await this.env.DB.prepare(
      'SELECT * FROM blueprints WHERE pipeline_run_id = ? ORDER BY version DESC LIMIT 1'
    )
      .bind(this.pipelineRunId())
      .first<{
        components: string;
        database_schema: string;
        api_routes: string;
        auth_strategy: string;
        env_vars: string;
        deploy_config: string;
      }>();
    if (!blueprintRow) {
      await this.recordFailure(
        new Error('No approved blueprint found for implementation')
      );
      return;
    }

    const blueprint: SystemBlueprint = {
      components: JSON.parse(blueprintRow.components),
      database: JSON.parse(blueprintRow.database_schema),
      apiRoutes: JSON.parse(blueprintRow.api_routes),
      authStrategy: blueprintRow.auth_strategy,
      envVars: JSON.parse(blueprintRow.env_vars),
      deployConfig: JSON.parse(blueprintRow.deploy_config),
    };
    const complexity = brief?.complexity ?? 'simple';

    const pendingSecurityErrors: string[] = run.pending_security_errors
      ? JSON.parse(run.pending_security_errors)
      : [];

    await this.publishAgentMessage(
      'coder',
      'reasoning',
      `Starting code generation. ${blueprint.components.length} components, complexity: ${complexity}.`
    );

    try {
      const onIteration = async (iter: CoderIterationResult) => {
        const stepId = await this.startStep(
          5,
          'coder',
          iter.model,
          iter.iteration
        );
        await this.completeStep(
          stepId,
          {
            errors: iter.errors,
            fixed: iter.fixed,
            fileCount: iter.files.length,
          },
          iter.tokensIn,
          iter.tokensOut
        );

        await this.publishAgentMessage(
          'coder',
          'reasoning',
          `Iteration ${iter.iteration}: ${iter.files.length} files, ${iter.errors.length} errors${iter.fixed ? ' — FIXED' : ''}.`
        );

        await enrichLattice(
          this.env,
          run.project_id,
          this.pipelineRunId(),
          5,
          'coder',
          `Code iteration ${iter.iteration}`,
          { errors: iter.errors, fileCount: iter.files.length },
          { nodeType: iter.errors.length > 0 ? 'bridge' : undefined }
        );
      };

      const result = await runCoder(blueprint, complexity, this.env, {
        bucket: this.env.BUCKET,
        pipelineRunId: this.pipelineRunId(),
        projectId: run.project_id,
        tier: await this.userTier(run.user_id),
        onIteration,
        initialErrors:
          pendingSecurityErrors.length > 0 ? pendingSecurityErrors : undefined,
      });

      await this.env.DB.prepare(
        'UPDATE pipeline_runs SET pending_security_errors = NULL WHERE id = ?'
      )
        .bind(this.pipelineRunId())
        .run();

      if (!result.success) {
        const lastIteration = result.iterations[result.iterations.length - 1];
        await this.publishAgentMessage(
          'coder',
          'error',
          `Reached ${PIPELINE_DEFAULTS.maxCoderIterations} iterations with unresolved errors.`
        );
        await finalizeGeneration(this.env, {
          pipelineRunId: this.pipelineRunId(),
          projectId: run.project_id,
          userId: run.user_id,
          prompt: run.prompt,
          model: result.model,
          files: result.files,
          tokensIn: result.totalTokensIn,
          tokensOut: result.totalTokensOut,
          warning: `Reached ${PIPELINE_DEFAULTS.maxCoderIterations} iterations with unresolved errors: ${(lastIteration?.errors ?? []).join('; ')}`,
        });
        return;
      }

      await this.publishAgentMessage(
        'coder',
        'consensus',
        `Code generation complete. ${result.files.length} files generated. Submitting to security gate.`
      );

      // Security gate
      const scanId = crypto.randomUUID();
      await this.env.DB.prepare(
        `INSERT INTO security_gate_runs (id, pipeline_run_id, status, files, model, tokens_in, tokens_out, created_date)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
      )
        .bind(
          scanId,
          this.pipelineRunId(),
          JSON.stringify(result.files),
          result.model,
          result.totalTokensIn,
          result.totalTokensOut,
          new Date().toISOString()
        )
        .run();

      await this.env.DB.prepare(
        "UPDATE pipeline_runs SET status = 'scanning', updated_date = ? WHERE id = ?"
      )
        .bind(new Date().toISOString(), this.pipelineRunId())
        .run();

      try {
        await dispatchSecurityGateWorkflow(
          this.env,
          this.pipelineRunId(),
          scanId
        );
        await this.ctx.storage.setAlarm(
          Date.now() + GenerationOrchestrator.SECURITY_GATE_TIMEOUT_MS
        );
      } catch (err) {
        console.error(
          'Failed to dispatch security-gate workflow',
          this.pipelineRunId(),
          err
        );
        await this.env.DB.prepare(
          "UPDATE security_gate_runs SET status = 'error', error_message = ?, completed_at = ? WHERE id = ?"
        )
          .bind(
            err instanceof Error ? err.message : 'Dispatch failed',
            new Date().toISOString(),
            scanId
          )
          .run();
        await finalizeGeneration(this.env, {
          pipelineRunId: this.pipelineRunId(),
          projectId: run.project_id,
          userId: run.user_id,
          prompt: run.prompt,
          model: result.model,
          files: result.files,
          tokensIn: result.totalTokensIn,
          tokensOut: result.totalTokensOut,
          warning:
            'Security gate could not be started — deployed without a scan',
        });
      }
    } catch (err) {
      await this.recordFailure(err);
      throw err;
    }
  }

  // ============ SECURITY GATE TIMEOUT ============

  private async autoFinalizeStuckScan(run: PipelineRunRow): Promise<void> {
    const scanRow = await this.env.DB.prepare(
      'SELECT files, model, tokens_in, tokens_out FROM security_gate_runs WHERE pipeline_run_id = ? AND status = ? ORDER BY created_date DESC LIMIT 1'
    )
      .bind(this.pipelineRunId(), 'pending')
      .first<{
        files: string;
        model: string;
        tokens_in: number;
        tokens_out: number;
      }>();

    if (!scanRow) {
      await this.recordFailure(
        new Error('Security gate timed out and no scan data found')
      );
      return;
    }

    await this.env.DB.prepare(
      "UPDATE security_gate_runs SET status = 'timeout', error_message = 'Auto-finalized after 3 min timeout', completed_at = ? WHERE pipeline_run_id = ? AND status = 'pending'"
    )
      .bind(new Date().toISOString(), this.pipelineRunId())
      .run();

    const files = JSON.parse(scanRow.files) as ProjectFile[];
    await finalizeGeneration(this.env, {
      pipelineRunId: this.pipelineRunId(),
      projectId: run.project_id,
      userId: run.user_id,
      prompt: run.prompt,
      model: scanRow.model,
      files,
      tokensIn: scanRow.tokens_in,
      tokensOut: scanRow.tokens_out,
      warning: 'Security gate timed out — deployed without scan',
    });
  }

  // ============ STEP HELPERS ============

  private async startStep(
    stepNumber: number,
    agentRole: string,
    model: string,
    iteration: number
  ): Promise<string> {
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO pipeline_steps (id, pipeline_run_id, step_number, agent_role, model_used, status, iteration, started_at, created_date, created_by)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, 'system')`
    )
      .bind(
        stepId,
        this.pipelineRunId(),
        stepNumber,
        agentRole,
        model,
        iteration,
        now,
        now
      )
      .run();
    return stepId;
  }

  private async completeStep(
    stepId: string,
    output: unknown,
    tokensIn: number,
    tokensOut: number
  ): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE pipeline_steps SET status = 'completed', output = ?, tokens_in = ?, tokens_out = ?, completed_at = ? WHERE id = ?`
    )
      .bind(
        JSON.stringify(output),
        tokensIn,
        tokensOut,
        new Date().toISOString(),
        stepId
      )
      .run();
  }

  private async failStep(stepId: string, message: string): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE pipeline_steps SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?"
    )
      .bind(message, new Date().toISOString(), stepId)
      .run();
  }

  private async userTier(userId: string): Promise<UserTierRow['tier']> {
    const row = await this.env.DB.prepare('SELECT tier FROM users WHERE id = ?')
      .bind(userId)
      .first<UserTierRow>();
    return row?.tier ?? 'free';
  }
}
