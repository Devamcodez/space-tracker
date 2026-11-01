import { useEffect, useState } from 'react';

const G       = '#00ff88';
const TOTAL_MS = 10_000;

const PHASES = [
  { from: 0,  text: 'INITIALIZING SYSTEMS...' },
  { from: 15, text: 'CONNECTING TO TLE NETWORK...' },
  { from: 35, text: 'LOADING ORBITAL DATABASE...' },
  { from: 55, text: 'CALIBRATING SGP4 PROPAGATOR...' },
  { from: 70, text: 'RENDERING GLOBE...' },
  { from: 90, text: 'SYSTEMS ONLINE' },
];

function currentPhase(pct) {
  return [...PHASES].reverse().find((p) => pct >= p.from) ?? PHASES[0];
}

export default function LoadingSplash() {
  const [pct,     setPct]     = useState(0);
  const [fading,  setFading]  = useState(false);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    const start = Date.now();

    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const next    = Math.min(100, (elapsed / TOTAL_MS) * 100);
      setPct(next);

      if (next >= 100) {
        clearInterval(tick);
        setTimeout(() => setFading(true), 200);
        setTimeout(() => setMounted(false), 1400); // 200ms hold + 1000ms fade
      }
    }, 40); // ~25fps — smooth enough

    return () => clearInterval(tick);
  }, []);

  if (!mounted) return null;

  const phase = currentPhase(pct);
  const isOnline = pct >= 90;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: '#000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Courier New', monospace",
      opacity: fading ? 0 : 1,
      transition: fading ? 'opacity 1s ease-out' : 'none',
      pointerEvents: fading ? 'none' : 'auto',
    }}>
      {/* Corner brackets — decorative */}
      <span style={{ position: 'absolute', top: 24, left: 24,  fontSize: 14, color: '#0a2a14', letterSpacing: 0 }}>┌─</span>
      <span style={{ position: 'absolute', top: 24, right: 24, fontSize: 14, color: '#0a2a14' }}>─┐</span>
      <span style={{ position: 'absolute', bottom: 24, left: 24,  fontSize: 14, color: '#0a2a14' }}>└─</span>
      <span style={{ position: 'absolute', bottom: 24, right: 24, fontSize: 14, color: '#0a2a14' }}>─┘</span>

      {/* System ID line */}
      <div style={{ fontSize: 9, color: '#0d2a18', letterSpacing: 4, marginBottom: 32 }}>
        SYS-ID: ST-01 ◈ ORBITAL SURVEILLANCE NODE
      </div>

      {/* Main title */}
      <div style={{
        fontSize: 42,
        color: G,
        letterSpacing: 10,
        fontWeight: 700,
        marginBottom: 10,
        textShadow: `0 0 30px ${G}55, 0 0 60px ${G}22`,
      }}>
        SPACE TRACKER
      </div>

      {/* Subtitle */}
      <div style={{
        fontSize: 11,
        color: '#1a4a28',
        letterSpacing: 6,
        marginBottom: 56,
      }}>
        ORBITAL SURVEILLANCE SYSTEM
      </div>

      {/* Progress bar */}
      <div style={{ width: 400, marginBottom: 14 }}>
        {/* Bar track */}
        <div style={{
          height: 2,
          background: '#050f08',
          position: 'relative',
          overflow: 'visible',
        }}>
          {/* Filled portion */}
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${pct}%`,
            background: G,
            boxShadow: `0 0 10px ${G}, 0 0 20px ${G}66`,
            transition: 'width 0.04s linear',
          }} />
          {/* Glow head */}
          {pct > 0 && pct < 100 && (
            <div style={{
              position: 'absolute', top: -3, bottom: -3,
              width: 4,
              left: `calc(${pct}% - 2px)`,
              background: '#fff',
              boxShadow: `0 0 8px ${G}, 0 0 16px ${G}`,
            }} />
          )}
        </div>

        {/* Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <span style={{ fontSize: 9, color: '#0d2a18', letterSpacing: 2 }}>LOADING</span>
          <span style={{ fontSize: 9, color: G, letterSpacing: 2, fontWeight: 700 }}>
            {Math.floor(pct).toString().padStart(3, '0')}%
          </span>
        </div>
      </div>

      {/* Status text */}
      <div style={{
        fontSize: 10,
        color: isOnline ? G : '#1a4a28',
        letterSpacing: 3,
        height: 18,
        textShadow: isOnline ? `0 0 10px ${G}` : 'none',
        transition: 'color 0.3s, text-shadow 0.3s',
      }}>
        {phase.text}
      </div>

      {/* Bottom version line */}
      <div style={{
        position: 'absolute', bottom: 24,
        fontSize: 8, color: '#0a1a10', letterSpacing: 3,
      }}>
        V2.0 ◈ SGP4/SDP4 PROPAGATOR ◈ CELESTRAK · SPACE-TRACK.ORG
      </div>
    </div>
  );
}
