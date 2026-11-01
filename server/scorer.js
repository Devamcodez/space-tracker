const satellite = require('satellite.js');
const { db } = require('./db');

// ── Scoring formula (0–100) ─────────────────────────────────────────────────
//
//   altitude  : 0–40 pts  — how operationally critical is this orbital zone?
//   velocity  : 0–15 pts  — kinetic energy on impact (v²)
//   density   : 0–30 pts  — how many other debris share the same orbital shell?
//   conjunction: 0–15 pts — CDM-backed collision probability
//
//   Max without CDM data: 40 + 15 + 30 = 85 (critical territory)
//   Max with CDM data:    40 + 15 + 30 + 15 = 100

// ── Component functions ─────────────────────────────────────────────────────

function altScore(altKm) {
  if (!Number.isFinite(altKm) || altKm < 0) return 0;
  if (altKm < 200)   return 8;  // decaying — brief residual threat
  if (altKm < 600)   return 40; // ISS zone and crewed mission band
  if (altKm < 1000)  return 35; // sun-synchronous / earth-obs belt
  if (altKm < 2000)  return 25; // upper LEO
  if (altKm < 35000) return 10; // MEO — sparse
  if (altKm < 36500) return 15; // GEO belt — economically critical
  return 5;
}

function velScore(velocityKmS) {
  if (!Number.isFinite(velocityKmS)) return 0;
  if (velocityKmS >= 7.5) return 15;
  if (velocityKmS >= 6.0) return 12;
  if (velocityKmS >= 3.0) return 8;
  return 4;
}

/**
 * Orbital shell density: count of other tracked debris within ±50 km of this
 * object's altitude, using a pre-sorted altitude array and binary search.
 * A crowded shell is exponentially more collision-prone (Kessler cascade risk).
 */
function densityScore(altKm, sortedAlts) {
  if (!Number.isFinite(altKm)) return 0;
  const lo = altKm - 50;
  const hi = altKm + 50;
  const leftIdx  = lowerBound(sortedAlts, lo);
  const rightIdx = upperBound(sortedAlts, hi);
  const count = rightIdx - leftIdx - 1; // subtract 1 to exclude self

  if (count >= 1200) return 30;
  if (count >= 800)  return 25;
  if (count >= 500)  return 20;
  if (count >= 300)  return 15;
  if (count >= 150)  return 10;
  if (count >= 50)   return 5;
  return 0;
}

function lowerBound(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < val) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] <= val) lo = mid + 1; else hi = mid; }
  return lo;
}

function conjScore(noradId, conjMap) {
  const conjs = conjMap.get(noradId) ?? [];
  if (!conjs.length) return 0;
  const maxProb = Math.max(...conjs.map((c) => c.probability ?? 0));
  if (maxProb >= 1e-4) return 15;
  if (maxProb >= 1e-5) return 10;
  if (maxProb >= 1e-6) return 5;
  return 2;
}

// ── Main computation ────────────────────────────────────────────────────────

async function computeAllDangerScores() {
  console.log('[scorer] Starting danger score computation…');
  console.log('[scorer] Formula: alt(0-40) + vel(0-15) + density(0-30) + conjunction(0-15) = 100 max');
  const startMs = Date.now();

  // Load all tracked objects
  const rows = db.prepare(`
    SELECT norad_id, name, tle_line1, tle_line2, category
    FROM satellites WHERE category IN ('debris', 'rocket-body')
  `).all();
  console.log(`[scorer] Loaded ${rows.length} objects`);

  // Build conjunction map: norad_id → [{probability, miss_distance_km}]
  const conjRows = db.prepare(`
    SELECT sat1_norad, sat2_norad, probability, miss_distance_km
    FROM conjunctions WHERE tca > CURRENT_TIMESTAMP
  `).all();
  const conjMap = new Map();
  for (const c of conjRows) {
    for (const norad of [c.sat1_norad, c.sat2_norad]) {
      if (!conjMap.has(norad)) conjMap.set(norad, []);
      conjMap.get(norad).push(c);
    }
  }
  console.log(`[scorer] ${conjRows.length} active conjunctions across ${conjMap.size} objects`);

  // ── Pass 1: propagate all objects to get current position ────────────────
  const now = new Date();
  const posMap = new Map(); // norad_id → { altKm, velocityKmS }
  let propagated = 0;
  let unpropagatable = 0;

  for (const row of rows) {
    try {
      const satrec = satellite.twoline2satrec(row.tle_line1, row.tle_line2);
      const pv = satellite.propagate(satrec, now);
      if (pv?.position) {
        const gmst = satellite.gstime(now);
        const geo  = satellite.eciToGeodetic(pv.position, gmst);
        const altKm = geo.height;
        let velocityKmS = null;
        if (pv.velocity) {
          const { x: vx, y: vy, z: vz } = pv.velocity;
          velocityKmS = Math.sqrt(vx * vx + vy * vy + vz * vz);
        }
        if (Number.isFinite(altKm) && altKm > -100) {
          posMap.set(row.norad_id, { altKm, velocityKmS });
          propagated++;
        }
      }
    } catch { /* skip invalid TLE */ }
    if (!posMap.has(row.norad_id)) unpropagatable++;
  }
  console.log(`[scorer] Propagated ${propagated} / ${rows.length} objects (${unpropagatable} unpropagatable)`);

  // ── Build sorted altitude array for density lookups ──────────────────────
  const sortedAlts = [...posMap.values()]
    .map((p) => p.altKm)
    .sort((a, b) => a - b);

  // Log altitude shell breakdown to show where debris concentrates
  const shellCounts = [
    [200, 400], [400, 600], [600, 800], [800, 1000],
    [1000, 1200], [1200, 2000], [2000, 36000],
  ];
  console.log('[scorer] Altitude shell population:');
  for (const [lo, hi] of shellCounts) {
    const cnt = sortedAlts.filter((a) => a >= lo && a < hi).length;
    console.log(`  ${lo.toString().padStart(5)}-${hi.toString().padEnd(6)} km : ${cnt.toLocaleString()}`);
  }

  // ── Pass 2: score every object ───────────────────────────────────────────
  const updates = [];
  const debugEntries = []; // collect full breakdowns for logging top 10

  for (const row of rows) {
    const pos = posMap.get(row.norad_id) ?? null;
    const a = altScore(pos?.altKm ?? null);
    const v = velScore(pos?.velocityKmS ?? null);
    const d = pos ? densityScore(pos.altKm, sortedAlts) : 0;
    const c = conjScore(row.norad_id, conjMap);
    const total = Math.min(100, Math.round(a + v + d + c));

    updates.push({ norad_id: row.norad_id, danger_score: total });
    debugEntries.push({
      norad_id: row.norad_id,
      name:     row.name,
      altKm:    pos?.altKm ?? null,
      velKmS:   pos?.velocityKmS ?? null,
      a, v, d, c, total,
    });
  }

  // ── Log breakdown for top 10 highest-scoring objects ────────────────────
  debugEntries.sort((x, y) => y.total - x.total);
  console.log('\n[scorer] Top 10 highest-scoring debris — component breakdown:');
  console.log('  NORAD    Score  Alt(km)  alt  vel  den  con  Name');
  console.log('  ──────── ─────  ───────  ───  ───  ───  ───  ────────────────────');
  for (const e of debugEntries.slice(0, 10)) {
    const alt = e.altKm != null ? e.altKm.toFixed(0).padStart(7) : '    N/A';
    console.log(
      `  ${e.norad_id.toString().padStart(8)}  ${e.total.toString().padStart(3)}`
      + `  ${alt}  ${e.a.toString().padStart(3)}  ${e.v.toString().padStart(3)}`
      + `  ${e.d.toString().padStart(3)}  ${e.c.toString().padStart(3)}  ${e.name}`
    );
  }

  // ── Write back in a single transaction ───────────────────────────────────
  const stmt = db.prepare('UPDATE satellites SET danger_score = @danger_score WHERE norad_id = @norad_id');
  db.transaction((rows) => rows.forEach((r) => stmt.run(r)))(updates);

  // ── Summary ───────────────────────────────────────────────────────────────
  const scores   = updates.map((u) => u.danger_score);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const maxScore = Math.max(...scores);
  const elapsed  = ((Date.now() - startMs) / 1000).toFixed(1);

  const dist = {
    critical: scores.filter((s) => s >= 80).length,
    high:     scores.filter((s) => s >= 60 && s < 80).length,
    medium:   scores.filter((s) => s >= 40 && s < 60).length,
    low:      scores.filter((s) => s >= 20 && s < 40).length,
    minimal:  scores.filter((s) => s < 20).length,
  };

  console.log(`\n[scorer] ✓ Danger scores computed in ${elapsed}s`);
  console.log(`  Objects processed  : ${rows.length.toLocaleString()}`);
  console.log(`  Propagated OK      : ${propagated.toLocaleString()}`);
  console.log(`  Unpropagatable     : ${unpropagatable}`);
  console.log(`  Avg score          : ${avgScore.toFixed(1)}`);
  console.log(`  Max score          : ${maxScore}`);
  console.log(`  Critical  (>=80)   : ${dist.critical.toLocaleString()}`);
  console.log(`  High      (60-79)  : ${dist.high.toLocaleString()}`);
  console.log(`  Medium    (40-59)  : ${dist.medium.toLocaleString()}`);
  console.log(`  Low       (20-39)  : ${dist.low.toLocaleString()}`);
  console.log(`  Minimal   (<20)    : ${dist.minimal.toLocaleString()}`);

  return {
    processed:    rows.length,
    propagated,
    unpropagatable,
    avgScore:     parseFloat(avgScore.toFixed(1)),
    maxScore,
    distribution: dist,
    elapsedSec:   parseFloat(elapsed),
  };
}

module.exports = { computeAllDangerScores };
