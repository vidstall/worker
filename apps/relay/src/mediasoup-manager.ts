/**
 * mediasoup Worker lifecycle manager.
 *
 * Creates one Worker per CPU core (configurable via NUM_WORKERS env).
 * Workers use rtcMinPort/rtcMaxPort from environment.
 * Round-robin worker selection for new rooms.
 *
 * Requirements: RELAY-05
 */

import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import os from 'os';
import type { Logger } from '@dvconf/shared';

export interface MediasoupManager {
  workers: msTypes.Worker[];
  getNextWorker(): msTypes.Worker;
  createRouter(worker: msTypes.Worker): Promise<msTypes.Router>;
  close(): void;
}

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
  },
];

/**
 * Create and initialize mediasoup Workers.
 *
 * @param logger - Pino logger instance
 * @returns MediasoupManager with round-robin worker selection
 */
export async function createMediasoupManager(logger: Logger): Promise<MediasoupManager> {
  const numWorkers = parseInt(process.env['NUM_WORKERS'] ?? String(os.cpus().length), 10);
  const rtcMinPort = parseInt(process.env['RTC_MIN_PORT'] ?? '10000', 10);
  const rtcMaxPort = parseInt(process.env['RTC_MAX_PORT'] ?? '10100', 10);

  logger.info({ numWorkers, rtcMinPort, rtcMaxPort }, 'Creating mediasoup Workers');

  const workers: msTypes.Worker[] = [];

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      rtcMinPort,
      rtcMaxPort,
      logLevel: 'warn',
    });

    worker.on('died', (error) => {
      logger.error({ workerId: worker.pid, error }, 'mediasoup Worker died — spawning replacement');
      // Remove dead worker
      const idx = workers.indexOf(worker);
      if (idx !== -1) {
        workers.splice(idx, 1);
      }
      // Spawn replacement asynchronously
      mediasoup
        .createWorker({ rtcMinPort, rtcMaxPort, logLevel: 'warn' })
        .then((replacement) => {
          replacement.on('died', () => {
            logger.error({ workerId: replacement.pid }, 'Replacement Worker also died');
          });
          workers.push(replacement);
          logger.info({ workerId: replacement.pid }, 'Replacement Worker spawned');
        })
        .catch((err) => {
          logger.error({ err }, 'Failed to spawn replacement Worker');
        });
    });

    workers.push(worker);
    logger.info({ workerId: worker.pid, index: i }, 'mediasoup Worker created');
  }

  let nextWorkerIndex = 0;

  return {
    workers,

    getNextWorker(): msTypes.Worker {
      if (workers.length === 0) {
        throw new Error('No mediasoup Workers available');
      }
      const worker = workers[nextWorkerIndex % workers.length]!;
      nextWorkerIndex++;
      return worker;
    },

    async createRouter(worker: msTypes.Worker): Promise<msTypes.Router> {
      return worker.createRouter({ mediaCodecs });
    },

    close(): void {
      logger.info({ workerCount: workers.length }, 'Closing all mediasoup Workers');
      for (const worker of workers) {
        worker.close();
      }
      workers.length = 0;
    },
  };
}
