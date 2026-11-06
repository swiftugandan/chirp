// Multi-tone FSK modem.
//
// Every symbol sounds `groups` tones at once; each group picks one of 16 tones,
// so a symbol carries 4 bits per group. Tones of different groups are
// interleaved across the band so a single frequency notch (room mode, speaker
// dip) only hurts one tone value instead of a whole group. With `alternate`,
// even and odd symbols use two interleaved tone sets, so echoes of the previous
// symbol land on tones the receiver is not looking at.
//
// Wire format, in symbols:
//   preamble (8 known symbols) | header (10 bytes) | body (RS blocks, interleaved)
// Header = [version<<4 | profile code, frame type, length hi, length lo] + 6 RS parity.
// Body   = payload + CRC-32, split into equal blocks, each RS-protected, then
//          byte-interleaved across blocks so a burst error is spread out.
//
// The receiver works on raw samples with a sample-count clock: it slides a
// window across the input looking for the preamble pattern, refines the timing,
// then reads each symbol at its known position with a small early/late timing
// tracker to follow clock drift between devices.
//
// Doppler: the preamble search also runs at fixed ±1500 ppm offsets (scored
// per bank, best wins). At lock, a Doppler factor is estimated from the
// preamble and the tone correlators are rebuilt at the shifted frequencies.
// During the frame, a frequency early/late gate keeps following it. Symbol
// positions scale by the same factor.

import { crc32 } from './crc32.ts';
import { rsDecode, rsEncode } from './reedSolomon.ts';
import type { DemodEvent, Demodulator, Frame, Modem } from './types.ts';

export interface MfskProfile {
  id: string;
  /** 4-bit identifier carried in the header. */
  code: number;
  label: string;
  description: string;
  /** Tones sounding simultaneously (4 bits each). */
  groups: number;
  /** Alternate between two tone sets on even/odd symbols to reject echoes. */
  alternate: boolean;
  baseFrequency: number;
  /** Must be a multiple of 1 / symbolSeconds so tones are orthogonal. */
  toneSpacing: number;
  /** Integration window per symbol. */
  symbolSeconds: number;
  /** Ramp-down/ramp-up time between symbols; also absorbs echoes and timing error. */
  guardSeconds: number;
  /** Reed–Solomon parity bytes per block. */
  parity: number;
  /** Maximum data bytes per Reed–Solomon block. */
  blockData: number;
  maxPayload: number;
  /** Peak output level, 0..1. */
  amplitude: number;
}

const TONES = 16;
export const PREAMBLE = [0, 11, 3, 14, 6, 9, 1, 12];
const VERSION = 1;
const HEADER_DATA = 4;
const HEADER_PARITY = 6;
export const HEADER_BYTES = HEADER_DATA + HEADER_PARITY;
const HEADER_NIBBLES = HEADER_BYTES * 2;
export const CRC_BYTES = 4;
export const LEAD_IN_SECONDS = 0.02;
export const TAIL_SECONDS = 0.02;

// Preamble detection: mean share of energy in the expected tone, and the
// weakest single preamble symbol, both as a fraction of the group's energy.
const SYNC_SCORE = 0.45;
const SYNC_MIN_SYMBOL = 0.2;
const SYNC_SETTLE_HOPS = 3;
const TIMING_GAIN = 0.1;
const RING_SIZE = 1 << 18;
// Doppler search: ±3000 ppm (about ±1 m/s of relative motion) in 100 ppm steps.
const DOPPLER_STEP = 100e-6;
const DOPPLER_STEPS = 30;
const DOPPLER_REBUILD = 20e-6;
const FREQ_GAIN = 0.05;
/** Doppler offsets the preamble search also listens at (besides nominal). */
const SEARCH_BANKS = [-1500e-6, 1500e-6];

const preambleValue = (symbol: number, group: number) => PREAMBLE[(symbol + 3 * group) % PREAMBLE.length];

interface Layout {
  blocks: number;
  perBlock: number;
  bodyBytes: number;
  symbols: number;
}

function layout(p: MfskProfile, payloadLength: number): Layout {
  const dataLength = payloadLength + CRC_BYTES;
  const blocks = Math.max(1, Math.ceil(dataLength / p.blockData));
  const perBlock = Math.ceil(dataLength / blocks);
  const bodyBytes = blocks * (perBlock + p.parity);
  const symbols = Math.ceil(((HEADER_BYTES + bodyBytes) * 2) / p.groups);
  return { blocks, perBlock, bodyBytes, symbols };
}

/** The bytes a frame puts on the wire after the preamble: header + interleaved RS body. */
export function frameBytes(p: MfskProfile, frame: Frame): Uint8Array {
  const { payload } = frame;
  if (payload.length > p.maxPayload) {
    throw new Error(`Payload of ${payload.length} bytes exceeds ${p.label} limit of ${p.maxPayload}`);
  }
  const l = layout(p, payload.length);
  const header = rsEncode(
    Uint8Array.of((VERSION << 4) | p.code, frame.type, payload.length >> 8, payload.length & 0xff),
    HEADER_PARITY,
  );

  const data = new Uint8Array(l.blocks * l.perBlock);
  data.set(payload);
  new DataView(data.buffer).setUint32(payload.length, crc32(payload));

  const n = l.perBlock + p.parity;
  const out = new Uint8Array(HEADER_BYTES + l.bodyBytes);
  out.set(header);
  for (let b = 0; b < l.blocks; b++) {
    const cw = rsEncode(data.subarray(b * l.perBlock, (b + 1) * l.perBlock), p.parity);
    for (let j = 0; j < n; j++) out[HEADER_BYTES + j * l.blocks + b] = cw[j];
  }
  return out;
}

export const toneFrequency = (p: MfskProfile, bin: number) => p.baseFrequency + bin * p.toneSpacing;
const toneSets = (p: MfskProfile) => (p.alternate ? 2 : 1);
const binCount = (p: MfskProfile) => p.groups * TONES * toneSets(p);
/**
 * `symbol` is the absolute symbol index (preamble included); it selects the tone set.
 * The demodulator's partial `measure(start, symbol)` computes exactly the bins this
 * can return for that symbol, so it must stay the only way a symbol's bins are chosen.
 */
export const binOf = (p: MfskProfile, value: number, group: number, symbol: number) =>
  (value * p.groups + group) * toneSets(p) + (symbol % toneSets(p));
const symbolPeriod = (p: MfskProfile) => p.symbolSeconds + p.guardSeconds;

/** Tone bin for every group of every symbol, preamble included: the full wire format. */
export function frameTones(p: MfskProfile, frame: Frame): number[][] {
  const bytes = frameBytes(p, frame);
  const l = layout(p, frame.payload.length);
  const nibbles: number[] = [];
  for (const b of bytes) nibbles.push(b >> 4, b & 0x0f);
  while (nibbles.length < l.symbols * p.groups) nibbles.push(0);
  const symbols: number[][] = [];
  for (let s = 0; s < PREAMBLE.length + l.symbols; s++) {
    const tones: number[] = [];
    for (let g = 0; g < p.groups; g++) {
      const value = s < PREAMBLE.length ? preambleValue(s, g) : nibbles[(s - PREAMBLE.length) * p.groups + g];
      tones.push(binOf(p, value, g, s));
    }
    symbols.push(tones);
  }
  return symbols;
}

function nibblesToBytes(nibbles: number[], start: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (nibbles[start + 2 * i] << 4) | nibbles[start + 2 * i + 1];
  return out;
}

/** RS decode, retrying with the least-confident bytes marked as erasures. */
function decodeWithErasures(cw: Uint8Array, nsym: number, confidence: number[]): Uint8Array | null {
  const direct = rsDecode(cw, nsym);
  if (direct) return direct;
  const order = confidence.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  for (const count of [Math.floor(nsym / 2), nsym - 2]) {
    if (count <= 0) continue;
    const fixed = rsDecode(cw, nsym, order.slice(0, count));
    if (fixed) return fixed;
  }
  return null;
}

export function createMfskModem(p: MfskProfile): Modem {
  const bins = binCount(p);
  const period = symbolPeriod(p);
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    band: [p.baseFrequency, toneFrequency(p, bins - 1)],
    rawBitRate: (4 * p.groups) / period,
    maxPayload: p.maxPayload,
    supports: (sampleRate) => toneFrequency(p, bins) < sampleRate * 0.46,
    airtime: (length) => LEAD_IN_SECONDS + (PREAMBLE.length + layout(p, length).symbols) * period + TAIL_SECONDS,

    modulate(frame, sampleRate) {
      const tones = frameTones(p, frame);
      const totalSymbols = tones.length;
      const out = new Float32Array(Math.ceil((LEAD_IN_SECONDS + totalSymbols * period + TAIL_SECONDS) * sampleRate));
      const ramp = p.guardSeconds / 2;
      const amp = p.amplitude / p.groups;
      const freqs = new Float64Array(p.groups);

      for (let s = 0; s < totalSymbols; s++) {
        for (let g = 0; g < p.groups; g++) freqs[g] = toneFrequency(p, tones[s][g]);
        const t0 = LEAD_IN_SECONDS + s * period;
        const n0 = Math.ceil(t0 * sampleRate);
        const n1 = Math.min(out.length, Math.floor((t0 + period) * sampleRate));
        for (let n = n0; n < n1; n++) {
          const t = n / sampleRate;
          const local = t - t0;
          let env = 1;
          if (local < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * local) / ramp);
          else if (local > period - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (period - local)) / ramp);
          let y = 0;
          // Absolute-time phase keeps each tone phase-continuous; the per-group
          // offset keeps simultaneous tones from peaking together.
          for (let g = 0; g < p.groups; g++) y += Math.sin(2 * Math.PI * freqs[g] * t + g * 1.7);
          out[n] = amp * env * y;
        }
      }
      return out;
    },

    createDemodulator: (sampleRate) => new MfskDemodulator(p, sampleRate),
  };
}

interface HopRecord {
  start: number;
  /** Per-bin energy share within its group, one array per search bank (0 = nominal). */
  shares: Float32Array[];
}

interface Lock {
  /** Absolute sample index of preamble symbol 0's integration window. */
  base: number;
  /** Accumulated timing correction in samples. */
  adjust: number;
  symbol: number;
  nibbles: number[];
  confidence: number[];
  marginSum: number;
  marginCount: number;
  header?: { type: number; length: number; layout: Layout; totalSymbols: number };
}

class MfskDemodulator implements Demodulator {
  private readonly p: MfskProfile;
  private readonly bins: number;
  private readonly window: number;
  private readonly period: number;
  private readonly hop: number;
  private readonly trackOffset: number;
  private readonly maxAdjust: number;
  private cos: Float32Array[] = [];
  private sin: Float32Array[] = [];
  private readonly sampleRate: number;
  /** Doppler / clock factor applied to every tone frequency (1 = nominal). */
  private scale = 1;
  private tableScale = 1;
  /** Extra correlators at fixed Doppler offsets, used only by the preamble search. */
  private searchBanks: { cos: Float32Array[]; sin: Float32Array[] }[] = [];
  private readonly ring = new Float32Array(RING_SIZE);
  private readonly frame: Float32Array;
  private readonly energy: Float32Array;
  private readonly hopOffsets: number[];

  private written = 0;
  private nextHop = 0;
  private hopCount = 0;
  private hops: HopRecord[] = [];
  private candidate: { score: number; start: number; age: number; bank: number } | null = null;
  private lock: Lock | null = null;

  constructor(p: MfskProfile, sampleRate: number) {
    this.p = p;
    this.bins = binCount(p);
    this.window = Math.round(p.symbolSeconds * sampleRate);
    this.period = symbolPeriod(p) * sampleRate;
    this.hop = Math.max(1, Math.floor(this.window / 4));
    this.trackOffset = Math.max(1, Math.round((p.guardSeconds * sampleRate) / 4));
    this.maxAdjust = (p.guardSeconds * sampleRate) / 2;
    this.frame = new Float32Array(this.window);
    this.energy = new Float32Array(this.bins);
    this.sampleRate = sampleRate;
    for (const k of SEARCH_BANKS) {
      this.buildTables(1 + k);
      this.searchBanks.push({ cos: this.cos, sin: this.sin });
    }
    this.buildTables(1);
    this.hopOffsets = PREAMBLE.map((_, i) => Math.round((i * this.period) / this.hop));
  }

  /** Rebuild the correlator tables for tones scaled by `scale`. */
  private buildTables(scale: number) {
    this.cos = [];
    this.sin = [];
    for (let b = 0; b < this.bins; b++) {
      const w = (2 * Math.PI * toneFrequency(this.p, b) * scale) / this.sampleRate;
      const c = new Float32Array(this.window);
      const s = new Float32Array(this.window);
      for (let n = 0; n < this.window; n++) {
        c[n] = Math.cos(w * n);
        s[n] = Math.sin(w * n);
      }
      this.cos.push(c);
      this.sin.push(s);
    }
    this.tableScale = scale;
  }

  /** Energy at an arbitrary frequency over the window starting at absolute sample `start`. */
  private toneEnergy(start: number, freq: number): number {
    const mask = RING_SIZE - 1;
    const w = (2 * Math.PI * freq) / this.sampleRate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let c = 1;
    let s = 0;
    let re = 0;
    let im = 0;
    for (let n = 0; n < this.window; n++) {
      const x = this.ring[(start + n) & mask];
      re += x * c;
      im += x * s;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
    }
    return re * re + im * im;
  }

  /** Doppler factor that best explains the preamble at `base` (grid search + parabolic peak). */
  private estimateScale(base: number): number {
    const { p } = this;
    const step = DOPPLER_STEP;
    const scores: number[] = [];
    for (let k = -DOPPLER_STEPS; k <= DOPPLER_STEPS; k++) {
      const sc = 1 + k * step;
      let hit = 0;
      for (let s = 0; s < PREAMBLE.length; s++) {
        const start = Math.round(base + (s * this.period) / sc);
        for (let g = 0; g < p.groups; g++) hit += this.toneEnergy(start, toneFrequency(p, binOf(p, preambleValue(s, g), g, s)) * sc);
      }
      scores.push(hit);
    }
    const i = scores.indexOf(Math.max(...scores));
    let frac = 0;
    if (i > 0 && i < scores.length - 1) {
      const [a, b, c] = [scores[i - 1], scores[i], scores[i + 1]];
      const d = a - 2 * b + c;
      if (d < 0) frac = (0.5 * (a - c)) / d;
    }
    return 1 + (i - DOPPLER_STEPS + frac) * step;
  }

  private setScale(scale: number) {
    this.scale = scale;
    if (Math.abs(scale - this.tableScale) > DOPPLER_REBUILD) this.buildTables(scale);
  }

  reset() {
    this.written = 0;
    this.nextHop = 0;
    this.resumeSearch(0);
  }

  process(samples: Float32Array): DemodEvent[] {
    const events: DemodEvent[] = [];
    const chunk = RING_SIZE / 4;
    for (let off = 0; off < samples.length; off += chunk) {
      const part = samples.subarray(off, Math.min(samples.length, off + chunk));
      for (let i = 0; i < part.length; i++) this.ring[(this.written + i) & (RING_SIZE - 1)] = part[i];
      this.written += part.length;
      this.run(events);
    }
    return events;
  }

  private run(events: DemodEvent[]) {
    for (;;) {
      if (this.lock) {
        if (!this.stepLocked(events)) return;
      } else if (!this.stepSearch(events)) {
        return;
      }
    }
  }

  private resumeSearch(at: number) {
    this.lock = null;
    if (this.tableScale !== 1) this.buildTables(1);
    this.scale = 1;
    this.candidate = null;
    this.hops = [];
    this.hopCount = 0;
    this.nextHop = Math.max(at, this.written - RING_SIZE / 2);
  }

  /**
   * Energy at the tones of the window starting at absolute sample `start`.
   *
   * Without `symbol`, every tone of every tone set is measured; the preamble
   * search needs that, since it doesn't yet know which symbol it is looking at.
   * With `symbol`, only the tones `binOf(p, v, g, symbol)` can name are
   * measured, which halves the cost with alternating tone sets. That is most of
   * the work at sync (refine) and during reception.
   *
   * Risk for future changes: after a call with `symbol`, the other tone set's
   * entries still hold values from an earlier window. They are stale, not zero,
   * so reading them gives plausible wrong numbers rather than an error. Callers
   * passing `symbol` must read bins only through `binOf` with that same symbol;
   * anything that needs both sets (echo estimates, diagnostics, a search across
   * symbol boundaries) must call without it. The array is also shared and
   * overwritten by the next call, so copy what must outlive it.
   * "decoder output is pinned" in test/modem.test.ts fails if this changes what
   * the decoder reports.
   */
  private measure(start: number, symbol?: number): Float32Array {
    const mask = RING_SIZE - 1;
    const f = this.frame;
    for (let n = 0; n < this.window; n++) f[n] = this.ring[(start + n) & mask];
    if (symbol === undefined) {
      for (let b = 0; b < this.bins; b++) this.energy[b] = this.windowEnergy(b);
    } else {
      const { p } = this;
      for (let g = 0; g < p.groups; g++) {
        for (let v = 0; v < TONES; v++) {
          const b = binOf(p, v, g, symbol);
          this.energy[b] = this.windowEnergy(b);
        }
      }
    }
    return this.energy;
  }

  /** Energy at one tone over the window `measure` copied into `this.frame`. */
  private windowEnergy(bin: number, c = this.cos[bin], s = this.sin[bin]): number {
    const f = this.frame;
    let re = 0;
    let im = 0;
    for (let n = 0; n < this.window; n++) {
      re += f[n] * c[n];
      im += f[n] * s[n];
    }
    return re * re + im * im;
  }

  private binEnergy(bin: number, start: number): number {
    const mask = RING_SIZE - 1;
    const c = this.cos[bin];
    const s = this.sin[bin];
    let re = 0;
    let im = 0;
    for (let n = 0; n < this.window; n++) {
      const x = this.ring[(start + n) & mask];
      re += x * c[n];
      im += x * s[n];
    }
    return re * re + im * im;
  }

  private stepSearch(events: DemodEvent[]): boolean {
    if (this.nextHop + this.window > this.written) return false;
    const { p } = this;
    this.measure(this.nextHop);
    const shares: Float32Array[] = [];
    for (let k = 0; k <= this.searchBanks.length; k++) {
      const bank = k === 0 ? null : this.searchBanks[k - 1];
      const e = new Float32Array(this.bins);
      for (let b = 0; b < this.bins; b++) e[b] = bank ? this.windowEnergy(b, bank.cos[b], bank.sin[b]) : this.energy[b];
      const share = new Float32Array(this.bins);
      for (let set = 0; set < toneSets(p); set++) {
        for (let g = 0; g < p.groups; g++) {
          let total = 1e-20;
          for (let v = 0; v < TONES; v++) total += e[binOf(p, v, g, set)];
          for (let v = 0; v < TONES; v++) share[binOf(p, v, g, set)] = e[binOf(p, v, g, set)] / total;
        }
      }
      shares.push(share);
    }
    this.hops[this.hopCount % 128] = { start: this.nextHop, shares };
    this.hopCount++;
    this.nextHop += this.hop;

    const span = this.hopOffsets[this.hopOffsets.length - 1];
    const first = this.hopCount - 1 - span;
    if (first < 0) return true;

    let score = 0;
    let weakest = 0;
    let bankIndex = 0;
    for (let k = 0; k <= this.searchBanks.length; k++) {
      let sum = 0;
      let weak = 1;
      for (let s = 0; s < PREAMBLE.length; s++) {
        const rec = this.hops[(first + this.hopOffsets[s]) % 128];
        let symbolShare = 0;
        for (let g = 0; g < p.groups; g++) symbolShare += rec.shares[k][binOf(p, preambleValue(s, g), g, s)];
        symbolShare /= p.groups;
        sum += symbolShare;
        weak = Math.min(weak, symbolShare);
      }
      if (sum / PREAMBLE.length > score) {
        score = sum / PREAMBLE.length;
        weakest = weak;
        bankIndex = k;
      }
    }
    const start = this.hops[first % 128].start;

    if (score > SYNC_SCORE && weakest > SYNC_MIN_SYMBOL && (!this.candidate || score > this.candidate.score)) {
      this.candidate = { score, start, age: 0, bank: bankIndex };
    } else if (this.candidate && ++this.candidate.age >= SYNC_SETTLE_HOPS) {
      if (this.candidate.bank > 0) this.setScale(1 + SEARCH_BANKS[this.candidate.bank - 1]);
      let base = this.refine(this.candidate.start);
      const scale = this.estimateScale(base);
      if (Math.abs(scale - this.scale) > DOPPLER_REBUILD) {
        this.setScale(scale);
        base = this.refine(this.candidate.start);
      }
      this.candidate = null;
      this.lock = { base, adjust: 0, symbol: 0, nibbles: [], confidence: [], marginSum: 0, marginCount: 0 };
      events.push({ kind: 'sync', modemId: p.id });
    }
    return true;
  }

  /** Fine timing search around a coarse preamble position. */
  private refine(coarse: number): number {
    const { p } = this;
    const step = Math.max(1, Math.round(this.hop / 8));
    const scores: [number, number][] = [];
    for (let off = -this.hop; off <= this.hop; off += step) {
      let hit = 0;
      let all = 1e-20;
      for (let s = 0; s < PREAMBLE.length; s++) {
        // Only symbol s's tone set is measured; both sums below read through binOf(…, s).
        const e = this.measure(Math.round(coarse + off + (s * this.period) / this.scale), s);
        for (let g = 0; g < p.groups; g++) {
          hit += e[binOf(p, preambleValue(s, g), g, s)];
          for (let v = 0; v < TONES; v++) all += e[binOf(p, v, g, s)];
        }
      }
      scores.push([off, hit / all]);
    }
    const best = Math.max(...scores.map((s) => s[1]));
    const plateau = scores.filter((s) => s[1] >= best - 0.01);
    return coarse + plateau.reduce((acc, s) => acc + s[0], 0) / plateau.length;
  }

  private stepLocked(events: DemodEvent[]): boolean {
    const lock = this.lock!;
    const { p } = this;
    const start = Math.round(lock.base + ((PREAMBLE.length + lock.symbol) * this.period) / this.scale + lock.adjust);
    if (start + this.window + this.trackOffset > this.written) return false;

    const symbol = PREAMBLE.length + lock.symbol;
    // Only this symbol's tone set is measured: read `e` through binOf(…, symbol) alone.
    const e = this.measure(start, symbol);
    const chosen: number[] = [];
    for (let g = 0; g < p.groups; g++) {
      let best = -1;
      let bestE = -1;
      let second = 1e-20;
      for (let v = 0; v < TONES; v++) {
        const x = e[binOf(p, v, g, symbol)];
        if (x > bestE) {
          second = Math.max(second, bestE);
          bestE = x;
          best = v;
        } else if (x > second) {
          second = x;
        }
      }
      lock.nibbles.push(best);
      lock.confidence.push(bestE / second);
      lock.marginSum += 10 * Math.log10(Math.max(bestE, 1e-20) / second);
      lock.marginCount++;
      chosen.push(binOf(p, best, g, symbol));
    }

    // Early/late gate: nudge timing toward where the decided tones are strongest.
    let early = 0;
    let late = 0;
    for (const bin of chosen) {
      early += this.binEnergy(bin, start - this.trackOffset);
      late += this.binEnergy(bin, start + this.trackOffset);
    }
    if (early + late > 0) {
      lock.adjust += TIMING_GAIN * ((late - early) / (late + early)) * this.trackOffset;
      lock.adjust = Math.max(-this.maxAdjust, Math.min(this.maxAdjust, lock.adjust));
    }
    // Frequency tracker: the same early/late idea on the frequency axis, to follow
    // Doppler from a moving phone. Probes a quarter tone spacing either side.
    {
      const df = p.toneSpacing / 4;
      let lo = 0;
      let hi = 0;
      for (const bin of chosen) {
        const f = toneFrequency(p, bin) * this.scale;
        lo += this.toneEnergy(start, f - df);
        hi += this.toneEnergy(start, f + df);
      }
      if (lo + hi > 0) {
        const mid = toneFrequency(p, chosen[0]);
        this.setScale(this.scale + (FREQ_GAIN * ((hi - lo) / (hi + lo)) * df) / mid);
      }
    }
    lock.symbol++;

    if (!lock.header) {
      if (lock.nibbles.length < HEADER_NIBBLES) return true;
      const header = this.parseHeader(lock);
      if (!header) {
        this.resumeSearch(Math.round(lock.base + this.period));
        return true;
      }
      lock.header = header;
      events.push({ kind: 'header', modemId: p.id, type: header.type, length: header.length, totalSymbols: header.totalSymbols });
    }

    const h = lock.header;
    const progress: DemodEvent = { kind: 'progress', modemId: p.id, symbols: lock.symbol, totalSymbols: h.totalSymbols };
    if (h.layout.blocks === 1) {
      const received = Math.min(h.length, Math.floor((lock.nibbles.length - HEADER_NIBBLES) / 2));
      progress.preview = nibblesToBytes(lock.nibbles, HEADER_NIBBLES, received);
    }
    events.push(progress);

    if (lock.symbol < h.totalSymbols) return true;
    events.push(this.finish(lock, h));
    this.resumeSearch(Math.round(lock.base + ((PREAMBLE.length + h.totalSymbols) * this.period) / this.scale + lock.adjust));
    return true;
  }

  private byteConfidence(lock: Lock, index: number): number {
    return Math.min(lock.confidence[2 * index], lock.confidence[2 * index + 1]);
  }

  private parseHeader(lock: Lock): Lock['header'] | null {
    const { p } = this;
    const raw = nibblesToBytes(lock.nibbles, 0, HEADER_BYTES);
    const conf = Array.from({ length: HEADER_BYTES }, (_, i) => this.byteConfidence(lock, i));
    const h = decodeWithErasures(raw, HEADER_PARITY, conf);
    if (!h) return null;
    if (h[0] >> 4 !== VERSION || (h[0] & 0x0f) !== p.code || h[1] === 0) return null;
    const length = (h[2] << 8) | h[3];
    if (length > p.maxPayload) return null;
    const l = layout(p, length);
    return { type: h[1], length, layout: l, totalSymbols: l.symbols };
  }

  private finish(lock: Lock, h: NonNullable<Lock['header']>): DemodEvent {
    const { p } = this;
    const { blocks, perBlock } = h.layout;
    const n = perBlock + p.parity;
    const raw = nibblesToBytes(lock.nibbles, HEADER_NIBBLES, h.layout.bodyBytes);
    const data = new Uint8Array(blocks * perBlock);
    let correctedBytes = 0;
    for (let b = 0; b < blocks; b++) {
      const cw = new Uint8Array(n);
      const conf: number[] = [];
      for (let j = 0; j < n; j++) {
        cw[j] = raw[j * blocks + b];
        conf.push(this.byteConfidence(lock, HEADER_BYTES + j * blocks + b));
      }
      const fixed = decodeWithErasures(cw, p.parity, conf);
      if (!fixed) return { kind: 'error', modemId: p.id, reason: 'too many errors to correct' };
      for (let j = 0; j < perBlock; j++) if (fixed[j] !== cw[j]) correctedBytes++;
      data.set(fixed, b * perBlock);
    }
    const payload = data.slice(0, h.length);
    if (new DataView(data.buffer).getUint32(h.length) !== crc32(payload)) {
      return { kind: 'error', modemId: p.id, reason: 'checksum mismatch' };
    }
    return {
      kind: 'frame',
      modemId: p.id,
      frame: { type: h.type, payload },
      stats: {
        correctedBytes,
        marginDb: lock.marginSum / Math.max(1, lock.marginCount),
        airtime: (PREAMBLE.length + h.totalSymbols) * symbolPeriod(p),
      },
    };
  }
}
