import { MoreHorizontal, Pencil, Search } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import styled, { css } from 'styled-components'
import {
  LIMITS,
  PERMISSIONS,
  type AdminUser,
  type Application,
  type ClubSettings,
  type MemberChange,
  type Permission,
} from '../../shared/protocol.ts'
import type { BookSyncRow } from '../../shared/robot/system/tku/sources.ts'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { FeatureFlags } from '../components/FeatureFlags.tsx'
import { SystemStatus } from '../components/SystemStatus.tsx'
import { useToast } from '../components/Toast.tsx'
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
  ErrorText,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Muted,
  PageMain,
  PageTitle,
  Select,
} from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { formatDate, formatRelative } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'

/**
 * The club admin page (DESIGN.md §7.8, docs/design/03-admin.png): registrations waiting for
 * approval, settings (account limit, invite code), members (TKU BridgeBook permissions, reset
 * password, admin role, delete), adding a member directly, closing stuck tables, and the 淡江橋館
 * articles edited online since the robot's rules were checked against them (e5-t45), and the feature
 * flags (e11-t26). A section nav
 * on the left (a dropdown on a phone), one card per section. Everything opens read-only; the
 * settings and the members' roles and permissions change only after 「編輯」, and 「儲存」 sends the
 * section's changes in one request (DESIGN.md §7.9). Saving shows a toast, and an error the
 * server ties to a field shows under that field. Only admins reach it. The accounts are shared
 * with TKU BridgeBook, which has the same approvals and permissions on its own admin page.
 */

type SectionId = 'applications' | 'settings' | 'members' | 'add' | 'tables' | 'bookSync' | 'features' | 'status'
const SECTIONS: SectionId[] = ['applications', 'settings', 'members', 'add', 'tables', 'bookSync', 'features', 'status']
const anchor = (section: SectionId) => `admin-${section}`

/** Fields a server error can belong to */
type FieldKey = 'maxUsers' | 'inviteCode' | 'username' | 'password' | 'reset'

type Pending = { id: string; action: 'password' | 'delete' | 'reject' | 'close' } | null

/** A member's role and permissions, as the members section edits them */
type Role = { admin: boolean; permissions: Permission[] }

const samePermissions = (a: Permission[], b: Permission[]) => PERMISSIONS.every((p) => a.includes(p) === b.includes(p))

/**
 * What saving the members section sends: the members whose draft differs from the server's. A
 * member made admin sends only that; anyone left a member sends their permissions too when the role
 * changed, so taking away the admin role leaves exactly the permissions ticked on screen.
 */
function changesOf(users: AdminUser[], draft: Record<string, Role>): MemberChange[] {
  const changes: MemberChange[] = []
  for (const u of users) {
    const next = draft[u.id]
    if (!next) continue
    const change: MemberChange = { id: u.id }
    if (next.admin !== u.admin) change.admin = next.admin
    if (!next.admin && (next.admin !== u.admin || !samePermissions(next.permissions, u.permissions)))
      change.permissions = PERMISSIONS.filter((p) => next.permissions.includes(p))
    if (Object.keys(change).length > 1) changes.push(change)
  }
  return changes
}

export function AdminPage() {
  const { t, lang, message } = usePreferences()
  const { user: me, refresh } = useAuth()
  const { lobby } = useClub()
  const toast = useToast()
  const id = useId()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [applications, setApplications] = useState<Application[]>([])
  const [settings, setSettings] = useState<ClubSettings | null>(null)
  // Sections open for editing, each with its draft; nothing is sent until 「儲存」
  const [draft, setDraft] = useState<{ maxUsers: string; inviteCode: string } | null>(null)
  const [memberDraft, setMemberDraft] = useState<Record<string, Role> | null>(null)
  const [loadError, setLoadError] = useState('')
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [newPassword, setNewPassword] = useState('')
  const [member, setMember] = useState({ username: '', password: '' })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SectionId>('applications')
  const [sync, setSync] = useState<BookSyncRow[] | null>(null)

  const text = useCallback(
    (e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError),
    [message, t],
  )

  const reload = useCallback(
    () =>
      Promise.all([api.admin.users(), api.admin.settings(), api.admin.applications()])
        .then(([{ users }, { settings }, { applications }]) => {
          setUsers(users)
          setSettings(settings)
          setApplications(applications)
          setLoadError('')
          // The header shows how many applications are waiting
          void refresh()
        })
        .catch((e: unknown) => setLoadError(text(e))),
    [text, refresh],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  // The robot's sync with 淡江橋館 loads on its own: the rest of the page does not wait for it
  useEffect(() => {
    let live = true
    api.admin
      .bookSync()
      .then(({ sync }) => live && setSync(sync))
      .catch(() => live && setSync([]))
    return () => {
      live = false
    }
  }, [])

  /**
   * Runs one admin action: a toast when it worked, then the page reads everything again from the
   * server; an error under its field, or an error toast. Says whether it worked.
   */
  const run = async (key: string, work: () => Promise<unknown>, fields: Partial<Record<string, FieldKey>> = {}) => {
    setErrors({})
    setBusy(key)
    try {
      await work()
      toast.success(t.saved)
      setPending(null)
      setNewPassword('')
      await reload()
      return true
    } catch (e) {
      const field = e instanceof ApiError ? fields[e.code] : undefined
      if (field) setErrors({ [field]: text(e) })
      else toast.error(text(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  // What the open sections would change (DESIGN.md §7.9): the settings, and one entry per member
  const settingsDirty =
    !!draft && !!settings && (draft.maxUsers !== String(settings.maxUsers) || draft.inviteCode !== settings.inviteCode)
  const memberChanges = memberDraft && users ? changesOf(users, memberDraft) : []
  const dirty = settingsDirty || memberChanges.length > 0

  // Leaving the page with unsaved edits asks first: closing or reloading the tab, and links in the app
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    // Capture phase, before React Router's link handler, which skips a click already prevented
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link || link.target === '_blank') return
      const to = new URL(link.href, window.location.href)
      if (to.origin === window.location.origin && to.pathname === window.location.pathname) return
      if (window.confirm(t.adminLeaveConfirm)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [dirty, t])

  const editSettings = () => {
    if (!settings) return
    setErrors({})
    setDraft({ maxUsers: String(settings.maxUsers), inviteCode: settings.inviteCode })
  }
  const cancelSettings = () => {
    setErrors({})
    setDraft(null)
  }
  const saveSettings = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    if (!settingsDirty) return cancelSettings()
    const ok = await run(
      'settings',
      () => api.admin.saveSettings({ maxUsers: Number(draft.maxUsers), inviteCode: draft.inviteCode }),
      { badCap: 'maxUsers' },
    )
    if (ok) setDraft(null)
  }

  const permissionLabel: Record<Permission, string> = {
    bookEdit: t.permissionBookEdit,
    bookReview: t.permissionBookReview,
    bookImport: t.permissionBookImport,
    boardCurate: t.permissionBoardCurate,
    tkuSystem: t.permissionTkuSystem,
    forumModerate: t.permissionForumModerate,
  }
  const editMembers = () => {
    if (!users) return
    setMemberDraft(Object.fromEntries(users.map((u) => [u.id, { admin: u.admin, permissions: u.permissions }])))
  }
  const cancelMembers = () => setMemberDraft(null)
  const setRole = (u: AdminUser, change: Partial<Role>) =>
    setMemberDraft((all) => {
      const was = all?.[u.id] ?? { admin: u.admin, permissions: u.permissions }
      return { ...all, [u.id]: { ...was, ...change } }
    })
  const togglePermission = (u: AdminUser, permission: Permission, on: boolean) => {
    const was = memberDraft?.[u.id]?.permissions ?? u.permissions
    setRole(u, { permissions: PERMISSIONS.filter((p) => (p === permission ? on : was.includes(p))) })
  }
  const saveMembers = async () => {
    if (!memberChanges.length) return cancelMembers()
    if (await run('members', () => api.admin.updateMembers(memberChanges))) setMemberDraft(null)
  }

  const addMember = (e: FormEvent) => {
    e.preventDefault()
    void run(
      'add',
      async () => {
        await api.admin.createUser(member.username, member.password)
        setMember({ username: '', password: '' })
      },
      { badUsername: 'username', usernameTaken: 'username', shortPassword: 'password', longPassword: 'password' },
    )
  }

  const editPending = (next: Pending) => {
    setErrors({})
    setNewPassword('')
    setPending(next)
  }

  const go = (section: SectionId) => {
    setActive(section)
    document.getElementById(anchor(section))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  // Mark the section in view in the nav while scrolling: the last one whose top has passed under
  // the header, or the last one of all at the bottom of the page
  useEffect(() => {
    if (!users) return
    const onScroll = () => {
      const doc = document.documentElement
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) return setActive(SECTIONS[SECTIONS.length - 1])
      let current = SECTIONS[0]
      for (const section of SECTIONS) {
        const top = document.getElementById(anchor(section))?.getBoundingClientRect().top
        if (top !== undefined && top <= 120) current = section
      }
      setActive(current)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [users])

  if (!users || !settings)
    return (
      <PageMain>
        <PageTitle>{t.adminTitle}</PageTitle>
        {loadError ? (
          <ErrorText role="alert">{loadError}</ErrorText>
        ) : (
          <Skeletons aria-busy="true" aria-label={t.loading}>
            <Skeleton $h={120} />
            <Skeleton $h={220} />
            <Skeleton $h={320} />
          </Skeletons>
        )}
      </PageMain>
    )

  const tables = lobby?.tables ?? []
  const label: Record<SectionId, string> = {
    applications: t.applicationsTitle,
    settings: t.settingsTitle,
    members: t.membersTitle,
    add: t.addMember,
    tables: t.tablesTitle,
    bookSync: t.bookSyncTitle,
    features: t.featureFlags.title,
    status: t.statusTitle,
  }
  const outOfStep = sync?.filter((row) => !row.synced) ?? []
  const count: Record<SectionId, number | null> = {
    applications: applications.length,
    settings: null,
    members: users.length,
    add: null,
    tables: tables.length,
    bookSync: outOfStep.length || null,
    features: null,
    status: null,
  }
  const words = { today: t.timeToday, yesterday: t.timeYesterday }
  const relative = (at: number) => formatRelative(at, lang, words)
  const shown = query.trim() ? users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase())) : users
  const changed = new Set(memberChanges.map((c) => c.id))
  const unsaved = (
    <Unsaved>
      <Dot aria-hidden />
      {t.adminUnsaved}
    </Unsaved>
  )
  const fieldIds = (field: FieldKey, hint: boolean) => ({
    id: `${id}-${field}`,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': errors[field] ? `${id}-${field}-error` : hint ? `${id}-${field}-hint` : undefined,
  })
  const below = (field: FieldKey, hint?: ReactNode) =>
    errors[field] ? (
      <FieldError id={`${id}-${field}-error`} role="alert">
        {errors[field]}
      </FieldError>
    ) : hint ? (
      <FieldHint id={`${id}-${field}-hint`}>{hint}</FieldHint>
    ) : null

  return (
    <PageMain>
      <PageTitle>{t.adminTitle}</PageTitle>
      <Intro>{t.adminIntro}</Intro>
      {loadError && <ErrorText role="alert">{loadError}</ErrorText>}
      <Layout>
        <Nav aria-label={t.adminSections}>
          <SectionSelect
            aria-label={t.adminSections}
            value={active}
            onChange={(e) => go(e.target.value as SectionId)}
          >
            {SECTIONS.map((s) => (
              <option key={s} value={s}>
                {count[s] !== null ? `${label[s]}（${count[s]}）` : label[s]}
              </option>
            ))}
          </SectionSelect>
          <NavList>
            {SECTIONS.map((s) => (
              <li key={s}>
                <NavLink
                  href={`#${anchor(s)}`}
                  aria-current={active === s ? 'location' : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    go(s)
                  }}
                >
                  <span>{label[s]}</span>
                  {s === 'applications' || s === 'bookSync'
                    ? count[s]! > 0 && <GoldBadge>{count[s]}</GoldBadge>
                    : count[s] !== null && <NavCount>{count[s]}</NavCount>}
                </NavLink>
              </li>
            ))}
          </NavList>
        </Nav>

        <Stack>
          <Section id={anchor('applications')} aria-labelledby={`${id}-h-applications`}>
            <CardHeader>
              <TitleRow>
                <CardTitle id={`${id}-h-applications`}>{t.applicationsTitle}</CardTitle>
                {applications.length > 0 && <GoldBadge>{applications.length}</GoldBadge>}
              </TitleRow>
            </CardHeader>
            {!applications.length ? (
              <Empty>{t.noApplications}</Empty>
            ) : (
              <Flush>
                <Table aria-label={t.applicationsTitle}>
                  <thead>
                    <tr>
                      <th>{t.username}</th>
                      <th>{t.about}</th>
                      <th>{t.applied}</th>
                      <th className="end">{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applications.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Name>{a.username}</Name>
                          <Sub>{t.appliedFrom(a.site)}</Sub>
                        </td>
                        <td className="note">{a.note || t.never}</td>
                        <td className="time">{relative(a.createdAt)}</td>
                        <td className="end">
                          {pending?.id === a.id && pending.action === 'reject' ? (
                            <Actions>
                              <span>{t.confirmReject(a.username)}</span>
                              <Button
                                type="button"
                                $size="sm"
                                $variant="danger"
                                $busy={busy === `reject-${a.id}`}
                                onClick={() => void run(`reject-${a.id}`, () => api.admin.reject(a.id))}
                              >
                                {t.confirm}
                              </Button>
                              <Button type="button" $size="sm" onClick={() => editPending(null)}>
                                {t.cancel}
                              </Button>
                            </Actions>
                          ) : (
                            <Actions>
                              <Button
                                type="button"
                                $size="sm"
                                $variant="primary"
                                $busy={busy === `approve-${a.id}`}
                                onClick={() => void run(`approve-${a.id}`, () => api.admin.approve(a.id))}
                              >
                                {t.approve}
                              </Button>
                              <Button type="button" $size="sm" onClick={() => editPending({ id: a.id, action: 'reject' })}>
                                {t.reject}
                              </Button>
                            </Actions>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Flush>
            )}
          </Section>

          <Section id={anchor('settings')} aria-labelledby={`${id}-h-settings`} $editing={!!draft}>
            <CardHeader>
              <CardTitle id={`${id}-h-settings`}>{t.settingsTitle}</CardTitle>
              {!draft && (
                <Button type="button" $size="sm" aria-label={t.adminEditSection(t.settingsTitle)} onClick={editSettings}>
                  <Pencil size={14} aria-hidden />
                  {t.adminEdit}
                </Button>
              )}
            </CardHeader>
            {!draft ? (
              <FormGrid>
                <GridRow>
                  <FieldLabel as="span" id={`${id}-maxUsers-label`}>
                    {t.maxUsers}
                  </FieldLabel>
                  <Control>
                    <ReadValue aria-labelledby={`${id}-maxUsers-label`}>{settings.maxUsers}</ReadValue>
                    <FieldHint>{t.maxUsersHint(users.length, LIMITS.maxUsersMin, LIMITS.maxUsersMax)}</FieldHint>
                  </Control>
                </GridRow>
                <GridRow>
                  <FieldLabel as="span" id={`${id}-inviteCode-label`}>
                    {t.inviteCode}
                  </FieldLabel>
                  <Control>
                    <ReadValue aria-labelledby={`${id}-inviteCode-label`}>
                      {settings.inviteCode || <Muted as="span">{t.adminNoInviteCode}</Muted>}
                    </ReadValue>
                  </Control>
                </GridRow>
              </FormGrid>
            ) : (
              <form onSubmit={(e) => void saveSettings(e)} aria-label={t.settingsTitle}>
                <FormGrid>
                  <GridRow>
                    <FieldLabel htmlFor={`${id}-maxUsers`}>{t.maxUsers}</FieldLabel>
                    <Control>
                      <Input
                        {...fieldIds('maxUsers', true)}
                        type="number"
                        inputMode="numeric"
                        autoFocus
                        min={LIMITS.maxUsersMin}
                        max={LIMITS.maxUsersMax}
                        value={draft.maxUsers}
                        onChange={(e) => setDraft({ ...draft, maxUsers: e.target.value })}
                      />
                      {below('maxUsers', t.maxUsersHint(users.length, LIMITS.maxUsersMin, LIMITS.maxUsersMax))}
                    </Control>
                  </GridRow>
                  <GridRow>
                    <FieldLabel htmlFor={`${id}-inviteCode`}>{t.inviteCode}</FieldLabel>
                    <Control>
                      <Input
                        {...fieldIds('inviteCode', true)}
                        value={draft.inviteCode}
                        autoComplete="off"
                        onChange={(e) => setDraft({ ...draft, inviteCode: e.target.value })}
                      />
                      {below('inviteCode', t.inviteCodeHint)}
                    </Control>
                  </GridRow>
                </FormGrid>
                <CardFooter>
                  {settingsDirty && unsaved}
                  <Button type="button" onClick={cancelSettings} disabled={busy === 'settings'}>
                    {t.cancel}
                  </Button>
                  <Button type="submit" $variant="primary" $busy={busy === 'settings'}>
                    {busy === 'settings' ? t.saving : t.save}
                  </Button>
                </CardFooter>
              </form>
            )}
          </Section>

          <Section id={anchor('members')} aria-labelledby={`${id}-h-members`} $editing={!!memberDraft}>
            <CardHeader>
              <TitleRow>
                <CardTitle id={`${id}-h-members`}>{t.membersTitle}</CardTitle>
                <Muted>{t.memberCount(users.length, settings.maxUsers)}</Muted>
              </TitleRow>
              {/* Search at the left, 「編輯」 at the far right (社長 2026-10-27) */}
              <HeaderTools>
                <SearchBox>
                  <Search size={16} aria-hidden />
                  <Input
                    type="search"
                    $size="sm"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t.adminSearchMembers}
                    aria-label={t.adminSearchMembers}
                  />
                </SearchBox>
                {!memberDraft && (
                  <Button type="button" $size="sm" aria-label={t.adminEditSection(t.membersTitle)} onClick={editMembers}>
                    <Pencil size={14} aria-hidden />
                    {t.adminEdit}
                  </Button>
                )}
              </HeaderTools>
            </CardHeader>
            {!shown.length ? (
              <Empty>{t.adminNoMatch}</Empty>
            ) : (
              <Flush>
                <Table aria-label={t.membersTitle}>
                  <thead>
                    <tr>
                      <th>{t.username}</th>
                      <th>{t.role}</th>
                      <th>{t.bookPermissions}</th>
                      <th>{t.lastLogin}</th>
                      <th className="num">{t.boardsCount}</th>
                      <th className="end">{t.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((u) => {
                      const self = u.id === me?.id
                      const editing = pending?.id === u.id ? pending.action : null
                      const role = memberDraft?.[u.id] ?? { admin: u.admin, permissions: u.permissions }
                      return (
                        <tr key={u.id} data-changed={changed.has(u.id) || undefined}>
                          <td>
                            <Name>
                              {u.username}
                              {u.online && <Online role="img" aria-label={t.online} />}
                            </Name>
                            {changed.has(u.id) ? (
                              <Changed>{t.adminChanged}</Changed>
                            ) : (
                              <Sub>
                                {u.passwordResetAt
                                  ? t.selfReset(relative(u.passwordResetAt))
                                  : t.adminJoinedOn(formatDate(u.createdAt, lang))}
                              </Sub>
                            )}
                          </td>
                          <td>
                            {memberDraft ? (
                              <RoleSelect
                                $size="sm"
                                value={role.admin ? 'admin' : 'member'}
                                // Nobody takes away their own admin role
                                disabled={self || busy === 'members'}
                                onChange={(e) => setRole(u, { admin: e.target.value === 'admin' })}
                                aria-label={t.adminRoleOf(u.username)}
                              >
                                <option value="member">{t.member}</option>
                                <option value="admin">{t.admin}</option>
                              </RoleSelect>
                            ) : (
                              <Badge $on={u.admin}>{u.admin ? t.admin : t.member}</Badge>
                            )}
                          </td>
                          <td>
                            {role.admin ? (
                              <Sub as="span">{t.adminAllPermissions}</Sub>
                            ) : memberDraft ? (
                              PERMISSIONS.map((permission) => (
                                <Check key={permission}>
                                  <input
                                    type="checkbox"
                                    checked={role.permissions.includes(permission)}
                                    disabled={busy === 'members'}
                                    onChange={(e) => togglePermission(u, permission, e.target.checked)}
                                    aria-label={`${u.username}${t.colon}${permissionLabel[permission]}`}
                                  />
                                  {permissionLabel[permission]}
                                </Check>
                              ))
                            ) : u.permissions.length ? (
                              <PermissionList>
                                {u.permissions.map((p) => (
                                  <span key={p}>{permissionLabel[p]}</span>
                                ))}
                              </PermissionList>
                            ) : (
                              <Sub as="span">{t.adminNoPermissions}</Sub>
                            )}
                          </td>
                          <td className="time">{u.lastLoginAt ? relative(u.lastLoginAt) : t.never}</td>
                          <td className="num">{u.boards}</td>
                          <td className="end">
                            {editing === 'password' ? (
                              <PasswordRow>
                                <Actions>
                                  <PasswordInput
                                    id={`${id}-reset`}
                                    $size="sm"
                                    autoFocus
                                    value={newPassword}
                                    minLength={LIMITS.passwordMin}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    aria-label={t.newPasswordFor(u.username)}
                                    aria-invalid={errors.reset ? true : undefined}
                                    aria-describedby={errors.reset ? `${id}-reset-error` : undefined}
                                    placeholder={t.newPassword}
                                  />
                                  <Button
                                    type="button"
                                    $size="sm"
                                    $variant="primary"
                                    $busy={busy === `password-${u.id}`}
                                    onClick={() =>
                                      void run(`password-${u.id}`, () => api.admin.resetPassword(u.id, newPassword), {
                                        shortPassword: 'reset',
                                        longPassword: 'reset',
                                      })
                                    }
                                  >
                                    {t.save}
                                  </Button>
                                  <Button type="button" $size="sm" onClick={() => editPending(null)}>
                                    {t.cancel}
                                  </Button>
                                </Actions>
                                {below('reset')}
                              </PasswordRow>
                            ) : editing === 'delete' ? (
                              <Actions>
                                <span>{t.confirmDelete(u.username)}</span>
                                <Button
                                  type="button"
                                  $size="sm"
                                  $variant="danger"
                                  $busy={busy === `delete-${u.id}`}
                                  onClick={() => void run(`delete-${u.id}`, () => api.admin.deleteUser(u.id))}
                                >
                                  {t.confirm}
                                </Button>
                                <Button type="button" $size="sm" onClick={() => editPending(null)}>
                                  {t.cancel}
                                </Button>
                              </Actions>
                            ) : (
                              <Actions>
                                <Button type="button" $size="sm" onClick={() => editPending({ id: u.id, action: 'password' })}>
                                  {t.resetPassword}
                                </Button>
                                <RowMenu label={t.adminMoreActions(u.username)} disabled={self}>
                                  {(close) => (
                                    // The role is edited with the permissions (「編輯」); deleting is not an edit
                                    <MenuItem
                                      type="button"
                                      role="menuitem"
                                      $danger
                                      onClick={() => {
                                        close()
                                        editPending({ id: u.id, action: 'delete' })
                                      }}
                                    >
                                      {t.adminDeleteMember}
                                    </MenuItem>
                                  )}
                                </RowMenu>
                              </Actions>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </Table>
              </Flush>
            )}
            {memberDraft && (
              <CardFooter>
                {memberChanges.length > 0 && unsaved}
                <Button type="button" onClick={cancelMembers} disabled={busy === 'members'}>
                  {t.cancel}
                </Button>
                <Button type="button" $variant="primary" $busy={busy === 'members'} onClick={() => void saveMembers()}>
                  {busy === 'members' ? t.saving : t.save}
                </Button>
              </CardFooter>
            )}
          </Section>

          <Section id={anchor('add')} aria-labelledby={`${id}-h-add`}>
            <CardHeader>
              <CardTitle id={`${id}-h-add`}>{t.addMember}</CardTitle>
            </CardHeader>
            <form onSubmit={addMember} aria-label={t.addMember}>
              <FormGrid>
                <GridRow>
                  <FieldLabel htmlFor={`${id}-username`}>{t.username}</FieldLabel>
                  <Control>
                    <Input
                      {...fieldIds('username', true)}
                      value={member.username}
                      autoComplete="off"
                      onChange={(e) => setMember({ ...member, username: e.target.value })}
                      required
                    />
                    {below('username', t.usernameHint(LIMITS.usernameMin, LIMITS.usernameMax))}
                  </Control>
                </GridRow>
                <GridRow>
                  <FieldLabel htmlFor={`${id}-password`}>{t.password}</FieldLabel>
                  <Control>
                    <PasswordInput
                      {...fieldIds('password', true)}
                      value={member.password}
                      autoComplete="new-password"
                      minLength={LIMITS.passwordMin}
                      onChange={(e) => setMember({ ...member, password: e.target.value })}
                      required
                    />
                    {below('password', t.passwordHint(LIMITS.passwordMin))}
                  </Control>
                </GridRow>
              </FormGrid>
              <CardFooter>
                <Button type="submit" $variant="primary" $busy={busy === 'add'}>
                  {t.add}
                </Button>
              </CardFooter>
            </form>
          </Section>

          <Section id={anchor('tables')} aria-labelledby={`${id}-h-tables`}>
            <CardHeader>
              <CardTitle id={`${id}-h-tables`}>{t.tablesTitle}</CardTitle>
            </CardHeader>
            {!tables.length ? (
              <Empty>{t.noTablesAdmin}</Empty>
            ) : (
              <Flush>
                <Table aria-label={t.tablesTitle}>
                  <tbody>
                    {tables.map((table) => (
                      <tr key={table.id}>
                        <td>
                          <Name>{t.tableName(table.number)}</Name>
                        </td>
                        <td>
                          {t.host}{t.colon}{table.hostName}
                        </td>
                        <td className="num">{t.boardsPlayed(table.boardsPlayed)}</td>
                        <td className="end">
                          {pending?.id === table.id && pending.action === 'close' ? (
                            <Actions>
                              <span>{t.adminConfirmClose(t.tableName(table.number))}</span>
                              <Button
                                type="button"
                                $size="sm"
                                $variant="danger"
                                $busy={busy === `close-${table.id}`}
                                onClick={() => void run(`close-${table.id}`, () => api.admin.closeTable(table.id))}
                              >
                                {t.confirm}
                              </Button>
                              <Button type="button" $size="sm" onClick={() => editPending(null)}>
                                {t.cancel}
                              </Button>
                            </Actions>
                          ) : (
                            <Button type="button" $size="sm" onClick={() => editPending({ id: table.id, action: 'close' })}>
                              {t.closeTable}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Flush>
            )}
          </Section>

          <Section id={anchor('bookSync')} aria-labelledby={`${id}-h-bookSync`}>
            <CardHeader>
              <TitleRow>
                <CardTitle id={`${id}-h-bookSync`}>{t.bookSyncTitle}</CardTitle>
                {outOfStep.length > 0 && <GoldBadge>{outOfStep.length}</GoldBadge>}
              </TitleRow>
              <Muted>{t.bookSyncIntro}</Muted>
            </CardHeader>
            {!sync ? (
              <Skeleton $h={80} aria-busy="true" aria-label={t.loading} />
            ) : !outOfStep.length ? (
              <Empty>{t.bookSyncAllSynced(sync.length)}</Empty>
            ) : (
              <Flush>
                <Table aria-label={t.bookSyncTitle}>
                  <tbody>
                    {outOfStep.map((row) => (
                      <tr key={row.slug}>
                        <td>
                          <Name>{row.nameZh}</Name>
                          <Muted>{row.auctions.filter(Boolean).slice(0, 6).join('、')}</Muted>
                        </td>
                        <td>
                          {row.hidden ? t.bookSyncHidden : t.bookSyncChanged(row.version, row.checked.version)}
                          {row.updatedBy && (
                            <Muted>
                              {row.updatedBy}
                              {row.updatedAt !== undefined && ` · ${relative(row.updatedAt)}`}
                            </Muted>
                          )}
                        </td>
                        <td className="num">{t.bookSyncRules(row.rules)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Flush>
            )}
          </Section>

          <Section id={anchor('features')} aria-labelledby={`${id}-h-features`}>
            <CardHeader>
              <CardTitle id={`${id}-h-features`}>{t.featureFlags.title}</CardTitle>
              <Muted>{t.featureFlags.intro}</Muted>
            </CardHeader>
            <FeatureFlags />
          </Section>

          <Section id={anchor('status')} aria-labelledby={`${id}-h-status`}>
            <CardHeader>
              <CardTitle id={`${id}-h-status`}>{t.statusTitle}</CardTitle>
              <Muted>{t.statusIntro}</Muted>
            </CardHeader>
            <SystemStatus />
          </Section>
        </Stack>
      </Layout>
    </PageMain>
  )
}

/**
 * The 「⋯」 menu on a member row. It floats over the page (position: fixed) so the table's
 * horizontal scroll box doesn't clip it; it closes on Escape, a click outside, or scrolling.
 */
function RowMenu({ label, disabled, children }: { label: string; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setAt(null), [])

  const open = () => {
    const rect = button.current!.getBoundingClientRect()
    setAt({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
  }

  useLayoutEffect(() => {
    if (at) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [at])

  useEffect(() => {
    if (!at) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [at, close])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  return (
    <>
      <IconButton
        ref={button}
        type="button"
        $size="sm"
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => (at ? close() : open())}
      >
        <MoreHorizontal size={16} aria-hidden />
      </IconButton>
      {at && (
        <Menu ref={menu} role="menu" aria-label={label} style={{ top: at.top, right: at.right }} onKeyDown={onMenuKey}>
          {children(close)}
        </Menu>
      )}
    </>
  )
}

const Intro = styled(Muted)`
  margin: -${({ theme }) => theme.space(3)} 0 ${({ theme }) => theme.space(6)};
`

const Layout = styled.div`
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: ${({ theme }) => theme.space(6)};
  align-items: start;

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
    gap: ${({ theme }) => theme.space(4)};
  }
`

const Nav = styled.nav`
  position: sticky;
  top: calc(${({ theme }) => theme.layout.headerHeight} + ${({ theme }) => theme.space(4)});

  ${mobile} {
    top: calc(${({ theme }) => theme.layout.headerHeight} + ${({ theme }) => theme.space(2)});
    z-index: 5;
  }
`

const SectionSelect = styled(Select)`
  display: none;
  ${mobile} {
    display: block;
    box-shadow: ${({ theme }) => theme.shadow};
  }
`

const NavList = styled.ul`
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;

  ${mobile} {
    display: none;
  }
`

const NavLink = styled.a`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(2)};
  min-height: 36px;
  padding: 0 ${({ theme }) => theme.space(3)};
  border-left: 3px solid transparent;
  border-radius: 0 ${({ theme }) => theme.radius.sm} ${({ theme }) => theme.radius.sm} 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.text};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
  }
  &[aria-current='location'] {
    border-left-color: ${({ theme }) => theme.colors.accent};
    background: ${({ theme }) => theme.colors.surface};
    color: ${({ theme }) => theme.colors.text};
  }
`

const NavCount = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.caption.size};
  font-weight: 400;
  font-variant-numeric: tabular-nums;
`

const GoldBadge = styled.span`
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.accentStrong};
  font-size: ${({ theme }) => theme.type.caption.size};
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`

const Stack = styled.div`
  display: grid;
  /* minmax(0, …) so the tables scroll inside their cards instead of widening the page */
  grid-template-columns: minmax(0, 1fr);
  gap: ${({ theme }) => theme.space(5)};
`

/** A section card; while it is being edited its frame turns primary, so it is clear what 「儲存」 covers */
const Section = styled(Card)<{ $editing?: boolean }>`
  scroll-margin-top: calc(${({ theme }) => theme.layout.headerHeight} + ${({ theme }) => theme.space(4)});
  ${({ $editing, theme }) =>
    $editing &&
    css`
      border-color: ${theme.colors.primary};
      box-shadow: 0 0 0 1px ${theme.colors.primary}, ${theme.shadow};
    `}

  ${mobile} {
    /* Below the sticky section dropdown */
    scroll-margin-top: calc(${({ theme }) => theme.layout.headerHeight} + 64px);
  }
`

const TitleRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${({ theme }) => theme.space(2)};
`

const Empty = styled(Muted)`
  padding: ${({ theme }) => theme.space(2)} 0;
`

/** A table that runs to the card's edges and scrolls sideways inside it on a narrow screen */
const Flush = styled.div`
  overflow-x: auto;
  /* The top cancels the header's bottom margin; the rest reach the card's edges */
  margin: calc(var(--card-pad) * -1);
  border-radius: 0 0 ${({ theme }) => theme.radius.lg} ${({ theme }) => theme.radius.lg};
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;

  th,
  td {
    padding: 12px 16px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
    vertical-align: middle;
  }
  th {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.caption.size};
    line-height: ${({ theme }) => theme.type.caption.line};
    font-weight: ${({ theme }) => theme.type.caption.weight};
    white-space: nowrap;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  tbody tr[data-changed] td {
    background: ${({ theme }) => theme.colors.accentSoft};
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .note {
    min-width: 160px;
  }
  .time {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .end {
    text-align: right;
    white-space: nowrap;
  }
`

const Name = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  white-space: nowrap;
`

const Sub = styled.small`
  display: block;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.caption.size};
  line-height: ${({ theme }) => theme.type.caption.line};
  font-weight: 400;
  white-space: nowrap;
`

const Actions = styled.div`
  display: inline-flex;
  justify-content: flex-end;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  text-align: left;
`

const PasswordRow = styled.div`
  display: inline-grid;
  justify-items: end;
  gap: 6px;

  & span:has(> input) {
    width: 180px;
  }
`

const Badge = styled.span<{ $on: boolean }>`
  display: inline-block;
  padding: 0 8px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $on }) => ($on ? theme.colors.primarySoft : theme.colors.surfaceAlt)};
  color: ${({ theme, $on }) => ($on ? theme.colors.primary : theme.colors.textMuted)};
  font-size: ${({ theme }) => theme.type.caption.size};
  font-weight: 700;
  white-space: nowrap;
`

const Online = styled.span`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.success};
`

const Check = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 12px;
  font-size: 14px;
  white-space: nowrap;
`

/** DESIGN.md §7.2: label 180 | input 320 | the rest blank; the label stacks on top on a phone */
const FormGrid = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(5)};
`

const GridRow = styled.div`
  display: grid;
  grid-template-columns: 180px minmax(0, 320px);
  column-gap: ${({ theme }) => theme.space(6)};
  align-items: start;

  & > :first-child {
    /* Level with the first line of a 40px input (or a value shown read-only) */
    padding-top: 10px;
  }

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 6px;
    & > :first-child {
      padding-top: 0;
    }
  }
`

/** A setting shown read-only: as tall as an input, so 「編輯」 doesn't move the rows */
const ReadValue = styled.div`
  display: flex;
  align-items: center;
  min-height: 40px;
  color: ${({ theme }) => theme.colors.text};
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
`

/** 「有尚未儲存的變更」 at the left of an editing section's footer */
const Unsaved = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  color: ${({ theme }) => theme.colors.accentStrong};
  font-size: ${({ theme }) => theme.type.small.size};
  font-weight: 600;
`

const Dot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.accent};
`

/** 「已修改」 under a member's name while their row has unsaved changes */
const Changed = styled(Sub)`
  color: ${({ theme }) => theme.colors.accentStrong};
  font-weight: 600;
`

const RoleSelect = styled(Select)`
  width: auto;
  min-width: 96px;
`

const PermissionList = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  white-space: nowrap;
`

/**
 * The members header's tools, taking the rest of the title row (or a row of their own on a phone):
 * the search grows from the left, 「編輯」 stays at the far right, on one line
 */
const HeaderTools = styled.div`
  display: flex;
  flex: 1 1 280px;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  min-width: 0;

  & > button {
    flex: none;
    margin-left: auto;
  }
`

const Control = styled.div`
  display: grid;
  gap: 6px;
  min-width: 0;
`

const SearchBox = styled.div`
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 320px;

  ${mobile} {
    max-width: none;
  }

  & > svg {
    position: absolute;
    top: 50%;
    left: 10px;
    transform: translateY(-50%);
    color: ${({ theme }) => theme.colors.textMuted};
    pointer-events: none;
  }
  & > input {
    padding-left: 32px;
  }
`

const IconButton = styled(Button)`
  width: 32px;
  padding: 0;
`

const Menu = styled.div`
  position: fixed;
  z-index: 40;
  display: grid;
  min-width: 160px;
  padding: 6px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadowRaised};
`

const MenuItem = styled.button<{ $danger?: boolean }>`
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: ${({ theme }) => theme.colors.text};
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    outline: none;
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  ${({ $danger, theme }) =>
    $danger &&
    css`
      color: ${theme.colors.danger};
    `}
`

const Skeletons = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(5)};
`

const Skeleton = styled.div<{ $h: number }>`
  height: ${({ $h }) => $h}px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`
