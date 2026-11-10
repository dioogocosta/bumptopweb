/**
 * Worker de persistência — SQLite (WASM) rodando fora da thread principal.
 *
 * Dois backends, escolhidos em tempo de execução:
 *  1. `opfs-sqlite`  — SQLite real persistido em OPFS (via OpfsSAHPoolVfs).
 *                     Requer contexto de Worker (por isso existe este arquivo).
 *  2. `idb-sqlite`   — SQLite em memória; o DB é exportado (Uint8Array) e
 *                     persistido no IndexedDB. Fallback p/ Firefox/iOS antigo.
 *
 * O schema deriva do `.proto` original (ver schema.ts).
 */
import * as sqlite3init from '@sqlite.org/sqlite-wasm';
import { openDB, type IDBPDatabase } from 'idb';
import { MIGRATIONS, LATEST_VERSION } from './schema';
import type { RpcRequest, RpcResponse } from './rpc';
import type { SceneSnapshot } from '@core/model/types';

// Tipos leves p/ API oo1 do sqlite-wasm
interface SqliteStmt {
  bind(params: unknown[]): void;
  step(): boolean;
  get(i: number): unknown;
  reset(alsoClearBinds?: boolean): void;
  finalize(): void;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
  export(): Uint8Array;
}
interface SqliteModule {
  oo1: { DB: new (name?: string, flags?: string, vfs?: string) => SqliteDb };
  installOpfsSAHPoolVfs(opts?: unknown): Promise<unknown>;
  OpfsSAHPoolDb?: new (name?: string) => SqliteDb;
}

let sqlite3: SqliteModule;
let db: SqliteDb;
let backend = 'unknown';
let idb: IDBPDatabase | null = null;
const IDB_NAME = 'bumptop-sqlite';
const IDB_STORE = 'db';
const IDB_KEY = 'main';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// helpers de query
// ---------------------------------------------------------------------------

function prepareRun(sql: string, params: unknown[] = []): void {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    stmt.step();
  } finally {
    stmt.reset();
    stmt.finalize();
  }
}

// ---------------------------------------------------------------------------
// migrações
// ---------------------------------------------------------------------------

function applyMigrations(): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  let current = 0;
  {
    const stmt = db.prepare('SELECT MAX(version) FROM _migrations');
    if (stmt.step()) current = (stmt.get(0) as number) ?? 0;
    stmt.reset();
    stmt.finalize();
  }
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec(m.sql);
      prepareRun('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        Date.now(),
      ]);
      current = m.version;
    }
  }
}

// ---------------------------------------------------------------------------
// backend de persistência (p/ fallback memória)
// ---------------------------------------------------------------------------

async function persistMemToIdb(): Promise<void> {
  if (backend !== 'idb-sqlite') return;
  if (!idb)
    idb = await openDB(IDB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore(IDB_STORE);
      },
    });
  const blob = db.export();
  await idb.put(IDB_STORE, blob, IDB_KEY);
}

async function loadMemFromIdb(): Promise<void> {
  if (!idb)
    idb = await openDB(IDB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore(IDB_STORE);
      },
    });
  const blob = (await idb.get(IDB_STORE, IDB_KEY)) as Uint8Array | undefined;
  if (blob) {
    db = new sqlite3.oo1.DB();
    // Restaura bytes do IndexedDB p/ o DB em memória
    (db as unknown as { deserialize(d: Uint8Array): void }).deserialize(blob);
  }
}

// ---------------------------------------------------------------------------
// inicialização
// ---------------------------------------------------------------------------

async function initDb(): Promise<string> {
  sqlite3 = (await (sqlite3init as unknown as { default: (o?: unknown) => Promise<SqliteModule> }).default()) as SqliteModule;
  try {
    await sqlite3.installOpfsSAHPoolVfs();
    // 3º parâmetro = VFS: sem ele o DB cai no VFS default (memória) e nada
    // persiste entre recargas (confirmado em produção: Netlify perdia settings e cena)
    db = new sqlite3.oo1.DB('/bumptop.db', 'c', 'opfs-sahpool');
    backend = 'opfs-sqlite';
  } catch {
    // Fallback: memória + IndexedDB
    await loadMemFromIdb();
    if (!db) db = new sqlite3.oo1.DB();
    backend = 'idb-sqlite';
  }
  applyMigrations();
  return backend;
}

// ---------------------------------------------------------------------------
// handlers de método
// ---------------------------------------------------------------------------

async function handle(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case 'init':
      return initDb();

    case 'backend':
      return backend;

    case 'saveScene': {
      const { snapshot } = params[0] as { snapshot: SceneSnapshot };
      // Upsert da cena (singleton) — transaction garante atomicidade
      db.exec('BEGIN');
      try {
        prepareRun('DELETE FROM objects');
        prepareRun('DELETE FROM piles');
        prepareRun('DELETE FROM pile_children');
        for (const o of snapshot.objects) {
          prepareRun(
            `INSERT INTO objects (id, kind, type_flags, parent_id, px,py,pz, qx,qy,qz,qw, vx,vy,vz, scale, pinned_wall, frozen, label, meta_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              o.id, o.kind, o.typeFlags, o.parentId,
              o.pose.position.x, o.pose.position.y, o.pose.position.z,
              o.pose.rotation.x, o.pose.rotation.y, o.pose.rotation.z, o.pose.rotation.w,
              o.velocity.x, o.velocity.y, o.velocity.z,
              o.scale, o.pinnedWall, o.frozen ? 1 : 0, o.label,
              JSON.stringify(o.meta ?? {}),
            ],
          );
        }
        for (const [pileId, p] of Object.entries(snapshot.piles ?? {})) {
          prepareRun('INSERT OR REPLACE INTO piles (object_id, layout, pile_type, page) VALUES (?,?,?,?)', [
            pileId, p.layout, 0, p.page,
          ]);
        }
        prepareRun(
          `INSERT INTO scene (id, schema_ver, camera_json, updated_at) VALUES (1,?,?,?)
           ON CONFLICT(id) DO UPDATE SET camera_json=excluded.camera_json, updated_at=excluded.updated_at, schema_ver=excluded.schema_ver`,
          [snapshot.schemaVersion, JSON.stringify(snapshot.camera), Date.now()],
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      if (backend === 'idb-sqlite') await persistMemToIdb();
      return true;
    }

    case 'loadScene': {
      const stmt = db.prepare('SELECT schema_ver, camera_json FROM scene WHERE id = 1');
      if (!stmt.step()) {
        stmt.reset();
        stmt.finalize();
        return null;
      }
      const schemaVer = stmt.get(0) as number;
      const cameraJson = stmt.get(1) as string;
      stmt.reset();
      stmt.finalize();

      // Carrega objetos
      const objects = loadObjects();
      const piles = loadPiles();
      const snapshot: SceneSnapshot = {
        schemaVersion: schemaVer,
        objects,
        camera: JSON.parse(cameraJson),
        piles,
      };
      return snapshot;
    }

    case 'upsertObject': {
      const { data } = params[0] as { data: import('@core/model/types').BumpObjectData };
      prepareRun(
        `INSERT INTO objects (id, kind, type_flags, parent_id, px,py,pz, qx,qy,qz,qw, vx,vy,vz, scale, pinned_wall, frozen, label, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, type_flags=excluded.type_flags, parent_id=excluded.parent_id,
           px=excluded.px, py=excluded.py, pz=excluded.pz,
           qx=excluded.qx, qy=excluded.qy, qz=excluded.qz, qw=excluded.qw,
           vx=excluded.vx, vy=excluded.vy, vz=excluded.vz,
           scale=excluded.scale, pinned_wall=excluded.pinned_wall, frozen=excluded.frozen,
           label=excluded.label, meta_json=excluded.meta_json`,
        [
          data.id, data.kind, data.typeFlags, data.parentId,
          data.pose.position.x, data.pose.position.y, data.pose.position.z,
          data.pose.rotation.x, data.pose.rotation.y, data.pose.rotation.z, data.pose.rotation.w,
          data.velocity.x, data.velocity.y, data.velocity.z,
          data.scale, data.pinnedWall, data.frozen ? 1 : 0, data.label,
          JSON.stringify(data.meta ?? {}),
        ],
      );
      if (backend === 'idb-sqlite') await persistMemToIdb();
      return true;
    }

    case 'deleteObject': {
      const [id] = params as [string];
      prepareRun('DELETE FROM objects WHERE id = ?', [id]);
      if (backend === 'idb-sqlite') await persistMemToIdb();
      return true;
    }

    case 'getSetting': {
      const [key, fallback] = params as [string, unknown];
      const stmt = db.prepare('SELECT value_json FROM settings WHERE key = ?');
      stmt.bind([key]);
      if (stmt.step()) {
        const v = stmt.get(0) as string;
        stmt.reset();
        stmt.finalize();
        return JSON.parse(v);
      }
      stmt.reset();
      stmt.finalize();
      return fallback;
    }

    case 'setSetting': {
      const [key, value] = params as [string, unknown];
      prepareRun(
        'INSERT INTO settings (key, value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
        [key, JSON.stringify(value)],
      );
      if (backend === 'idb-sqlite') await persistMemToIdb();
      return true;
    }

    case 'upsertFsEntry': {
      const e = params[0] as import('@core/ports/index').FsEntryRow;
      prepareRun(
        `INSERT INTO fs_entries (object_id, mode, path, name, is_dir, size, mtime, launch_count, thumb, thumb_mime)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(object_id) DO UPDATE SET
           mode=excluded.mode, path=excluded.path, name=excluded.name, is_dir=excluded.is_dir,
           size=excluded.size, mtime=excluded.mtime, launch_count=excluded.launch_count,
           thumb=excluded.thumb, thumb_mime=excluded.thumb_mime`,
        [
          e.objectId, e.mode, e.path, e.name, e.isDir ? 1 : 0,
          e.size, e.mtime, e.launchCount ?? 0,
          e.thumb ?? null, e.thumb ? 'image/png' : null,
        ],
      );
      if (backend === 'idb-sqlite') await persistMemToIdb();
      return true;
    }

    case 'listFsEntries': {
      const stmt = db.prepare(
        'SELECT object_id, mode, path, name, is_dir, size, mtime, launch_count, thumb FROM fs_entries',
      );
      const out: import('@core/ports/index').FsEntryRow[] = [];
      while (stmt.step()) {
        out.push({
          objectId: stmt.get(0) as string,
          mode: stmt.get(1) as 0 | 1 | 2,
          path: (stmt.get(2) as string) ?? null,
          name: stmt.get(3) as string,
          isDir: Boolean(stmt.get(4)),
          size: (stmt.get(5) as number) ?? null,
          mtime: (stmt.get(6) as number) ?? null,
          launchCount: (stmt.get(7) as number) ?? 0,
          thumb: (stmt.get(8) as string) ?? null,
        });
      }
      stmt.finalize();
      return out;
    }

    case 'export':
      return db.export();

    case 'close':
      if (backend === 'idb-sqlite') await persistMemToIdb();
      db.close();
      return true;

    default:
      throw new Error(`Método desconhecido: ${method}`);
  }
}

// helpers de leitura (reconstroem objetos a partir das colunas)
function loadObjects(): import('@core/model/types').BumpObjectData[] {
  const stmt = db.prepare(
    'SELECT id, kind, type_flags, parent_id, px,py,pz, qx,qy,qz,qw, vx,vy,vz, scale, pinned_wall, frozen, label, meta_json FROM objects',
  );
  const out: import('@core/model/types').BumpObjectData[] = [];
  while (stmt.step()) {
    out.push({
      id: stmt.get(0) as string,
      kind: stmt.get(1) as never,
      typeFlags: stmt.get(2) as never,
      parentId: (stmt.get(3) as string) ?? null,
      pose: {
        position: { x: stmt.get(4) as number, y: stmt.get(5) as number, z: stmt.get(6) as number },
        rotation: { x: stmt.get(7) as number, y: stmt.get(8) as number, z: stmt.get(9) as number, w: stmt.get(10) as number },
      },
      velocity: { x: stmt.get(11) as number, y: stmt.get(12) as number, z: stmt.get(13) as number },
      scale: (stmt.get(14) as number) ?? 1,
      pinnedWall: (stmt.get(15) as number) ?? null,
      frozen: Boolean(stmt.get(16)),
      label: (stmt.get(17) as string) ?? null,
      meta: JSON.parse((stmt.get(18) as string) ?? '{}'),
    });
  }
  stmt.reset();
  stmt.finalize();
  return out;
}

function loadPiles(): Record<string, { layout: never; page: number }> {
  const stmt = db.prepare('SELECT object_id, layout, page FROM piles');
  const out: Record<string, { layout: never; page: number }> = {};
  while (stmt.step()) {
    out[stmt.get(0) as string] = { layout: stmt.get(1) as never, page: (stmt.get(2) as number) ?? 0 };
  }
  stmt.reset();
  stmt.finalize();
  return out;
}

// ---------------------------------------------------------------------------
// loop de mensagens
// ---------------------------------------------------------------------------

ctx.onmessage = async (e: MessageEvent<RpcRequest>) => {
  const { id, method, params } = e.data;
  try {
    const result = await handle(method, params ?? []);
    const res: RpcResponse = { id, result };
    ctx.postMessage(res);
  } catch (err) {
    const res: RpcResponse = { id, error: (err as Error).message };
    ctx.postMessage(res);
  }
};

export { LATEST_VERSION };
