# Chirp: Sound-based Data Transfer

> Fork of [solst-ice/chirp](https://github.com/solst-ice/chirp), live at **https://swiftugandan.github.io/chirp/**. It adds Doppler tracking to the receiver so transfers keep working while a phone is moving. See [Doppler tracking](#doppler-tracking).

This application transmits and receives text and small files through sound: one device plays a short burst of tones through its speaker and another decodes it from its microphone. No network, pairing or account is involved.

## Features

- Send text (any UTF-8, including lowercase and emoji) and small files through sound
- Three modes: **FAST** (~320 bit/s), **ROBUST** (~85 bit/s, for noisy or echoey rooms) and **INAUDIBLE** (~65 bit/s, near-ultrasonic 18–19 kHz)
- The receiver listens for all three modes at once
- Doppler tracking: the receiver estimates and follows the frequency shift from a moving phone (up to about ±1 m/s), which matters most for INAUDIBLE
- Error correction (Reed–Solomon) plus a CRC-32 checksum: text appears as it arrives, and a message only counts as received once it passes its checksum. Frames that are too damaged are reported as corrupted, but a transmission the receiver never detects (too quiet, too far, drowned out) leaves no trace
- Transmission is one-way broadcast: there are no acknowledgments, so the sender cannot tell whether anyone received it. The log marks messages "sent", and its startup line reads "ready · one-way send · auto-receive"
- Cancel any transmission (ESC), resend files to fill gaps, and a loopback TEST that checks whether a device can hear its own signal in the selected mode
- Terminal-style interface: a live 0–20 kHz spectrum with peak hold and a scrolling waterfall, a transfer log with progress bars, per-mode link statistics, and keyboard shortcuts

## How It Works

The modem lives in [`src/modem/`](src/modem/):

1. **Framing**: each message becomes a frame: an 8-symbol preamble, a 10-byte header (mode, type, length, protected by its own Reed–Solomon parity), then the payload + CRC-32 split into Reed–Solomon blocks that are byte-interleaved to spread out burst errors.
2. **Modulation (multi-tone FSK)**: every symbol sounds one tone per group; each group picks one of 16 tones, carrying 4 bits. Even and odd symbols use two interleaved tone sets so room echoes of the previous symbol land on tones the receiver ignores. Short raised-cosine ramps between symbols avoid clicks.
3. **Reception**: an `AudioWorklet` streams raw microphone samples to the demodulators, which use the sample count as their clock rather than timers or screen refreshes. Whether a browser keeps capturing audio in a background tab varies (see Notes). They slide a window looking for the preamble, refine the timing, then read each symbol at its known position while an early/late tracker follows clock drift between devices and a frequency tracker follows Doppler shift (see [Doppler tracking](#doppler-tracking)). Low-confidence bytes are retried as erasures during error correction.
4. **Files**: a manifest frame (name, size, checksum) followed by numbered chunk frames, compressed with deflate when that helps. The manifest is repeated at the end, and **RESEND** reuses the 32-bit file id so a receiver can fill in chunks it missed. Receivers validate manifests against hard limits (256 KB, consistent chunk counts and exact chunk lengths) before allocating anything, cap decompression at the declared size, and keep at most eight incomplete transfers. Chunks that arrive before their manifest are held within the same budgets (no more than the largest valid file per transfer, 1 MB across all of them), and transfers that go quiet for ten minutes are dropped.
5. **Transmitting**: one transmission at a time, cancellable, and it waits for any frame currently being received to finish before talking (listen before talk). Transfers longer than 15 minutes of airtime are refused.

The wire format is pinned by known-answer tests (`test/wireFormat.test.ts`); it is not compatible with the earlier character-per-tone version of Chirp, so both devices need this version.

| Mode | Tones | Band | Raw rate | 100-byte message |
|---|---|---|---|---|
| FAST | 4 at a time | 1.5–7.9 kHz | 533 bit/s | ~2.5 s |
| ROBUST | 2 at a time | 1.5–4.7 kHz | 133 bit/s | ~9 s |
| INAUDIBLE | 1 at a time | 18–19 kHz | 100 bit/s | ~12.5 s |

INAUDIBLE is near-ultrasonic, not ultrasonic, and device-dependent: a 44.1/48 kHz sample rate does not guarantee that a phone or laptop speaker and microphone actually reproduce 18–19 kHz. Run the loopback TEST on each device first. It uses a single tone at a time because two simultaneous high tones can produce an audible difference tone through a small speaker, it will not work over Bluetooth speakers or headsets, and some young people (and most pets) can still hear it.

### Doppler tracking

When the phones move relative to each other, every tone shifts in frequency by about f·v/343. At 19 kHz, a hand moving at 0.3 m/s shifts tones by about 16 Hz. That is half of INAUDIBLE's 33 Hz tone spacing, so tones start landing on their neighbours. The receiver handles this in three steps (all in [`src/modem/mfsk.ts`](src/modem/mfsk.ts)):

1. **Search**: besides the nominal tones, the preamble search also listens at ±1500 ppm (about ±0.5 m/s). It scores each bank separately and keeps the best. Taking the per-tone maximum across banks instead would raise the noise floor and cost detections when the phones are still.
2. **Lock**: once the preamble is found, the receiver grid-searches a Doppler factor over ±3000 ppm in 100 ppm steps, then refines it to the peak. It rebuilds its tone correlators at the shifted frequencies and repeats the fine timing search.
3. **Track**: after each symbol, it compares energy a quarter tone spacing above and below the tones it decided on, and nudges the Doppler estimate toward the stronger side. This is the same idea as the early/late timing gate, applied to frequency. Symbol positions scale by the same factor, so a long frame does not drift outside the guard interval.

The extra search banks roughly triple the preamble-search work. Once locked, the extra cost is small.

Simulated results for INAUDIBLE: 100-byte message, 5 dB SNR with room echo, 10 trials per cell (`node scripts/bench-inaudible.ts`). Treat these as rough figures.

| Relative motion | Before | After |
|---|---|---|
| Still (0 dB + echo) | 90% | 100% |
| 0.15 m/s | 90% | 100% |
| 0.3 m/s | 20% | 90% |
| 0.5 m/s | 0% | 100% |

The standard benchmark (`npm run bench`) is unchanged for all three modes, and the "no modem syncs on 20 s of noise" test still passes.

With motion handled, a wider INAUDIBLE tone spacing becomes a reasonable next step. For example, 50 Hz spacing with 20 ms symbols and a 10 ms guard simulates at about 86 bit/s goodput instead of 64, at a similar delivery rate, using 18.0–19.6 kHz. `scripts/bench-inaudible.ts` compares several such variants. None of them is the default yet, because a profile change alters the wire format and needs testing on real devices first.

### Security

The checksum proves the data was not damaged in transit, not who sent it: anyone within earshot can transmit, and anyone within earshot can listen. Nothing is encrypted. Received text is displayed as plain text and received files are offered only as downloads (`application/octet-stream`), never opened in the page.

## Getting Started

### Prerequisites

- Node.js 22.18 or newer (the build works on older versions, but the tests run the TypeScript sources directly)
- npm or yarn


### Installation

#### Clone this repository  

First—assuming you have the GitHub CLI—use this command while in your end directory:

   ```bash
   gh repo clone swiftugandan/chirp
   ```

Otherwise use this command while in your end directory:

   ```bash
   git clone https://github.com/swiftugandan/chirp.git
   ```

#### Install dependencies

   ```bash
   npm install
   ```

   **or**

   ```bash
   yarn
   ```

### Running the Application

```bash
npm run dev
```
**or**
```bash
yarn dev
```

Then open your browser to the URL shown in the terminal (usually http://localhost:5173).

## Usage

1. Open the page on two devices and allow microphone access. Browsers keep audio paused until you interact with the page, so press [ START AUDIO ] in the status bar if it shows AUDIO PAUSED
2. Pick a mode under TRANSMIT (or press alt+1/2/3); the receiver does not need to match, it listens for all modes
3. Type a message and press Enter or [ SEND ], or use [ FILE ] / alt+f to send a file (up to 256 KB and 15 minutes of airtime; transfers over a minute ask for confirmation). ESC cancels
4. Received messages and files appear in the LOG; click a file name to download it. A file that stops arriving is marked incomplete; [ RESEND ] / alt+r on the sender fills in the missing chunks
5. [ TEST ] / alt+t plays a test frame and checks that the same device decodes it, which tells you whether its speaker and microphone work in that mode
6. The status bar shows whether the microphone is live, with RETRY MIC / LISTEN / STOP as needed (RETRY MIC in a log message works too); without a microphone Chirp can still send
7. The diagnostics under the spectrum show per-mode sync/frame/error counts and the signal margin of the last frame
8. [ ? EXPLAIN THIS ] opens a separate page on how data travels through sound, with playable demos; it replaces the app in the tab, so nothing can be received there until you go back

### Development

```bash
npm test        # modem, transmitter, file-transfer and wire-format tests; acoustic tests run through a simulated
                # room (noise, echo, clock drift, dropouts, speaker band limits, speech and music interference)
npm run bench   # delivery rate and goodput per mode under increasingly hard conditions
node scripts/bench-inaudible.ts [trials]
                # INAUDIBLE profile variants under speaker roll-off and relative motion (Doppler)
npm run lint
```

The deploy workflow runs lint and tests before building, then publishes `dist/` to the `gh-pages` branch. GitHub Pages serves that branch at `/chirp/`, which is the `base` set in `vite.config.js`. In-app links use `import.meta.env.BASE_URL`, so changing the base is a one-line edit. GitHub turns Actions off on new forks, so a fork must enable Actions before it deploys automatically. The simulator is not a substitute for real devices: it does not model actual speaker/microphone frequency responses, distortion, or OS audio processing.

## Notes

- Moving a phone during a transfer is tolerated up to about walking-hand speed, but holding both devices still is still best
- Best results are achieved with the devices close together; move to ROBUST if FAST fails in an echoey room or with people talking nearby
- Turn off Bluetooth audio output; keep the volume high but not distorting
- Keep the page in the foreground: mobile browsers may suspend audio in background tabs or when the screen locks
- Browser security may require you to explicitly grant permission to use the microphone

## Technologies Used

- React
- TypeScript
- Vite
- Web Audio API
