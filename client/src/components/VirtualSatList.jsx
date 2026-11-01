import { useMemo, useRef, useState, useCallback } from 'react';
import { useStore } from '../store/useStore';

const ROW_H  = 48;
const OVERSCAN = 5;

const CAT_COLORS = {
  active:        '#00bfff',
  debris:        '#4a7090',
  'rocket-body': '#ff8800',
  crewed:        '#00ff64',
  starlink:      '#a060ff',
  weather:       '#9060e0',
  navigation:    '#ffcc00',
  constellation: '#40a8ff',
  unknown:       '#304050',
};

function SatRow({ sat, isSelected, isConjunction, onSelect }) {
  const catColor = CAT_COLORS[sat.category] ?? '#304050';
  const [hovered, setHovered] = useState(false);

  let bg = 'transparent';
  if (isSelected)    bg = 'rgba(0,191,255,0.08)';
  else if (isConjunction) bg = 'rgba(255,34,68,0.07)';
  else if (hovered)  bg = 'rgba(0,255,100,0.04)';

  const leftBorder = isSelected
    ? `2px solid #00bfff`
    : isConjunction
    ? `2px solid #ff2244`
    : `2px solid transparent`;

  return (
    <button
      onClick={() => onSelect(sat.norad_id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%', height: ROW_H,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '0 12px',
        background: bg,
        borderLeft: leftBorder,
        borderBottom: '1px solid rgba(0,255,100,0.06)',
        borderTop: 'none', borderRight: 'none',
        cursor: 'pointer',
        fontFamily: "'Courier New', monospace",
        textAlign: 'left',
        transition: 'background 0.1s',
      }}
    >
      {/* Row 1: dot + name + conj warning */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: catColor, flexShrink: 0,
        }} />
        <span style={{
          fontSize: 10, color: isSelected ? '#d0e8f8' : '#8aabb8',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }}>
          {sat.name}
        </span>
        {isConjunction && (
          <span style={{ fontSize: 8, color: '#ff2244', fontWeight: 700, flexShrink: 0 }}>
            ⚠CONJ
          </span>
        )}
      </div>

      {/* Row 2: NORAD + alt + danger score */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, marginTop: 2 }}>
        <span style={{ fontSize: 9, color: '#3a5a6a' }}>{sat.norad_id}</span>
        {sat.position && (
          <span style={{ fontSize: 9, color: '#00ff6488' }}>
            {sat.position.altKm?.toFixed(0)} KM
          </span>
        )}
        {sat.danger_score > 0 && (
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: sat.danger_score >= 80 ? '#ff2244'
                 : sat.danger_score >= 60 ? '#ff8800'
                 : sat.danger_score >= 40 ? '#ffcc00'
                 : '#4a9a6a',
            marginLeft: 'auto',
          }}>
            {sat.danger_score}
          </span>
        )}
      </div>
    </button>
  );
}

export default function VirtualSatList({ satellites, containerHeight = 400 }) {
  const selectedNoradId = useStore((s) => s.selectedNoradId);
  const conjunctions    = useStore((s) => s.conjunctions);
  const selectSatellite = useStore((s) => s.selectSatellite);

  const conjunctionIds = useMemo(
    () => new Set(conjunctions.flatMap((c) => [c.sat1_norad, c.sat2_norad])),
    [conjunctions]
  );

  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef(null);

  const totalHeight = satellites.length * ROW_H;

  const { startIdx, endIdx } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visibleCount = Math.ceil(containerHeight / ROW_H) + OVERSCAN * 2;
    return { startIdx: start, endIdx: Math.min(satellites.length - 1, start + visibleCount) };
  }, [scrollTop, containerHeight, satellites.length]);

  const onScroll = useCallback((e) => setScrollTop(e.currentTarget.scrollTop), []);

  if (!satellites.length) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: containerHeight, fontFamily: "'Courier New', monospace",
        fontSize: 9, color: '#3a5a6a', letterSpacing: 2,
      }}>
        NO OBJECTS MATCH FILTER
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      style={{
        height: containerHeight,
        overflowY: 'auto',
        flex: 1,
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(0,255,100,0.2) transparent',
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: startIdx * ROW_H, left: 0, right: 0 }}>
          {satellites.slice(startIdx, endIdx + 1).map((sat) => (
            <SatRow
              key={sat.norad_id}
              sat={sat}
              isSelected={sat.norad_id === selectedNoradId}
              isConjunction={conjunctionIds.has(sat.norad_id)}
              onSelect={selectSatellite}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
