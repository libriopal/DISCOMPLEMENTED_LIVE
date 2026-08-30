/**
 * Memory Lattice canvas — Three.js stub. Renders lattice_nodes as points
 * colored by hemisphere (left=indigo, right=violet, bridge=pink) with a
 * slow auto-rotation. Full interaction model (orbit/pan/zoom, node
 * selection, bridge InstancedMesh) is design/05-memory-lattice-interaction.html —
 * out of scope for this stub, which exists so LatticeManager's D1/Vectorize
 * writes have somewhere to render.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

interface LatticeNode {
  id: string;
  type: string;
  label: string;
  position: [number, number, number];
}

const HEMISPHERE_COLOR: Record<string, number> = {
  requirement: 0x3b4fd6, // indigo — architect
  semantic: 0x3b4fd6, // indigo — researcher
  architecture: 0x8b3fd6, // violet — designer
  code: 0x8b3fd6, // violet — coder
  bridge: 0xdb3f88,
  cluster: 0xdb3f88,
};

export function LatticeView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<LatticeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/projects', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        const projectList = list as { id: string; name: string }[];
        setProjects(projectList);
        if (projectList.length > 0) setProjectId(projectList[0].id);
      });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetch(`/api/lattice/${projectId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { nodes: [] }))
      .then((data) => setNodes((data as { nodes?: LatticeNode[] }).nodes ?? []))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || 640;
    const height = 480;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.z = 50;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const group = new THREE.Group();
    scene.add(group);

    const points = nodes.length > 0 ? nodes : placeholderNodes();
    for (const node of points) {
      const color = HEMISPHERE_COLOR[node.type] ?? 0x93939f;
      const geometry = new THREE.SphereGeometry(1, 12, 12);
      const material = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...node.position);
      group.add(mesh);
    }

    let frameId: number;
    const animate = () => {
      group.rotation.y += 0.003;
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      renderer.dispose();
      container.innerHTML = '';
    };
  }, [nodes]);

  return (
    <div
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <h1 style={{ fontSize: 32 }}>Memory Lattice</h1>
      {projects.length > 0 && (
        <select
          value={projectId ?? ''}
          onChange={(e) => setProjectId(e.target.value || null)}
          style={{
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-raised)',
            color: 'var(--text-primary)',
            alignSelf: 'flex-start',
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      {!projectId && (
        <div style={{ color: 'var(--text-secondary)' }}>
          Create a project to view its lattice.
        </div>
      )}
      {loading && (
        <div style={{ color: 'var(--text-secondary)' }}>Loading nodes...</div>
      )}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 480,
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-default)',
          overflow: 'hidden',
        }}
      />
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {nodes.length} nodes loaded
      </div>
    </div>
  );
}

function placeholderNodes(): LatticeNode[] {
  return Array.from({ length: 12 }).map((_, i) => ({
    id: `placeholder-${i}`,
    type: i % 2 === 0 ? 'semantic' : 'architecture',
    label: `Node ${i}`,
    position: [
      (Math.random() - 0.5) * 40,
      (Math.random() - 0.5) * 40,
      (Math.random() - 0.5) * 40,
    ],
  }));
}
