import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RoleInput } from '@orch/shared';
import { api } from '../api';
import { StatusPill } from '../components/StatusPill';

export function ProjectPage({ projectName }: { projectName: string }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.find((p) => p.name === projectName);
  const projectId = project?.id ?? '';
  const sessions = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api.sessions(projectId),
    enabled: !!project,
  });
  const [prompt, setPrompt] = useState('');
  const [role, setRole] = useState('');
  const start = useMutation({
    mutationFn: () => api.startSession(projectId, { prompt, role: role || undefined }),
    onSuccess: (s) => (location.hash = `#/sessions/${s.id}`),
  });
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const available = roles.data?.filter((r) => !project?.roles.includes(r.name)) ?? [];
  const [predefined, setPredefined] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const addRole = useMutation({
    mutationFn: (role: RoleInput) => api.addProjectRole(projectId, role),
    onSuccess: () => {
      setPredefined('');
      setNewName('');
      setNewDesc('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <>
      <p className="crumbs">
        <a href="#/">Projects</a> /
      </p>
      <h1>{projectName}</h1>
      {projects.data && !project && <p className="error">No project named "{projectName}".</p>}
      <p className="muted mono">{project?.workdir}</p>

      {project && (
        <div className="card">
          <p>
            <strong>Roles:</strong>{' '}
            {project.roles.length ? project.roles.join(', ') : <span className="muted">none (single session)</span>}
          </p>
          <div className="form-row">
            <select value={predefined} onChange={(e) => setPredefined(e.target.value)} aria-label="Predefined role">
              <option value="">Predefined role…</option>
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              disabled={!predefined || addRole.isPending}
              onClick={() => {
                // A predefined role sends its composed content (own text + guidelines) as the CLAUDE.md body.
                const r = available.find((x) => x.id === predefined);
                if (r) addRole.mutate({ name: r.name, description: r.content });
              }}
            >
              Add role
            </button>
          </div>
          <div className="form-row" style={{ marginTop: 8 }}>
            <input placeholder="Role for this project only" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input placeholder="Description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            <button
              type="button"
              className="secondary"
              disabled={!newName.trim() || addRole.isPending}
              onClick={() => addRole.mutate({ name: newName.trim(), description: newDesc })}
            >
              Add role
            </button>
          </div>
          {addRole.error && <p className="error">{addRole.error.message}</p>}
        </div>
      )}

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <textarea
          rows={3}
          placeholder="What should Claude do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
        <div className="actions">
          {!!project?.roles.length && (
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="">Project root</option>
              {project.roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <button disabled={start.isPending || !project}>Start session</button>
        </div>
        {start.error && <p className="error">{start.error.message}</p>}
      </form>

      <h2>Sessions</h2>
      {sessions.data?.length === 0 && <p className="muted">No sessions yet.</p>}
      <ul className="list">
        {[...(sessions.data ?? [])].reverse().map((s) => (
          <li key={s.id}>
            <a href={`#/sessions/${s.id}`} className="card row">
              <StatusPill status={s.status} />
              <span className="mono">{s.id.slice(0, 8)}</span>
              {s.role && <strong>{s.role}</strong>}
              <span className="muted">{s.model}</span>
              <span className="muted">${s.costUsd.toFixed(4)}</span>
              <span className="muted grow-right">{new Date(s.startedAt).toLocaleString()}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
