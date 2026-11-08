import type {
  AnswerDecisionRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  Decision,
  Guideline,
  MoveTaskRequest,
  GuidelineRequest,
  Project,
  ProjectRoleFile,
  Role,
  RoleInput,
  RoleRequest,
  Session,
  SessionMessage,
  StartSessionRequest,
  Task,
  TasksResponse,
  UpdateProjectRoleRequest,
} from '@orch/shared';

/** The server rejected the owner token (missing or expired cookie). */
export class Unauthorized extends Error {}

/** Any other non-2xx response; `status` lets callers react to specific codes. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    const message = err?.error ?? `${res.status} ${res.statusText}`;
    throw res.status === 401 ? new Unauthorized(message) : new ApiError(res.status, message);
  }
  return (res.status === 202 || res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  health: () => call<{ ok: boolean }>('GET', '/api/health'),
  login: (token: string) => call<void>('POST', '/api/login', { token }),
  projects: () => call<Project[]>('GET', '/api/projects'),
  createProject: (req: CreateProjectRequest) => call<Project>('POST', '/api/projects', req),
  deleteProject: (id: string) => call<void>('DELETE', `/api/projects/${id}`),
  addProjectRole:(id: string, req: RoleInput) => call<Project>('POST', `/api/projects/${id}/roles`, req),
  projectRole: (id: string, role: string) =>
    call<ProjectRoleFile>('GET', `/api/projects/${id}/roles/${encodeURIComponent(role)}`),
  updateProjectRole: (id: string, role: string, req: UpdateProjectRoleRequest) =>
    call<ProjectRoleFile>('PUT', `/api/projects/${id}/roles/${encodeURIComponent(role)}`, req),
  roles: () => call<Role[]>('GET', '/api/roles'),
  createRole: (req: RoleRequest) => call<Role>('POST', '/api/roles', req),
  updateRole: (id: string, req: RoleRequest) => call<Role>('PUT', `/api/roles/${id}`, req),
  deleteRole: (id: string) => call<void>('DELETE', `/api/roles/${id}`),
  guidelines: () => call<Guideline[]>('GET', '/api/guidelines'),
  createGuideline: (req: GuidelineRequest) => call<Guideline>('POST', '/api/guidelines', req),
  updateGuideline: (id: string, req: GuidelineRequest) => call<Guideline>('PUT', `/api/guidelines/${id}`, req),
  deleteGuideline: (id: string) => call<void>('DELETE', `/api/guidelines/${id}`),
  sessions: (projectId: string) => call<Session[]>('GET', `/api/projects/${projectId}/sessions`),
  startSession: (projectId: string, req: StartSessionRequest) =>
    call<Session>('POST', `/api/projects/${projectId}/sessions`, req),
  session: (id: string) => call<Session>('GET', `/api/sessions/${id}`),
  messages: (id: string) => call<SessionMessage[]>('GET', `/api/sessions/${id}/messages`),
  send: (id: string, text: string) => call<void>('POST', `/api/sessions/${id}/messages`, { text }),
  interrupt: (id: string) => call<void>('POST', `/api/sessions/${id}/interrupt`),
  terminate: (id: string) => call<void>('DELETE', `/api/sessions/${id}`),
  tasks: () => call<TasksResponse>('GET', '/api/tasks'),
  createTask: (req: CreateTaskRequest) => call<Task>('POST', '/api/tasks', req),
  setTaskStatus: (id: string, status: 'wait' | 'run') => call<Task>('PUT', `/api/tasks/${id}/status`, { status }),
  moveTask: (id: string, req: MoveTaskRequest) => call<void>('PUT', `/api/tasks/${id}/position`, req),
  deleteTask: (id: string) => call<void>('DELETE', `/api/tasks/${id}`),
  runGroup: (groupId: string) => call<void>('POST', `/api/task-groups/${groupId}/run`),
  decisions: (status?: Decision['status']) =>
    call<Decision[]>('GET', `/api/decisions${status ? `?status=${status}` : ''}`),
  answer: (id: string, req: AnswerDecisionRequest) => call<Decision>('POST', `/api/decisions/${id}`, req),
};
