/**
 * Constants for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes. Path constants are
 * re-derived from this module's own location (one directory deeper than
 * the original file) so the resolved absolute paths are identical to the
 * originals.
 */

import { getFaucetHost } from '@mysten/sui/faucet';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGraphQLClient } from '../../../packages/shared/src/index.ts';
import { CHAIN_LATENCY_SCHEMA_VERSION } from '../chain-latency-evidence.ts';

export const MODULE = 'measure-chain-latency';
export const SCHEMA_VERSION = CHAIN_LATENCY_SCHEMA_VERSION;
export const POLL_INTERVAL_MS = 5_000;
export const EVENT_TIMEOUT_MS = 30_000;
export const PINNED_CONTRACT_REF = '17e1fce0efd7b7668a5cd7d6aa34ebae762670bd';
export const PINNED_FRAMEWORK_REV = '94ad8ccd0ed6c089a9fe072ff80c918b5ab44943';
export const PINNED_SUI_CLI = '1.66.2';
export const ESCROW_AMOUNT_MIST = 1_000_000n;
export const GAS_BUDGET_MIST = 100_000_000;
export const EXPECTED_RELAYS = 2;
export const EXPECTED_VALIDATORS = 4;
export const PROOFS_PER_ROOM = EXPECTED_RELAYS * EXPECTED_VALIDATORS;
export const FAUCET_URL = getFaucetHost('localnet');
// Event queries only (exactEvent's RoomCreated/EscrowCreated/etc. lookups) --
// no-op on localnet's JSON-RPC (which already returns events populated), but
// matches the same fallback devnet callers need (see chain/events.ts docstring).
export const GRAPHQL_CLIENT = createGraphQLClient('localnet');

// This file lives at scripts/eval/chain-latency/constants.ts, i.e. one
// directory deeper than the original scripts/eval/measure-chain-latency.ts.
// Walking up two levels from here lands on the same scripts/eval directory
// the original HERE constant pointed to, so every derived path below is
// byte-for-byte identical to the original.
const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..', '..');
export const DAEMONS_ROOT = resolve(HERE, '..', '..');
export const WORKSPACE_ROOT = resolve(DAEMONS_ROOT, '..');
export const CONTRACTS_SOURCE_ROOT = resolve(WORKSPACE_ROOT, 'dvconf-contracts');
export const CLIENT_ROOT = resolve(WORKSPACE_ROOT, 'dvconf-client');
