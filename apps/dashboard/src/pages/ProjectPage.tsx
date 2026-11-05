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
  const remove = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: () => {
      location.hash = '#/';
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <>
      <h1 className="path-title">
        <a href="#/">Projects</a>
        <span className="sep">/</span>
        {projectName}
      </h1>
      {projects.data && !project && <p className="error">No project named "{projectName}".</p>}
      {project && (
        <p className="path page-path" title={project.workdir}>
          <bdi>{project.workdir}</bdi>
        </p>
      )}

      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
      >
        <label className="eyebrow field-label" htmlFor="prompt">
          New session
        </label>
        <textarea
          id="prompt"
          rows={3}
          placeholder="What should Claude do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
        <div className="actions end">
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

      {project && (
        <div className="card stack">
          <div className="row">
            <span className="eyebrow">Roles</span>
            {project.roles.length ? (
              <span className="chips">
                {project.roles.map((r) => (
                  <span key={r} className="chip">
                    {r}
                  </span>
                ))}
              </span>
            ) : (
              <span className="muted">none (single session)</span>
            )}
          </div>
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
          <div className="form-row">
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

      <h2>Sessions</h2>
      {sessions.data?.length === 0 && <p className="empty">No sessions yet.</p>}
      <ul className="list">
        {[...(sessions.data ?? [])].reverse().map((s) => (
          <li key={s.id}>
            <a href={`#/sessions/${s.id}`} className="card session-row">
              <StatusPill status={s.status} />
              <span className="mono">{s.id.slice(0, 8)}</span>
              <span className="who">
                {s.role && <strong>{s.role}</strong>}
                <span className="muted mono">{s.model}</span>
                <span className="muted mono">${s.costUsd.toFixed(4)}</span>
              </span>
              <span className="when">{new Date(s.startedAt).toLocaleString()}</span>
            </a>
          </li>
        ))}
      </ul>

      {project && (
        <div className="actions">
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => {
              const msg = `Delete project "${project.name}" with its sessions, history and tasks?\n\nThe directory ${project.workdir} is kept.`;
              if (confirm(msg)) remove.mutate();
            }}
          >
            Delete project
          </button>
          {remove.error && <p className="error">{remove.error.message}</p>}
        </div>
      )}
    </>
  );
}
