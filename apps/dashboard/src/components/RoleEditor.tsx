import type { Guideline, Role, RoleRequest } from '@orch/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';

/** Ordered parts of a role: guideline ids, with null marking the role's own description. */
type Part = string | null;

const toParts = (role?: Role): Part[] => {
  if (!role) return [null];
  const parts: Part[] = [...role.guidelineIds];
  parts.splice(role.descriptionIndex, 0, null);
  return parts;
};

/** Same rule as the server's composeRole; the server's `content` is authoritative after saving. */
function compose(parts: Part[], description: string, byId: Map<string, Guideline>): string {
  return parts
    .map((p) => (p === null ? description : `## ${byId.get(p)?.name ?? '?'}\n\n${byId.get(p)?.description ?? ''}`))
    .filter((p) => p.trim())
    .join('\n\n');
}

export function RoleEditor(props: {
  role?: Role;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (req: RoleRequest) => void;
  onDelete?: () => void;
}) {
  const guidelines = useQuery({ queryKey: ['guidelines'], queryFn: api.guidelines });
  const byId = new Map((guidelines.data ?? []).map((g) => [g.id, g]));
  const [name, setName] = useState(props.role?.name ?? '');
  const [description, setDescription] = useState(props.role?.description ?? '');
  const [parts, setParts] = useState<Part[]>(() => toParts(props.role));

  const toggle = (id: string) => setParts((ps) => (ps.includes(id) ? ps.filter((p) => p !== id) : [...ps, id]));
  const move = (i: number, by: -1 | 1) =>
    setParts((ps) => {
      const next = [...ps];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      return next;
    });

  const guidelineIds = parts.filter((p): p is string => p !== null);
  const descriptionIndex = parts.indexOf(null);
  const r = props.role;
  const dirty =
    !r ||
    name !== r.name ||
    description !== r.description ||
    descriptionIndex !== r.descriptionIndex ||
    guidelineIds.join() !== r.guidelineIds.join();

  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit({ name, description, guidelineIds, descriptionIndex });
      }}
    >
      <input placeholder="Role name (also the folder name)" value={name} onChange={(e) => setName(e.target.value)} required />
      <textarea
        rows={4}
        placeholder="Role description (its own text in CLAUDE.md)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {!!guidelines.data?.length && (
        <div>
          <span className="eyebrow field-label">Guidelines</span>
          {guidelines.data.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={parts.includes(g.id)} onChange={() => toggle(g.id)} />
              {g.name}
            </label>
          ))}
        </div>
      )}

      {parts.length > 1 && (
        <div>
          <span className="eyebrow field-label">Order in CLAUDE.md</span>
          <ol className="order">
            {parts.map((p, i) => (
              <li key={p ?? 'own'}>
                <span className={p === null ? 'muted' : undefined}>{p === null ? 'Role description' : `## ${byId.get(p)?.name ?? '?'}`}</span>
                <button type="button" className="secondary" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  ↑
                </button>
                <button type="button" className="secondary" disabled={i === parts.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  ↓
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      <details>
        <summary className="link">Preview CLAUDE.md</summary>
        <pre>{`# Role: ${name}\n\n${compose(parts, description, byId)}`}</pre>
      </details>

      <div className="actions">
        <button disabled={!dirty || props.pending}>{props.submitLabel}</button>
        {props.onDelete && (
          <button type="button" className="danger" onClick={props.onDelete}>
            Delete
          </button>
        )}
      </div>
      {props.error && <p className="error">{props.error.message}</p>}
    </form>
  );
}
