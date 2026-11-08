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
  const [predefinedExtra, setPredefinedExtra] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const addRole = useMutation({
    mutationFn: (role: RoleInput) => api.addProjectRole(projectId, role),
    onSuccess: () => {
      setPredefined('');
      setPredefinedExtra('');
      setNewName('');
      setNewDesc('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const [editing, setEditing] = useState<string | null>(null);
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
                  <button
                    key={r}
                    type="button"
                    className={`chip chip-button${editing === r ? ' active' : ''}`}
                    title="Edit CLAUDE.md"
                    onClick={() => setEditing(editing === r ? null : r)}
                  >
                    {r}
                  </button>
                ))}
              </span>
            ) : (
              <span className="muted">none (single session)</span>
            )}
          </div>
          {editing && (
            <ProjectRoleEditor key={editing} projectId={projectId} role={editing} onClose={() => setEditing(null)} />
          )}
          <div className="role-form">
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
                // A predefined role sends its composed content (own text + guidelines) as the CLAUDE.md body,
                // preceded by the extra text for this project only.
                const r = available.find((x) => x.id === predefined);
                const extra = predefinedExtra.trim();
                if (r) addRole.mutate({ name: r.name, description: extra ? `${extra}\n\n${r.content}` : r.content });
              }}
            >
              Add role
            </button>
            {predefined && (
              <textarea
                rows={3}
                placeholder="Extra description for this project (optional)"
                value={predefinedExtra}
                onChange={(e) => setPredefinedExtra(e.target.value)}
              />
            )}
          </div>
          <div className="role-form">
            <input placeholder="Role for this project only" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <textarea rows={3} placeholder="Description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
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

/** Edits a project role's CLAUDE.md as a whole. Running sessions pick the change up on their next start or resume. */
function ProjectRoleEditor({ projectId, role, onClose }: { projectId: string; role: string; onClose: () => void }) {
  const file = useQuery({
    queryKey: ['project-role', projectId, role],
    queryFn: () => api.projectRole(projectId, role),
    staleTime: 0,
  });
  const [content, setContent] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.updateProjectRole(projectId, role, { content: content ?? '' }),
    onSuccess: onClose,
  });
  const value = content ?? file.data?.content ?? '';

  return (
    <div className="stack">
      <label className="eyebrow field-label" htmlFor="role-content">
        {role}/CLAUDE.md
      </label>
      <textarea
        id="role-content"
        rows={10}
        className="mono"
        value={value}
        disabled={!file.data}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="actions end">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={content === null || save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
      </div>
      {(file.error ?? save.error) && <p className="error">{(file.error ?? save.error)?.message}</p>}
    </div>
  );
}
