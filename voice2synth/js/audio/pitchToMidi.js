// /js/audio/pitchToMidi.js
// Segment pitch analysis → note events, plus a tiny MIDI file exporter.
//
// API:
//   await segmentToMidi({
//     audioBuffer, start, end, sampleRate,
//     method: 'yin' | 'mpm' | 'crepe',
//     quantize: 'off' | '1/8' | '1/16' | '1/32',
//     minDurMs: 100,
//     hysteresisCents: 20,
//     gateDb: -40
//   }) -> { notes: [{pitch, tOn, tOff, velocity}], f0?: Float32Array }
//
//   exportMidi({ notes, bpm=120, ppq=480 }) -> Blob
//
// Notes:
// - Uses /workers/pitchWorker.js (lazy-created singleton).
// - Time values tOn/tOff are in seconds, relative to segment start.
// - Velocity in [0..1]. We'll scale to 1..127 when exporting MIDI.

let _worker = null;
function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker('./workers/pitchWorker.js', { type: 'module' });
  return _worker;
}

export async function segmentToMidi({
  audioBuffer,
  start = 0,
  end = audioBuffer ? audioBuffer.duration : 0,
  sampleRate = audioBuffer ? audioBuffer.sampleRate : 44100,
  method = 'yin',
  quantize = '1/16',
  minDurMs = 100,
  hysteresisCents = 20,
  gateDb = -40
}) {
  if (!audioBuffer) throw new Error('segmentToMidi: audioBuffer is required');
  const sr = audioBuffer.sampleRate || sampleRate;
  const s0 = Math.max(0, Math.min(start, audioBuffer.duration));
  const s1 = Math.max(s0, Math.min(end, audioBuffer.duration));
  const frames0 = Math.floor(s0 * sr);
  const frames1 = Math.floor(s1 * sr);
  const length = Math.max(0, frames1 - frames0);
  if (length < Math.floor(0.02 * sr)) {
    return { notes: [], f0: new Float32Array(0) };
  }

  // Mixdown to mono float32 segment
  const mono = new Float32Array(length);
  const chs = audioBuffer.numberOfChannels;
  for (let ch = 0; ch < chs; ch++) {
    const data = audioBuffer.getChannelData(ch).subarray(frames0, frames1);
    for (let i = 0; i < length; i++) mono[i] += data[i] / chs;
  }

  // Send to worker
  const worker = getWorker();
  const req = {
    type: 'analyze',
    payload: {
      float32Audio: mono,
      sr,
      method,
      minDurMs,
      hysteresisCents,
      gateDb
    }
  };
  const f0 = await postWorker(worker, req); // { f0Hz, notesRaw? }

  // Convert worker output to notes if needed
  let notes = f0.notesRaw ? f0.notesRaw : trackToNotes(f0.f0Hz, sr, {
    minDurMs,
    hysteresisCents
  });

  // Quantize if requested
  if (quantize && quantize !== 'off') {
    notes = quantizeNotes(notes, quantize);
  }

  // Clamp/clean times to [0, segmentDuration]
  const dur = s1 - s0;
  for (const n of notes) {
    n.tOn = clamp(n.tOn, 0, dur);
    n.tOff = clamp(n.tOff, n.tOn + 0.001, dur);
    n.velocity = clamp(n.velocity ?? 0.9, 0.01, 1.0);
  }

  return { notes, f0: f0.f0Hz ? new Float32Array(f0.f0Hz) : undefined };
}

function postWorker(worker, message) {
  return new Promise((resolve, reject) => {
    const { payload } = message;
    // Transfer the Float32Array buffer for speed
    const transfer = [];
    if (payload && payload.float32Audio && payload.float32Audio.buffer) {
      transfer.push(payload.float32Audio.buffer);
    }
    const onMsg = (e) => {
      const { type, payload } = e.data || {};
      if (type === 'analyze:ok') {
        worker.removeEventListener('message', onMsg);
        resolve(payload);
      } else if (type === 'analyze:err') {
        worker.removeEventListener('message', onMsg);
        reject(new Error(payload?.message || 'Worker error'));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage(message, transfer);
  });
}

// ---- f0 -> notes (fallback if worker returns only f0) ----
function trackToNotes(f0Hz, sr, { minDurMs = 100, hysteresisCents = 20 } = {}) {
  const hopSec = 0.01; // assume worker used ~10ms hop; if not, we’ll estimate below
  const dt = hopSec;   // seconds per bin (safe default)
  const notes = [];
  const minDur = minDurMs / 1000;

  let cur = null;
  const toMidi = (hz) => hz > 0 ? (69 + 12 * Math.log2(hz / 440)) : null;

  const cents = (a, b) => 1200 * Math.log2(a / b);

  for (let i = 0; i < f0Hz.length; i++) {
    const t = i * dt;
    const hz = f0Hz[i];
    if (!hz || hz <= 0) {
      // gap → end current if any
      if (cur) {
        cur.tOff = t;
        if (cur.tOff - cur.tOn >= minDur) notes.push(cur);
        cur = null;
      }
      continue;
    }
    const midi = Math.round(toMidi(hz));
    if (!isFinite(midi)) continue;

    if (!cur) {
      cur = { pitch: midi, tOn: t, tOff: t, velocity: 0.9 };
    } else {
      // same note? allow small cents deviance with hysteresis
      const curHz = 440 * Math.pow(2, (cur.pitch - 69) / 12);
      const diff = Math.abs(cents(hz, curHz));
      if (Math.abs(midi - cur.pitch) <= 0 && diff <= hysteresisCents) {
        cur.tOff = t;
      } else {
        // new note
        if (cur.tOff - cur.tOn >= minDur) notes.push(cur);
        cur = { pitch: midi, tOn: t, tOff: t, velocity: 0.9 };
      }
    }
  }

  if (cur && (cur.tOff - cur.tOn >= minDur)) notes.push(cur);

  // Merge tiny gaps between same-pitch neighbors
  return mergeAdjacent(notes, 0.03);
}

function mergeAdjacent(notes, maxGapSec = 0.03) {
  if (!notes.length) return notes;
  const out = [notes[0]];
  for (let i = 1; i < notes.length; i++) {
    const prev = out[out.length - 1];
    const cur = notes[i];
    if (cur.pitch === prev.pitch && cur.tOn - prev.tOff <= maxGapSec) {
      prev.tOff = cur.tOff; // extend
      prev.velocity = Math.max(prev.velocity, cur.velocity ?? 0.9);
    } else {
      out.push(cur);
    }
  }
  return out;
}

// ---- Quantization ----
function quantizeNotes(notes, grid = '1/16', bpm = 120) {
  const secPerBeat = 60 / bpm;
  const denom = gridToDenom(grid); // e.g., 16 for 1/16
  if (!denom) return notes;

  const step = secPerBeat * (4 / denom); // quarter note = 1 beat
  const q = (t) => Math.round(t / step) * step;

  // Quantize start and end; ensure at least 1 step length
  return notes.map(n => {
    const tOnQ = q(n.tOn);
    const tOffQ = Math.max(tOnQ + step, q(n.tOff));
    return { ...n, tOn: tOnQ, tOff: tOffQ };
  });
}

function gridToDenom(grid) {
  switch (grid) {
    case '1/8': return 8;
    case '1/16': return 16;
    case '1/32': return 32;
    default: return null;
  }
}

// ---- MIDI export ----
export function exportMidi({ notes = [], bpm = 120, ppq = 480 }) {
  // One-track SMF, tempo meta, note-on/off events.
  // Times in ticks. Convert seconds -> ticks with bpm/ppq.
  const events = [];

  // Tempo meta (microseconds per quarter note)
  const usPerQuarter = Math.round(60000000 / Math.max(1, bpm));
  events.push(delta(0), meta(0x51, u24(usPerQuarter)));

  // Build sorted note-on/off events
  const pairs = [];
  for (const n of notes) {
    pairs.push({ t: n.tOn, type: 'on', pitch: n.pitch, vel: Math.max(1, Math.min(127, Math.round((n.velocity ?? 0.9) * 127))) });
    pairs.push({ t: n.tOff, type: 'off', pitch: n.pitch, vel: 64 });
  }
  pairs.sort((a, b) => a.t - b.t || (a.type === 'off' ? -1 : 1)); // offs before ons at same t

  let lastTick = 0;
  const secToTicks = (sec) => Math.round(sec * (bpm / 60) * ppq);

  for (const ev of pairs) {
    const tick = secToTicks(ev.t);
    const dt = Math.max(0, tick - lastTick);
    lastTick = tick;

    events.push(varint(dt));
    if (ev.type === 'on') {
      events.push(status(0x90, 0), byte(ev.pitch), byte(ev.vel));
    } else {
      events.push(status(0x80, 0), byte(ev.pitch), byte(0));
    }
  }

  // End of track
  events.push(varint(0), meta(0x2F, []));

  const trackData = concatBytes(...events);
  const trackChunk = chunk('MTrk', trackData);
  const header = smfHeader(1, 1, ppq);
  const blob = new Blob([header, trackChunk], { type: 'audio/midi' });
  return blob;
}

// ---- MIDI helpers ----
function smfHeader(format, ntrks, division) {
  const data = new Uint8Array(6);
  const dv = new DataView(data.buffer);
  dv.setUint16(0, format);
  dv.setUint16(2, ntrks);
  dv.setUint16(4, division);
  return chunk('MThd', data);
}

function chunk(tag, data) {
  const out = new Uint8Array(8 + data.length);
  out.set(strBytes(tag), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, data.length);
  out.set(data, 8);
  return out;
}

function strBytes(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function concatBytes(...arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function byte(n) { return new Uint8Array([n & 0xff]); }
function status(type, ch) { return new Uint8Array([ (type & 0xF0) | (ch & 0x0F) ]); }
function meta(type, data) { return concatBytes(new Uint8Array([0xFF, type & 0x7F, ...varint(data.length)]), new Uint8Array(data)); }
function delta(n) { return varint(n); }
function varint(n) {
  // variable-length quantity
  const bytes = [];
  let v = n >>> 0;
  do {
    bytes.push(v & 0x7f);
    v >>>= 7;
  } while (v > 0);
  for (let i = bytes.length - 1; i > 0; i--) bytes[i] |= 0x80;
  return new Uint8Array(bytes.reverse());
}
function u24(n) { return [ (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF ]; }

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
