import { useStore } from '../store/useStore';

const ERROR_META = {
  celestrak:      { label: 'CELESTRAK',   color: '#ff8800' },
  'space-track':  { label: 'SPACE-TRACK', color: '#ff8800' },
  satellites:     { label: 'API',         color: '#ff2244' },
  connection:     { label: 'CONNECTION',  color: '#ff2244' },
  'no-token':     { label: 'CONFIG',      color: '#ffcc00' },
};

export default function ErrorBanner() {
  const errors     = useStore((s) => s.errors);
  const clearError = useStore((s) => s.clearError);

  if (!errors.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 10px 0', pointerEvents: 'none' }}>
      {errors.map((err) => {
        const meta = ERROR_META[err.type] ?? { label: err.type.toUpperCase(), color: '#ff8800' };
        return (
          <div
            key={err.id}
            style={{
              pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 10px',
              background: `${meta.color}12`,
              border: `1px solid ${meta.color}40`,
              fontFamily: "'Courier New', monospace",
            }}
          >
            <span style={{ fontSize: 9, color: meta.color, fontWeight: 700, letterSpacing: 1, flexShrink: 0 }}>
              [{meta.label}]
            </span>
            <span style={{ fontSize: 9, color: '#8aabb8', flex: 1 }}>{err.message}</span>
            {err.type === 'no-token' && (
              <span style={{ fontSize: 8, color: '#3a5a6a', letterSpacing: 1, flexShrink: 0 }}>
                ADD VITE_CESIUM_TOKEN TO .ENV
              </span>
            )}
            <button
              onClick={() => clearError(err.type)}
              style={{
                color: '#3a5a6a', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 12, marginLeft: 4,
                fontFamily: "'Courier New', monospace",
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
