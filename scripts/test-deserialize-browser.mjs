/** Teste no BROWSER do roundtrip serialize→deserialize do sqlite-wasm:
 *  o build de browser tem oo1.DB.export()/deserialize(); verificamos se a
 *  escrita pós-deserialize funciona (padrão do backend idb-sqlite).
 *
 * Uso: node scripts/test-deserialize-browser.mjs  (sobe um server estático
 * para o pacote @sqlite.org/sqlite-wasm sozinho)
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const PKG = new URL('../node_modules/@sqlite.org/sqlite-wasm/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };

const server = createServer((req, res) => {
  const p = join(PKG, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(p)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(8099, r));
console.log('server em http://localhost:8099');

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  await page.goto('http://localhost:8099/', { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const mod = await import('http://localhost:8099/dist/index.mjs');
    const sqlite3 = await mod.default();
    const log = [];
    const db1 = new sqlite3.oo1.DB();
    db1.exec('CREATE TABLE t (a TEXT)');
    db1.exec("INSERT INTO t VALUES ('x')");

    // Probe: quais APIs de serialize/deserialize existem?
    const probe = {
      'db.pointer': typeof db1.pointer,
      'db.serialize': typeof db1.serialize,
      'db.export': typeof db1.export,
      'db.deserialize': typeof db1.deserialize,
      'capi.sqlite3_serialize': typeof sqlite3.capi.sqlite3_serialize,
      'capi.sqlite3_deserialize': typeof sqlite3.capi.sqlite3_deserialize,
      'capi.sqlite3_malloc': typeof sqlite3.capi.sqlite3_malloc,
      'capi.sqlite3_free': typeof sqlite3.capi.sqlite3_free,
      RESIZEABLE: sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      READONLY: sqlite3.capi.SQLITE_DESERIALIZE_READONLY,
      FREEAFTERUSE: sqlite3.capi.SQLITE_DESERIALIZE_FREEAFTERUSE,
    };
    log.push('probe: ' + JSON.stringify(probe));

    // Teste do FIX candidato: sqlite3_js_db_export + capi.sqlite3_deserialize
    let fixOk = false;
    try {
      const blob = sqlite3.capi.sqlite3_js_db_export(db1);
      log.push(`sqlite3_js_db_export: ${blob.length} bytes`);
      db1.close();
      const wasm = sqlite3.wasm;
      const capi = sqlite3.capi;
      const db2 = new sqlite3.oo1.DB();
      const p = wasm.allocFromTypedArray(blob);
      const rc = capi.sqlite3_deserialize(db2.pointer, 'main', p, blob.byteLength, blob.byteLength, capi.SQLITE_DESERIALIZE_RESIZEABLE);
      log.push(`deserialize rc=${rc}`);
      db2.exec("INSERT INTO t VALUES ('y')");
      const s = db2.prepare('SELECT COUNT(*) c FROM t');
      s.step();
      const linhas = s.get(0);
      s.finalize();
      log.push(`SELECT pós-deserialize: linhas=${linhas} (esperado 2)`);
      fixOk = linhas === 2;
      // Segunda rodada: export de novo (persist após writes)
      const blob2 = sqlite3.capi.sqlite3_js_db_export(db2);
      log.push(`re-export após INSERT: ${blob2.length} bytes`);
      db2.close();
    } catch (e) {
      log.push('fix FALHOU → ' + e.message);
      try { db1.close(); } catch { /* já fechado */ }
    }
    return { log, fixOk };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  server.close();
}
