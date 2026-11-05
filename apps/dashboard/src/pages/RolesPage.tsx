import type { Role } from '@orch/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { RoleEditor } from '../components/RoleEditor';

/** Predefined roles; a project with multiple sessions picks from these. */
export function RolesPage() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: api.roles });
  // Bumped after a successful add to remount (reset) the add form.
  const [formKey, setFormKey] = useState(0);
  const create = useMutation({
    mutationFn: api.createRole,
    onSuccess: () => {
      setFormKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  return (
    <>
      <h1>Roles</h1>
      <h2>New role</h2>
      <RoleEditor key={formKey} submitLabel="Add role" pending={create.isPending} error={create.error} onSubmit={create.mutate} />

      <h2>Defined roles</h2>
      {roles.data?.length === 0 && <p className="empty">No roles yet.</p>}
      <ul className="list">
        {roles.data?.map((r) => (
          <li key={r.id}>
            <RoleItem role={r} />
          </li>
        ))}
      </ul>
    </>
  );
}

function RoleItem({ role }: { role: Role }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['roles'] });
  const save = useMutation({ mutationFn: (req: Parameters<typeof api.updateRole>[1]) => api.updateRole(role.id, req), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteRole(role.id), onSuccess: refresh });

  return (
    <RoleEditor
      role={role}
      submitLabel="Save"
      pending={save.isPending || remove.isPending}
      error={save.error ?? remove.error}
      onSubmit={save.mutate}
      onDelete={() => remove.mutate()}
    />
  );
}
