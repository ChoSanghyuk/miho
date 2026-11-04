import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { DecisionCard } from '../components/DecisionCard';

export function DecisionsPage() {
  const pending = useQuery({ queryKey: ['decisions', 'pending'], queryFn: () => api.decisions('pending') });

  return (
    <>
      <h1>Decisions</h1>
      {pending.data?.length === 0 && <p className="muted">Nothing waiting on you.</p>}
      {pending.data?.map((d) => (
        <div key={d.id}>
          <p className="crumbs">
            <a href={`#/sessions/${d.sessionId}`} className="mono">
              session {d.sessionId.slice(0, 8)}
            </a>
          </p>
          <DecisionCard decision={d} />
        </div>
      ))}
    </>
  );
}
