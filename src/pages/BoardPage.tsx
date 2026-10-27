import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { BoardRecord } from '../../shared/protocol.ts'
import type { Traveller } from '../../shared/traveller.ts'
import { BoardRecordView, RecordSection } from '../components/BoardRecordView.tsx'
import { TravellerTable } from '../components/Traveller.tsx'
import { Card, ErrorText, PageMain } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * One finished board's page (`BoardRecordView`), and below it a challenge board's traveller when
 * the server lets the member see it
 */

export function BoardPage() {
  const { recordId } = useParams()
  const { t, message } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState<{ boardId: string; traveller: Traveller | null } | null>(
    null,
  )
  const { user } = useAuth()

  useEffect(() => {
    if (!recordId) return
    api
      .record(recordId)
      .then(({ record }) => setRecord(record))
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [recordId, message])

  // A challenge board's traveller, when the server lets this member see it (e4-t32)
  const eventBoard = record?.id === recordId && !!record?.eventId
  const traveller = loaded && loaded.boardId === recordId ? loaded.traveller : null
  useEffect(() => {
    if (!recordId || !eventBoard) return
    let live = true
    api
      .traveller(recordId)
      .then((r) => live && setLoaded({ boardId: recordId, traveller: r.traveller }))
      .catch(() => {
        // Without a traveller the record is still worth reading
      })
    return () => {
      live = false
    }
  }, [recordId, eventBoard])

  if (error)
    return (
      <PageMain>
        <ErrorText role="alert">{error}</ErrorText>
        <p>
          <Link to="/history">{t.backToHistory}</Link>
        </p>
      </PageMain>
    )
  if (!record) return <PageMain>{t.loading}</PageMain>
  const own = traveller?.entries.find((e) => e.userId === user?.id)?.boardId
  return (
    <BoardRecordView
      key={record.id}
      record={record}
      after={
        traveller && (
          <>
            <RecordSection>{t.travellerTitle}</RecordSection>
            <Card>
              <TravellerTable
                traveller={traveller}
                current={record.id}
                compareFrom={own ?? record.id}
                viewerId={user?.id}
              />
            </Card>
          </>
        )
      }
    />
  )
}
