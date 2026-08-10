/**
 * Shared mediasoup mock factories for the relay-role-manager.test.ts split files.
 */

import { vi } from 'vitest';

export function makeMockConsumer(paused = false) {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

export function makeMockPipeTransport(consumer: ReturnType<typeof makeMockConsumer>) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
  };
}

export function makeMockRouter(pipeTransport: ReturnType<typeof makeMockPipeTransport>) {
  return {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockResolvedValue(pipeTransport),
    rtpCapabilities: {} as any,
  };
}
