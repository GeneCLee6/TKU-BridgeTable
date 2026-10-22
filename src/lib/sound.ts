/**
 * Table sounds, made on the fly with the Web Audio API so there are no sound files to load: the
 * snap of a card played to the table, and a riffle when a new board is dealt. Browsers only allow
 * sound after the page has been clicked or typed in, so the audio context is created (or resumed)
 * on the first such gesture. Where Web Audio is missing (tests, old browsers) nothing plays.
 */

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (context) return context
  try {
    const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    context = Context ? new Context() : null
  } catch {
    context = null
  }
  return context
}

/** Lets sound play once the viewer has interacted with the page */
export function unlockSound() {
  const ctx = audio()
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
}

/** A short burst of filtered noise: one card hitting the table */
function snap(ctx: AudioContext, at: number, frequency: number, volume: number, length = 0.06) {
  const samples = Math.round(ctx.sampleRate * length)
  const buffer = ctx.createBuffer(1, samples, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / samples) ** 4
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = frequency
  filter.Q.value = 0.9
  const gain = ctx.createGain()
  gain.gain.value = volume
  source.connect(filter).connect(gain).connect(ctx.destination)
  source.start(at)
}

function ready(): AudioContext | null {
  const ctx = audio()
  return ctx && ctx.state === 'running' ? ctx : null
}

/** A card played to the table */
export function playCardSound() {
  const ctx = ready()
  if (!ctx) return
  snap(ctx, ctx.currentTime, 1500, 0.9, 0.07)
  snap(ctx, ctx.currentTime + 0.005, 3200, 0.35, 0.03)
}

/** A new board: a quick riffle of cards being dealt */
export function dealSound() {
  const ctx = ready()
  if (!ctx) return
  for (let i = 0; i < 14; i++) snap(ctx, ctx.currentTime + i * 0.032, 2600 + (i % 3) * 350, 0.32, 0.035)
}
