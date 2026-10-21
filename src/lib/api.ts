import type { MessageParams } from '../../shared/messages.ts'
import type { AdminUser, BoardRecord, ClubSettings, HistoryPage, Me } from '../../shared/protocol.ts'

/** HTTP calls to the Worker. The session lives in an HttpOnly cookie, so no token is handled here. */

/** An error from the API; `code` and `params` translate it (shared/messages.ts) */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly params: MessageParams
  constructor(message: string, status: number, code = '', params: MessageParams = {}) {
    super(message)
    this.status = status
    this.code = code
    this.params = params
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data.code ?? '', data.params ?? {})
  return data as T
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  me: () => request<{ user: Me }>('/api/me'),
  login: (username: string, password: string) => post<{ user: Me }>('/api/login', { username, password }),
  register: (username: string, password: string, inviteCode: string) =>
    post<{ user: Me }>('/api/register', { username, password, inviteCode }),
  logout: () => post<{ ok: true }>('/api/logout'),
  changePassword: (current: string, next: string) => post<{ ok: true }>('/api/account/password', { current, next }),
  history: (all: boolean, before?: string) => {
    const query = new URLSearchParams()
    if (all) query.set('scope', 'all')
    if (before) query.set('before', before)
    const text = query.toString()
    return request<HistoryPage>(`/api/history${text ? `?${text}` : ''}`)
  },
  record: (id: string) => request<{ record: BoardRecord }>(`/api/history/${encodeURIComponent(id)}`),

  admin: {
    users: () => request<{ users: AdminUser[] }>('/api/admin/users'),
    createUser: (username: string, password: string) => post<{ user: Me }>('/api/admin/users', { username, password }),
    resetPassword: (id: string, password: string) => post<{ ok: true }>(`/api/admin/users/${id}/password`, { password }),
    setAdmin: (id: string, admin: boolean) => post<{ ok: true }>(`/api/admin/users/${id}/admin`, { admin }),
    deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
    settings: () => request<{ settings: ClubSettings }>('/api/admin/settings'),
    saveSettings: (settings: Partial<ClubSettings>) => post<{ settings: ClubSettings }>('/api/admin/settings', settings),
    closeTable: (id: string) => request<{ ok: true }>(`/api/admin/tables/${id}`, { method: 'DELETE' }),
  },
}
