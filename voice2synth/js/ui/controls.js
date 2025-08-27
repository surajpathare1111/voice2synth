// /js/ui/controls.js
// Builds the right-side controls panel.
// API:
//   initControls(panelEl, { mode, onParamChange })
// Returns:
//   { setMode(mode), getParams() }

export function initControls(panelEl, opts = {}) {
  let mode = opts.mode || 'instrument';
  const onParamChange = typeof opts.onParamChange === 'function' ? opts.onParamChange : () => {};

  // Shared param state (both modes can read/write these)
  const params = {
    // Envelope
    attack: 0.008,
    decay: 0.12,
    sustain: 0.7,
    release: 0.18,
    // Instrument (granular) extras
    grainSize: 0.04,   // seconds
    overlap: 0.5,      // 0..1
    jitter: 0.002,     // seconds (random time jitter)
    transpose: 0,      // semitones
    formantShift: 0,   // semitones (small range recommended)
    brightness: 0,     // -1..+1 (tilt EQ)
    reverbMix: 0.12,   // 0..1
    // Piano extras (kept for future use)
    velocityCurve: 0.0 // -1..+1
  };

  // Build UI once; swap sections per mode
  panelEl.innerHTML = '';
  panelEl.append(
    makeSection('Envelope', [
      slider('Attack', 'attack', 0.001, 1.0, 0.001, params.attack, (v)=>params.attack=v),
      slider('Decay', 'decay', 0.01, 2.0, 0.01, params.decay, (v)=>params.decay=v),
      slider('Sustain', 'sustain', 0.0, 1.0, 0.01, params.sustain, (v)=>params.sustain=v),
      slider('Release', 'release', 0.01, 3.0, 0.01, params.release, (v)=>params.release=v),
    ], 'env')
  );

  const instrumentSection = makeSection('Instrument (Timbre)', [
    slider('Grain Size (ms)', 'grainSize', 10, 120, 1, params.grainSize*1000, (v)=>params.grainSize = v/1000),
    slider('Overlap', 'overlap', 0.0, 0.95, 0.01, params.overlap, (v)=>params.overlap = v),
    slider('Jitter (ms)', 'jitter', 0, 12, 0.1, params.jitter*1000, (v)=>params.jitter = v/1000),
    slider('Transpose (st)', 'transpose', -24, 24, 1, params.transpose, (v)=>params.transpose = Math.round(v)),
    slider('Formant Shift (st)', 'formantShift', -3, 3, 0.1, params.formantShift, (v)=>params.formantShift = +v),
    slider('Brightness', 'brightness', -1, 1, 0.01, params.brightness, (v)=>params.brightness = +v),
    slider('Reverb Mix', 'reverbMix', 0, 1, 0.01, params.reverbMix, (v)=>params.reverbMix = +v),
  ], 'instr');

  const pianoSection = makeSection('Piano (MIDI)', [
    slider('Velocity Curve', 'velocityCurve', -1, 1, 0.01, params.velocityCurve, (v)=>params.velocityCurve = +v),
    note('Tip: use Settings → Quantize for grid, and “Extract MIDI” to generate notes from the selection.')
  ], 'piano');

  panelEl.append(instrumentSection, pianoSection);

  // Show proper section initially
  setMode(mode);

  // Notify initial params
  onParamChange({ ...params });

  // ------------- helpers -------------
  function setMode(nextMode) {
    mode = nextMode;
    instrumentSection.style.display = mode === 'instrument' ? '' : 'none';
    pianoSection.style.display = mode === 'piano' ? '' : 'none';
    // Push current params for the new mode
    onParamChange({ ...params });
  }

  function getParams() {
    return { ...params };
  }

  // ---- UI factories ----
  function makeSection(title, children, id) {
    const wrap = document.createElement('section');
    wrap.className = 'control-section';
    wrap.dataset.id = id;

    const h = document.createElement('h3');
    h.textContent = title;
    wrap.appendChild(h);

    for (const child of children) wrap.appendChild(child);
    return wrap;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    return p;
  }

  function slider(labelText, key, min, max, step, value, assignFn) {
    const row = document.createElement('div');
    row.className = 'control-row';

    const label = document.createElement('label');
    label.textContent = labelText;

    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = format(value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', labelText);

    input.addEventListener('input', () => {
      const v = clamp(parseFloat(input.value), min, max);
      val.textContent = format(v);
      assignFn(v);
      onParamChange({ ...params });
    });

    const controls = document.createElement('div');
    controls.className = 'control-input';
    controls.append(input, val);

    row.append(label, controls);
    return row;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }
  function format(v) {
    if (Math.abs(v) >= 100 || Math.abs(v) < 0.01) return v.toFixed(2);
    if (Math.abs(v) >= 10) return v.toFixed(2);
    return v.toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
  }

  return { setMode, getParams };
}
