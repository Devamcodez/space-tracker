import { useEffect, useCallback, useRef, useState } from 'react';
import axios from 'axios';
import Globe from './components/Globe';
import LoadingSplash from './components/LoadingSplash';
import Sidebar from './components/Sidebar';
import SatCard from './components/SatCard';
import AlertPanel from './components/AlertPanel';
import TimeControls from './components/TimeControls';
import ErrorBanner from './components/ErrorBanner';
import MissionPlanner from './components/MissionPlanner';
import { useStore } from './store/useStore';
import { formatDistanceToNow, parseISO } from 'date-fns';

// ── Layout constants ────────────────────────────────────────────────────────
const SIDEBAR_W  = 260;
const TOPBAR_H   = 40;
const BOTTOMBAR_H = 50;

const S = {
  sidebar: {
    position: 'fixed', left: 0, top: 0,
    width: SIDEBAR_W, height: '100vh',
    zIndex: 100,
    borderRight: '1px solid rgba(0,255,100,0.13)',
  },
  topBar: {
    position: 'fixed', top: 0, left: SIDEBAR_W, right: 0,
    height: TOPBAR_H,
    background: '#050a0f',
    zIndex: 100,
    borderBottom: '1px solid rgba(0,255,100,0.15)',
    display: 'flex', alignItems: 'center',
    fontFamily: "'Courier New', monospace",
    color: '#b0c8d8',
  },
  bottomBar: {
    position: 'fixed', bottom: 0, left: SIDEBAR_W, right: 0,
    height: BOTTOMBAR_H,
    background: '#050a0f',
    zIndex: 100,
    borderTop: '1px solid rgba(0,255,100,0.13)',
    overflow: 'hidden',
    display: 'flex', alignItems: 'center',
  },
  errorArea: {
    position: 'fixed', top: TOPBAR_H, left: SIDEBAR_W, right: 0,
    zIndex: 110, pointerEvents: 'none',
  },
  satCard: {
    position: 'fixed', top: 0, right: 0, bottom: 0,
    zIndex: 105,
    pointerEvents: 'none',  // panel itself re-enables pointer-events when visible
  },
  globeWrap: {
    position: 'fixed',
    left: SIDEBAR_W, top: TOPBAR_H, right: 0, bottom: 0,
    zIndex: 0,
  },
};

// ── Top stats bar ───────────────────────────────────────────────────────────

function StatsBar({ stats, dangerStats, onPlanMission, plannerOpen }) {
  const tleAge = (() => {
    try { return formatDistanceToNow(parseISO(stats?.lastTleUpdate), { addSuffix: true }); }
    catch { return '—'; }
  })();

  const G   = '#00ff88';
  const MUT = '#3a5a6a';
  const pipe = <span style={{ color: MUT, margin: '0 10px', fontSize: 10 }}>|</span>;

  const d = dangerStats?.distribution;

  return (
    <div style={S.topBar}>
      {/* Scrollable stats — takes remaining space */}
      <div style={{ display: 'flex', alignItems: 'center', flex: 1, paddingLeft: 14, overflow: 'hidden', minWidth: 0 }}>
        <span style={{ color: G, fontSize: 11, fontWeight: 700, letterSpacing: 2, marginRight: 12, flexShrink: 0 }}>
          ◈ DEBRIS TRACKER
        </span>
        {pipe}
        <Stat label="DEBRIS" value={(stats?.totalObjects ?? '—').toLocaleString()} color={G} />
        {pipe}
        <Stat label="ALERTS" value={stats?.highRiskCount ?? '—'}
          color={(stats?.highRiskCount ?? 0) > 0 ? '#ff2244' : G}
          blink={(stats?.highRiskCount ?? 0) > 0} />
        {pipe}
        <Stat label="CONJ"   value={stats?.conjunctionCount ?? '—'} color={G} />
        {pipe}
        {d ? (
          <>
            <Stat label="CRIT"  value={d.critical ?? '—'} color={(d.critical ?? 0) > 0 ? '#ff2244' : MUT} blink={(d.critical ?? 0) > 0} />
            <span style={{ color: MUT, margin: '0 4px', fontSize: 10 }}>·</span>
            <Stat label="HIGH"  value={d.high ?? '—'}     color="#ff8800" />
            <span style={{ color: MUT, margin: '0 4px', fontSize: 10 }}>·</span>
            <Stat label="MED"   value={d.medium ?? '—'}   color="#ffcc00" />
            {pipe}
            <Stat label="AVG DANGER" value={dangerStats?.avgScore != null ? `${dangerStats.avgScore}/100` : '—'} color={G} />
          </>
        ) : (
          <span style={{ fontSize: 9, color: MUT, flexShrink: 0 }}>DANGER SCORES LOADING…</span>
        )}
        {pipe}
        <span style={{ fontSize: 10, color: MUT, flexShrink: 0 }}>TLE</span>
        <span style={{ fontSize: 10, color: '#b0c8d8', marginLeft: 4, flexShrink: 0 }}>{tleAge}</span>
      </div>

      {/* Plan Mission button — pinned to the right, never clipped */}
      <div style={{ flexShrink: 0, paddingRight: 14, paddingLeft: 10 }}>
        <PlanMissionButton active={plannerOpen} onClick={onPlanMission} />
      </div>
    </div>
  );
}

function PlanMissionButton({ active, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        fontFamily: "'Courier New', monospace",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: '5px 14px',
        cursor: 'pointer',
        border: 'none',
        borderRadius: 2,
        background: active
          ? '#4f8ef7'
          : hovered
          ? 'rgba(79,142,247,0.25)'
          : 'rgba(79,142,247,0.12)',
        color: active ? '#fff' : (hovered ? '#a0c8ff' : '#4f8ef7'),
        outline: active ? '1px solid #4f8ef7' : hovered ? '1px solid rgba(79,142,247,0.6)' : '1px solid rgba(79,142,247,0.3)',
        transition: 'background 0.15s, color 0.15s, outline 0.15s',
        whiteSpace: 'nowrap',
      }}
    >
      🛰 PLAN MISSION
    </button>
  );
}

function Stat({ label, value, color, blink }) {
  return (
    <span
      style={{ fontSize: 10, flexShrink: 0 }}
      className={blink ? 'mil-threat-blink' : ''}
    >
      <span style={{ color, fontWeight: 700 }}>{value}</span>
      <span style={{ color: '#3a5a6a', marginLeft: 4 }}>{label}</span>
    </span>
  );
}

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const satellites            = useStore((s) => s.satellites);
  const conjunctions          = useStore((s) => s.conjunctions);
  const stats                 = useStore((s) => s.stats);
  const selectedNoradId       = useStore((s) => s.selectedNoradId);
  const setSatellites         = useStore((s) => s.setSatellites);
  const setConjunctions       = useStore((s) => s.setConjunctions);
  const setStats              = useStore((s) => s.setStats);
  const selectSatellite       = useStore((s) => s.selectSatellite);
  const getFilteredSatellites = useStore((s) => s.getFilteredSatellites);
  const setLoadingState       = useStore((s) => s.setLoadingState);
  const setLoadedCount        = useStore((s) => s.setLoadedCount);
  const addError              = useStore((s) => s.addError);
  const missionPlannerOpen      = useStore((s) => s.missionPlannerOpen);
  const openMissionPlanner      = useStore((s) => s.openMissionPlanner);
  const closeMissionPlanner     = useStore((s) => s.closeMissionPlanner);
  const isSelectingLaunchSite   = useStore((s) => s.isSelectingLaunchSite);

  const [dangerStats, setDangerStats] = useState(null);

  const retryTimerRef = useRef(null);
  const emptyRetryRef = useRef(0);

  const fetchSatellites = useCallback(async (isFirst = false) => {
    if (isFirst) setLoadingState('loading');
    clearTimeout(retryTimerRef.current);
    try {
      const { data } = await axios.get('/api/satellites', { params: { category: 'debris', limit: 10000 } });
      const sats = data.satellites ?? [];
      const catCounts = sats.reduce((acc, s) => { acc[s.category ?? 'null'] = (acc[s.category ?? 'null'] ?? 0) + 1; return acc; }, {});
      console.log(`[app] fetchSatellites → ${sats.length} objects | categories:`, catCounts);
      console.log('[app] first 10 objects:', sats.slice(0, 10).map((s) => ({ norad: s.norad_id, name: s.name, category: s.category })));
      setSatellites(sats);
      setLoadedCount(sats.length);
      if (isFirst) setLoadingState('ready');
      if (sats.length === 0 && emptyRetryRef.current < 24) {
        emptyRetryRef.current += 1;
        retryTimerRef.current = setTimeout(() => fetchSatellites(false), 5_000);
      } else {
        emptyRetryRef.current = 0;
      }
    } catch (err) {
      const isNetworkErr = !err.response;
      console.error('[app] fetch satellites:', err.message);
      if (isNetworkErr) {
        addError('connection', 'Server unreachable — retrying in 5s…');
        retryTimerRef.current = setTimeout(() => fetchSatellites(isFirst), 5_000);
      } else {
        addError('satellites', err.message);
        if (isFirst) setLoadingState('error');
      }
    }
  }, [setSatellites, setLoadingState, setLoadedCount, addError]);

  const fetchConjunctions = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/conjunctions', { params: { hoursAhead: 72, limit: 100 } });
      setConjunctions(data.conjunctions ?? []);
    } catch (err) {
      console.error('[app] fetch conjunctions:', err.message);
    }
  }, [setConjunctions]);

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/stats');
      setStats(data);
    } catch (err) {
      console.error('[app] fetch stats:', err.message);
    }
  }, [setStats]);

  const fetchDangerStats = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/danger-stats');
      setDangerStats(data);
    } catch (err) {
      console.error('[app] fetch danger-stats:', err.message);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.VITE_CESIUM_TOKEN) {
      addError('no-token', 'Cesium Ion token missing — globe imagery will be limited');
    }
  }, [addError]);

  useEffect(() => {
    fetchSatellites(true);
    fetchConjunctions();
    fetchStats();
    fetchDangerStats();
    const satTimer    = setInterval(() => fetchSatellites(false), 60_000);
    const conjTimer   = setInterval(fetchConjunctions, 300_000);
    const statsTimer  = setInterval(fetchStats, 60_000);
    const dangerTimer = setInterval(fetchDangerStats, 300_000);
    return () => { clearInterval(satTimer); clearInterval(conjTimer); clearInterval(statsTimer); clearInterval(dangerTimer); };
  }, [fetchSatellites, fetchConjunctions, fetchStats, fetchDangerStats]);

  const filteredSatellites = getFilteredSatellites();
  const conjunctionIds = new Set(conjunctions.flatMap((c) => [c.sat1_norad, c.sat2_norad]));

  return (
    <>
      <LoadingSplash />

      {/* Globe viewport */}
      <div style={S.globeWrap}>
        <Globe
          satellites={filteredSatellites}
          selectedNoradId={selectedNoradId}
          onSatelliteSelect={selectSatellite}
          conjunctionIds={conjunctionIds}
        />
      </div>

      {/* Left sidebar */}
      <div style={S.sidebar}>
        <Sidebar />
      </div>

      {/* Top stats bar */}
      <StatsBar
        stats={stats}
        dangerStats={dangerStats}
        onPlanMission={missionPlannerOpen ? closeMissionPlanner : openMissionPlanner}
        plannerOpen={missionPlannerOpen}
      />

      {/* Mission planner backdrop + panel */}
      {missionPlannerOpen && (
        <>
          {/* Semi-transparent backdrop — disabled during launch site selection so clicks reach the globe */}
          <div
            onClick={isSelectingLaunchSite ? undefined : closeMissionPlanner}
            style={{
              position: 'fixed',
              left: SIDEBAR_W,
              top: TOPBAR_H,
              right: 0,
              bottom: BOTTOMBAR_H,
              background: isSelectingLaunchSite ? 'transparent' : 'rgba(0,0,0,0.45)',
              zIndex: 190,
              pointerEvents: isSelectingLaunchSite ? 'none' : 'auto',
              cursor: isSelectingLaunchSite ? 'crosshair' : 'default',
            }}
          />
          <MissionPlanner />
        </>
      )}

      {/* Error banners */}
      <div style={S.errorArea}>
        <ErrorBanner />
      </div>

      {/* Right detail panel */}
      <div style={S.satCard}>
        <SatCard />
      </div>

      {/* Bottom bar: time controls + conjunction alerts */}
      <div style={S.bottomBar}>
        <TimeControls />
        <AlertPanel />
      </div>
    </>
  );
}
