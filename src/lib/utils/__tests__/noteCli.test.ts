/**
 * The installed command line.
 *
 * `note` reaches people three ways, and all three have to arrive at the same
 * place: `deno task serve` from a clone, `deno run -A cli/serve.ts` as it has
 * always been called, and a compiled binary on PATH, which is the only form
 * that is called `note serve` by anybody who did not clone anything. So the
 * subcommand is parsed off, the flags keep working on either side of it, and
 * asking the binary what it is must not start a server.
 *
 * These come from cli/command.ts rather than cli/serve.ts, and that is not
 * tidiness: a test inside src/ is type checked with the app's tsconfig, where
 * `Deno` does not exist. Importing the Deno modules from here would put 47
 * errors into the app's type check and turn CI red.
 */
import { describe, it, expect } from 'vitest';
// A JSON import, not node:fs: the app's tsconfig has no node types either.
import pkg from '../../../../package.json';
import {
  DEFAULT_PORT,
  VERSION,
  binaryName,
  help,
  installDir,
  isRuntime,
  parseArgs,
  versionText,
} from '../../../../cli/command';

/** Where the app is, supplied by the caller, which knows where its own module is. */
const DIST = '/somewhere/dist';
const args = (argv: string[]) => parseArgs(argv, DIST);

describe('parseArgs', () => {
  it('takes the subcommand off, so `note serve nb` is the documented form', () => {
    expect(args(['serve', 'nb']).targets).toEqual(['nb']);
  });

  it('still takes a bare target, as every existing call does', () => {
    expect(args(['nb']).targets).toEqual(['nb']);
  });

  it('reads the flags that follow the subcommand', () => {
    const parsed = args(['serve', 'nb', '--port', '5000', '--dist', 'build']);
    expect(parsed.targets).toEqual(['nb']);
    expect(parsed.port).toBe(5000);
    expect(parsed.dist).toBe('build');
  });

  it('reads the subcommand only as the first word, so a folder called serve is still a folder', () => {
    // Anywhere else in the line, "serve" is a path the reader typed.
    expect(args(['--port', '5000', 'serve']).targets).toEqual(['serve']);
  });

  it('defaults the port, and the app to the one it was given', () => {
    expect(args(['serve', 'nb']).port).toBe(DEFAULT_PORT);
    expect(args(['serve', 'nb']).dist).toBe(DIST);
  });

  it('has a serve subcommand with nothing after it mean no notebook at all', () => {
    // Which is what help() gets printed for, rather than a target named
    // "serve" that does not exist.
    expect(args(['serve']).targets).toEqual([]);
  });

  it('reads a question as a question', () => {
    for (const flag of ['--help', '-h']) {
      expect(args([flag]).help).toBe(true);
      expect(args(['serve', flag]).help).toBe(true);
    }
    for (const flag of ['--version', '-v']) {
      expect(args([flag]).version).toBe(true);
      expect(args(['serve', flag]).version).toBe(true);
    }
  });

  it('ignores a flag it does not know, as it always has', () => {
    expect(args(['--nonsense', 'nb']).targets).toEqual(['nb']);
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

describe('DEFAULT_PORT', () => {
  it('is 4321, the port the README and the help both promise', () => {
    expect(DEFAULT_PORT).toBe(4321);
    expect(help()).toContain('4321');
  });
});

describe('VERSION', () => {
  it('is the version in package.json, which is the one thing that ships a number', () => {
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
    // A checkout has no stamp, and an older binary has none either. Both are
    // "unknown", which is the truth in either case.
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
