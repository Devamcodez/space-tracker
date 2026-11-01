import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cesiumSource = 'node_modules/cesium/Build/Cesium';

export default defineConfig({
  // Read .env from the workspace root so VITE_CESIUM_TOKEN is picked up
  envDir: path.resolve(__dirname, '..'),
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/Workers/*`, dest: 'cesium/Workers' },
        { src: `${cesiumSource}/ThirdParty/*`, dest: 'cesium/ThirdParty' },
        { src: `${cesiumSource}/Assets/*`, dest: 'cesium/Assets' },
        { src: `${cesiumSource}/Widgets/*`, dest: 'cesium/Widgets' },
      ],
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
