/**
 * Protocolo RPC entre a thread principal e o Worker de persistência.
 * O `SqliteRepo` (main) envia comandos; o worker responde com resultado/erro.
 */
import type { BumpObjectData, SceneSnapshot } from '@core/model/types';

export type RepoMethod =
  | 'init'
  | 'saveScene'
  | 'loadScene'
  | 'upsertObject'
  | 'deleteObject'
  | 'getSetting'
  | 'setSetting'
  | 'upsertFsEntry'
  | 'listFsEntries'
  | 'backend'
  | 'export'
  | 'close';

export interface RpcRequest {
  id: number;
  method: RepoMethod;
  params: unknown[];
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

// Payloads tipados (auxílio p/ chamadores)
export interface SaveSceneParams {
  snapshot: SceneSnapshot;
}
export interface UpsertObjectParams {
  data: BumpObjectData;
}
