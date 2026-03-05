/**
 * Keypair loading utilities for daemon wallets.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/**
 * Load an Ed25519Keypair from a bech32 secret key stored in an environment variable.
 * The key should start with 'suiprivkey'.
 */
export function loadKeypair(envVar: string): Ed25519Keypair {
  const secretKey = process.env[envVar];
  if (!secretKey) {
    throw new Error(`Missing keypair env var: ${envVar}`);
  }
  return Ed25519Keypair.fromSecretKey(secretKey);
}

/**
 * Generate a fresh Ed25519Keypair for use as a validator session wallet.
 * The private key should NEVER be logged or persisted to files committed to git.
 */
export function generateSessionKeypair(): {
  keypair: Ed25519Keypair;
  address: string;
} {
  const keypair = new Ed25519Keypair();
  const address = keypair.getPublicKey().toSuiAddress();
  return { keypair, address };
}
