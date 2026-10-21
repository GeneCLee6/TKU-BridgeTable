import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { LIMITS, type ChatMessage } from '../../shared/protocol.ts'
import { strings } from '../strings.ts'

const Panel = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
`

const Log = styled.ol`
  flex: 1;
  min-height: 120px;
  margin: 0;
  padding: 8px 12px;
  overflow-y: auto;
  list-style: none;
  font-size: 14px;
  line-height: 1.5;
`

const Line = styled.li`
  overflow-wrap: anywhere;
  & + & { margin-top: 4px; }
`

const Author = styled.span`
  font-weight: 700;
  color: ${({ theme }) => theme.colors.primary};
`

const Time = styled.span`
  margin-right: 6px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
`

const Form = styled.form`
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
`

const Input = styled.input`
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bg};
`

const Send = styled.button`
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primary};
  color: ${({ theme }) => theme.colors.onPrimary};
  font-weight: 600;
`

const time = (at: number) =>
  new Date(at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })

export function ChatPanel({ messages, onSend }: { messages: ChatMessage[]; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const log = useRef<HTMLOListElement>(null)

  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight })
  }, [messages.length])

  return (
    <Panel>
      <Log ref={log} aria-label={strings.chat} aria-live="polite">
        {messages.map((m) => (
          <Line key={m.id}>
            <Time>{time(m.at)}</Time>
            <Author>{m.username}</Author>：{m.text}
          </Line>
        ))}
      </Log>
      <Form
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          onSend(text)
          setText('')
        }}
      >
        <Input
          value={text}
          maxLength={LIMITS.chatMax}
          onChange={(e) => setText(e.target.value)}
          placeholder={strings.chatPlaceholder}
          aria-label={strings.chatPlaceholder}
        />
        <Send type="submit">{strings.send}</Send>
      </Form>
    </Panel>
  )
}
