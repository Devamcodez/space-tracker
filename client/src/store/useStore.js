import { create } from 'zustand';

const ALL_CATEGORIES = ['debris'];

export const useStore = create((set, get) => ({
  // ── Data ──────────────────────────────────────────────────────────────
  satellites:   [],
  conjunctions: [],
  stats:        null,

  // ── Selection ─────────────────────────────────────────────────────────
  selectedSatellite: null,
  selectedNoradId:   null,
  isTracking:        false,

  // ── Time playback ─────────────────────────────────────────────────────
  simulatedTime:  Date.now(), // Unix ms — updated by the RAF loop when playing
  isLive:         true,
  isPlaying:      false,
  playbackSpeed:  1,          // 1 | 10 | 60 | 600 | 3600

  // ── Filters ───────────────────────────────────────────────────────────
  filters: {
    categories:   new Set(ALL_CATEGORIES),
    orbitRegime:  'all',
    search:       '',
  },

  // ── Mission Planner ───────────────────────────────────────────────────
  missionPlannerOpen:      false,
  launchSite:              null,   // { lat, lon } or null
  launchTime:              null,   // ISO string or null
  isSelectingLaunchSite:   false,
  missionPlan:             null,   // full response from POST /api/optimize-path or null

  openMissionPlanner:  () => set({ missionPlannerOpen: true }),
  closeMissionPlanner: () => set({ missionPlannerOpen: false, isSelectingLaunchSite: false }),
  setLaunchSite:       (site) => set({ launchSite: site, isSelectingLaunchSite: false }),
  setLaunchTime:       (iso)  => set({ launchTime: iso }),
  setMissionPlan:      (plan) => set({ missionPlan: plan }),
  setSelectingLaunchSite: (v) => set({ isSelectingLaunchSite: v }),

  // ── Loading / error state ────────────────────────────────────────────
  loadingState: 'idle',   // 'idle' | 'loading' | 'ready' | 'error'
  loadedCount: 0,
  errors: [],             // [{id, type, message, timestamp}]

  setLoadingState: (s) => set({ loadingState: s }),
  setLoadedCount: (n) => set({ loadedCount: n }),
  addError: (type, message) =>
    set((state) => ({
      errors: [
        ...state.errors.filter((e) => e.type !== type), // replace same-type error
        { id: Date.now(), type, message, timestamp: new Date().toISOString() },
      ],
    })),
  clearError: (type) =>
    set((state) => ({ errors: state.errors.filter((e) => e.type !== type) })),

  // ── Actions ───────────────────────────────────────────────────────────
  setSatellites:   (satellites)   => set({ satellites }),
  setConjunctions: (conjunctions) => set({ conjunctions }),
  setStats:        (stats)        => set({ stats }),

  selectSatellite: (noradId) => {
    if (noradId === null) {
      set({ selectedNoradId: null, selectedSatellite: null, isTracking: false });
      return;
    }
    set({ selectedNoradId: noradId });
  },

  setSelectedSatellite: (detail) => set({ selectedSatellite: detail }),
  setTracking: (v) => set({ isTracking: v }),

  // Time playback actions
  goLive: () => set({ isLive: true, isPlaying: false, simulatedTime: Date.now() }),
  setSimulatedTime: (ts) => set({ simulatedTime: ts, isLive: false }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
  // Called by the RAF loop — does NOT set isLive=false (already false when playing)
  _advanceSimTime: (ts) => set({ simulatedTime: ts }),

  jumpToNextConjunction: () => {
    const { conjunctions } = get();
    const now = Date.now();
    const next = conjunctions
      .filter((c) => c.tca && new Date(c.tca).getTime() > now)
      .sort((a, b) => new Date(a.tca) - new Date(b.tca))[0];
    if (next) set({ simulatedTime: new Date(next.tca).getTime(), isLive: false, isPlaying: false });
  },

  updateFilters: (patch) =>
    set((state) => ({ filters: { ...state.filters, ...patch } })),

  toggleCategory: (cat) =>
    set((state) => {
      const next = new Set(state.filters.categories);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return { filters: { ...state.filters, categories: next } };
    }),

  // ── Derived helpers ────────────────────────────────────────────────────
  getFilteredSatellites: () => {
    const { satellites, filters } = get();
    const { categories, orbitRegime, search } = filters;
    const q = search.trim().toLowerCase();

    return satellites.filter((sat) => {
      if (!categories.has(sat.category ?? 'unknown')) return false;

      if (q) {
        const nameMatch  = sat.name?.toLowerCase().includes(q);
        const noradMatch = String(sat.norad_id).includes(q);
        if (!nameMatch && !noradMatch) return false;
      }

      if (orbitRegime !== 'all') {
        const alt = sat.position?.altKm ?? null;
        if (alt === null) return false;
        if (orbitRegime === 'LEO' && !(alt <  2000))          return false;
        if (orbitRegime === 'MEO' && !(alt >= 2000 && alt < 35000)) return false;
        if (orbitRegime === 'GEO' && !(alt >= 35000 && alt < 37000)) return false;
        if (orbitRegime === 'HEO' && !(alt >= 37000))          return false;
      }

      return true;
    });
  },
}));

export { ALL_CATEGORIES };
