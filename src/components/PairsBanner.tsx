import { UsersRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { TablePairs } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'

/**
 * A pairs event's table (§5.22, `e9-t11`): the title names the round and the table, with a link to
 * the event (a new tab: leaving this page would leave the table). `lib/usePairsFollow.ts` takes the
 * player on when the round changes
 */

const Wrap = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;

  & small {
    font-weight: 400;
    opacity: 0.9;
  }
  & a {
    color: inherit;
  }
`

export function PairsBanner({ pairs }: { pairs: TablePairs }) {
  const t = useT()
  return (
    <Wrap>
      <UsersRound size={15} aria-hidden />
      <Link to={`/pairs/${encodeURIComponent(pairs.id)}`} target="_blank" rel="noopener">
        {(pairs.individual ? t.pairs.individualBanner : t.pairs.banner)(pairs.round, pairs.rounds, pairs.table)}
      </Link>
      <small>{`${pairs.played}／${pairs.boards}`}</small>
      {pairs.over && pairs.round < pairs.rounds && <small role="status">{t.pairs.bannerOver}</small>}
    </Wrap>
  )
}
