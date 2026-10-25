import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function healthzPlugin(): Plugin {
  return {
    name: 'healthz-endpoint',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/healthz') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: 'ok',
              service: 'web',
              timestamp: new Date().toISOString()
            })
          );
          return;
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/healthz') {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              status: 'ok',
              service: 'web',
              timestamp: new Date().toISOString()
            })
          );
          return;
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), healthzPlugin()],
  server: {
    port: 5173,
    host: true
  },
  preview: {
    port: 5173,
    host: true
  }
});
