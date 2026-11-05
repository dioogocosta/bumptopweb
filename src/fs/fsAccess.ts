/**
 * Adapter de filesystem — File System Access API (Modo A, Chromium).
 *
 * Abre uma pasta REAL do usuário (`showDirectoryPicker`) e lê/escreve nela.
 * Feature-detect: se indisponível, o chamador cai para o Modo B (OPFS/virtual).
 *
 * ⚠️ Permissão: `queryPermission`/`requestPermission` com modo 'readwrite'
 * precisam de gesto do usuário em alguns navegadores.
 */
import type { FsEntry, IFileSystem } from '@core/ports/index';

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

/** Converte um FileSystemHandle em caminho lógico ('/' separado). */
function pathOf(segments: string[]): string {
  return '/' + segments.join('/');
}

export class FsAccessFileSystem implements IFileSystem {
  private root: DirHandle | null = null;
  private fallback: IFileSystem | null = null;

  /** `fallback` é usado quando a API não existe ou o usuário cancela. */
  constructor(fallback: IFileSystem) {
    this.fallback = fallback;
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  async requestDirectory(): Promise<boolean> {
    if (!FsAccessFileSystem.isSupported()) return false;
    try {
      const picker = (window as unknown as {
        showDirectoryPicker(opts?: unknown): Promise<DirHandle>;
      }).showDirectoryPicker;
      this.root = await picker({ mode: 'readwrite' });
      return true;
    } catch {
      // Usuário cancelou ou permissão negada
      return false;
    }
  }

  mode(): 'fs-access' | 'opfs' | 'virtual' {
    return this.root ? 'fs-access' : (this.fallback?.mode() ?? 'virtual');
  }

  private requireRoot(): DirHandle {
    if (!this.root) throw new Error('Nenhum diretório aberto (Modo A indisponível).');
    return this.root;
  }

  /** Resolve um caminho '/' → handle, descendo por segmentos. */
  private async resolve(path: string, forWrite = false): Promise<FileSystemHandle | null> {
    const root = this.requireRoot();
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) return root;
    let dir: DirHandle = root;
    for (let i = 0; i < segs.length - 1; i++) {
      dir = (await dir.getDirectoryHandle(segs[i])) as DirHandle;
    }
    const last = segs[segs.length - 1];
    try {
      if (forWrite) {
        // Tentamos arquivo; se falhar, é diretório
        return await dir.getFileHandle(last);
      }
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
    if (!this.root) return this.fallback!.list(path);
    let dir: DirHandle;
    try {
      const resolved = await this.resolve(path);
      dir = (resolved ?? this.root) as DirHandle;
    } catch {
      return this.fallback!.list(path);
    }
    const out: FsEntry[] = [];
    // @types: entries() é async iterator
    for await (const [name, handle] of (
      dir as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (name.startsWith('.')) continue; // ignora arquivos ocultos/internos (.opfs-sahpool, .DS_Store)
      const isDir = handle.kind === 'directory';
      let size = 0;
      let mtime = 0;
      if (!isDir) {
        try {
          const f = await (handle as FileHandle).getFile();
          size = f.size;
          mtime = f.lastModified;
        } catch {
          /* sem permissão de leitura — mantém 0 */
        }
      }
      out.push({ path: pathOf([...path.split('/').filter(Boolean), name]), name, isDir, size, mtime });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    if (!this.root) return this.fallback!.read(path);
    const h = await this.resolve(path);
    if (!h || h.kind !== 'file') throw new Error(`Arquivo não encontrado: ${path}`);
    const file = await (h as FileHandle).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (!this.root) return this.fallback!.write(path, data);
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    if (!name) throw new Error('Caminho inválido');
    let dir: DirHandle = this.root;
    for (const s of segs) dir = (await dir.getDirectoryHandle(s, { create: true })) as DirHandle;
    const fh = (await dir.getFileHandle(name, { create: true })) as FileHandle;
    const w = await fh.createWritable();
    // Cópia com buffer ArrayBuffer p/ tipagem de FileSystemWriteChunkType
    await w.write(data.slice().buffer);
    await w.close();
  }

  async remove(path: string): Promise<void> {
    if (!this.root) return this.fallback!.remove(path);
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    if (!name) throw new Error('Caminho inválido');
    let dir: DirHandle = this.root;
    for (const s of segs) dir = (await dir.getDirectoryHandle(s)) as DirHandle;
    await dir.removeEntry(name, { recursive: true });
  }
}
