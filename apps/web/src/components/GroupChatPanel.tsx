/**
 * 5-Agent Group Chat Panel — shows the full pipeline agent thread.
 *
 * Researcher → Auditor → Verifier → Designer → Coder
 *
 * Each agent card shows:
 *  - Agent name and role
 *  - Current status (pending / running / complete / error)
 *  - Latest message from that agent
 *  - Gate status between agents (auto-advanced / awaiting approval / forced gate)
 *
 * Polls GET /api/pipeline/:id/messages for agent messages, at the founder's
 * verboseness level (§3.3). The filtering is the endpoint's — see
 * lib/verboseness.ts — and the level is sent as a query parameter so raising
 * it widens the transcript on the next poll rather than after the setting
 * round-trips.
 *
 * Each agent's status comes from the `stages` array, which the endpoint
 * returns at every level. It used to be inferred from the presence of that
 * agent's `output` message, which would have made a quiet run look
 * permanently stuck the moment those messages started being filtered — a
 * display preference silently changing what the pipeline appears to have
 * done.
 */
import { useState, useEffect, useCallback } from 'react';
import { VERBOSENESS_LEVELS, type Verboseness } from '../lib/verboseness.js';
import { ReviewGate } from './ReviewGate.js';
import { BlockSuggestions } from './BlockSuggestions.js';

export interface AgentMessage {
  id: string;
  step: string;
  agent: string;
  messageType: 'reasoning' | 'output' | 'gate' | 'error' | 'tool' | 'consensus';
  content: string;
  metadata?: Record<string, unknown> | null;
  created_date: string;
}

/** One row of `pipeline_steps`, as the transcript endpoint reports it. The
 * telemetry fields are present only at `verbose`. */
export interface PipelineStage {
  step: number;
  agent: string;
  status: string;
  iteration: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  creditsUsed?: number;
  durationMs?: number | null;
}

/** What the control calls each level, said as what the founder will see
 * rather than as a jargon word. */
const LEVEL_LABELS: Record<Verboseness, string> = {
  quiet: 'Quiet',
  normal: 'Normal',
  verbose: 'Verbose',
};

const LEVEL_HINTS: Record<Verboseness, string> = {
  quiet: 'Stage transitions and the result only',
  normal: 'Stage transitions plus each agent’s conclusion',
  verbose: 'Everything: reasoning, models, tokens and tool calls',
};

export interface AgentInfo {
  name: string;
  role: string;
  step: number;
  accent: string;
  icon: string;
}

const AGENTS: AgentInfo[] = [
  {
    name: 'Researcher',
    role: 'Discovery & Analysis',
    step: 1,
    accent: 'indigo',
    icon: '🔬',
  },
  {
    name: 'Auditor',
    role: 'Quality Gate & Coverage',
    step: 2,
    accent: 'amber',
    icon: '🛡️',
  },
  {
    name: 'Verifier',
    role: 'Dependency & Constraint Check',
    step: 3,
    accent: 'emerald',
    icon: '✓',
  },
  {
    name: 'Designer',
    role: 'Architecture & Blueprint',
    step: 4,
    accent: 'violet',
    icon: '✏️',
  },
  {
    name: 'Coder',
    role: 'Code Generation',
    step: 5,
    accent: 'pink',
    icon: '⚡',
  },
];

const ACCENT_CLASSES: Record<
  string,
  { bg: string; border: string; text: string; dot: string }
> = {
  indigo: {
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/30',
    text: 'text-indigo-400',
    dot: 'bg-indigo-500',
  },
  amber: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    text: 'text-amber-400',
    dot: 'bg-amber-500',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    text: 'text-emerald-400',
    dot: 'bg-emerald-500',
  },
  violet: {
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/30',
    text: 'text-violet-400',
    dot: 'bg-violet-500',
  },
  pink: {
    bg: 'bg-pink-500/10',
    border: 'border-pink-500/30',
    text: 'text-pink-400',
    dot: 'bg-pink-500',
  },
};

interface GroupChatPanelProps {
  pipelineId: string | null;
  currentStep: number;
  awaitingApproval: boolean;
  onApprove: (approved: boolean, feedback?: string) => void;
  executionMode?: string;
  verboseness: Verboseness;
  onVerbosenessChange: (level: Verboseness) => void;
  /** Set when saving the setting failed and it was rolled back. */
  verbosenessError?: string | null;
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function GroupChatPanel({
  pipelineId,
  currentStep,
  awaitingApproval,
  onApprove,
  executionMode,
  verboseness,
  onVerbosenessChange,
  verbosenessError,
}: GroupChatPanelProps) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);

  // Poll for agent messages
  const fetchMessages = useCallback(async () => {
    if (!pipelineId) return;
    try {
      const res = await fetch(
        `/api/pipeline/${pipelineId}/messages?verboseness=${verboseness}`,
        { credentials: 'include' }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          messages?: AgentMessage[];
          stages?: PipelineStage[];
        };
        setMessages(data.messages ?? []);
        setStages(data.stages ?? []);
      }
    } catch {
      // SSE will handle updates, polling is backup
    }
  }, [pipelineId, verboseness]);

  useEffect(() => {
    if (!pipelineId) {
      setMessages([]);
      setStages([]);
      return;
    }
    fetchMessages();
    const interval = setInterval(fetchMessages, 3000);
    return () => clearInterval(interval);
  }, [pipelineId, fetchMessages]);

  // Group messages by agent
  const messagesByAgent = AGENTS.map((agent) => {
    const role = agent.name.toLowerCase();
    const agentMsgs = messages.filter((m) => m.step === role);
    const hasGate = agentMsgs.some((m) => m.messageType === 'gate');

    // The Coder writes one row per iteration; the latest is the one whose
    // state describes the agent now.
    const agentStages = stages.filter((s) => s.agent === role);
    const stage = agentStages[agentStages.length - 1];

    // Derived from `pipeline_steps`, not from which messages this verboseness
    // level happened to return. `error` also covers a message-level error the
    // step row has not caught up with yet.
    let status: 'pending' | 'running' | 'complete' | 'error' = 'pending';
    if (agentMsgs.some((m) => m.messageType === 'error')) status = 'error';
    else if (stage?.status === 'failed') status = 'error';
    else if (stage?.status === 'completed') status = 'complete';
    else if (stage?.status === 'running') status = 'running';
    else if (currentStep > agent.step) status = 'complete';

    return { agent, messages: agentMsgs, status, hasGate, stage };
  });

  if (!pipelineId) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3 p-4 rounded-lg border border-[var(--border)] bg-[var(--card)] h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Pipeline Agents
        </h3>
        {executionMode && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--text-secondary)]">
            {executionMode === 'auto_accept' ? 'Auto-approve' : 'Ask first'}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 mb-1">
        <div
          role="radiogroup"
          aria-label="How much of the pipeline to show"
          className="flex gap-1"
        >
          {VERBOSENESS_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={verboseness === level}
              title={LEVEL_HINTS[level]}
              onClick={() => onVerbosenessChange(level)}
              className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
                verboseness === level
                  ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--accent)]/5'
              }`}
            >
              {LEVEL_LABELS[level]}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {LEVEL_HINTS[verboseness]}
        </p>
        {verbosenessError && (
          <p role="status" className="text-xs text-amber-400">
            {verbosenessError}
          </p>
        )}
      </div>

      {/* First in the panel, above every agent card. §3.4: the review gate is
          the centre of the experience, and it is the one structural claim the
          field does not make. It does not wait its turn in a scroll. */}
      {awaitingApproval && (
        <>
          <ReviewGate onDecide={(approved, fb) => onApprove(approved, fb)} />
          {/* Below the gate, never inside it: these are proposals to weigh
              while deciding, not part of what approval applies to. */}
          <BlockSuggestions
            pipelineId={pipelineId}
            enabled={awaitingApproval}
          />
        </>
      )}

      {messagesByAgent.map(
        ({ agent, messages: agentMsgs, status, hasGate, stage }) => {
          const accent = ACCENT_CLASSES[agent.accent];
          const isCurrentAgent = currentStep === agent.step;
          const isAwaitingThisGate =
            awaitingApproval && isCurrentAgent && hasGate;

          return (
            <div
              key={agent.step}
              className={`rounded-lg border p-3 transition-all ${
                isCurrentAgent
                  ? `${accent.bg} ${accent.border} ring-1 ring-${agent.accent}-500/20`
                  : 'border-[var(--border)] bg-[var(--card)]/50'
              }`}
            >
              {/* Agent header */}
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`w-2 h-2 rounded-full ${accent.dot} ${status === 'running' ? 'animate-pulse' : ''} ${status === 'pending' ? 'opacity-30' : ''}`}
                />
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {agent.name}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {agent.role}
                </span>
                <div className="ml-auto">
                  {status === 'running' && (
                    <span className={`text-xs ${accent.text}`}>● Running</span>
                  )}
                  {status === 'complete' && (
                    <span className="text-xs text-[var(--text-muted)]">
                      ✓ Done
                    </span>
                  )}
                  {status === 'error' && (
                    <span className="text-xs text-red-400">✕ Error</span>
                  )}
                  {status === 'pending' && (
                    <span className="text-xs text-[var(--text-muted)] opacity-50">
                      ○ Pending
                    </span>
                  )}
                </div>
              </div>

              {/* Which model served this step, and what it cost. Present only
                  at verbose — and only when the step has actually run, since
                  a model id on a pending step would say a dispatch happened
                  that has not. This is how a founder can see for themselves
                  that the audit step runs on a different model from the work
                  it grades. */}
              {stage?.model && (
                <dl className="ml-4 mb-2 text-xs text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-0.5">
                  <div className="flex gap-1">
                    <dt className="sr-only">Model</dt>
                    <dd className="font-mono">{stage.model}</dd>
                  </div>
                  {(stage.tokensIn ?? 0) + (stage.tokensOut ?? 0) > 0 && (
                    <div className="flex gap-1">
                      <dt>tokens</dt>
                      <dd>
                        {stage.tokensIn ?? 0} in / {stage.tokensOut ?? 0} out
                      </dd>
                    </div>
                  )}
                  {formatDuration(stage.durationMs) && (
                    <div className="flex gap-1">
                      <dt>took</dt>
                      <dd>{formatDuration(stage.durationMs)}</dd>
                    </div>
                  )}
                </dl>
              )}

              {/* Agent messages */}
              {agentMsgs.length > 0 && (
                <div className="space-y-1.5 ml-4">
                  {agentMsgs.map((msg) => (
                    <div
                      key={msg.id}
                      className="text-xs text-[var(--text-secondary)] leading-relaxed"
                    >
                      {msg.messageType === 'gate' && (
                        <div
                          className={`mt-1 px-2 py-1 rounded text-xs ${
                            msg.content.includes('FAILED') ||
                            msg.content.includes('forcing')
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-[var(--accent)]/10 text-[var(--text-secondary)] border border-[var(--border)]'
                          }`}
                        >
                          <span className="font-medium">Gate:</span>{' '}
                          {msg.content}
                        </div>
                      )}
                      {msg.messageType === 'output' && (
                        <div className="text-[var(--text-secondary)]">
                          {msg.content}
                        </div>
                      )}
                      {msg.messageType === 'reasoning' && (
                        <div className="text-[var(--text-muted)] italic">
                          {msg.content}
                        </div>
                      )}
                      {/* A tool the agent's *code* called — not a model-issued
                          tool call, of which this pipeline makes none. See
                          lib/tool-record.ts. */}
                      {msg.messageType === 'tool' && (
                        <div className="text-[var(--text-muted)] flex gap-1.5">
                          <span
                            className="font-mono opacity-60"
                            aria-label="tool call"
                          >
                            ⚙
                          </span>
                          <span>{msg.content}</span>
                        </div>
                      )}
                      {msg.messageType === 'consensus' && (
                        <div className="text-[var(--text-secondary)]">
                          {msg.content}
                        </div>
                      )}
                      {msg.messageType === 'error' && (
                        <div className="text-red-400 text-xs">
                          ⚠ {msg.content}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* The gate itself is hoisted out of this card and rendered
                  above the thread — see ReviewGate. A gate rendered inside
                  the fourth card of a scrolling sidebar is a gate a founder
                  can scroll past, and it is the one moment on this screen
                  that must not be missable. What stays here is the marker
                  that says which stage stopped. */}
              {isAwaitingThisGate && (
                <div className="review-gate__marker">
                  Stopped here — your review is above.
                </div>
              )}

              {/* Connector arrow between agents */}
              {agent.step < 5 && (
                <div className="flex justify-center mt-2">
                  <div className="w-px h-4 bg-[var(--border)]" />
                </div>
              )}
            </div>
          );
        }
      )}
    </div>
  );
}
