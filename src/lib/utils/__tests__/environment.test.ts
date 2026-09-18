/**
 * The lock file.
 *
 * It is committed to git and read back on another machine, so its shape has to
 * be stable, its diffs readable, and a file it cannot understand has to be
 * refused rather than half-applied — pinning the wrong things is worse than
 * not pinning.
 */
import { describe, it, expect } from 'vitest';
import { diffLock, emptyLock, parseLock, serializeLock, shortName, LOCK_FILE } from '../environment';

const lock = {
  ...emptyLock(),
  frozen: true,
  frozenAt: '2026-09-18T10:00:00.000Z',
  modules: {
    'https://cdn.jsdelivr.net/npm/d3/+esm': 'sha256-AAA=',
    'https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js': 'sha256-BBB=',
  },
};

describe('the lock file', () => {
  it('round-trips', () => {
    expect(parseLock(serializeLock(lock))).toEqual(lock);
  });

  it('sorts its URLs, so a diff shows what changed and nothing else', () => {
    const shuffled = { ...lock, modules: { b: 'sha256-B=', a: 'sha256-A=' } };
    expect(serializeLock(shuffled).indexOf('"a"')).toBeLessThan(serializeLock(shuffled).indexOf('"b"'));
    expect(serializeLock(lock).endsWith('\n')).toBe(true);
  });

  it('refuses a file it does not understand', () => {
    expect(() => parseLock('{oops')).toThrow(new RegExp(`${LOCK_FILE} is not valid JSON`));
    expect(() => parseLock('{"format":"other"}')).toThrow(/not a tangent lock file/);
    expect(() => parseLock('{"format":"tangent-lock","version":99}')).toThrow(/newer version/);
  });

  it('drops entries whose hash is not one', () => {
    const parsed = parseLock('{"format":"tangent-lock","version":1,"modules":{"a":"sha256-Zm9v","b":"nope","c":123}}');
    expect(parsed.modules).toEqual({ a: 'sha256-Zm9v' });
  });
});

describe('diffLock', () => {
  it('names what is new, what moved, and what is gone', () => {
    const diff = diffLock(lock, {
      'https://cdn.jsdelivr.net/npm/d3/+esm': 'sha256-AAA=',
      'https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js': 'sha256-MOVED=',
      'https://cdn.jsdelivr.net/npm/tone/+esm': 'sha256-NEW=',
    });
    expect(diff.unchanged).toBe(1);
    expect(diff.changed).toEqual(['https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js']);
    expect(diff.added).toEqual(['https://cdn.jsdelivr.net/npm/tone/+esm']);
    expect(diff.removed).toEqual([]);
  });

  it('reports what the lock has and the notebook no longer loads', () => {
    expect(diffLock(lock, {}).removed).toHaveLength(2);
  });
});

describe('shortName', () => {
  it('is the package, not the whole URL', () => {
    expect(shortName('https://cdn.jsdelivr.net/npm/d3/+esm')).toBe('d3');
    expect(shortName('https://cdn.jsdelivr.net/gh/jmonlabs/studio@main/src/index.js')).toBe('jmonlabs/studio@main/src/index.js');
    expect(shortName('https://gleitz.github.io/midi-js-soundfonts/MusyngKite/x-mp3/A4.mp3'))
      .toBe('gleitz.github.io/midi-js-soundfonts/MusyngKite/x-mp3/A4.mp3');
    expect(shortName('not a url')).toBe('not a url');
  });
});
