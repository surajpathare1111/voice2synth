// /js/ui/keyboard.js
// On-screen keyboard with optional QWERTY and WebMIDI input.
// API: initKeyboard(containerEl, { octaves=2, qwerty=true, midiIn=true, onNoteOn, onNoteOff })
// Methods: setOctave(offset), setQwerty(enabled), setMidiIn(enabled), highlight(midi, on)

export function initKeyboard(containerEl, opts = {}) {
  const onNoteOn = opts.onNoteOn || (() => {});
  const onNoteOff = opts.onNoteOff || (() => {});
  let octaves = Math.max(1, opts.octaves || 2);
  let baseOctaveOffset = 0; // -2..+2 from UI
  let qwertyEnabled = !!opts.qwerty;
  let midiInEnabled = !!opts.midiIn;

  const state = {
    down: new Set(), // active MIDI notes
    keyEls: new Map(), // midi -> element
    qwertyMap: buildQwertyMap(), // key -> semitone offset
    midiAccess: null,
    midiInputs: [],
  };

  // Build keys for N octaves starting at C3 (MIDI 48) + baseOctaveOffset
  function baseMidi() {
    // C3 = 48, plus 12 * offset
    return 48 + 12 * baseOctaveOffset;
  }

  // Note layout for one octave starting at C
  const octaveLayout = [
    { n: 0,  type: 'white', label: 'C'  },
    { n: 1,  type: 'black', label: 'C#' },
    { n: 2,  type: 'white', label: 'D'  },
    { n: 3,  type: 'black', label: 'D#' },
    { n: 4,  type: 'white', label: 'E'  },
    { n: 5,  type: 'white', label: 'F'  },
    { n: 6,  type: 'black', label: 'F#' },
    { n: 7,  type: 'white', label: 'G'  },
    { n: 8,  type: 'black', label: 'G#' },
    { n: 9,  type: 'white', label: 'A'  },
    { n: 10, type: 'black', label: 'A#' },
    { n: 11, type: 'white', label: 'B'  },
  ];

  // Build DOM
  containerEl.innerHTML = '';
  containerEl.classList.add('keyboard');
  renderKeys();

  // Pointer interactions
  containerEl.addEventListener('pointerdown', onPointerDown);
  containerEl.addEventListener('pointerup', onPointerUp);
  containerEl.addEventListener('pointerleave', onPointerLeave);
  containerEl.addEventListener('pointercancel', onPointerLeave);
  containerEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // QWERTY
  if (qwertyEnabled) enableQwerty();
  // WebMIDI
  if (midiInEnabled) enableMidi();

  // ---- Rendering ----
  function renderKeys() {
    state.keyEls.clear();
    const frag = document.createDocumentFragment();

    for (let o = 0; o < octaves; o++) {
      for (const k of octaveLayout) {
        const midi = baseMidi() + o * 12 + k.n;
        const el = document.createElement('div');
        el.className = `key ${k.type}`;
        el.dataset.midi = String(midi);
        el.title = `${k.label}${octaveNumberFromMidi(midi)} (${midi})`;
        el.textContent = k.type === 'white' ? k.label : '';
        frag.appendChild(el);
        state.keyEls.set(midi, el);
      }
    }
    containerEl.appendChild(frag);
    layoutBlackKeys();
  }

  // Position black keys visually above whites
  function layoutBlackKeys() {
    // CSS handles stacking; we ensure DOM order is white then black overlay via margins in CSS.
    // No extra JS needed here beyond class names.
  }

  // ---- Pointer handlers ----
  function onPointerDown(e) {
    const el = e.target.closest('.key');
    if (!el) return;
    const midi = parseInt(el.dataset.midi, 10);
    el.setPointerCapture?.(e.pointerId);
    noteOn(midi, 0.9);
  }
  function onPointerUp(e) {
    const el = e.target.closest('.key');
    if (!el) return;
    const midi = parseInt(el.dataset.midi, 10);
    noteOff(midi);
  }
  function onPointerLeave(e) {
    // stop any hanging notes when pointer leaves
    for (const m of [...state.down]) noteOff(m);
  }

  // ---- QWERTY ----
  function buildQwertyMap() {
    // Typical two-row piano mapping starting at C:
    // Row 1: Z S X D C V G B H N J M ,  (whites with sharps on adjacent letters)
    // Row 2 (upper): Q 2 W 3 E R 5 T 6 Y 7 U
    // We'll map to a linear semitone ladder starting from baseMidi().
    return {
      // lower row
      'z': 0,  's': 1, 'x': 2,  'd': 3, 'c': 4,
      'v': 5,  'g': 6, 'b': 7,  'h': 8, 'n': 9,
      'j': 10, 'm': 11, ',': 12, 'l': 13, '.': 14, ';': 15, '/': 16,
      // upper row
      'q': 12, '2': 13, 'w': 14, '3': 15, 'e': 16,
      'r': 17, '5': 18, 't': 19, '6': 20, 'y': 21,
      '7': 22, 'u': 23, 'i': 24, '9': 25, 'o': 26, '0': 27, 'p': 28,
      // arrows for octave shift (handled separately in app)
    };
  }

  function keyToMidi(ev) {
    const key = ev.key?.toLowerCase();
    if (!key) return null;
    if (!(key in state.qwertyMap)) return null;
    return baseMidi() + state.qwertyMap[key];
  }

  function onKeyDown(ev) {
    // Avoid typing into inputs
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
    const midi = keyToMidi(ev);
    if (midi == null) return;
    if (state.down.has(midi)) return; // no repeats
    ev.preventDefault();
    noteOn(midi, 0.9);
  }
  function onKeyUp(ev) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
    const midi = keyToMidi(ev);
    if (midi == null) return;
    ev.preventDefault();
    noteOff(midi);
  }

  function enableQwerty() {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  function disableQwerty() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  }

  // ---- WebMIDI ----
  async function enableMidi() {
    try {
      if (!navigator.requestMIDIAccess) return;
      state.midiAccess = await navigator.requestMIDIAccess();
      attachMidiInputs();
      state.midiAccess.onstatechange = attachMidiInputs;
    } catch {
      // MIDI not available
    }
  }
  function disableMidi() {
    for (const input of state.midiInputs) {
      if (input && input.onmidimessage) input.onmidimessage = null;
    }
    state.midiInputs = [];
  }
  function attachMidiInputs() {
    disableMidi();
    if (!state.midiAccess) return;
    for (const input of state.midiAccess.inputs.values()) {
      input.onmidimessage = (msg) => {
        const [status, d1, d2] = msg.data;
        const cmd = status & 0xf0;
        const midi = d1;
        const vel = (d2 || 0) / 127;
        if (cmd === 0x90 && vel > 0) {
          noteOn(midi, vel || 0.8);
        } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
          noteOff(midi);
        }
      };
      state.midiInputs.push(input);
    }
  }

  // ---- Note helpers ----
  function noteOn(midi, velocity = 0.9) {
    if (state.down.has(midi)) return;
    state.down.add(midi);
    highlight(midi, true);
    onNoteOn(midi, velocity);
  }

  function noteOff(midi) {
    if (!state.down.has(midi)) return;
    state.down.delete(midi);
    highlight(midi, false);
    onNoteOff(midi);
  }

  function highlight(midi, on) {
    const el = state.keyEls.get(midi);
    if (!el) return;
    el.classList.toggle('active', !!on);
  }

  function octaveNumberFromMidi(midi) {
    // MIDI 60 = C4
    return Math.floor(midi / 12) - 1;
  }

  // ---- Public controls ----
  function setOctave(offset) {
    baseOctaveOffset = Math.max(-3, Math.min(4, offset | 0));
    // Rerender keys to move base MIDI
    const active = [...state.down];
    for (const m of active) noteOff(m);
    containerEl.innerHTML = '';
    renderKeys();
  }

  function setQwerty(enabled) {
    qwertyEnabled = !!enabled;
    if (qwertyEnabled) enableQwerty();
    else disableQwerty();
  }

  function setMidiIn(enabled) {
    midiInEnabled = !!enabled;
    if (midiInEnabled) enableMidi();
    else disableMidi();
  }

  // Cleanup (optional future)
  function dispose() {
    disableQwerty();
    disableMidi();
    containerEl.innerHTML = '';
    state.keyEls.clear();
    state.down.clear();
  }

  // Return public API
  return {
    setOctave,
    setQwerty,
    setMidiIn,
    highlight,
    dispose,
  };
}
