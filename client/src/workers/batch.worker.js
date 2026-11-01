/**
 * Batch propagation worker (Vite ES-module worker).
 * Imported via: new Worker(new URL('../workers/batch.worker.js', import.meta.url), { type: 'module' })
 *
 * Message in:
 *   { satrecs: [{_norad_id, ...satrec}], startTs: number, stepMs: number, numSteps: number }
 *
 * Message out:
 *   { frames: [{ ts: number, positions: [{norad_id, lat, lon, altKm}] }] }
 */
import * as satellite from 'satellite.js';

self.onmessage = function (e) {
  const { satrecs, startTs, stepMs, numSteps } = e.data;
  if (!satrecs?.length || !numSteps) { self.postMessage({ frames: [] }); return; }

  const frames = [];

  for (let i = 0; i < numSteps; i++) {
    const ts   = startTs + i * stepMs;
    const date = new Date(ts);
    const positions = [];

    for (const rec of satrecs) {
      try {
        const pv = satellite.propagate(rec, date);
        if (!pv?.position) continue;
        const { x, y, z } = pv.position;
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

        const gmst = satellite.gstime(date);
        const geo  = satellite.eciToGeodetic(pv.position, gmst);
        const lat  = satellite.degreesLat(geo.latitude);
        const lon  = satellite.degreesLong(geo.longitude);
        const alt  = geo.height;

        if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt) || alt < -100) continue;
        positions.push({ norad_id: rec._norad_id, lat, lon, altKm: alt });
      } catch { /* skip */ }
    }

    frames.push({ ts, positions });
  }

  self.postMessage({ frames });
};
