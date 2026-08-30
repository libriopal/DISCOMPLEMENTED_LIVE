/**
 * FileTree — Collapsible file tree for the IDE. Renders a flat file list
 * as a nested tree with collapsible folders and per-extension icons.
 */
import { useState, useMemo } from 'react';

export interface FileNode {
  path: string;
  content: string;
}

export interface FileTreeProps {
  files: FileNode[];
  activeFile: string;
  onSelectFile: (path: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
  file?: FileNode;
}

function buildTree(files: FileNode[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFolder: true, children: [] };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path,
          isFolder: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort: folders first, then files, alphabetically
  function sortTree(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortTree);
  }
  sortTree(root);

  return root;
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const colors: Record<string, string> = {
    tsx: 'var(--code-600)',
    ts: 'var(--code-600)',
    jsx: 'var(--warning)',
    js: 'var(--warning)',
    css: 'var(--bridge-300)',
    html: 'var(--semantic-300)',
    json: 'var(--success)',
    md: 'var(--text-muted)',
    svg: 'var(--semantic-300)',
    sql: 'var(--code-400)',
  };
  const color = colors[ext] ?? 'var(--text-muted)';

  const icons: Record<string, string> = {
    tsx: 'TS',
    ts: 'TS',
    jsx: 'JS',
    js: 'JS',
    css: 'css',
    html: '<>',
    json: '{}',
    md: 'md',
    svg: 'svg',
    sql: 'SQL',
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 16,
        fontSize: 8,
        fontWeight: 700,
        fontFamily: 'var(--font-mono, monospace)',
        color,
        flexShrink: 0,
        marginRight: 4,
      }}
    >
      {icons[ext] ?? '•'}
    </span>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 20,
        textAlign: 'center',
        color: 'var(--text-muted)',
        flexShrink: 0,
        marginRight: 4,
        fontSize: 10,
      }}
    >
      {open ? '▾' : '▸'}
    </span>
  );
}

function TreeItem({
  node,
  depth,
  activeFile,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string;
  onSelectFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);

  if (node.isFolder) {
    return (
      <div>
        <button
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '4px 8px',
            paddingLeft: depth * 12 + 8,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 13,
            fontFamily: "'Inter', sans-serif",
            textAlign: 'left',
          }}
        >
          <FolderIcon open={open} />
          <span>{node.name}</span>
        </button>
        {open && (
          <div>
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activeFile={activeFile}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isActive = node.path === activeFile;

  return (
    <button
      onClick={() => onSelectFile(node.path)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '4px 8px',
        paddingLeft: depth * 12 + 8,
        background: isActive ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
        border: 'none',
        borderLeft: isActive ? '2px solid var(--color-accent)' : '2px solid transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
        cursor: 'pointer',
        fontSize: 13,
        fontFamily: "'Inter', sans-serif",
        textAlign: 'left',
      }}
    >
      <FileIcon name={node.name} />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {node.name}
      </span>
    </button>
  );
}

export function FileTree({ files, activeFile, onSelectFile }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="file-tree" style={{ overflowY: 'auto', padding: '8px 0' }}>
      {tree.children.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={0}
          activeFile={activeFile}
          onSelectFile={onSelectFile}
        />
      ))}
      {files.length === 0 && (
        <div
          style={{
            padding: '16px',
            color: 'var(--text-muted)',
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          No files yet. Start a pipeline to generate code.
        </div>
      )}
    </div>
  );
}
