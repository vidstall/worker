import { describe, it, expect } from 'vitest';
import { consolidatedComposeFiles, exitCodeFor, STAGE_KEYS } from '../../../../run-consolidated-demo.ts';

describe('run-consolidated-demo contract', () => {
  it('composes the 5 layers in order (base, w1, relay-overlap, consolidated, realmedia)', () => {
    const files = consolidatedComposeFiles('/ROOT');
    expect(files).toEqual([
      '/ROOT/docker-compose-demo.yml',
      '/ROOT/docker-compose-demo-w1.override.yml',
      '/ROOT/docker-compose-demo-relay-overlap.override.yml',
      '/ROOT/docker-compose-demo-consolidated.override.yml',
      '/ROOT/docker-compose-demo-realmedia.override.yml',
    ]);
  });

  it('STAGE_KEYS is the canonical ordered set (no drift)', () => {
    expect([...STAGE_KEYS]).toEqual([
      'stack-up',
      '1a-revote',
      '1b-initial-role-vote',
      '2-provision-room',
      '2a-admission-composition',
      '2b-no-token-rejected',
      '2c-valid-join-accepted',
      '3-media-inprocess',
      '4-failover-mttr',
      '5-canary-audit-run',
      '5a-canary-slash-e2e',
      '5b-onchain-slash-2distinct',
      '5-realmedia-browser-slash',
    ]);
  });

  it('exits 0 when no stage FAILed (SKIP does not fail the run)', () => {
    expect(exitCodeFor({ 'stack-up': 'PASS', '4-failover-mttr': 'SKIP' })).toBe(0);
  });

  it('exits non-zero when any stage FAILed', () => {
    expect(exitCodeFor({ 'stack-up': 'PASS', '5b-onchain-slash-2distinct': 'FAIL' })).toBe(1);
  });
});
