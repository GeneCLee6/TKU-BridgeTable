import type { Post } from '../../shared/forum.ts'

/** Drafts and scheduled posts in the post editor (E13 e13-t12; `components/ForumRelease.tsx`) */

/** The editor's choice: scheduled or not, and the time as the browser's `datetime-local` value (local time) */
export interface ReleaseChoice {
  schedule: boolean
  at: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `ms` as a `datetime-local` value in the browser's time zone, to the minute */
export function localInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A `datetime-local` value as ms; none when it is empty or not a time */
export function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/** What the editor starts with: a scheduled post's time, else the next whole hour after an hour from now */
export function initialRelease(post: Post | undefined, now = Date.now()): ReleaseChoice {
  if (post?.publishAt !== undefined) return { schedule: true, at: localInput(post.publishAt) }
  const next = new Date(now + 3_600_000)
  next.setMinutes(0, 0, 0)
  return { schedule: false, at: localInput(next.getTime() + 3_600_000) }
}

/** Whether a post is not out yet: a draft or scheduled */
export const notOut = (post: Pick<Post, 'draft' | 'publishAt'>) =>
  !!post.draft || post.publishAt !== undefined
