import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, Unauthorized } from './api';
import { LoginPage } from './pages/LoginPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SessionPage } from './pages/SessionPage';
import { useEvents } from './useEvents';

/** Hash routes: #/  #/projects/:name  #/sessions/:id  #/decisions */
function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  // /api/health requires the owner token, so it doubles as the "am I logged in?" check.
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.health, retry: false });
  if (auth.isPending) return null;
  if (auth.error instanceof Unauthorized) return <LoginPage />;
  return <Shell />;
}

function Shell() {
  const connected = useEvents();
  const [section, id] = useRoute();
  const pending = useQuery({ queryKey: ['decisions', 'pending'], queryFn: () => api.decisions('pending') });

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">AI Orchestrator</a>
        <nav>
          <a href="#/">Projects</a>
          <a href="#/decisions">
            Decisions
            {!!pending.data?.length && <span className="badge">{pending.data.length}</span>}
          </a>
        </nav>
        <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? 'Live' : 'Reconnecting…'}</span>
      </header>
      <main>
        {section === 'projects' && id ? (
          <ProjectPage projectName={id} />
        ) : section === 'sessions' && id ? (
          <SessionPage sessionId={id} />
        ) : section === 'decisions' ? (
          <DecisionsPage />
        ) : (
          <ProjectsPage />
        )}
      </main>
    </div>
  );
}
