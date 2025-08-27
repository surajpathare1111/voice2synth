// /js/ui/waveform.js
// Wrapper around WaveSurfer v7 + Regions plugin
// Exposes: initWaveform(containerEl) -> { loadBuffer, onRegionChanged, getRegion, playPause, stop, zoom, setLoop, setZeroCrossSnap, setZoom }

export function initWaveform(containerEl) {
  if (!window.WaveSurfer) {
    throw new Error('WaveSurfer not found. Ensure wavesurfer.js is loaded before main.js');
  }

  // --- Internal state ---
  let ws = null;
  let regions = null;
  let currentRegion = null;
  let loopEnabled = false;
  let zeroCrossSnap = true;
  let zoomLevel = 0;               // WaveSurfer uses "zoom" in px-per-second; 0 = auto
  let suppressRegionEvt = false;   // avoid infinite loops when programmatically adjusting region

  // --- Create WaveSurfer + Regions ---
  ws = WaveSurfer.create({
    container: containerEl,
    waveColor: '#7fb7ff',
    progressColor: '#3fa9f5',
    cursorColor: '#fff',
    barWidth: 1,
    barGap: 0,
    barRadius: 0,
    height: 200,
    autoCenter: true,
    interact: true,
    minPxPerSec: 20,
    normalize: true,
    renderFunction: null
  });

  regions = ws.registerPlugin(WaveSurfer.Regions.create({
    dragSelection: {
      slop: 5,
      color: 'rgba(63,169,245,0.15)',
      handleStyle: { left: { color: '#3fa9f5' }, right: { color: '#3fa9f5' } }
    },
    maxRegions: 1
  }));

  // --- Region event wiring ---
  regions.on('region-created', (reg) => {
    // Keep only one region
    if (currentRegion && reg.id !== currentRegion.id) {
      try { currentRegion.remove(); } catch {}
    }
    currentRegion = reg;
    if (loopEnabled) currentRegion.setOptions({ loop: true });
    emitRegionChanged();
  });

  regions.on('region-updated', (reg) => {
    currentRegion = reg;
    if (suppressRegionEvt) return;
    if (zeroCrossSnap) {
      // Snap to zero crossings after user finishes a drag (debounced lightly)
      snapRegionToZeroCrossing(reg);
    } else {
      emitRegionChanged();
    }
  });

  regions.on('region-removed', () => {
    currentRegion = null;
    emitRegionChanged();
  });

  // Double-click to play region
  regions.on('region-clicked', (reg, e) => {
    if (e.detail === 2) {
      playRegion(reg);
    }
  });

  // --- Helpers ---
  function playRegion(reg) {
    if (!reg) return;
    const start = reg.start;
    const end = reg.end;
    ws.play(start, end);
  }

  function emitRegionChanged() {
    const region = getRegion();
    listeners.forEach((cb) => {
      try { cb(region); } catch { /* noop */ }
    });
  }

  // Find nearest zero crossing around a time point
  function findZeroCrossingTime(audioBuffer, timeSec, direction = 0, maxWindowMs = 12) {
    const sr = audioBuffer.sampleRate;
    const maxSamples = Math.max(1, Math.floor((maxWindowMs / 1000) * sr));
    const chData = audioBuffer.numberOfChannels ? audioBuffer.getChannelData(0) : null;
    if (!chData) return timeSec;

    let idx = Math.min(Math.max(0, Math.floor(timeSec * sr)), chData.length - 1);

    // Search window depends on direction: -1 (backward), 1 (forward), 0 (both)
    let bestIdx = idx;
    let found = false;

    const testDir = (dir) => {
      let lastSample = chData[idx];
      for (let i = 1; i < maxSamples; i++) {
        const j = dir < 0 ? idx - i : idx + i;
        if (j < 1 || j >= chData.length) break;
        const s = chData[j];
        // crossing if sign changes or exactly zero
        if ((lastSample <= 0 && s > 0) || (lastSample >= 0 && s < 0) || s === 0) {
          bestIdx = j;
          found = true;
          break;
        }
        lastSample = s;
      }
    };

    if (direction === 0) {
      testDir(-1);
      if (!found) testDir(1);
    } else {
      testDir(direction);
    }

    return found ? bestIdx / sr : timeSec;
  }

  async function snapRegionToZeroCrossing(reg) {
    const buf = ws.getDecodedData?.();
    if (!buf) {
      emitRegionChanged();
      return;
    }

    // Compute snapped edges
    const startZ = findZeroCrossingTime(buf, reg.start, -1);
    const endZ = findZeroCrossingTime(buf, reg.end, 1);

    // Avoid collapse
    const minDur = 0.02; // 20ms minimum duration
    const snappedStart = Math.max(0, Math.min(startZ, endZ - minDur));
    const snappedEnd = Math.max(snappedStart + minDur, endZ);

    // If significant change, update and emit
    const changed = (Math.abs(snappedStart - reg.start) > 0.0005) || (Math.abs(snappedEnd - reg.end) > 0.0005);

    if (changed) {
      suppressRegionEvt = true;
      reg.setOptions({ start: snappedStart, end: snappedEnd });
      suppressRegionEvt = false;
    }
    emitRegionChanged();
  }

  // --- Public API wiring ---
  const listeners = new Set();

  function onRegionChanged(cb) {
    if (typeof cb === 'function') listeners.add(cb);
    // fire immediately with current
    cb(getRegion());
    return () => listeners.delete(cb);
  }

  function getRegion() {
    if (!currentRegion) return null;
    const start = Math.max(0, currentRegion.start);
    const end = Math.max(start, currentRegion.end);
    return {
      start,
      end,
      duration: Math.max(0, end - start),
    };
  }

  async function loadBuffer(audioBuffer) {
    // Reset state
    try {
      regions.clear();
      currentRegion = null;
    } catch {}
    // Load decoded buffer
    if (typeof ws.loadDecodedBuffer === 'function') {
      ws.loadDecodedBuffer(audioBuffer);
    } else {
      // Fallback: create a blob (rarely needed in v7)
      const wav = await _bufferToWavBlob(audioBuffer);
      ws.loadBlob(wav);
    }
    // Center and redraw after decode
    ws.once('decode', () => {
      ws.setTime(0);
      ws.zoom(zoomLevel);
      emitRegionChanged();
    });
  }

  function playPause() {
    ws.playPause();
  }

  function stop() {
    ws.stop();
  }

  function zoom(delta) {
    // sensible zoom ladder
    const steps = [0, 40, 80, 120, 200, 320, 500, 800, 1200];
    const idx = Math.max(0, steps.findIndex((v) => v >= zoomLevel));
    let newIdx = idx + (delta > 0 ? 1 : -1);
    if (zoomLevel === steps[idx]) {
      // ok
    } else {
      // find nearest current
      const nearest = steps.reduce((p, c) => Math.abs(c - zoomLevel) < Math.abs(p - zoomLevel) ? c : p, steps[0]);
      newIdx = steps.indexOf(nearest) + (delta > 0 ? 1 : -1);
    }
    newIdx = Math.max(0, Math.min(steps.length - 1, newIdx));
    zoomLevel = steps[newIdx];
    ws.zoom(zoomLevel);
  }

  function setZoom(pxPerSec) {
    zoomLevel = Math.max(0, pxPerSec | 0);
    ws.zoom(zoomLevel);
  }

  function setLoop(enabled) {
    loopEnabled = !!enabled;
    if (currentRegion) {
      currentRegion.setOptions({ loop: loopEnabled });
    }
  }

  function setZeroCrossSnap(enabled) {
    zeroCrossSnap = !!enabled;
    if (zeroCrossSnap && currentRegion) {
      // immediately snap current region once
      snapRegionToZeroCrossing(currentRegion);
    }
  }

  // --- Utils: minimal WAV encoder for fallback ---
  async function _bufferToWavBlob(audioBuffer) {
    const numOfChan = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);

    _writeString(view, 0, 'RIFF');
    view.setUint32(4, length - 8, true);
    _writeString(view, 8, 'WAVE');
    _writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numOfChan, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numOfChan * 2, true);
    view.setUint16(32, numOfChan * 2, true);
    view.setUint16(34, 16, true);
    _writeString(view, 36, 'data');
    view.setUint32(40, length - 44, true);

    const channels = [];
    for (let i = 0; i < numOfChan; i++) channels.push(audioBuffer.getChannelData(i));
    const interleaved = _interleave(channels);
    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, interleaved[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function _interleave(chans) {
    const length = chans[0].length;
    const numCh = chans.length;
    const out = new Float32Array(length * numCh);
    let idx = 0;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numCh; ch++) out[idx++] = chans[ch][i];
    }
    return out;
  }
  function _writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  }

  // Public API
  return {
    loadBuffer,
    onRegionChanged,
    getRegion,
    playPause,
    stop,
    zoom,
    setZoom,
    setLoop,
    setZeroCrossSnap,
  };
}
