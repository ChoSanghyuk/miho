import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [name, setName] = useState('');
  const [workdir, setWorkdir] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject({ name, workdir }),
    onSuccess: (p) => {
      setName('');
      setWorkdir('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
      location.hash = `#/projects/${p.id}`;
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
            <a href={`#/projects/${p.id}`} className="card row">
              <strong>{p.name}</strong>
              <span className="muted mono">{p.workdir}</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
