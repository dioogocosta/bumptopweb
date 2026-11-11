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
    // Remove DE FATO do mapa (o world real remove; necessário p/ testar o
    // tombstone: depois de excluir, o syncDirectory não pode ver o objeto)
    removeObject: vi.fn((id: string) => {
      byId.delete(id);
    }),
    addBox: vi.fn(() => 'novo'),
    setObjectThumb: vi.fn(),
  } as unknown as World;
}

function makeFs(files: Record<string, Uint8Array>): IFileSystem {
  const fs = {
    mode: vi.fn(() => 'opfs'),
    requestDirectory: vi.fn(async () => true),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`sem arquivo: ${p}`);
      return files[p];
    }),
    list: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    write: vi.fn(async (p: string, data: Uint8Array) => {
      files[p] = data;
    }),
    remove: vi.fn(async (p: string) => {
      delete files[p];
    }),
  };
  return fs as unknown as IFileSystem & Record<string, ReturnType<typeof vi.fn>>;
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

describe('FileService.moveInto (arrastar arquivo para pasta)', () => {
  it('escreve na pasta, apaga o original e REMOVE o ícone da cena', async () => {
    const files = { '/foto.png': bytes('dados') };
    const world = makeWorld([
      objeto(),
      { id: 'dir1', label: 'Nova pasta', meta: { fsPath: '/Nova pasta', isDir: true } },
    ]);
    const fs = makeFs(files);
    const svc = new FileService(world, fs, makeRepo());

    const ok = await svc.moveInto('obj1', 'dir1');
    expect(ok).toBe(true);
    expect(fs.write).toHaveBeenCalledWith('/Nova pasta/foto.png', expect.anything());
    expect(fs.remove).toHaveBeenCalledWith('/foto.png');
    expect(world.removeObject).toHaveBeenCalledWith('obj1');
    expect(files['/Nova pasta/foto.png' as keyof typeof files]).toBeDefined();
    expect(files['/foto.png']).toBeUndefined();
  });

  it('usa o NOME do arquivo do caminho (não o label) no destino', async () => {
    const files = { '/doc.txt': bytes('x') };
    const world = makeWorld([
      { id: 'obj1', label: 'renomeado', meta: { fsPath: '/doc.txt', isDir: false } },
      { id: 'dir1', label: 'p', meta: { fsPath: '/p', isDir: true } },
    ]);
    const fs = makeFs(files);
    const svc = new FileService(world, fs, makeRepo());

    await svc.moveInto('obj1', 'dir1');
    expect(fs.write).toHaveBeenCalledWith('/p/doc.txt', expect.anything());
    expect(files['/p/doc.txt' as keyof typeof files]).toBeDefined();
  });

  it('upsertFsEntry falhando NÃO quebra o move: removeObject acontece e retorna true', async () => {
    const world = makeWorld([
      objeto(),
      { id: 'dir1', label: 'Nova pasta', meta: { fsPath: '/Nova pasta', isDir: true } },
    ]);
    const fs = makeFs({ '/foto.png': bytes('dados') });
    const repo = makeRepo();
    (repo.upsertFsEntry as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('P.export is not a function'));
    const svc = new FileService(world, fs, repo);

    const ok = await svc.moveInto('obj1', 'dir1');
    expect(ok).toBe(true);
    // O ícone sai da cena MESMO com o repo falhando (bug do fallback idb-sqlite)
    expect(world.removeObject).toHaveBeenCalledWith('obj1');
  });

  it('destino não é pasta / sem fsPath → false', async () => {
    const world = makeWorld([
      objeto(),
      { id: 'n1', label: 'nota', meta: {} },
    ]);
    const svc = new FileService(world, makeFs({}), makeRepo());
    expect(await svc.moveInto('obj1', 'n1')).toBe(false);
    expect(await svc.moveInto('obj1', 'obj1')).toBe(false);
  });
});

describe('FileService.deleteFsObject (excluir pasta/arquivo)', () => {
  it('apaga o diretório no OPFS, remove o ícone e o tombstone impede re-spawn', async () => {
    const world = makeWorld([objeto({ label: 'Nova pasta', meta: { isDir: true } })]);
    const fs = makeFs({});
    const svc = new FileService(world, fs, makeRepo());

    expect(await svc.deleteFsObject('obj1')).toBe(true);
    expect(world.removeObject).toHaveBeenCalledWith('obj1');
    expect(fs.remove).toHaveBeenCalledWith('/foto.png');
    // O objeto saiu da cena; mesmo com o caminho ainda no FS (corrida com o
    // watcher), o tombstone impede a recriação do ícone
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/foto.png', name: 'Nova pasta', isDir: true, size: 0, mtime: 0 },
    ]);
    const d = await svc.syncDirectory();
    expect(d.added).toBe(0);
  });

  it('tomba filhos: excluir a pasta protege os caminhos dentro dela', async () => {
    const world = makeWorld([
      objeto({ label: 'docs', meta: { fsPath: '/docs', isDir: true } }),
      { id: 'filho', label: 'a.txt', meta: { fsPath: '/docs/a.txt', isDir: false } },
    ]);
    const fs = makeFs({});
    const svc = new FileService(world, fs, makeRepo());

    await svc.deleteFsObject('obj1');
    expect(fs.remove).toHaveBeenCalledWith('/docs');
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/docs/a.txt', name: 'a.txt', isDir: false, size: 3, mtime: 0 },
    ]);
    const d = await svc.syncDirectory();
    expect(d.added).toBe(0); // filho tombado não renasce
  });

  it('modo fs-access: NÃO apaga o arquivo real do usuário (só tomba)', async () => {
    const world = makeWorld([objeto()]);
    const fs = makeFs({});
    (fs.mode as ReturnType<typeof vi.fn>).mockReturnValue('fs-access');
    const svc = new FileService(world, fs, makeRepo());

    await svc.deleteFsObject('obj1');
    expect(world.removeObject).toHaveBeenCalledWith('obj1');
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it('objeto demo (sem fsPath): só o ícone sai', async () => {
    const world = makeWorld([{ id: 'obj1', label: 'demo', meta: {} }]);
    const fs = makeFs({});
    const svc = new FileService(world, fs, makeRepo());

    await svc.deleteFsObject('obj1');
    expect(world.removeObject).toHaveBeenCalledWith('obj1');
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it('importDirectory limpa os tombstones (nova intenção do usuário)', async () => {
    const world = makeWorld([objeto()]);
    const fs = makeFs({ '/foto.png': bytes('dados') });
    const svc = new FileService(world, fs, makeRepo());

    await svc.deleteFsObject('obj1'); // tomba /foto.png
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/foto.png', name: 'foto.png', isDir: false, size: 4, mtime: 0 },
    ]);
    await svc.importDirectory();
    // Re-import explícito: o tombstone foi limpo e o ícone volta
    expect(world.addBox).toHaveBeenCalled();
  });
});

describe('FileService.importFiles (PR8 — arrastar arquivo do SO para a cena)', () => {
  it('escreve cada arquivo no FS atual e cria os ícones com fsPath', async () => {
    const files: Record<string, Uint8Array> = {};
    const world = makeWorld([]);
    const fs = makeFs(files);
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.importFiles(
      [new File([bytes('ola')], 'nota.txt'), new File([bytes('img')], 'foto.png')],
      { x: 10, y: 0, z: 5 },
    );
    expect(r.total).toBe(2);
    expect(r.files).toBe(2);
    expect(files['/nota.txt']).toBeDefined();
    expect(files['/foto.png']).toBeDefined();
    expect(world.addBox).toHaveBeenCalledTimes(2);
    // Ícones nascem a partir do ponto solto, lado a lado
    const calls = (world.addBox as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toMatchObject({ x: 10, z: 5 });
    expect(calls[1][0].x).toBeGreaterThan(10);
  });

  it('nome duplicado ganha sufixo " (2)" mantendo a extensão', async () => {
    const files: Record<string, Uint8Array> = {};
    const world = makeWorld([]);
    const fs = makeFs(files);
    // "a.txt" já existe no destino
    files['/a.txt'] = bytes('velho');
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/a.txt', name: 'a.txt', isDir: false, size: 5, mtime: 0 },
    ]);
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.importFiles([new File([bytes('novo')], 'a.txt')]);
    expect(r.files).toBe(1);
    expect(files['/a.txt']).toEqual(bytes('velho'));
    expect(files['/a (2).txt']).toEqual(bytes('novo'));
  });

  it('arquivo grande demais é ignorado (skipped) sem quebrar o lote', async () => {
    const files: Record<string, Uint8Array> = {};
    const world = makeWorld([]);
    const fs = makeFs(files);
    const svc = new FileService(world, fs, makeRepo());

    const enorme = new File([new Uint8Array(1)], 'grande.bin');
    Object.defineProperty(enorme, 'size', { value: 200 * 1024 * 1024 });
    const r = await svc.importFiles([enorme, new File([bytes('ok')], 'ok.txt')]);
    expect(r.files).toBe(1);
    expect(r.skipped).toBe(1);
    expect(files['/ok.txt']).toBeDefined();
  });
});

describe('FileService.downloadObject (PR8 — salvar no computador)', () => {
  let clicks: Array<{ download?: string; href?: string }>;
  beforeEach(() => {
    clicks = [];
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
  afterEach(() => vi.unstubAllGlobals());

  it('baixa o arquivo com o NOME REAL (do fsPath, não o label)', async () => {
    const svc = new FileService(
      makeWorld([{ id: 'obj1', label: 'renomeado', meta: { fsPath: '/doc.txt', isDir: false } }]),
      makeFs({ '/doc.txt': bytes('conteudo') }),
      makeRepo(),
    );
    const r = await svc.downloadObject('obj1');
    expect(r).toEqual({ kind: 'downloaded', name: 'doc.txt' });
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('doc.txt');
  });

  it('pasta e objeto sem fsPath → unsupported', async () => {
    const svc = new FileService(
      makeWorld([{ id: 'dir1', label: 'p', meta: { fsPath: '/p', isDir: true } }]),
      makeFs({}),
      makeRepo(),
    );
    expect((await svc.downloadObject('dir1')).kind).toBe('unsupported');
  });
});

describe('FileService.createFolder (item 6 — pasta virtual na cena)', () => {
  it('cria o diretório no FS + objeto pasta (isDir) na cena + persiste', async () => {
    const world = makeWorld([]);
    const fs = makeFs({});
    const repo = makeRepo();
    const svc = new FileService(world, fs, repo);

    const r = await svc.createFolder('Minha pasta', { x: 10, y: 0, z: 20 });
    expect(r).toEqual({ id: 'novo', name: 'Minha pasta' });
    expect(fs.mkdir).toHaveBeenCalledWith('/Minha pasta');
    expect(world.addBox).toHaveBeenCalledWith(
      { x: 10, y: 1.6 + 0.1, z: 20 },
      { x: 7, y: 1.6, z: 7 },
      expect.any(String),
      'Minha pasta',
      { fsPath: '/Minha pasta', isDir: true },
    );
    expect(repo.upsertFsEntry).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: 'novo', path: '/Minha pasta', isDir: true }),
    );
  });

  it('dedup: nome já existente ganha sufixo " (2)"', async () => {
    const world = makeWorld([]);
    const fs = makeFs({});
    (fs.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: '/Nova pasta', name: 'Nova pasta', isDir: true, size: 0, mtime: 0 },
    ]);
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.createFolder('Nova pasta');
    expect(r?.name).toBe('Nova pasta (2)');
    expect(fs.mkdir).toHaveBeenCalledWith('/Nova pasta (2)');
  });

  it('nome com "/" ou vazio → normalizado', async () => {
    const world = makeWorld([]);
    const fs = makeFs({});
    const svc = new FileService(world, fs, makeRepo());

    const r = await svc.createFolder('a/b/c');
    expect(r?.name).toBe('abc');
    const r2 = await svc.createFolder('   ');
    expect(r2?.name).toBe('Nova pasta');
  });

  it('falha do fs.mkdir → null', async () => {
    const fs = makeFs({});
    (fs.mkdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cheio'));
    const svc = new FileService(makeWorld([]), fs, makeRepo());
    expect(await svc.createFolder('x')).toBeNull();
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
