/**
 * Memory Lattice Graph — the living centerpiece of Bicameral.
 *
 * A spatial graph where semantic (left=indigo) and implementation (right=violet)
 * hemispheres converge, with pink bridges representing alignment.
 *
 * Node taxonomy:
 *   Size → memory density (more connections = larger)
 *   Glow → confidence (higher = brighter)
 *   Hue  → hemisphere (indigo=semantic, violet=implementation, pink=bridge)
 *
 * Interactions:
 *   Scroll/pinch → zoom (0.25×–4×)
 *   Drag empty canvas → pan
 *   Click node → select
 *   Double-click → inspect (opens detail panel)
 *   Drag handle → connect (creates bridge edge)
 *
 * This is what makes Discomplement's memory visible — you can SEE
 * the system learning, connecting, and aligning.
 */
import { useState, useRef, useEffect, useCallback } from 'react';

export interface LatticeNode {
  id: string;
  label: string;
  type: 'semantic' | 'implementation' | 'bridge';
  x: number;
  y: number;
  density: number; // 0-1, controls size
  confidence: number; // 0-1, controls glow
  connections: number;
  status?: 'stable' | 'needs-review' | 'drift';
  metadata?: Record<string, unknown>;
}

export interface LatticeEdge {
  id: string;
  source: string;
  target: string;
  type: 'implements' | 'refines' | 'depends-on' | 'derived' | 'bridge';
  strength: number; // 0-1
}

export interface MemoryLatticeProps {
  nodes: LatticeNode[];
  edges: LatticeEdge[];
  onNodeSelect?: (node: LatticeNode) => void;
  onNodeInspect?: (node: LatticeNode) => void;
  width?: number;
  height?: number;
}

const HEMISPHERE_COLORS = {
  semantic: { fill: 'var(--color-accent)', glow: 'rgba(99, 102, 241, 0.3)' }, // indigo
  implementation: { fill: 'var(--code-400)', glow: 'rgba(139, 92, 246, 0.3)' }, // violet
  bridge: { fill: 'var(--semantic-400)', glow: 'rgba(236, 72, 153, 0.3)' }, // pink
};

const EDGE_COLORS = {
  implements: 'var(--semantic-400)',
  refines: 'var(--color-accent)',
  'depends-on': 'var(--code-400)',
  derived: 'var(--bridge-400)',
  bridge: 'var(--semantic-400)',
};

const MIN_RADIUS = 6;
const MAX_RADIUS = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export function MemoryLattice({
  nodes,
  edges,
  onNodeSelect,
  onNodeInspect,
  width = 800,
  height = 600,
}: MemoryLatticeProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Bridge axis line (vertical line separating hemispheres)
  const bridgeX = width / 2;

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (
        e.target === svgRef.current ||
        (e.target as Element).tagName === 'rect'
      ) {
        setIsDragging(true);
        dragStart.current = {
          x: e.clientX,
          y: e.clientY,
          panX: pan.x,
          panY: pan.y,
        };
      }
    },
    [pan]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = (e.clientX - dragStart.current.x) / zoom;
      const dy = (e.clientY - dragStart.current.y) / zoom;
      setPan({
        x: dragStart.current.panX + dx,
        y: dragStart.current.panY + dy,
      });
    },
    [isDragging, zoom]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleNodeClick = useCallback(
    (node: LatticeNode) => {
      setSelectedNode(node.id);
      onNodeSelect?.(node);
    },
    [onNodeSelect]
  );

  const handleNodeDoubleClick = useCallback(
    (node: LatticeNode) => {
      onNodeInspect?.(node);
    },
    [onNodeInspect]
  );

  // Keyboard shortcuts: F = frame selection, 0 = fit all
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === '0') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
      if (e.key === 'f' && selectedNode) {
        const node = nodes.find((n) => n.id === selectedNode);
        if (node) {
          setZoom(2);
          setPan({ x: width / 2 - node.x * 2, y: height / 2 - node.y * 2 });
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedNode, nodes, width, height]);

  return (
    <div className="lattice-container">
      <div className="lattice-toolbar">
        <button
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 0.25))}
          className="lattice-btn"
        >
          +
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
          className="lattice-btn"
        >
          −
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="lattice-btn"
        >
          ⌖
        </button>
        <span className="lattice-zoom-label">{Math.round(zoom * 100)}%</span>
        <span className="lattice-node-count">
          {nodes.length} nodes · {edges.length} edges
        </span>
      </div>

      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="lattice-svg"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Background */}
        <rect width={width} height={height} fill="var(--surface-base)" />

        {/* Hemisphere labels */}
        <text
          x={bridgeX * 0.5}
          y={24}
          textAnchor="middle"
          className="lattice-hemisphere-label"
        >
          Semantic
        </text>
        <text
          x={bridgeX * 1.5}
          y={24}
          textAnchor="middle"
          className="lattice-hemisphere-label"
        >
          Implementation
        </text>

        {/* Bridge axis */}
        <line
          x1={bridgeX}
          y1={0}
          x2={bridgeX}
          y2={height}
          stroke="var(--surface-hover)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />

        {/* Transform group for zoom/pan */}
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {edges.map((edge) => {
            const source = nodes.find((n) => n.id === edge.source);
            const target = nodes.find((n) => n.id === edge.target);
            if (!source || !target) return null;

            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={EDGE_COLORS[edge.type] ?? 'var(--border-strong)'}
                strokeWidth={1 + edge.strength * 2}
                opacity={0.3 + edge.strength * 0.4}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const colors = HEMISPHERE_COLORS[node.type];
            const radius =
              MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * node.density;
            const glowRadius = radius + node.confidence * 12;
            const isSelected = selectedNode === node.id;
            const isHovered = hoveredNode === node.id;
            const statusColor =
              node.status === 'drift'
                ? 'var(--danger)'
                : node.status === 'needs-review'
                  ? 'var(--warning)'
                  : null;

            return (
              <g
                key={node.id}
                onClick={() => handleNodeClick(node)}
                onDoubleClick={() => handleNodeDoubleClick(node)}
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                style={{ cursor: 'pointer' }}
              >
                {/* Glow */}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={glowRadius}
                  fill={colors.glow}
                  opacity={0.5}
                />
                {/* Node */}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius}
                  fill={colors.fill}
                  stroke={isSelected ? 'var(--text-primary)' : (statusColor ?? 'none')}
                  strokeWidth={isSelected ? 2 : statusColor ? 1.5 : 0}
                />
                {/* Label (visible when hovered or selected) */}
                {(isHovered || isSelected) && (
                  <text
                    x={node.x}
                    y={node.y - radius - 6}
                    textAnchor="middle"
                    className="lattice-node-label"
                  >
                    {node.label.length > 30
                      ? node.label.slice(0, 27) + '...'
                      : node.label}
                  </text>
                )}
                {/* Confidence indicator */}
                {node.confidence > 0 && (
                  <circle
                    cx={node.x + radius * 0.7}
                    cy={node.y - radius * 0.7}
                    r={2}
                    fill={
                      node.confidence > 0.7
                        ? 'var(--success)'
                        : node.confidence > 0.4
                          ? 'var(--warning)'
                          : 'var(--danger)'
                    }
                  />
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Inspector panel */}
      {selectedNode &&
        (() => {
          const node = nodes.find((n) => n.id === selectedNode);
          if (!node) return null;
          const colors = HEMISPHERE_COLORS[node.type];
          return (
            <div className="lattice-inspector">
              <div className="lattice-inspector-header">
                <span
                  className="lattice-inspector-dot"
                  style={{ background: colors.fill }}
                />
                <span className="lattice-inspector-title">{node.label}</span>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="lattice-inspector-close"
                >
                  ×
                </button>
              </div>
              <div className="lattice-inspector-body">
                <div className="lattice-inspector-row">
                  <span>Type</span>
                  <span style={{ color: colors.fill }}>{node.type}</span>
                </div>
                <div className="lattice-inspector-row">
                  <span>Confidence</span>
                  <span>{(node.confidence * 100).toFixed(0)}%</span>
                </div>
                <div className="lattice-inspector-row">
                  <span>Density</span>
                  <span>
                    {node.density > 0.7
                      ? 'High'
                      : node.density > 0.4
                        ? 'Medium'
                        : 'Low'}
                  </span>
                </div>
                <div className="lattice-inspector-row">
                  <span>Connections</span>
                  <span>{node.connections} edges</span>
                </div>
                {node.status && (
                  <div className="lattice-inspector-row">
                    <span>Status</span>
                    <span className={`lattice-status-${node.status}`}>
                      {node.status === 'drift'
                        ? '⚠ Drift detected'
                        : node.status === 'needs-review'
                          ? 'Needs review'
                          : 'Stable'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
