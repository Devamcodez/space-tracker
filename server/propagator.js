const satellite = require('satellite.js');

// ── Constants ──────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM   = 6371.0;
const STALE_TLE_DAYS    = 14;
const MS_PER_DAY        = 86_400_000;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return true if every value in the object is a finite number.
 */
function isFiniteVec({ x, y, z }) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/**
 * Compute the epoch Date of a parsed satrec.
 * satellite.js stores epochyr (2-digit year) and epochdays.
 */
function satrec2epoch(satrec) {
  const yr = satrec.epochyr < 57 ? 2000 + satrec.epochyr : 1900 + satrec.epochyr;
  return new Date(Date.UTC(yr, 0, 1) + (satrec.epochdays - 1) * MS_PER_DAY);
}

/**
 * Warn once (per TLE) when the epoch is older than STALE_TLE_DAYS.
 */
function warnIfStale(satrec, noradHint = '') {
  const epoch = satrec2epoch(satrec);
  const ageDays = (Date.now() - epoch.getTime()) / MS_PER_DAY;
  if (ageDays > STALE_TLE_DAYS) {
    console.warn(
      `[propagator] Stale TLE${noradHint ? ` (NORAD ${noradHint})` : ''}: epoch ${epoch.toISOString()} is ${ageDays.toFixed(1)} days old`
    );
  }
}

/**
 * Parse TLE lines into a satrec, returning null on failure.
 */
function parseSatrec(tleLine1, tleLine2) {
  try {
    return satellite.twoline2satrec(tleLine1, tleLine2);
  } catch {
    return null;
  }
}

/**
 * Run SGP4 propagation and convert ECI → geodetic + ECEF.
 * Returns the full result object or null on any error / NaN output.
 */
function _propagate(satrec, dateObj) {
  const posVel = satellite.propagate(satrec, dateObj);

  if (!posVel || !posVel.position || !isFiniteVec(posVel.position)) return null;

  const gmst   = satellite.gstime(dateObj);
  const geo    = satellite.eciToGeodetic(posVel.position, gmst);
  const lat    = satellite.degreesLat(geo.latitude);
  const lon    = satellite.degreesLong(geo.longitude);
  const altKm  = geo.height;

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm)) return null;

  // Velocity magnitude (km/s)
  let velocityKmS = null;
  if (posVel.velocity && isFiniteVec(posVel.velocity)) {
    const { x: vx, y: vy, z: vz } = posVel.velocity;
    velocityKmS = Math.sqrt(vx * vx + vy * vy + vz * vz);
  }

  // ECEF position via ECI rotation
  const ecef = satellite.eciToEcf(posVel.position, gmst);

  return { lat, lon, altKm, velocityKmS, ecef: { x: ecef.x, y: ecef.y, z: ecef.z } };
}

// ── Exported functions ─────────────────────────────────────────────────────

/**
 * Propagate a single satellite to a specific date.
 *
 * @param {string} tleLine1
 * @param {string} tleLine2
 * @param {Date}   dateObj  - defaults to now
 * @returns {{ lat, lon, altKm, velocityKmS, ecef: {x,y,z} } | null}
 */
function propagateSingle(tleLine1, tleLine2, dateObj = new Date()) {
  const satrec = parseSatrec(tleLine1, tleLine2);
  if (!satrec) return null;

  warnIfStale(satrec);
  return _propagate(satrec, dateObj);
}

/**
 * Propagate an array of satellites to a given date.
 * Nulls (decayed / invalid TLEs) are filtered out.
 *
 * @param {{ norad_id, name, tle_line1, tle_line2 }[]} satelliteArray
 * @param {Date} dateObj
 * @returns {{ norad_id, name, lat, lon, altKm, velocityKmS }[]}
 */
function propagateAll(satelliteArray, dateObj = new Date()) {
  const results = [];

  for (const sat of satelliteArray) {
    const satrec = parseSatrec(sat.tle_line1, sat.tle_line2);
    if (!satrec) continue;

    warnIfStale(satrec, sat.norad_id);
    const pos = _propagate(satrec, dateObj);
    if (!pos) continue;

    results.push({
      norad_id:    sat.norad_id,
      name:        sat.name,
      lat:         pos.lat,
      lon:         pos.lon,
      altKm:       pos.altKm,
      velocityKmS: pos.velocityKmS,
    });
  }

  return results;
}

/**
 * Generate an orbit trail by sampling SGP4 across one full orbital period.
 *
 * Mean motion (rev/day) is in TLE line 2, columns 52-63.
 * Period (minutes) = 1440 / meanMotion.
 *
 * @param {string} tleLine1
 * @param {string} tleLine2
 * @param {number} numPoints - samples per orbit (default 64)
 * @returns {{ lat, lon, altKm }[]}
 */
function generateOrbitTrail(tleLine1, tleLine2, numPoints = 64) {
  const satrec = parseSatrec(tleLine1, tleLine2);
  if (!satrec) return [];

  // Mean motion stored in satrec.no is in rad/min; convert to rev/day for period calc
  // period = 2π / no  (minutes)
  const periodMinutes = (2 * Math.PI) / satrec.no;
  if (!Number.isFinite(periodMinutes) || periodMinutes <= 0) return [];

  const stepMs  = (periodMinutes * 60_000) / numPoints;
  const now     = Date.now();
  const points  = [];

  for (let i = 0; i < numPoints; i++) {
    const date = new Date(now + i * stepMs);
    const pos  = _propagate(satrec, date);
    if (pos) points.push({ lat: pos.lat, lon: pos.lon, altKm: pos.altKm });
  }

  return points;
}

/**
 * Propagate a satellite into the future at fixed time steps.
 * Used by the collision engine to build a state vector time series.
 *
 * @param {string} tleLine1
 * @param {string} tleLine2
 * @param {Date}   startDate
 * @param {number} stepMinutes  - interval between samples
 * @param {number} numSteps     - total number of samples
 * @returns {{ timestamp: number, lat, lon, altKm, ecef: {x,y,z} }[]}
 */
function propagateFuture(tleLine1, tleLine2, startDate, stepMinutes, numSteps) {
  const satrec = parseSatrec(tleLine1, tleLine2);
  if (!satrec) return [];

  const stepMs  = stepMinutes * 60_000;
  const start   = startDate.getTime();
  const results = [];

  for (let i = 0; i < numSteps; i++) {
    const ts   = start + i * stepMs;
    const date = new Date(ts);
    const pos  = _propagate(satrec, date);
    if (!pos) continue;

    results.push({
      timestamp: ts,
      lat:       pos.lat,
      lon:       pos.lon,
      altKm:     pos.altKm,
      ecef:      pos.ecef,
    });
  }

  return results;
}

module.exports = { propagateSingle, propagateAll, generateOrbitTrail, propagateFuture };
