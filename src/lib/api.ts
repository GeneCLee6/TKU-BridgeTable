import type { BoardRecord, BoardSummary, PublicUser } from '../../shared/protocol.ts'

/** HTTP calls to the Worker. The session lives in an HttpOnly cookie, so no token is handled here. */

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status)
  return data as T
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  me: () => request<{ user: PublicUser }>('/api/me'),
  login: (username: string, password: string) =>
    post<{ user: PublicUser }>('/api/login', { username, password }),
  register: (username: string, password: string, inviteCode: string) =>
    post<{ user: PublicUser }>('/api/register', { username, password, inviteCode }),
  logout: () => post<{ ok: true }>('/api/logout'),
  history: (all: boolean) =>
    request<{ boards: BoardSummary[] }>(`/api/history${all ? '?scope=all' : ''}`),
  record: (id: string) => request<{ record: BoardRecord }>(`/api/history/${encodeURIComponent(id)}`),
}
