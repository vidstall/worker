// check-publish-fresh.mjs — idempotency gate for the demo move-publish one-shot.
//
// WHY (root cause A, 2026-06-24): the consolidated runner issues `docker compose run --rm <scenario>`
// WITHOUT `--no-deps`, so every scenario (1b/2/2a/5) RE-TRIGGERS the `service_completed_successfully`
// move-publish dependency. `sui client test-publish` is non-idempotent, so each re-trigger minted a
// BRAND-NEW package (5 in one boot). cp-daemon latched the 1st package while validators/host latched
// the last → role-vote/cap-token/canary desync (Stage 1b/2c/5-canary FAIL). Making re-publish a no-op
// when a package is ALREADY live on this chain converges every consumer on ONE package.
//
// WHY .mjs (not .ts): the move-publish container's entrypoint is plain `/bin/bash`, runs the
// volume-mounted /entrypoint/demo/publish-and-init.sh, and uses bare `node` (NOT tsx). A .mjs runs with
// just `node` + the global fetch (Node 18+) — no tsx, no node_modules, no working-dir assumptions — and
// because scripts/ is bind-mounted read-only to /entrypoint, editing it needs NO image rebuild. The
// pure decision helpers are exported for the hermetic unit test; the I/O glue runs only when invoked
// as `node check-publish-fresh.mjs` (the isMain guard below).
//
// Exit code (consumed by `if node .../check-publish-fresh.mjs` in publish-and-init.sh):
//   0  → a recorded package is LIVE on SUI_RPC_URL → SKIP re-publish (idempotent no-op)
//   1  → no/unreadable output, no recorded package, package not found, or RPC unreachable → PUBLISH
//        (fail-safe: when in doubt, publish rather than skip with a dead/unknown package).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Pure: extract the published packageId from a parsed `sui client test-publish --json` output.
 * Returns the packageId string, or null when absent/malformed (never throws).
 */
export function extractPackageId(parsed) {
  const changes = (parsed && parsed.objectChanges) || [];
  if (!Array.isArray(changes)) return null;
  const published = changes.find((c) => c && c.type === 'published');
  return (published && published.packageId) || null;
}

/**
 * Pure: is a `sui_getObject` JSON-RPC response a LIVE object on this chain?
 * True only when result.data.objectId is present (a missing object returns data:null +
 * an error code like "notExists"). Never throws.
 */
export function isLiveGetObjectResponse(rpcJson) {
  return Boolean(rpcJson && rpcJson.result && rpcJson.result.data && rpcJson.result.data.objectId);
}

async function main() {
  const PUBLISH_OUTPUT = process.env.PUBLISH_OUTPUT || '/shared/publish-output.json';
  const RPC = process.env.SUI_RPC_URL || 'http://127.0.0.1:9000';

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PUBLISH_OUTPUT, 'utf8'));
  } catch {
    process.exit(1); // no/unreadable publish output → must publish
  }

  const pkg = extractPackageId(parsed);
  if (!pkg) process.exit(1); // nothing recorded yet → publish

  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getObject', params: [pkg, { showType: true }] }),
    });
    const json = await res.json();
    if (isLiveGetObjectResponse(json)) {
      process.stderr.write(`[check-publish-fresh] ${pkg} live on ${RPC} → SKIP republish\n`);
      process.exit(0); // live → skip republish
    }
    process.stderr.write(`[check-publish-fresh] ${pkg} NOT live on ${RPC} → republish\n`);
  } catch (e) {
    process.stderr.write(`[check-publish-fresh] RPC check of ${pkg} on ${RPC} failed (${(e && e.message) || e}) → republish\n`);
  }
  process.exit(1); // not live / unreachable → publish (fail-safe)
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) await main();
