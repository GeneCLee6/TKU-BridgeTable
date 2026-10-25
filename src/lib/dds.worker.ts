import { Dds, loadDds } from 'bridge-dds'
import type { DdPositionRequest, DdRequest } from './doubleDummy.ts'
import { solveDeal, solvePosition } from './ddsSolve.ts'

/**
 * A Web Worker that runs DDS (WASM) off the page's thread: a whole DD table can take a second or
 * more. The module (about 500 KB, the WASM inlined) is only fetched when a record page first asks.
 * It answers two questions: a board's DD table and par (`request`), and the cards of one point of
 * the play in double-dummy mode (`position`).
 */

let solver: Promise<Dds> | null = null

type Message = { id: number; request: DdRequest } | { id: number; position: DdPositionRequest }

addEventListener('message', (event: MessageEvent<Message>) => {
  const message = event.data
  solver ??= loadDds().then((module) => new Dds(module))
  solver
    .then((dds) =>
      postMessage({ id: message.id, result: 'position' in message ? solvePosition(dds, message.position) : solveDeal(dds, message.request) }),
    )
    .catch((error: unknown) => {
      // A WASM abort leaves the module unusable: load a fresh one for the next board
      solver = null
      postMessage({ id: message.id, error: String(error) })
    })
})
