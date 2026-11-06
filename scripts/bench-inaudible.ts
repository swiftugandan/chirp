import { createMfskModem, type MfskProfile } from '../src/modem/mfsk.ts';
import { PROFILES } from '../src/modem/profiles.ts';
import { FrameType } from '../src/modem/types.ts';
import { rng, room, roundTrip } from '../test/channel.ts';

const base = PROFILES.find((p) => p.id === 'inaudible')!;
const variants: [string, Partial<MfskProfile>][] = [
  ['baseline 33Hz/30+10ms', {}],
  ['guard 5ms', { guardSeconds: 0.005 }],
  ['50Hz/20+5ms', { toneSpacing: 50, symbolSeconds: 0.02, guardSeconds: 0.005 }],
  ['50Hz/20+10ms', { toneSpacing: 50, symbolSeconds: 0.02, guardSeconds: 0.01 }],
  ['100Hz/10+5ms', { toneSpacing: 100, symbolSeconds: 0.01, guardSeconds: 0.005, baseFrequency: 17500 }],
];
const trials = Number(process.argv[2] ?? 10);
const PAYLOAD = 100;
const conds = [
  { name: '5dB+echo', snrDb: 5, echo: 0.4, ppm: 150 },
  { name: '0dB+echo', snrDb: 0, echo: 0.4, ppm: 150 },
  { name: 'rolloff 0dB', snrDb: 0, echo: 0.4, ppm: 150, lp: 18500 },
  { name: 'move .15m/s', snrDb: 5, echo: 0.4, ppm: 450 },
  { name: 'move .3m/s', snrDb: 5, echo: 0.4, ppm: 900 },
  { name: 'move .5m/s', snrDb: 5, echo: 0.4, ppm: 1500 },
];
console.log(['variant'.padEnd(22), 'raw', 'good', ...conds.map((c) => c.name.padStart(12))].join(' '));
for (const [name, over] of variants) {
  const modem = createMfskModem({ ...base, ...over });
  const cells: string[] = [];
  for (const c of conds) {
    let ok = 0;
    for (let t = 0; t < trials; t++) {
      const r = rng(1000 * t + 17);
      const payload = Uint8Array.from({ length: PAYLOAD }, () => Math.floor(r() * 256));
      const { frames } = roundTrip(modem, { type: FrameType.Text, payload }, 44100, {
        rxRate: 48000, clockPpm: (r() < 0.5 ? -1 : 1) * c.ppm, snrDb: c.snrDb,
        echoes: room(t + 1, c.echo), leadSeconds: 0.1 + r() * 0.5, seed: t + 1, lowpassHz: c.lp,
      });
      if (frames.length === 1 && frames[0].frame.payload.every((b, i) => b === payload[i])) ok++;
    }
    cells.push(`${Math.round((100 * ok) / trials)}%`.padStart(12));
  }
  console.log([name.padEnd(22), modem.rawBitRate.toFixed(0).padStart(3), ((PAYLOAD * 8) / modem.airtime(PAYLOAD)).toFixed(0).padStart(4), modem.band.map(Math.round).join('-'), ...cells].join(' '));
}
