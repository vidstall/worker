import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeRoomManifest, type RoomManifest } from '../provision-room.ts';

const outA = join(tmpdir(), `room-a-${Date.now()}.json`);
const outB = join(tmpdir(), `room-b-${Date.now()}.json`);
afterEach(() => { for (const p of [outA, outB]) if (existsSync(p)) rmSync(p); });

describe('writeRoomManifest', () => {
  it('writes {roomId,relayId,signalingId,primaryUrl} pretty-printed + trailing newline to EVERY path', () => {
    const manifest: RoomManifest = {
      roomId: '0x7c60b80e',
      relayId: '0x93c9564e',
      signalingId: '0x93c9564e',
      primaryUrl: 'ws://relay:4001',
    };
    writeRoomManifest([outA, outB], manifest);
    for (const p of [outA, outB]) {
      const raw = readFileSync(p, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(JSON.parse(raw)).toEqual(manifest);
    }
  });
});
