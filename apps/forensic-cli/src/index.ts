#!/usr/bin/env node
/**
 * Forensic CLI — entry point.
 *
 * Subcommands:
 *   collect          --rpc <url> --package <id> --modules <csv> --out <jsonl>
 *   report slashes        --in <jsonl> [--json]
 *   report proofs         --in <jsonl> --room-id <id> [--json]
 *   report relay-history  --in <jsonl> --miner-id <id> [--json]
 *   report rewards        --in <jsonl> [--room-id <id>] [--json]
 *   smoke
 *
 * Spec: docs/70-operations/forensic-cli.md § 7.
 */

import { createSuiClient } from '@dvconf/shared';
import { collect } from './collect.js';
import {
  loadTranscript,
  reportSlashes,
  reportProofs,
  reportRelayHistory,
  reportRewards,
} from './report.js';
import { runSmoke } from './smoke.js';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function emit(obj: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  }
}

async function cmdCollect(flags: Record<string, string | true>): Promise<void> {
  const rpc = String(flags['rpc'] ?? '');
  const pkg = String(flags['package'] ?? '');
  const modulesCsv = String(flags['modules'] ?? 'economic_layer,relay_registry,room_manager');
  const outPath = String(flags['out'] ?? '.forensic/events.jsonl');
  if (!rpc || !pkg) {
    process.stderr.write('forensic collect: --rpc and --package are required\n');
    process.exit(2);
  }
  const client = createSuiClient(rpc);
  const modules = modulesCsv.split(',').map((s) => s.trim()).filter(Boolean);
  const result = await collect({ client, packageId: pkg, modules, outPath });
  emit(result, true);
}

async function cmdReport(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const sub = positional[0];
  const inPath = String(flags['in'] ?? '.forensic/events.jsonl');
  const asJson = flags['json'] === true || flags['json'] === 'true';
  const events = await loadTranscript(inPath);

  switch (sub) {
    case 'slashes':
      emit(reportSlashes(events), asJson);
      return;
    case 'proofs': {
      const roomId = String(flags['room-id'] ?? '');
      if (!roomId) {
        process.stderr.write('forensic report proofs: --room-id is required\n');
        process.exit(2);
      }
      emit(reportProofs(events, roomId), asJson);
      return;
    }
    case 'relay-history': {
      const minerId = String(flags['miner-id'] ?? '');
      if (!minerId) {
        process.stderr.write('forensic report relay-history: --miner-id is required\n');
        process.exit(2);
      }
      emit(reportRelayHistory(events, minerId), asJson);
      return;
    }
    case 'rewards': {
      const roomId = flags['room-id'] !== undefined ? String(flags['room-id']) : undefined;
      emit(reportRewards(events, roomId), asJson);
      return;
    }
    default:
      process.stderr.write(`forensic report: unknown subcommand "${sub}"\n`);
      process.exit(2);
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case 'collect':
      await cmdCollect(flags);
      return;
    case 'report':
      await cmdReport(positional.slice(1), flags);
      return;
    case 'smoke':
      await runSmoke();
      return;
    default:
      process.stderr.write(
        'forensic-cli\n' +
          '  collect          --rpc <url> --package <id> [--modules <csv>] --out <jsonl>\n' +
          '  report slashes        --in <jsonl>\n' +
          '  report proofs         --in <jsonl> --room-id <id>\n' +
          '  report relay-history  --in <jsonl> --miner-id <id>\n' +
          '  report rewards        --in <jsonl> [--room-id <id>]\n' +
          '  smoke\n',
      );
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`forensic: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
