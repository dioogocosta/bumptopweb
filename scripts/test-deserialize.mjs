/**
 * Teste do roundtrip deserialize do sqlite-wasm (fallback idb-sqlite):
 * cria DB em memória → escreve → export() → deserialize() → tenta ESCREVER.
 * Se a escrita pós-deserialize falhar, o backend idb-sqlite é somente-leitura
 * e explica "cena zerada a cada F5" nos navegadores onde o VFS OPFS falha.
 */
import initSqlJs from '@sqlite.org/sqlite-wasm';

const sqlite3 = await initSqlJs.default();
console.log('sqlite3 versão:', sqlite3.version?.libVersion ?? '?');

// 1. DB em memória + write
let db = new sqlite3.oo1.DB();
db.exec('CREATE TABLE t (a TEXT)');
db.exec("INSERT INTO t VALUES ('x')");
const blob = db.export();
db.close();
console.log('export():', blob.length, 'bytes');

// 2. deserialize e tenta escrever de novo
let db2 = new sqlite3.oo1.DB();
try {
  db2.deserialize(blob);
} catch (e) {
  console.log('deserialize() lançou:', e.message);
}
try {
  db2.exec("INSERT INTO t VALUES ('y')");
  const stmt = db2.prepare('SELECT COUNT(*) c FROM t');
  stmt.step();
  console.log('pós-deserialize INSERT: OK — linhas =', stmt.get(0));
  stmt.finalize();
} catch (e) {
  console.log('pós-deserialize INSERT: FALHOU →', e.message);
}
db2.close();

// 3. deserialize com flags READWRITE|RESIZEABLE (fix candidato)
const READWRITE = sqlite3.capi.SQLITE_DESERIALIZE_FREEAFTERUSE ?? 0;
const RESIZEABLE = sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE ?? 0;
console.log('flags disponíveis: RESIZEABLE =', RESIZEABLE, '| FREEAFTERUSE =', READWRITE);
let db3 = new sqlite3.oo1.DB();
try {
  db3.deserialize(blob, { flags: RESIZEABLE | READWRITE });
  db3.exec("INSERT INTO t VALUES ('z')");
  const stmt = db3.prepare('SELECT COUNT(*) c FROM t');
  stmt.step();
  console.log('com flags: INSERT OK — linhas =', stmt.get(0));
  stmt.finalize();
} catch (e) {
  console.log('com flags: FALHOU →', e.message);
}
db3.close();
