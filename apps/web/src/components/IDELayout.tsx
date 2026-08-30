/**
 * IDELayout — responsive 3-panel split layout with theme support.
 * Panels: file tree | code editor | live preview (+ optional chat + glass engine).
 * Auto-fits to screen size. Mobile collapses to tabbed view.
 * Theme selection via ThemeToggle; the set of themes comes from tokens/source.json.
 */
import { useState, useRef, useCallback, type ReactNode } from 'react';
import { FileTree, type FileNode } from './FileTree.js';
import { CodeEditor } from './CodeEditor.js';
import { ChatPanel } from './ChatPanel.js';
import { GlassEngine, type GlassEvent } from './GlassEngine.js';
import { ThemeToggle } from './ThemeToggle.js';

export interface IDELayoutProps {
  files: FileNode[];
  activeFile: string;
  onSelectFile: (path: string) => void;
  onFileChange: (path: string, content: string) => void;
  onFilesUpdated: (files: FileNode[]) => void;
  /**
   * The preview panel's contents, rendered as given.
   *
   * This was a `previewSrcDoc: string` written straight into a sandboxed
   * iframe here, which hard-coded the layout to a client-bundled preview and
   * made Tier 3 unreachable from this screen — the container tier serves a
   * real dev server over a URL, and there is no srcDoc to hand it. Passing the
   * node lets the caller choose the tier (components/PreviewFrame.tsx) and
   * show honest state alongside it.
   */
  preview: ReactNode;
  projectName?: string;
  pipelineId?: string;
  onDeploy?: () => void;
  isDeploying?: boolean;
  deployUrl?: string | null;
  glassEvents?: GlassEvent[];
  totalCreditsSpent?: number;
  creditBudget?: number;
}

type MobileTab = 'files' | 'editor' | 'preview' | 'chat' | 'engine';

export function IDELayout({
  files,
  activeFile,
  onSelectFile,
  onFileChange,
  onFilesUpdated,
  preview,
  projectName,
  pipelineId,
  onDeploy,
  isDeploying,
  deployUrl,
  glassEvents = [],
  totalCreditsSpent = 0,
  creditBudget = 100,
}: IDELayoutProps) {
  const [previewVisible, setPreviewVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(false);
  const [glassVisible, setGlassVisible] = useState(false);
  const [treeWidth, setTreeWidth] = useState(220);
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');
  const dragRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = treeWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [treeWidth]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.min(
        400,
        Math.max(150, startWidthRef.current + delta)
      );
      setTreeWidth(newWidth);
    };
    const handleMouseUp = () => {
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const activeFileData = files.find((f) => f.path === activeFile);

  // Mobile tab configuration
  const mobileTabs: Array<{ id: MobileTab; label: string; icon: string }> = [
    { id: 'files', label: 'Files', icon: '☰' },
    { id: 'editor', label: 'Code', icon: '⌨' },
    { id: 'preview', label: 'Preview', icon: '◐' },
    { id: 'chat', label: 'Chat', icon: '✎' },
    { id: 'engine', label: 'Engine', icon: '⌬' },
  ];

  return (
    <div className="ide-layout">
      <div className="ide-header">
        <div className="ide-header-left">
          <span className="ide-project-name">{projectName ?? 'Untitled'}</span>
        </div>
        <div className="ide-header-right">
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
          {onDeploy && (
            <button
              onClick={onDeploy}
              disabled={isDeploying || files.length === 0}
              className="ide-deploy-btn"
            >
              {isDeploying ? 'Deploying...' : 'Deploy'}
            </button>
          )}
          {/* Desktop toggle buttons */}
          <button
            onClick={() => setGlassVisible(!glassVisible)}
            className="ide-toggle-btn desktop-only"
            style={
              glassVisible
                ? {
                    color: 'var(--hemisphere-right)',
                    borderColor: 'var(--hemisphere-right)',
                  }
                : {}
            }
          >
            Engine
          </button>
          <button
            onClick={() => setChatVisible(!chatVisible)}
            className="ide-toggle-btn desktop-only"
            style={
              chatVisible
                ? {
                    color: 'var(--bridge-align)',
                    borderColor: 'var(--bridge-align)',
                  }
                : {}
            }
          >
            Chat
          </button>
          <button
            onClick={() => setPreviewVisible(!previewVisible)}
            className="ide-toggle-btn desktop-only"
          >
            {previewVisible ? 'Hide preview' : 'Show preview'}
          </button>
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile tab bar */}
      <div className="ide-mobile-tabs mobile-only">
        {mobileTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setMobileTab(tab.id)}
            className={`ide-mobile-tab ${mobileTab === tab.id ? 'active' : ''}`}
          >
            <span className="ide-mobile-tab-icon">{tab.icon}</span>
            <span className="ide-mobile-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Desktop layout */}
      <div className="ide-panels desktop-only">
        <div
          className="ide-panel-tree"
          style={{ width: treeWidth, flexShrink: 0 }}
        >
          <FileTree
            files={files}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        </div>

        <div className="ide-divider" onMouseDown={handleMouseDown} />

        <div className="ide-panel-editor">
          {activeFileData ? (
            <CodeEditor
              value={activeFileData.content}
              path={activeFileData.path}
              onChange={(content) => onFileChange(activeFileData.path, content)}
            />
          ) : (
            <div className="ide-placeholder">
              Select a file from the tree to view its contents.
            </div>
          )}
        </div>

        {previewVisible && (
          <>
            <div className="ide-divider" />
            <div className="ide-panel-preview">{preview}</div>
          </>
        )}

        {chatVisible && (
          <>
            <div className="ide-divider" />
            <div style={{ width: 320, flexShrink: 0, display: 'flex' }}>
              <ChatPanel
                files={files}
                onFilesUpdated={onFilesUpdated}
                pipelineId={pipelineId}
              />
            </div>
          </>
        )}

        {glassVisible && (
          <>
            <div className="ide-divider" />
            <div style={{ width: 380, flexShrink: 0, display: 'flex' }}>
              <GlassEngine
                events={glassEvents}
                totalCreditsSpent={totalCreditsSpent}
                creditBudget={creditBudget}
              />
            </div>
          </>
        )}
      </div>

      {/* Mobile layout — single panel based on active tab */}
      <div className="ide-mobile-content mobile-only">
        {mobileTab === 'files' && (
          <FileTree
            files={files}
            activeFile={activeFile}
            onSelectFile={(p) => {
              onSelectFile(p);
              setMobileTab('editor');
            }}
          />
        )}
        {mobileTab === 'editor' &&
          (activeFileData ? (
            <CodeEditor
              value={activeFileData.content}
              path={activeFileData.path}
              onChange={(content) => onFileChange(activeFileData.path, content)}
            />
          ) : (
            <div className="ide-placeholder">
              Select a file from the Files tab.
            </div>
          ))}
        {mobileTab === 'preview' && preview}
        {mobileTab === 'chat' && (
          <ChatPanel
            files={files}
            onFilesUpdated={onFilesUpdated}
            pipelineId={pipelineId}
          />
        )}
        {mobileTab === 'engine' && (
          <GlassEngine
            events={glassEvents}
            totalCreditsSpent={totalCreditsSpent}
            creditBudget={creditBudget}
          />
        )}
      </div>
    </div>
  );
}

// Need to import useEffect
import { useEffect } from 'react';
