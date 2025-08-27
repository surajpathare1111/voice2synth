// /workers/pitchWorker.js
// Web Worker: fast, dependency-free pitch tracking (YIN + MPM) on a mono Float32 segment.
// Receives: { type: 'analyze', payload: { float32Audio, sr, method, minDurMs, hysteresisCents, gateDb } }
// Responds:  { type: 'analyze:ok', payload: { f0Hz: Float32Array } }  OR { type: 'analyze:err', payload: { message } }
//
// Notes:
// - Hop size ~10 ms. Frame size auto-chosen (>= 3 * min period).
// - Simple energy gate (gateDb) to suppress silence.
// - If method === 'crepe', we currently fall back to YIN (front-end toggle still works).
// - Keep this file as a true Worker module (no DOM access).

self.onmessage = async (e) => {
  try {
    const { type, payload } = e.data || {};
    if (type !== 'analyze') return;

    const {
      float32Audio,
      sr = 44100,
      method = 'yin',
      gateDb = -40,
    } = payload || {};

    if (!float32Audio || !float32Audio.length) {
      return postMessage({ type: 'analyze:ok', payload: { f0Hz: new Float32Array(0) } });
    }

    // Analysis params
    const hop = Math.max(1, Math.floor(sr * 0.01)); // 10ms hop
    const fMin = 60;   // Hz (A1)
    const fMax = 1200; // Hz (rough upper bound for meows/whistles)
    const tauMin = Math.floor(sr / fMax);
    const tauMax = Math.ceil(sr / fMin);

    // Ensure frame is long enough: YIN needs > 2 * tauMax; use power-of-two near 2048/4096
    const minFrame = Math.max(1024, 2 * tauMax + 4);
    const frameSize = nextPow2(Math.min(8192, Math.max(2048, minFrame)));

    // Prepare output
    const nFrames = Math.max(0, Math.floor((float32Audio.length - frameSize) / hop) + 1);
    const f0Hz = new Float32Array(nFrames);

    // Precompute energy threshold for gate (RMS in dBFS)
    const gateLin = dbToLin(gateDb);

    // Process frames
    let idx = 0;
    for (let i = 0; i < nFrames; i++) {
      const off = i * hop;

      // RMS for gate
      const rms = frameRMS(float32Audio, off, frameSize);
      if (rms < gateLin) {
        f0Hz[idx++] = 0;
        continue;
      }

      let f0 = 0;
      const m = method.toLowerCase();
      if (m === 'yin' || m === 'crepe') {
        // 'crepe' falls back to YIN in this Worker (no TF.js here)
        f0 = yinPitch(float32Audio, off, frameSize, sr, tauMin, tauMax);
      } else {
        f0 = mpmPitch(float32Audio, off, frameSize, sr, tauMin, tauMax);
      }
      f0Hz[idx++] = f0;
    }

    postMessage({ type: 'analyze:ok', payload: { f0Hz } });
  } catch (err) {
    postMessage({ type: 'analyze:err', payload: { message: err?.message || String(err) } });
  }
};

// ----------------------- Utilities & Algorithms -----------------------

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function dbToLin(db) {
  return Math.pow(10, db / 20);
}

function frameRMS(x, off, size) {
  let s = 0;
  const end = Math.min(x.length, off + size);
  for (let i = off; i < end; i++) {
    const v = x[i];
    s += v * v;
  }
  const len = Math.max(1, end - off);
  return Math.sqrt(s / len);
}

// ---- YIN (de Cheveigné & Kawahara, 2002) ----
function yinPitch(x, off, w, sr, tauMin, tauMax) {
  // 1) Difference function d(tau)
  const maxTau = Math.min(tauMax, w - 1);
  const d = new Float32Array(maxTau + 1);
  d[0] = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    const lim = w - tau;
    for (let i = 0; i < lim; i++) {
      const diff = x[off + i] - x[off + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2) Cumulative mean normalized difference CMND
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let cum = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    cum += d[tau];
    cmnd[tau] = d[tau] * tau / (cum || 1);
  }

  // 3) Absolute threshold
  const threshold = 0.1; // typical YIN threshold
  let tau = tauMin;
  for (; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      // pick local minimum around tau
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      break;
    }
  }
  if (tau > maxTau) return 0; // unvoiced

  // 4) Parabolic interpolation around tau for better precision
  const tauL = Math.max(tauMin, tau - 1);
  const tauR = Math.min(maxTau, tau + 1);
  const s0 = cmnd[tauL], s1 = cmnd[tau], s2 = cmnd[tauR];
  const denom = (2 * (s0 - 2 * s1 + s2)) || 1e-9;
  const delta = (s0 - s2) / denom;
  const tauRefined = tau + Math.max(-1, Math.min(1, delta)); // clamp a bit

  const f0 = sr / tauRefined;
  if (!isFinite(f0) || f0 <= 0) return 0;
  return f0;
}

// ---- McLeod Pitch Method (MPM) ----
function mpmPitch(x, off, w, sr, tauMin, tauMax) {
  // McLeod combines NSDF (normalized squared difference) and peak picking
  const maxTau = Math.min(tauMax, w - 1);
  const nsdf = new Float32Array(maxTau + 1);
  nsdf[0] = 1;

  // Autocorrelation & energy terms
  // NSDF(tau) = 2 * sum(x[i]*x[i+tau]) / (sum(x[i]^2) + sum(x[i+tau]^2))
  // We'll compute denominator incrementally.
  let sumSq0 = 0;
  for (let i = 0; i < w; i++) {
    const v = x[off + i];
    sumSq0 += v * v;
  }
  for (let tau = 1; tau <= maxTau; tau++) {
    let ac = 0, sumSq1 = 0, sumSq2 = 0;
    const lim = w - tau;
    for (let i = 0; i < lim; i++) {
      const a = x[off + i];
      const b = x[off + i + tau];
      ac += a * b;
      sumSq1 += a * a;
      sumSq2 += b * b;
    }
    const denom = sumSq1 + sumSq2;
    nsdf[tau] = denom > 0 ? (2 * ac) / denom : 0;
  }

  // Peak picking in nsdf (look for the highest peak after tauMin)
  let tau = -1, maxVal = -1;
  for (let t = tauMin; t <= maxTau - 1; t++) {
    if (nsdf[t] > nsdf[t - 1] && nsdf[t] >= nsdf[t + 1] && nsdf[t] > maxVal) {
      tau = t;
      maxVal = nsdf[t];
    }
  }
  if (tau < tauMin || maxVal < 0.3) return 0; // unvoiced-ish

  // Parabolic interpolate around tau for sub-sample precision
  const tauL = Math.max(tauMin, tau - 1);
  const tauR = Math.min(maxTau, tau + 1);
  const s0 = nsdf[tauL], s1 = nsdf[tau], s2 = nsdf[tauR];
  const denom = (2 * (s0 - 2 * s1 + s2)) || 1e-9;
  const delta = (s0 - s2) / denom;
  const tauRefined = tau + Math.max(-1, Math.min(1, delta));

  const f0 = sr / tauRefined;
  return isFinite(f0) && f0 > 0 ? f0 : 0;
}
