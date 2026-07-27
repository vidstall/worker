/**
 * Multi-CP quorum Phase 1 — Leg 4 (G2 assembler) tests (RED-first → GREEN).
 *
 * DESIGN-connection-arch.md G2 + ROADMAP Leg 4: `assembleCapTokenQuorum` takes the
 * cell CLAIM + the accrued CP self-attestations + the discovered active-CP operator
 * set, and emits the EXACT single-CP shape `{ qs:{signers,signatures}, pubkeys,
 * aggregateSig }` (index.ts:147-151) — the shape the FROZEN consumer chain
 * (`CapTokenIssuer.submitIssue` → `makeCapTokenSubmitter` → `buildIssueCapTokenTx` →
 * Move `room_capability::issue_capability_token` → `cp_quorum_sig::verify_quorum`)
 * accepts UNCHANGED.
 *
 * The three arrays are INDEX-ALIGNED in signature order: `qs.signers[i]` = the
 * poster's registered operator ADDRESS, `qs.signatures[i]` = the RAW 64-byte sig,
 * `pubkeys[i]` = the poster's 32-byte pubkey. `verify_quorum`
 * (cp_quorum_sig.move:129-192) iterates these in lock-step (F-01 VecSet dedup-by-
 * address + `is_operator_registered` + `ed25519_verify(signatures[i], pubkeys[i],
 * msg)`), and takes `pubkeys` as a SEPARATE parallel arg (NOT a QuorumSig field).
 *
 * FAIL-CLOSED (OQ-1): a poster whose pubkey resolves to NO operator in the discovered
 * active-CP snapshot (just-joined / stranger) is DROPPED — never a silent index-
 * misalignment (it would fail `is_operator_registered` on-chain anyway).
 *
 * OQ-BUILD-1: the on-chain AUTHORITATIVE gate is `verify_quorum`, which consumes ONLY
 * `qs`(signers+signatures) + `pubkeys` + `msg`. `aggregate_sig` is NEVER read by
 * `verify_quorum`; `issue_capability_token` (room_capability.move:455,527) stores it
 * VERBATIM into `RoomCapability.aggregate_sig` for off-chain audit replay only. It is
 * therefore VESTIGIAL vs the per-index `pubkeys[]` ed25519_verify path. The single-CP
 * branch uses `[0x01, ...sig64]`; the multi-CP generalization is `[0x01, ...sig64(0),
 * ...sig64(1), ...]` (the 0x01 version/marker + the concatenated RAW sigs in signer
 * order) — a self-describing audit blob that a future reader can split on the 64-byte
 * boundary. Since it is never on-chain-parsed, any deterministic encoding is safe; this
 * one preserves the single-CP shape (0x01 prefix) and carries every real signature.
 *
 * Forcing function (cross-daemon byte-identity): two independent CP keypairs each run
 * the Leg-2 `rebuildCanonicalAndSignIfMatches` over the SAME golden ISSUE claim
 * (room 0x11*32, peer 0x22*32, role 2, expires 200n, nonce 1 → 81-byte golden vector
 * from bcs-equivalence.test.ts). CP-A's rebuilt bytes == CP-B's == the Move canonical
 * concat. The assembled arrays must verify against a `verify_quorum`-shaped consumer.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildIssueCanonicalMsg,
  rebuildCanonicalAndSignIfMatches,
  assembleCapTokenQuorum,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token/index.js';
import type { CpOperator } from '../sui-chain-state-reader.js';

/** hex string → number[] bytes (matches Move's id_to_bytes shape / bcs-equivalence helper). */
function bytesToHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The golden ISSUE vector from bcs-equivalence.test.ts (the canonical-bytes anchor). */
const GOLDEN_ROOM_ID = '0x' + '11'.repeat(32);
const GOLDEN_PEER_PUBKEY = new Array(32).fill(0x22);
const GOLDEN_ROLE = 2; // relay
const GOLDEN_EXPIRES = 200n;
const GOLDEN_NONCE = 1;

function goldenClaim(): CapTokenIssueClaim {
  const canonicalMsg = buildIssueCanonicalMsg({
    roomId: GOLDEN_ROOM_ID,
    peerPubkey: GOLDEN_PEER_PUBKEY,
    role: GOLDEN_ROLE,
    expiresEpoch: GOLDEN_EXPIRES,
    nonce: GOLDEN_NONCE,
  });
  return {
    kind: 'captoken-issue',
    roomId: GOLDEN_ROOM_ID,
    peerPubkey: GOLDEN_PEER_PUBKEY,
    role: GOLDEN_ROLE,
    expiresEpoch: GOLDEN_EXPIRES,
    nonce: GOLDEN_NONCE,
    canonicalMsgHex: bytesToHex(canonicalMsg),
  };
}

/** The golden canonical ISSUE bytes (what every honest CP signs). */
function goldenCanonical(): Uint8Array {
  return buildIssueCanonicalMsg({
    roomId: GOLDEN_ROOM_ID,
    peerPubkey: GOLDEN_PEER_PUBKEY,
    role: GOLDEN_ROLE,
    expiresEpoch: GOLDEN_EXPIRES,
    nonce: GOLDEN_NONCE,
  });
}

/**
 * Minimal `verify_quorum`-shaped consumer — mirrors cp_quorum_sig.move:129-192 lock-step
 * iteration over the THREE index-aligned arrays. Returns true iff: lengths agree, count
 * >= required, F-01 dedup-by-address holds, each signer is a registered operator, and
 * each `ed25519_verify(signatures[i], pubkeys[i], msg)` passes. The on-chain path takes
 * `pubkeys` as a SEPARATE parallel arg (NOT a QuorumSig field) — asserted by the call
 * shape here.
 */
async function verifyQuorumShaped(
  qs: { signers: string[]; signatures: number[][] },
  pubkeys: number[][],
  msg: Uint8Array,
  registeredOperators: Set<string>,
  required: number,
): Promise<boolean> {
  const n = qs.signers.length;
  if (qs.signatures.length !== n) return false;
  if (pubkeys.length !== n) return false; // Move aborts E_PUBKEY_COUNT_MISMATCH; we model as reject
  if (n < required) return false;
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const signer = qs.signers[i]!;
    if (seen.has(signer)) return false; // F-01 dedup-by-address
    seen.add(signer);
    if (!registeredOperators.has(signer)) return false; // is_operator_registered
    const ok = await verifyEd25519(pubkeys[i]!, qs.signatures[i]!, msg);
    if (!ok) return false;
  }
  return true;
}

/** ed25519_verify(sig, pubkey, msg) — mirrors Move sui::ed25519::ed25519_verify arg order. */
async function verifyEd25519(pubkey: number[], sig: number[], msg: Uint8Array): Promise<boolean> {
  const { Ed25519PublicKey } = await import('@mysten/sui/keypairs/ed25519');
  const pk = new Ed25519PublicKey(new Uint8Array(pubkey));
  return pk.verify(msg, new Uint8Array(sig));
}

describe('Leg 4 — G2 assembleCapTokenQuorum (multi-CP quorum assembler)', () => {
  it('2-attestation assembly → index-aligned { qs:{signers,signatures}, pubkeys, aggregateSig } a verify_quorum-shaped consumer accepts (CP-A == CP-B == Move byte-identity)', async () => {
    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const claim = goldenClaim();

    // Each CP independently re-derives + signs the golden ISSUE bytes (Leg-2 predicate).
    const attA = await rebuildCanonicalAndSignIfMatches(claim, cpA);
    const attB = await rebuildCanonicalAndSignIfMatches(claim, cpB);
    expect(attA).not.toBeNull();
    expect(attB).not.toBeNull();

    // Cross-daemon byte-identity: both CPs signed the SAME 81-byte golden canonical.
    const canonical = goldenCanonical();
    expect(canonical.length).toBe(81);
    expect(await cpA.getPublicKey().verify(canonical, new Uint8Array(attA!.signature))).toBe(true);
    expect(await cpB.getPublicKey().verify(canonical, new Uint8Array(attB!.signature))).toBe(true);

    // Discovered active-CP operator set (Leg 1 getActiveCpOperators projection). The
    // poster's self-declared `addr` IS its operator address here (registered).
    const discoveredCps: CpOperator[] = [
      { minerId: '0xaaa1', operator: cpA.toSuiAddress() },
      { minerId: '0xbbb2', operator: cpB.toSuiAddress() },
    ];

    const { qs, pubkeys } = assembleCapTokenQuorum(claim, [attA!, attB!], discoveredCps);

    // ── INDEX-ALIGNMENT in signature order ──
    expect(qs.signers.length).toBe(2);
    expect(qs.signatures.length).toBe(2);
    expect(pubkeys.length).toBe(2);
    // signers[i] = operator address; signatures[i] = RAW 64-byte sig; pubkeys[i] = 32-byte pubkey
    expect(qs.signers[0]).toBe(cpA.toSuiAddress());
    expect(qs.signers[1]).toBe(cpB.toSuiAddress());
    expect(qs.signatures[0]).toEqual(attA!.signature);
    expect(qs.signatures[1]).toEqual(attB!.signature);
    expect(pubkeys[0]).toEqual(attA!.pubkey);
    expect(pubkeys[1]).toEqual(attB!.pubkey);
    expect(qs.signatures[0]!.length).toBe(64);
    expect(pubkeys[0]!.length).toBe(32);

    // ── verify_quorum-shaped consumer ACCEPTS the assembled proof (M=2 of N=2) ──
    const registered = new Set([cpA.toSuiAddress(), cpB.toSuiAddress()]);
    const accepted = await verifyQuorumShaped(qs, pubkeys, canonical, registered, 2);
    expect(accepted).toBe(true);
  });

  it('FAIL-CLOSED (OQ-1): a stranger poster whose pubkey is NOT in the active-CP snapshot is DROPPED (never silent index-misalignment)', async () => {
    const cpA = Ed25519Keypair.generate();
    const stranger = Ed25519Keypair.generate(); // valid sig, but NOT registered
    const claim = goldenClaim();

    const attA = await rebuildCanonicalAndSignIfMatches(claim, cpA);
    const attStranger = await rebuildCanonicalAndSignIfMatches(claim, stranger);
    expect(attA).not.toBeNull();
    expect(attStranger).not.toBeNull();

    // Only cpA is in the discovered active-CP set; the stranger is not.
    const discoveredCps: CpOperator[] = [{ minerId: '0xaaa1', operator: cpA.toSuiAddress() }];

    const { qs, pubkeys, aggregateSig } = assembleCapTokenQuorum(
      claim,
      [attA!, attStranger!],
      discoveredCps,
    );

    // The stranger is dropped fail-closed → only cpA survives, arrays STAY aligned.
    expect(qs.signers).toEqual([cpA.toSuiAddress()]);
    expect(qs.signatures).toEqual([attA!.signature]);
    expect(pubkeys).toEqual([attA!.pubkey]);
    // aggregateSig carries only the surviving sig (audit blob, single-CP shape).
    expect(aggregateSig[0]).toBe(0x01);
    expect(aggregateSig.length).toBe(1 + 64);

    // The stranger's address NEVER appears in the signers column.
    expect(qs.signers).not.toContain(stranger.toSuiAddress());
  });

  it('poster declaring a NON-registered operator address is DROPPED fail-closed (OQ-1: address column is membership-checked against the discovered snapshot, design-drift #5)', async () => {
    // The registry stores NO CP pubkeys (Phase-2.x, design-drift correction #5), so there
    // is no on-chain pubkey→operator oracle. The poster's self-declared `addr` IS the
    // pubkey→address binding; the assembler checks it for MEMBERSHIP in the discovered
    // active-CP operator set. A poster that declares an address NOT in the snapshot (a lie,
    // or a just-joined node) is a deliberate fail-closed DROP — it would fail
    // `is_operator_registered` on-chain anyway. The TRUE operator (cp.toSuiAddress()) is in
    // the snapshot, but the poster declared a foreign address, so the attestation is
    // unusable and dropped (never a forged signers column).
    const cp = Ed25519Keypair.generate();
    const claim = goldenClaim();
    const att = await rebuildCanonicalAndSignIfMatches(claim, cp);
    expect(att).not.toBeNull();

    const lyingAtt: CapTokenIssueAttestation = {
      signature: att!.signature,
      pubkey: att!.pubkey,
      addr: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    };
    // The TRUE operator is registered, but the poster did not declare it.
    const discoveredCps: CpOperator[] = [{ minerId: '0xaaa1', operator: cp.toSuiAddress() }];

    const { qs, pubkeys } = assembleCapTokenQuorum(claim, [lyingAtt], discoveredCps);
    // Foreign-address poster dropped → empty, fail-closed. The foreign address NEVER
    // appears in qs.signers.
    expect(qs.signers).toEqual([]);
    expect(qs.signatures).toEqual([]);
    expect(pubkeys).toEqual([]);
    expect(qs.signers).not.toContain(lyingAtt.addr);
  });

  it('empty attestation list → empty index-aligned arrays + bare [0x01] aggregateSig marker', () => {
    const claim = goldenClaim();
    const { qs, pubkeys, aggregateSig } = assembleCapTokenQuorum(claim, [], []);
    expect(qs.signers).toEqual([]);
    expect(qs.signatures).toEqual([]);
    expect(pubkeys).toEqual([]);
    expect(aggregateSig).toEqual([0x01]);
  });

  it('aggregateSig (OQ-BUILD-1): vestigial audit blob = [0x01, ...sig64(0), ...sig64(1)] — single-CP shape generalized, never on-chain-parsed', async () => {
    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const claim = goldenClaim();
    const attA = (await rebuildCanonicalAndSignIfMatches(claim, cpA))!;
    const attB = (await rebuildCanonicalAndSignIfMatches(claim, cpB))!;
    const discoveredCps: CpOperator[] = [
      { minerId: '0xaaa1', operator: cpA.toSuiAddress() },
      { minerId: '0xbbb2', operator: cpB.toSuiAddress() },
    ];

    const { aggregateSig } = assembleCapTokenQuorum(claim, [attA, attB], discoveredCps);
    expect(aggregateSig[0]).toBe(0x01); // version/marker, matches single-CP [0x01,...sig64]
    expect(aggregateSig.length).toBe(1 + 64 + 64);
    // The concatenated RAW sigs are recoverable on the 64-byte boundary (audit-replay).
    expect(aggregateSig.slice(1, 65)).toEqual(attA.signature);
    expect(aggregateSig.slice(65, 129)).toEqual(attB.signature);
  });

  it('single surviving attestation → aggregateSig is byte-identical to the single-CP branch [0x01, ...sig64]', async () => {
    const cp = Ed25519Keypair.generate();
    const claim = goldenClaim();
    const att = (await rebuildCanonicalAndSignIfMatches(claim, cp))!;
    const discoveredCps: CpOperator[] = [{ minerId: '0xaaa1', operator: cp.toSuiAddress() }];

    const { qs, pubkeys, aggregateSig } = assembleCapTokenQuorum(claim, [att], discoveredCps);
    expect(qs.signers).toEqual([cp.toSuiAddress()]);
    expect(qs.signatures).toEqual([att.signature]);
    expect(pubkeys).toEqual([att.pubkey]);
    // Exactly the single-CP branch shape (index.ts:146): [0x01, ...sig64].
    expect(aggregateSig).toEqual([0x01, ...att.signature]);
  });
});
