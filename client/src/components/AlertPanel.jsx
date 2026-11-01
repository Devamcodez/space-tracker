import { useMemo, useEffect, useState } from 'react';
import { parseISO } from 'date-fns';
import { useStore } from '../store/useStore';

const G   = '#00ff64';
const MUT = '#3a5a6a';
const DIM = 'rgba(0,255,100,0.13)';

function riskMeta(prob) {
  if (prob > 1e-4) return { label: 'CRIT', color: '#ff2244' };
  if (prob > 1e-6) return { label: 'WARN', color: '#ff8800' };
  return               { label: 'LOW',  color: G };
}

function Countdown({ tca }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    function update() {
      try {
        const diff = parseISO(tca) - new Date();
        if (diff <= 0) { setLabel('NOW'); return; }
        const h = Math.floor(diff / 3_600_000);
        const m = Math.floor((diff % 3_600_000) / 60_000);
        const s = Math.floor((diff % 60_000) / 1_000);
        setLabel(`T-${h > 0 ? `${h}H` : ''}${m}M${s}S`);
      } catch { setLabel('--'); }
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [tca]);
  return <span>{label}</span>;
}

function ConjunctionItem({ c, onSelect }) {
  const prob = c.probability ?? 0;
  const meta = riskMeta(prob);
  const n1   = (c.sat1_name ?? `#${c.sat1_norad}`).slice(0, 20);
  const n2   = (c.sat2_name ?? `#${c.sat2_norad}`).slice(0, 20);

  return (
    <button
      onClick={() => onSelect(c.sat1_norad)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        padding: '0 14px',
        background: 'none', border: 'none', cursor: 'pointer',
        fontFamily: "'Courier New', monospace",
        flexShrink: 0,
        height: '100%',
        borderLeft: `1px solid ${DIM}`,
      }}
    >
      {/* Risk badge */}
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 1,
        color: meta.color,
        border: `1px solid ${meta.color}`,
        padding: '1px 5px',
        flexShrink: 0,
        animation: meta.color === '#ff2244' ? 'threat-blink 1s step-end infinite' : 'none',
      }}>
        {meta.label}
      </span>

      {/* Object names */}
      <span style={{ fontSize: 10, color: '#8aabb8', whiteSpace: 'nowrap' }}>
        {n1} <span style={{ color: MUT }}>×</span> {n2}
      </span>

      {/* Countdown */}
      <span style={{ fontSize: 10, color: meta.color, fontWeight: 700, whiteSpace: 'nowrap' }}>
        <Countdown tca={c.tca} />
      </span>

      {/* Miss distance */}
      <span style={{ fontSize: 10, color: MUT, whiteSpace: 'nowrap' }}>
        {c.miss_distance_km?.toFixed(1)} KM
      </span>

      {/* Probability */}
      <span style={{ fontSize: 9, color: meta.color, whiteSpace: 'nowrap' }}>
        PC {prob.toExponential(1)}
      </span>
    </button>
  );
}

export default function AlertPanel() {
  const conjunctions    = useStore((s) => s.conjunctions);
  const selectSatellite = useStore((s) => s.selectSatellite);

  const sorted = useMemo(
    () =>
      [...conjunctions]
        .filter((c) => c.probability > 0)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 10),
    [conjunctions]
  );

  return (
    <div style={{
      flex: 1, height: '100%', minWidth: 0,
      display: 'flex', alignItems: 'center',
      fontFamily: "'Courier New', monospace",
    }}>
      {/* Left label */}
      <div style={{
        flexShrink: 0,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '0 14px',
        borderRight: `1px solid ${DIM}`,
        height: '100%',
        gap: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {sorted.length > 0
            ? <span className="mil-live-dot" style={{ background: '#ff2244', animation: 'live-pulse 1s step-end infinite' }} />
            : <span style={{ width: 6, height: 6, borderRadius: '50%', background: G, opacity: 0.6, display: 'inline-block' }} />
          }
          <span style={{ fontSize: 9, color: MUT, letterSpacing: 2, whiteSpace: 'nowrap' }}>
            CONJ ANALYSIS
          </span>
        </div>
        <div style={{ fontSize: 9, color: sorted.length > 0 ? '#ff2244' : G, letterSpacing: 1, paddingLeft: 12 }}>
          {sorted.length > 0 ? `${sorted.length} THREAT${sorted.length > 1 ? 'S' : ''}` : 'NOMINAL'}
        </div>
      </div>

      {/* Ticker / no-threat message */}
      {sorted.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center',
          padding: '0 20px',
          fontSize: 10, color: G, letterSpacing: 3,
        }}>
          NO ACTIVE THREATS DETECTED
        </div>
      ) : (
        <div className="mil-ticker-wrap">
          {/* Duplicate items so the loop is seamless */}
          <div className="mil-ticker-inner">
            {[...sorted, ...sorted].map((c, i) => (
              <ConjunctionItem key={`${c.id}-${i}`} c={c} onSelect={selectSatellite} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
