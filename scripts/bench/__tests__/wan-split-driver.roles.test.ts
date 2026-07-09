import { describe, it, expect } from 'vitest';
import { parseRole } from '../wan-split-driver';

describe('wan-split-driver roles', () => {
  it('consume-standby pins to standby', () => {
    expect(parseRole('consume-standby')).toEqual({ role: 'consume', relayPin: 'standby', distinguishable: false });
  });
  it('produce-id emits a distinguishable track', () => {
    expect(parseRole('produce-id')).toEqual({ role: 'produce', relayPin: null, distinguishable: true });
  });
  it('bare produce / consume still parse', () => {
    expect(parseRole('produce')).toEqual({ role: 'produce', relayPin: null, distinguishable: false });
    expect(parseRole('consume')).toEqual({ role: 'consume', relayPin: null, distinguishable: false });
  });
});
