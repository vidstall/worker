/**
 * Unit tests for the pipe-connect frame (REQ-RO-006).
 *
 * The symmetric connect-param frame the standby and primary exchange so both
 * PipeTransports can connect() before RTP is piped. Mirrors PipeProducerAnnounce
 * exactly: flat JSON, string-literal discriminant, typeof-every-field guard, no
 * version/correlation id (design D1 / §10 Q7).
 *
 * Requirements: REQ-RO-006
 */
import { describe, it, expect } from 'vitest';
import {
  isPipeConnectFrame,
  buildPipeConnectFrame,
  type PipeConnectFrame,
  type PipeConnectParams,
} from '@dvconf/inter-relay-client';

describe('isPipeConnectFrame', () => {
  it('accepts a valid pipe-connect frame (srtp absent)', () => {
    const frame: PipeConnectFrame = { type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1', port: 44000 };
    expect(isPipeConnectFrame(frame)).toBe(true);
  });

  it('rejects wrong type', () => {
    expect(isPipeConnectFrame({ type: 'pipe-producer', roomId: 'r', ip: '127.0.0.1', port: 1 })).toBe(false);
  });

  it('rejects a missing/non-number port', () => {
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1' })).toBe(false);
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1', port: '1' })).toBe(false);
  });

  it('rejects a missing ip', () => {
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', port: 1 })).toBe(false);
  });

  it('rejects null / non-object', () => {
    expect(isPipeConnectFrame(null)).toBe(false);
    expect(isPipeConnectFrame('pipe-connect')).toBe(false);
    expect(isPipeConnectFrame(7)).toBe(false);
  });
});

describe('buildPipeConnectFrame', () => {
  it('RED-PC-1: builds the locked frame shape from params (round-trips its own guard)', () => {
    const params: PipeConnectParams = { ip: '127.0.0.1', port: 44010 };
    const frame = buildPipeConnectFrame('room-9', params);
    expect(frame).toEqual({ type: 'pipe-connect', roomId: 'room-9', ip: '127.0.0.1', port: 44010 });
    expect(isPipeConnectFrame(frame)).toBe(true);
  });

  it('RED-PC-2: carries srtpParameters when present', () => {
    const srtp = { cryptoSuite: 'AEAD_AES_256_GCM', keyBase64: 'k' } as unknown as PipeConnectParams['srtpParameters'];
    const frame = buildPipeConnectFrame('room-s', { ip: '10.0.0.2', port: 5, srtpParameters: srtp });
    expect(frame.srtpParameters).toBe(srtp);
    expect(isPipeConnectFrame(frame)).toBe(true);
  });
});
