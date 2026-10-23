/**
 * Table sounds, made on the fly with the Web Audio API so there are no sound files to load, and
 * modelled on BBO's. Cards are filtered noise, like paper: a played card is a quick swish that
 * swells as it comes down and a crisp snap as it lands on the felt, the deal is a riffle shuffle
 * (dozens of tiny flicks) squared off with two taps. Your turn is a soft wooden "dum", somewhere
 * between a drum and a marimba, as on BBO. Everything goes through one compressor, so nothing
 * clips or booms. Browsers only allow sound after the page has been clicked or typed in, so the
 * audio context is created (or resumed) on the first such gesture. Where Web Audio is missing
 * (tests, old browsers) nothing plays.
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

/** How long after the card leaves the hand it lands: the table's 1.3 s glide is all but done by then */
const LANDS_AFTER = 0.95

/** A short, soft knock: a low sine that drops in pitch as it dies away */
function knock(ctx: AudioContext, at: number, frequency: number, peak: number, decay: number) {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(frequency, at)
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.6, at + decay)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.003)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
  osc.connect(gain).connect(out(ctx))
  osc.start(at)
  osc.stop(at + decay + 0.02)
}

/**
 * A card played to the table, as on BBO: high, airy noise swelling over the last 60 ms as the card
 * comes down, then a crisp snap (mostly 4–8 kHz, gone in about 15 ms) with a little low body from
 * the felt. Each card varies a touch, so a trick does not sound mechanical.
 */
export function playCardSound() {
  const ctx = ready()
  if (!ctx) return
  const land = ctx.currentTime + LANDS_AFTER
  const vary = 0.9 + Math.random() * 0.2
  paper(ctx, land - 0.06, { low: 3000, high: 9000, peak: 0.1 * vary, attack: 0.058, decay: 0.004 })
  paper(ctx, land, { low: 3500, high: 10000, peak: 0.55 * vary, attack: 0.001, decay: 0.014 })
  paper(ctx, land, { low: 1200, high: 4000, peak: 0.16 * vary, attack: 0.001, decay: 0.022 })
  paper(ctx, land + 0.012, { low: 4000, high: 9000, peak: 0.03, attack: 0.002, decay: 0.03 })
  knock(ctx, land, 190 * vary, 0.06, 0.03)
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

/** A sine overtone that rings briefly: `decay` is its time constant (seconds) */
function overtone(ctx: AudioContext, at: number, frequency: number, peak: number, decay: number) {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = frequency
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(peak, at + 0.01)
  gain.gain.setTargetAtTime(0, at + 0.01, decay)
  osc.connect(gain).connect(out(ctx))
  osc.start(at)
  osc.stop(at + decay * 10)
}

/**
 * Your turn, like BBO's: a soft wooden "dum", between a tom and a marimba. A low B (247 Hz) with a
 * fast 40 Hz warble in pitch that gives it a drum's burr, two overtones off the harmonic series
 * (546 and 848 Hz) that die away first, a faint thump underneath and a short, quiet tail. It rises
 * in about 12 ms and falls by 20 dB in a quarter of a second.
 */
export function turnSound() {
  const ctx = ready()
  if (!ctx) return
  const at = ctx.currentTime + 0.01
  const end = at + 1.3

  const tone = ctx.createOscillator()
  tone.type = 'sine'
  tone.frequency.value = 247
  // The warble: ±27 Hz forty times a second, which puts sidebands 9 dB down at 207 and 287 Hz
  const lfo = ctx.createOscillator()
  lfo.frequency.value = 40
  const depth = ctx.createGain()
  depth.gain.value = 27
  lfo.connect(depth).connect(tone.frequency)

  const body = ctx.createGain()
  body.gain.setValueAtTime(0, at)
  body.gain.linearRampToValueAtTime(0.3, at + 0.012)
  body.gain.setTargetAtTime(0, at + 0.012, 0.1)
  const tail = ctx.createGain()
  tail.gain.setValueAtTime(0, at)
  tail.gain.linearRampToValueAtTime(0.011, at + 0.05)
  tail.gain.setTargetAtTime(0, at + 0.05, 0.35)
  tone.connect(body).connect(out(ctx))
  tone.connect(tail).connect(out(ctx))
  for (const osc of [tone, lfo]) {
    osc.start(at)
    osc.stop(end)
  }

  overtone(ctx, at, 546, 0.09, 0.07)
  overtone(ctx, at, 848, 0.035, 0.09)
  knock(ctx, at, 60, 0.16, 0.14)
}
