/**
 * The table's sounds, made on the fly with the Web Audio API: no sound files to download, no
 * licences, and every card a touch different so a long session never sounds mechanical
 * (DESIGN.md §4「音效」). Two styles: A「實體牌桌」 (paper on felt, a wooden "dum", a marimba;
 * modelled on BBO's) and B「簡潔電子」 (soft electronic clicks and chimes). Ported from the
 * proposal's demo page (docs/design/sound/demo.html).
 *
 * Browsers only allow sound after the page has been clicked or typed in, so the audio context is
 * created on the first such gesture (`unlockAudio`) and never before; until then, and where Web
 * Audio is missing (tests, old browsers), nothing plays. Everything goes through one compressor,
 * so nothing clips or booms. Which sound plays when, and how loud, is decided in `player.ts`.
 */

import type { SoundEvent, SoundStyle } from './events.ts'

let context: AudioContext | null = null
let output: AudioNode | null = null
let noiseBuffer: AudioBuffer | null = null

/** Creates (or resumes) the audio context; call it from a click or a key press */
export function unlockAudio() {
  if (!context) {
    try {
      const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      context = Context ? new Context() : null
    } catch {
      context = null
    }
  }
  if (context && context.state === 'suspended') void context.resume().catch(() => undefined)
}

function ready(): AudioContext | null {
  return context && context.state === 'running' ? context : null
}

/** Every sound goes through a gentle compressor to the speakers */
function out(ctx: AudioContext): AudioNode {
  if (output) return output
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -20
  compressor.ratio.value = 4
  compressor.connect(ctx.destination)
  output = compressor
  return output
}

/** A second of white noise, made once and reused */
function noise(ctx: AudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noiseBuffer
}

const vary = () => 0.9 + Math.random() * 0.2

/** The building blocks, bound to one context */
function blocks(ctx: AudioContext) {
  const dest = out(ctx)

  /** Band-passed noise with an attack / hold / decay envelope: paper, felt, a sweep */
  const paper = (at: number, s: { low: number; high: number; peak: number; attack: number; hold?: number; decay: number }) => {
    const { low, high, attack, hold = 0, decay } = s
    const peak = Math.max(s.peak, 0.0002)
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
    source.connect(highpass).connect(lowpass).connect(gain).connect(dest)
    const length = attack + hold + decay + 0.05
    source.start(at, Math.random() * Math.max(0, 1 - length), length)
  }

  /** A low sine that drops in pitch: the felt under a card, a knock on wood */
  const knock = (at: number, frequency: number, peak: number, decay: number) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency, at)
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.6, at + decay)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay)
    osc.connect(gain).connect(dest)
    osc.start(at)
    osc.stop(at + decay + 0.02)
  }

  /** A partial that rings and dies away; `tau` is its time constant in seconds */
  const partial = (at: number, frequency: number, peak: number, tau: number, rise = 0.005) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = frequency
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + rise)
    gain.gain.setTargetAtTime(0, at + rise, tau)
    osc.connect(gain).connect(dest)
    osc.start(at)
    osc.stop(at + rise + tau * 8)
  }

  /** A marimba bar: the fundamental, its strong overtone dying fast, a mallet tick */
  const marimba = (at: number, f: number, peak: number) => {
    partial(at, f, peak, 0.16)
    partial(at, f * 3.93, peak * 0.22, 0.03)
    partial(at, f * 9.2, peak * 0.05, 0.012)
    paper(at, { low: 1500, high: 5000, peak: peak * 0.15, attack: 0.001, decay: 0.012 })
  }

  /** A hollow wood block: short, pitched, with a little noise */
  const woodblock = (at: number, f: number, peak: number) => {
    partial(at, f, peak, 0.025)
    partial(at, f * 2.6, peak * 0.3, 0.012)
    paper(at, { low: f, high: f * 4, peak: peak * 0.25, attack: 0.001, decay: 0.015 })
  }

  /** A soft electronic bell: a few harmonic partials with a gentle decay */
  const chime = (at: number, f: number, peak: number, tau = 0.22) => {
    partial(at, f, peak, tau, 0.008)
    partial(at, f * 2, peak * 0.25, tau * 0.6, 0.008)
    partial(at, f * 3, peak * 0.08, tau * 0.4, 0.008)
  }

  /** A short electronic click */
  const click = (at: number, f: number, peak: number, length = 0.012) => {
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = f
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(gain).connect(dest)
    osc.start(at)
    osc.stop(at + length + 0.02)
  }

  /** A pitch glide: a bubble, a blip */
  const glide = (at: number, f1: number, f2: number, peak: number, length: number) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(f1, at)
    osc.frequency.exponentialRampToValueAtTime(f2, at + length)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(gain).connect(dest)
    osc.start(at)
    osc.stop(at + length + 0.02)
  }

  /**
   * Your turn, like BBO's: a soft wooden "dum". A low B (247 Hz) with a fast 40 Hz warble that
   * gives it a drum's burr, two overtones that die away first, a faint thump and a quiet tail
   */
  const dum = (at: number, k: number) => {
    const tone = ctx.createOscillator()
    tone.frequency.value = 247
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 40
    const depth = ctx.createGain()
    depth.gain.value = 27
    lfo.connect(depth).connect(tone.frequency)
    const body = ctx.createGain()
    body.gain.setValueAtTime(0, at)
    body.gain.linearRampToValueAtTime(0.3 * k, at + 0.012)
    body.gain.setTargetAtTime(0, at + 0.012, 0.1)
    const tail = ctx.createGain()
    tail.gain.setValueAtTime(0, at)
    tail.gain.linearRampToValueAtTime(0.011 * k, at + 0.05)
    tail.gain.setTargetAtTime(0, at + 0.05, 0.35)
    tone.connect(body).connect(dest)
    tone.connect(tail).connect(dest)
    for (const osc of [tone, lfo]) {
      osc.start(at)
      osc.stop(at + 1.3)
    }
    partial(at, 546, 0.09 * k, 0.07, 0.01)
    partial(at, 848, 0.035 * k, 0.09, 0.01)
    knock(at, 60, 0.16 * k, 0.14)
  }

  return { paper, knock, marimba, woodblock, chime, click, glide, dum }
}

type Voice = (at: number, k: number) => void
type Voices = Record<SoundEvent, Voice>

/** Style A「實體牌桌」: paper on felt, a wooden box of bidding cards, a marimba */
function tableVoices(b: ReturnType<typeof blocks>): Voices {
  const { paper, knock, marimba, woodblock, dum } = b
  const square = (at: number, k: number) => {
    paper(at, { low: 400, high: 3000, peak: k * 0.25, attack: 0.002, decay: 0.05 })
    paper(at + 0.09, { low: 400, high: 3000, peak: k * 0.16, attack: 0.002, decay: 0.05 })
  }
  /** A card lands at `at`: a swish swelling over the last 60 ms, a crisp snap, a little felt */
  const card = (other: boolean) => (at: number, k: number) => {
    const v = vary() * k
    const top = other ? 8000 : 10000
    paper(at - 0.06, { low: 3000, high: top - 1000, peak: 0.1 * v, attack: 0.058, decay: 0.004 })
    paper(at, { low: 3500, high: top, peak: 0.55 * v, attack: 0.001, decay: 0.014 })
    paper(at, { low: 1200, high: 4000, peak: 0.16 * v, attack: 0.001, decay: 0.022 })
    paper(at + 0.012, { low: 4000, high: 9000, peak: 0.03 * v, attack: 0.002, decay: 0.03 })
    knock(at, 190 * vary(), 0.06 * v, 0.03)
  }
  const bid = (pass: boolean) => (at: number, k: number) => {
    const v = vary() * k * (pass ? 0.6 : 1)
    paper(at, { low: 900, high: 4000, peak: 0.3 * v, attack: 0.001, decay: 0.02 })
    knock(at, 320, 0.08 * v, 0.025)
  }
  return {
    deal(at, k) {
      // A riffle shuffle: dozens of tiny flicks, squared off with two taps
      const flicks = 48
      const span = 0.62
      for (let i = 0; i < flicks; i++) {
        const p = i / flicks
        const level = Math.min(1, p * 6) * (1 - 0.35 * p)
        paper(at + p * span + (Math.random() - 0.5) * 0.006, {
          low: 1800 + Math.random() * 1500,
          high: 7000,
          peak: k * (0.02 + 0.07 * level),
          attack: 0.001,
          decay: 0.006 + Math.random() * 0.006,
        })
      }
      paper(at, { low: 1500, high: 5000, peak: k * 0.02, attack: 0.15, hold: 0.3, decay: 0.2 })
      square(at + span + 0.1, k)
    },
    card: card(false),
    otherCard: card(true),
    trick(at, k) {
      paper(at, { low: 500, high: 2800, peak: k * 0.14, attack: 0.12, decay: 0.16 })
      paper(at + 0.05, { low: 2500, high: 6000, peak: k * 0.04, attack: 0.08, decay: 0.1 })
      knock(at + 0.26, 160, k * 0.08, 0.05)
    },
    turn: dum,
    turnPlay: dum,
    bid: bid(false),
    pass: bid(true),
    attention(at, k) {
      marimba(at, 392, 0.35 * k)
      marimba(at + 0.15, 523, 0.35 * k)
    },
    made(at, k) {
      marimba(at, 392, 0.32 * k)
      marimba(at + 0.16, 587, 0.32 * k)
    },
    down: (at, k) => marimba(at, 294, 0.32 * k),
    passout: square,
    slow(at, k) {
      dum(at, k)
      dum(at + 0.32, k * 0.8)
    },
    chat: (at, k) => woodblock(at, 950, 0.3 * k),
    notify(at, k) {
      marimba(at, 659, 0.28 * k)
      marimba(at + 0.14, 659, 0.22 * k)
    },
    seat: (at, k) => woodblock(at, 700, 0.3 * k),
    full(at, k) {
      woodblock(at, 700, 0.3 * k)
      woodblock(at + 0.12, 880, 0.3 * k)
    },
    challengeResult(at, k) {
      marimba(at, 440, 0.3 * k)
      marimba(at + 0.16, 659, 0.3 * k)
    },
    matchStart(at, k) {
      marimba(at, 523, 0.3 * k)
      marimba(at + 0.13, 659, 0.3 * k)
      marimba(at + 0.26, 784, 0.3 * k)
    },
    score: (at, k) => marimba(at, 880, 0.25 * k),
    matchEnd(at, k) {
      marimba(at, 523, 0.3 * k)
      marimba(at + 0.16, 659, 0.3 * k)
      marimba(at + 0.32, 587, 0.3 * k)
      marimba(at + 0.52, 784, 0.34 * k)
    },
  }
}

/** Style B「簡潔電子」: soft clicks, blips and chimes */
function digitalVoices(b: ReturnType<typeof blocks>): Voices {
  const { click, glide, chime } = b
  const square = (at: number, k: number) => {
    click(at, 600, k * 0.12)
    click(at + 0.09, 600, k * 0.09)
  }
  const turn: Voice = (at, k) => chime(at, 880, 0.3 * k, 0.25)
  return {
    deal(at, k) {
      for (let i = 0; i < 8; i++) click(at + i * 0.055, 700 + i * 70, k * (0.08 + i * 0.01), 0.02)
    },
    card: (at, k) => click(at, 1400, vary() * k * 0.2, 0.014),
    otherCard: (at, k) => click(at, 1000, vary() * k * 0.16, 0.014),
    trick(at, k) {
      glide(at, 880, 820, k * 0.08, 0.06)
      glide(at + 0.07, 660, 620, k * 0.08, 0.07)
    },
    turn,
    turnPlay: turn,
    bid: (at, k) => click(at, 2000, k * 0.11, 0.008),
    pass: (at, k) => click(at, 1600, k * 0.07, 0.008),
    attention(at, k) {
      chime(at, 880, 0.28 * k)
      chime(at + 0.16, 1175, 0.28 * k)
    },
    made(at, k) {
      chime(at, 784, 0.25 * k)
      chime(at + 0.16, 1175, 0.25 * k)
    },
    down: (at, k) => chime(at, 587, 0.25 * k, 0.28),
    passout: square,
    slow(at, k) {
      chime(at, 880, 0.3 * k)
      chime(at + 0.3, 880, 0.24 * k)
    },
    chat: (at, k) => glide(at, 500, 900, 0.14 * k, 0.07),
    notify(at, k) {
      chime(at, 1319, 0.2 * k, 0.15)
      chime(at + 0.14, 1319, 0.16 * k, 0.15)
    },
    seat: (at, k) => glide(at, 660, 700, 0.12 * k, 0.06),
    full(at, k) {
      glide(at, 660, 700, 0.12 * k, 0.06)
      glide(at + 0.1, 880, 930, 0.12 * k, 0.06)
    },
    challengeResult(at, k) {
      chime(at, 880, 0.24 * k)
      chime(at + 0.16, 1319, 0.24 * k)
    },
    matchStart(at, k) {
      chime(at, 523, 0.24 * k)
      chime(at + 0.13, 659, 0.24 * k)
      chime(at + 0.26, 784, 0.24 * k)
    },
    score: (at, k) => chime(at, 1760, 0.12 * k, 0.12),
    matchEnd(at, k) {
      chime(at, 523, 0.24 * k)
      chime(at + 0.16, 659, 0.24 * k)
      chime(at + 0.32, 587, 0.24 * k)
      chime(at + 0.52, 784, 0.28 * k, 0.35)
    },
  }
}

let voices: { ctx: AudioContext; table: Voices; digital: Voices } | null = null

/**
 * Plays one event's sound in a style, `delay` seconds from now, scaled by `gain` (linear: the
 * event's level and the member's volume together). Nothing happens before the first gesture.
 */
export function synthesize(style: Exclude<SoundStyle, 'off'>, event: SoundEvent, delay: number, gain: number) {
  const ctx = ready()
  if (!ctx) return
  if (!voices || voices.ctx !== ctx) {
    const b = blocks(ctx)
    voices = { ctx, table: tableVoices(b), digital: digitalVoices(b) }
  }
  voices[style][event](ctx.currentTime + 0.01 + Math.max(0, delay), gain)
}
