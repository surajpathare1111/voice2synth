// /js/main.js
// Entry point: wires UI, audio engine, waveform, keyboard, controls, and actions.
// Requires: WaveSurfer.js, Tone.js loaded globally via <script> in index.html

import { initWaveform } from './ui/waveform.js';
import { initKeyboard } from './ui/keyboard.js';
import { initControls } from './ui/controls.js';

import { initAudio } from './audio/engine.js';
import { createGranularInstrument } from './audio/samplerInstrument.js';
import { createPiano } from './audio/pianoInstrument.js';
import { segmentToMidi, exportMidi } from './audio/pitchToMidi.js';

// ---------- App State ----------
const state = {
  mode: 'instrument', // 'instrument' | 'piano'
  engine: null,       // audio engine { context, masterGain, connect, ... }
  waveform: null,     // wavesurfer wrapper
  keyboard: null,     // onscreen keyboard
  controls: null,     // controls UI
  currentBuffer: null, // AudioBuffer of the loaded audio
  currentRegion: null, // { start, end, duration }
  recording: false,
  mediaRecorder: null,
  recordedChunks: [],
  // Instruments
  instrument: null,   // granular instrument instance (instrument mode)
  piano: null,        // piano sampler instance (piano mode)
  // Exports
  lastExtractedNotes: null, // [{pitch,tOn,tOff,velocity}]
  // Settings
  settings: {
    highAccuracy: false,      // CREPE toggle (lazy-loaded downstream)
    minNoteDurationMs: 100,
    quantize: '1/16',         // or 'off'
    noiseGateDb: -40,
    hpfHz: 30,
    qwerty: true,
    midiIn: true,
    octaveOffset: 0,
  }
};

// ---------- DOM Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  btnLoad: $('#btn-load'),
  fileInput: $('#file-input'),
  btnRecord: $('#btn-record'),
  btnPlay: $('#btn-play'),
  btnStop: $('#btn-stop'),
  btnZoomIn: $('#btn-zoom-in'),
  btnZoomOut: $('#btn-zoom-out'),
  chkLoop: $('#chk-loop'),
  chkZero: $('#chk-zero'),
  btnPreviewRegion: $('#btn-preview-region'),
  btnMakeInstrument: $('#btn-make-instrument'),
  btnExtractMidi: $('#btn-extract-midi'),
  btnExportMidi: $('#btn-export-midi'),
  btnSavePreset: $('#btn-save-preset'),
  modeSelect: $('#mode-select'),
  statusText: $('#status-text'),
  cpuMeter: $('#cpu-meter'),
  waveHint: $('#wave-hint'),
  keyboard: $('#keyboard'),
  controlsPanel: $('#controls-panel'),
  settingsDialog: $('#settings-dialog'),
  btnSettings: $('#btn-settings'),
  chkHighAccuracy: $('#chk-high-accuracy'),
  inpMinDuration: $('#inp-min-duration'),
  selQuantize: $('#sel-quantize'),
  inpGate: $('#inp-gate'),
  inpHpf: $('#inp-hpf'),
  octaveRange: $('#octave-range'),
  chkQwerty: $('#chk-qwerty'),
  chkMidiIn: $('#chk-midiin'),
};

function setStatus(msg) {
  els.statusText.textContent = msg;
  // Also update aria-live for screen readers
  const live = document.getElementById('aria-live');
  if (live) live.textContent = msg;
}

function setButtonsEnabled() {
  const hasRegion = !!state.currentRegion && !!state.currentBuffer;
  els.btnPreviewRegion.disabled = !hasRegion;
  els.btnMakeInstrument.disabled = !hasRegion || state.mode !== 'instrument';
  els.btnExtractMidi.disabled = !hasRegion || state.mode !== 'piano';

  els.btnExportMidi.disabled = !(state.lastExtractedNotes && state.lastExtractedNotes.length);
  els.btnSavePreset.disabled = !state.instrument;
}

// ---------- Boot ----------
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Init Audio Engine
    state.engine = await initAudio();
    setStatus('Audio engine ready.');

    // Init Waveform
    state.waveform = initWaveform(document.getElementById('waveform'));
    state.waveform.onRegionChanged((region) => {
      state.currentRegion = region;
      setStatus(`Region: ${region.start.toFixed(3)}s → ${region.end.toFixed(3)}s (${region.duration.toFixed(3)}s)`);
      setButtonsEnabled();
    });

    // Init Controls
    state.controls = initControls(els.controlsPanel, {
      mode: state.mode,
      onParamChange: (params) => {
        // Forward param changes to the active instrument
        if (state.mode === 'instrument' && state.instrument) {
          state.instrument.setParams(params);
        } else if (state.mode === 'piano' && state.piano) {
          state.piano.setParams?.(params);
        }
      }
    });

    // Init Keyboard
    state.keyboard = initKeyboard(els.keyboard, {
      octaves: 2,
      qwerty: state.settings.qwerty,
      midiIn: state.settings.midiIn,
      onNoteOn: (midi, velocity = 0.9) => {
        resumeAudioContext();
        if (state.mode === 'instrument' && state.instrument) {
          state.instrument.noteOn(midi, velocity);
        } else if (state.mode === 'piano' && state.piano) {
          state.piano.noteOn(midi, velocity);
        }
      },
      onNoteOff: (midi) => {
        if (state.mode === 'instrument' && state.instrument) {
          state.instrument.noteOff(midi);
        } else if (state.mode === 'piano' && state.piano) {
          state.piano.noteOff(midi);
        }
      }
    });

    // Piano instrument (always available in piano mode)
    state.piano = await createPiano({ assetsBaseUrl: './assets/samples/piano/' });
    state.piano.connect(state.engine.masterGain);

    // Wire UI
    wireTopBar();
    wireWaveToolbar();
    wireExportPanel();
    wireSettings();
    wireFooter();

    setButtonsEnabled();
  } catch (err) {
    console.error(err);
    setStatus('Error during initialization. See console.');
  }
});

// ---------- Wiring Handlers ----------
function wireTopBar() {
  els.btnLoad.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', onFileChosen);

  els.btnRecord.addEventListener('click', onToggleRecord);

  els.modeSelect.addEventListener('change', (e) => {
    state.mode = e.target.value;
    setStatus(`Mode: ${state.mode === 'instrument' ? 'Instrument (Timbre)' : 'Piano (MIDI)'}`);
    // Update controls UI to reflect mode
    state.controls.setMode(state.mode);
    setButtonsEnabled();
  });

  els.btnSettings.addEventListener('click', () => {
    els.settingsDialog.showModal();
  });
}

function wireWaveToolbar() {
  els.btnPlay.addEventListener('click', () => {
    resumeAudioContext();
    state.waveform.playPause();
  });

  els.btnStop.addEventListener('click', () => {
    state.waveform.stop();
  });

  els.btnZoomIn.addEventListener('click', () => state.waveform.zoom(1));
  els.btnZoomOut.addEventListener('click', () => state.waveform.zoom(-1));

  els.chkLoop.addEventListener('change', (e) => {
    state.waveform.setLoop(e.target.checked);
  });

  els.chkZero.addEventListener('change', (e) => {
    state.waveform.setZeroCrossSnap(e.target.checked);
  });

  els.btnPreviewRegion.addEventListener('click', previewSelectedSegment);

  els.btnMakeInstrument.addEventListener('click', async () => {
    if (!ensureRegion()) return;
    try {
      resumeAudioContext();
      setStatus('Building instrument from segment…');
      const { start, end } = state.currentRegion;
      const instrument = await createGranularInstrument({
        audioBuffer: state.currentBuffer,
        start, end,
        baseNote: await detectBaseNoteFromRegion()
      });
      if (state.instrument) {
        state.instrument.disconnect?.();
        state.instrument.dispose?.();
      }
      state.instrument = instrument;
      instrument.connect(state.engine.masterGain);
      setStatus('Instrument ready. Play the keyboard!');
      setButtonsEnabled();
    } catch (e) {
      console.error(e);
      setStatus('Failed to create instrument.');
    }
  });

  els.btnExtractMidi.addEventListener('click', async () => {
    if (!ensureRegion()) return;
    try {
      resumeAudioContext();
      setStatus('Analyzing pitch → MIDI…');
      const { start, end } = state.currentRegion;
      const notesOut = await segmentToMidi({
        audioBuffer: state.currentBuffer,
        start,
        end,
        sampleRate: state.currentBuffer.sampleRate,
        method: state.settings.highAccuracy ? 'crepe' : 'yin',
        quantize: state.settings.quantize,
        minDurMs: state.settings.minNoteDurationMs,
        hysteresisCents: 20,
        gateDb: state.settings.noiseGateDb
      });
      state.lastExtractedNotes = notesOut.notes || [];
      setStatus(`Extracted ${state.lastExtractedNotes.length} notes.`);
      setButtonsEnabled();

      // Optionally audition the MIDI through the piano
      if (state.mode === 'piano' && state.piano && state.lastExtractedNotes.length) {
        auditionNotes(state.lastExtractedNotes);
      }
    } catch (e) {
      console.error(e);
      setStatus('Failed to extract MIDI.');
    }
  });
}

function wireExportPanel() {
  els.btnExportMidi.addEventListener('click', () => {
    if (!(state.lastExtractedNotes && state.lastExtractedNotes.length)) return;
    const blob = exportMidi({
      notes: state.lastExtractedNotes,
      bpm: 120,
      ppq: 480
    });
    downloadBlob(blob, 'segment.mid');
  });

  els.btnSavePreset.addEventListener('click', async () => {
    if (!ensureRegion()) return;
    try {
      const preset = await buildInstrumentPresetJSON();
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'instrument-preset.json');
    } catch (e) {
      console.error(e);
      setStatus('Failed to save preset.');
    }
  });
}

function wireSettings() {
  els.chkHighAccuracy.addEventListener('change', (e) => {
    state.settings.highAccuracy = !!e.target.checked;
    setStatus(`Pitch mode: ${state.settings.highAccuracy ? 'High accuracy (CREPE)' : 'Fast (YIN)'}`);
  });
  els.inpMinDuration.addEventListener('input', (e) => {
    state.settings.minNoteDurationMs = parseInt(e.target.value || '100', 10);
  });
  els.selQuantize.addEventListener('change', (e) => {
    state.settings.quantize = e.target.value;
  });
  els.inpGate.addEventListener('input', (e) => {
    state.settings.noiseGateDb = parseInt(e.target.value || '-40', 10);
    state.engine?.setGate?.(state.settings.noiseGateDb);
  });
  els.inpHpf.addEventListener('input', (e) => {
    state.settings.hpfHz = parseInt(e.target.value || '30', 10);
    state.engine?.setHPF?.(state.settings.hpfHz);
  });
}

function wireFooter() {
  els.octaveRange.addEventListener('input', (e) => {
    const val = parseInt(e.target.value || '0', 10);
    state.settings.octaveOffset = val;
    state.keyboard.setOctave(val);
  });
  els.chkQwerty.addEventListener('change', (e) => {
    state.settings.qwerty = !!e.target.checked;
    state.keyboard.setQwerty(state.settings.qwerty);
  });
  els.chkMidiIn.addEventListener('change', (e) => {
    state.settings.midiIn = !!e.target.checked;
    state.keyboard.setMidiIn(state.settings.midiIn);
  });
}

// ---------- Actions ----------
async function onFileChosen(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    setStatus(`Loading file: ${file.name}`);
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await state.engine.context.decodeAudioData(arrayBuf);
    await loadBufferIntoWaveform(audioBuf, file.name);
    setStatus(`Loaded: ${file.name}`);
  } catch (err) {
    console.error(err);
    setStatus('Failed to load audio file.');
  } finally {
    // reset input so same file can be chosen again
    e.target.value = '';
  }
}

async function onToggleRecord() {
  if (state.recording) {
    // Stop recording
    state.mediaRecorder?.stop();
    return;
  }

  try {
    // Request mic
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    state.mediaRecorder = mr;
    state.recordedChunks = [];
    mr.ondataavailable = (evt) => {
      if (evt.data && evt.data.size > 0) {
        state.recordedChunks.push(evt.data);
      }
    };
    mr.onstop = async () => {
      const blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await state.engine.context.decodeAudioData(arrayBuf);
      await loadBufferIntoWaveform(audioBuf, 'Recording');
      // Stop tracks
      stream.getTracks().forEach(t => t.stop());
      state.recording = false;
      els.btnRecord.textContent = 'Record';
      setStatus('Recording loaded.');
    };
    mr.start();
    state.recording = true;
    els.btnRecord.textContent = 'Stop';
    setStatus('Recording… speak/meow/hum now.');
  } catch (e) {
    console.error(e);
    setStatus('Mic access denied or unsupported.');
  }
}

async function loadBufferIntoWaveform(audioBuffer, label = 'Audio') {
  state.currentBuffer = audioBuffer;
  await state.waveform.loadBuffer(audioBuffer);
  els.waveHint.style.display = 'none';
  state.currentRegion = null;
  setButtonsEnabled();
  setStatus(`${label} ready. Select a region to use.`);
}

function ensureRegion() {
  if (!state.currentBuffer) {
    setStatus('Load or record audio first.');
    return false;
  }
  if (!state.currentRegion) {
    setStatus('Select a region on the waveform first.');
    return false;
  }
  return true;
}

async function previewSelectedSegment() {
  if (!ensureRegion()) return;
  const { start, end } = state.currentRegion;
  const ctx = state.engine.context;
  const src = ctx.createBufferSource();
  src.buffer = state.currentBuffer;
  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  src.connect(gain).connect(ctx.destination);
  // small fades to avoid clicks
  // (handled in engine or here; engine may already have DC/HPF)
  resumeAudioContext();
  const duration = Math.max(0, end - start);
  src.start(0, start, duration);
  setStatus(`Previewing ${duration.toFixed(3)}s.`);
}

async function detectBaseNoteFromRegion() {
  // Lightweight estimation via segmentToMidi (fast mode) to pick a base note
  try {
    const { start, end } = state.currentRegion;
    const notesOut = await segmentToMidi({
      audioBuffer: state.currentBuffer,
      start,
      end,
      sampleRate: state.currentBuffer.sampleRate,
      method: 'yin',
      quantize: 'off',
      minDurMs: 60,
      hysteresisCents: 35,
      gateDb: state.settings.noiseGateDb
    });
    if (notesOut?.notes?.length) {
      // pick the most common pitch
      const hist = new Map();
      for (const n of notesOut.notes) {
        hist.set(n.pitch, (hist.get(n.pitch) || 0) + (n.tOff - n.tOn));
      }
      const [topPitch] = [...hist.entries()].sort((a,b)=>b[1]-a[1])[0];
      return topPitch; // MIDI note number
    }
  } catch (e) {
    console.warn('Base note detection failed, defaulting to C3', e);
  }
  return 60; // C4 (or use 48 for C3) depending on your preference
}

async function auditionNotes(notes) {
  if (!state.piano) return;
  // Simple real-time schedule relative to now
  const now = state.engine.context.currentTime + 0.1;
  const scale = 1.0; // assuming notes use seconds relative to segment start
  for (const n of notes) {
    state.piano.noteOn(n.pitch, (n.velocity ?? 0.9), now + n.tOn * scale);
    state.piano.noteOff(n.pitch, now + n.tOff * scale);
  }
}

async function buildInstrumentPresetJSON() {
  // Export selected audio segment as base64 + current params from controls
  const { start, end } = state.currentRegion;
  const sr = state.currentBuffer.sampleRate;
  const startFrame = Math.floor(start * sr);
  const endFrame = Math.floor(end * sr);
  const length = Math.max(0, endFrame - startFrame);
  const channels = state.currentBuffer.numberOfChannels;
  const seg = new AudioBuffer({ length, sampleRate: sr, numberOfChannels: channels });
  for (let ch = 0; ch < channels; ch++) {
    const src = state.currentBuffer.getChannelData(ch).subarray(startFrame, endFrame);
    seg.copyToChannel(src, ch, 0);
  }
  const wavBlob = await audioBufferToWavBlob(seg);
  const base64 = await blobToBase64(wavBlob);

  return {
    name: 'Voice2Synth Instrument',
    createdAt: new Date().toISOString(),
    baseNote: await detectBaseNoteFromRegion(),
    sampleRate: sr,
    audioBase64: base64,
    params: state.controls.getParams(),
    engine: 'granular-v1'
  };
}

// ---------- Utilities ----------
function resumeAudioContext() {
  const ctx = state.engine?.context;
  if (ctx && ctx.state !== 'running') {
    ctx.resume?.();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

async function audioBufferToWavBlob(audioBuffer) {
  // Minimal WAV encoder (PCM 16-bit)
  const numOfChan = audioBuffer.numberOfChannels;
  const length = audioBuffer.length * numOfChan * 2 + 44;
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, length - 8, true);
  writeString(view, 8, 'WAVE');
  // FMT sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // SubChunk1Size
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * numOfChan * 2, true); // Byte rate
  view.setUint16(32, numOfChan * 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, length - 44, true);

  // PCM samples
  let offset = 44;
  const chans = [];
  for (let i = 0; i < numOfChan; i++) {
    chans.push(audioBuffer.getChannelData(i));
  }
  const interleaved = interleave(chans);
  for (let i = 0; i < interleaved.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

function interleave(chans) {
  const length = chans[0].length;
  const numCh = chans.length;
  const out = new Float32Array(length * numCh);
  let idx = 0;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      out[idx++] = chans[ch][i];
    }
  }
  return out;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve((reader.result || '').toString().split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

// ---------- CPU meter (simple animation placeholder) ----------
let cpuAnim = 0;
(function cpuMeterTick() {
  cpuAnim = (cpuAnim + 1) % 100;
  els.cpuMeter.style.background = `linear-gradient(90deg, var(--accent) ${cpuAnim}%, transparent ${cpuAnim}%)`;
  requestAnimationFrame(cpuMeterTick);
})();
