import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ServerEvent, Session, SessionMessage } from '@orch/shared';

/** Keeps the query cache in sync with /ws. Reconnects with backoff and refetches everything after a reconnect. */
export function useEvents(): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        setConnected(true);
        delay = 500;
        void qc.invalidateQueries(); // catch up on anything missed while disconnected
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
      ws.onmessage = (m) => apply(JSON.parse(String(m.data)) as ServerEvent);
    };

    const apply = (e: ServerEvent) => {
      switch (e.type) {
        case 'session_output':
          qc.setQueryData<SessionMessage[]>(['messages', e.sessionId], (old) =>
            old && !old.some((m) => m.id === e.message.id) ? [...old, e.message] : old,
          );
          return;
        case 'session_status':
          qc.setQueryData<Session>(['session', e.sessionId], (old) => (old ? { ...old, status: e.status } : old));
          void qc.invalidateQueries({ queryKey: ['sessions'] });
          return;
        case 'decision_needed':
        case 'decision_resolved':
          void qc.invalidateQueries({ queryKey: ['decisions'] });
          return;
        case 'tasks_changed':
          void qc.invalidateQueries({ queryKey: ['tasks'] });
          return;
        case 'task_done':
          void qc.invalidateQueries({ queryKey: ['session', e.sessionId] });
          return;
      }
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [qc]);

  return connected;
}
