import { useEffect, useRef, useCallback } from 'react';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as satellite from 'satellite.js';
import { useStore } from '../store/useStore';

// ── Danger-score colour / size helpers ─────────────────────────────────────
//
// Thresholds mirror scorer.js:
//   >=80  critical  → red
//   60-79 high      → orange
//   40-59 medium    → yellow
//   20-39 low       → green
//   <20   minimal   → dim teal (unscored / decaying debris)
//
// Fixed colours for special states:
const COLOR_CONJUNCTION = Cesium.Color.fromCssColorString('#f76b6b');
const COLOR_SELECTED    = Cesium.Color.WHITE;
const COLOR_FLASH       = Cesium.Color.RED;

// Pre-build the five danger colours once (avoid allocations in RAF loop)
const DANGER_COLORS = {
  critical: Cesium.Color.fromCssColorString('#ff2244'),  // >=80
  high:     Cesium.Color.fromCssColorString('#ff8800'),  // 60-79
  medium:   Cesium.Color.fromCssColorString('#ffcc00'),  // 40-59
  low:      Cesium.Color.fromCssColorString('#00cc66'),  // 20-39
  minimal:  Cesium.Color.fromCssColorString('#3a6070'),  // <20 / unscored
};

function getDangerColor(score) {
  const s = score ?? 0;
  if (s >= 80) return DANGER_COLORS.critical;
  if (s >= 60) return DANGER_COLORS.high;
  if (s >= 40) return DANGER_COLORS.medium;
  if (s >= 20) return DANGER_COLORS.low;
  return DANGER_COLORS.minimal;
}

function getDangerPixelSize(score, isSelected, isConjunction) {
  if (isSelected)    return 8;
  if (isConjunction) return 6;
  const s = score ?? 0;
  if (s >= 80) return 4;
  if (s >= 60) return 3;
  if (s >= 40) return 2.5;
  return 2;
}

function colorForSat(isSelected, isConjunction, isFlashing, dangerScore) {
  if (isFlashing)    return COLOR_FLASH;
  if (isSelected)    return COLOR_SELECTED;
  if (isConjunction) return COLOR_CONJUNCTION;
  return getDangerColor(dangerScore);
}

function sizeForSat(isSelected, isConjunction, dangerScore) {
  return getDangerPixelSize(dangerScore, isSelected, isConjunction);
}

// ── SGP4 main-thread helper ────────────────────────────────────────────────

function propagateOne(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position) return null;
    const { x, y, z } = pv.position;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    const gmst = satellite.gstime(date);
    const geo  = satellite.eciToGeodetic(pv.position, gmst);
    const lat  = satellite.degreesLat(geo.latitude);
    const lon  = satellite.degreesLong(geo.longitude);
    const alt  = geo.height;
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt) || alt < -100) return null;
    return { lat, lon, altKm: alt };
  } catch { return null; }
}

// ── Batch cache helpers ────────────────────────────────────────────────────

// Interpolate linearly between two position sets at time t
function interpolateFrames(frameA, frameB, t) {
  if (!frameA || !frameB) return frameA ?? frameB ?? [];
  const alpha = (t - frameA.ts) / (frameB.ts - frameA.ts);
  const map = new Map();
  for (const p of frameA.positions) map.set(p.norad_id, p);
  const result = [];
  for (const pb of frameB.positions) {
    const pa = map.get(pb.norad_id);
    if (!pa) { result.push(pb); continue; }
    result.push({
      norad_id: pb.norad_id,
      lat:   pa.lat  + (pb.lat  - pa.lat)  * alpha,
      lon:   pa.lon  + (pb.lon  - pa.lon)  * alpha,
      altKm: pa.altKm + (pb.altKm - pa.altKm) * alpha,
    });
  }
  return result;
}

// ── Component ─────────────────────────────────────────────────────────────

export default function Globe({
  satellites = [],
  selectedNoradId,
  onSatelliteSelect,
  conjunctionIds = new Set(),
}) {
  const containerRef  = useRef(null);
  const viewerRef     = useRef(null);
  const pointsRef     = useRef(null);
  const trailRef      = useRef(null);         // selected orbit trail
  const futureTrailsRef = useRef([]);         // prediction polylines for conj pair
  const conjLineRef   = useRef(null);         // live conjunction line primitive
  const satrecs       = useRef([]);
  const noradToPoint  = useRef(new Map());
  const rafRef        = useRef(null);

  // Mission visualization refs
  const launchMarkerRef    = useRef(null);    // PointPrimitive entity for launch site
  const missionPathRef     = useRef([]);      // Array of polyline primitives for path
  const interceptLabelsRef = useRef(null);    // LabelCollection for intercept markers

  // Batch worker for high-speed playback
  const batchWorkerRef  = useRef(null);
  const batchCacheRef   = useRef([]);         // [{ts, positions:[]}] sorted asc
  const batchBusyRef    = useRef(false);

  // Single-frame worker (legacy, for live mode)
  const workerRef       = useRef(null);
  const workerBusy      = useRef(false);

  const lastWallRef          = useRef(null);   // wall-clock ms of last RAF tick
  const lastTickSimRef       = useRef(0);      // simTime at last render tick
  const lastFutureTrailSimRef = useRef(0);     // simTime when futureTrails last ran
  const LIVE_TICK_MS    = 1000;

  // ── Store refs (avoid stale closures in RAF) ────────────────────────────
  const isLiveRef     = useRef(true);
  const isPlayingRef  = useRef(false);
  const speedRef      = useRef(1);
  const simTimeRef    = useRef(Date.now());
  const conjunctionsRef = useRef([]);

  const selectedRef    = useRef(selectedNoradId);
  const conjIdsRef     = useRef(conjunctionIds);
  const onSelectRef    = useRef(onSatelliteSelect);

  // Subscribe to store changes and mirror to refs
  useEffect(() => {
    const unsub = useStore.subscribe((state) => {
      isLiveRef.current    = state.isLive;
      isPlayingRef.current = state.isPlaying;
      speedRef.current     = state.playbackSpeed;
      simTimeRef.current   = state.simulatedTime;
      conjunctionsRef.current = state.conjunctions;
    });
    // Seed initial values
    const s = useStore.getState();
    isLiveRef.current    = s.isLive;
    isPlayingRef.current = s.isPlaying;
    speedRef.current     = s.playbackSpeed;
    simTimeRef.current   = s.simulatedTime;
    conjunctionsRef.current = s.conjunctions;
    return unsub;
  }, []);

  // ── Mission state from store ──────────────────────────────────────────
  const launchSite            = useStore((s) => s.launchSite);
  const missionPlan           = useStore((s) => s.missionPlan);
  const isSelectingLaunchSite = useStore((s) => s.isSelectingLaunchSite);

  useEffect(() => { selectedRef.current  = selectedNoradId; }, [selectedNoradId]);
  useEffect(() => { conjIdsRef.current   = conjunctionIds;  }, [conjunctionIds]);
  useEffect(() => { onSelectRef.current  = onSatelliteSelect; }, [onSatelliteSelect]);

  // ── Orbit trail for selected satellite ───────────────────────────────────

  const updateOrbitTrail = useCallback((viewer, noradId, simTime) => {
    if (trailRef.current) { viewer.scene.primitives.remove(trailRef.current); trailRef.current = null; }
    if (!noradId) return;
    const entry = satrecs.current.find((s) => s.norad_id === noradId);
    if (!entry) return;

    const base       = simTime ?? Date.now();
    const periodMs   = (2 * Math.PI / entry.satrec.no) * 60_000;
    const numPoints  = 128;
    const stepMs     = periodMs / numPoints;
    const positions  = [];

    for (let i = 0; i <= numPoints; i++) {
      const pos = propagateOne(entry.satrec, new Date(base + i * stepMs));
      if (pos) positions.push(Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000));
    }
    if (positions.length < 2) return;

    trailRef.current = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({ positions, width: 1.5, arcType: Cesium.ArcType.NONE }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString('#a78bfa').withAlpha(0.6)
          ),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
    }));
  }, []);

  // ── Future prediction trails for conjunction pair (non-live) ────────────

  const updateFutureTrails = useCallback((viewer, simTime) => {
    for (const p of futureTrailsRef.current) {
      if (!viewer.scene.primitives.contains(p)) continue;
      viewer.scene.primitives.remove(p);
    }
    futureTrailsRef.current = [];

    const isLive = isLiveRef.current;
    const conjs  = conjunctionsRef.current;
    if (isLive || !conjs.length) return;

    // Draw 10-min future trail for each sat in the top conjunction
    const top = [...conjs].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0];
    if (!top) return;

    const norads = [top.sat1_norad, top.sat2_norad];
    const baseMs = simTime ?? Date.now();
    const stepMs = 30_000;  // 30s intervals
    const steps  = 20;      // 10 min ahead

    for (const norad of norads) {
      const entry = satrecs.current.find((s) => s.norad_id === norad);
      if (!entry) continue;

      const positions = [];
      for (let i = 0; i <= steps; i++) {
        const pos = propagateOne(entry.satrec, new Date(baseMs + i * stepMs));
        if (pos) positions.push(Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000));
      }
      if (positions.length < 2) continue;

      const prim = viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({ positions, width: 1.0, arcType: Cesium.ArcType.NONE }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString('#f76b6b').withAlpha(0.35)
            ),
          },
        }),
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        asynchronous: false,
      }));
      futureTrailsRef.current.push(prim);
    }
  }, []);

  // ── Conjunction flash line ────────────────────────────────────────────────

  function updateConjunctionLine(viewer, conj, simTime) {
    if (conjLineRef.current) {
      viewer.scene.primitives.remove(conjLineRef.current);
      conjLineRef.current = null;
    }
    if (!conj) return;

    const e1 = satrecs.current.find((s) => s.norad_id === conj.sat1_norad);
    const e2 = satrecs.current.find((s) => s.norad_id === conj.sat2_norad);
    if (!e1 || !e2) return;

    const date = new Date(simTime);
    const p1   = propagateOne(e1.satrec, date);
    const p2   = propagateOne(e2.satrec, date);
    if (!p1 || !p2) return;

    conjLineRef.current = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions: [
            Cesium.Cartesian3.fromDegrees(p1.lon, p1.lat, p1.altKm * 1000),
            Cesium.Cartesian3.fromDegrees(p2.lon, p2.lat, p2.altKm * 1000),
          ],
          width: 2.0,
          arcType: Cesium.ArcType.NONE,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString('#f76b6b').withAlpha(0.8)
          ),
        },
      }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
    }));
  }

  // ── Rebuild PointPrimitiveCollection ────────────────────────────────────

  const rebuildPoints = useCallback((viewer, sats) => {
    if (!viewer || viewer.isDestroyed()) return;

    // ── Diagnostic: verify danger_score is present in incoming data ─────────
    console.log('[globe] Sample satellites (danger_score check):',
      sats.slice(0, 5).map((s) => ({ norad: s.norad_id, score: s.danger_score ?? 'MISSING' }))
    );

    const newSatrecs = [];
    for (const sat of sats) {
      try {
        const sr = satellite.twoline2satrec(sat.tle_line1, sat.tle_line2);
        newSatrecs.push({
          norad_id:    sat.norad_id,
          satrec:      sr,
          category:    sat.category,
          name:        sat.name,
          danger_score: sat.danger_score ?? 0,  // carry score into the RAF loop
        });
      } catch { /* skip */ }
    }
    satrecs.current = newSatrecs;

    if (pointsRef.current) viewer.scene.primitives.remove(pointsRef.current);
    const collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    pointsRef.current = collection;

    const now    = new Date(simTimeRef.current);
    const newMap = new Map();

    // Colour distribution counters for logging
    let colorCounts = { critical: 0, high: 0, medium: 0, low: 0, minimal: 0 };

    for (const entry of newSatrecs) {
      const pos           = propagateOne(entry.satrec, now);
      const isSelected    = entry.norad_id === selectedRef.current;
      const isConjunction = conjIdsRef.current.has(entry.norad_id);
      const s             = entry.danger_score;
      const col           = colorForSat(isSelected, isConjunction, false, s);

      if (!isSelected && !isConjunction) {
        if (s >= 80)      colorCounts.critical++;
        else if (s >= 60) colorCounts.high++;
        else if (s >= 40) colorCounts.medium++;
        else if (s >= 20) colorCounts.low++;
        else              colorCounts.minimal++;
      }

      const point = collection.add({
        position:    pos
          ? Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000)
          : Cesium.Cartesian3.fromDegrees(0, 0, 0),
        color:        col,
        pixelSize:    sizeForSat(isSelected, isConjunction, s),
        outlineColor: isConjunction ? COLOR_CONJUNCTION.withAlpha(0.4) : Cesium.Color.TRANSPARENT,
        outlineWidth: isConjunction ? 3 : 0,
        show:         !!pos,
        id:           entry.norad_id,
      });
      newMap.set(entry.norad_id, point);
    }

    noradToPoint.current = newMap;
    batchCacheRef.current = [];
    console.log(
      `[globe] Rendering ${newSatrecs.length} debris objects on globe`
      + ` | Total colored: ${colorCounts.critical} red, ${colorCounts.high} orange,`
      + ` ${colorCounts.medium} yellow, ${colorCounts.low} green, ${colorCounts.minimal} dim`
    );
  }, []);

  // ── Batch worker: request next window of frames ──────────────────────────

  function requestBatch(startTs) {
    const bw = batchWorkerRef.current;
    if (!bw || batchBusyRef.current) return;

    const speed   = speedRef.current;
    // Cover 15 real-seconds of simulated time ahead
    const simWindowMs = 15_000 * speed;
    const numSteps    = 60;
    const stepMs      = simWindowMs / numSteps;

    batchBusyRef.current = true;
    const payload = satrecs.current.map((e) => ({ ...e.satrec, _norad_id: e.norad_id }));
    bw.postMessage({ satrecs: payload, startTs, stepMs, numSteps });
  }

  // ── RAF propagation tick ─────────────────────────────────────────────────

  const tick = useCallback((wallMs) => {
    rafRef.current = requestAnimationFrame(tick);

    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const isLive    = isLiveRef.current;
    const isPlaying = isPlayingRef.current;
    const speed     = speedRef.current;
    const collection = pointsRef.current;
    if (!collection) return;

    // ── Advance simulated time if playing ────────────────────────────────
    let simNow;
    if (isLive) {
      simNow = Date.now();
    } else if (isPlaying) {
      const wallDelta = lastWallRef.current != null ? wallMs - lastWallRef.current : 0;
      const newSim    = simTimeRef.current + wallDelta * speed;
      useStore.getState()._advanceSimTime(newSim);
      simNow = newSim;
    } else {
      simNow = simTimeRef.current;
    }
    lastWallRef.current = wallMs;

    // ── Throttle propagation: skip if simTime hasn't moved enough ────────
    const simDelta = Math.abs(simNow - lastTickSimRef.current);
    const minSimDelta = isLive ? LIVE_TICK_MS : (speed >= 60 ? 0 : 500);
    if (simDelta < minSimDelta) return;
    lastTickSimRef.current = simNow;

    const now        = new Date(simNow);
    const selectedId = selectedRef.current;
    const conjIds    = conjIdsRef.current;
    const conjs      = conjunctionsRef.current;

    // ── Conjunction flash: find active conjunction (within ±5 min of TCA) ─
    let activeConj = null;
    const FLASH_WINDOW_MS = 5 * 60_000;
    for (const c of conjs) {
      if (!c.tca) continue;
      if (Math.abs(new Date(c.tca).getTime() - simNow) < FLASH_WINDOW_MS) {
        activeConj = c; break;
      }
    }

    const flashNorads = activeConj
      ? new Set([activeConj.sat1_norad, activeConj.sat2_norad])
      : new Set();

    // Update conjunction warning line
    if (activeConj) {
      updateConjunctionLine(viewer, activeConj, simNow);
    } else if (conjLineRef.current) {
      viewer.scene.primitives.remove(conjLineRef.current);
      conjLineRef.current = null;
    }

    // ── Choose propagation path ──────────────────────────────────────────
    if (!isLive && isPlaying && speed >= 60 && batchWorkerRef.current) {
      // High-speed: use batch cache + interpolation
      const cache = batchCacheRef.current;

      // Trim old frames
      while (cache.length > 1 && cache[1].ts <= simNow) cache.shift();

      // Interpolate
      if (cache.length >= 2 && cache[0].ts <= simNow && simNow <= cache[cache.length - 1].ts) {
        let lo = 0;
        for (let i = 0; i < cache.length - 1; i++) {
          if (cache[i].ts <= simNow && simNow <= cache[i + 1].ts) { lo = i; break; }
        }
        const positions = interpolateFrames(cache[lo], cache[lo + 1], simNow);
        applyPositions(positions, selectedId, conjIds, flashNorads);
      }

      // Request next batch when cache is running low (< 20 frames remaining)
      if (cache.length < 20 && !batchBusyRef.current) {
        const nextStart = cache.length ? cache[cache.length - 1].ts : simNow;
        requestBatch(nextStart);
      }

      // If cache is empty, fall through to main-thread propagation to avoid blank frame
      if (!cache.length) {
        propagateMainThread(now, selectedId, conjIds, flashNorads);
      }
    } else if (isLive && workerRef.current && !workerBusy.current) {
      // Live mode: use single-frame worker
      workerBusy.current = true;
      const payload = satrecs.current.map((e) => ({ ...e.satrec, _norad_id: e.norad_id }));
      workerRef.current.postMessage({ satrecs: payload, timestamp: now.getTime() });
    } else {
      // Default: main-thread propagation
      propagateMainThread(now, selectedId, conjIds, flashNorads);
    }

    // ── Flash conjunction pair ───────────────────────────────────────────
    for (const norad of flashNorads) {
      const point = noradToPoint.current.get(norad);
      if (!point) continue;
      const flashOn = Math.floor(wallMs / 250) % 2 === 0;
      point.color     = flashOn ? Cesium.Color.RED : Cesium.Color.fromCssColorString('#f76b6b').withAlpha(0.6);
      point.pixelSize = 8;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function propagateMainThread(now, selectedId, conjIds, flashNorads) {
    const collection = pointsRef.current;
    if (!collection) return;
    for (const entry of satrecs.current) {
      const point = noradToPoint.current.get(entry.norad_id);
      if (!point) continue;
      const pos = propagateOne(entry.satrec, now);
      if (pos) {
        point.position = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000);
        point.show = true;
      } else {
        point.show = false;
      }
      if (!flashNorads.has(entry.norad_id)) {
        const isSelected    = entry.norad_id === selectedId;
        const isConjunction = conjIds.has(entry.norad_id);
        point.color        = colorForSat(isSelected, isConjunction, false, entry.danger_score);
        point.pixelSize    = sizeForSat(isSelected, isConjunction, entry.danger_score);
        point.outlineColor = isConjunction ? COLOR_CONJUNCTION.withAlpha(0.4) : Cesium.Color.TRANSPARENT;
        point.outlineWidth = isConjunction ? 3 : 0;
      }
    }
  }

  function applyPositions(positions, selectedId, conjIds, flashNorads) {
    for (const pos of positions) {
      const point = noradToPoint.current.get(pos.norad_id);
      if (!point) continue;
      point.position = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altKm * 1000);
      point.show = true;
    }
    for (const entry of satrecs.current) {
      const point = noradToPoint.current.get(entry.norad_id);
      if (!point || flashNorads.has(entry.norad_id)) continue;
      const isSelected    = entry.norad_id === selectedId;
      const isConjunction = conjIds.has(entry.norad_id);
      point.color     = colorForSat(isSelected, isConjunction, false, entry.danger_score);
      point.pixelSize = sizeForSat(isSelected, isConjunction, entry.danger_score);
    }
  }

  // ── Viewer initialisation ─────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    // Set CESIUM_BASE_URL on window before any Cesium code runs so the
    // pre-bundled worker loader can resolve assets at runtime.
    window.CESIUM_BASE_URL = '/cesium';

    const cesiumToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';
    const hasValidToken = cesiumToken && cesiumToken !== 'your_cesium_token_here';
    Cesium.Ion.defaultAccessToken = hasValidToken ? cesiumToken : '';

    // Move Cesium's credit widget into a hidden off-screen div so it doesn't
    // render a large globe icon / attribution bar below the viewer.
    const hiddenCredit = document.createElement('div');
    hiddenCredit.style.display = 'none';
    document.body.appendChild(hiddenCredit);

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker:      false,
      imageryProvider:      false, // added below, conditionally
      timeline:             false,
      animation:            false,
      infoBox:              false,
      selectionIndicator:   false,
      homeButton:           false,
      sceneModePicker:      false,
      navigationHelpButton: false,
      geocoder:             false,
      fullscreenButton:     false,
      creditContainer:      hiddenCredit,
      skyBox:               new Cesium.SkyBox({ show: true }),
      skyAtmosphere:        new Cesium.SkyAtmosphere(),
      scene3DOnly:          true,
      shadows:              false,
      requestRenderMode:    false,
    });

    // Imagery: use Bing via Ion if we have a valid token, else free OSM tiles
    if (hasValidToken) {
      try {
        viewer.imageryLayers.addImageryProvider(new Cesium.IonImageryProvider({ assetId: 2 }));
      } catch {
        viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({
          url: 'https://tile.openstreetmap.org/',
        }));
      }
    } else {
      viewer.imageryLayers.addImageryProvider(new Cesium.OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
      }));
    }

    viewer.scene.globe.enableLighting    = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#000005');
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 20, 25_000_000) });
    viewerRef.current = viewer;

    // Terrain: async Ion terrain, silent fallback to ellipsoid if token missing
    if (hasValidToken) {
      Cesium.CesiumTerrainProvider.fromIonAssetId(1, { requestWaterMask: false, requestVertexNormals: false })
        .then((tp) => { if (!viewer.isDestroyed()) viewer.terrainProvider = tp; })
        .catch(() => { /* fall back to default ellipsoid */ });
    }

    // Click handler — supports both satellite selection and launch site placement
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
      const storeState = useStore.getState();
      if (storeState.isSelectingLaunchSite) {
        // Pick position on globe surface
        const ray      = viewer.camera.getPickRay(click.position);
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (cartesian) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          const lat = Cesium.Math.toDegrees(carto.latitude);
          const lon = Cesium.Math.toDegrees(carto.longitude);
          storeState.setLaunchSite({ lat, lon });
        }
        return;
      }
      const picked = viewer.scene.pick(click.position);
      if (picked && typeof picked.id === 'number') onSelectRef.current?.(picked.id);
      else onSelectRef.current?.(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Single-frame worker (live mode)
    try {
      const w = new Worker('/propagation.worker.js');
      w.onmessage = (e) => {
        workerBusy.current = false;
        const { positions } = e.data;
        if (positions?.length) applyPositions(positions, selectedRef.current, conjIdsRef.current, new Set());
      };
      w.onerror = () => { workerBusy.current = false; };
      workerRef.current = w;
    } catch { workerRef.current = null; }

    // Batch worker (high-speed playback) — Vite-bundled ES module worker
    try {
      const bw = new Worker(new URL('../workers/batch.worker.js', import.meta.url), { type: 'module' });
      bw.onmessage = (e) => {
        batchBusyRef.current = false;
        const { frames } = e.data;
        if (!frames?.length) return;
        // Merge into cache, keeping it sorted and bounded to 200 frames
        const cache = batchCacheRef.current;
        for (const f of frames) cache.push(f);
        cache.sort((a, b) => a.ts - b.ts);
        if (cache.length > 200) cache.splice(0, cache.length - 200);
      };
      bw.onerror = () => { batchBusyRef.current = false; };
      batchWorkerRef.current = bw;
    } catch { batchWorkerRef.current = null; }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      handler.destroy();
      workerRef.current?.terminate();
      batchWorkerRef.current?.terminate();
      if (!viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      hiddenCredit.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rebuild points when satellite list changes ────────────────────────────

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    rebuildPoints(viewer, satellites);
  }, [satellites, rebuildPoints]);

  // ── Orbit trail when selection changes ───────────────────────────────────

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    updateOrbitTrail(viewer, selectedNoradId, simTimeRef.current);

    for (const entry of satrecs.current) {
      const point = noradToPoint.current.get(entry.norad_id);
      if (!point) continue;
      const isSelected    = entry.norad_id === selectedNoradId;
      const isConjunction = conjIdsRef.current.has(entry.norad_id);
      point.color     = colorForSat(isSelected, isConjunction, false, entry.danger_score);
      point.pixelSize = sizeForSat(isSelected, isConjunction, entry.danger_score);
    }
  }, [selectedNoradId, updateOrbitTrail]);

  // ── Future trails + orbit trail when sim-time changes (non-live) ─────────

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    // Use store value directly since this fires on every simulatedTime change
    const { simulatedTime, isLive } = useStore.getState();
    if (!isLive) {
      // Only re-run futureTrails if simTime changed by more than 30 seconds
      if (Math.abs(simulatedTime - lastFutureTrailSimRef.current) > 30_000) {
        lastFutureTrailSimRef.current = simulatedTime;
        updateFutureTrails(viewer, simulatedTime);
      }
      updateOrbitTrail(viewer, selectedNoradId, simulatedTime);
    }
  }); // intentionally run every render — gated inside by isLive check

  // ── Re-colour when conjunction set changes ────────────────────────────────

  useEffect(() => {
    for (const entry of satrecs.current) {
      const point = noradToPoint.current.get(entry.norad_id);
      if (!point) continue;
      const isSelected    = entry.norad_id === selectedRef.current;
      const isConjunction = conjunctionIds.has(entry.norad_id);
      point.color        = colorForSat(isSelected, isConjunction, false, entry.danger_score);
      point.pixelSize    = sizeForSat(isSelected, isConjunction, entry.danger_score);
      point.outlineColor = isConjunction ? COLOR_CONJUNCTION.withAlpha(0.4) : Cesium.Color.TRANSPARENT;
      point.outlineWidth = isConjunction ? 3 : 0;
    }
  }, [conjunctionIds]);

  // ── Launch site marker ───────────────────────────────────────────────────

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    // Remove old marker
    if (launchMarkerRef.current) {
      viewer.entities.remove(launchMarkerRef.current);
      launchMarkerRef.current = null;
    }

    if (!launchSite) return;

    launchMarkerRef.current = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(launchSite.lon, launchSite.lat, 0),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#00ff64'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: 'LAUNCH',
        font: '11px Courier New',
        fillColor: Cesium.Color.fromCssColorString('#00ff64'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      },
    });
  }, [launchSite]);

  // ── Mission path visualization ────────────────────────────────────────────

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    // Clear old mission path polylines
    for (const p of missionPathRef.current) {
      if (viewer.scene.primitives.contains(p)) viewer.scene.primitives.remove(p);
    }
    missionPathRef.current = [];

    // Clear old intercept labels
    if (interceptLabelsRef.current) {
      viewer.scene.primitives.remove(interceptLabelsRef.current);
      interceptLabelsRef.current = null;
    }

    if (!missionPlan?.path?.length) return;

    // Build path segments, splitting at antimeridian crossings
    const pathPoints = missionPlan.path;
    let segment = [];
    const segments = [segment];

    for (let i = 0; i < pathPoints.length; i++) {
      const pt = pathPoints[i];
      if (i > 0) {
        const prev = pathPoints[i - 1];
        if (Math.abs(pt.lon - prev.lon) > 180) {
          // Antimeridian crossing — start new segment
          segment = [];
          segments.push(segment);
        }
      }
      segment.push(Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.altKm * 1000));
    }

    for (const seg of segments) {
      if (seg.length < 2) continue;
      const prim = viewer.scene.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: seg,
            width: 1.5,
            arcType: Cesium.ArcType.NONE,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString('#00ff64').withAlpha(0.45)
            ),
          },
        }),
        appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
        asynchronous: false,
      }));
      missionPathRef.current.push(prim);
    }

    // Intercept labels at each target position
    if (missionPlan.targets?.length) {
      const labelColl = viewer.scene.primitives.add(new Cesium.LabelCollection());
      interceptLabelsRef.current = labelColl;

      missionPlan.targets.forEach((t, i) => {
        if (t.interceptLat == null || t.interceptLon == null) return;
        labelColl.add({
          position: Cesium.Cartesian3.fromDegrees(t.interceptLon, t.interceptLat, (t.altKm ?? 400) * 1000 + 30_000),
          text: `#${i + 1}`,
          font: '10px Courier New',
          fillColor: Cesium.Color.fromCssColorString('#ff8800'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -6),
        });
      });
    }
  }, [missionPlan]);

  // ── Cursor style when selecting launch site ───────────────────────────────

  useEffect(() => {
    const canvas = viewerRef.current?.scene?.canvas;
    if (canvas) canvas.style.cursor = isSelectingLaunchSite ? 'crosshair' : '';
  }, [isSelectingLaunchSite]);

  return (
    <div
      ref={containerRef}
      id="cesium-container"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
