// /js/audio/pianoInstrument.js
// Lightweight piano playable via MIDI notes using Tone.js Sampler.
// API:
//   createPiano({ assetsBaseUrl }) -> piano
// Piano object:
//   noteOn(midi, velocity=0.9, whenSec?)
//   noteOff(midi, whenSec?)
//   setParams({ velocityCurve })
//   connect(node) / disconnect() / dispose()
//
// Notes:
// - If Tone.js is available (recommended), we use Tone.Sampler with your
//   multisamples under /assets/samples/piano/.
// - If Tone is missing, we fall back to a super-simplified WebAudio "pluck"
//   (so you still hear something), but quality/piano realism will be limited.

export async function createPiano({ assetsBaseUrl = './assets/samples/piano/' } = {}) {
  const hasTone = !!window.Tone && !!Tone.Sampler;
  if (hasTone) {
    return await createTonePiano(assetsBaseUrl);
  } else {
    console.warn('[pianoInstrument] Tone.js not found. Using basic WebAudio fallback.');
    return createFallbackPiano();
  }
}

// ---------------- Tone.js implementation ----------------

async function createTonePiano(base) {
  // Map of sample files you’ll place in /assets/samples/piano/
  // Filenames should match exactly; feel free to replace with your own set.
  const urls = {
    'C2':  'C2.mp3',
    'F2':  'F2.mp3',
    'A#2': 'A#2.mp3',
    'C3':  'C3.mp3',
    'F3':  'F3.mp3',
    'A#3': 'A#3.mp3',
    'C4':  'C4.mp3',
    'F4':  'F4.mp3',
    'A#4': 'A#4.mp3',
    'C5':  'C5.mp3',
  };

  // Prepend base path
  const mapped = {};
  for (const [k, v] of Object.entries(urls)) mapped[k] = base.replace(/\/?$/, '/') + v;

  // Tone.Sampler automatically stretches between provided zones.
  const sampler = new Tone.Sampler({
    urls: mapped,
    release: 0.8,
    attack: 0.002,
    curve: 'linear',
  });

  // Gain node to allow local control (optional—Tone routes to Destination by default)
  const out = new Tone.Gain(1);
  sampler.connect(out);
  out.toDestination(); // Note: in initAudio(), Tone.Destination is routed into engine.masterGain

  // Wait for samples to load
  await Tone.loaded();

  const params = {
    velocityCurve: 0.0, // -1..+1 (negative = softer, positive = harder)
  };

  function noteOn(midi, velocity = 0.9, when = Tone.now()) {
    const note = midiToNoteName(midi);
    const v = applyVelocityCurve(velocity, params.velocityCurve);
    sampler.triggerAttack(note, when, v);
  }

  function noteOff(midi, when = Tone.now()) {
    const note = midiToNoteName(midi);
    sampler.triggerRelease(note, when);
  }

  function setParams(next = {}) {
    Object.assign(params, next);
    // You could map envelope/etc here if you add more piano params later.
  }

  function connect(/* node */) {
    // No-op: In this app, Tone.Destination is already connected into the engine chain.
    // If you want to route elsewhere, you can modify engine.js to expose a Tone.Gain bus.
  }

  function disconnect() {
    try { out.disconnect(); } catch {}
  }

  function dispose() {
    disconnect();
    try { sampler.dispose(); } catch {}
    try { out.dispose(); } catch {}
  }

  return { noteOn, noteOff, setParams, connect, disconnect, dispose };
}

// ---------------- WebAudio fallback (simple pluck) ----------------

function createFallbackPiano() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  const params = {
    velocityCurve: 0.0,
  };

  const voices = new Map(); // midi -> { osc, gain, filter, stopTimer }

  function noteOn(midi, velocity = 0.9, when = ctx.currentTime) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    filter.type = 'lowpass';
    filter.frequency.value = 1200 + (midi - 60) * 40;

    const v = applyVelocityCurve(velocity, params.velocityCurve);
    gain.gain.value = 0.00001;

    osc.type = 'triangle';
    osc.frequency.value = freq;

    osc.connect(filter).connect(gain).connect(ctx.destination);

    const now = Math.max(ctx.currentTime, when);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.00001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, v), now + 0.005); // attack
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0005, 0.3 * v), now + 0.25); // decay/sustain

    osc.start(now);

    voices.set(midi, { osc, gain, filter, stopTimer: null });
  }

  function noteOff(midi, when = ctx.currentTime) {
    const v = voices.get(midi);
    if (!v) return;
    const now = Math.max(ctx.currentTime, when);
    v.gain.gain.cancelScheduledValues(now);
    const cur = Math.max(0.00001, v.gain.gain.value);
    v.gain.gain.setValueAtTime(cur, now);
    v.gain.gain.exponentialRampToValueAtTime(0.00001, now + 0.25);

    clearTimeoutSafe(v.stopTimer);
    v.stopTimer = setTimeout(() => {
      try { v.osc.stop(); } catch {}
      try { v.osc.disconnect(); v.gain.disconnect(); v.filter.disconnect(); } catch {}
    }, 300);
    voices.delete(midi);
  }

  function setParams(next = {}) {
    Object.assign(params, next);
  }

  function connect() {}
  function disconnect() {}
  function dispose() {
    for (const [m] of voices) noteOff(m);
  }

  return { noteOn, noteOff, setParams, connect, disconnect, dispose };
}

// ---------------- utils ----------------

function midiToNoteName(midi) {
  // MIDI 60 = C4
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const n = midi % 12;
  const o = Math.floor(midi / 12) - 1;
  return names[n] + o;
}

function applyVelocityCurve(v, curve) {
  // curve in [-1, +1]. Map to exponent: e in [0.5, 2.0]
  const c = Math.max(-1, Math.min(1, +curve || 0));
  const exp = c >= 0 ? 1 + c : 1 / (1 - c); // c=-1 -> 0.5, c=0 ->1, c=+1 ->2
  const out = Math.pow(Math.max(0, Math.min(1, v)), exp);
  return Math.max(0.001, Math.min(1, out));
}

function clearTimeoutSafe(id) {
  if (id) { try { clearTimeout(id); } catch {} }
}
