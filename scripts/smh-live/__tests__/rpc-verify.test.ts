import { describe, it, expect } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { parseAssignedRelays, parseRelayPromoted, decodeMoveString, parseWsPort, parseVecId } from '../rpc-verify.js';

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

  // T1-1: the on-chain event ENVELOPE timestampMs (checkpoint/consensus-commit wall-clock, from
  // queryEvents — NOT parsedJson) is the authoritative `RelayPromoted`-delivered instant used to
  // decompose submit->RelayPromoted latency. Never client-visible, never MTTR.
  it('surfaces the envelope timestampMs as promotedAtMs (numeric-string epoch-ms -> number)', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', old_primary: '0xdead', new_primary: '0xnew', epoch: '7' }, timestampMs: '1700000000123' },
    ];
    const r = parseRelayPromoted(events, pkg, '0xroom', '0xdead');
    expect(r!.promotedAtMs).toBe(1700000000123);
  });

  it('sets promotedAtMs = null (NOT 0) when the event carries no envelope timestampMs', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', old_primary: '0xdead', new_primary: '0xnew', epoch: '7' } },
    ];
    const r = parseRelayPromoted(events, pkg, '0xroom', '0xdead');
    expect(r!.promotedAtMs).toBeNull();
  });

  it('sets promotedAtMs = null (NOT 0) when timestampMs is explicitly null (Number(null)===0 trap)', () => {
    const events = [
      { type: `${pkg}::room_manager::RelayPromoted`, parsedJson: { room_id: '0xroom', old_primary: '0xdead', new_primary: '0xnew', epoch: '7' }, timestampMs: null },
    ];
    const r = parseRelayPromoted(events, pkg, '0xroom', '0xdead');
    expect(r!.promotedAtMs).toBeNull();
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

describe('parseVecId (BCS vector<ID> from get_room_assignment.assigned_relays — LIVE swap check)', () => {
  const hex = (a: number[]) => normalizeSuiAddress('0x' + a.map((b) => b.toString(16).padStart(2, '0')).join(''));

  it('decodes a ULEB-length-prefixed vector of 32-byte ids to normalized addresses', () => {
    const id1 = Array.from({ length: 32 }, (_, i) => i + 1);
    const id2 = Array.from({ length: 32 }, (_, i) => 100 + i);
    expect(parseVecId([2, ...id1, ...id2])).toEqual([hex(id1), hex(id2)]);
  });

  it('returns [] for an empty vector', () => {
    expect(parseVecId([0])).toEqual([]);
  });

  it('stops at a truncated trailing id rather than emitting a short address', () => {
    const id1 = Array.from({ length: 32 }, (_, i) => i + 1);
    expect(parseVecId([2, ...id1, 9, 9, 9])).toEqual([hex(id1)]);
  });
});
