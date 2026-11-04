import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api';

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [name, setName] = useState('');
  const [workdir, setWorkdir] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      try {
        return await api.createProject({ name, workdir });
      } catch (e) {
        // 404 = the folder doesn't exist yet; offer to create it.
        if (!(e instanceof ApiError && e.status === 404) || !confirm(`${e.message}\n\nCreate this directory?`)) throw e;
        return api.createProject({ name, workdir, createDir: true });
      }
    },
    onSuccess: (p) => {
      setName('');
      setWorkdir('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      location.hash = `#/projects/${encodeURIComponent(p.name)}`;
    },
  });

  return (
    <>
      <h1>Projects</h1>
      <form
        className="card form-row"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input
          placeholder="Folder, relative to projects.rootDir"
          value={workdir}
          onChange={(e) => setWorkdir(e.target.value)}
          required
        />
        <button disabled={create.isPending}>Create project</button>
        {create.error && <p className="error">{create.error.message}</p>}
      </form>

      {projects.data?.length === 0 && <p className="muted">No projects yet.</p>}
      <ul className="list">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <a href={`#/projects/${encodeURIComponent(p.name)}`} className="card row">
              <strong>{p.name}</strong>
              <span className="muted mono">{p.workdir}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
