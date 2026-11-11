/**
 * Serviço de arquivos (M2) — liga o filesystem (porta IFileSystem) à cena.
 *
 *  - importDirectory(): lista a pasta, cria um "ícone" por arquivo, gera
 *    thumbnails de imagem e persiste em `fs_entries` (SQLite).
 *  - openFile(): abre o arquivo (blob em nova aba / download).
 *  - syncThumbs(): preenche thumbnails faltantes de objetos já na cena.
 *
 * Conhece o World (core) e os ports — sem tocar em three/SQL diretamente.
 */
import type { IFileSystem, IRepo } from '@core/ports/index';
import type { World } from '@core/world';
import { colorForFile, makeThumbnail } from '../fs/thumbnails';

/** Layout em grade simples p/ importação (fica no piso, em espiral). */
const GRID_COLS = 6;
const CELL = 20;
const ICON_HALF = { x: 7, y: 1.6, z: 7 }; // ícone deitado no chão (topo p/ cima)

export interface ImportResult {
  total: number;
  dirs: number;
  files: number;
  thumbs: number;
  /** Ignorados (ex.: arquivos grandes demais p/ o navegador ler em memória). */
  skipped?: number;
}

/** Resultado discriminado de `openObject` (item 3). */
export type OpenOutcome =
  | { kind: 'imported' }
  | { kind: 'downloaded'; name: string }
  | { kind: 'preview'; name: string; mime: string; url?: string; text?: string }
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** Extensão → MIME (mapa manual, sem dependências). Padrão: octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  // imagem
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // pdf
  pdf: 'application/pdf',
  // texto
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  xml: 'text/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  json: 'application/json',
  log: 'text/plain',
  ini: 'text/plain',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  // outros (vão para download)
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  exe: 'application/octet-stream',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

/** MIME de um arquivo pelo nome/extensão (lowercase, sem query). */
export function mimeFromName(name: string): string {
  const clean = name.split('?')[0].split('#')[0];
  const ext = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export class FileService {
  private world: World;
  private fs: IFileSystem;
  private repo: IRepo;
  /** Caminho da última pasta aberta (persistido). */
  private currentPath = '/';

  /**
   * Caminhos "tombados": excluídos pelo usuário nesta sessão. O watcher NÃO
   * recria o ícone deles (sem isso, excluir pasta/arquivo ressuscita o ícone
   * 5 s depois — o listing do FS ainda contém o caminho).
   */
  private tombs = new Set<string>();

  constructor(world: World, fs: IFileSystem, repo: IRepo) {
    this.world = world;
    this.fs = fs;
    this.repo = repo;
  }

  mode(): string {
    return this.fs.mode();
  }

  /** Pede um diretório ao usuário; false se indisponível/cancelado. */
  async requestDirectory(): Promise<boolean> {
    return this.fs.requestDirectory();
  }

  /**
   * Importa o diretório atual para a cena (substitui os ícones de FS antigos).
   */
  async importDirectory(path = this.currentPath): Promise<ImportResult> {
    this.currentPath = path;
    const entries = await this.fs.list(path);
    const result: ImportResult = { total: entries.length, dirs: 0, files: 0, thumbs: 0 };
    if (entries.length === 0) return result;

    // Import explícito = nova intenção: limpa tombstones (o que o usuário
    // excluiu nesta sessão volta a aparecer se ainda existir no FS)
    this.tombs.clear();

    // Remove ícones de FS antigos (mantém a cena demo/objetos soltos)
    for (const o of this.world.listObjects()) {
      if (o.meta.fsPath !== undefined) this.world.removeObject(o.id);
    }

    // Layout em grade (M2 simplificado; pilhas reais vêm no M3)
    entries.forEach((entry, i) => {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const x = (col - (GRID_COLS - 1) / 2) * CELL;
      const z = (row - 1.5) * CELL;
      const id = this.world.addBox(
        { x, y: ICON_HALF.y + 0.1, z },
        ICON_HALF,
        colorForFile(entry.name),
        entry.name,
        { fsPath: entry.path, isDir: entry.isDir },
      );
      if (entry.isDir) result.dirs++;
      else result.files++;

      // Persiste metadados de FS (assíncrono, fora do caminho crítico)
      this.repo
        .upsertFsEntry({
          objectId: id,
          mode: this.fs.mode() === 'fs-access' ? 1 : this.fs.mode() === 'opfs' ? 2 : 0,
          path: entry.path,
          name: entry.name,
          isDir: entry.isDir,
          size: entry.size,
          mtime: entry.mtime,
        })
        .catch(() => {});
    });

    // Thumbnails/ícones para TODOS os arquivos (imagens = bitmap, resto = SVG)
    const fileEntries = entries.filter((e) => !e.isDir);
    const idsByPath = new Map<string, string>();
    for (const o of this.world.listObjects()) {
      if (typeof o.meta.fsPath === 'string') idsByPath.set(o.meta.fsPath, o.id);
    }
    const CONCURRENCY = 4;
    for (let i = 0; i < fileEntries.length; i += CONCURRENCY) {
      const batch = fileEntries.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const bytes = await this.fs.read(entry.path);
            const file = new File([bytes as BlobPart], entry.name);
            const thumb = await makeThumbnail(file); // sempre retorna string (bitmap ou SVG)
            const objId = idsByPath.get(entry.path);
            if (objId) {
              this.world.setObjectThumb(objId, thumb);
              await this.repo.upsertFsEntry({
                objectId: objId,
                mode: this.fs.mode() === 'fs-access' ? 1 : 2,
                path: entry.path,
                name: entry.name,
                isDir: false,
                size: entry.size,
                mtime: entry.mtime,
                thumb,
              });
              result.thumbs++;
            }
          } catch {
            /* sem permissão/ler falhou — segue */
          }
        }),
      );
    }

    return result;
  }

  /**
   * Abre um arquivo da cena (item 3):
   *  - imagem/PDF/texto → modal de pré-visualização in-app (`preview`)
   *  - demais tipos → download via `<a download>` (`downloaded`)
   *  - diretórios importam (`imported`); sem fsPath → `unsupported`.
   */
  async openObject(objectId: string): Promise<OpenOutcome> {
    const o = this.world.getObject(objectId);
    if (!o) return { kind: 'error' };
    const fsPath = o.meta.fsPath as string | undefined;
    if (fsPath === undefined) return { kind: 'unsupported' };
    const name = o.label ?? fsPath.split('/').pop() ?? 'arquivo';

    if (o.meta.isDir) {
      await this.importDirectory(fsPath);
      return { kind: 'imported' };
    }

    try {
      const bytes = await this.fs.read(fsPath);
      const mime = mimeFromName(name);

      // Pré-visualização in-app: imagem, PDF (blob url) e texto/json (decodificado)
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        const blob = new Blob([bytes as BlobPart], { type: mime });
        return { kind: 'preview', name, mime, url: URL.createObjectURL(blob) };
      }
      if (mime.startsWith('text/') || mime === 'application/json') {
        const text = new TextDecoder().decode(bytes);
        return { kind: 'preview', name, mime, text };
      }

      // Qualquer outro tipo → download (sem pop-up, funciona em todos os browsers)
      const blob = new Blob([bytes as BlobPart], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { kind: 'downloaded', name };
    } catch {
      return { kind: 'error' };
    }
  }

  /**
   * Importa arquivos ARRASTADOS DO SO para a cena (PR8): escreve cada um no
   * filesystem atual (OPFS/virtual ou a pasta real em fs-access), cria os
   * ícones lado a lado a partir do ponto solto (`at`) e gera thumbnails.
   * Nomes duplicados ganham sufixo " (2)", " (3)"...
   */
  async importFiles(
    files: File[],
    at?: { x: number; y: number; z: number },
  ): Promise<ImportResult> {
    const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — navegador lê em memória
    const dir = this.currentPath === '/' ? '' : this.currentPath;
    const result: ImportResult = { total: files.length, dirs: 0, files: 0, thumbs: 0, skipped: 0 };
    if (files.length === 0) return result;

    // Nomes já usados no destino (p/ dedup, inclusive dentro do próprio lote)
    const listing = await this.fs.list(this.currentPath);
    const usados = new Set(listing.map((e) => e.name));

    let i = 0;
    for (const file of files) {
      // Nome real do arquivo (sem qualquer caminho que venha no File.name)
      const base = file.name.split(/[\\/]/).pop() || 'arquivo';
      if (file.size > MAX_BYTES) {
        result.skipped = (result.skipped ?? 0) + 1;
        continue;
      }
      let nome = base;
      for (let n = 2; usados.has(nome); n++) nome = base.replace(/(\.[^.]*)?$/, ` (${n})$1`);
      usados.add(nome);
      const path = `${dir}/${nome}`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.fs.write(path, bytes);
        this.spawnIcon(
          { path, name: nome, isDir: false, size: file.size, mtime: file.lastModified || Date.now() },
          i++,
          at,
        );
        result.files++;
      } catch {
        result.skipped = (result.skipped ?? 0) + 1;
      }
    }
    return result;
  }

  /**
   * Baixa uma cópia do arquivo para o computador (menu "Salvar no
   * computador" — PR8). No navegador não há API para abrir o Explorer num
   * caminho específico; a cópia cai na pasta Downloads do sistema.
   */
  async downloadObject(objectId: string): Promise<OpenOutcome> {
    const o = this.world.getObject(objectId);
    const fsPath = o?.meta.fsPath as string | undefined;
    if (!o || fsPath === undefined || o.meta.isDir) return { kind: 'unsupported' };
    const name = (fsPath.split('/').pop() || 'arquivo').trim();
    try {
      const bytes = await this.fs.read(fsPath);
      const blob = new Blob([bytes as BlobPart], { type: mimeFromName(name) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { kind: 'downloaded', name };
    } catch {
      return { kind: 'error' };
    }
  }

  /** Persiste o caminho atual nas settings. */
  async savePath(): Promise<void> {
    await this.repo.setSetting('fsPath', this.currentPath);
  }

  async restorePath(): Promise<string> {
    this.currentPath = await this.repo.getSetting('fsPath', '/');
    return this.currentPath;
  }

  /**
   * Move um arquivo para uma pasta (arrastar-e-soltar sobre o ícone de pasta).
   * Lê o original, escreve no destino e remove o original. O ícone sai da cena
   * (o arquivo agora vive dentro da pasta — como no original).
   */
  async moveInto(srcId: string, dirId: string): Promise<boolean> {
    if (srcId === dirId) return false;
    const src = this.world.getObject(srcId);
    const dir = this.world.getObject(dirId);
    if (!src || !dir) return false;
    if (dir.meta.isDir !== true) return false;
    const srcPath = src.meta.fsPath as string | undefined;
    const dirPath = dir.meta.fsPath as string | undefined;
    if (srcPath === undefined || dirPath === undefined) return false;

    try {
      const data = await this.fs.read(srcPath);
      const base = dirPath === '/' ? '' : dirPath;
      // Nome REAL do arquivo (do caminho), não o label — o label pode ter sido
      // renomeado/sem extensão e o arquivo precisaria do nome correto na pasta.
      const nome = srcPath.split('/').pop() || src.label || 'arquivo';
      const newPath = `${base}/${nome}`;
      await this.fs.write(newPath, data);
      await this.fs.remove(srcPath);
      // O ícone SAI da cena AGORA: o arquivo fisicamente já mudou de lugar, e
      // o upsertFsEntry (worker SQLite) pode falhar/rejeitar sem estragar a UX
      // (antes: await upsertFsEntry rejeitando → catch → false → toast de erro
      // mesmo com o move OK; e o ícone antigo continuava na cena).
      this.world.removeObject(srcId);
      const thumb = src.meta.thumb as string | undefined;
      // Best-effort: reflete o novo caminho no repo; se falhar, o sync do
      // watcher corrige depois.
      this.repo
        .upsertFsEntry({
          objectId: srcId,
          mode: this.fs.mode() === 'fs-access' ? 1 : 2,
          path: newPath,
          name: nome,
          isDir: false,
          size: data.byteLength,
          mtime: Date.now(),
          thumb,
        })
        .catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pasta virtual na cena (item 6): cria o diretório no FS e o ícone na cena.
   * Dedup do nome com sufixo " (2)", " (3)"... se já existir. `at` = ponto do
   * piso onde soltar o ícone (default: centro). Retorna null se falhar.
   */
  async createFolder(
    name: string,
    at?: { x: number; y: number; z: number },
  ): Promise<{ id: string; name: string } | null> {
    try {
      // Normaliza: trim, sem '/' e sem vazio
      let base = name.trim().replace(/\//g, '') || 'Nova pasta';
      // Dedup: "Nova pasta (2)" se "Nova pasta" já existe na raiz
      const raiz = await this.fs.list('/');
      const nomes = new Set(raiz.map((e) => e.name));
      let final = base;
      for (let n = 2; nomes.has(final); n++) final = `${base} (${n})`;
      const path = `/${final}`;
      await this.fs.mkdir(path);
      const pos = at ?? { x: 0, y: ICON_HALF.y + 0.1, z: 0 };
      const id = this.world.addBox(
        { x: pos.x, y: ICON_HALF.y + 0.1, z: pos.z },
        ICON_HALF,
        colorForFile(final),
        final,
        { fsPath: path, isDir: true },
      );
      await this.repo.upsertFsEntry({
        objectId: id,
        mode: this.fs.mode() === 'fs-access' ? 1 : this.fs.mode() === 'opfs' ? 2 : 0,
        path,
        name: final,
        isDir: true,
        size: 0,
        mtime: Date.now(),
      });
      return { id, name: final };
    } catch {
      return null;
    }
  }

  /**
   * Exclui um objeto de FS da cena (pasta ou arquivo):
   *  1. remove o ícone;
   *  2. tomba o caminho (e filhos `path/...`) p/ o watcher não recriar;
   *  3. em modo SANDBOX (opfs/virtual) apaga o arquivo/diretório de verdade
   *     (`remove` já é recursivo p/ pastas); em fs-access NÃO toca no disco
   *     real do usuário — só o ícone sai (o tombstone evita o re-spawn).
   */
  async deleteFsObject(id: string): Promise<boolean> {
    const o = this.world.getObject(id);
    const path = o?.meta.fsPath as string | undefined;
    this.world.removeObject(id);
    if (path === undefined) return true;
    // Tumba o caminho e tudo que está dentro dele (ícones de filhos na cena)
    this.tombs.add(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const other of this.world.listObjects()) {
      const p = other.meta.fsPath as string | undefined;
      if (typeof p === 'string' && p.startsWith(prefix)) this.tombs.add(p);
    }
    if (this.fs.mode() !== 'fs-access') {
      try {
        await this.fs.remove(path);
      } catch {
        // Melhor esforço: o ícone já saiu e o tombstone evita re-spawn
      }
    }
    return true;
  }

  /**
   * Watcher leve (polling + diff): detecta arquivos novos/removidos na pasta
   * atual e sincroniza os ícones. Chamado periodicamente e ao voltar à aba.
   */
  async syncDirectory(): Promise<{ added: number; removed: number }> {
    const entries = await this.fs.list(this.currentPath);
    const seen = new Set(entries.map((e) => e.path));
    const existing = new Map<string, string>();
    for (const o of this.world.listObjects()) {
      if (typeof o.meta.fsPath === 'string') existing.set(o.meta.fsPath, o.id);
    }

    let added = 0;
    let removed = 0;

    // Novos → cria ícone (exceto os tombados pelo usuário nesta sessão)
    entries.forEach((entry, i) => {
      if (existing.has(entry.path)) return;
      if (this.tombs.has(entry.path)) return;
      this.spawnIcon(entry, i);
      added++;
    });

    // Removidos fora da cena → remove ícone
    for (const [path, id] of existing) {
      if (!seen.has(path)) {
        this.world.removeObject(id);
        removed++;
      }
    }
    return { added, removed };
  }

  /** Cria o ícone de um item da pasta (usado por import e sync). */
  private spawnIcon(
    entry: { path: string; name: string; isDir: boolean; size: number; mtime: number },
    index: number,
    at?: { x: number; y: number; z: number },
  ): string {
    const col = index % GRID_COLS;
    const row = Math.floor(index / GRID_COLS);
    // Com `at` (arraste do SO): lado a lado a partir do ponto solto na cena
    const pos = at
      ? { x: at.x + index * (CELL * 0.55), y: ICON_HALF.y + 0.1, z: at.z }
      : {
          x: (col - (GRID_COLS - 1) / 2) * CELL,
          y: ICON_HALF.y + 0.1,
          z: (row - 1.5) * CELL,
        };
    const id = this.world.addBox(
      { x: pos.x, y: ICON_HALF.y + 0.1, z: pos.z },
      ICON_HALF,
      colorForFile(entry.name),
      entry.name,
      { fsPath: entry.path, isDir: entry.isDir },
    );
    // Gera thumbnail/ícone assíncrono para o novo item
    if (!entry.isDir) {
      this.fs.read(entry.path)
        .then((bytes) => new File([bytes as BlobPart], entry.name))
        .then((file) => makeThumbnail(file))
        .then((thumb) => {
          this.world.setObjectThumb(id, thumb);
          this.repo.upsertFsEntry({
            objectId: id,
            mode: this.fs.mode() === 'fs-access' ? 1 : 2,
            path: entry.path,
            name: entry.name,
            isDir: false,
            size: entry.size,
            mtime: entry.mtime,
            thumb,
          }).catch(() => {});
        })
        .catch(() => {});
    }
    return id;
  }
}
