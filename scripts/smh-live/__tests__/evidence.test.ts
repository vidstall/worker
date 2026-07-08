import { describe, it, expect } from 'vitest';
import { assembleEvidence, SMH_LIVE_CAVEATS, type PhaseResult } from '../evidence.js';

describe('assembleEvidence', () => {
  it('renders each phase with its verdict + indented lines and copies the caveat block', () => {
    const phases: PhaseResult[] = [
      { phase: 'D1a', verdict: 'PASS', lines: ['curl :8105/canary/load -> relays:[]', 'basis=defer'] },
      { phase: 'D2', verdict: 'FAIL', lines: ['no RelayPromoted within 90s'] },
    ];
    const md = assembleEvidence(phases, 'CAVEAT: attested-rows admission not proven here.');
    expect(md).toContain('# Static-Mesh-Hardening LIVE — Evidence');
    expect(md).toContain('## D1a — PASS');
    expect(md).toContain('## D2 — FAIL');
    expect(md).toContain('basis=defer');
    expect(md).toContain('CAVEAT: attested-rows admission not proven here.');
  });

  it('OVERALL PASS only when every phase passed', () => {
    expect(assembleEvidence([{ phase: 'D1a', verdict: 'PASS', lines: [] }], 'x')).toContain('OVERALL: PASS');
  });

  it('OVERALL FAIL if any phase failed', () => {
    const md = assembleEvidence(
      [
        { phase: 'D1a', verdict: 'PASS', lines: [] },
        { phase: 'D2', verdict: 'FAIL', lines: [] },
      ],
      'x',
    );
    expect(md).toContain('OVERALL: FAIL');
  });

  it('defaults to the SMH_LIVE_CAVEATS block when no caveat argument is passed', () => {
    const md = assembleEvidence([{ phase: 'D1a', verdict: 'PASS', lines: [] }]);
    expect(md).toContain(SMH_LIVE_CAVEATS);
  });
});

describe('SMH_LIVE_CAVEATS (RECONCILIATION v2 — D3 hermetic, live scope D1a+D1b+D2 only)', () => {
  it('states D3 is proven hermetically (loopback-impractical) and live scope is D1a+D1b+D2', () => {
    const c = SMH_LIVE_CAVEATS;
    expect(c).toMatch(/hermetic/i);
    expect(c).toMatch(/loopback/i);
    expect(c).toContain('D1a');
    expect(c).toContain('D1b');
    expect(c).toContain('D2');
    expect(c).toContain('D3');
  });
});
