import type { Guideline } from '@orch/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

/** Shared sections that roles compose into their CLAUDE.md as `## name`. */
export function GuidelinesPage() {
  const qc = useQueryClient();
  const guidelines = useQuery({ queryKey: ['guidelines'], queryFn: api.guidelines });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => api.createGuideline({ name, description }),
    onSuccess: () => {
      setName('');
      setDescription('');
      void qc.invalidateQueries({ queryKey: ['guidelines'] });
    },
  });

  return (
    <>
      <h1>Guidelines</h1>
      <h2>New guideline</h2>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input placeholder="Guideline name (becomes a ## heading)" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea
          rows={4}
          placeholder="Content under the heading"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="actions">
          <button disabled={create.isPending}>Add guideline</button>
        </div>
        {create.error && <p className="error">{create.error.message}</p>}
      </form>

      <h2>Shared guidelines</h2>
      {guidelines.data?.length === 0 && <p className="empty">No guidelines yet.</p>}
      <ul className="list">
        {guidelines.data?.map((g) => (
          <GuidelineItem key={g.id} guideline={g} />
        ))}
      </ul>
    </>
  );
}

function GuidelineItem({ guideline }: { guideline: Guideline }) {
  const qc = useQueryClient();
  const [name, setName] = useState(guideline.name);
  const [description, setDescription] = useState(guideline.description);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['guidelines'] });
    void qc.invalidateQueries({ queryKey: ['roles'] }); // role content is composed from guidelines
  };
  const save = useMutation({ mutationFn: () => api.updateGuideline(guideline.id, { name, description }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.deleteGuideline(guideline.id), onSuccess: refresh });
  const dirty = name !== guideline.name || description !== guideline.description;

  return (
    <li className="card stack">
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
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
