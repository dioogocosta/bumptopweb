export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: Record<string, unknown> }>;
  all<T = unknown>(): Promise<{ success: boolean; results?: T[]; meta: Record<string, unknown> }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface Env {
  DB: D1Database;
}

export interface EventContext<E, P extends string = string, D = Record<string, unknown>> {
  request: Request;
  functionPath: string;
  waitUntil: (promise: Promise<unknown>) => void;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  env: E;
  params: Record<P, string | string[]>;
  data: D;
}

export type PagesFunction<E = Env, P extends string = string, D = Record<string, unknown>> = (
  context: EventContext<E, P, D>
) => Response | Promise<Response>;

export interface UserRow {
  id: string;
  email: string;
  salt: string;
  hash: string;
  created_at: number;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
}

export interface SceneRow {
  user_id: string;
  payload: string;
  updated_at: number;
}
