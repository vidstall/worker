/**
 * Friendly adjective-noun aliases for bot sessions ("affectionate-jet"),
 * mirroring `cli/wallet.py`'s `_generate_alias` so pooled bots read the same
 * way pooled operator wallets do. Deliberately reimplemented here rather than
 * shared with the Python CLI -- different language/runtime, small enough
 * that a shared module isn't worth the cross-language plumbing.
 */

const ADJECTIVES = [
  'affectionate', 'amused', 'brave', 'calm', 'clever', 'cosmic', 'curious',
  'daring', 'eager', 'elegant', 'fearless', 'fierce', 'gentle', 'golden',
  'graceful', 'happy', 'humble', 'jolly', 'keen', 'lively', 'lucky',
  'mellow', 'merry', 'mighty', 'noble', 'nimble', 'patient', 'playful',
  'proud', 'quiet', 'quick', 'radiant', 'serene', 'sharp', 'silent',
  'silver', 'sincere', 'spirited', 'steady', 'sunny', 'swift', 'tender',
  'tranquil', 'vivid', 'witty', 'wise', 'zealous', 'bold', 'bright', 'cozy',
];

const NOUNS = [
  'jet', 'falcon', 'otter', 'harbor', 'meadow', 'canyon', 'comet', 'delta',
  'ember', 'fjord', 'glacier', 'grove', 'horizon', 'island', 'lagoon',
  'lantern', 'maple', 'meridian', 'nebula', 'orbit', 'orchid', 'panther',
  'pebble', 'phoenix', 'prairie', 'quartz', 'raven', 'reef', 'ridge',
  'river', 'sable', 'sequoia', 'shore', 'sparrow', 'summit', 'tundra',
  'valley', 'willow', 'wren', 'zephyr', 'brook', 'cedar', 'cliff', 'coral',
  'dune', 'forest', 'glade', 'hollow', 'isle', 'marsh',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/** Generates an alias unique among `existing`. */
export function generateBotAlias(existing: ReadonlySet<string>): string {
  for (let i = 0; i < 200; i++) {
    const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!existing.has(candidate)) return candidate;
  }
  let suffix = 2;
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  let candidate = `${base}-${suffix}`;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
