import { useSearchParams } from 'react-router-dom'
import { HISTORY_PAGE_SIZES } from '../../shared/protocol.ts'
import { readPageSize, writePageSize } from './lists.ts'

/**
 * The sort, page and page size of a list the browser holds whole (challenges, featured boards, team
 * matches), kept in the address as the history page keeps its own: `?sort=oldest&page=2&size=50`.
 * What is the default is left out; a page size picked here is remembered for every list.
 */
export function useListParams<T extends string>(sorts: readonly T[], fallback: T) {
  const [params, setParams] = useSearchParams()
  const sort = sorts.find((s) => s === params.get('sort')) ?? fallback
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1)
  const asked = Number(params.get('size'))
  const size = (HISTORY_PAGE_SIZES as readonly number[]).includes(asked) ? asked : readPageSize()

  const write = (patch: { sort?: T; page?: number; size?: number }) => {
    setParams(
      (now) => {
        const next = new URLSearchParams(now)
        const put = (
          key: string,
          value: string | number | undefined,
          standard: string | number,
        ) => {
          if (value === undefined) return
          if (value === standard) next.delete(key)
          else next.set(key, String(value))
        }
        put('sort', patch.sort, fallback)
        put('page', patch.page ?? 1, 1)
        put('size', patch.size, readPageSize())
        return next
      },
      { replace: true },
    )
  }

  return {
    sort,
    page,
    size,
    setSort: (next: T) => write({ sort: next }),
    setPage: (next: number) => write({ page: next }),
    setSize: (next: number) => {
      writePageSize(next)
      write({ size: next })
    },
    /** Back to the first page, for a change the list's own controls do not make (a tab) */
    firstPage: () => write({}),
  }
}
