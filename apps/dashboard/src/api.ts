import type {
  AnswerDecisionRequest,
  CreateProjectRequest,
  Decision,
  Project,
  Role,
  RoleInput,
  Session,
  SessionMessage,
  StartSessionRequest,
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
  roles: () => call<Role[]>('GET', '/api/roles'),
  createRole: (req: RoleInput) => call<Role>('POST', '/api/roles', req),
  updateRole: (id: string, req: RoleInput) => call<Role>('PUT', `/api/roles/${id}`, req),
  deleteRole: (id: string) => call<void>('DELETE', `/api/roles/${id}`),
  sessions: (projectId: string) => call<Session[]>('GET', `/api/projects/${projectId}/sessions`),
  startSession: (projectId: string, req: StartSessionRequest) =>
    call<Session>('POST', `/api/projects/${projectId}/sessions`, req),
  session: (id: string) => call<Session>('GET', `/api/sessions/${id}`),
  messages: (id: string) => call<SessionMessage[]>('GET', `/api/sessions/${id}/messages`),
  send: (id: string, text: string) => call<void>('POST', `/api/sessions/${id}/messages`, { text }),
  interrupt: (id: string) => call<void>('POST', `/api/sessions/${id}/interrupt`),
  terminate: (id: string) => call<void>('DELETE', `/api/sessions/${id}`),
  decisions: (status?: Decision['status']) =>
    call<Decision[]>('GET', `/api/decisions${status ? `?status=${status}` : ''}`),
  answer: (id: string, req: AnswerDecisionRequest) => call<Decision>('POST', `/api/decisions/${id}`, req),
};
