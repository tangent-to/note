/**
 * The installed command line.
 *
 * `note` reaches people three ways, and all three have to arrive at the same
 * place: `deno task serve` from a clone, `deno run -A cli/serve.ts` as it has
 * always been called, and a compiled binary on PATH, which is the only form
 * that is called `note serve` by anybody who did not clone anything. So the
 * subcommand is parsed off, the flags keep working on either side of it, and
 * asking the binary what it is must not start a server.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION, help, isRuntime, parseArgs, versionText } from '../../../../cli/serve';
import { binaryName, installDir } from '../../../../cli/install';

describe('parseArgs', () => {
  it('takes the subcommand off, so `note serve nb` is the documented form', () => {
    expect(parseArgs(['serve', 'nb']).targets).toEqual(['nb']);
  });

  it('reads a question that follows the subcommand', () => {
    expect(parseArgs(['serve', '--help']).help).toBe(true);
  });

  it('still takes a bare target, as every existing call does', () => {
    expect(parseArgs(['nb']).targets).toEqual(['nb']);
  });

  it('reads the flags that follow the subcommand', () => {
    const args = parseArgs(['serve', 'nb', '--port', '5000', '--dist', 'build']);
    expect(args.targets).toEqual(['nb']);
    expect(args.port).toBe(5000);
    expect(args.dist).toBe('build');
  });

  it('reads the subcommand only as the first word, so a folder called serve is still a folder', () => {
    // Anywhere else in the line, "serve" is a path the reader typed.
    expect(parseArgs(['--port', '5000', 'serve']).targets).toEqual(['serve']);
  });

  it('defaults the port, and finds the app beside itself', () => {
    const args = parseArgs(['serve', 'nb']);
    expect(args.port).toBe(4321);
    // Resolved against the module, not the working directory, so a binary
    // installed anywhere still finds the copy of the app inside it.
    expect(args.dist).toMatch(/[/\\]dist$/);
  });

  it('has a serve subcommand with nothing after it mean no notebook at all', () => {
    // Which is what help() gets printed for, rather than a target named
    // "serve" that does not exist.
    expect(parseArgs(['serve']).targets).toEqual([]);
  });

  it('reads a question as a question', () => {
    for (const flag of ['--help', '-h']) {
      expect(parseArgs([flag]).help).toBe(true);
    }
    for (const flag of ['--version', '-v']) {
      expect(parseArgs([flag]).version).toBe(true);
    }
  });

  it('ignores a flag it does not know, as it always has', () => {
    expect(parseArgs(['--nonsense', 'nb']).targets).toEqual(['nb']);
  });
});

describe('help', () => {
  it('leads with the command and lists every option it reads', () => {
    const text = help();
    expect(text).toMatch(/note serve <notebook\.js\|notebook\.html\|directory>/);
    for (const flag of ['--port', '--dist', '--help', '--version']) {
      expect(text).toContain(flag);
    }
  });
});

describe('VERSION', () => {
  it('is the version in package.json, which is the one thing that ships a number', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('isRuntime', () => {
  it('names the runtime, and nothing else that runs this', () => {
    // The stamp describes a build, so a run under the runtime must not claim
    // one, and a binary must not be turned away for being called something.
    expect(isRuntime('deno')).toBe(true);
    expect(isRuntime('deno.exe')).toBe(true);
    expect(isRuntime('DENO')).toBe(true);
    expect(isRuntime('note')).toBe(false);
    expect(isRuntime('note.exe')).toBe(false);
  });
});

describe('versionText', () => {
  // A version number alone cannot answer "did that update land?", since it only
  // changes when package.json does. The build is what changes.
  const installed = { revision: '445dd95a1f2e3d4c5b6a7d8e9f0a1b2c3d4e5f60', installed: '2026-09-25T14:22:03.117Z' };

  it('names the build an install embedded, and the source it came from', () => {
    const text = versionText(installed);
    expect(text).toContain(`note ${VERSION}`);
    expect(text).toContain('2026-09-25T14:22:03.117Z');
    expect(text).toContain('445dd95');
  });

  it('says so when there is nothing to claim, rather than guessing', () => {
    // Run from a checkout there is no stamp, and an older binary has none
    // either. Both are "unknown", which is the truth in either case.
    expect(versionText(null)).toContain('unknown');
    expect(versionText(null)).toContain(`note ${VERSION}`);
  });
});

describe('installDir', () => {
  it('is where deno install -g already put things', () => {
    expect(installDir({ HOME: '/home/reader' })).toBe('/home/reader/.deno/bin');
    expect(installDir({ USERPROFILE: 'C:/Users/reader' })).toBe('C:/Users/reader/.deno/bin');
  });

  it('follows DENO_INSTALL_ROOT when it is set, as deno does', () => {
    expect(installDir({ DENO_INSTALL_ROOT: '/opt/deno', HOME: '/home/reader' })).toBe('/opt/deno/bin');
  });
});

describe('binaryName', () => {
  it('is plain on posix and needs the extension windows wants', () => {
    expect(binaryName('darwin')).toBe('note');
    expect(binaryName('linux')).toBe('note');
    expect(binaryName('windows')).toBe('note.exe');
  });
});
