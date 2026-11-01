import { useState, useCallback } from 'react';
import axios from 'axios';
import { useStore } from '../store/useStore';

const G   = '#00ff64';
const MUT = '#3a5a6a';
const BG  = '#060b0f';
const SF  = '#08111a';
const TXT = '#b0c8d8';
const DIM = 'rgba(0,255,100,0.13)';

function dangerColor(score) {
  if (!score) return MUT;
  if (score >= 80) return '#ff2244';
  if (score >= 60) return '#ff8800';
  if (score >= 40) return '#ffcc00';
  return '#00cc66';
}

function Divider() {
  return <div style={{ borderTop: `1px solid ${DIM}`, margin: '8px 0' }} />;
}

function FieldLabel({ text }) {
  return (
    <div style={{ fontSize: 9, color: MUT, letterSpacing: 2, marginBottom: 4 }}>
      {text}
    </div>
  );
}

export default function MissionPlanner() {
  const closeMissionPlanner    = useStore((s) => s.closeMissionPlanner);
  const launchSite             = useStore((s) => s.launchSite);
  const launchTime             = useStore((s) => s.launchTime);
  const isSelectingLaunchSite  = useStore((s) => s.isSelectingLaunchSite);
  const missionPlan            = useStore((s) => s.missionPlan);
  const setLaunchTime          = useStore((s) => s.setLaunchTime);
  const setMissionPlan         = useStore((s) => s.setMissionPlan);
  const setSelectingLaunchSite = useStore((s) => s.setSelectingLaunchSite);
  const selectSatellite        = useStore((s) => s.selectSatellite);

  const [computing, setComputing] = useState(false);
  const [error,     setError]     = useState(null);

  // Default launch time = now + 1 hour, formatted for datetime-local input
  const defaultLaunchTime = (() => {
    const d = new Date(Date.now() + 3_600_000);
    return d.toISOString().slice(0, 16);
  })();

  const handleCompute = useCallback(async () => {
    if (!launchSite) { setError('Select a launch site on the globe first.'); return; }
    setComputing(true);
    setError(null);
    try {
      const lt = launchTime ?? defaultLaunchTime;
      const { data } = await axios.post('/api/optimize-path', {
        launchLat:  launchSite.lat,
        launchLon:  launchSite.lon,
        launchTime: new Date(lt).toISOString(),
      });
      setMissionPlan(data);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message ?? 'Compute failed');
    } finally {
      setComputing(false);
    }
  }, [launchSite, launchTime, defaultLaunchTime, setMissionPlan]);

  const plan = missionPlan;

  return (
    <div style={{
      position: 'fixed',
      left: 260,   // sidebar width
      top: 40,     // topbar height
      bottom: 50,  // bottombar height
      width: 300,
      background: BG,
      borderRight: `1px solid ${isSelectingLaunchSite ? 'rgba(79,142,247,0.7)' : DIM}`,
      boxShadow: isSelectingLaunchSite ? '0 0 0 1px rgba(79,142,247,0.4) inset' : 'none',
      zIndex: 200,
      display: 'flex',
      flexDirection: 'column',
      fontFamily: "'Courier New', monospace",
      overflow: 'hidden',
      transition: 'border-color 0.2s, box-shadow 0.2s',
    }}>
      {/* ── Header ── */}
      <div style={{
        padding: '12px 16px 10px',
        borderBottom: `1px solid ${DIM}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 9, color: G, letterSpacing: 3, marginBottom: 2 }}>
              MISSION PLANNER
            </div>
            <div style={{ fontSize: 11, color: TXT, letterSpacing: 3, fontWeight: 700 }}>
              DEBRIS INTERCEPT
            </div>
          </div>
          <button
            onClick={closeMissionPlanner}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: MUT, fontSize: 16, lineHeight: 1, flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

        {/* Launch site section */}
        <FieldLabel text="-- LAUNCH SITE --" />

        {/* Instruction banner shown only when actively selecting */}
        {isSelectingLaunchSite && (
          <div style={{
            background: 'rgba(79,142,247,0.1)',
            border: '1px solid rgba(79,142,247,0.5)',
            borderRadius: 2,
            padding: '8px 10px',
            marginBottom: 8,
            fontSize: 9,
            color: '#a0c8ff',
            letterSpacing: 0.5,
            lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 2, color: '#4f8ef7' }}>
              ◎ CLICK ANYWHERE ON THE GLOBE
            </div>
            <div style={{ color: '#6090b0' }}>
              Panel stays open. Click to place the launch site.
            </div>
          </div>
        )}

        {/* Coordinates display */}
        <div style={{
          background: SF,
          border: `1px solid ${launchSite ? 'rgba(0,255,100,0.25)' : DIM}`,
          borderRadius: 2,
          padding: '6px 10px',
          marginBottom: 8,
          fontSize: 10,
          color: launchSite ? G : MUT,
          minHeight: 36,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}>
          {launchSite ? (
            <>
              <div style={{ fontWeight: 700 }}>
                {launchSite.lat.toFixed(4)}°&nbsp;&nbsp;{launchSite.lon.toFixed(4)}°
              </div>
              <div style={{ fontSize: 8, color: MUT, marginTop: 2 }}>LAT / LON · CONFIRMED</div>
            </>
          ) : (
            <div style={{ fontSize: 9 }}>NO LAUNCH SITE SELECTED</div>
          )}
        </div>

        {/* Select / Cancel button */}
        <button
          onClick={() => setSelectingLaunchSite(!isSelectingLaunchSite)}
          style={{
            width: '100%',
            marginBottom: 12,
            padding: '6px 0',
            fontFamily: "'Courier New', monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1,
            cursor: 'pointer',
            border: 'none',
            borderRadius: 2,
            background: isSelectingLaunchSite
              ? 'rgba(79,142,247,0.2)'
              : launchSite
              ? 'rgba(0,255,100,0.08)'
              : 'rgba(79,142,247,0.15)',
            color: isSelectingLaunchSite ? '#4f8ef7' : launchSite ? G : '#4f8ef7',
            outline: isSelectingLaunchSite
              ? '1px solid rgba(79,142,247,0.6)'
              : launchSite
              ? '1px solid rgba(0,255,100,0.2)'
              : '1px solid rgba(79,142,247,0.4)',
            animation: isSelectingLaunchSite ? 'threat-blink 1s step-end infinite' : 'none',
          }}
        >
          {isSelectingLaunchSite
            ? '◎ SELECTING… CLICK GLOBE'
            : launchSite
            ? '↺ CHANGE LAUNCH SITE'
            : '⊕ SELECT ON GLOBE'}
        </button>

        <Divider />

        {/* Launch time */}
        <FieldLabel text="-- LAUNCH TIME --" />
        <input
          type="datetime-local"
          defaultValue={defaultLaunchTime}
          onChange={(e) => setLaunchTime(e.target.value ? new Date(e.target.value).toISOString() : null)}
          className="mil-input"
          style={{ width: '100%', marginBottom: 12 }}
        />

        <Divider />

        {/* Compute button */}
        <button
          className="mil-btn"
          disabled={computing || !launchSite}
          onClick={handleCompute}
          style={{
            width: '100%', textAlign: 'center', marginBottom: 8,
            opacity: (!launchSite || computing) ? 0.5 : 1,
          }}
        >
          {computing ? '[COMPUTING PATH…]' : '[CALCULATE MISSION]'}
        </button>

        {error && (
          <div style={{ fontSize: 9, color: '#ff2244', marginBottom: 8 }}>{error}</div>
        )}

        {/* ── Mission results ── */}
        {plan && (
          <>
            <Divider />
            <FieldLabel text="-- MISSION SUMMARY --" />

            <div style={{
              background: SF,
              border: `1px solid ${DIM}`,
              borderRadius: 2,
              padding: '8px 10px',
              marginBottom: 10,
              fontSize: 9,
            }}>
              <Row label="LAUNCH AZ" value={`${plan.launchAzimuth?.toFixed(1) ?? '—'}°`} />
              <Row label="TARGET ALT" value={`${plan.targetOrbit?.altKm?.toFixed(0) ?? '—'} km`} />
              <Row label="INCLINATION" value={`${plan.targetOrbit?.inclDeg?.toFixed(1) ?? '—'}°`} />
              <Row label="TARGETS" value={plan.stats?.totalTargets ?? '—'} />
              <Row label="DANGER REMOVED" value={plan.stats?.totalDangerRemoved ?? '—'} />
              <Row label="DELTA-V" value={`${plan.stats?.totalDeltaV?.toFixed(0) ?? '—'} m/s`} />
              <Row label="DURATION" value={`${plan.stats?.missionDurationHours?.toFixed(1) ?? '—'} hr`} />
            </div>

            <FieldLabel text={`-- INTERCEPT SEQUENCE (${plan.targets?.length ?? 0}) --`} />
            {(plan.targets ?? []).map((t, i) => (
              <div
                key={t.norad_id}
                onClick={() => selectSatellite(t.norad_id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px',
                  marginBottom: 3,
                  background: SF,
                  border: `1px solid ${DIM}`,
                  borderLeft: `3px solid ${dangerColor(t.danger_score)}`,
                  borderRadius: 2,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 9, color: MUT, flexShrink: 0 }}>#{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 9, color: TXT,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {t.name}
                  </div>
                  <div style={{ fontSize: 8, color: MUT, marginTop: 1 }}>
                    {t.norad_id} · {t.altKm?.toFixed(0)} km
                  </div>
                </div>
                <span style={{ fontSize: 9, fontWeight: 700, color: dangerColor(t.danger_score), flexShrink: 0 }}>
                  {t.danger_score}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{
        padding: '6px 16px',
        borderTop: `1px solid ${DIM}`,
        flexShrink: 0,
        fontSize: 8, color: '#203040', letterSpacing: 1, textAlign: 'center',
      }}>
        SIMPLIFIED KEPLERIAN MODEL · NOT FOR OPERATIONAL USE
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
      <span style={{ color: MUT, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color: '#00ff88', fontWeight: 700 }}>{value}</span>
    </div>
  );
}
