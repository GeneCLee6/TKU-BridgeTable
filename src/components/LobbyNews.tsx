import { Megaphone, MessageSquare, Pin } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { NEWS_BOARD_ID, type ForumLatest, type Post } from '../../shared/forum.ts'
import { formatDateTime } from '../lib/format.ts'
import { forumApi } from '../lib/forum.ts'
import { useMemberName } from '../lib/forumHooks.ts'
import { useFeature } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { Muted } from './ui.tsx'

/**
 * 社團公告 on the home page (the lobby; E13 e13-t12, AC-13.4): the news board's latest posts, pinned
 * first, beside the newest posts of the other boards. The same `GET /api/forum/latest` as
 * BridgeHall's home page, so both sites show the same news; drafts, scheduled posts and the posts an
 * officer hid stay out (the server's `visibleTo`). Only for members with the `forum` flag; nothing
 * when the forum cannot be read.
 */

const Wrap = styled.section`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: ${({ theme }) => theme.space(4)};
  margin-bottom: ${({ theme }) => theme.space(8)};

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Column = styled.div`
  display: grid;
  align-content: start;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  min-width: 0;
`

const Head = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;

  & > h2 {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h3.size};
    line-height: ${({ theme }) => theme.type.h3.line};
  }
  & > a {
    color: ${({ theme }) => theme.colors.primary};
    font-size: 14px;
    font-weight: 600;
  }
`

const List = styled.ul`
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;

  & a {
    display: grid;
    gap: 2px;
    padding: 6px 8px;
    border-radius: ${({ theme }) => theme.radius.sm};
    color: ${({ theme }) => theme.colors.text};
    text-decoration: none;
  }
  & a:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  & strong {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  & small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 12px;
  }
`

function Rows({ posts, empty }: { posts: Post[]; empty: string }) {
  const { t, lang } = usePreferences()
  const name = useMemberName()
  if (!posts.length) return <Muted>{empty}</Muted>
  return (
    <List>
      {posts.map((post) => (
        <li key={post.id}>
          <Link to={`/forum/p/${encodeURIComponent(post.id)}`}>
            <strong>
              {post.pinned && <Pin size={12} aria-label={t.forum.pinned} />}
              {post.title || t.forum.untitled}
            </strong>
            <small>
              {t.forum.byLine(name(post.authorId), formatDateTime(post.createdAt, lang))}
            </small>
          </Link>
        </li>
      ))}
    </List>
  )
}

export function LobbyNews() {
  const { t } = usePreferences()
  const forumOn = useFeature('forum')
  const [latest, setLatest] = useState<ForumLatest | null>(null)

  useEffect(() => {
    if (!forumOn) return
    let live = true
    forumApi
      .latest()
      .then((found) => live && setLatest(found))
      .catch(() => live && setLatest(null))
    return () => {
      live = false
    }
  }, [forumOn])

  if (!forumOn || !latest) return null
  const n = t.forumNews
  return (
    <Wrap aria-label={n.announcements}>
      <Column>
        <Head>
          <h2>
            <Megaphone size={18} aria-hidden />
            {n.announcements}
          </h2>
          <Link to={`/forum/${NEWS_BOARD_ID}`}>{n.more}</Link>
        </Head>
        <Rows posts={latest.news} empty={n.noAnnouncements} />
      </Column>
      <Column>
        <Head>
          <h2>
            <MessageSquare size={18} aria-hidden />
            {n.discussions}
          </h2>
          <Link to="/forum">{n.more}</Link>
        </Head>
        <Rows posts={latest.discussions} empty={t.forum.noPosts} />
      </Column>
    </Wrap>
  )
}
