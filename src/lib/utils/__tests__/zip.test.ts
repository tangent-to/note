/**
 * The archive a backup travels in.
 *
 * A backup that cannot be read back — here, or by an ordinary unzip tool — is
 * not a backup, so the round trip and the checks against damage are the point.
 * Interoperability with real tools is verified outside the test suite (unzip,
 * Python's zipfile), since those are not available everywhere tests run.
 */
import { describe, it, expect } from 'vitest';
import { crc32, createZip, readZip } from '../zip';

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

describe('crc32', () => {
  it('matches the standard check value', () => {
    // CRC-32/ISO-HDLC of "123456789".
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('createZip and readZip', () => {
  it('round-trips files, paths and contents', async () => {
    const files = [
      { path: 'backup/notes.js', data: text('// %% [javascript]\nconst x = 1;\n') },
      { path: 'backup/data/penguins.csv', data: text('species,mass\nAdelie,3750\n'.repeat(200)) },
      { path: 'backup/.tangent/backup.json', data: text('{"version":1}') },
    ];
    const back = await readZip(await createZip(files));
    expect(back.map((e) => e.path)).toEqual(files.map((f) => f.path));
    expect(back.map((e) => str(e.data))).toEqual(files.map((f) => str(f.data)));
  });

  it('keeps non-ASCII names, which a piece title often has', async () => {
    const back = await readZip(await createZip([{ path: 'mélodie – été.js', data: text('x') }]));
    expect(back[0].path).toBe('mélodie – été.js');
  });

  it('handles empty files and binary data', async () => {
    const binary = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
    const back = await readZip(await createZip([
      { path: 'empty.txt', data: new Uint8Array() },
      { path: 'noise.bin', data: binary },
    ]));
    expect(back[0].data.length).toBe(0);
    expect([...back[1].data]).toEqual([...binary]);
  });

  it('compresses what compresses', async () => {
    const repetitive = text('a'.repeat(100_000));
    const zip = await createZip([{ path: 'a.txt', data: repetitive }]);
    expect(zip.length).toBeLessThan(2_000);
  });

  it('refuses a file that is not an archive', async () => {
    await expect(readZip(text('just some text, no archive here'))).rejects.toThrow(/not a ZIP/);
  });

  it('refuses an archive whose contents were damaged', async () => {
    const zip = await createZip([{ path: 'a.txt', data: text('hello hello hello') }]);
    // Flip a byte inside the stored or deflated body.
    zip[40] ^= 0xff;
    await expect(readZip(zip)).rejects.toThrow();
  });

  it('refuses a path that would climb out of the archive', async () => {
    await expect(createZip([{ path: '../escape.js', data: text('x') }])).rejects.toThrow(/climbs out/);
  });
});
