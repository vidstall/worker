/**
 * Reframe invariants — relay-saturation INTERNET curated schema (real-bitrate run).
 *
 * The old `<=540` DirectTransport worker-ceiling guard was CATEGORY-WRONG twice
 * over: (1) for the internet real-bitrate scenario the relay never approached
 * its CPU ceiling (max cpuCoresSrtp ~5% of a core), so `cWorkerSrtp =
 * round(1/measured-slope)` comes out huge (~2250) — a HEADROOM indicator, not a
 * claimed operating ceiling; and (2) 540 is a delivery-healthy
 * DirectTransport-harness FLOOR on one laptop (i9-12900HK), NOT a ceiling — the
 * DirectTransport boundary is UNKNOWN (>540; harness broke at 720), the
 * real-SRTP ceiling's relation to 540 is UNMEASURED, and cWorkerSrtp comes from
 * Azure VMs (CH5-R6-001). These tests pin the reframed, still-fail-closed
 * contract:
 *
 *   - binding is DERIVED from measured relay-CPU headroom: 'cpu' iff a rung
 *     approached a core (> 0.5), else 'not-saturated'. When binding==='cpu'
 *     (and for legacy artifacts where binding is absent — those default to the
 *     requirement) the artifact must CARRY the DirectTransport-boundary honesty
 *     caveat; there is NO numeric cap on cWorkerSrtp.
 *   - MEASURED fail-closed gates: egress linearity, delivery==1 all rungs,
 *     identity 0-mismatch all rungs (incl. clean:false rungs), relaysAfter>=2.
 *   - the CONSUMER-DECODE knee is present + located (derived from g2g p99).
 *   - honesty[] documents BOTH (1) relay sub-saturation/headroom AND (2) the
 *     knee-is-a-co-location-artifact caveat.
 *
 * Data-source of truth: the real-bitrate raw
 *   .logs/bench/rms-internet/rms-int-20260709T045507-realbitrate.jsonl
 * is NOT committed; these tests use the committed fixture where a value is not
 * scenario-specific, and hand-built curated objects to exercise each guard in
 * isolation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  aggregate,
  deriveConsumerKnee,
  parseAggregateArgs,
} from '../aggregate-saturation-internet';
import { validateCurated } from '../saturation-internet.schema';
import type {
  CuratedSaturationInternet,
  PercentileTriple,
  RungRow,
} from '../saturation-internet.schema';

const raw = readFileSync(
  new URL('./fixtures/rms-internet-sample.jsonl', import.meta.url),
  'utf8',
);

/** A schema-valid curated artifact derived from the committed fixture. */
function validCurated(): CuratedSaturationInternet {
  return aggregate(raw, {
    runId: 'demo',
    benchCommit: 'abc123',
    mediaSecurity: 'plaintext',
  });
}

/** Minimal RungRow carrying only the g2g percentiles the knee logic reads. */
function makeRung(n: number, g2gMs: PercentileTriple): RungRow {
  return {
    n,
    forwardPaths: n * 9,
    cpuCoresSrtp: 0,
    egressMbpsReal: 0,
    mbpsPerViewer: 1,
    tHopMs: { p50: 13, p95: 13, p99: 14 },
    g2gMs,
    pipeBytesDelta: 0,
    deliveryHealth: 1,
    streamIdentityOk: true,
    clean: true,
  };
}

describe('reframe: binding is a DERIVED saturation verdict', () => {
  it("marks the relay 'not-saturated' when no rung approached a core", () => {
    const c = validCurated(); // fixture max cpuCoresSrtp ~0.28 (<0.5)
    expect(c.twoCeiling.binding).toBe('not-saturated');
  });

  it('reports cWorkerSrtp with an explicit headroom-not-ceiling note', () => {
    const c = validCurated();
    expect(typeof c.twoCeiling.cWorkerSrtpNote).toBe('string');
    expect(c.twoCeiling.cWorkerSrtpNote.length).toBeGreaterThan(0);
  });
});

/** The violation emitted when a CPU-bound artifact lacks the DT-boundary caveat. */
const DT_CAVEAT_VIOLATION =
  'cpu-bound artifact missing the DirectTransport-boundary caveat ' +
  '(real-SRTP ceiling vs the UNKNOWN DirectTransport boundary is unmeasured)';

/** An honesty entry that satisfies the DirectTransport-boundary requirement. */
const DT_CAVEAT =
  'Real-SRTP ceiling is LOWER than the UNKNOWN DirectTransport boundary ' +
  '(>540 forward-paths; the harness broke at 720); its relation to 540 or any ' +
  'measured point is UNMEASURED.';

describe('reframe: the DirectTransport-boundary caveat requirement is binding-conditional (fail-closed preserved)', () => {
  it("does NOT require the caveat when binding is 'not-saturated', even with a huge cWorkerSrtp", () => {
    const c = validCurated();
    const huge = {
      ...c,
      twoCeiling: {
        ...c.twoCeiling,
        binding: 'not-saturated' as const,
        cWorkerSrtp: 2250,
      },
    };
    expect(validateCurated(huge)).toEqual([]);
  });

  it("trips when binding==='cpu' and the DirectTransport-boundary caveat is MISSING", () => {
    const c = validCurated();
    const uncaveated = {
      ...c,
      twoCeiling: { ...c.twoCeiling, binding: 'cpu' as const, cWorkerSrtp: 2250 },
    };
    expect(validateCurated(uncaveated)).toContain(DT_CAVEAT_VIOLATION);
  });

  it('defaults to requiring the caveat when binding is absent (legacy artifact, fail-closed)', () => {
    const c = validCurated();
    const legacy = {
      ...c,
      twoCeiling: { ...c.twoCeiling, cWorkerSrtp: 900 },
    } as CuratedSaturationInternet;
    // Strip the binding field to simulate a legacy artifact.
    delete (legacy.twoCeiling as { binding?: unknown }).binding;
    expect(validateCurated(legacy)).toContain(DT_CAVEAT_VIOLATION);
  });

  it('accepts a CPU-bound cWorkerSrtp in (540, 750] when the caveat IS present (no numeric cap)', () => {
    // The point of CH5-R6-001: 540 is a one-laptop DirectTransport-harness
    // FLOOR, not a ceiling — a properly-caveated 720 must NOT be rejected.
    const c = validCurated();
    const caveated = {
      ...c,
      twoCeiling: { ...c.twoCeiling, binding: 'cpu' as const, cWorkerSrtp: 720 },
      honesty: [...c.honesty, DT_CAVEAT],
    };
    expect(validateCurated(caveated)).toEqual([]);
  });

  it('accepts a legacy (binding-absent) artifact at ANY cWorkerSrtp once the caveat is present', () => {
    const c = validCurated();
    const legacy = {
      ...c,
      twoCeiling: { ...c.twoCeiling, cWorkerSrtp: 540 },
      honesty: [...c.honesty, DT_CAVEAT],
    } as CuratedSaturationInternet;
    delete (legacy.twoCeiling as { binding?: unknown }).binding;
    expect(
      validateCurated(legacy).filter(
        (v) => v.includes('cWorkerSrtp') || v.includes('DirectTransport'),
      ),
    ).toEqual([]);
  });
});

describe('reframe: MEASURED fail-closed gates', () => {
  it('rejects a non-linear egress (a rung mbpsPerViewer strays > tol from median)', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.rungs[1]!.mbpsPerViewer = broken.rungs[1]!.mbpsPerViewer * 1.5; // +50%
    expect(validateCurated(broken).some((v) => v.includes('egress'))).toBe(true);
  });

  it('rejects deliveryHealth != 1 on ANY rung', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.rungs[0]!.deliveryHealth = 0.98;
    expect(
      validateCurated(broken).some((v) => v.includes('deliveryHealth')),
    ).toBe(true);
  });

  it('rejects an identity mismatch even on a clean:false rung', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.rungs[2]!.clean = false; // knee rung
    broken.rungs[2]!.streamIdentityOk = false; // identity broke
    expect(
      validateCurated(broken).some((v) => v.includes('streamIdentityOk')),
    ).toBe(true);
  });

  it('rejects relaysAfter < 2 (positive survival floor)', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.dropRelay.relaysAfter = 1;
    expect(
      validateCurated(broken).some((v) => v.includes('relaysAfter')),
    ).toBe(true);
  });
});

describe('reframe: consumer-decode knee is present + located', () => {
  it('exposes a derived consumerKnee block with onset + saturation', () => {
    const c = validCurated();
    expect(c.consumerKnee).toBeDefined();
    expect(Number.isFinite(c.consumerKnee.onsetN)).toBe(true);
    expect(Number.isFinite(c.consumerKnee.saturatedN)).toBe(true);
    expect(Number.isFinite(c.consumerKnee.g2gP99AtOnset)).toBe(true);
    expect(Number.isFinite(c.consumerKnee.g2gP99AtSaturation)).toBe(true);
    // Saturation p99 must be worse than onset p99 (the knee bends UP).
    expect(c.consumerKnee.g2gP99AtSaturation).toBeGreaterThanOrEqual(
      c.consumerKnee.g2gP99AtOnset,
    );
  });

  it('locates onset at the rung where the g2g TAIL first detaches (p99/p50 spread jump)', () => {
    // Real-run g2g percentiles: N=5 tight (49/46), N=10 tail detaches (96/50),
    // N=15 worse (167/61). Onset must be N=10 (tail-detachment), NOT N=15.
    const knee = deriveConsumerKnee([
      makeRung(5, { p50: 45.66, p95: 48.645, p99: 49.353 }),
      makeRung(10, { p50: 50.469, p95: 90.242, p99: 96.026 }),
      makeRung(15, { p50: 60.619, p95: 133.158, p99: 166.78 }),
    ]);
    expect(knee.onsetN).toBe(10);
    expect(knee.saturatedN).toBe(15);
    expect(knee.g2gP99AtOnset).toBeCloseTo(96.026);
    expect(knee.g2gP99AtSaturation).toBeCloseTo(166.78);
  });

  it('rejects an artifact whose consumerKnee is missing', () => {
    const c = validCurated();
    const broken = structuredClone(c) as Partial<CuratedSaturationInternet>;
    delete broken.consumerKnee;
    expect(
      validateCurated(broken as CuratedSaturationInternet).some((v) =>
        v.includes('consumerKnee'),
      ),
    ).toBe(true);
  });
});

describe('reframe: bandwidth ceiling is a labeled PROJECTION, not a gate', () => {
  it('exposes a parameterized bandwidthProjection with >=2 reference points + measured peak', () => {
    const c = validCurated();
    expect(c.bandwidthProjection).toBeDefined();
    expect(c.bandwidthProjection.mbpsPerViewer).toBeGreaterThan(0);
    expect(c.bandwidthProjection.references.length).toBeGreaterThanOrEqual(2);
    for (const ref of c.bandwidthProjection.references) {
      // viewers = floor(uplinkMbps / mbpsPerViewer) — derived, not hand-typed.
      expect(ref.viewers).toBe(
        Math.floor(ref.uplinkMbps / c.bandwidthProjection.mbpsPerViewer),
      );
    }
    expect(c.bandwidthProjection.measuredPeakEgressMbps).toBeGreaterThan(0);
  });
});

describe('reframe: honesty[] must document BOTH required caveats', () => {
  it('rejects honesty[] missing the relay-headroom caveat', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.honesty = broken.honesty.filter(
      (h) => !/headroom|sub-saturat|not.*saturat|never approached/i.test(h),
    );
    expect(
      validateCurated(broken).some((v) => v.includes('relay sub-saturation')),
    ).toBe(true);
  });

  it('rejects honesty[] missing the knee-is-co-location-artifact caveat', () => {
    const c = validCurated();
    const broken = structuredClone(c);
    broken.honesty = broken.honesty.filter(
      (h) => !/co-locat|colocat|synthetic consumer|per-user|own device/i.test(h),
    );
    expect(
      validateCurated(broken).some((v) => v.includes('co-location')),
    ).toBe(true);
  });

  it('a fully-valid curated artifact has ZERO violations', () => {
    expect(validateCurated(validCurated())).toEqual([]);
  });
});

describe('reframe: mediaSecurity must be self-declared (fail-closed)', () => {
  it('populates mediaSecurity from the operator-supplied value', () => {
    const c = aggregate(raw, {
      runId: 'demo',
      benchCommit: 'abc123',
      mediaSecurity: 'plaintext',
    });
    expect(c.mediaSecurity).toBe('plaintext');
  });

  it('rejects an artifact with a missing/invalid mediaSecurity', () => {
    const c = validCurated();
    const broken = structuredClone(c) as Partial<CuratedSaturationInternet>;
    delete broken.mediaSecurity;
    expect(
      validateCurated(broken as CuratedSaturationInternet).some((v) =>
        v.includes('mediaSecurity'),
      ),
    ).toBe(true);
  });

  it('a plaintext run emits the relay-is-E2EE-invariant caveat', () => {
    const c = aggregate(raw, {
      runId: 'demo',
      benchCommit: 'abc123',
      mediaSecurity: 'plaintext',
    });
    expect(
      c.honesty.some((h) => /PLAINTEXT|E2EE-INVARIANT|content-blind/i.test(h)),
    ).toBe(true);
  });

  it('an e2ee run does NOT emit the plaintext caveat', () => {
    const c = aggregate(raw, {
      runId: 'demo',
      benchCommit: 'abc123',
      mediaSecurity: 'e2ee',
    });
    expect(c.mediaSecurity).toBe('e2ee');
    expect(
      c.honesty.some((h) => /Measured on the PLAINTEXT SFU-forward path/i.test(h)),
    ).toBe(false);
  });

  it('an e2ee run emits the E2EE-path / endpoints-pay caveat', () => {
    const c = aggregate(raw, {
      runId: 'demo',
      benchCommit: 'abc123',
      mediaSecurity: 'e2ee',
    });
    expect(
      c.honesty.some((h) => /Measured on the E2EE path/i.test(h)),
    ).toBe(true);
  });
});

describe('reframe: planning-fields legend + CLI media-security requirement', () => {
  it('honesty[] documents what kR*/floor/planning mean (planning legend)', () => {
    const c = validCurated();
    expect(
      c.honesty.some(
        (h) =>
          /twoCeiling planning fields/i.test(h) &&
          /kRcpuAt100/.test(h) &&
          /kRbwAt100/.test(h) &&
          /planningAt100/.test(h),
      ),
    ).toBe(true);
  });

  it('parseAggregateArgs REQUIRES --media-security', () => {
    expect(() =>
      parseAggregateArgs([
        'node',
        'aggregate.ts',
        'raw.jsonl',
        '--run-id',
        'r',
        '--commit',
        'c',
      ]),
    ).toThrow(/media-security/i);
  });

  it('parseAggregateArgs accepts a valid --media-security', () => {
    const args = parseAggregateArgs([
      'node',
      'aggregate.ts',
      'raw.jsonl',
      '--run-id',
      'r',
      '--commit',
      'c',
      '--media-security',
      'e2ee',
    ]);
    expect(args.mediaSecurity).toBe('e2ee');
  });
});
