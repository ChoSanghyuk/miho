import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AnswerDecisionRequest, Decision } from '@orch/shared';
import { api } from '../api';

export function DecisionCard({ decision }: { decision: Decision }) {
  const answer = useMutation({ mutationFn: (req: AnswerDecisionRequest) => api.answer(decision.id, req) });
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const reply = (choice: string) => answer.mutate({ answer: { choice } });
  const toggle = (option: string) =>
    setPicked((p) => (p.includes(option) ? p.filter((o) => o !== option) : [...p, option]));

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
          {decision.payload.multiSelect ? (
            <div className="actions">
              {decision.payload.options.map((option) => (
                <label key={option} className="check">
                  <input type="checkbox" checked={picked.includes(option)} onChange={() => toggle(option)} /> {option}
                </label>
              ))}
              <button
                disabled={answer.isPending || picked.length === 0}
                // In the options' order, joined the way Claude Code answers multi-select questions.
                onClick={() => reply(decision.payload.options.filter((o) => picked.includes(o)).join(', '))}
              >
                Submit
              </button>
            </div>
          ) : (
            <div className="actions">
              {decision.payload.options.map((choice) => (
                <button key={choice} disabled={answer.isPending} onClick={() => reply(choice)}>
                  {choice}
                </button>
              ))}
            </div>
          )}
          <form
            className="actions"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) reply(text.trim());
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or answer in your own words" />
            <button type="submit" className="secondary" disabled={answer.isPending || !text.trim()}>
              Send
            </button>
          </form>
        </>
      )}
      {answer.error && <p className="error">{answer.error.message}</p>}
    </div>
  );
}
