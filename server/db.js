const fs = require('fs');
const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'satellites.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS satellites (
    norad_id    INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    tle_line1   TEXT NOT NULL,
    tle_line2   TEXT NOT NULL,
    category    TEXT,
    country     TEXT,
    launch_date TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    danger_score REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS conjunctions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    sat1_norad            INTEGER,
    sat2_norad            INTEGER,
    tca                   DATETIME,
    miss_distance_km      REAL,
    relative_velocity_km_s REAL,
    probability           REAL,
    computed_at           DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tle_fetch_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT,
    count      INTEGER,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    success    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_satellites_category   ON satellites(category);
  CREATE INDEX IF NOT EXISTS idx_satellites_updated_at ON satellites(updated_at);
  CREATE INDEX IF NOT EXISTS idx_conjunctions_tca      ON conjunctions(tca);
  CREATE INDEX IF NOT EXISTS idx_conjunctions_sat1     ON conjunctions(sat1_norad);
  CREATE INDEX IF NOT EXISTS idx_conjunctions_sat2     ON conjunctions(sat2_norad);
`);

// ── Prepared statements ────────────────────────────────────────────────────

const _upsertSat = db.prepare(`
  INSERT INTO satellites (norad_id, name, tle_line1, tle_line2, category, country, launch_date, updated_at)
  VALUES (@norad_id, @name, @tle_line1, @tle_line2, @category, @country, @launch_date, CURRENT_TIMESTAMP)
  ON CONFLICT(norad_id) DO UPDATE SET
    name        = excluded.name,
    tle_line1   = excluded.tle_line1,
    tle_line2   = excluded.tle_line2,
    category    = excluded.category,
    country     = excluded.country,
    launch_date = excluded.launch_date,
    updated_at  = CURRENT_TIMESTAMP
`);

const _insertConjunction = db.prepare(`
  INSERT INTO conjunctions (sat1_norad, sat2_norad, tca, miss_distance_km, relative_velocity_km_s, probability)
  VALUES (@sat1_norad, @sat2_norad, @tca, @miss_distance_km, @relative_velocity_km_s, @probability)
`);

const _logFetch = db.prepare(`
  INSERT INTO tle_fetch_log (source, count, success) VALUES (@source, @count, @success)
`);

// ── Exported helpers ───────────────────────────────────────────────────────

/**
 * Upsert an array of satellite objects into the database.
 * Each object should have: norad_id, name, tle_line1, tle_line2,
 * and optionally: category, country, launch_date.
 */
function insertOrUpdateSatellites(satellites) {
  const run = db.transaction((rows) => {
    for (const row of rows) {
      _upsertSat.run({
        norad_id:    row.norad_id,
        name:        row.name,
        tle_line1:   row.tle_line1,
        tle_line2:   row.tle_line2,
        category:    row.category    ?? null,
        country:     row.country     ?? null,
        launch_date: row.launch_date ?? null,
      });
    }
  });
  run(satellites);
}

/**
 * Fetch satellites, optionally filtered.
 * @param {object} filters - { category?: string, country?: string, search?: string, limit?: number }
 */
// Only debris and rocket-body are served — all other categories are excluded.
const DEBRIS_CATEGORIES_SQL = `category IN ('debris', 'rocket-body')`;

function getSatellites({ category, country, search, limit = 2000 } = {}) {
  const conditions = [DEBRIS_CATEGORIES_SQL];
  const params = {};

  // category param accepted for API compatibility but always scoped to debris/rocket-body
  if (category && category !== 'all' && !['debris', 'rocket-body'].includes(category)) {
    return [];
  }
  if (category === 'debris' || category === 'rocket-body') {
    // narrow further to exactly that sub-type
    conditions[0] = `category = @category`;
    params.category = category;
  }
  if (country && country !== 'all') {
    conditions.push('country = @country');
    params.country = country;
  }
  if (search) {
    conditions.push('(name LIKE @search OR CAST(norad_id AS TEXT) LIKE @search)');
    params.search = `%${search}%`;
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const sql = `SELECT * FROM satellites ${where} ORDER BY name LIMIT @limit`;
  console.log(`[db] getSatellites SQL: ${sql} | params: ${JSON.stringify({ ...params, limit })}`);
  return db.prepare(sql).all({ ...params, limit });
}

/**
 * Fetch conjunctions with TCA within the next `hoursAhead` hours.
 * @param {number} hoursAhead
 */
function getConjunctions(hoursAhead = 72) {
  return db.prepare(`
    SELECT c.*, s1.name AS sat1_name, s2.name AS sat2_name
    FROM conjunctions c
    LEFT JOIN satellites s1 ON s1.norad_id = c.sat1_norad
    LEFT JOIN satellites s2 ON s2.norad_id = c.sat2_norad
    WHERE c.tca BETWEEN CURRENT_TIMESTAMP
                    AND datetime(CURRENT_TIMESTAMP, '+' || @hours || ' hours')
    ORDER BY c.miss_distance_km ASC
  `).all({ hours: hoursAhead });
}

/**
 * Record a TLE fetch attempt in the log.
 * @param {string} source - URL or label
 * @param {number} count  - number of TLEs fetched
 * @param {boolean} success
 */
function logFetch(source, count, success) {
  _logFetch.run({ source, count, success: success ? 1 : 0 });
}

module.exports = { db, insertOrUpdateSatellites, getSatellites, getConjunctions, logFetch };
