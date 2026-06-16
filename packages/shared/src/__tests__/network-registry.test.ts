/**
 * P17 M2b-P8 (DOH-021) — readIsPaused + readCapMinerId on-chain reads for the
 * F60 reactive-shutdown wiring. Both are FAIL-OPEN (a read error never reads as
 * paused / a wrong id) so a transient chain hiccup can never self-kill a daemon.
 */
import { describe, it, expect, vi } from 'vitest';
import { readIsPaused, readCapMinerId } from '../chain/network-registry.js';

const PKG = '0xpkg';
const NET_REG = '0xnetreg';
const CAP = '0xcap';

describe('readIsPaused (devInspect network_registry::is_paused)', () => {
  it('decodes a BCS bool=1 return as true', async () => {
    const client = {
      devInspectTransactionBlock: vi
        .fn()
        .mockResolvedValue({ results: [{ returnValues: [[[1], 'bool']] }] }),
    } as never;
    expect(await readIsPaused(client, PKG, NET_REG)).toBe(true);
  });

  it('decodes a BCS bool=0 return as false', async () => {
    const client = {
      devInspectTransactionBlock: vi
        .fn()
        .mockResolvedValue({ results: [{ returnValues: [[[0], 'bool']] }] }),
    } as never;
    expect(await readIsPaused(client, PKG, NET_REG)).toBe(false);
  });

  it('fail-open: a devInspect rejection → false (never reads as paused)', async () => {
    const client = {
      devInspectTransactionBlock: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as never;
    expect(await readIsPaused(client, PKG, NET_REG)).toBe(false);
  });

  it('fail-open: an empty return → false', async () => {
    const client = {
      devInspectTransactionBlock: vi.fn().mockResolvedValue({ results: [{ returnValues: [] }] }),
    } as never;
    expect(await readIsPaused(client, PKG, NET_REG)).toBe(false);
  });

  it('issues exactly one devInspect with the 0x0 read-only sender', async () => {
    const spy = vi.fn().mockResolvedValue({ results: [{ returnValues: [[[1], 'bool']] }] });
    const client = { devInspectTransactionBlock: spy } as never;
    await readIsPaused(client, PKG, NET_REG);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].sender).toMatch(/^0x0+$/);
  });
});

describe('readCapMinerId (getObject cap.miner_id field)', () => {
  it('extracts miner_id from a move-object cap content', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile', role: 2 } } },
      }),
    } as never;
    expect(await readCapMinerId(client, CAP)).toBe('0xminerprofile');
  });

  it('returns null when the object is missing', async () => {
    const client = { getObject: vi.fn().mockResolvedValue({ data: null }) } as never;
    expect(await readCapMinerId(client, CAP)).toBeNull();
  });

  it('returns null when the miner_id field is absent', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: { role: 2 } } },
      }),
    } as never;
    expect(await readCapMinerId(client, CAP)).toBeNull();
  });

  it('fail-safe: a getObject rejection → null', async () => {
    const client = { getObject: vi.fn().mockRejectedValue(new Error('boom')) } as never;
    expect(await readCapMinerId(client, CAP)).toBeNull();
  });
});
