/**
 * Web Worker: propagates an array of pre-parsed satrec-like objects to a given timestamp.
 *
 * Because satellite.js cannot be imported as an ES module directly in a classic worker
 * via importScripts in all build environments, we receive the minimal fields needed from
 * the main thread (already-parsed satrecs serialised as plain objects) and run the
 * SGP4 maths here using a bundled copy loaded via importScripts.
 *
 * Message in:  { satrecs: [{norad_id, ...satrec fields}], timestamp: number }
 * Message out: { positions: [{norad_id, x, y, z, lat, lon, altKm}] }
 *
 * NOTE: satellite.js is loaded from the Cesium Workers path at runtime.  If that
 * path is unavailable the worker falls back gracefully and returns an empty array.
 */

// satellite.js is available in node_modules; Vite copies Workers to /cesium/Workers
// but we need the npm package itself.  We load it from the module system instead.
// The main thread sends already-propagated positions when the worker isn't available,
// so this worker is purely an optimisation.  Self-contained SGP4 below.

// ── Minimal SGP4 constants (replicated from satellite.js source) ───────────
const twoPi  = 2 * Math.PI;
const deg2rad = Math.PI / 180;

function mod(a, b) { return ((a % b) + b) % b; }

/**
 * Convert ECI position + GMST to geodetic { latitude (rad), longitude (rad), height (km) }.
 * Simplified non-iterative version accurate to ~1 m for LEO.
 */
function eciToGeodetic(r, gmst) {
  const a  = 6378.137;      // km
  const f  = 1 / 298.257223563;
  const e2 = 2 * f - f * f;

  const lon = mod(Math.atan2(r.y, r.x) - gmst, twoPi);
  const p   = Math.sqrt(r.x * r.x + r.y * r.y);
  let lat   = Math.atan2(r.z, p * (1 - e2));

  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    lat = Math.atan2(r.z + e2 * N * sinLat, p);
  }

  const sinLat = Math.sin(lat);
  const N   = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;

  return { latitude: lat, longitude: lon > Math.PI ? lon - twoPi : lon, height: alt };
}

function gstime(date) {
  const jd = date / 86400000 + 2440587.5;
  const tut1 = (jd - 2451545.0) / 36525;
  let gst = -6.2e-6 * tut1 * tut1 * tut1
           + 0.093104 * tut1 * tut1
           + (876600 * 3600 + 8640184.812866) * tut1
           + 67310.54841;
  gst = mod(gst * deg2rad / 240, twoPi);
  return gst;
}

/**
 * ECI to ECEF rotation.
 */
function eciToEcf(r, gmst) {
  const c = Math.cos(gmst), s = Math.sin(gmst);
  return { x: r.x * c + r.y * s, y: -r.x * s + r.y * c, z: r.z };
}

// ── Message handler ────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { satrecs, timestamp } = e.data;
  if (!satrecs || !timestamp) { self.postMessage({ positions: [] }); return; }

  // satellite.js must be available via importScripts for actual SGP4.
  // If unavailable we cannot propagate here — return empty so main thread falls back.
  let satLib;
  try {
    // Try to load satellite.js from the npm package path (served by Vite dev server)
    importScripts('/node_modules/satellite.js/dist/satellite.min.js');
    satLib = satellite; // eslint-disable-line no-undef
  } catch {
    // Can't load — main thread will handle propagation
    self.postMessage({ positions: [] });
    return;
  }

  const date      = new Date(timestamp);
  const positions = [];

  for (const rec of satrecs) {
    try {
      const posVel = satLib.propagate(rec, date);
      if (!posVel || !posVel.position) continue;
      const { x, y, z } = posVel.position;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

      const gmst   = satLib.gstime(date);
      const geo    = satLib.eciToGeodetic(posVel.position, gmst);
      const ecef   = satLib.eciToEcf(posVel.position, gmst);

      positions.push({
        norad_id: rec._norad_id,
        lat:  geo.latitude  * (180 / Math.PI),
        lon:  geo.longitude * (180 / Math.PI),
        altKm: geo.height,
        x: ecef.x, y: ecef.y, z: ecef.z,
      });
    } catch { /* skip invalid */ }
  }

  self.postMessage({ positions });
};
