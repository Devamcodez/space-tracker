require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const https = require('https');
const axios = require('axios');
const { insertOrUpdateSatellites, getConjunctions, logFetch, db } = require('./db');

// ── Constants ──────────────────────────────────────────────────────────────

const CELESTRAK_BASE = 'https://celestrak.org/cgi-bin/TLE.cgi';

// Debris-only sources — major fragmentation events from CelesTrak
const CELESTRAK_SOURCES = [
  { url: `${CELESTRAK_BASE}?GROUP=cosmos-1408-debris&FORMAT=TLE`, category: 'debris' },
  { url: `${CELESTRAK_BASE}?GROUP=fengyun-1c-debris&FORMAT=TLE`,  category: 'debris' },
  { url: `${CELESTRAK_BASE}?GROUP=iridium-33-debris&FORMAT=TLE`,  category: 'debris' },
  { url: `${CELESTRAK_BASE}?GROUP=cosmos-2251-debris&FORMAT=TLE`, category: 'debris' },
];

const SPACETRACK_BASE   = 'https://www.space-track.org';
const SPACETRACK_LOGIN  = `${SPACETRACK_BASE}/ajaxauth/login`;
const SPACETRACK_GP_JSON = `${SPACETRACK_BASE}/basicspacedata/query/class/gp/EPOCH/%3Enow-30/orderby/NORAD_CAT_ID/format/json`;
const SPACETRACK_CDM    = `${SPACETRACK_BASE}/basicspacedata/query/class/cdm_public/limit/1000/format/json`;

const RETRY_ATTEMPTS    = 3;
const SPACETRACK_DELAY  = 2000; // ms between Space-Track requests

// Browser-like headers — CelesTrak's WAF blocks requests without these
const DEFAULT_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/plain, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Referer':         'https://celestrak.org/',
};

// ── Utilities ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a URL with exponential backoff on failure.
 * @param {import('axios').AxiosRequestConfig} config
 * @param {number} attempts
 */
async function fetchWithRetry(config, attempts = RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios({
        timeout: 30_000,
        ...config,
        headers: { ...DEFAULT_HEADERS, ...config.headers },
      });
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? 'no-response';
      // Don't retry client errors or timeouts — they won't get better with retries
      if (status === 403 || status === 401 || status === 404) {
        console.warn(`[fetcher] HTTP ${status} for ${config.url ?? config.baseURL} — not retrying`);
        throw lastErr;
      }
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
        console.warn(`[fetcher] Timeout for ${config.url ?? config.baseURL} — not retrying`);
        throw lastErr;
      }
      const wait = 1000 * 2 ** i;
      console.warn(
        `[fetcher] attempt ${i + 1}/${attempts} failed for ${config.url ?? config.baseURL}` +
        ` — HTTP ${status}: ${err.message}. Retrying in ${wait}ms…`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Parse a raw TLE text body (3-line format) into an array of satellite objects.
 * Name line may be blank — falls back to "Unknown".
 * @param {string} text
 * @param {string} defaultCategory
 * @returns {{ norad_id: number, name: string, tle_line1: string, tle_line2: string, category: string }[]}
 */
function parseTLE(text, defaultCategory) {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  const satellites = [];
  let i = 0;

  while (i < lines.length) {
    // Detect whether the current line is a name line or TLE line-1
    const isLine1 = (l) => l.startsWith('1 ') && l.length >= 69;
    const isLine2 = (l) => l.startsWith('2 ') && l.length >= 69;

    let name, line1, line2;

    if (isLine1(lines[i])) {
      // 2-line format (no name line)
      name  = 'Unknown';
      line1 = lines[i];
      line2 = lines[i + 1];
      i += 2;
    } else {
      // 3-line format
      name  = lines[i].trim() || 'Unknown';
      line1 = lines[i + 1];
      line2 = lines[i + 2];
      i += 3;
    }

    if (!line1 || !line2 || !isLine1(line1) || !isLine2(line2)) continue;

    // NORAD ID is characters 2-6 (0-indexed) of TLE line 1
    const norad_id = parseInt(line1.substring(2, 7).trim(), 10);
    if (!Number.isFinite(norad_id)) continue;

    satellites.push({ norad_id, name, tle_line1: line1, tle_line2: line2, category: defaultCategory });
  }

  return satellites;
}

/**
 * Classify a satellite into an internal category string using its name and
 * Space-Track OBJECT_TYPE. Name-based rules take precedence for known
 * constellations so Starlink, GPS, weather sats etc. get distinct categories.
 * @param {string} name
 * @param {string} objectType  — PAYLOAD | ROCKET BODY | DEBRIS | TBA | UNKNOWN
 */
function classifySatellite(name, objectType) {
  const t = (objectType ?? '').toUpperCase();
  if (t === 'DEBRIS')      return 'debris';
  if (t === 'ROCKET BODY') return 'rocket-body';

  const n = (name ?? '').toUpperCase();
  if (n.startsWith('STARLINK'))              return 'starlink';
  if (n.startsWith('ONEWEB'))               return 'constellation';
  if (n.startsWith('IRIDIUM'))              return 'constellation';
  if (n.startsWith('GPS') || n.startsWith('NAVSTAR'))  return 'navigation';
  if (n.startsWith('GLONASS') || n.startsWith('COSMOS 2') && n.includes('GLONASS')) return 'navigation';
  if (n.startsWith('GALILEO'))              return 'navigation';
  if (n.startsWith('BEIDOU'))               return 'navigation';
  if (n.startsWith('NOAA') || n.startsWith('GOES') || n.startsWith('METOP') ||
      n.startsWith('METEOR') || n.startsWith('FENGYUN') || n.startsWith('HIMAWARI')) return 'weather';
  if (n.includes('ISS (ZARYA)') || n.includes('CSS (TIANHE)') || n.includes('TIANHE') ||
      n.includes('TIANGONG')    || n.includes('SHENZHOU'))    return 'crewed';

  return t === 'PAYLOAD' ? 'active' : 'unknown';
}

// ── Prepared statement for CDM upsert ─────────────────────────────────────

const _upsertCdm = db.prepare(`
  INSERT INTO conjunctions (sat1_norad, sat2_norad, tca, miss_distance_km, relative_velocity_km_s, probability)
  VALUES (@sat1_norad, @sat2_norad, @tca, @miss_distance_km, @relative_velocity_km_s, @probability)
`);

const _insertCdms = db.transaction((rows) => rows.forEach((r) => _upsertCdm.run(r)));

// ── CelesTrak diagnostic probe ────────────────────────────────────────────
// Uses Node's native https module (bypasses axios entirely) so we can see
// the raw HTTP response and rule out axios header/agent issues.

function probeCelesTrak() {
  return new Promise((resolve) => {
    const TEST_URL = 'https://celestrak.org/cgi-bin/TLE.cgi?GROUP=stations&FORMAT=TLE';
    console.log(`[diag] Probing ${TEST_URL} via native https…`);

    const req = https.get(
      TEST_URL,
      {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept':          'text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         'https://celestrak.org/',
        },
        timeout: 20_000,
      },
      (res) => {
        console.log(`[diag] HTTP ${res.statusCode} — headers: ${JSON.stringify(res.headers)}`);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 500) res.destroy(); });
        res.on('close', () => {
          const preview = body.slice(0, 500).replace(/\n/g, '↵');
          console.log(`[diag] Body preview: ${preview}`);
          resolve(res.statusCode);
        });
      }
    );
    req.on('error', (err) => {
      console.error(`[diag] Request error: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => {
      console.error('[diag] Request timed out');
      req.destroy();
      resolve(null);
    });
  });
}

// ── Fetcher: CelesTrak ─────────────────────────────────────────────────────

async function fetchCelesTrak() {
  let total = 0;
  let failures = 0;

  for (const { url, category } of CELESTRAK_SOURCES) {
    try {
      const res = await fetchWithRetry({ method: 'GET', url, responseType: 'text', timeout: 8_000 });
      const sats = parseTLE(res.data, category); // all parsed with category='debris'
      insertOrUpdateSatellites(sats);
      total += sats.length;
      const group = new URL(url).searchParams.get('GROUP') ?? url;
      console.log(`[celestrak] ${group} → ${sats.length} debris objects`);
    } catch (err) {
      failures++;
      console.error(`[celestrak] Failed to fetch ${url}: ${err.message}`);
    }
    // Polite delay between CelesTrak requests to avoid rate-limiting
    await sleep(800);
  }

  console.log(`[celestrak] Done — ${total} debris objects fetched, ${failures}/${CELESTRAK_SOURCES.length} groups failed`);
  return total;
}

// ── Fetcher: Space-Track ───────────────────────────────────────────────────

async function fetchSpaceTrack() {
  const user = process.env.SPACETRACK_USER;
  const pass = process.env.SPACETRACK_PASS;

  if (!user || !pass) {
    console.warn('[space-track] SPACETRACK_USER / SPACETRACK_PASS not set — skipping. Check that .env in workspace root has real credentials.');
    return { sats: 0, cdms: 0 };
  }
  const isPlaceholder = user.includes('example.com') || pass.includes('your_') || pass === 'your_password_here';
  if (isPlaceholder) {
    console.warn(`[space-track] Credentials look like placeholders (user=${user}) — update .env with real Space-Track credentials`);
    return { sats: 0, cdms: 0 };
  }
  console.log(`[space-track] Using credentials for ${user}`);

  // ── Authenticate ──
  // Node.js axios does NOT automatically persist cookies between requests.
  // Extract the Set-Cookie header from the login response and forward it manually.
  let sessionCookie = '';
  try {
    const loginRes = await fetchWithRetry({
      method: 'POST',
      url: SPACETRACK_LOGIN,
      data: new URLSearchParams({ identity: user, password: pass }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const setCookie = loginRes.headers['set-cookie'];
    if (setCookie?.length) {
      sessionCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      console.log('[space-track] Authenticated — session cookie acquired');
    } else {
      console.warn('[space-track] Login succeeded but no Set-Cookie header found');
    }
  } catch (err) {
    console.error(`[space-track] Login failed: ${err.message}`);
    return { sats: 0, cdms: 0 };
  }

  await sleep(SPACETRACK_DELAY);

  // ── Fetch GP data (JSON — includes OBJECT_TYPE, COUNTRY_CODE, LAUNCH_DATE) ──
  let satCount = 0;
  try {
    const gpRes = await fetchWithRetry({
      method: 'GET',
      url: SPACETRACK_GP_JSON,
      headers: { Cookie: sessionCookie },
    });
    const records = gpRes.data ?? [];
    const withTle = records.filter((r) => r.TLE_LINE1 && r.TLE_LINE2);
    const KEEP_TYPES = new Set(['DEBRIS', 'ROCKET BODY']);
    const filtered = withTle.filter((r) => KEEP_TYPES.has((r.OBJECT_TYPE ?? '').toUpperCase()));
    console.log(`[space-track] Filtered to ${filtered.length} debris/rocket-body objects out of ${withTle.length} total (${records.length} raw records)`);

    const sats = filtered
      .map((r) => ({
        norad_id:    parseInt(r.NORAD_CAT_ID, 10),
        name:        r.OBJECT_NAME ?? r.SATNAME ?? 'Unknown',
        tle_line1:   r.TLE_LINE1,
        tle_line2:   r.TLE_LINE2,
        category:    classifySatellite(r.OBJECT_NAME ?? r.SATNAME, r.OBJECT_TYPE),
        country:     r.COUNTRY_CODE ?? null,
        launch_date: r.LAUNCH_DATE  ?? null,
      }))
      .filter((s) => Number.isFinite(s.norad_id));

    insertOrUpdateSatellites(sats);
    satCount = sats.length;
    console.log(`[space-track] GP JSON → ${satCount} debris/rocket-body objects inserted`);
  } catch (err) {
    console.error(`[space-track] GP fetch failed: ${err.message}`);
  }

  await sleep(SPACETRACK_DELAY);

  // ── Fetch CDMs ──
  let cdmCount = 0;
  try {
    const cdmRes = await fetchWithRetry({
      method: 'GET',
      url: SPACETRACK_CDM,
      headers: { Cookie: sessionCookie },
    });
    const cdms = (cdmRes.data ?? []).map((c) => ({
      sat1_norad:              parseInt(c.SAT_1_ID, 10)   || null,
      sat2_norad:              parseInt(c.SAT_2_ID, 10)   || null,
      tca:                     c.TCA                      ?? null,
      miss_distance_km:        parseFloat(c.MISS_DISTANCE) || null,
      relative_velocity_km_s:  parseFloat(c.RELATIVE_SPEED) || null,
      probability:             parseFloat(c.COLLISION_PROBABILITY) || null,
    })).filter((c) => c.sat1_norad && c.sat2_norad);

    _insertCdms(cdms);
    cdmCount = cdms.length;
    console.log(`[space-track] CDMs → ${cdmCount} conjunctions inserted`);
  } catch (err) {
    console.error(`[space-track] CDM fetch failed: ${err.message}`);
  }

  return { sats: satCount, cdms: cdmCount };
}

// ── fetchAll ───────────────────────────────────────────────────────────────

async function fetchAll() {
  console.log('[fetcher] Starting fetchAll…');

  // CelesTrak (primary source)
  let celestrakCount = 0;
  try {
    celestrakCount = await fetchCelesTrak();
    logFetch('celestrak', celestrakCount, true);
  } catch (err) {
    console.error(`[fetcher] CelesTrak run failed: ${err.message}`);
    logFetch('celestrak', 0, false);
  }

  // Space-Track — runs always (provides CDMs + fills gaps when CelesTrak fails)
  if (celestrakCount === 0) {
    console.warn('[fetcher] CelesTrak yielded 0 satellites — Space-Track is the fallback source');
  }
  let stSats = 0, stCdms = 0;
  try {
    ({ sats: stSats, cdms: stCdms } = await fetchSpaceTrack());
    logFetch('space-track-tle', stSats, true);
    logFetch('space-track-cdm', stCdms, true);
  } catch (err) {
    console.error(`[fetcher] Space-Track run failed: ${err.message}`);
    logFetch('space-track', 0, false);
  }

  // ── DB stats after all inserts ──────────────────────────────────────────
  const dbCount = db.prepare('SELECT COUNT(*) AS n FROM satellites').get().n;

  const catBreakdown = db.prepare(`
    SELECT category, COUNT(*) AS n
    FROM satellites
    GROUP BY category
    ORDER BY n DESC
  `).all();

  const summary = {
    celestrak:      celestrakCount,
    spaceTrackSats: stSats,
    spaceTrackCdms: stCdms,
    totalInDB:      dbCount,
  };

  console.log(`\n╔═ fetchAll complete ═══════════════════════════════════`);
  console.log(`║  CelesTrak fetched : ${celestrakCount.toLocaleString()} sats`);
  console.log(`║  Space-Track TLEs  : ${stSats.toLocaleString()} sats`);
  console.log(`║  Space-Track CDMs  : ${stCdms.toLocaleString()} conjunctions`);
  console.log(`║  DB total          : ${dbCount.toLocaleString()} satellites`);
  console.log(`║  Category breakdown:`);
  catBreakdown.forEach(({ category, n }) => {
    console.log(`║    ${(category ?? 'null').padEnd(14)} ${n.toLocaleString()}`);
  });
  console.log(`╚═══════════════════════════════════════════════════════\n`);

  return summary;
}

module.exports = { fetchAll, fetchCelesTrak, fetchSpaceTrack, parseTLE };
