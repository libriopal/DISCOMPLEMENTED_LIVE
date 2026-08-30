import '../styles/generation-view.css';

/**
 * Prompt-to-app interface — now with a real IDE: file tree, Monaco editor,
 * and live multi-file preview. The pipeline runs in the background and
 * files appear in the tree as they're generated.
 *
 * See ARCHITECTURE-REVISION-PLAN.md Phase 1-2.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { usePipeline } from '../hooks/usePipeline.js';
import { useSandboxPreview } from '../hooks/useSandboxPreview.js';
import { useVerboseness } from '../hooks/useVerboseness.js';
import { IDELayout } from '../components/IDELayout.js';
import { PreviewFrame } from '../components/PreviewFrame.js';
import { GroupChatPanel } from '../components/GroupChatPanel.js';
import { PipelineStatus } from '../components/PipelineStatus.js';
import {
  describePipelineError,
  type RunSnapshot,
} from '../lib/pipeline-legibility.js';
import type { FileNode } from '../components/FileTree.js';
import { bundleProject, type BundleResult } from '../lib/multi-file-bundler.js';
import { selectPreviewTier } from '../lib/preview-strategy.js';
import type { ProjectFile, SystemBlueprint } from '@bicameral/shared/types';
import type { PipelineComplexity } from '../lib/cohere.js';

function guessEntryPoint(files: FileNode[]): string {
  const appFile = files.find((f) => /(^|\/)App\.(tsx|jsx)$/.test(f.path));
  return appFile?.path ?? files[0]?.path ?? '';
}

/**
 * The two blueprint facts that decide which preview tier this run needs.
 *
 * Read off the pipeline's own step outputs rather than guessed from the file
 * list: `hasApiRoutes` is the whole reason Tier 3 exists, and it is a
 * statement the Designer made, not something inferable from a `src/api`
 * directory that may or may not be there.
 */
function previewFacts(stepOutputs: Partial<Record<string, unknown>>): {
  hasApiRoutes: boolean;
  complexity: PipelineComplexity;
} {
  const blueprint = stepOutputs.designer as
    | Partial<SystemBlueprint>
    | undefined;
  const research = stepOutputs.researcher as
    | { brief?: { complexity?: PipelineComplexity } }
    | undefined;
  return {
    hasApiRoutes: (blueprint?.apiRoutes?.length ?? 0) > 0,
    complexity: research?.brief?.complexity ?? 'simple',
  };
}

export function GenerationView() {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [figmaConnected, setFigmaConnected] = useState(false);
  const [figmaUser, setFigmaUser] = useState<{
    name?: string;
    handle?: string;
  } | null>(null);
  const [deployUrl, setDeployUrl] = useState<string | null>(null);
  // Defaults to `ask_first`, matching GenerationOrchestrator's own default
  // (`run.execution_mode ?? 'ask_first'`). This previously read 'auto_accept'
  // with no setter destructured, so the client overrode that safe server
  // default on every request and no user could opt out — every generation
  // auto-advanced each gate with nobody holding the approval seat.
  //
  // The mode picker lands with the Steward work: the elevated modes are meant
  // to be earned (an Architect blueprint signed by the Auditor and by a human),
  // not merely switched on, so shipping a bare toggle here would be the wrong
  // shape for it.
  const [executionMode] = useState<'ask_first' | 'auto_accept'>('ask_first');

  // Loaded from the founder's account, not from this browser: the level is a
  // decision about the pipeline, and it travels with the person watching it.
  const {
    verboseness,
    setVerboseness,
    error: verbosenessError,
  } = useVerboseness();

  const {
    pipelineState,
    startPipeline,
    approveBlueprint,

    startNew,
    busy,
    startError,
  } = usePipeline();

  // Extract files from pipeline output when they become available
  // Check Figma connection status
  useEffect(() => {
    fetch('/api/figma/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.connected) {
          setFigmaConnected(true);
          setFigmaUser(data.user);
        }
      })
      .catch(() => {});
    // Check for figma_connected query param (after OAuth redirect)
    const params = new URLSearchParams(window.location.search);
    if (params.get('figma_connected') === 'true') {
      setFigmaConnected(true);
      window.history.replaceState({}, '', '/generate');
      // Re-fetch status
      fetch('/api/figma/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((data: any) => {
          if (data?.connected) {
            setFigmaUser(data.user);
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    const coderOutput = pipelineState.stepOutputs.coder as
      | { files?: ProjectFile[] }
      | undefined;

    if (coderOutput?.files && coderOutput.files.length > 0) {
      const fileNodes: FileNode[] = coderOutput.files.map((f) => ({
        path: f.path,
        content: f.content,
      }));
      setFiles(fileNodes);
      if (!activeFile) {
        setActiveFile(guessEntryPoint(fileNodes));
      }
    }
  }, [pipelineState.stepOutputs.coder]);

  // ---- Preview tier ----------------------------------------------------
  //
  // This screen used to bundle every project with esbuild in the browser and
  // show the result in an iframe: Tier 2, always, for every app including the
  // ones whose whole point is a server. The tier selector and the container
  // both existed; nothing here called either. That is what made every Tier 3
  // fix invisible to a founder.
  const { hasApiRoutes, complexity } = useMemo(
    () => previewFacts(pipelineState.stepOutputs),
    [pipelineState.stepOutputs]
  );
  const projectFiles = useMemo<ProjectFile[]>(
    () =>
      files.map((f) => ({
        path: f.path,
        content: f.content,
        language: 'typescript',
      })) as ProjectFile[],
    [files]
  );
  const tier = selectPreviewTier(complexity, {
    hasApiRoutes,
    fileCount: files.length,
  });

  const {
    status: sandboxStatus,
    starting: sandboxStarting,
    error: sandboxError,
    queue: sandboxQueue,
    start: startSandbox,
  } = useSandboxPreview(tier === 'sandbox' ? pipelineState.projectId : null);

  // Start the container once per file set, rather than on every render of a
  // changing `files` array. A container start is expensive and capacity is a
  // hard global ceiling (wrangler.toml `max_instances`), so re-entering this
  // effect must not mean re-starting.
  const startedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (tier !== 'sandbox') return;
    if (!pipelineState.projectId || projectFiles.length === 0) return;
    // Already waiting for a slot: asking again would only reset the timer the
    // hook is already running, and the founder is already being told.
    if (sandboxStarting || sandboxStatus.running || sandboxQueue) return;

    const signature = `${pipelineState.projectId}:${projectFiles.length}:${projectFiles.map((f) => f.content.length).join(',')}`;
    if (startedForRef.current === signature) return;
    startedForRef.current = signature;
    void startSandbox(projectFiles);
  }, [
    tier,
    pipelineState.projectId,
    projectFiles,
    sandboxStarting,
    sandboxStatus.running,
    sandboxQueue,
    startSandbox,
  ]);

  const previewPanel = (
    <PreviewFrame
      files={projectFiles}
      entryPoint={guessEntryPoint(files)}
      complexity={complexity}
      strategy={{ hasApiRoutes, fileCount: files.length }}
      sandbox={{
        starting: sandboxStarting,
        running: sandboxStatus.running,
        degraded: sandboxStatus.degraded,
        health: sandboxStatus.health,
        warnings: sandboxStatus.warnings,
        url: sandboxStatus.previewUrl,
        error: sandboxError,
        queue: sandboxQueue,
        onStart: () => {
          // A manual retry after a failed start must not be blocked by the
          // signature guard above, which has already recorded this file set.
          startedForRef.current = null;
          void startSandbox(projectFiles);
        },
      }}
    />
  );

  /**
   * The run as the legibility module wants to see it — one object rather than
   * six props threaded through three components, and the same shape the unit
   * tests in lib/pipeline-legibility.test.ts drive.
   */
  const snapshot: RunSnapshot = useMemo(
    () => ({
      currentStep: pipelineState.currentStep,
      currentAgent: pipelineState.currentAgent,
      awaitingApproval: pipelineState.awaitingApproval,
      error: pipelineState.error,
      errorStep: pipelineState.errorStep,
      finished: pipelineState.finished,
      iteration: pipelineState.iteration,
    }),
    [
      pipelineState.currentStep,
      pipelineState.currentAgent,
      pipelineState.awaitingApproval,
      pipelineState.error,
      pipelineState.errorStep,
      pipelineState.finished,
      pipelineState.iteration,
    ]
  );

  const errorReport = useMemo(
    () =>
      pipelineState.error
        ? describePipelineError(pipelineState.error, pipelineState.errorStep)
        : null,
    [pipelineState.error, pipelineState.errorStep]
  );

  const handleFilesUpdated = useCallback((updatedFiles: FileNode[]) => {
    setFiles(updatedFiles);
  }, []);

  const handleFileChange = useCallback((path: string, content: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content } : f))
    );
  }, []);

  const handleDeploy = async () => {
    if (!pipelineState.pipelineId || files.length === 0) return;
    setDeploying(true);
    try {
      // Bundle the files first
      const entry = guessEntryPoint(files);
      const result: BundleResult = await bundleProject(files, entry);
      if (result.errors.length > 0 && !result.code) {
        setDeploying(false);
        return;
      }
      // Deploy the bundled HTML
      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelineRunId: pipelineState.pipelineId,
          html: result.code,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { url: string };
        setDeployUrl(data.url);
      }
    } catch (err) {
      console.error('Deploy failed:', err);
    } finally {
      setDeploying(false);
    }
  };

  const handleStart = async () => {
    if (!prompt.trim()) return;
    setFiles([]);
    setActiveFile('');
    await startPipeline(prompt.trim(), undefined, executionMode);
  };

  // Show the prompt input when no pipeline is running
  if (!pipelineState.pipelineId) {
    return (
      <main className="gen-view ide-layout">
        <div className="ide-header">
          <div className="ide-header-left">
            <span className="ide-project-name">New Project</span>
          </div>
        </div>
        <div className="gen-empty">
          <h1 className="gen-empty__title">Build something</h1>
          <p className="gen-empty__subtitle">
            Describe your app. The Researcher, Auditor, Verifier, Designer, and
            Coder agents will research, validate, design, and build it — with
            live preview, group chat, and iterative refinement.
          </p>
          <textarea
            className="gen-empty__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="I want an app that helps dog owners find nearby parks..."
            rows={4}
          />
          <div className="gen-empty__actions">
            <button
              className="gen-empty__btn"
              onClick={() => void handleStart()}
              disabled={busy || !prompt.trim()}
            >
              {busy ? 'Starting...' : 'Start pipeline →'}
            </button>
            {startError && (
              <span className="gen-empty__error">{startError}</span>
            )}
          </div>

          {/* Pipeline progress indicator */}
          <div className="gen-progress">
            <div className="gen-progress__bar">
              {[
                { label: 'Researcher', step: 1 },
                { label: 'Auditor', step: 2 },
                { label: 'Verifier', step: 3 },
                { label: 'Designer', step: 4 },
                { label: 'Coder', step: 5 },
              ].map(({ label, step }) => {
                const status =
                  pipelineState.currentStep > step
                    ? 'gen-progress__step--done'
                    : pipelineState.currentStep >= step
                      ? 'gen-progress__step--active'
                      : '';
                return (
                  <div key={label} className={`gen-progress__step ${status}`}>
                    <span className="gen-progress__step-circle">
                      {pipelineState.currentStep > step ? '✓' : step}
                    </span>
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>
    );
  }

  // Full IDE view when files are available or coder is running
  return (
    <main className="gen-view ide-layout">
      <div className="ide-header">
        <div className="ide-header-left">
          <span className="ide-project-name">
            {prompt.slice(0, 40)}
            {prompt.length > 40 ? '...' : ''}
          </span>
        </div>
        <div className="ide-header-right">
          {figmaConnected ? (
            <span className="figma-connected-badge">
              Figma: {figmaUser?.name || figmaUser?.handle || 'Connected'}
            </span>
          ) : (
            <a
              href="/api/figma/auth"
              className="figma-connect-btn"
              title="Connect your Figma account to import designs"
            >
              Connect Figma
            </a>
          )}
          {deployUrl && (
            <a
              href={deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ide-deploy-link"
            >
              View live ↗
            </a>
          )}
          {pipelineState.deploymentUrl && !deployUrl && (
            <a
              href={pipelineState.deploymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ide-deploy-link"
            >
              View live ↗
            </a>
          )}
          {files.length > 0 && !deployUrl && (
            <button
              className="gen-ide__deploy-btn"
              onClick={() => void handleDeploy()}
              disabled={deploying}
            >
              {deploying ? 'Deploying...' : 'Deploy ↗'}
            </button>
          )}
          <button onClick={startNew} className="ide-toggle-preview">
            New project
          </button>
        </div>
      </div>
      <PipelineStatus
        snapshot={snapshot}
        startedAt={pipelineState.startedAt}
        model={pipelineState.modelByStep[pipelineState.currentStep] ?? null}
        verboseness={verboseness}
        tier={tier}
        backendRunning={sandboxStatus.running && !sandboxStatus.degraded}
      />
      <div className="ide-panels">
        <IDELayout
          files={files}
          activeFile={activeFile || guessEntryPoint(files)}
          onSelectFile={setActiveFile}
          onFileChange={handleFileChange}
          onFilesUpdated={handleFilesUpdated}
          preview={previewPanel}
          projectName={prompt.slice(0, 30)}
          pipelineId={pipelineState.pipelineId}
        />
        <div
          className="ide-chat-sidebar"
          style={{
            width: '360px',
            flexShrink: 0,
            borderLeft: '1px solid var(--border)',
          }}
        >
          <GroupChatPanel
            pipelineId={pipelineState.pipelineId}
            currentStep={pipelineState.currentStep}
            awaitingApproval={pipelineState.awaitingApproval}
            onApprove={(approved, fb) => void approveBlueprint(approved, fb)}
            executionMode={executionMode}
            verboseness={verboseness}
            onVerbosenessChange={setVerboseness}
            verbosenessError={verbosenessError}
          />
        </div>
      </div>
      {errorReport && (
        <div className="pipe-error" role="alert">
          <p className="pipe-error__headline">{errorReport.headline}</p>
          <pre className="pipe-error__detail">{errorReport.detail}</pre>
          <p className="pipe-error__remedy">{errorReport.remedy}</p>
          <div className="pipe-error__actions">
            {errorReport.retryable && (
              <button
                type="button"
                className="pipe-error__btn"
                onClick={() => void handleStart()}
                disabled={busy || !prompt.trim()}
              >
                Retry the run
              </button>
            )}
            <button
              type="button"
              className="pipe-error__btn"
              onClick={startNew}
            >
              Start over
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
