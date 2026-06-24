import { describe, it, expect } from 'vitest';
// scripts/ tests can't resolve the @dvconf/shared workspace alias under vitest — import the
// relative SOURCE. check-publish-fresh is a plain .mjs so the bash move-publish ENTRYPOINT can run
// it with bare `node` (no tsx / node_modules) from the volume-mounted /entrypoint/demo; the pure
// decision helpers are exported for this unit test, the fetch/exit glue runs only when isMain.
import { extractPackageId, isLiveGetObjectResponse } from '../check-publish-fresh.mjs';

describe('extractPackageId', () => {
  it('returns the published packageId from a sui test-publish objectChanges array', () => {
    const parsed = {
      objectChanges: [
        { type: 'created', objectId: '0xc1', objectType: '0x::network_registry::AdminCap' },
        { type: 'published', packageId: '0xPKG', modules: ['core'], version: '1' },
      ],
    };
    expect(extractPackageId(parsed)).toBe('0xPKG');
  });

  it('returns null when no published change is present', () => {
    expect(extractPackageId({ objectChanges: [{ type: 'created', objectId: '0xc1' }] })).toBeNull();
  });

  it('returns null on empty / malformed input (never throws)', () => {
    expect(extractPackageId({})).toBeNull();
    expect(extractPackageId({ objectChanges: [] })).toBeNull();
    expect(extractPackageId(null)).toBeNull();
    expect(extractPackageId(undefined)).toBeNull();
  });
});

describe('isLiveGetObjectResponse', () => {
  it('is true when sui_getObject returns a present object (result.data.objectId set)', () => {
    const live = { jsonrpc: '2.0', id: 1, result: { data: { objectId: '0xPKG', version: '3', type: 'package' } } };
    expect(isLiveGetObjectResponse(live)).toBe(true);
  });

  it('is false when the object does not exist on this chain (result.data null)', () => {
    const gone = { jsonrpc: '2.0', id: 1, result: { data: null, error: { code: 'notExists', object_id: '0xPKG' } } };
    expect(isLiveGetObjectResponse(gone)).toBe(false);
  });

  it('is false on a top-level RPC error or malformed response (never throws)', () => {
    expect(isLiveGetObjectResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } })).toBe(false);
    expect(isLiveGetObjectResponse({ result: {} })).toBe(false);
    expect(isLiveGetObjectResponse(null)).toBe(false);
    expect(isLiveGetObjectResponse(undefined)).toBe(false);
  });
});
