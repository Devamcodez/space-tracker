const { KDTree } = require('kd-tree-javascript');
const { db, getConjunctions } = require('./db');
const { propagateFuture, propagateSingle } = require('./propagator');

// ── Tuning constants ───────────────────────────────────────────────────────

const SCREEN_THRESHOLD_KM    = 50;     // coarse KD-tree query radius
const REFINE_WINDOW_MIN      = 10;     // ± minutes around candidate TCA for refinement
const REFINE_STEP_SEC        = 30;     // step size during refinement pass
const TERNARY_ITERATIONS     = 40;     // ternary-search precision iterations
const COARSE_STEP_MIN        = 5;      // coarse propagation step (minutes)
const HORIZON_HOURS          = 72;     // look-ahead window
const COARSE_STEPS           = (HORIZON_HOURS * 60) / COARSE_STEP_MIN; // 864
const STALE_EPOCH_DAYS       = 14;
const R_COMBINED_KM          = 0.01;   // combined hard-body radius (km)

// ── Distance function for KD-tree (squared Euclidean, no sqrt needed) ─────

function ecefDist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function euclideanKm(a, b) {
  return Math.sqrt(ecefDist2(a, b));
}

/**
 * Compute scalar distance (km) between two ECEF points at a given timestamp
 * using raw satellite records. Returns Infinity on propagation failure.
 */
function distanceAtTime(sat1, sat2, ts) {
  const d = new Date(ts);
  const p1 = propagateSingle(sat1.tle_line1, sat1.tle_line2, d);
  const p2 = propagateSingle(sat2.tle_line1, sat2.tle_line2, d);
  if (!p1 || !p2) return Infinity;
  return euclideanKm(p1.ecef, p2.ecef);
}

/**
 * Ternary search for minimum distance (TCA) on [lo, hi] (Unix ms).
 * Assumes the distance function is unimodal on the interval.
 */
function ternarySearchTCA(sat1, sat2, lo, hi, iters = TERNARY_ITERATIONS) {
  for (let i = 0; i < iters; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (distanceAtTime(sat1, sat2, m1) < distanceAtTime(sat1, sat2, m2)) {
      hi = m2;
    } else {
      lo = m1;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Compute relative velocity (km/s) between two satellites at a given time.
 */
function relativeVelocity(sat1, sat2, ts) {
  const d = new Date(ts);
  const p1 = propagateSingle(sat1.tle_line1, sat1.tle_line2, d);
  const p2 = propagateSingle(sat2.tle_line1, sat2.tle_line2, d);
  if (!p1 || !p2 || p1.velocityKmS === null || p2.velocityKmS === null) return null;
  // Approximate: ||v1|| + ||v2|| overestimates, but true relative velocity
  // requires vector difference — compute it from ECEF velocity if available.
  // satellite.js propagateSingle returns scalar speed only, so use that approx:
  return Math.abs(p1.velocityKmS - p2.velocityKmS);
}

/**
 * Simplified Foster collision probability.
 * Pc = 1 - exp( -π r² / (2σ²) )
 * where σ = miss_distance / 3 (1-sigma positional uncertainty model)
 */
function collisionProbability(missDistanceKm) {
  if (missDistanceKm <= 0) return 1;
  const sigma = missDistanceKm / 3;
  const r     = R_COMBINED_KM;
  return 1 - Math.exp((-Math.PI * r * r) / (2 * sigma * sigma));
}

// ── Prepared statements ────────────────────────────────────────────────────

const _clearOldConjunctions = db.prepare(
  `DELETE FROM conjunctions WHERE computed_at < datetime(CURRENT_TIMESTAMP, '-73 hours')`
);

const _insertConjunction = db.prepare(`
  INSERT INTO conjunctions
    (sat1_norad, sat2_norad, tca, miss_distance_km, relative_velocity_km_s, probability)
  VALUES
    (@sat1_norad, @sat2_norad, @tca, @miss_distance_km, @relative_velocity_km_s, @probability)
`);

const _insertMany = db.transaction((rows) => rows.forEach((r) => _insertConjunction.run(r)));

// ── Main detection engine ──────────────────────────────────────────────────

/**
 * Run the full conjunction detection pipeline.
 * This is CPU-intensive and should be called from a background job.
 *
 * @returns {{ conjunctionsFound, highRisk, mediumRisk, lowRisk, computedAt }}
 */
async function runCollisionDetection() {
  const startedAt = Date.now();
  console.log('[collision] Starting conjunction detection…');

  // 1. Load satellites with fresh TLEs ───────────────────────────────────
  const cutoff = new Date(Date.now() - STALE_EPOCH_DAYS * 86_400_000).toISOString();
  const sats = db.prepare(
    `SELECT norad_id, name, tle_line1, tle_line2
     FROM satellites
     WHERE updated_at >= ?`
  ).all(cutoff);

  if (sats.length < 2) {
    console.warn('[collision] Not enough fresh satellites to screen.');
    return { conjunctionsFound: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0, computedAt: new Date().toISOString() };
  }

  console.log(`[collision] Screening ${sats.length} satellites over ${HORIZON_HOURS}h…`);

  // 2. Propagate all sats across the horizon in coarse steps ─────────────
  // Layout: stateMatrix[stepIndex] = array of { norad_id, idx, x, y, z }
  // We build each step lazily to keep peak memory reasonable.
  const startDate = new Date();

  // Pre-compute full future state vectors for every satellite
  // Shape: futureStates[satIdx] = [ { timestamp, ecef } × COARSE_STEPS ]
  console.log('[collision] Propagating state vectors…');
  const futureStates = sats.map((sat) =>
    propagateFuture(sat.tle_line1, sat.tle_line2, startDate, COARSE_STEP_MIN, COARSE_STEPS)
  );

  // 3-5. KD-tree screening per timestep ──────────────────────────────────
  const candidatePairs = new Map(); // key: `${minId}-${maxId}` → { sat1, sat2, candidateTsMs }

  console.log('[collision] Running KD-tree screening across timesteps…');

  for (let step = 0; step < COARSE_STEPS; step++) {
    // Gather all positions at this timestep
    const points = [];
    for (let si = 0; si < sats.length; si++) {
      const frame = futureStates[si][step];
      if (!frame) continue;
      points.push({ x: frame.ecef.x, y: frame.ecef.y, z: frame.ecef.z, satIdx: si, ts: frame.timestamp });
    }

    if (points.length < 2) continue;

    const tree = new KDTree(points, ecefDist2, ['x', 'y', 'z']);
    const threshSq = SCREEN_THRESHOLD_KM * SCREEN_THRESHOLD_KM;

    for (const pt of points) {
      // nearest(point, count) — we ask for a generous number of neighbours
      const neighbours = tree.nearest(pt, 16, threshSq);
      for (const [neighbour] of neighbours) {
        if (neighbour.satIdx === pt.satIdx) continue;

        const i1 = Math.min(pt.satIdx, neighbour.satIdx);
        const i2 = Math.max(pt.satIdx, neighbour.satIdx);
        const key = `${i1}-${i2}`;

        if (!candidatePairs.has(key)) {
          candidatePairs.set(key, {
            sat1: sats[i1],
            sat2: sats[i2],
            candidateTsMs: pt.ts,
          });
        }
      }
    }
  }

  console.log(`[collision] ${candidatePairs.size} candidate pairs found — refining…`);

  // 5a-c. Refine each candidate pair ────────────────────────────────────
  const conjunctionRows = [];

  for (const { sat1, sat2, candidateTsMs } of candidatePairs.values()) {
    // Refine window: ±REFINE_WINDOW_MIN around the coarse candidate
    const windowMs  = REFINE_WINDOW_MIN * 60_000;
    const refStepMs = REFINE_STEP_SEC * 1_000;
    const lo = candidateTsMs - windowMs;
    const hi = candidateTsMs + windowMs;

    // Find the approximate minimum in the refined window
    let bestTs   = candidateTsMs;
    let bestDist = distanceAtTime(sat1, sat2, candidateTsMs);

    for (let ts = lo; ts <= hi; ts += refStepMs) {
      const d = distanceAtTime(sat1, sat2, ts);
      if (d < bestDist) { bestDist = d; bestTs = ts; }
    }

    // Ternary search for precise TCA
    const tcaWindowMs = refStepMs * 2;
    const tcaTs  = ternarySearchTCA(sat1, sat2, bestTs - tcaWindowMs, bestTs + tcaWindowMs);
    const tcaDist = distanceAtTime(sat1, sat2, tcaTs);

    if (!Number.isFinite(tcaDist) || tcaDist > SCREEN_THRESHOLD_KM) continue;

    const relV = relativeVelocity(sat1, sat2, tcaTs);
    const pc   = collisionProbability(tcaDist);
    const tca  = new Date(tcaTs).toISOString();

    conjunctionRows.push({
      sat1_norad:              sat1.norad_id,
      sat2_norad:              sat2.norad_id,
      tca,
      miss_distance_km:        tcaDist,
      relative_velocity_km_s:  relV,
      probability:             pc,
    });
  }

  // 6. Persist results ───────────────────────────────────────────────────
  _clearOldConjunctions.run();
  _insertMany(conjunctionRows);

  // 7. Summarise ─────────────────────────────────────────────────────────
  const highRisk   = conjunctionRows.filter((r) => r.probability >  1e-4).length;
  const mediumRisk = conjunctionRows.filter((r) => r.probability >  1e-6 && r.probability <= 1e-4).length;
  const lowRisk    = conjunctionRows.filter((r) => r.probability <= 1e-6).length;
  const computedAt = new Date().toISOString();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[collision] Done in ${elapsed}s — ${conjunctionRows.length} conjunctions ` +
    `(high: ${highRisk}, medium: ${mediumRisk}, low: ${lowRisk})`
  );

  return { conjunctionsFound: conjunctionRows.length, highRisk, mediumRisk, lowRisk, computedAt };
}

// ── Query helper ───────────────────────────────────────────────────────────

/**
 * Return active conjunctions within the next `hoursAhead` hours,
 * joined with satellite names, ordered by miss distance ascending.
 *
 * @param {number} hoursAhead
 */
function getActiveConjunctions(hoursAhead = 72) {
  return getConjunctions(hoursAhead);
}

// ── Background job state ───────────────────────────────────────────────────

let _running = false;
let _lastResult = null;

/**
 * Fire-and-forget wrapper — safe to call from the scheduler.
 * Prevents concurrent runs; stores the last result for the API to read.
 */
async function runCollisionDetectionBackground() {
  if (_running) {
    console.log('[collision] Already running — skipping this trigger.');
    return;
  }
  _running = true;
  try {
    _lastResult = await runCollisionDetection();
  } catch (err) {
    console.error('[collision] Detection run failed:', err);
  } finally {
    _running = false;
  }
}

function getLastResult() {
  return _lastResult;
}

module.exports = {
  runCollisionDetection,
  runCollisionDetectionBackground,
  getActiveConjunctions,
  getLastResult,
};
