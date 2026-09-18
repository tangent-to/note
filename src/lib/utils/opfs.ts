/**
 * The browser's own file system, used as a working directory.
 *
 * Without the companion there is no folder on disk to read or write, and a
 * browser page cannot make one: the File System Access API that would let it is
 * Chromium-only, which this app deliberately does not rely on. The Origin
 * Private File System is the part every current browser does implement — real
 * files and folders, private to this site, and reachable from a worker, which is
 * where cells run.
 *
 * It is storage, not a folder you can open in a file manager, and the browser
 * may clear it. That is why the Storage panel offers a backup, and why anything
 * written here appears there with a way to download it.
 *
 * Each notebook gets its own folder, so two notebooks cannot collide on
 * `data.csv` the way they would in one shared space.
 */

export interface VirtualFile {
  name: string;
  size: number;
  modified: number;
  type: string;
}

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/** The folder a notebook's files live in. Ids are not path-safe; names are. */
export function folderForNotebook(notebookId: string): string {
  return `notebooks/${encodeURIComponent(notebookId)}`;
}

async function directory(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!opfsAvailable()) return null;
  let handle = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean)) {
    try {
      handle = await handle.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return handle;
}

/** Split `figures/fig1.svg` into the folder to reach and the file to open. */
function split(dir: string, name: string): { folder: string; file: string } {
  const parts = `${dir}/${name}`.split('/').filter((p) => p && p !== '.');
  const file = parts.pop() ?? '';
  return { folder: parts.join('/'), file };
}

export async function readVirtualFile(dir: string, name: string): Promise<File | null> {
  const { folder, file } = split(dir, name);
  const handle = await directory(folder, false);
  if (!handle) return null;
  try {
    return await (await handle.getFileHandle(file)).getFile();
  } catch {
    return null;
  }
}

/**
 * Write a file, creating folders on the way.
 *
 * `createWritable` where it exists, and the worker-only sync handle where it
 * does not — Safari and Firefox implement OPFS writing that way in workers, and
 * a cell runs in a worker.
 */
export async function writeVirtualFile(
  dir: string,
  name: string,
  bytes: Uint8Array
): Promise<{ path: string; size: number }> {
  const { folder, file } = split(dir, name);
  const handle = await directory(folder, true);
  if (!handle) throw new Error('This browser has no private file system to write to.');
  const fileHandle = await handle.getFileHandle(file, { create: true });

  if (typeof (fileHandle as any).createWritable === 'function') {
    const writable = await (fileHandle as any).createWritable();
    await writable.write(bytes.slice());
    await writable.close();
  } else if (typeof (fileHandle as any).createSyncAccessHandle === 'function') {
    const access = await (fileHandle as any).createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(bytes.slice(), { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  } else {
    throw new Error('This browser cannot write to its private file system.');
  }
  return { path: `${folder}/${file}`.replace(/^\/+/, ''), size: bytes.length };
}

export async function deleteVirtualFile(dir: string, name: string): Promise<void> {
  const { folder, file } = split(dir, name);
  const handle = await directory(folder, false);
  await handle?.removeEntry(file).catch(() => {});
}

/** Every file in a notebook's folder, subfolders included, as `sub/name`. */
export async function listVirtualFiles(dir: string): Promise<VirtualFile[]> {
  const handle = await directory(dir, false);
  if (!handle) return [];
  const files: VirtualFile[] = [];
  const walk = async (folder: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, entry] of (folder as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
      } else {
        const file = await (entry as FileSystemFileHandle).getFile();
        files.push({ name: `${prefix}${name}`, size: file.size, modified: file.lastModified, type: file.type });
      }
    }
  };
  await walk(handle, '');
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Drop a notebook's whole folder, e.g. when the notebook is deleted. */
export async function removeVirtualFolder(dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  const parent = await directory(parts.join('/'), false);
  await (parent as any)?.removeEntry(name, { recursive: true }).catch(() => {});
}
