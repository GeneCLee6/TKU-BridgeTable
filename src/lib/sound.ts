/**
 * Table sounds, made on the fly with the Web Audio API so there are no sound files to load. They
 * are built from filtered noise, like paper: a card is a faint slide followed by a crisp tap as it
 * lands, the deal is a riffle shuffle (dozens of tiny flicks) squared off with two taps, and your
 * turn is a soft two-note chime. Everything goes through one compressor, so nothing clips or
 * booms. Browsers only allow sound after the page has been clicked or typed in, so the audio
 * context is created (or resumed) on the first such gesture. Where Web Audio is missing (tests,
 * old browsers) nothing plays.
 */

let context: AudioContext | null = null
let output: AudioNode | null = null

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

/** Every sound goes through a gentle compressor to the speakers */
function out(ctx: AudioContext): AudioNode {
  if (output) return output
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -20
  compressor.ratio.value = 4
  const gain = ctx.createGain()
  gain.gain.value = 0.9
  compressor.connect(gain).connect(ctx.destination)
  output = compressor
  return output
}

let noiseBuffer: AudioBuffer | null = null

/** A second of white noise, made once and reused */
function noise(ctx: AudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noiseBuffer
}

/** Noise between two frequencies, faded in over `attack`, held, then faded out over `decay` (seconds) */
function paper(
  ctx: AudioContext,
  at: number,
  shape: { low: number; high: number; peak: number; attack: number; hold?: number; decay: number },
) {
  const { low, high, peak, attack, hold = 0, decay } = shape
  const source = ctx.createBufferSource()
  source.buffer = noise(ctx)
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = low
  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = high
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + attack)
  gain.gain.setValueAtTime(peak, at + attack + hold)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + decay)
  source.connect(highpass).connect(lowpass).connect(gain).connect(out(ctx))
  const length = attack + hold + decay + 0.05
  source.start(at, Math.random() * (1 - length), length)
}

/** How long after the sound starts a played card lands (the table's glide takes about this long) */
const LANDS_AFTER = 0.5

/** A card played to the table: a faint slide while it travels, then a crisp, light tap as it lands */
export function playCardSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime
  paper(ctx, at, { low: 2500, high: 7500, peak: 0.025, attack: 0.18, hold: 0.12, decay: 0.2 })
  paper(ctx, at + LANDS_AFTER, { low: 900, high: 6000, peak: 0.5, attack: 0.002, decay: 0.045 })
  paper(ctx, at + LANDS_AFTER, { low: 300, high: 1200, peak: 0.1, attack: 0.002, decay: 0.03 })
}

/** A new board: a riffle shuffle, the cards flicking together, then squared off with two taps */
export function dealSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime
  const flicks = 48
  const span = 0.62
  for (let i = 0; i < flicks; i++) {
    const progress = i / flicks
    // Louder as the riffle gets going, a little softer as it runs out
    const level = Math.min(1, progress * 6) * (1 - 0.35 * progress)
    const when = at + progress * span + (Math.random() - 0.5) * 0.006
    paper(ctx, when, { low: 1800 + Math.random() * 1500, high: 7000, peak: 0.02 + 0.07 * level, attack: 0.001, decay: 0.006 + Math.random() * 0.006 })
  }
  paper(ctx, at, { low: 1500, high: 5000, peak: 0.02, attack: 0.15, hold: 0.3, decay: 0.2 })
  paper(ctx, at + span + 0.1, { low: 400, high: 3000, peak: 0.25, attack: 0.002, decay: 0.05 })
  paper(ctx, at + span + 0.19, { low: 400, high: 3000, peak: 0.16, attack: 0.002, decay: 0.05 })
}

/** A soft bell note */
function bell(ctx: AudioContext, at: number, frequency: number, peak: number, decay: number) {
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
  gain.connect(out(ctx))
  for (const [multiple, level] of [
    [1, 1],
    [2, 0.18],
    [3, 0.06],
  ]) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = frequency * multiple
    const partial = ctx.createGain()
    partial.gain.value = level
    osc.connect(partial).connect(gain)
    osc.start(at)
    osc.stop(at + decay + 0.05)
  }
}

/** Your turn: a gentle rising "ding-dong", so you hear it from another tab */
export function turnSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime
  bell(ctx, at, 784, 0.16, 0.7)
  bell(ctx, at + 0.17, 1175, 0.13, 0.9)
}
