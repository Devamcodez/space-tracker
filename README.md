# SpaceTracker

Real-time satellite tracking and conjunction detection dashboard.

## Architecture

```
space-tracker/
├── server/                    # Node.js + Express backend
│   ├── index.js               # API server (port 3001)
│   ├── db.js                  # SQLite via better-sqlite3
│   ├── fetcher.js             # TLE ingestion (CelesTrak + Space-Track)
│   ├── propagator.js          # SGP4 orbit propagation (satellite.js)
│   ├── collision.js           # Conjunction detection (KD-tree)
│   └── scheduler.js           # node-cron jobs
├── client/                    # React + Vite frontend
│   └── src/
│       ├── App.jsx            # Root layout + data fetching
│       ├── store/useStore.js  # Zustand global state
│       ├── workers/           # Web Workers for SGP4 batch computation
│       └── components/
│           ├── Globe.jsx      # CesiumJS 3D globe
│           ├── Sidebar.jsx    # Filters + virtual satellite list
│           ├── SatCard.jsx    # Satellite detail panel
│           ├── AlertPanel.jsx # Conjunction alerts bar
│           └── TimeControls.jsx # Playback scrubber
└── package.json               # Workspace root (concurrently)
```

## Data Flow

```
CelesTrak / Space-Track
        │  HTTP (every 6h via cron)
        ▼
  fetcher.js ──▶ SQLite (space.db)
                     │
              ┌──────┴──────┐
              │             │
       /api/satellites  /api/conjunctions
              │             │
        React App (Zustand store)
              │
        satellite.js (SGP4, client-side)
              │
        CesiumJS Globe (WebGL)
```

## Quick Start

### 1. Prerequisites

- Node.js 18+
- A free [Cesium Ion](https://cesium.com/ion/signup) account (for globe imagery)
- Optional: [Space-Track.org](https://www.space-track.org/auth/createAccount) account (for CDM conjunction data)

### 2. Clone and install

```bash
git clone <repo-url> space-tracker
cd space-tracker
npm run install:all
```

### 3. Configure environment

Create `server/.env`:
```env
PORT=3001
SPACETRACK_USER=your@email.com
SPACETRACK_PASS=yourpassword
```

Create `client/.env`:
```env
VITE_CESIUM_TOKEN=your_cesium_ion_token_here
```

### 4. Run development servers

```bash
npm run dev
```

This starts:
- **Backend** at `http://localhost:3001` (nodemon, auto-restarts on changes)
- **Frontend** at `http://localhost:5173` (Vite HMR)

## API Keys

### Cesium Ion (required for globe imagery)
1. Sign up at [cesium.com/ion/signup](https://cesium.com/ion/signup) — free tier is sufficient
2. Go to **Access Tokens** → create a new token
3. Add to `client/.env` as `VITE_CESIUM_TOKEN`

Without a token the globe will still render but satellite imagery and terrain will be unavailable.

### Space-Track.org (optional — for conjunction data)
1. Register at [space-track.org/auth/createAccount](https://www.space-track.org/auth/createAccount)
2. Add credentials to `server/.env` as `SPACETRACK_USER` / `SPACETRACK_PASS`

Without Space-Track credentials:
- TLE data is still fetched from CelesTrak (free, no account needed)
- Conjunction data must be computed locally via the collision engine

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both server and client concurrently |
| `npm run dev:server` | Start backend only (nodemon) |
| `npm run dev:client` | Start frontend only (Vite) |
| `npm run install:all` | Install all workspace dependencies |

## API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health check |
| `GET /api/stats` | Object counts, conjunction summary |
| `GET /api/satellites` | All satellites with current positions |
| `GET /api/satellites/:noradId` | Single satellite detail + orbit trail |
| `GET /api/conjunctions` | Upcoming conjunctions (default 72h) |
| `POST /api/refresh` | Trigger manual TLE refresh |
| `GET /api/collision-status` | Last collision detection run result |

## Performance Notes

- First load fetches ~25,000+ TLEs from CelesTrak
- SGP4 propagation runs client-side using satellite.js in a Web Worker
- At speeds ≥60× playback, positions are batch pre-computed and interpolated
- The satellite list uses virtual scrolling to handle 30,000+ objects
- SQLite uses WAL mode for concurrent read performance
