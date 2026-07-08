/**
 * SMH-LIVE evidence-markdown assembler.
 *
 * Renders `.evidence/verification/static-mesh-hardening-live.md` from the per-phase
 * results the orchestrator collects. The honest-scope caveat block is copied VERBATIM
 * into the header so no claim travels without its caveat (evidence contract, design
 * § "Evidence contract").
 */

export interface PhaseResult {
  phase: string;
  verdict: 'PASS' | 'FAIL';
  /** Raw evidence lines (curl body, grepped log line, RPC re-read JSON), rendered indented. */
  lines: string[];
}

/**
 * Honest-scope caveats, verbatim per RECONCILIATION v2: the LIVE run proves D1a+D1b+D2
 * ONLY; D3 (REQ-RMS-037 reopen re-delivery) is proven HERMETICALLY because it is
 * loopback-impractical to inject live (shared client-WS port + Windows loopback not
 * firewall-filterable, and no daemon-prod test-hook is allowed).
 */
export const SMH_LIVE_CAVEATS = [
  '- **Live scope = D1a + D1b + D2 ONLY.** This hands-off run proves, on the native N=3',
  '  localnet: D1a (flag-ON strict no-attestation `defer`), D1b (flag-OFF byte-stable',
  '  K_r>=3 placement), and D2 (kill-relay failover with an RPC-verified `RelayPromoted`',
  '  and same-relay consume continuity). Every on-chain claim is re-read by an independent',
  '  Sui RPC query, never by a daemon log alone.',
  '- **D3 (reopen re-delivery, REQ-RMS-037) is proven HERMETICALLY, not in this live run.**',
  "  On single-host loopback the standby dials the PRIMARY's SHARED client-WS port (there is",
  '  NO dedicated inter-relay port), and Windows Firewall does not filter loopback traffic —',
  '  so a transient standby->primary link flap cannot be injected without a relay test-hook',
  '  (rejected: no daemon-production edit). D3 stays covered by the shipped during-window',
  '  test on `static-mesh-hardening` (REQ-RMS-037 §3.3).',
  '- **Attested-rows admission (`basis=attested`) is NOT proven here** — it is canary-M4b-',
  '  gated; D1a deliberately asserts the strict `defer` (feed wired, zero attested rows).',
  '- Media source is a headless programmatic `mediasoup-client` peer (no browser tab). The',
  '  mesh / failover / placement behaviour under test is entirely server-side, so a headless',
  '  peer does not reduce its liveness (lane charter = 0 client edits).',
].join('\n');

/**
 * Build the evidence markdown. `OVERALL: PASS` iff every phase passed; otherwise FAIL.
 * `caveats` defaults to {@link SMH_LIVE_CAVEATS}.
 */
export function assembleEvidence(phases: PhaseResult[], caveats: string = SMH_LIVE_CAVEATS): string {
  const overall = phases.every((p) => p.verdict === 'PASS') ? 'PASS' : 'FAIL';
  const body = phases
    .map((p) => `## ${p.phase} — ${p.verdict}\n\n${p.lines.map((l) => `    ${l}`).join('\n')}`)
    .join('\n\n');
  return [
    '# Static-Mesh-Hardening LIVE — Evidence',
    '',
    `OVERALL: ${overall}`,
    '',
    body,
    '',
    '## Honest scope / caveats',
    '',
    caveats,
    '',
  ].join('\n');
}
