import { composeLobby, emptyReplica, receiveLobby } from '../../shared/lobby.ts'
import type { LobbyMine, LobbyView, ServerMessage } from '../../shared/protocol.ts'

/**
 * The lobby as a browser that got these messages holds it (H3b): the shared part from the whole
 * lobby and its deltas (`receiveLobby`), put together with the member's own part (`composeLobby`)
 */
export function lobbyFrom(messages: readonly ServerMessage[]): LobbyView | undefined {
  let replica = emptyReplica()
  let mine: LobbyMine | undefined
  for (const message of messages) {
    if (message.type === 'lobbyShared' || message.type === 'lobbyDelta') replica = receiveLobby(replica, message).replica
    else if (message.type === 'lobbyMine') mine = message.mine
  }
  return replica.copy && mine ? composeLobby(replica.copy.lobby, mine) : undefined
}
