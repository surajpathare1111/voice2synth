// /js/audio/samplerInstrument.js
// Build a playable instrument from a selected audio region.
//
// Prefers a polyphonic granular engine via AudioWorklet ("granular-processor"),
// and falls back to a per-note looping BufferSource sampler if worklets aren’t available.
//
// API:
//   createGranularInstrument({ audioBuffer, start, end, baseNote = 60 }) -> instrument
// instrument:
//   noteOn(midi, velocity=0.9, whenSec?)
//   noteOff(midi, whenSec?)
//   setParams({ attack, decay, sustain, release, transpose, formantShift, brightness, reverbMix, grainSize, overlap, jitter })
//   connect(node) / disconnect() / dispose()

export async function createGranularInstrument({ audioBuffer, start, end, baseNote = 60 }) {
  if (!audioBuffer) throw new Error('createGranularInstrument: audioBuffer is required');

  const context = getAudioContext();
  const sr = audioBuffer.sampleRate;

  // 1) Slice the selected region into an AudioBuffer `seg`
  const startFrame = Math.max(0, Math.floor(start * sr));
  const endFrame = Math.min(audioBuffer.length, Math.floor(end * sr));
  const length = Math.max(1, endFrame - startFrame);
  const chs = audioBuffer.numberOfChannels;

  const seg = new AudioBuffer({ length, sampleRate: sr, numberOfChannels: chs });
  for (let ch = 0; ch < chs; ch++) {
    const src = audioBuffer.getChannelData(ch).subarray(startFrame, endFrame);
    seg.copyToChannel(src, ch, 0);
  }
  applyEdgeFades(seg, Math.min(0.01, seg.duration * 0.05));

  // Shared output chain (both engines)
  const outputGain = context.createGain();
  outputGain.gain.value = 1.0;

  // A simple EQ/tilt for the fallback sampler; with worklet we use its built-in shapers
  const eq = makeEqChain(context);
  const reverbSend = context.createGain();
  reverbSend.gain.value = 0.0;

  // Wire: engineOut -> eq -> output + reverbSend
  const engineIn = context.createGain(); // where voices/engine will connect
  engineIn.connect(eq.input);
  eq.output.connect(outputGain);
  eq.output.connect(reverbSend);

  // Live params (kept in JS)
  const params = {
    attack: 0.008,
    decay: 0.12,
    sustain: 0.7,
    release: 0.18,
    transpose: 0,     // semitones
    formantShift: 0,  // -3..+3 semitones (approx)
    brightness: 0,    // -1..+1
    reverbMix: 0.12,
    grainSize: 0.04,  // sec
    overlap: 0.5,     // 0..0.95
    jitter: 0.002,    // sec
  };

  // Try to initialize granular worklet engine
  const engine = await tryCreateWorkletEngine(context, seg, params).catch(() => null);

  if (engine) {
    // ---------- Worklet-based granular instrument ----------
    // engine: { node, noteOn(id, rate, gain), noteOff(id), setParams({ tilt, brightness }), setWorkletParams({grainSize, overlap, jitter}) }

    const idGen = makeIdGen();
    const active = new Map(); // midi -> id

    function midiToPlaybackRate(midi) {
      const totalSemis = (midi - baseNote) + (params.transpose || 0);
      return Math.pow(2, totalSemis / 12);
    }

    function noteOn(midi, velocity = 0.9, when = context.currentTime) {
      if (active.has(midi)) noteOff(midi, when);
      const id = idGen();
      active.set(midi, id);
      // Worklet starts grains continuously; we just send the voice spec
      engine.noteOn(id, midiToPlaybackRate(midi), clamp(velocity, 0.001, 1));
      // Update EQ (post) lightly for extra color (optional)
      updateEq(eq, params);
      reverbSend.gain.setTargetAtTime(clamp(params.reverbMix, 0, 1), context.currentTime, 0.02);
    }

    function noteOff(midi, when = context.currentTime) {
      const id = active.get(midi);
      if (id == null) return;
      active.delete(midi);
      engine.noteOff(id);
    }

    function setParams(next = {}) {
      Object.assign(params, next);
      // Send shaper params to worklet:
      // Map formantShift (±3 st) to a gentle "tilt" in [-1, +1]
      const formantTilt = clamp(params.formantShift / 3, -1, 1);
      engine.setParams({ formantTilt, brightness: clamp(params.brightness, -1, 1) });
      engine.setWorkletParams({
        grainSize: clamp(params.grainSize, 0.01, 0.25),
        overlap: clamp(params.overlap, 0, 0.95),
        jitter: clamp(params.jitter, 0, 0.02)
      });
      // Post-EQ (very subtle, keeps parity with fallback):
      updateEq(eq, params);
      reverbSend.gain.setTargetAtTime(clamp(params.reverbMix, 0, 1), context.currentTime, 0.05);
    }

    function connect(node) { outputGain.connect(node); }
    function disconnect() { try { outputGain.disconnect(); } catch {} try { reverbSend.disconnect(); } catch {} }
    function dispose() {
      for (const m of [...active.keys()]) noteOff(m);
      disconnect();
      try { engine.node.disconnect(); } catch {}
    }

    // initial param push
    setParams(params);
    // wire node output into chain
    engine.node.connect(engineIn);

    return { noteOn, noteOff, setParams, connect, disconnect, dispose };
  }

  // ---------- Fallback: per-note looping BufferSource sampler ----------
  const voices = new Map(); // midi -> { src, gain, releaseTimer }

  function midiToPlaybackRate(midi) {
    const totalSemis = (midi - baseNote) + (params.transpose || 0);
    return Math.pow(2, totalSemis / 12);
  }

  function noteOn(midi, velocity = 0.9, when = context.currentTime) {
    if (voices.has(midi)) noteOff(midi, when);

    const src = context.createBufferSource();
    src.buffer = seg;
    src.loop = true;
    src.playbackRate.value = midiToPlaybackRate(midi);

    const vGain = context.createGain();
    vGain.gain.value = 0.00001;

    src.connect(vGain).connect(engineIn);

    // ADSR
    const now = Math.max(context.currentTime, when);
    const peak = clamp(velocity, 0.001, 1.2);
    vGain.gain.cancelScheduledValues(now);
    vGain.gain.setValueAtTime(0.00001, now);
    vGain.gain.linearRampToValueAtTime(peak, now + params.attack);
    vGain.gain.linearRampToValueAtTime(peak * clamp(params.sustain, 0, 1), now + params.attack + params.decay);

    src.start(now);

    voices.set(midi, { src, gain: vGain, releaseTimer: null });
    updateEq(eq, params);
    reverbSend.gain.setTargetAtTime(clamp(params.reverbMix, 0, 1), now, 0.02);
  }

  function noteOff(midi, when = context.currentTime) {
    const v = voices.get(midi);
    if (!v) return;
    const now = Math.max(context.currentTime, when);

    v.gain.gain.cancelScheduledValues(now);
    const cur = Math.max(0.00001, v.gain.gain.value);
    v.gain.gain.setValueAtTime(cur, now);
    v.gain.gain.exponentialRampToValueAtTime(0.00001, now + Math.max(0.01, params.release));

    clearTimerSafe(v.releaseTimer);
    v.releaseTimer = setTimeout(() => {
      try { v.src.stop(); } catch {}
      try { v.src.disconnect(); v.gain.disconnect(); } catch {}
    }, Math.ceil((Math.max(0.01, params.release) + 0.05) * 1000));

    voices.delete(midi);
  }

  function setParams(next = {}) {
    Object.assign(params, next);
    updateEq(eq, params);
    reverbSend.gain.setTargetAtTime(clamp(params.reverbMix, 0, 1), context.currentTime, 0.05);
    // Update active voices’ playbackRate to reflect transpose:
    for (const [midi, v] of voices) {
      const rate = midiToPlaybackRate(midi);
      try { v.src.playbackRate.setTargetAtTime(rate, context.currentTime, 0.01); }
      catch { v.src.playbackRate.value = rate; }
    }
  }

  function connect(node) { outputGain.connect(node); }
  function disconnect() { try { outputGain.disconnect(); } catch {} try { reverbSend.disconnect(); } catch {} }
  function dispose() {
    for (const [m] of voices) noteOff(m);
    disconnect();
  }

  // initial param push
  setParams(params);

  return { noteOn, noteOff, setParams, connect, disconnect, dispose };
}

// -------------------- Worklet engine wrapper --------------------

async function tryCreateWorkletEngine(context, seg, params) {
  if (!context.audioWorklet || !window.isSecureContext) {
    // Worklets require secure context (https or localhost)
    return null;
  }
  // Try to add the module (no-op if already added in this page)
  try {
    // If added already, this will throw only in some browsers—ignore
    await context.audioWorklet.addModule('./worklets/granular-processor.js');
  } catch (e) {
    // If it’s already registered, continue; otherwise, bail out to fallback
    const ok = ('' + e.message).toLowerCase().includes('already');
    if (!ok) return null;
  }

  const node = new AudioWorkletNode(context, 'granular-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: {
      grainSize: clamp(params.grainSize, 0.01, 0.25),
      overlap: clamp(params.overlap, 0, 0.95),
      jitter: clamp(params.jitter, 0, 0.02),
    }
  });

  // Prepare channel data for transfer
  const channels = [];
  for (let ch = 0; ch < seg.numberOfChannels; ch++) {
    // Copy to a new Float32Array so we can transfer the underlying buffer
    channels.push(new Float32Array(seg.getChannelData(ch)));
  }
  // Ensure stereo array shape [L,R]
  if (channels.length === 1) channels.push(channels[0]);
  node.port.postMessage(
    { type: 'loadBuffer', payload: { sampleRate: seg.sampleRate, channels } },
    channels.map(a => a.buffer)
  );

  // Control helpers
  function noteOn(id, rate, gain) {
    node.port.postMessage({ type: 'noteOn', payload: { id, rate, gain } });
  }
  function noteOff(id) {
    node.port.postMessage({ type: 'noteOff', payload: { id } });
  }
  function setParams({ formantTilt, brightness }) {
    node.port.postMessage({ type: 'setParams', payload: { formantTilt, brightness } });
  }
  function setWorkletParams({ grainSize, overlap, jitter }) {
    // k-rate AudioParams
    node.parameters.get('grainSize').setTargetAtTime(clamp(grainSize, 0.01, 0.25), context.currentTime, 0.03);
    node.parameters.get('overlap').setTargetAtTime(clamp(overlap, 0, 0.95), context.currentTime, 0.03);
    node.parameters.get('jitter').setTargetAtTime(clamp(jitter, 0, 0.02), context.currentTime, 0.03);
  }

  return { node, noteOn, noteOff, setParams, setWorkletParams };
}

// -------------------- Shared helpers --------------------

function getAudioContext() {
  if (window.Tone && Tone.getContext) return Tone.getContext().rawContext;
  const AC = window.AudioContext || window.webkitAudioContext;
  return new AC();
}

function applyEdgeFades(buffer, fadeSec = 0.01) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const fadeN = Math.min(n >> 1, Math.max(1, Math.floor(fadeSec * sr)));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < fadeN; i++) {
      const g = i / fadeN;
      data[i] *= g;
    }
    for (let i = 0; i < fadeN; i++) {
      const g = 1 - (i / fadeN);
      data[n - 1 - i] *= g;
    }
  }
}

function makeEqChain(context) {
  const input = context.createGain();
  const out = context.createGain();

  const formant = context.createBiquadFilter();
  formant.type = 'peaking';
  formant.frequency.value = 1200;
  formant.Q.value = 0.9;
  formant.gain.value = 0;

  const lowShelf = context.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = 250;

  const highShelf = context.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = 2500;

  input.connect(formant).connect(lowShelf).connect(highShelf).connect(out);

  return { input, output: out, nodes: { formant, lowShelf, highShelf } };
}

function updateEq(eq, params) {
  const { formant, lowShelf, highShelf } = eq.nodes;

  // Formant-ish: slide center frequency by semitones
  const baseHz = 1200;
  const shiftSt = clamp(params.formantShift || 0, -3, 3);
  const targetHz = baseHz * Math.pow(2, shiftSt / 12);
  formant.frequency.setTargetAtTime(targetHz, formant.context.currentTime, 0.02);
  formant.gain.setTargetAtTime(shiftSt * 1.8, formant.context.currentTime, 0.02);

  // Brightness tilt
  const b = clamp(params.brightness || 0, -1, 1);
  const hi = b * 6;
  const lo = -b * 4;
  lowShelf.gain.setTargetAtTime(lo, lowShelf.context.currentTime, 0.02);
  highShelf.gain.setTargetAtTime(hi, highShelf.context.currentTime, 0.02);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function makeIdGen(start = 1) {
  let i = start | 0;
  return () => (i = (i + 1) >>> 0);
}

function clearTimerSafe(id) { if (id) try { clearTimeout(id); } catch {} }
