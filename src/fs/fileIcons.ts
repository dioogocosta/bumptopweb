/**
 * Ícones e texturas de cards para tipos de arquivo.
 *
 * Gera textura SVG completa (256x256) no formato de ficha/papel BumpTop:
 * fundo branco com borda, badge de categoria colorido, ícone vetorial
 * ampliado e nome do arquivo impresso na base do card.
 */

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgDataUrl(svgContent: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svgContent)}`;
}

export const CATEGORY_COLORS: Record<string, string> = {
  // Office
  doc: '#1d4ed8',
  docx: '#1d4ed8',
  rtf: '#1d4ed8',
  xls: '#15803d',
  xlsx: '#15803d',
  csv: '#15803d',
  ppt: '#c2410c',
  pptx: '#c2410c',
  // PDF
  pdf: '#b91c1c',
  // Texto / Markdown
  txt: '#334155',
  md: '#334155',
  // Código
  js: '#6d28d9',
  ts: '#6d28d9',
  jsx: '#6d28d9',
  tsx: '#6d28d9',
  json: '#6d28d9',
  html: '#6d28d9',
  css: '#6d28d9',
  py: '#6d28d9',
  sql: '#6d28d9',
  db: '#6d28d9',
  // Imagens
  png: '#0e7490',
  jpg: '#0e7490',
  jpeg: '#0e7490',
  gif: '#0e7490',
  webp: '#0e7490',
  svg: '#0e7490',
  bmp: '#0e7490',
  avif: '#0e7490',
  // Vídeo
  mp4: '#be185d',
  mkv: '#be185d',
  avi: '#be185d',
  mov: '#be185d',
  webm: '#be185d',
  // Áudio
  mp3: '#b45309',
  wav: '#b45309',
  flac: '#b45309',
  ogg: '#b45309',
  // Arquivos compactados
  zip: '#4338ca',
  rar: '#4338ca',
  '7z': '#4338ca',
  tar: '#4338ca',
  gz: '#4338ca',
  // Executáveis
  exe: '#1e293b',
  msi: '#1e293b',
  apk: '#1e293b',
  app: '#1e293b',
  // Fontes
  ttf: '#0f766e',
  otf: '#0f766e',
  woff: '#0f766e',
  // Pasta
  folder: '#d97706',
};

export const RAW_PATHS: Record<string, string> = {
  // Office
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
  docx: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#1d4ed8">W</text>',
  xls: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>',
  xlsx: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#15803d">X</text>',
  ppt: '<rect x="3" y="3" width="18" height="18" rx="2"/><polygon points="12 6 18 12 12 18 6 12"/>',
  pptx: '<rect x="3" y="3" width="18" height="18" rx="2"/><polygon points="12 6 18 12 12 18 6 12"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#c2410c">P</text>',
  // PDF
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="8" font-weight="bold" text-anchor="middle" stroke="none" fill="#b91c1c">PDF</text>',
  // Texto
  txt: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  md: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="9" x2="9" y2="15"/><line x1="15" y1="9" x2="15" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>',
  rtf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#1d4ed8">RTF</text>',
  // Código
  js: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">JS</text>',
  ts: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">TS</text>',
  jsx: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">JSX</text>',
  tsx: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">TSX</text>',
  json: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">{ }</text>',
  html: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">&lt;&gt;</text>',
  css: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">CSS</text>',
  py: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="7" font-weight="bold" text-anchor="middle" stroke="none" fill="#6d28d9">PY</text>',
  sql: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14"/><path d="M21 5v14"/><ellipse cx="12" cy="19" rx="9" ry="3"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14"/><path d="M21 5v14"/><ellipse cx="12" cy="19" rx="9" ry="3"/>',
  // Imagens
  png: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  jpg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  jpeg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  gif: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#0e7490">GIF</text>',
  webp: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/><text x="12" y="16" font-size="5" font-weight="bold" text-anchor="middle" stroke="none" fill="#0e7490">WEBP</text>',
  svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="8 16 12 12 16 16"/><line x1="12" y1="8" x2="12" y2="16"/>',
  bmp: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  avif: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  // Vídeo
  mp4: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  mkv: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/><text x="12" y="16" font-size="5" font-weight="bold" text-anchor="middle" stroke="none" fill="#be185d">MKV</text>',
  avi: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#be185d">AVI</text>',
  mov: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/><text x="12" y="16" font-size="5" font-weight="bold" text-anchor="middle" stroke="none" fill="#be185d">MOV</text>',
  webm: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/><text x="12" y="16" font-size="5" font-weight="bold" text-anchor="middle" stroke="none" fill="#be185d">WEBM</text>',
  // Áudio
  mp3: '<path d="M11 5v14"/><path d="M19 5v14"/><path d="M3 17a4 4 0 0 0 4 4"/><path d="M3 7a7 7 0 0 1 14 0"/><path d="M3 3a11 11 0 0 1 22 0"/>',
  wav: '<path d="M11 5v14"/><path d="M19 5v14"/><path d="M3 17a4 4 0 0 0 4 4"/><path d="M3 7a7 7 0 0 1 14 0"/><path d="M3 3a11 11 0 0 1 22 0"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#b45309">WAV</text>',
  flac: '<path d="M11 5v14"/><path d="M19 5v14"/><path d="M3 17a4 4 0 0 0 4 4"/><path d="M3 7a7 7 0 0 1 14 0"/><path d="M3 3a11 11 0 0 1 22 0"/>',
  ogg: '<path d="M11 5v14"/><path d="M19 5v14"/><path d="M3 17a4 4 0 0 0 4 4"/><path d="M3 7a7 7 0 0 1 14 0"/><path d="M3 3a11 11 0 0 1 22 0"/>',
  // Compactados
  zip: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><path d="M18 8a2 2 0 0 0 0-4H7a2 2 0 0 0 0 4"/><line x1="10" y1="12" x2="10" y2="16"/><line x1="14" y1="12" x2="14" y2="16"/>',
  rar: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><path d="M18 8a2 2 0 0 0 0-4H7a2 2 0 0 0 0 4"/><line x1="10" y1="12" x2="10" y2="16"/><line x1="14" y1="12" x2="14" y2="16"/><text x="12" y="16" font-size="5" font-weight="bold" text-anchor="middle" stroke="none" fill="#4338ca">RAR</text>',
  '7z': '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><path d="M18 8a2 2 0 0 0 0-4H7a2 2 0 0 0 0 4"/><line x1="10" y1="12" x2="10" y2="16"/><line x1="14" y1="12" x2="14" y2="16"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#4338ca">7z</text>',
  tar: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><path d="M18 8a2 2 0 0 0 0-4H7a2 2 0 0 0 0 4"/><line x1="10" y1="12" x2="10" y2="16"/><line x1="14" y1="12" x2="14" y2="16"/>',
  gz: '<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/><path d="M18 8a2 2 0 0 0 0-4H7a2 2 0 0 0 0 4"/><line x1="10" y1="12" x2="10" y2="16"/><line x1="14" y1="12" x2="14" y2="16"/>',
  // Executáveis
  exe: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 15 15 9"/>',
  msi: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 15 15 9"/>',
  apk: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 15 15 9"/>',
  app: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 12 12 15 15 9"/>',
  // Fontes
  ttf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="8" font-weight="bold" text-anchor="middle" stroke="none" fill="#0f766e">Aa</text>',
  otf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="8" font-weight="bold" text-anchor="middle" stroke="none" fill="#0f766e">O</text>',
  woff: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" stroke="none" fill="#0f766e">WOFF</text>',
  // Pasta
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16z"/>',
};

/**
 * Gera a textura completa de um card de documento (256x256).
 * Inclui folha de papel, badge de cor por tipo, ícone vetorial
 * e o nome do arquivo impresso na base do card.
 */
export function makeFileCardSvg(ext: string, label?: string): string {
  const key = ext.toLowerCase();
  const color = CATEGORY_COLORS[key] ?? CATEGORY_COLORS.folder;
  const paths = RAW_PATHS[key] ?? RAW_PATHS.folder;
  const rawLabel = label ?? ext.toUpperCase();
  const displayLabel = rawLabel.length > 17 ? rawLabel.slice(0, 15) + '…' : rawLabel;
  const safeLabel = escapeXml(displayLabel);
  const tag = escapeXml(ext ? ext.toUpperCase().slice(0, 4) : 'FILE');

  return svgDataUrl(`
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="100%" stop-color="#f8fafc"/>
        </linearGradient>
      </defs>
      <!-- Base do papel com cantos arredondados -->
      <rect x="8" y="8" width="240" height="240" rx="16" fill="url(#cardGrad)" stroke="#cbd5e1" stroke-width="3"/>
      <!-- Faixa colorida da categoria no topo -->
      <path d="M 8 24 Q 8 8 24 8 L 232 8 Q 248 8 248 24 L 248 38 L 8 38 Z" fill="${color}"/>
      <!-- Badge de extensão no topo direito -->
      <rect x="182" y="13" width="56" height="18" rx="5" fill="#ffffff" opacity="0.95"/>
      <text x="210" y="26" font-size="11" font-family="system-ui, -apple-system, sans-serif" font-weight="900" text-anchor="middle" fill="${color}">${tag}</text>
      <!-- Ícone vetorial centralizado -->
      <g transform="translate(68, 54) scale(5)" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${paths}
      </g>
      <!-- Tarjeta inferior para o nome do arquivo -->
      <rect x="16" y="196" width="224" height="42" rx="8" fill="#f1f5f9"/>
      <text x="128" y="223" font-size="14.5" font-family="system-ui, -apple-system, sans-serif" font-weight="bold" text-anchor="middle" fill="#0f172a">${safeLabel}</text>
    </svg>
  `);
}

/** Retorna dataURL do ícone/card p/ uma extensão e rótulo. */
export function iconForExt(ext: string, label?: string): string {
  return makeFileCardSvg(ext, label);
}

/** Mapa compatível com o schema antigo. */
export const FILE_ICONS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get: (_target, prop: string) => makeFileCardSvg(prop, prop.toUpperCase()),
});

/** Lista todas as extensões suportadas. */
export function supportedExtensions(): string[] {
  return Object.keys(RAW_PATHS).filter((k) => k !== 'folder');
}