import type { Role } from '@orch/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

/** Predefined roles; a project with multiple sessions picks from these. */
export function RolesPage() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.createRole({ name, description }),
    onSuccess: () => {
      setName('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  return (
    <>
      <h1>Roles</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input placeholder="Role name (also the folder name)" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea
          rows={4}
          placeholder="Description, written to the role's CLAUDE.md"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="actions">
          <button disabled={create.isPending}>Add role</button>
        </div>
        {create.error && <p className="error">{create.error.message}</p>}
      </form>

      {roles.data?.length === 0 && <p className="muted">No roles yet.</p>}
      <ul className="list">
        {roles.data?.map((r) => (
          <RoleItem key={r.id} role={r} />
        ))}
      </ul>
    </>
  );
}

function RoleItem({ role }: { role: Role }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['roles'] });
  const save = useMutation({ mutationFn: () => api.updateRole(role.id, { name, description }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteRole(role.id), onSuccess: refresh });
  const dirty = name !== role.name || description !== role.description;

  return (
    <li className="card">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} style={{ marginTop: 8 }} />
      <div className="actions">
        <button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
        <button className="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Delete
        </button>
      </div>
      {(save.error ?? remove.error) && <p className="error">{(save.error ?? remove.error)?.message}</p>}
    </li>
  );
}
