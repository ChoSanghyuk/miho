import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, Unauthorized } from './api';
import { LoginPage } from './pages/LoginPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { GuidelinesPage } from './pages/GuidelinesPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RolesPage } from './pages/RolesPage';
import { SessionPage } from './pages/SessionPage';
import { TasksPage } from './pages/TasksPage';
import { useEvents } from './useEvents';

/** Hash routes: #/  #/projects/:name  #/sessions/:id  #/tasks  #/decisions  #/roles  #/guidelines */
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
  // Project and session pages live under Projects in the nav.
  const active = !section || section === 'sessions' ? 'projects' : section;
  const current = (s: string) => (active === s ? 'page' : undefined);

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand">MIHO</a>
        <nav>
          <a href="#/" aria-current={current('projects')}>Projects</a>
          <a href="#/tasks" aria-current={current('tasks')}>Todos</a>
          <a href="#/roles" aria-current={current('roles')}>Roles</a>
          <a href="#/guidelines" aria-current={current('guidelines')}>Guidelines</a>
          <a href="#/decisions" aria-current={current('decisions')}>
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
        ) : section === 'tasks' ? (
          <TasksPage />
        ) : section === 'decisions' ? (
          <DecisionsPage />
        ) : section === 'roles' ? (
          <RolesPage />
        ) : section === 'guidelines' ? (
          <GuidelinesPage />
        ) : (
          <ProjectsPage />
        )}
      </main>
    </div>
  );
}
