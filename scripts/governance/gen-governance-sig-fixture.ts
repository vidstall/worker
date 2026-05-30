/**
 * F47 Phase 1.4 — CP-quorum governance signature fixture generator.
 *
 * WHY: Move unit tests cannot produce an ed25519 signature in-VM (the VM only
 * exposes `ed25519_verify`, not sign). The only ready-made valid (pubkey, sig)
 * pair is RFC-8032 §7.1 over an EMPTY message — which cannot exercise the TRUE
 * positive path of a governance entry whose canonical message is non-empty.
 *
 * This dev-tool reproduces `role_voting::build_governance_msg`'s EXACT byte layout
 * off-chain, signs it with @mysten/sui's Ed25519Keypair (the SAME library the
 * cp-daemon Phase 2.3 governance-coordinator will use to sign), and self-verifies
 * the signature TWO independent ways (@mysten PublicKey.verify + Node's built-in
 * crypto over a hand-built SPKI key) so the emitted hex constants are bulletproof.
 *
 * The Move test (tests/registry/role_voting_governance_tests.move) hardcodes the
 * emitted PK/SIG/MSG hex. A `build_governance_msg == EXPECTED_MSG` Move assertion
 * locks the Move<->TS byte layout against drift. This script is the reproducibility
 * record — it is NOT a test-time dependency.
 *
 * Canonical message layout (25 bytes, little-endian — mirrors room_capability's
 * hand-rolled BCS append style; byte format provisional per OQ-RV-1; on-chain nonce/epoch
 * replay-enforcement deferred to the cp-daemon Phase 2.3 governance-coordinator (OQ-RV-4)):
 *   byte  0      : action            (u8)   1 = update_revote_cooldown_epochs
 *                                            2 = update_max_idle_epochs
 *   bytes 1..8   : new_value         (u64 LE)
 *   bytes 9..16  : nonce             (u64 LE)
 *   bytes 17..24 : epoch             (u64 LE)
 *
 * Run: pnpm --dir dvconf-daemons exec tsx scripts/governance/gen-governance-sig-fixture.ts
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';

const ACTION_UPDATE_COOLDOWN = 1;
const ACTION_UPDATE_MAX_IDLE = 2;

/** Deterministic TEST-ONLY seed (bytes 0x01..0x20). NEVER a production key. */
const TEST_SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));

/** Build the 25-byte canonical governance message — must match Move byte-for-byte. */
function buildGovernanceMsg(action: number, newValue: bigint, nonce: bigint, epoch: bigint): Uint8Array {
  const buf = new Uint8Array(25);
  const dv = new DataView(buf.buffer);
  buf[0] = action;
  dv.setBigUint64(1, newValue, true);   // little-endian
  dv.setBigUint64(9, nonce, true);
  dv.setBigUint64(17, epoch, true);
  return buf;
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Independent cross-check: verify a raw ed25519 sig via Node crypto + a hand-built SPKI key. */
function nodeCryptoVerify(rawPubkey32: Uint8Array, msg: Uint8Array, sig64: Uint8Array): boolean {
  // SPKI DER prefix for an ed25519 public key (RFC 8410): 12 bytes + 32-byte raw key.
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([spkiPrefix, Buffer.from(rawPubkey32)]);
  const keyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });
  return nodeVerify(null, Buffer.from(msg), keyObj, Buffer.from(sig64));
}

async function main() {
  const kp = Ed25519Keypair.fromSecretKey(TEST_SEED);
  const pubkey = kp.getPublicKey().toRawBytes();
  if (pubkey.length !== 32) throw new Error(`pubkey not 32 bytes: ${pubkey.length}`);

  const cases = [
    { name: 'COOLDOWN', action: ACTION_UPDATE_COOLDOWN, newValue: 21n, nonce: 0n, epoch: 0n },
    { name: 'MAX_IDLE', action: ACTION_UPDATE_MAX_IDLE, newValue: 45n, nonce: 0n, epoch: 0n },
  ];

  const out: Record<string, unknown> = { pubkey_hex: toHex(pubkey), cases: {} as Record<string, unknown> };

  for (const c of cases) {
    const msg = buildGovernanceMsg(c.action, c.newValue, c.nonce, c.epoch);
    const sig = await kp.sign(msg);                         // raw 64-byte ed25519 sig (no Sui intent)
    if (sig.length !== 64) throw new Error(`sig not 64 bytes: ${sig.length}`);

    const okMysten = await kp.getPublicKey().verify(msg, sig);
    const okNode = nodeCryptoVerify(pubkey, msg, sig);
    if (!okMysten || !okNode) {
      throw new Error(`VERIFY FAILED for ${c.name}: mysten=${okMysten} node=${okNode}`);
    }

    (out.cases as Record<string, unknown>)[c.name] = {
      action: c.action,
      new_value: Number(c.newValue),
      nonce: Number(c.nonce),
      epoch: Number(c.epoch),
      msg_hex: toHex(msg),
      msg_len: msg.length,
      sig_hex: toHex(sig),
      verified_mysten: okMysten,
      verified_node: okNode,
    };
  }

  console.log(JSON.stringify(out, null, 2));
  console.error('\nAll signatures self-verified via BOTH @mysten/sui and Node crypto (SPKI). Fixture is sound.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
