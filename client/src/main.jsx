import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// StrictMode intentionally removed — it causes React to double-invoke effects
// in development, which destroys and recreates the Cesium WebGL viewer on the
// same DOM node, resulting in a blank globe.
createRoot(document.getElementById('root')).render(<App />);
