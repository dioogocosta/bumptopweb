/**
 * Adapter de filesystem — OPFS (Modo B, universal).
 *
 * Sandbox de arquivos dentro do navegador (Origin Private File System).
 * Usado quando a File System Access API não existe (Firefox/Safari) ou o
 * usuário prefere não dar acesso à pasta real. É o modo padrão do PWA.
 */
import type { FsEntry, IFileSystem } from '@core/ports/index';

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

export class OpfsFileSystem implements IFileSystem {
  private rootPromise: Promise<DirHandle> | null = null;

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
  }

  private root(): Promise<DirHandle> {
    if (!this.rootPromise) {
      this.rootPromise = navigator.storage.getDirectory();
    }
    return this.rootPromise;
  }

  async requestDirectory(): Promise<boolean> {
    // OPFS não pede permissão (é privado à origem); cria a raiz se preciso.
    if (!OpfsFileSystem.isSupported()) return false;
    await this.root();
    return true;
  }

  mode(): 'fs-access' | 'opfs' | 'virtual' {
    return 'opfs';
  }

  /** Caminho '/' → handle (descendo segmentos). */
  private async resolve(path: string): Promise<FileSystemHandle | null> {
    const root = await this.root();
    const segs = path.split('/').filter(Boolean);
    let dir: DirHandle = root;
    for (let i = 0; i < segs.length - 1; i++) {
      try {
        dir = (await dir.getDirectoryHandle(segs[i])) as DirHandle;
      } catch {
        return null;
      }
    }
    if (segs.length === 0) return root;
    const last = segs[segs.length - 1];
    try {
      return await dir.getFileHandle(last);
    } catch {
      try {
        return await dir.getDirectoryHandle(last);
      } catch {
        return null;
      }
    }
  }

  async list(path: string): Promise<FsEntry[]> {
    const h = await this.resolve(path);
    if (!h || h.kind !== 'directory') return [];
    const dir = h as DirHandle;
    const out: FsEntry[] = [];
    for await (const [name, handle] of (
      dir as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (name.startsWith('.')) continue; // ignora arquivos ocultos/internos (.opfs-sahpool)
      const isDir = handle.kind === 'directory';
      let size = 0;
      let mtime = 0;
      if (!isDir) {
        try {
          const f = await (handle as FileHandle).getFile();
          size = f.size;
          mtime = f.lastModified;
        } catch {
          /* ignore */
        }
      }
      const base = '/' + path.split('/').filter(Boolean).join('/');
      out.push({ path: (base === '/' ? '' : base) + '/' + name, name, isDir, size, mtime });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const h = await this.resolve(path);
    if (!h || h.kind !== 'file') throw new Error(`Arquivo não encontrado: ${path}`);
    const file = await (h as FileHandle).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    if (!name) throw new Error('Caminho inválido');
    let dir: DirHandle = await this.root();
    for (const s of segs) dir = (await dir.getDirectoryHandle(s, { create: true })) as DirHandle;
    const fh = (await dir.getFileHandle(name, { create: true })) as FileHandle;
    const w = await fh.createWritable();
    await w.write(data.slice().buffer);
    await w.close();
  }

  async remove(path: string): Promise<void> {
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    if (!name) throw new Error('Caminho inválido');
    let dir: DirHandle = await this.root();
    for (const s of segs) dir = (await dir.getDirectoryHandle(s)) as DirHandle;
    await dir.removeEntry(name, { recursive: true });
  }
}
