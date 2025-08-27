// /worklets/granular-processor.js
// AudioWorkletProcessor: polyphonic granular playback of a provided buffer.
//
// Message API (via node.port.postMessage from the main thread):
//  - { type: 'loadBuffer', payload: { sampleRate, channels: [Float32Array,...] } }
//      * channels: 1 or 2 Float32Array(s) for the segment to synthesize
//  - { type: 'noteOn', payload: { id, rate, gain } }   // id: any unique number
//  - { type: 'noteOff', payload: { id } }
//  - { type: 'setParams', payload: { grainSize, overlap, jitter, formantTilt, brightness } }
//
// Audio params (per render quantum):
//  - grainSize (sec)   : default 0.04
//  - overlap (0..0.95) : default 0.5
//  - jitter (sec)      : default 0.002
//
// Notes:
//  - This processor is intentionally simple for reliability. It picks random
//    grain start positions and stitches with Hann windows.
//  - If no buffer is loaded, silence is produced.
//  - Stereo supported if 2 channels provided; otherwise mono is copied to both.
//  - "formantTilt" and "brightness" are light EQ shapers (1st-order filters).
//
// Integration:
//  - In your main thread, create an AudioWorkletNode('granular-processor').
//  - Send 'loadBuffer' once per selected region (pass raw channel data).
//  - For each key press: 'noteOn' with playback rate (2^(semitones/12)) and gain.
//  - For release: 'noteOff'.
//
// This file must be added via: audioContext.audioWorklet.addModule('/worklets/granular-processor.js')

class RingRNG {
  constructor(seed = 22222) { this.s = seed >>> 0; }
  next() { // xorshift32
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x >>> 0;
    return (this.s & 0x7fffffff) / 0x80000000;
  }
  norm() { return this.next() * 2 - 1; }
}

const TWO_PI = Math.PI * 2;

function hann(n, i) {
  // i in [0..n-1]
  return 0.5 * (1 - Math.cos(TWO_PI * i / (n - 1)));
}

class Voice {
  constructor(id, rate = 1, gain = 0.9) {
    this.id = id;
    this.rate = rate;
    this.gain = gain;
    this.on = true;

    this.time = 0;             // running time (sec) to schedule grains
    this.nextGrainAt = 0;      // when to schedule next grain (sec)
    this.grains = [];          // active grains
  }
}

class Grain {
  constructor(startFrameL, startFrameR, lengthFrames, rate, gain) {
    this.posL = startFrameL;   // float frame position (left)
    this.posR = startFrameR;   // float frame position (right or same as L)
    this.length = lengthFrames;
    this.i = 0;                // current frame inside grain window
    this.rate = rate;          // playback rate
    this.gain = gain;          // amplitude
  }
}

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'grainSize', defaultValue: 0.04, minValue: 0.01, maxValue: 0.25, automationRate: 'k-rate' },
      { name: 'overlap',   defaultValue: 0.5,  minValue: 0,    maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'jitter',    defaultValue: 0.002,minValue: 0,    maxValue: 0.02, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // Buffer data
    this.sampleRateSrc = 44100;
    this.buffers = [new Float32Array(0), new Float32Array(0)]; // L, R (R may alias L)
    this.length = 0;  // frames

    // State
    this.voices = new Map();
    this.maxVoices = 32;
    this.rng = new RingRNG(123456);

    // Simple EQ shapers
    this.formantTilt = 0.0; // -1..+1
    this.brightness = 0.0;  // -1..+1
    this.eqStateL = { lp: 0, hp: 0 };
    this.eqStateR = { lp: 0, hp: 0 };

    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;
    const { type, payload } = msg;

    switch (type) {
      case 'loadBuffer': {
        const { sampleRate, channels } = payload || {};
        if (!channels || !channels.length) {
          this.buffers = [new Float32Array(0), new Float32Array(0)];
          this.length = 0;
          break;
        }
        const L = channels[0] || new Float32Array(0);
        const R = channels[1] || L;
        this.buffers = [L, R];
        this.length = Math.min(L.length, R.length) | 0;
        this.sampleRateSrc = sampleRate || 44100;
        break;
      }
      case 'noteOn': {
        if (this.voices.size >= this.maxVoices) break;
        const { id, rate = 1, gain = 0.9 } = payload || {};
        if (id == null) break;
        const v = new Voice(id, rate, gain);
        this.voices.set(id, v);
        break;
      }
      case 'noteOff': {
        const { id } = payload || {};
        const v = this.voices.get(id);
        if (v) v.on = false; // let grains decay naturally
        break;
      }
      case 'setParams': {
        const p = payload || {};
        if (typeof p.formantTilt === 'number') this.formantTilt = clamp(p.formantTilt, -1, 1);
        if (typeof p.brightness  === 'number') this.brightness  = clamp(p.brightness,  -1, 1);
        break;
      }
      default: break;
    }
  }

  scheduleGrainForVoice(v, grainSizeSec, overlap, jitterSec) {
    if (this.length <= 0) return;
    const sr = this.sampleRateSrc;
    const grainFrames = Math.max(16, Math.floor(grainSizeSec * sr));
    const startFrame = Math.floor(this.rng.next() * (this.length - grainFrames - 1));
    const jitterFrames = Math.floor(jitterSec * sr * this.rng.norm()); // +/- jitter
    const sL = clampInt(startFrame + jitterFrames, 0, this.length - grainFrames - 1);
    const sR = sL;

    const g = new Grain(sL, sR, grainFrames, v.rate, v.gain);
    v.grains.push(g);

    // Decide when next grain should be scheduled:
    // interval ~= grainSize * (1 - overlap)
    const intervalSec = Math.max(0.001, grainSizeSec * (1 - overlap));
    v.nextGrainAt += intervalSec;
  }

  // Very light EQ: first-order tilt + brightness via HP/LP blend
  applyEQ(sample, state, sampleRate) {
    // One-pole low-pass and high-pass
    const cutoff = 1200 * Math.pow(2, this.formantTilt / 2); // shift with tilt
    const alphaLP = onePoleAlpha(cutoff, sampleRate);
    state.lp = state.lp + alphaLP * (sample - state.lp);

    const alphaHP = onePoleAlpha(200, sampleRate);
    state.hp = state.hp + alphaHP * (sample - state.hp);
    const hp = sample - state.hp;

    // Mix brightness: tilt high vs low
    const b = this.brightness; // -1..+1
    const lo = state.lp * (0.5 - 0.5 * b);
    const hi = hp       * (0.5 + 0.5 * b);
    return lo + hi;
  }

  process(_inputs, outputs, parameters) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];

    // Clear output
    outL.fill(0);
    outR.fill(0);

    const grainSizeSec = readParam(parameters.grainSize);
    const overlap = clamp(readParam(parameters.overlap), 0, 0.95);
    const jitterSec = clamp(readParam(parameters.jitter), 0, 0.02);

    // Early out if no buffer
    if (this.length <= 0 || this.buffers[0].length === 0) {
      return true;
    }

    const srcL = this.buffers[0];
    const srcR = this.buffers[1];

    // Render AUDIO_RENDER_QUANTUM_FRAMES samples
    const quantum = outL.length;
    const srProc = sampleRate; // destination rate (worklet context)

    // For scheduling grains against processor time, we use "v.time" in seconds.
    const dt = quantum / srProc;

    // 1) Schedule grains for each active voice
    for (const v of this.voices.values()) {
      if (v.nextGrainAt <= v.time + 1e-6) {
        // Initialize nextGrainAt if first time
        if (v.time === 0) v.nextGrainAt = 0;
        // Schedule one (or multiple if we've fallen behind)
        while (v.nextGrainAt <= v.time + 1e-6) {
          this.scheduleGrainForVoice(v, grainSizeSec, overlap, jitterSec);
        }
      }
    }

    // 2) Synthesize quantum
    for (let i = 0; i < quantum; i++) {
      let mixL = 0, mixR = 0;

      for (const v of this.voices.values()) {
        // advance existing grains
        for (let gi = v.grains.length - 1; gi >= 0; gi--) {
          const g = v.grains[gi];

          // Hann window
          const w = hann(g.length, g.i);
          // Read with linear interpolation at position
          const sL = readInterp(srcL, g.posL);
          const sR = readInterp(srcR, g.posR);
          mixL += sL * w * g.gain;
          mixR += sR * w * g.gain;

          // Advance positions & frame index
          g.posL += g.rate;
          g.posR += g.rate;
          g.i++;

          if (g.i >= g.length) {
            // Grain finished
            v.grains.splice(gi, 1);
          } else {
            // Wrap positions if exceeded buffer
            if (g.posL >= this.length) g.posL -= this.length;
            if (g.posR >= this.length) g.posR -= this.length;
          }
        }

        // If voice is released and no grains left, remove voice
        if (!v.on && v.grains.length === 0) {
          this.voices.delete(v.id);
        }
      }

      // Simple EQ per channel
      mixL = this.applyEQ(mixL, this.eqStateL, srProc);
      mixR = this.applyEQ(mixR, this.eqStateR, srProc);

      outL[i] = mixL;
      outR[i] = mixR;
    }

    // Advance voice scheduling time
    for (const v of this.voices.values()) {
      v.time += dt;
    }

    return true;
  }
}

function readInterp(buf, pos) {
  const i = Math.floor(pos);
  const frac = pos - i;
  const i1 = i + 1 >= buf.length ? 0 : i + 1;
  return buf[i] * (1 - frac) + buf[i1] * frac;
}

function readParam(param) {
  // k-rate params are either single value array or per-sample array; we pick [0]
  return (param.length ? param[0] : param) ?? 0;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function clampInt(v, a, b) { return Math.max(a, Math.min(b, v | 0)) | 0; }

function onePoleAlpha(cutHz, sr) {
  const x = Math.exp(-2 * Math.PI * Math.max(1, cutHz) / Math.max(1, sr));
  return 1 - x;
}

registerProcessor('granular-processor', GranularProcessor);
