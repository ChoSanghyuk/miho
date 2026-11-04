import type { SessionStatus } from '@orch/shared';

const LABELS: Record<SessionStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_decision: 'Needs decision',
  idle: 'Idle',
  terminated: 'Terminated',
  error: 'Error',
  interrupted: 'Interrupted',
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`pill pill-${status}`}>{LABELS[status]}</span>;
}
