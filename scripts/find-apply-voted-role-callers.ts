/**
 * find-apply-voted-role-callers.ts — F47 Phase 1.0 pre-impl gate (REQ-RV-008).
 *
 * Enumerates ALL callers of `apply_voted_role` across the dvconf 3-repo
 * workspace (dvconf-contracts, dvconf-daemons, dvconf-client). The output
 * locks the caller-set scope that Phase 1.5 must refactor when the function
 * signature changes (per plans/role-revote-pool/milestone-1/DESIGN.md).
 *
 * Spec: plans/role-revote-pool/milestone-1/ROADMAP.md § Phase 1.0
 *
 * Output schema:
 *   {
 *     count: number,
 *     locations: Array<{ file: string, line: number, context: string }>
 *   }
 *
 * Scope:
 *   - File extensions: .move, .ts
 *   - Roots: dvconf-contracts/, dvconf-daemons/, dvconf-client/ (sibling repos
 *     to the script's parent dvconf-daemons/, i.e. C:\Thesis\dvconf\)
 *   - Skipped dirs: node_modules, build, dist, .git, target, .turbo, .next,
 *     .vite, coverage, .pnpm, .pnpm-store, .scratch-odt, .evidence
 *
 * Determinism: locations are sorted by file ASC then line ASC. Same input →
 * identical JSON across runs/machines.
 *
 * Invocation (from dvconf-daemons/):
 *   pnpm tsx scripts/find-apply-voted-role-callers.ts
 *
 * Outputs:
 *   - stdout: pretty JSON
 *   - file:   <workspace-root>/.evidence/verification/phase-1.0-caller-enumeration.json
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dvconf-daemons/scripts/ → dvconf-daemons/ → C:\Thesis\dvconf\
const DAEMONS_ROOT = resolve(__dirname, '..');
const WORKSPACE_ROOT = resolve(DAEMONS_ROOT, '..');

const SEARCH_ROOTS = ['dvconf-contracts', 'dvconf-daemons', 'dvconf-client'].map((d) =>
  join(WORKSPACE_ROOT, d),
);

const ALLOWED_EXTS = new Set(['.move', '.ts']);

const SKIP_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  '.git',
  'target',
  '.turbo',
  '.next',
  '.vite',
  'coverage',
  '.pnpm',
  '.pnpm-store',
  '.scratch-odt',
  '.evidence',
]);

// Match `apply_voted_role` as a whole-identifier token (word boundary on both
// sides). This catches `dvconf::role_voting::apply_voted_role`, plain calls,
// references in doc-comments, and Move test invocations — but NOT a hypothetical
// `apply_voted_role_v2` or `not_apply_voted_role`.
const APPLY_RE = /(?<![A-Za-z0-9_])apply_voted_role(?![A-Za-z0-9_])/;

export interface CallerLocation {
  file: string;
  line: number;
  context: string;
}

export interface CallerEnumResult {
  count: number;
  locations: CallerLocation[];
}

function hasAllowedExt(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_EXTS.has(name.slice(dot));
}

function walk(rootDir: string, out: string[]): void {
  if (!existsSync(rootDir)) return;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return; // permissions / vanished dir — skip silently
  }
  for (const ent of entries) {
    const full = join(rootDir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(full, out);
    } else if (ent.isFile()) {
      if (hasAllowedExt(ent.name)) out.push(full);
    }
    // Symlinks / other entry types: ignore.
  }
}

function scanFile(absPath: string): CallerLocation[] {
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  if (!APPLY_RE.test(content)) return [];

  const lines = content.split(/\r?\n/);
  const hits: CallerLocation[] = [];
  const relPath = relative(WORKSPACE_ROOT, absPath).split(sep).join('/');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (APPLY_RE.test(line)) {
      hits.push({
        file: relPath,
        line: i + 1,
        context: line.trim(),
      });
    }
  }
  return hits;
}

export function enumerateCallers(): CallerEnumResult {
  const files: string[] = [];
  for (const root of SEARCH_ROOTS) walk(root, files);

  const locations: CallerLocation[] = [];
  for (const f of files) {
    const hits = scanFile(f);
    if (hits.length > 0) locations.push(...hits);
  }

  // Deterministic ordering: file ASC, then line ASC.
  locations.sort((a, b) => {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
    return a.line - b.line;
  });

  return { count: locations.length, locations };
}

function main(): void {
  const result = enumerateCallers();
  const json = JSON.stringify(result, null, 2);
  process.stdout.write(`${json}\n`);

  const evidenceDir = join(WORKSPACE_ROOT, '.evidence', 'verification');
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
  const outPath = join(evidenceDir, 'phase-1.0-caller-enumeration.json');
  writeFileSync(outPath, `${json}\n`, 'utf8');
}

// Run when invoked directly (tsx / node), not when imported as a module.
const isDirectRun = (() => {
  try {
    return resolve(process.argv[1] ?? '') === resolve(__filename);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
