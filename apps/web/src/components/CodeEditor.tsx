/**
 * CodeEditor — Monaco Editor loaded from CDN to avoid web worker issues
 * on Cloudflare Workers. See ARCHITECTURE-REVISION-PLAN.md Phase 1.
 */
import { useRef } from 'react';
import Editor, { type OnMount, type BeforeMount } from '@monaco-editor/react';
import { loader } from '@monaco-editor/react';

// Configure Monaco to load from CDN — this avoids bundling Monaco's
// large worker files and WASM into the Cloudflare Worker bundle.
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs',
  },
});

export interface CodeEditorProps {
  value: string;
  language?: string;
  path?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

const EXT_LANG_MAP: Record<string, string> = {
  '.tsx': 'typescript',
  '.ts': 'typescript',
  '.jsx': 'javascript',
  '.js': 'javascript',
  '.css': 'css',
  '.html': 'html',
  '.json': 'json',
  '.md': 'markdown',
  '.svg': 'xml',
  '.sql': 'sql',
};

function detectLanguage(path?: string): string {
  if (!path) return 'typescript';
  for (const [ext, lang] of Object.entries(EXT_LANG_MAP)) {
    if (path.endsWith(ext)) return lang;
  }
  return 'plaintext';
}

const beforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('bicameral-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '71717a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '818cf8' },
      { token: 'string', foreground: '10b981' },
      { token: 'number', foreground: 'f59e0b' },
      { token: 'type', foreground: '6366f1' },
      { token: 'function', foreground: '818cf8' },
      { token: 'variable', foreground: 'ffffff' },
      { token: 'identifier', foreground: 'ffffff' },
    ],
    colors: {
      'editor.background': 'var(--neutral-0)',
      'editor.foreground': 'var(--text-primary)',
      'editorLineNumber.foreground': 'var(--text-muted)',
      'editorLineNumber.activeForeground': 'var(--text-muted)',
      'editor.selectionBackground': 'rgba(235, 100, 170, 0.25)',
      'editor.lineHighlightBackground': 'var(--surface-base)',
      'editorCursor.foreground': 'var(--color-accent)',
      'editorIndentGuide.background': 'var(--border-default)',
      'editorIndentGuide.activeBackground': 'var(--border-default)',
      'editorWidget.background': 'var(--surface-base)',
      'editorWidget.border': 'var(--border-default)',
      'input.background': 'var(--surface-base)',
      'input.border': 'var(--border-default)',
      'scrollbarSlider.background': 'rgba(140, 120, 142, 0.5)',
      'scrollbarSlider.hoverBackground': 'rgba(140, 120, 142, 0.7)',
    },
  });
};

const onMount: OnMount = (editor, monaco) => {
  monaco.editor.setTheme('bicameral-dark');
  editor.updateOptions({
    fontSize: 14,
    minimap: { enabled: false },
    wordWrap: 'on',
    lineNumbers: 'on',
    smoothScrolling: true,
    padding: { top: 12 },
    fontFamily: "'Inter', -apple-system, monospace",
    fontLigatures: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
  });
};

export function CodeEditor({
  value,
  language,
  path,
  readOnly = false,
  onChange,
}: CodeEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  return (
    <div className="code-editor-container">
      <Editor
        value={value}
        language={language ?? detectLanguage(path)}
        path={path}
        theme="bicameral-dark"
        beforeMount={beforeMount}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          onMount(editor, monaco);
        }}
        onChange={(val) => onChange?.(val ?? '')}
        options={{
          readOnly,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
