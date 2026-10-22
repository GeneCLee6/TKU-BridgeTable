/**
 * Table sounds, made on the fly with the Web Audio API so there are no sound files to load: a
 * soft, low "thock" when a card lands on the felt, and a gentle riffle and swish when a new board
 * is dealt. Everything goes through a low-pass filter, so nothing is sharp. Browsers only allow
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

function ready(): AudioContext | null {
  const ctx = audio()
  return ctx && ctx.state === 'running' ? ctx : null
}

let noiseBuffer: AudioBuffer | null = null

/** Half a second of white noise, made once and reused */
function noise(ctx: AudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer
  noiseBuffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noiseBuffer
}

/** A volume envelope: quick rise to `peak`, then a smooth fall over `decay` seconds */
function envelope(ctx: AudioContext, at: number, peak: number, attack: number, decay: number) {
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.linearRampToValueAtTime(peak, at + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay)
  return gain
}

/** Filtered noise: the paper part of a card sound */
function brush(ctx: AudioContext, at: number, options: { cutoff: number; peak: number; attack: number; decay: number; band?: boolean }) {
  const source = ctx.createBufferSource()
  source.buffer = noise(ctx)
  const filter = ctx.createBiquadFilter()
  filter.type = options.band ? 'bandpass' : 'lowpass'
  filter.frequency.value = options.cutoff
  filter.Q.value = 0.7
  const gain = envelope(ctx, at, options.peak, options.attack, options.decay)
  source.connect(filter).connect(gain).connect(ctx.destination)
  source.start(at, Math.random() * 0.3, options.attack + options.decay + 0.05)
}

/** A short, low tone falling in pitch: the body of a card meeting the felt */
function thump(ctx: AudioContext, at: number, from: number, to: number, peak: number, decay: number) {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(from, at)
  osc.frequency.exponentialRampToValueAtTime(to, at + decay)
  const gain = envelope(ctx, at, peak, 0.004, decay)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + decay + 0.05)
}

/** A card played to the table */
export function playCardSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime
  brush(ctx, at, { cutoff: 1300, peak: 0.32, attack: 0.004, decay: 0.12 })
  thump(ctx, at, 190, 110, 0.22, 0.09)
}

/** A new board: a soft riffle of cards and a swish as the hands slide out */
export function dealSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime
  for (let i = 0; i < 7; i++) brush(ctx, at + i * 0.045, { cutoff: 1700, peak: 0.12, attack: 0.003, decay: 0.05 })
  brush(ctx, at + 0.28, { cutoff: 700, peak: 0.16, attack: 0.12, decay: 0.32, band: true })
}
