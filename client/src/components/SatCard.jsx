import { useEffect, useState } from 'react';
import { formatDistanceToNow, format, parseISO, differenceInDays } from 'date-fns';
import axios from 'axios';
import { useStore } from '../store/useStore';

// ── Palette ──────────────────────────────────────────────────────────────────
const G   = '#00ff64';
const C   = '#00bfff';
const MUT = '#3a5a6a';
const DIM = 'rgba(0,255,100,0.13)';
const BG  = '#060b0f';
const SF  = '#08111a';
const TXT = '#b0c8d8';

const CAT_COLORS = {
  active:        C,
  debris:        '#4a7090',
  'rocket-body': '#ff8800',
  crewed:        G,
  starlink:      '#a060ff',
  weather:       '#9060e0',
  navigation:    '#ffcc00',
  constellation: '#40a8ff',
  unknown:       MUT,
};

const COUNTRY_FLAGS = {
  US: '🇺🇸', RU: '🇷🇺', CN: '🇨🇳', EU: '🇪🇺', IN: '🇮🇳',
  JP: '🇯🇵', FR: '🇫🇷', GB: '🇬🇧', DE: '🇩🇪', CA: '🇨🇦',
  AU: '🇦🇺', IL: '🇮🇱', KR: '🇰🇷', BR: '🇧🇷', UA: '🇺🇦',
};

// ── Small helpers ────────────────────────────────────────────────────────────

function Row({ label, value, accent }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0' }}>
      <span style={{ fontSize: 9, color: MUT, letterSpacing: 1.5, textTransform: 'uppercase', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: accent ? G : TXT, fontFamily: "'Courier New', monospace" }}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function Block({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: 9, color: MUT, letterSpacing: 2,
        borderTop: `1px solid ${DIM}`,
        padding: '6px 0 4px',
        marginBottom: 4,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Mini map ─────────────────────────────────────────────────────────────────

function MiniMap({ lat, lon }) {
  if (lat == null || lon == null) return null;
  const x = ((lon + 180) / 360) * 100;
  const y = ((90 - lat) / 180) * 100;
  return (
    <div style={{
      position: 'relative', width: '100%', height: 58,
      background: '#030810',
      border: `1px solid ${DIM}`,
      overflow: 'hidden', marginBottom: 6,
    }}>
      {/* Grid */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.15 }}
        viewBox="0 0 100 50" preserveAspectRatio="none">
        {[-60,-30,0,30,60].map((lt) => {
          const py = ((90 - lt) / 180) * 50;
          return <line key={lt} x1="0" y1={py} x2="100" y2={py} stroke={G} strokeWidth="0.4" />;
        })}
        {[-120,-60,0,60,120].map((ln) => {
          const px = ((ln + 180) / 360) * 100;
          return <line key={ln} x1={px} y1="0" x2={px} y2="50" stroke={G} strokeWidth="0.4" />;
        })}
      </svg>
      {/* Equator */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: `1px solid ${G}22` }} />
      {/* Crosshair */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${x}%`, borderLeft: `1px solid ${G}40` }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: `${y}%`, borderTop: `1px solid ${G}40` }} />
      {/* Dot */}
      <div style={{
        position: 'absolute',
        width: 6, height: 6, borderRadius: '50%',
        background: G,
        boxShadow: `0 0 6px ${G}`,
        left: `calc(${x}% - 3px)`, top: `calc(${y}% - 3px)`,
      }} />
      {/* Coords */}
      <span style={{
        position: 'absolute', bottom: 2, right: 4,
        fontSize: 8, color: `${G}99`, fontFamily: "'Courier New', monospace",
      }}>
        {lat.toFixed(2)}° {lon.toFixed(2)}°
      </span>
    </div>
  );
}

// ── Probability badge ────────────────────────────────────────────────────────

function ProbBadge({ prob }) {
  if (prob == null) return <span style={{ color: MUT, fontSize: 9 }}>—</span>;
  const p = Number(prob);
  const [color, label] =
    p > 1e-4 ? ['#ff2244', 'CRIT'] :
    p > 1e-6 ? ['#ff8800', 'WARN'] :
               [G,         'LOW'];
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, letterSpacing: 1,
      color, border: `1px solid ${color}`,
      padding: '1px 4px',
    }}>
      {label} {p.toExponential(1)}
    </span>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function SatCard() {
  const selectedNoradId      = useStore((s) => s.selectedNoradId);
  const selectedSatellite    = useStore((s) => s.selectedSatellite);
  const setSelectedSatellite = useStore((s) => s.setSelectedSatellite);
  const selectSatellite      = useStore((s) => s.selectSatellite);
  const isTracking           = useStore((s) => s.isTracking);
  const setTracking          = useStore((s) => s.setTracking);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedNoradId) { setSelectedSatellite(null); return; }
    setLoading(true);
    axios.get(`/api/satellites/${selectedNoradId}`)
      .then((r) => setSelectedSatellite(r.data))
      .catch(() => setSelectedSatellite(null))
      .finally(() => setLoading(false));
  }, [selectedNoradId, setSelectedSatellite]);

  const visible = !!selectedNoradId;

  return (
    <div style={{
      width: 300,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      background: BG,
      borderLeft: `1px solid ${DIM}`,
      fontFamily: "'Courier New', monospace",
      overflowY: 'auto',
      transition: 'transform 0.25s ease-out',
      transform: visible ? 'translateX(0)' : 'translateX(100%)',
      pointerEvents: visible ? 'auto' : 'none',
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px',
        borderBottom: `1px solid ${DIM}`,
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 9, color: G, letterSpacing: 2 }}>OBJECT DETAILS</div>
          <div style={{ fontSize: 9, color: MUT, letterSpacing: 1, marginTop: 1 }}>
            NORAD {selectedNoradId ?? '---'}
          </div>
        </div>
        <button
          onClick={() => { selectSatellite(null); setTracking(false); }}
          style={{
            color: MUT, background: 'none', border: `1px solid ${MUT}`,
            cursor: 'pointer', fontSize: 12, padding: '2px 7px',
            fontFamily: "'Courier New', monospace",
          }}
        >
          ✕
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 10, color: G, letterSpacing: 3 }}>LOADING...</span>
        </div>
      )}

      {/* Content */}
      {!loading && selectedSatellite && (
        <CardContent
          sat={selectedSatellite}
          isTracking={isTracking}
          setTracking={setTracking}
          selectSatellite={selectSatellite}
        />
      )}
    </div>
  );
}

function CardContent({ sat, isTracking, setTracking, selectSatellite }) {
  const catColor = CAT_COLORS[sat.category] ?? MUT;
  const flag = COUNTRY_FLAGS[sat.country] ?? '';

  let epochAge = null, epochStr = null;
  try {
    const yr   = parseInt(sat.tle_line1.substring(18, 20), 10);
    const days = parseFloat(sat.tle_line1.substring(20, 32));
    const fullYr = yr < 57 ? 2000 + yr : 1900 + yr;
    const epoch = new Date(Date.UTC(fullYr, 0, 1) + (days - 1) * 86400000);
    epochAge = differenceInDays(new Date(), epoch);
    epochStr = format(epoch, 'yyyy-MM-dd HH:mm');
  } catch { /* ignore */ }

  let periodMin = null, inclination = null;
  try {
    const mm = parseFloat(sat.tle_line2.substring(52, 63));
    if (mm > 0) periodMin = ((2 * Math.PI) / (mm * ((2 * Math.PI) / 1440))).toFixed(1);
    inclination = parseFloat(sat.tle_line2.substring(8, 16)).toFixed(2);
  } catch { /* ignore */ }

  const pos = sat.position;

  return (
    <div style={{ padding: '12px 14px', flex: 1, overflowY: 'auto' }}>
      {/* Name */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#d0e8f8', fontWeight: 700, letterSpacing: 1, lineHeight: 1.3 }}>
          {sat.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 8, letterSpacing: 1, fontWeight: 700,
            color: catColor, border: `1px solid ${catColor}`,
            padding: '1px 5px',
          }}>
            {(sat.category ?? 'UNKNOWN').toUpperCase()}
          </span>
          {flag && <span style={{ fontSize: 13 }}>{flag}</span>}
          <span style={{ fontSize: 9, color: MUT }}>#{sat.norad_id}</span>
        </div>
      </div>

      {/* Track button */}
      <button
        onClick={() => setTracking(!isTracking)}
        style={{
          width: '100%', padding: '6px 0', marginBottom: 12,
          background: isTracking ? `${G}15` : `${C}12`,
          border: `1px solid ${isTracking ? G : C}`,
          color: isTracking ? G : C,
          fontSize: 10, letterSpacing: 2, fontWeight: 700,
          fontFamily: "'Courier New', monospace",
          cursor: 'pointer',
        }}
      >
        {isTracking ? '⊙ TRACKING — CLICK TO RELEASE' : '◎ LOCK TRACKING'}
      </button>

      {/* Position */}
      <Block title="-- CURRENT POSITION --">
        {pos ? (
          <>
            <MiniMap lat={pos.lat} lon={pos.lon} />
            <Row label="Altitude"  value={`${pos.altKm?.toFixed(1)} KM`} accent />
            <Row label="Velocity"  value={pos.velocityKmS != null ? `${pos.velocityKmS.toFixed(3)} KM/S` : null} />
            <Row label="Latitude"  value={`${pos.lat?.toFixed(4)}°`} />
            <Row label="Longitude" value={`${pos.lon?.toFixed(4)}°`} />
          </>
        ) : (
          <div style={{ fontSize: 9, color: '#ff8800', letterSpacing: 1 }}>POSITION UNAVAILABLE</div>
        )}
      </Block>

      {/* Orbital params */}
      <Block title="-- ORBITAL PARAMETERS --">
        <Row label="Period"      value={periodMin ? `${periodMin} MIN` : null} />
        <Row label="Inclination" value={inclination ? `${inclination}°` : null} />
        <Row label="Launch"      value={sat.launch_date ?? null} />
        <Row label="Country"     value={sat.country ? `${sat.country} ${flag}` : null} />
      </Block>

      {/* TLE */}
      <Block title="-- TLE DATA --">
        <Row label="Epoch" value={epochStr} />
        <Row label="Age"   value={epochAge != null ? `${epochAge} DAYS` : null} />
        {epochAge != null && epochAge > 14 && (
          <div style={{ fontSize: 9, color: '#ff8800', letterSpacing: 1, marginTop: 3 }}>
            ⚠ TLE AGE {epochAge}D — POSITION DEGRADED
          </div>
        )}
        <div style={{ marginTop: 6, borderTop: `1px solid ${DIM}`, paddingTop: 5 }}>
          <div style={{ fontSize: 8, color: '#203040', fontFamily: "'Courier New', monospace", wordBreak: 'break-all', lineHeight: 1.6 }}>
            {sat.tle_line1}<br />{sat.tle_line2}
          </div>
        </div>
      </Block>

      {/* Conjunctions */}
      {sat.conjunctions?.length > 0 && (
        <Block title={`-- CONJUNCTIONS (${sat.conjunctions.length}) --`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sat.conjunctions.slice(0, 5).map((c) => {
              const otherName  = c.sat1_norad === sat.norad_id ? c.sat2_name : c.sat1_name;
              const otherNorad = c.sat1_norad === sat.norad_id ? c.sat2_norad : c.sat1_norad;
              let tcaStr = '—';
              try { tcaStr = formatDistanceToNow(parseISO(c.tca), { addSuffix: true }); } catch { /* ignore */ }
              return (
                <div key={c.id} style={{
                  background: SF, border: `1px solid ${DIM}`, padding: '6px 8px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span
                      style={{ fontSize: 9, color: TXT, cursor: 'pointer' }}
                      onClick={() => selectSatellite(otherNorad)}
                    >
                      {otherName ?? `NORAD ${otherNorad}`}
                    </span>
                    <ProbBadge prob={c.probability} />
                  </div>
                  <div style={{ display: 'flex', gap: 10, fontSize: 9, color: MUT }}>
                    <span>TCA <span style={{ color: TXT }}>{tcaStr}</span></span>
                    <span>MISS <span style={{ color: G }}>{c.miss_distance_km?.toFixed(2)} KM</span></span>
                  </div>
                </div>
              );
            })}
          </div>
        </Block>
      )}
    </div>
  );
}
