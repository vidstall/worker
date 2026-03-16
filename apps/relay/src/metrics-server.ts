/**
 * HTTP metrics server for relay daemon.
 *
 * Exposes per-room metrics for validator probing and a global health endpoint.
 * Uses Node.js built-in http module (no Express).
 *
 * Endpoints:
 *   GET /metrics/:roomId  — per-room metrics (IC-5)
 *   GET /metrics          — global health summary
 *
 * Default port: 4001 (configurable via METRICS_PORT env var).
 *
 * Requirements: Phase 14 IC-5
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';

/**
 * Start the metrics HTTP server.
 *
 * @returns The HTTP server instance (for graceful shutdown).
 */
export function startMetricsServer(
  metrics: MetricsTracker,
  logger: Logger,
): Server {
  const port = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);

  const server = createServer((req, res) => {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url ?? '/';

    try {
      // Route: GET /metrics/:roomId
      const roomMatch = url.match(/^\/metrics\/([a-fA-F0-9x]+)$/);
      if (roomMatch) {
        const roomId = roomMatch[1]!;
        const roomMetrics = metrics.getRoomMetrics(roomId);

        if (!roomMetrics) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(roomMetrics));
        return;
      }

      // Route: GET /metrics
      if (url === '/metrics') {
        const globalMetrics = metrics.getGlobalMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalMetrics));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err, url }, 'Metrics server error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Metrics HTTP server listening');
  });

  return server;
}
