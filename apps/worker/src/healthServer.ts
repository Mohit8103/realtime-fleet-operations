import http from 'node:http';
import { config } from '@fleet/config';
import { type Logger } from '@fleet/logger';

export interface HealthServerInstance {
  server: http.Server;
  close: () => Promise<void>;
}

export function startHealthServer(logger: Logger, port: number = config.worker.healthPort): HealthServerInstance {
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0];

    if (url === '/healthz' || url === '/') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'worker',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          environment: config.env,
          concurrency: config.worker.concurrency
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(
      {
        port,
        healthCheck: `http://localhost:${port}/healthz`
      },
      '🩺 Worker health probe server listening'
    );
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
