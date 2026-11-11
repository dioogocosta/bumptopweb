/**
 * Testes do FileService (item 3 do dono — abrir arquivos):
 *  - imagem/PDF → preview com blob URL
 *  - texto/JSON → preview com texto decodificado
 *  - ZIP (e demais) → download via <a download>
 *  - sem fsPath → unsupported; diretório → imported
 *  - mimeFromName (mapa ext→mime)
 *
 * Ambiente é node (sem jsdom): `document`/`URL.createObjectURL` stubados.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem, IRepo } from '@core/ports/index';
import type { World } from '@core/world';
import { FileService, mimeFromName } from '@app/fileService';

/** Objeto da cena com/sem fsPath. */
function objeto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'obj1',
    label: 'foto.png',
    meta: { fsPath: '/foto.png', ...((overrides.meta as object) ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'meta')),
  };
}

function makeWorld(objs: Record<string, unknown>[]): World {
  const byId = new Map(objs.map((o) => [(o as { id: string }).id, o]));
  return {
    getObject: vi.fn((id: string) => byId.get(id) ?? null),
    listObjects: vi.fn(() => [...byId.values()]),
    removeObject: vi.fn(),
    addBox: vi.fn(() => 'novo'),
    setObjectThumb: vi.fn(),
  } as unknown as World;
}

function makeFs(files: Record<string, Uint8Array>): IFileSystem {
  return {
    mode: vi.fn(() => 'opfs'),
    requestDirectory: vi.fn(async () => true),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`sem arquivo: ${p}`);
      return files[p];
    }),
    list: vi.fn(async () => []),
  } as unknown as IFileSystem;
}

function makeRepo(): IRepo {
  return {
    upsertFsEntry: vi.fn(async () => {}),
    getSetting: vi.fn(async (_k: string, d: unknown) => d),
    setSetting: vi.fn(async () => {}),
    deleteObject: vi.fn(async () => {}),
  } as unknown as IRepo;
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('FileService.openObject (item 3)', () => {
  let clicks: Array<{ download?: string; href?: string }>;

  beforeEach(() => {
    clicks = [];
    // node não tem document: stub mínimo p/ criar o <a> do download
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        const a: { click: () => void; href?: string; download?: string } = {
          click: () => clicks.push(a),
        };
        return a;
      }),
    });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('imagem → preview com blob URL e MIME correto', async () => {
    const world = makeWorld([objeto({ label: 'foto.png' })]);
    const fs = makeFs({ '/foto.png': bytes('PNG') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r).toEqual({ kind: 'preview', name: 'foto.png', mime: 'image/png', url: 'blob:mock-url' });
    expect(clicks).toHaveLength(0); // não baixa, não abre aba
  });

  it('PDF → preview com blob URL', async () => {
    const world = makeWorld([objeto({ label: 'doc.pdf', meta: { fsPath: '/doc.pdf' } })]);
    const fs = makeFs({ '/doc.pdf': bytes('%PDF') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r.kind).toBe('preview');
    if (r.kind === 'preview') {
      expect(r.mime).toBe('application/pdf');
      expect(r.url).toBe('blob:mock-url');
    }
  });

  it('texto → preview com conteúdo decodificado (sem URL)', async () => {
    const world = makeWorld([objeto({ label: 'nota.txt', meta: { fsPath: '/nota.txt' } })]);
    const fs = makeFs({ '/nota.txt': bytes('olá mundo') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r).toEqual({ kind: 'preview', name: 'nota.txt', mime: 'text/plain', text: 'olá mundo' });
  });

  it('JSON → preview com texto decodificado', async () => {
    const world = makeWorld([objeto({ label: 'dados.json', meta: { fsPath: '/dados.json' } })]);
    const fs = makeFs({ '/dados.json': bytes('{"a":1}') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r.kind).toBe('preview');
    if (r.kind === 'preview') expect(r.text).toBe('{"a":1}');
  });

  it('ZIP → download via <a download> (não preview, não window.open)', async () => {
    vi.useFakeTimers();
    const world = makeWorld([objeto({ label: 'pacote.zip', meta: { fsPath: '/pacote.zip' } })]);
    const fs = makeFs({ '/pacote.zip': bytes('PK') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r).toEqual({ kind: 'downloaded', name: 'pacote.zip' });
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('pacote.zip');
    expect(clicks[0].href).toBe('blob:mock-url');
    vi.runAllTimers(); // revoga a url
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('extensão desconhecida → download (octet-stream)', async () => {
    const world = makeWorld([objeto({ label: 'bin.xyz', meta: { fsPath: '/bin.xyz' } })]);
    const fs = makeFs({ '/bin.xyz': bytes('\x00') });
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r.kind).toBe('downloaded');
    expect(clicks).toHaveLength(1);
  });

  it('objeto sem fsPath → unsupported', async () => {
    const world = makeWorld([{ id: 'obj1', label: 'sem-arquivo', meta: {} }]);
    const svc = new FileService(world, makeFs({}), makeRepo());
    expect(await svc.openObject('obj1')).toEqual({ kind: 'unsupported' });
  });

  it('objeto inexistente → error', async () => {
    const svc = new FileService(makeWorld([]), makeFs({}), makeRepo());
    expect(await svc.openObject('nao-existe')).toEqual({ kind: 'error' });
  });

  it('diretório → imported (importa o FS)', async () => {
    const world = makeWorld([objeto({ label: 'docs', meta: { fsPath: '/docs', isDir: true } })]);
    const fs = makeFs({});
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/docs/a.txt', name: 'a.txt', isDir: false, size: 3, mtime: 0 },
    ]);
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.openObject('obj1');
    expect(r).toEqual({ kind: 'imported' });
    expect(fs.list).toHaveBeenCalledWith('/docs');
    expect(world.addBox).toHaveBeenCalled();
  });

  it('falha de leitura → error', async () => {
    const world = makeWorld([objeto()]);
    const svc = new FileService(world, makeFs({}), makeRepo()); // read lança
    expect(await svc.openObject('obj1')).toEqual({ kind: 'error' });
  });
});

describe('mimeFromName', () => {
  it('mapeia extensões comuns (case-insensitive)', () => {
    expect(mimeFromName('a.PNG')).toBe('image/png');
    expect(mimeFromName('a.jpeg')).toBe('image/jpeg');
    expect(mimeFromName('a.svg')).toBe('image/svg+xml');
    expect(mimeFromName('a.pdf')).toBe('application/pdf');
    expect(mimeFromName('a.txt')).toBe('text/plain');
    expect(mimeFromName('a.md')).toBe('text/markdown');
    expect(mimeFromName('a.json')).toBe('application/json');
    expect(mimeFromName('a.html')).toBe('text/html');
  });

  it('desconhecida ou sem extensão → octet-stream', () => {
    expect(mimeFromName('a.xyz')).toBe('application/octet-stream');
    expect(mimeFromName('semextensao')).toBe('application/octet-stream');
    expect(mimeFromName('zip')).toBe('application/octet-stream');
  });

  it('ignora query/hash e usa a ÚLTIMA extensão', () => {
    expect(mimeFromName('a.png?raw=1')).toBe('image/png');
    expect(mimeFromName('a.tar.gz')).toBe('application/gzip');
    expect(mimeFromName('a.tar#x')).toBe('application/x-tar');
  });
});
