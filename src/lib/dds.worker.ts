import { Dds, loadDds } from 'bridge-dds'
import type { DdRequest } from './doubleDummy.ts'
import { solveDeal } from './ddsSolve.ts'

/**
 * A Web Worker that runs DDS (WASM) off the page's thread: a whole DD table can take a second or
 * more. The module (about 500 KB, the WASM inlined) is only fetched when a record page first asks.
 */

let solver: Promise<Dds> | null = null

addEventListener('message', (event: MessageEvent<{ id: number; request: DdRequest }>) => {
  const { id, request } = event.data
  solver ??= loadDds().then((module) => new Dds(module))
  solver
    .then((dds) => postMessage({ id, result: solveDeal(dds, request) }))
    .catch((error: unknown) => {
      // A WASM abort leaves the module unusable: load a fresh one for the next board
      solver = null
      postMessage({ id, error: String(error) })
    })
})
