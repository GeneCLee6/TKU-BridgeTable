import { useCallback, useEffect, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { LIMITS, PERMISSIONS, type AdminUser, type Application, type ClubSettings, type Permission } from '../../shared/protocol.ts'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The club admin page: registrations waiting for approval, settings (account limit, invite code),
 * members (TKU BridgeBook permissions, reset password, admin role, delete), adding a member
 * directly, and closing stuck tables. Only admins reach it. The accounts are shared with
 * TKU BridgeBook, which has the same approvals and permissions on its own admin page.
 */

const Stack = styled.div`
  display: grid;
  /* minmax(0, …) so the members table scrolls inside its card instead of widening the page */
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
`

const SectionTitle = styled.h2`
  margin: 0 0 12px;
  font-size: 18px;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

const Form = styled.form`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
`

const Field = styled.label`
  display: grid;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;

  & > input {
    min-height: 38px;
    padding: 0 10px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.bg};
    font-size: 15px;
    font-weight: 400;
  }
  & > small { color: ${({ theme }) => theme.colors.textMuted}; font-weight: 400; }
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;

  th, td {
    padding: 8px 10px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
    vertical-align: middle;
  }
  th { color: ${({ theme }) => theme.colors.textMuted}; font-size: 13px; font-weight: 600; white-space: nowrap; }
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
`

const Badge = styled.span<{ $on: boolean }>`
  display: inline-block;
  padding: 0 8px;
  border-radius: 999px;
  background: ${({ theme, $on }) => ($on ? theme.colors.primarySoft : theme.colors.surfaceAlt)};
  color: ${({ theme, $on }) => ($on ? theme.colors.primary : theme.colors.textMuted)};
  font-size: 13px;
  font-weight: 700;
`

const Online = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.success};
`

const Inline = styled.input`
  min-height: 32px;
  width: 140px;
  padding: 0 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bg};
`

const Small = styled.small`
  display: block;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
`

const Check = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 10px;
  font-size: 14px;
  white-space: nowrap;
`

const Success = styled.span`
  color: ${({ theme }) => theme.colors.success};
  font-weight: 600;
`

type Pending = { id: string; action: 'password' | 'delete' | 'reject' } | null

export function AdminPage() {
  const { t, lang, message } = usePreferences()
  const { user: me, refresh } = useAuth()
  const { lobby } = useClub()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [applications, setApplications] = useState<Application[]>([])
  const [settings, setSettings] = useState<ClubSettings | null>(null)
  const [draft, setDraft] = useState({ maxUsers: '', inviteCode: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending>(null)
  const [newPassword, setNewPassword] = useState('')
  const [member, setMember] = useState({ username: '', password: '' })

  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError),
    [message, t],
  )

  const reload = useCallback(
    () =>
      Promise.all([api.admin.users(), api.admin.settings(), api.admin.applications()])
        .then(([{ users }, { settings }, { applications }]) => {
          setUsers(users)
          setSettings(settings)
          setApplications(applications)
          setDraft({ maxUsers: String(settings.maxUsers), inviteCode: settings.inviteCode })
          // The header shows how many applications are waiting
          void refresh()
        })
        .catch(fail),
    [fail, refresh],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  const run = async (work: () => Promise<unknown>) => {
    setError('')
    setNotice('')
    try {
      await work()
      setNotice(t.saved)
      setPending(null)
      setNewPassword('')
      await reload()
    } catch (e) {
      fail(e)
    }
  }

  const saveSettings = (e: FormEvent) => {
    e.preventDefault()
    void run(() => api.admin.saveSettings({ maxUsers: Number(draft.maxUsers), inviteCode: draft.inviteCode }))
  }

  const permissionLabel: Record<Permission, string> = {
    bookEdit: t.permissionBookEdit,
    bookImport: t.permissionBookImport,
  }
  const togglePermission = (u: AdminUser, permission: Permission, on: boolean) =>
    void run(() =>
      api.admin.setPermissions(
        u.id,
        PERMISSIONS.filter((p) => (p === permission ? on : u.permissions.includes(p))),
      ),
    )

  const addMember = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api.admin.createUser(member.username, member.password)
      setMember({ username: '', password: '' })
    })
  }

  if (!users || !settings)
    return (
      <PageMain>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
      </PageMain>
    )

  return (
    <PageMain>
      <PageTitle>{t.adminTitle}</PageTitle>
      <Stack>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        {notice && <Success role="status">{notice}</Success>}

        <Card>
          <SectionTitle>
            {t.applicationsTitle}
            {applications.length > 0 && `（${applications.length}）`}
          </SectionTitle>
          {!applications.length ? (
            <Muted>{t.noApplications}</Muted>
          ) : (
            <Scroll>
              <Table aria-label={t.applicationsTitle}>
                <thead>
                  <tr>
                    <th>{t.username}</th>
                    <th>{t.about}</th>
                    <th>{t.applied}</th>
                    <th>{t.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((a) => (
                    <tr key={a.id}>
                      <td>
                        {a.username}
                        <Small>{t.appliedFrom(a.site)}</Small>
                      </td>
                      <td>{a.note || t.never}</td>
                      <td>{formatDateTime(a.createdAt, lang)}</td>
                      <td>
                        {pending?.id === a.id && pending.action === 'reject' ? (
                          <Row>
                            <span>{t.confirmReject(a.username)}</span>
                            <Button type="button" $small $variant="danger" onClick={() => void run(() => api.admin.reject(a.id))}>
                              {t.confirm}
                            </Button>
                            <Button type="button" $small onClick={() => setPending(null)}>
                              {t.cancel}
                            </Button>
                          </Row>
                        ) : (
                          <Row>
                            <Button type="button" $small $variant="primary" onClick={() => void run(() => api.admin.approve(a.id))}>
                              {t.approve}
                            </Button>
                            <Button type="button" $small $variant="danger" onClick={() => setPending({ id: a.id, action: 'reject' })}>
                              {t.reject}
                            </Button>
                          </Row>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Scroll>
          )}
        </Card>

        <Card>
          <SectionTitle>{t.settingsTitle}</SectionTitle>
          <Form onSubmit={saveSettings} aria-label={t.settingsTitle}>
            <Field>
              {t.maxUsers}
              <input
                type="number"
                min={LIMITS.maxUsersMin}
                max={LIMITS.maxUsersMax}
                value={draft.maxUsers}
                onChange={(e) => setDraft({ ...draft, maxUsers: e.target.value })}
              />
            </Field>
            <Field>
              {t.inviteCode}
              <input value={draft.inviteCode} onChange={(e) => setDraft({ ...draft, inviteCode: e.target.value })} />
              <small>{t.inviteCodeHint}</small>
            </Field>
            <Button type="submit" $variant="primary">
              {t.save}
            </Button>
          </Form>
        </Card>

        <Card>
          <SectionTitle>
            {t.membersTitle}（{t.memberCount(users.length, settings.maxUsers)}）
          </SectionTitle>
          <Scroll>
            <Table>
              <thead>
                <tr>
                  <th>{t.username}</th>
                  <th>{t.role}</th>
                  <th>{t.bookPermissions}</th>
                  <th>{t.joined}</th>
                  <th>{t.lastLogin}</th>
                  <th>{t.boardsCount}</th>
                  <th>{t.actions}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me?.id
                  const editing = pending?.id === u.id ? pending.action : null
                  return (
                    <tr key={u.id}>
                      <td>
                        {u.username}
                        {u.online && <Online aria-label={t.online} />}
                        {u.passwordResetAt && <Small>{t.selfReset(formatDateTime(u.passwordResetAt, lang))}</Small>}
                      </td>
                      <td>
                        <Badge $on={u.admin}>{u.admin ? t.admin : t.member}</Badge>
                      </td>
                      <td title={u.admin ? t.adminHasAll : undefined}>
                        {PERMISSIONS.map((permission) => (
                          <Check key={permission}>
                            <input
                              type="checkbox"
                              checked={u.permissions.includes(permission)}
                              disabled={u.admin}
                              onChange={(e) => togglePermission(u, permission, e.target.checked)}
                              aria-label={`${u.username}：${permissionLabel[permission]}`}
                            />
                            {permissionLabel[permission]}
                          </Check>
                        ))}
                      </td>
                      <td>{formatDateTime(u.createdAt, lang)}</td>
                      <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt, lang) : t.never}</td>
                      <td>{u.boards}</td>
                      <td>
                        {editing === 'password' ? (
                          <Row>
                            <Inline
                              type="password"
                              autoFocus
                              value={newPassword}
                              minLength={LIMITS.passwordMin}
                              onChange={(e) => setNewPassword(e.target.value)}
                              aria-label={t.newPasswordFor(u.username)}
                              placeholder={t.newPassword}
                            />
                            <Button type="button" $small $variant="primary" onClick={() => void run(() => api.admin.resetPassword(u.id, newPassword))}>
                              {t.save}
                            </Button>
                            <Button type="button" $small onClick={() => setPending(null)}>
                              {t.cancel}
                            </Button>
                          </Row>
                        ) : editing === 'delete' ? (
                          <Row>
                            <span>{t.confirmDelete(u.username)}</span>
                            <Button type="button" $small $variant="danger" onClick={() => void run(() => api.admin.deleteUser(u.id))}>
                              {t.confirm}
                            </Button>
                            <Button type="button" $small onClick={() => setPending(null)}>
                              {t.cancel}
                            </Button>
                          </Row>
                        ) : (
                          <Row>
                            <Button type="button" $small onClick={() => setPending({ id: u.id, action: 'password' })}>
                              {t.resetPassword}
                            </Button>
                            {!self && (
                              <Button type="button" $small onClick={() => void run(() => api.admin.setAdmin(u.id, !u.admin))}>
                                {u.admin ? t.removeAdmin : t.makeAdmin}
                              </Button>
                            )}
                            {!self && (
                              <Button type="button" $small $variant="danger" onClick={() => setPending({ id: u.id, action: 'delete' })}>
                                {t.deleteMember}
                              </Button>
                            )}
                          </Row>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          </Scroll>
        </Card>

        <Card>
          <SectionTitle>{t.addMember}</SectionTitle>
          <Form onSubmit={addMember} aria-label={t.addMember}>
            <Field>
              {t.username}
              <input
                value={member.username}
                autoComplete="off"
                onChange={(e) => setMember({ ...member, username: e.target.value })}
                required
              />
            </Field>
            <Field>
              {t.password}
              <input
                type="password"
                value={member.password}
                autoComplete="new-password"
                minLength={LIMITS.passwordMin}
                onChange={(e) => setMember({ ...member, password: e.target.value })}
                required
              />
            </Field>
            <Button type="submit" $variant="primary">
              {t.add}
            </Button>
          </Form>
        </Card>

        <Card>
          <SectionTitle>{t.tablesTitle}</SectionTitle>
          {!lobby?.tables.length ? (
            <Muted>{t.noTablesAdmin}</Muted>
          ) : (
            <Table>
              <tbody>
                {lobby.tables.map((table) => (
                  <tr key={table.id}>
                    <td>{t.tableName(table.number)}</td>
                    <td>
                      {t.host}：{table.hostName}
                    </td>
                    <td>{t.boardsPlayed(table.boardsPlayed)}</td>
                    <td>
                      <Button type="button" $small $variant="danger" onClick={() => void run(() => api.admin.closeTable(table.id))}>
                        {t.closeTable}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </Stack>
    </PageMain>
  )
}
