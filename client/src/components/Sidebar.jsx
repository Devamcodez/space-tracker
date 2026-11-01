import { useMemo, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { useStore, ALL_CATEGORIES } from '../store/useStore';
import VirtualSatList from './VirtualSatList';

// ── Palette ─────────────────────────────────────────────────────────────────
const G    = '#00ff64';
const MUT  = '#3a5a6a';
const DIM  = 'rgba(0,255,100,0.13)';
const BG   = '#060b0f';
const SF   = '#08111a';
const TXT  = '#b0c8d8';

const CAT_META = {
  active:        { label: 'ACTIVE PAYLOAD',  color: '#00bfff' },
  debris:        { label: 'DEBRIS',          color: '#4a7090' },
  'rocket-body': { label: 'ROCKET BODY',     color: '#ff8800' },
  crewed:        { label: 'CREWED',          color: '#00ff64' },
  starlink:      { label: 'STARLINK',        color: '#a060ff' },
  weather:       { label: 'WEATHER SAT',     color: '#9060e0' },
  navigation:    { label: 'NAVIGATION',      color: '#ffcc00' },
  constellation: { label: 'CONSTELLATION',   color: '#40a8ff' },
  unknown:       { label: 'UNKNOWN',         color: '#304050' },
};

const ORBIT_REGIMES = [
  { id: 'all', label: 'ALL'  },
  { id: 'LEO', label: 'LEO'  },
  { id: 'MEO', label: 'MEO'  },
  { id: 'GEO', label: 'GEO'  },
  { id: 'HEO', label: 'HEO'  },
];

// ── Divider label ────────────────────────────────────────────────────────────
function SectionLabel({ text }) {
  return (
    <div style={{ padding: '0 16px 5px', fontSize: 9, color: MUT, letterSpacing: 2 }}>
      {text}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Sidebar() {
  const satellites            = useStore((s) => s.satellites);
  const stats                 = useStore((s) => s.stats);
  const filters               = useStore((s) => s.filters);
  const updateFilters         = useStore((s) => s.updateFilters);
  const toggleCategory        = useStore((s) => s.toggleCategory);
  const getFilteredSatellites = useStore((s) => s.getFilteredSatellites);

  const [searchInput, setSearchInput] = useState(filters.search);
  useEffect(() => {
    const id = setTimeout(() => updateFilters({ search: searchInput }), 300);
    return () => clearTimeout(id);
  }, [searchInput, updateFilters]);

  const [recomputeState, setRecomputeState] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [recomputeResult, setRecomputeResult] = useState(null);

  const recomputeScores = useCallback(async () => {
    setRecomputeState('loading');
    setRecomputeResult(null);
    try {
      const { data } = await axios.post('/api/compute-danger-scores');
      setRecomputeResult(data);
      setRecomputeState('done');
      setTimeout(() => setRecomputeState('idle'), 8000);
    } catch (err) {
      console.error('[sidebar] recompute failed:', err.message);
      setRecomputeState('error');
      setTimeout(() => setRecomputeState('idle'), 4000);
    }
  }, []);

  // Use full-DB counts from /api/stats; fall back to counting from the frontend
  // array only if stats haven't arrived yet.
  const categoryCounts = useMemo(() => {
    if (stats) {
      return {
        active:        stats.activePayloads  ?? 0,
        debris:        stats.debris          ?? 0,
        'rocket-body': stats.rocketBodies    ?? 0,
        crewed:        stats.crewed          ?? 0,
        starlink:      stats.starlink        ?? 0,
        weather:       stats.weather         ?? 0,
        navigation:    stats.navigation      ?? 0,
        constellation: stats.constellation   ?? 0,
        unknown:       stats.unknown         ?? 0,
      };
    }
    // Fallback: count from rendered array
    const counts = {};
    for (const cat of ALL_CATEGORIES) counts[cat] = 0;
    for (const sat of satellites) {
      const cat = sat.category ?? 'unknown';
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [stats, satellites]);

  const filteredSats = useMemo(
    () => getFilteredSatellites(),
    [satellites, filters] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const totalShown = useMemo(() => {
    const { categories, orbitRegime, search } = filters;
    const q = search.trim().toLowerCase();
    let n = 0;
    for (const sat of satellites) {
      if (!categories.has(sat.category ?? 'unknown')) continue;
      if (q && !sat.name?.toLowerCase().includes(q) && !String(sat.norad_id).includes(q)) continue;
      if (orbitRegime !== 'all') {
        const alt = sat.position?.altKm ?? null;
        if (alt === null) continue;
        if (orbitRegime === 'LEO' && alt >= 2000)          continue;
        if (orbitRegime === 'MEO' && (alt < 2000 || alt >= 35000)) continue;
        if (orbitRegime === 'GEO' && (alt < 35000 || alt >= 37000)) continue;
        if (orbitRegime === 'HEO' && alt < 37000)          continue;
      }
      n++;
    }
    return n;
  }, [satellites, filters]);

  const allSelected = ALL_CATEGORIES.every((c) => filters.categories.has(c));

  return (
    <aside style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: BG,
      fontFamily: "'Courier New', monospace",
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Animated scan line */}
      <div className="mil-scanline" />

      {/* ── Header ── */}
      <div style={{
        padding: '14px 16px 10px',
        borderBottom: `1px solid ${DIM}`,
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, color: G, letterSpacing: 3, marginBottom: 3 }}>
          ST-01 ◈ ORBITAL SURVEILLANCE
        </div>
        <div style={{ fontSize: 12, color: '#d0e8f8', letterSpacing: 5, fontWeight: 700 }}>
          SPACE TRACKER
        </div>
        <div style={{ fontSize: 9, marginTop: 5, letterSpacing: 1 }}>
          <span style={{ color: '#00ff88', fontWeight: 700 }}>{totalShown.toLocaleString()}</span>
          <span style={{ color: '#ffffff99' }}> VISIBLE / </span>
          <span style={{ color: '#00ff88', fontWeight: 700 }}>{satellites.length.toLocaleString()}</span>
          <span style={{ color: '#ffffff99' }}> RENDERED</span>
        </div>
        {stats?.totalObjects && stats.totalObjects > satellites.length && (
          <div style={{ fontSize: 8, color: '#3a6a50', marginTop: 3, letterSpacing: 0.5 }}>
            <span style={{ color: '#00ff8866' }}>{satellites.length.toLocaleString()}</span>
            <span style={{ color: '#2a4a38' }}> rendered · </span>
            <span style={{ color: '#00ff8866' }}>{stats.totalObjects.toLocaleString()}</span>
            <span style={{ color: '#2a4a38' }}> in catalog</span>
          </div>
        )}
      </div>

      {/* ── Object class table ── */}
      <div style={{ borderBottom: `1px solid ${DIM}`, flexShrink: 0, paddingTop: 8 }}>
        <SectionLabel text="-- OBJECT CLASS --" />
        {ALL_CATEGORIES.map((cat) => {
          const meta    = CAT_META[cat] ?? { label: cat.toUpperCase(), color: MUT };
          const count   = categoryCounts[cat] ?? 0;
          const checked = filters.categories.has(cat);
          return (
            <div
              key={cat}
              onClick={() => toggleCategory(cat)}
              style={{
                display: 'flex', alignItems: 'center',
                padding: '3px 16px',
                cursor: 'pointer',
                background: checked ? `${meta.color}09` : 'transparent',
                borderLeft: `2px solid ${checked ? meta.color : 'transparent'}`,
                transition: 'background 0.1s',
              }}
            >
              {/* Dot */}
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: checked ? meta.color : 'transparent',
                border: `1px solid ${checked ? meta.color : MUT}`,
                marginRight: 8, transition: 'all 0.1s',
              }} />
              {/* Label */}
              <span style={{
                flex: 1, fontSize: 10,
                color: checked ? TXT : MUT,
                letterSpacing: 0.5,
              }}>
                {meta.label}
              </span>
              {/* Count */}
              <span style={{
                fontSize: 10, color: checked ? meta.color : '#253545',
                minWidth: 40, textAlign: 'right',
              }}>
                {count.toLocaleString()}
              </span>
            </div>
          );
        })}
        <div style={{ padding: '4px 16px 8px', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="mil-btn"
            onClick={() => updateFilters({ categories: allSelected ? new Set() : new Set(ALL_CATEGORIES) })}
          >
            [{allSelected ? 'DESELECT ALL' : 'SELECT ALL'}]
          </button>
        </div>
      </div>

      {/* ── Search ── */}
      <div style={{ padding: '8px 16px', borderBottom: `1px solid ${DIM}`, flexShrink: 0 }}>
        <SectionLabel text="-- SEARCH --" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: G, fontSize: 12, flexShrink: 0 }}>›</span>
          <input
            type="text"
            placeholder="SEARCH OBJECT..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="mil-input"
            style={{ borderColor: searchInput ? G : undefined }}
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); updateFilters({ search: '' }); }}
              style={{ color: MUT, background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* ── Orbit regime ── */}
      <div style={{ padding: '8px 16px', borderBottom: `1px solid ${DIM}`, flexShrink: 0 }}>
        <SectionLabel text="-- ORBIT REGIME --" />
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {ORBIT_REGIMES.map(({ id, label }) => (
            <button
              key={id}
              className={`mil-btn${filters.orbitRegime === id ? ' active' : ''}`}
              onClick={() => updateFilters({ orbitRegime: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tracked objects list ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '6px 16px 4px', flexShrink: 0 }}>
          <SectionLabel text={`-- TRACKED OBJECTS (${totalShown.toLocaleString()}) --`} />
        </div>
        <VirtualSatList satellites={filteredSats} containerHeight={300} />
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '7px 16px',
        borderTop: `1px solid ${DIM}`,
        flexShrink: 0,
      }}>
        <div style={{ marginBottom: 6 }}>
          <button
            className="mil-btn"
            disabled={recomputeState === 'loading'}
            onClick={recomputeScores}
            style={{ width: '100%', textAlign: 'center', opacity: recomputeState === 'loading' ? 0.6 : 1 }}
          >
            {recomputeState === 'loading' ? '[COMPUTING…]'
              : recomputeState === 'done'    ? '[SCORES UPDATED]'
              : recomputeState === 'error'   ? '[COMPUTE FAILED]'
              : '[RECOMPUTE DANGER SCORES]'}
          </button>
          {recomputeState === 'done' && recomputeResult && (
            <div style={{ fontSize: 8, color: G, marginTop: 4, letterSpacing: 0.5 }}>
              {recomputeResult.processed?.toLocaleString()} objs · avg {recomputeResult.avgScore}/100 · max {recomputeResult.maxScore} · {recomputeResult.elapsedSec}s
            </div>
          )}
        </div>
        <div style={{ fontSize: 8, color: '#203040', letterSpacing: 1, textAlign: 'center' }}>
          SRC: CELESTRAK · SPACE-TRACK.ORG
        </div>
      </div>
    </aside>
  );
}
