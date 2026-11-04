import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type DragEvent } from 'react';
import type { MoveTaskRequest, Project, Task } from '@orch/shared';
import { api } from '../api';

const STATUS_LABELS: Record<Task['status'], string> = {
  wait: 'Wait',
  run: 'Run',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
};

/** Only waiting, non-parallel tasks can be dragged into, within or out of groups. */
const draggable = (t: Task) => t.status === 'wait' && !t.parallel;

export function TasksPage() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const projectById = new Map((projects.data ?? []).map((p) => [p.id, p]));

  const refresh = () => void qc.invalidateQueries({ queryKey: ['tasks'] });
  const move = useMutation({ mutationFn: (v: { id: string; req: MoveTaskRequest }) => api.moveTask(v.id, v.req), onSettled: refresh });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: 'wait' | 'run' }) => api.setTaskStatus(v.id, v.status),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteTask, onSettled: refresh });
  const runGroup = useMutation({ mutationFn: api.runGroup, onSettled: refresh });
  const error = move.error ?? setStatus.error ?? remove.error ?? runGroup.error;

  // Drag state: the task being dragged and the drop target under the pointer.
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dropProps = (key: string, req: MoveTaskRequest, enabled = true) =>
    enabled && dragId
      ? {
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(key);
          },
          onDragLeave: () => setOver((o) => (o === key ? null : o)),
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(null);
            if (dragId) move.mutate({ id: dragId, req });
            setDragId(null);
          },
        }
      : {};

  // Groups and solo tasks, in order of their first task's creation.
  const entries: { groupId: string | null; tasks: Task[] }[] = [];
  for (const t of tasks.data?.tasks ?? []) {
    const group = t.groupId && entries.find((e) => e.groupId === t.groupId);
    if (group) group.tasks.push(t);
    else entries.push({ groupId: t.groupId, tasks: [t] });
  }
  for (const e of entries) e.tasks.sort((a, b) => a.position - b.position);
  const groups = entries.filter((e) => e.groupId);
  const solos = entries.filter((e) => !e.groupId).map((e) => e.tasks[0]!);

  const row = (t: Task) => {
    const project = projectById.get(t.projectId);
    return (
      <li
        key={t.id}
        className={`card task ${over === t.id ? 'drop-over' : ''}`}
        draggable={draggable(t)}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', t.id);
          setDragId(t.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setOver(null);
        }}
        {...dropProps(t.id, { before: t.id }, !t.parallel && dragId !== t.id)}
      >
        <div className="row">
          <span className={`pill pill-task-${t.status}`}>{STATUS_LABELS[t.status]}</span>
          <strong>{t.name}</strong>
          <span className="muted">
            {project?.name ?? '?'}
            {t.role ? ` / ${t.role}` : ''}
          </span>
          {t.parallel && <span className="muted">parallel</span>}
          <span className="actions grow-right" style={{ marginTop: 0 }}>
            {t.sessionId && <a href={`#/sessions/${t.sessionId}`}>Session</a>}
            {t.status === 'wait' && (
              <button type="button" onClick={() => setStatus.mutate({ id: t.id, status: 'run' })}>
                Run
              </button>
            )}
            {t.status === 'run' && (
              <button type="button" className="secondary" onClick={() => setStatus.mutate({ id: t.id, status: 'wait' })}>
                Wait
              </button>
            )}
            {t.status === 'failed' && (
              <button type="button" onClick={() => setStatus.mutate({ id: t.id, status: 'run' })}>
                Retry
              </button>
            )}
            {t.status !== 'working' && (
              <button type="button" className="danger" onClick={() => remove.mutate(t.id)}>
                Delete
              </button>
            )}
          </span>
        </div>
        <p className="muted content">{t.content}</p>
      </li>
    );
  };

  return (
    <>
      <h1>Todos</h1>
      <CreateTaskForm projects={projects.data ?? []} onCreated={refresh} />

      {tasks.data?.pausedUntil && (
        <p className="card banner">
          Usage limit reached. Tasks resume at {new Date(tasks.data.pausedUntil).toLocaleString()}.
        </p>
      )}
      {error && <p className="error">{error.message}</p>}
      <p className="muted">
        Drag a waiting task onto another task to put it in front of that task in one group, onto a group header to append it,
        or onto Ungrouped to take it out. Tasks in a group run in order.
      </p>

      {groups.map((g) => (
        <section key={g.groupId} className="card group">
          <div className={`row ${over === g.groupId ? 'drop-over' : ''}`} {...dropProps(g.groupId!, { groupId: g.groupId! })}>
            <strong>Group</strong>
            <span className="muted">{g.tasks.length} tasks</span>
            <span className="actions grow-right" style={{ marginTop: 0 }}>
              <button
                type="button"
                disabled={!g.tasks.some((t) => t.status === 'wait' || t.status === 'failed')}
                onClick={() => runGroup.mutate(g.groupId!)}
              >
                Run all
              </button>
            </span>
          </div>
          <ol className="list" style={{ marginTop: 8 }}>
            {g.tasks.map(row)}
          </ol>
        </section>
      ))}

      <h2>Ungrouped</h2>
      <ul className={`list drop-zone ${over === 'ungrouped' ? 'drop-over' : ''}`} {...dropProps('ungrouped', {})}>
        {solos.length === 0 && <li className="muted">No ungrouped tasks.</li>}
        {solos.map(row)}
      </ul>
    </>
  );
}

function CreateTaskForm({ projects, onCreated }: { projects: Project[]; onCreated: () => void }) {
  const [projectId, setProjectId] = useState('');
  const [role, setRole] = useState('');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [parallel, setParallel] = useState(false);
  const project = projects.find((p) => p.id === projectId);
  const create = useMutation({
    mutationFn: () => api.createTask({ projectId, role: role || undefined, name, content, parallel }),
    onSuccess: () => {
      setName('');
      setContent('');
      setParallel(false);
      onCreated();
    },
  });

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="form-row">
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setRole('');
          }}
          aria-label="Project"
          required
        >
          <option value="">Project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
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
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <textarea
        rows={3}
        style={{ marginTop: 8 }}
        placeholder="What should Claude do?"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        required
      />
      <div className="actions">
        <label className="check">
          <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} /> Can run in parallel
        </label>
        <button disabled={create.isPending}>Add task</button>
      </div>
      {create.error && <p className="error">{create.error.message}</p>}
    </form>
  );
}
