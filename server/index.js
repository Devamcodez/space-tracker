require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express  = require('express');
const cors     = require('cors');

const { db, getSatellites, getConjunctions } = require('./db');
const { propagateAll, generateOrbitTrail, propagateSingle } = require('./propagator');
const satLib = require('satellite.js');
const { getActiveConjunctions, getLastResult, runCollisionDetectionBackground } = require('./collision');
const { fetchAll }                 = require('./fetcher');
const { computeAllDangerScores }   = require('./scorer');
const { runStartup }               = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'] }));
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`[api] ${req.method} ${req.path}${Object.keys(req.query).length ? ' ' + JSON.stringify(req.query) : ''}`);
  next();
});

// ── Mission path generator ──────────────────────────────────────────────────
// Produces a simplified Keplerian orbit path (circular orbit, no perturbations).
// Earth rotation is accounted for so ground-track drifts westward correctly.

function generateMissionPath(launchLat, launchLon, launchTimeMs, altKm, inclDeg, durationSec) {
  const GM          = 398600.4418; // km³/s²
  const earthR      = 6371;        // km
  const earthOmega  = 7.2921150e-5; // rad/s
  const r           = earthR + altKm;
  const periodSec   = 2 * Math.PI * Math.sqrt((r * r * r) / GM);
  const orbOmega    = 2 * Math.PI / periodSec; // rad/s
  const incRad      = inclDeg * Math.PI / 180;
  const latRad      = launchLat * Math.PI / 180;
  const raan        = launchLon * Math.PI / 180;

  // Argument of latitude at launch: sin(u₀) = sin(lat) / sin(inc)
  let u0 = 0;
  if (Math.abs(Math.sin(incRad)) > 0.01) {
    const sinU = Math.max(-1, Math.min(1, Math.sin(latRad) / Math.sin(incRad)));
    u0 = Math.asin(sinU);
  }

  const steps = 200;
  const stepSec = durationSec / steps;
  const points = [];

  for (let i = 0; i <= steps; i++) {
    const t    = i * stepSec;
    const u    = u0 + orbOmega * t;
    const cosU = Math.cos(u), sinU = Math.sin(u);
    const cosR = Math.cos(raan), sinR = Math.sin(raan);
    const cosI = Math.cos(incRad), sinI = Math.sin(incRad);

    // ECI → ECEF (rotate by Earth spin)
    const xECI = r * (cosR * cosU - sinR * cosI * sinU);
    const yECI = r * (sinR * cosU + cosR * cosI * sinU);
    const zECI = r * sinI * sinU;
    const theta = earthOmega * t;
    const xECEF = xECI * Math.cos(theta) + yECI * Math.sin(theta);
    const yECEF = -xECI * Math.sin(theta) + yECI * Math.cos(theta);

    const lat = Math.atan2(zECI, Math.sqrt(xECEF * xECEF + yECEF * yECEF)) * 180 / Math.PI;
    const lon = Math.atan2(yECEF, xECEF) * 180 / Math.PI;
    points.push({
      lat: parseFloat(lat.toFixed(3)),
      lon: parseFloat(lon.toFixed(3)),
      altKm: parseFloat(altKm.toFixed(1)),
      timestamp: new Date(launchTimeMs + t * 1000).toISOString(),
    });
  }
  return points;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseIntParam(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatParam(val, fallback) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Merge propagated positions (lat/lon/alt/velocity) into a satellite array.
 * Satellites with no current position are still returned (position: null).
 */
function mergePositions(sats, positions) {
  const posMap = new Map(positions.map((p) => [p.norad_id, p]));
  return sats.map((sat) => {
    const pos = posMap.get(sat.norad_id);
    return {
      ...sat,
      position: pos
        ? { lat: pos.lat, lon: pos.lon, altKm: pos.altKm, velocityKmS: pos.velocityKmS }
        : null,
    };
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// GET /api/stats
app.get('/api/stats', (_req, res) => {
  const counts = db.prepare(`
    SELECT
      COUNT(*)                       AS totalObjects,
      SUM(category = 'debris')       AS debris,
      SUM(category = 'rocket-body')  AS rocketBodies,
      MAX(updated_at)                AS lastTleUpdate
    FROM satellites
    WHERE category IN ('debris', 'rocket-body')
  `).get();

  const conjStats = db.prepare(`
    SELECT
      COUNT(*)                              AS conjunctionCount,
      SUM(probability > 1e-4)              AS highRiskCount,
      SUM(probability > 1e-6 AND probability <= 1e-4) AS mediumRiskCount
    FROM conjunctions
    WHERE tca > CURRENT_TIMESTAMP
  `).get();

  res.json({ ...counts, ...conjStats });
});

// GET /api/satellites
app.get('/api/satellites', (req, res) => {
  const { category, country, search } = req.query;
  const limit  = parseIntParam(req.query.limit,  5000);
  const offset = parseIntParam(req.query.offset, 0);
  const minAlt = parseFloatParam(req.query.minAlt, null);
  const maxAlt = parseFloatParam(req.query.maxAlt, null);

  // Fetch from DB
  let sats = getSatellites({ category, country, search, limit: limit + offset });

  // Apply offset manually (getSatellites doesn't support it yet)
  if (offset > 0) sats = sats.slice(offset);
  sats = sats.slice(0, limit);

  // Propagate current positions
  const now       = new Date();
  const positions = propagateAll(sats, now);
  let merged      = mergePositions(sats, positions);

  // Altitude filter (applied after propagation)
  if (minAlt !== null) merged = merged.filter((s) => s.position && s.position.altKm >= minAlt);
  if (maxAlt !== null) merged = merged.filter((s) => s.position && s.position.altKm <= maxAlt);

  console.log(`[api] /api/satellites → ${merged.length} satellites (db had ${sats.length} before propagation filter)`);
  res.json({ satellites: merged, total: merged.length, computedAt: now.toISOString() });
});

// GET /api/satellites/:noradId
app.get('/api/satellites/:noradId', (req, res) => {
  const noradId = parseInt(req.params.noradId, 10);
  if (!Number.isFinite(noradId)) return res.status(400).json({ error: 'Invalid NORAD ID' });

  const sat = db.prepare('SELECT * FROM satellites WHERE norad_id = ?').get(noradId);
  if (!sat) return res.status(404).json({ error: 'Satellite not found' });

  // Current position
  const now      = new Date();
  const position = propagateAll([sat], now)[0] ?? null;

  // Orbit trail (64-point ground track)
  const orbitTrail = generateOrbitTrail(sat.tle_line1, sat.tle_line2, 64);

  // Upcoming conjunctions involving this object
  const conjunctions = db.prepare(`
    SELECT c.*, s1.name AS sat1_name, s2.name AS sat2_name
    FROM conjunctions c
    LEFT JOIN satellites s1 ON s1.norad_id = c.sat1_norad
    LEFT JOIN satellites s2 ON s2.norad_id = c.sat2_norad
    WHERE (c.sat1_norad = ? OR c.sat2_norad = ?)
      AND c.tca > CURRENT_TIMESTAMP
    ORDER BY c.tca ASC
    LIMIT 20
  `).all(noradId, noradId);

  res.json({
    ...sat,
    position: position
      ? { lat: position.lat, lon: position.lon, altKm: position.altKm, velocityKmS: position.velocityKmS }
      : null,
    orbitTrail,
    conjunctions,
    computedAt: now.toISOString(),
  });
});

// GET /api/conjunctions
app.get('/api/conjunctions', (req, res) => {
  const hoursAhead     = parseIntParam(req.query.hoursAhead, 72);
  const minProbability = parseFloatParam(req.query.minProbability, 0);
  const limit          = parseIntParam(req.query.limit, 200);

  let results = getActiveConjunctions(hoursAhead);

  if (minProbability > 0) {
    results = results.filter((c) => (c.probability ?? 0) >= minProbability);
  }

  // Sort by probability descending
  results.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  results = results.slice(0, limit);

  res.json({ conjunctions: results, total: results.length });
});

// POST /api/refresh  — manual admin trigger
app.post('/api/refresh', async (_req, res) => {
  // Respond immediately; fetch runs in background
  res.json({ status: 'refresh_started', startedAt: new Date().toISOString() });

  try {
    const summary = await fetchAll();
    console.log('[api] Manual refresh complete:', summary);
    // Kick off collision detection after TLE update
    await runCollisionDetectionBackground();
  } catch (err) {
    console.error('[api] Manual refresh failed:', err.message);
  }
});

// GET /api/danger-stats
app.get('/api/danger-stats', (_req, res) => {
  const row = db.prepare(`
    SELECT
      COUNT(*)                                               AS totalDebris,
      SUM(danger_score > 0)                                  AS scored,
      SUM(danger_score IS NULL OR danger_score = 0)          AS unscored,
      AVG(CASE WHEN danger_score > 0 THEN danger_score END)  AS avgScore,
      SUM(danger_score >= 80)                                AS critical,
      SUM(danger_score >= 60 AND danger_score < 80)          AS high,
      SUM(danger_score >= 40 AND danger_score < 60)          AS medium,
      SUM(danger_score >= 20 AND danger_score < 40)          AS low,
      SUM(danger_score < 20 AND danger_score > 0)            AS minimal,
      MAX(updated_at)                                        AS lastComputed
    FROM satellites
    WHERE category IN ('debris', 'rocket-body')
  `).get();

  const top10 = db.prepare(`
    SELECT norad_id, name, danger_score, category
    FROM satellites
    WHERE category IN ('debris', 'rocket-body') AND danger_score > 0
    ORDER BY danger_score DESC
    LIMIT 10
  `).all();

  res.json({
    totalDebris:  row.totalDebris,
    scored:       row.scored,
    unscored:     row.unscored,
    distribution: {
      critical: row.critical,
      high:     row.high,
      medium:   row.medium,
      low:      row.low,
      minimal:  row.minimal,
    },
    top10,
    avgScore:     row.avgScore ? parseFloat(row.avgScore.toFixed(1)) : null,
    lastComputed: row.lastComputed,
  });
});

// POST /api/compute-danger-scores — trigger a full recomputation (responds immediately, runs async)
app.post('/api/compute-danger-scores', async (_req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const result = await computeAllDangerScores();
    res.json({ status: 'complete', startedAt, ...result });
  } catch (err) {
    console.error('[api] Danger score computation failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/optimize-path  — compute debris cleanup mission from a launch site
app.post('/api/optimize-path', (req, res) => {
  const launchLat = parseFloat(req.body.launchLat);
  const launchLon = parseFloat(req.body.launchLon);
  if (!Number.isFinite(launchLat) || !Number.isFinite(launchLon)) {
    return res.status(400).json({ error: 'Invalid launch coordinates' });
  }
  const launchTime = req.body.launchTime
    ? new Date(req.body.launchTime)
    : new Date(Date.now() + 2 * 3600_000);

  // 1. Fetch medium-to-critical candidates from DB
  const candidates = db.prepare(`
    SELECT norad_id, name, danger_score, tle_line1, tle_line2, category
    FROM satellites
    WHERE category IN ('debris', 'rocket-body') AND danger_score >= 40
    ORDER BY danger_score DESC
    LIMIT 200
  `).all();

  // 2. Extract orbital elements directly from TLE (no propagation needed)
  const GM = 398600.4418, earthR = 6371;
  const withOrbit = candidates.map((c) => {
    try {
      const sr = satLib.twoline2satrec(c.tle_line1, c.tle_line2);
      const inclinationDeg = sr.inclo * (180 / Math.PI);
      const noRadPerSec    = sr.no / 60;
      const sma            = Math.cbrt(GM / (noRadPerSec * noRadPerSec));
      return { ...c, inclination: inclinationDeg, altKm: Math.max(0, sma - earthR) };
    } catch { return null; }
  }).filter(Boolean);

  // 3. Filter by launch-site reachability
  const latAbs = Math.abs(launchLat);
  let accessible = withOrbit.filter((c) =>
    c.altKm >= 300 && c.altKm <= 1500 &&
    c.inclination >= latAbs - 3 &&
    c.inclination <= latAbs + 32
  );
  // Fallback: loosen altitude constraint if too few candidates
  if (accessible.length < 5) {
    accessible = withOrbit
      .filter((c) => c.altKm >= 200 && c.altKm <= 2000)
      .sort((a, b) => b.danger_score - a.danger_score)
      .slice(0, 50);
  }

  // 4. Score by danger × accessibility, select top 7
  const scored = accessible.map((c) => {
    const inclPenalty  = Math.max(0, (c.inclination - (latAbs + 10)) / 35);
    const altOptimality = 1 - Math.abs(c.altKm - 750) / 900;
    return { ...c, _rank: c.danger_score * (1 - inclPenalty * 0.4) * Math.max(0.3, altOptimality) };
  }).sort((a, b) => b._rank - a._rank).slice(0, 7);

  if (scored.length === 0) {
    return res.status(422).json({ error: 'No accessible debris targets from this launch site' });
  }

  const avgAlt = scored.reduce((s, t) => s + t.altKm, 0) / scored.length;
  const avgInc = scored.reduce((s, t) => s + t.inclination, 0) / scored.length;

  // 5. Launch azimuth
  let launchAzimuth = 90;
  try {
    const val = Math.cos(avgInc * Math.PI / 180) / Math.cos(launchLat * Math.PI / 180);
    if (Math.abs(val) <= 1) launchAzimuth = parseFloat((Math.acos(val) * 180 / Math.PI).toFixed(1));
  } catch {}

  // 6. Delta-v budget (simplified Hohmann + inclination cost)
  let totalDeltaV = 9400; // m/s baseline to reach 300 km staging orbit
  const maneuverDvs = scored.map((t, i) => {
    const prevAlt = i === 0 ? 300 : scored[i - 1].altKm;
    const v1 = Math.sqrt(GM / (earthR + prevAlt)) * 1000;
    const v2 = Math.sqrt(GM / (earthR + t.altKm)) * 1000;
    const inclCost = i === 0 ? 0 : Math.abs(t.inclination - scored[i - 1].inclination) * 25;
    const dv = Math.abs(v2 - v1) + inclCost;
    totalDeltaV += dv;
    return Math.round(dv);
  });

  const missionDurationHours = scored.length * 1.5;

  // 7. Build intercept entries with SGP4 positions at intercept time
  const interceptTargets = scored.map((t, i) => {
    const interceptTime = new Date(launchTime.getTime() + (i + 1) * 90 * 60_000);
    const pos = propagateSingle(t.tle_line1, t.tle_line2, interceptTime);
    return {
      sequence:      i + 1,
      norad_id:      t.norad_id,
      name:          t.name,
      danger_score:  t.danger_score,
      altKm:         Math.round(t.altKm),
      inclination:   parseFloat(t.inclination.toFixed(1)),
      lat:           pos ? parseFloat(pos.lat.toFixed(4)) : null,
      lon:           pos ? parseFloat(pos.lon.toFixed(4)) : null,
      interceptTime: interceptTime.toISOString(),
      deltaV:        maneuverDvs[i],
      category:      t.category,
    };
  });

  // 8. Generate spacecraft path
  const path = generateMissionPath(
    launchLat, launchLon, launchTime.getTime(),
    avgAlt, avgInc, missionDurationHours * 3600
  );

  console.log(
    `[api] /api/optimize-path → launch (${launchLat.toFixed(2)}, ${launchLon.toFixed(2)})`
    + ` · ${interceptTargets.length} targets · ΔV=${Math.round(totalDeltaV).toLocaleString()} m/s`
  );

  res.json({
    launchSite:   { lat: launchLat, lon: launchLon },
    launchTime:   launchTime.toISOString(),
    launchAzimuth,
    targetOrbit:  { altKm: Math.round(avgAlt), inclination: parseFloat(avgInc.toFixed(1)) },
    targets:      interceptTargets,
    stats: {
      totalTargets:        interceptTargets.length,
      totalDangerRemoved:  interceptTargets.reduce((s, t) => s + t.danger_score, 0),
      totalDeltaV:         Math.round(totalDeltaV),
      missionDurationHours: parseFloat(missionDurationHours.toFixed(1)),
    },
    path,
  });
});

// GET /api/collision-status  — last detection run result
app.get('/api/collision-status', (_req, res) => {
  const result = getLastResult();
  if (!result) return res.json({ status: 'no_run_yet' });
  res.json({ status: 'ok', ...result });
});

// ── Error handler ──────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[api] Server listening on port ${PORT}`);

  // ── Startup DB diagnostics ─────────────────────────────────────────────
  const satCount = db.prepare('SELECT COUNT(*) AS n FROM satellites').get().n;
  console.log(`[startup] Satellites currently in DB: ${satCount}`);

  const fetchLog = db.prepare(
    'SELECT source, count, success, fetched_at FROM tle_fetch_log ORDER BY fetched_at DESC LIMIT 10'
  ).all();
  if (fetchLog.length) {
    console.log('[startup] Recent tle_fetch_log:');
    fetchLog.forEach((r) =>
      console.log(`  ${r.fetched_at}  ${r.source.padEnd(20)}  count=${r.count}  ok=${r.success}`)
    );
  } else {
    console.log('[startup] tle_fetch_log is empty — no fetches have run yet');
  }

  runStartup();
});
