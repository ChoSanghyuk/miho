import type { RoleInput } from '@orch/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api';

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [name, setName] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [multi, setMulti] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Roles added only for this project; never saved to the roles menu.
  const [extra, setExtra] = useState<RoleInput[]>([]);
  const [extraName, setExtraName] = useState('');
  const [extraDesc, setExtraDesc] = useState('');

  const options: RoleInput[] = [...(roles.data ?? []), ...extra];
  const selected = multi ? options.filter((r) => checked.has(r.name)) : undefined;
  const toggle = (roleName: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (!next.delete(roleName)) next.add(roleName);
      return next;
    });

  const create = useMutation({
    mutationFn: async () => {
      if (selected?.length === 0) throw new Error('Pick at least one role.');
      try {
        return await api.createProject({ name, workdir, roles: selected });
      } catch (e) {
        // 404 = the folder doesn't exist yet; offer to create it.
        if (!(e instanceof ApiError && e.status === 404) || !confirm(`${e.message}\n\nCreate this directory?`)) throw e;
        return api.createProject({ name, workdir, createDir: true, roles: selected });
      }
    },
    onSuccess: (p) => {
      setName('');
      setWorkdir('');
      setMulti(false);
      setChecked(new Set());
      setExtra([]);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      location.hash = `#/projects/${encodeURIComponent(p.name)}`;
    },
  });

  return (
    <>
      <h1>Projects</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="form-row">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input
            placeholder="Folder, relative to projects.rootDir"
            value={workdir}
            onChange={(e) => setWorkdir(e.target.value)}
            required
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="check">
            <input type="radio" checked={!multi} onChange={() => setMulti(false)} /> Single session
          </label>
          <label className="check">
            <input type="radio" checked={multi} onChange={() => setMulti(true)} /> Multiple sessions (roles)
          </label>
        </div>

        {multi && (
          <div style={{ marginTop: 8 }}>
            {options.length === 0 && <p className="muted">No roles yet. Define them under Roles, or add one below.</p>}
            {options.map((r) => (
              <label key={r.name} className="check">
                <input type="checkbox" checked={checked.has(r.name)} onChange={() => toggle(r.name)} />
                <strong>{r.name}</strong>
                <span className="muted">{r.description}</span>
              </label>
            ))}
            <div className="form-row" style={{ marginTop: 8 }}>
              <input placeholder="Role for this project only" value={extraName} onChange={(e) => setExtraName(e.target.value)} />
              <input placeholder="Description" value={extraDesc} onChange={(e) => setExtraDesc(e.target.value)} />
              <button
                type="button"
                className="secondary"
                disabled={!extraName.trim() || options.some((r) => r.name === extraName.trim())}
                onClick={() => {
                  const role = { name: extraName.trim(), description: extraDesc };
                  setExtra((x) => [...x, role]);
                  setChecked((s) => new Set(s).add(role.name));
                  setExtraName('');
                  setExtraDesc('');
                }}
              >
                Add role
              </button>
            </div>
          </div>
        )}

        <div className="actions">
          <button disabled={create.isPending}>Create project</button>
        </div>
        {create.error && <p className="error">{create.error.message}</p>}
      </form>

      {projects.data?.length === 0 && <p className="muted">No projects yet.</p>}
      <ul className="list">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <a href={`#/projects/${encodeURIComponent(p.name)}`} className="card row">
              <strong>{p.name}</strong>
              <span className="muted mono">{p.workdir}</span>
              {p.roles.length > 0 && <span className="muted grow-right">{p.roles.join(', ')}</span>}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
