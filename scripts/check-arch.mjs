/**
 * Lint de arquitetura — garante que `src/core/**` permanece PURO.
 *
 * Regra central do projeto: o core não pode importar adapters (three, rapier,
 * sqlite, idb) nem APIs de DOM/WebGL/SQL. Só pode importar de dentro de core/.
 * Se quebrar, o port para Tauri/Electron fica comprometido.
 *
 * Uso: node scripts/check-arch.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDir = join(__dirname, '..', 'src', 'core');

// Padrões proibidos dentro de core/
const FORBIDDEN = [
  /\bfrom\s+['"]three\b/,
  /\bfrom\s+['"]@dimforge\b/,
  /\bfrom\s+['"]@sqlite\b/,
  /\bfrom\s+['"]idb\b/,
  /\bfrom\s+['"]preact\b/,
  /\bfrom\s+['"]@physics\b/,
  /\bfrom\s+['"]@render\b/,
  /\bfrom\s+['"]@persistence\b/,
  /\bfrom\s+['"]@fs\b/,
  /\bfrom\s+['"]@input\b/,
  /\bfrom\s+['"]@overlay\b/,
  /\bfrom\s+['"]@app\b/,
  /\bdocument\./,
  /\bwindow\./,
  /\bTHREE\.|WebGLRenderingContext|WebGL2RenderingContext/,
  /\blocalStorage\b/,
  /\bindexedDB\b/,
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

let violations = 0;
let checked = 0;
for (const file of walk(coreDir)) {
  checked++;
  const src = readFileSync(file, 'utf8');
  for (const pattern of FORBIDDEN) {
    const m = src.match(pattern);
    if (m) {
      console.error(`✗ ${file}: usa padrão proibido "${m[0].trim()}"`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} violação(ões) de arquitetura em core/.`);
  process.exit(1);
}
console.log(`✓ core/ puro: ${checked} arquivos verificados, 0 violações.`);
