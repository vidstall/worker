import { describe, it, expect } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { parseAssignedRelays, parseRelayPromoted, decodeMoveString, parseWsPort } from '../rpc-verify.js';

const pkg = '0xpkg';

describe('parseAssignedRelays (room_manager::RoomAssigned.relay_ids — confirmed rms-live-local test)', () => {
  it('returns normalized distinct relay ids for the matching room', () => {
    const events = [
      { type: `${pkg}::room_manager::RoomAssigned`, parsedJson: { room_id: '0xroom', relay_ids: ['0x1', '0x2', '0x3'] } },
    ];
    const ids = parseAssignedRelays(events, pkg, '0xroom');
    expect(ids).toEqual(['0x1', '0x2', '0x3'].map((s) => normalizeSuiAddress(s)));
    expect(new Set(ids).size).toBe(3);
  });

  it('matches the room by NORMALIZED id (0xabc === 0x0abc)', () => {
    const events = [
      { type: `${pkg}::room_manager::RoomAssigned`, parsedJson: { room_id: '0x0abc', relay_ids: ['0xaa'] } },
    ];
    expect(parseAssignedRelays(events, pkg, '0xabc')).toEqual([normalizeSuiAddress('0xaa')]);
  });

  it('returns null when no event matches the room', () => {
    const events = [
      { type: `${pkg}::room_manager::RoomAssigned`, parsedJson: { room_id: '0xother', relay_ids: ['0x1'] } },
    ];
    expect(parseAssignedRelays(events, pkg, '0xroom')).toBeNull();
  });

  it('ignores events of a different type', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', relay_ids: ['0x1'] } },
    ];
    expect(parseAssignedRelays(events, pkg, '0xroom')).toBeNull();
  });
});

describe('parseRelayPromoted (Move fields room_id/old_primary/new_primary/epoch — confirmed room_manager.move:206-211)', () => {
  it('extracts new_primary + epoch for the matching (room, oldPrimary); epoch is a numeric-string u64', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', old_primary: '0xdead', new_primary: '0xnew', epoch: '7' } },
    ];
    const r = parseRelayPromoted(events, pkg, '0xroom', '0xdead');
    expect(r).not.toBeNull();
    expect(r!.newPrimary).toBe(normalizeSuiAddress('0xnew'));
    expect(r!.epoch).toBe(7);
  });

  it('returns null when the promotion is for a DIFFERENT oldPrimary (dedup is per (room,oldPrimary))', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', old_primary: '0xother', new_primary: '0xnew', epoch: '7' } },
    ];
    expect(parseRelayPromoted(events, pkg, '0xroom', '0xdead')).toBeNull();
  });

  it('returns null when the room does not match', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xother', old_primary: '0xdead', new_primary: '0xnew', epoch: '7' } },
    ];
    expect(parseRelayPromoted(events, pkg, '0xroom', '0xdead')).toBeNull();
  });
});

describe('decodeMoveString (BCS vector<u8> -> utf8, ULEB128 length prefix — relay endpoint bytes)', () => {
  it('decodes a short move string (single-byte ULEB length, as devInspect returns info_endpoint_url)', () => {
    const s = 'ws://127.0.0.1:4000';
    const bytes = [s.length, ...Array.from(new TextEncoder().encode(s))];
    expect(decodeMoveString(bytes)).toBe(s);
  });

  it('decodes the empty vector', () => {
    expect(decodeMoveString([0])).toBe('');
  });

  it('honors the ULEB length (ignores trailing bytes beyond the declared length)', () => {
    const s = 'ws://127.0.0.1:4002';
    const bytes = [s.length, ...Array.from(new TextEncoder().encode(s)), 0xff, 0xff];
    expect(decodeMoveString(bytes)).toBe(s);
  });
});

describe('parseWsPort (relay endpoint URL -> TCP port)', () => {
  it('parses the port from the native relay endpoints', () => {
    expect(parseWsPort('ws://127.0.0.1:4000')).toBe(4000);
    expect(parseWsPort('ws://127.0.0.1:4002')).toBe(4002);
    expect(parseWsPort('ws://127.0.0.1:4004/path')).toBe(4004);
  });

  it('returns null when there is no explicit port or the string is not a URL', () => {
    expect(parseWsPort('ws://127.0.0.1')).toBeNull();
    expect(parseWsPort('garbage')).toBeNull();
  });
});
