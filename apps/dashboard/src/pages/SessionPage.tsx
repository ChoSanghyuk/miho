import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { SessionMessage } from '@orch/shared';
import { api } from '../api';
import { DecisionCard } from '../components/DecisionCard';
import { StatusPill } from '../components/StatusPill';

const RESUMABLE = ['interrupted', 'error', 'terminated'];

export function SessionPage({ sessionId }: { sessionId: string }) {
  const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId) });
  const messages = useQuery({ queryKey: ['messages', sessionId], queryFn: () => api.messages(sessionId) });
  const pending = useQuery({ queryKey: ['decisions', 'pending'], queryFn: () => api.decisions('pending') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const send = useMutation({ mutationFn: () => api.send(sessionId, text), onSuccess: () => setText('') });
  const interrupt = useMutation({ mutationFn: () => api.interrupt(sessionId) });
  const terminate = useMutation({ mutationFn: () => api.terminate(sessionId) });

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.data?.length]);

  const s = session.data;
  const project = projects.data?.find((p) => p.id === s?.projectId);
  const status = s?.status;
  const canSend = status === 'idle' || (status !== undefined && RESUMABLE.includes(status));
  const busy = status === 'running' || status === 'waiting_decision' || status === 'queued';
  const error = send.error ?? interrupt.error ?? terminate.error;

  return (
    <>
      <p className="crumbs">
        <a href="#/">Projects</a> /{' '}
        {project && <a href={`#/projects/${encodeURIComponent(project.name)}`}>{project.name}</a>} /
      </p>
      <div className="title-row">
        <h1 className="mono">{sessionId.slice(0, 8)}</h1>
        {status && <StatusPill status={status} />}
        {s && (
          <span className="muted">
            {s.model} · ${s.costUsd.toFixed(4)}
          </span>
        )}
        <span className="grow-right" />
        <button className="secondary" disabled={!busy || interrupt.isPending} onClick={() => interrupt.mutate()}>
          Interrupt
        </button>
        <button
          className="danger"
          disabled={!s || status === 'terminated' || terminate.isPending}
          onClick={() => terminate.mutate()}
        >
          Terminate
        </button>
      </div>

      <div className="console">
        {messages.data?.map((m) => <Message key={m.id} message={m} />)}
        {pending.data
          ?.filter((d) => d.sessionId === sessionId)
          .map((d) => <DecisionCard key={d.id} decision={d} />)}
        {busy && status !== 'waiting_decision' && <p className="muted working">Working…</p>}
        <div ref={bottom} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={status && RESUMABLE.includes(status) ? 'Send a message to resume this session' : 'Follow-up command'}
          disabled={!canSend}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) send.mutate();
          }}
          required
        />
        <button disabled={!canSend || send.isPending}>{status && RESUMABLE.includes(status) ? 'Resume' : 'Send'}</button>
      </form>
      {error && <p className="error">{error.message}</p>}
    </>
  );
}

function Message({ message }: { message: SessionMessage }) {
  const body = message.body as Record<string, unknown>;
  if (message.role === 'tool' && 'tool' in body) {
    return (
      <details className="msg tool">
        <summary>
          Tool · <strong>{String(body.tool)}</strong>
        </summary>
        <pre>{JSON.stringify(body.input, null, 2)}</pre>
      </details>
    );
  }
  if (message.role === 'tool' && 'result' in body) {
    return (
      <details className={`msg tool ${body.isError ? 'tool-error' : ''}`}>
        <summary>{body.isError ? 'Tool error' : 'Tool result'}</summary>
        <pre>{String(body.result)}</pre>
      </details>
    );
  }
  return (
    <div className={`msg ${message.role}`}>
      <div className="who">{message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Claude' : message.role}</div>
      <div className="text">{typeof body.text === 'string' ? body.text : JSON.stringify(body)}</div>
    </div>
  );
}
