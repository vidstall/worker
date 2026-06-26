/**
 * REQ-RMS-028 unit tests — keys() / entries() enumeration on InterRelaySocketMap.
 */
import { describe, it, expect } from 'vitest';
import { createInterRelaySocketMap } from '../inter-relay-socket-map.js';

describe('REQ-RMS-028 — InterRelaySocketMap keys()/entries() enumeration', () => {
  it('keys() and entries() enumerate every attached peer (REQ-RMS-028)', () => {
    const map = createInterRelaySocketMap();
    const sockA = { readyState: 1, send() {} };
    const sockB = { readyState: 1, send() {} };
    map.attach('relayB', sockA);
    map.attach('relayC', sockB);
    expect(map.keys().sort()).toEqual(['relayB', 'relayC']);
    expect(map.entries().map(([k]) => k).sort()).toEqual(['relayB', 'relayC']);
    expect(map.entries().find(([k]) => k === 'relayB')?.[1]).toBe(sockA);
  });
});
