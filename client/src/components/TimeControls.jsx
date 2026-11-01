import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';

const G   = '#00ff88';
const MUT = '#3a5a6a';
const DIM = 'rgba(0,255,136,0.15)';

const SPEEDS       = [1, 10, 60];
const SPEED_LABELS = { 1: '1×', 10: '10×', 60: '60×' };

export default function TimeControls() {
  const isLive          = useStore((s) => s.isLive);
  const simulatedTime   = useStore((s) => s.simulatedTime);
  const playbackSpeed   = useStore((s) => s.playbackSpeed);
  const goLive          = useStore((s) => s.goLive);
  const setPlaybackSpeed = useStore((s) => s.setPlaybackSpeed);

  const [utc, setUtc] = useState('');
  const tickRef = useRef(null);

  useEffect(() => {
    function update() {
      const d = isLive ? new Date() : new Date(simulatedTime);
      setUtc(d.toISOString().replace('T', ' ').slice(0, 19));
    }
    update();
    clearInterval(tickRef.current);
    if (isLive) {
      tickRef.current = setInterval(update, 1000);
    }
    return () => clearInterval(tickRef.current);
  }, [isLive, simulatedTime]);

  const cell = {
    display: 'flex', alignItems: 'center',
    height: '100%',
    padding: '0 12px',
    borderRight: `1px solid ${DIM}`,
    flexShrink: 0,
    gap: 6,
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      height: '100%',
      borderRight: `1px solid ${DIM}`,
      flexShrink: 0,
      fontFamily: "'Courier New', monospace",
    }}>
      {/* ── LIVE pill ── */}
      <button
        onClick={goLive}
        title="Return to live mode"
        style={{
          ...cell,
          background: isLive ? 'rgba(0,255,136,0.08)' : 'transparent',
          border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: isLive ? G : MUT,
          boxShadow: isLive ? `0 0 6px ${G}, 0 0 12px ${G}` : 'none',
          display: 'inline-block',
          flexShrink: 0,
          animation: isLive ? 'live-pulse 1.5s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontSize: 9, color: isLive ? G : MUT, letterSpacing: 2 }}>LIVE</span>
      </button>

      {/* ── UTC clock ── */}
      <div style={cell}>
        <span style={{
          fontSize: 11,
          color: isLive ? G : '#00bfff',
          letterSpacing: 1,
        }}>
          {utc} UTC
        </span>
      </div>

      {/* ── Speed selector ── */}
      <div style={{ ...cell, gap: 4 }}>
        <span style={{ fontSize: 8, color: MUT, letterSpacing: 1, marginRight: 2 }}>SPD</span>
        {SPEEDS.map((s) => {
          const active = playbackSpeed === s && !isLive;
          return (
            <button
              key={s}
              onClick={() => setPlaybackSpeed(s)}
              style={{
                fontSize: 9, padding: '2px 6px',
                background: active ? 'rgba(0,255,136,0.12)' : 'transparent',
                border: `1px solid ${active ? G : MUT}`,
                color: active ? G : MUT,
                cursor: 'pointer',
                fontFamily: "'Courier New', monospace",
                letterSpacing: 1,
                transition: 'color 0.1s, border-color 0.1s',
              }}
            >
              {SPEED_LABELS[s]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
