/**
 * Adapter de repositório (thread principal) — fala com o Worker SQLite via RPC.
 * Implementa a porta `IRepo`. O `core` nunca vê SQL nem o worker.
 */
import type { IRepo, FsEntryRow } from '@core/ports/index';
import type { BumpObjectData, SceneSnapshot } from '@core/model/types';
import type { RpcRequest, RpcResponse, RepoMethod } from './rpc';

export class SqliteRepo implements IRepo {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _backend = 'unknown';

  constructor() {
    // Vite: new Worker com import de módulo (necessário p/ WASM no worker)
    this.worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<RpcResponse>) => {
      const { id, result, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    this.worker.onerror = (e) => {
      // Rejeita todos pendentes em caso de crash do worker
      for (const [, p] of this.pending) p.reject(new Error(`Worker error: ${e.message}`));
      this.pending.clear();
    };
  }

  private call<T>(method: RepoMethod, params: unknown[] = []): Promise<T> {
    const id = this.nextId++;
    const req: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage(req);
    });
  }

  async init(): Promise<void> {
    this._backend = (await this.call<string>('init')) as string;
    // Solicita persistência durável (evita eviction em PWA mobile)
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  async saveScene(snapshot: SceneSnapshot): Promise<void> {
    await this.call('saveScene', [{ snapshot }]);
  }

  async loadScene(): Promise<SceneSnapshot | null> {
    return (await this.call('loadScene')) as SceneSnapshot | null;
  }

  async upsertObject(data: BumpObjectData): Promise<void> {
    await this.call('upsertObject', [{ data }]);
  }

  async deleteObject(id: string): Promise<void> {
    await this.call('deleteObject', [id]);
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    return (await this.call('getSetting', [key, fallback])) as T;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.call('setSetting', [key, value]);
  }

  async upsertFsEntry(entry: FsEntryRow): Promise<void> {
    await this.call('upsertFsEntry', [entry]);
  }

  async listFsEntries(): Promise<FsEntryRow[]> {
    return (await this.call('listFsEntries')) as FsEntryRow[];
  }

  backend(): string {
    return this._backend;
  }

  async export(): Promise<Uint8Array> {
    return (await this.call('export')) as Uint8Array;
  }

  async close(): Promise<void> {
    await this.call('close');
    this.worker.terminate();
  }
}
