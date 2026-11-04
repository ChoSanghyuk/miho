import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { StatusPill } from '../components/StatusPill';

export function ProjectPage({ projectName }: { projectName: string }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const project = projects.data?.find((p) => p.name === projectName);
  const projectId = project?.id ?? '';
  const sessions = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => api.sessions(projectId),
    enabled: !!project,
  });
  const [prompt, setPrompt] = useState('');
  const start = useMutation({
    mutationFn: () => api.startSession(projectId, { prompt }),
    onSuccess: (s) => (location.hash = `#/sessions/${s.id}`),
  });

  return (
    <>
      <p className="crumbs">
        <a href="#/">Projects</a> /
      </p>
      <h1>{projectName}</h1>
      {projects.data && !project && <p className="error">No project named "{projectName}".</p>}
      <p className="muted mono">{project?.workdir}</p>

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
