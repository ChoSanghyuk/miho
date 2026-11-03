import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState('checking…');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? 'connected' : `error ${r.status}`))
      .catch(() => 'unreachable')
      .then(setStatus);
  }, []);

  return (
    <main>
      <h1>AI Orchestrator</h1>
      <p>Backend: {status}</p>
    </main>
  );
}
