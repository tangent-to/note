/**
 * Compile the companion into the sidecar the desktop app spawns.
 *
 * Tauri looks for `binaries/note-serve-<target triple>`, the triple being the
 * one the Rust build itself uses — so it is asked of `rustc` rather than
 * guessed. The built app travels inside the binary (`--include dist`), which is
 * what lets the desktop app serve the same app a browser gets.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

function targetTriple() {
  const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = info.match(/^host:\s*(\S+)$/m);
  if (!host) throw new Error('rustc -vV did not report a host triple');
  return host[1];
}

const triple = targetTriple();
const output = `src-tauri/binaries/note-serve-${triple}`;
mkdirSync('src-tauri/binaries', { recursive: true });

console.log(`note serve → ${output}`);
const compile = spawnSync(
  'deno',
  ['compile', '-A', '--include', 'dist', '--output', output, 'cli/serve.ts'],
  { stdio: 'inherit' }
);
process.exit(compile.status ?? 1);
