/**
 * Project list + management. See @agent_docs/api-spec.md "Projects".
 */
import { useCallback, useEffect, useState } from 'react';

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
}

export function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/projects', { credentials: 'include' });
    if (res.ok) setProjects(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createProject = async () => {
    if (!name.trim()) return;
    const res = await fetch('/api/projects', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) {
      setName('');
      await load();
    }
  };

  const deleteProject = async (id: string) => {
    await fetch(`/api/projects/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    await load();
  };

  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <h1 style={{ fontSize: 32 }}>Projects</h1>

      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          style={{
            flex: 1,
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-default)',
            background: 'var(--surface-raised)',
            color: 'var(--text-primary)',
          }}
        />
        <button
          onClick={() => void createProject()}
          style={{
            padding: '10px 16px',
            borderRadius: 'var(--radius-md)',
            border: 'none',
            background: 'var(--color-accent)',
            color: 'var(--surface-base)',
            cursor: 'pointer',
          }}
        >
          Create
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
      ) : projects.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)' }}>No projects yet.</div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {projects.map((p) => (
            <li
              key={p.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 'var(--space-4)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--border-default)',
              }}
            >
              <div>
                <div style={{ fontSize: 15 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {p.status} · {new Date(p.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => void deleteProject(p.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--danger)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
