import { useMutation } from '@tanstack/react-query';
import type { AnswerDecisionRequest, Decision } from '@orch/shared';
import { api } from '../api';

export function DecisionCard({ decision }: { decision: Decision }) {
  const answer = useMutation({ mutationFn: (req: AnswerDecisionRequest) => api.answer(decision.id, req) });

  return (
    <div className="card decision">
      {decision.kind === 'permission' ? (
        <>
          <div className="decision-title">
            Permission needed · <strong>{decision.payload.toolName}</strong>
          </div>
          <pre>{JSON.stringify(decision.payload.input, null, 2)}</pre>
          <div className="actions">
            <button disabled={answer.isPending} onClick={() => answer.mutate({ answer: { behavior: 'allow' } })}>
              Approve
            </button>
            <button
              className="secondary"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ answer: { behavior: 'deny' } })}
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="decision-title">Question</div>
          <p>{decision.payload.question}</p>
          <div className="actions">
            {decision.payload.options.map((choice) => (
              <button key={choice} disabled={answer.isPending} onClick={() => answer.mutate({ answer: { choice } })}>
                {choice}
              </button>
            ))}
          </div>
        </>
      )}
      {answer.error && <p className="error">{answer.error.message}</p>}
    </div>
  );
}
