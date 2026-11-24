/**
 * PR4.4 — BuildingView
 *
 * Renderiza as caixas (BoxEntityData) como andares empilhados de um prédio 3D.
 * Inclui dashboard com estatísticas, busca global e dots de match nos andares.
 */
import * as THREE from 'three';
import type { BoxType } from '@core/ports/index';
import type { BoxEntityData } from '@core/model/types';
import { t } from '@core/i18n/i18n';

// ── Tipos públicos ─────────────────────────────────────────────────────────

export interface BoxStats {
  boxId: string;
  notes: number;
  photos: number;
  documents: number;
  others: number;
  noteItems: Array<{ id: string; label: string; text: string }>;
}

export interface BuildingStatsData {
  boxes: BoxStats[];
}

export interface SearchMatch {
  itemId: string;
  boxId: string;
  label: string;
  floorNum: number;
}

export type FloorClickCallback  = (boxId: string)  => void;
export type ItemClickCallback   = (itemId: string, boxId: string) => void;
export type SearchQueryCallback = (query: string)  => void;
export type FavoriteCallback    = (boxId: string, isFavorite: boolean) => void;

// ── Constantes ────────────────────────────────────────────────────────────

const FLOOR_COLOR: Record<BoxType, number> = {
  comum:   0x5a6a80,
  root:    0x22c55e,
  kanban:  0xf97316,
  backlog: 0x8b5cf6,
  sprint:  0x0ea5e9,
};

const FLOOR_HEIGHT     = 4.2;
const FLOOR_WIDTH      = 28;
const FLOOR_DEPTH      = 18;
const FLOOR_GAP        = 0.35;
const SELECTED_OPACITY = 0.95;
const DEFAULT_OPACITY  = 0.45;
const DIM_OPACITY      = 0.15;

// ── Helpers ───────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration> = {},
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function drawDonut(canvas: HTMLCanvasElement, slices: { value: number; color: string }[]): void {
  const ctx = canvas.getContext('2d')!;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = Math.min(cx, cy) - 6;
  const inner = r * 0.56;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const total = slices.reduce((s, v) => s + v.value, 0) || 1;
  let start = -Math.PI / 2;
  for (const sl of slices) {
    const sweep = (sl.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.closePath();
    ctx.fillStyle = sl.color;
    ctx.fill();
    start += sweep;
  }
  // anel interno vazio
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = '#0d1420';
  ctx.fill();
  // total no centro
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `bold ${Math.round(r * 0.38)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(total), cx, cy);
}

// ── Classe principal ───────────────────────────────────────────────────────

export class BuildingView {
  private container!:  HTMLDivElement;
  private tooltip!:    HTMLDivElement;
  private scene!:      THREE.Scene;
  private camera!:     THREE.PerspectiveCamera;
  private renderer!:   THREE.WebGLRenderer;
  private group =      new THREE.Group();
  private raf = 0;

  // Câmera órbita
  private cam = { theta: 2.35, phi: 1.15, dist: 90, ty: 15 };
  private drag = { down: false, lx: 0, ly: 0 };

  private rawBoxes:        BoxEntityData[]  = [];
  private floors: Array<{ id: string; mesh: THREE.Mesh; edges: THREE.LineSegments; sprite?: THREE.Sprite }> = [];
  private clickableObjects: THREE.Object3D[] = [];
  private selectedId:  string | null = null;
  private hoveredId:   string | null = null;
  private clickCb:      FloorClickCallback  | null = null;
  private itemClickCb:  ItemClickCallback   | null = null;
  private searchCb:     SearchQueryCallback | null = null;
  private favoriteCb:   FavoriteCallback    | null = null;
  /** PR4.16 — filtro ⭐ do HUD: só andares/projetos favoritados. */
  private favoriteFilterOn = false;

  private visible  = false;
  private fadeAlpha = 0;
  private fadeDir   = 0;
  private fadeCb:  (() => void) | null = null;

  // Dashboard
  private statsData: BuildingStatsData | null = null;
  private searchMatches: SearchMatch[] = [];

  // Dashboard DOM nodes (criados em _createDashboard)
  private dashOverlay!: HTMLDivElement;
  private donutCanvas!: HTMLCanvasElement;
  private statTotal!:   HTMLElement;
  private statBoxes!:   HTMLElement;
  private statNotes!:   HTMLElement;
  private statPhotos!:  HTMLElement;
  private statDocs!:    HTMLElement;
  private floorListEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchCountEl!: HTMLElement;
  private dotsLayer!:  HTMLDivElement;
  private dotEls: Array<{ el: HTMLDivElement; match: SearchMatch; floorY: number }> = [];

  // PR4.13 — painéis Resumo/Andares: referências p/ poder movê-los entre o
  // dashboard do prédio e o host flutuante usado no ambiente das caixas.
  private summaryPanel!: HTMLElement;
  private floorsPanel!: HTMLElement;
  private barsWrap!:     HTMLElement;
  private boxPanelHost!: HTMLDivElement;
  private summaryOpen = false;
  private floorsOpen  = false;
  private panelsChangeCb: ((floors: boolean, summary: boolean) => void) | null = null;

  // PR4.12 — Perfil do usuário e Loading
  private profileCb: (() => void) | null = null;
  private profileBtn!: HTMLElement;
  private profileAvatarEl!: HTMLElement;
  private profileNameEl!: HTMLElement;
  private profileStatusDot!: HTMLElement;
  private profileStatusText!: HTMLElement;
  private loadingOverlay!: HTMLDivElement;
  private loadingTitleEl!: HTMLElement;
  private loadingSubEl!: HTMLElement;

  // ── Mount ──────────────────────────────────────────────────────────────

  mount(parent: HTMLElement): void {
    // z-index 5: ACIMA da cena (#scene-root, z auto) e ABAIXO do HUD
    // (#overlay-root, z 10) — antes era 50 e o canvas do prédio cobria toda a
    // barra de botões (tema/zoom ficavam inacessíveis na primeira tela).
    this.container = el('div', {
      position: 'absolute', inset: '0',
      zIndex: '5', opacity: '0',
      pointerEvents: 'none', transition: 'none',
    });
    parent.appendChild(this.container);

    // PR4.13 — host dos painéis quando abertos no ambiente das caixas.
    // Vive FORA do container (não recebe o fade do prédio) e em z 8: abaixo do
    // HUD (z 10) p/ os botões continuarem clicáveis por cima, acima da cena.
    this.boxPanelHost = el('div', {
      position: 'fixed', inset: '0',
      zIndex: '8', pointerEvents: 'none',
    });
    parent.appendChild(this.boxPanelHost);

    // Tooltip flutuante
    this.tooltip = el('div', {
      position: 'absolute', pointerEvents: 'none',
      background: 'rgba(15,23,42,0.92)',
      border: '1px solid rgba(99,179,237,0.4)',
      color: '#e2e8f0', borderRadius: '6px',
      padding: '5px 10px', fontSize: '12px',
      fontFamily: 'sans-serif', fontWeight: '500',
      zIndex: '60', display: 'none',
      transform: 'translate(-50%,-140%)',
      backdropFilter: 'blur(8px)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      whiteSpace: 'nowrap',
    });
    this.container.appendChild(this.tooltip);

    const w = parent.clientWidth  || window.innerWidth;
    const h = parent.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f16);
    this.scene.fog = new THREE.Fog(0x0a0f16, 200, 500);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.container.appendChild(this.renderer.domElement);
    // PR mobile — sem isto o navegador interpreta o arrasto do dedo como
    // rolagem/gestos da página e o pointermove é cancelado (pointercancel):
    // a órbita da câmera não completava no celular.
    this.renderer.domElement.style.touchAction = 'none';

    // Luzes
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.85);
    dir1.position.set(60, 120, 80);
    this.scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0x63b3ed, 0.35);
    dir2.position.set(-60, 40, -80);
    this.scene.add(dir2);

    // Chão grade
    const grid = new THREE.GridHelper(300, 24, 0x1e293b, 0x0f172a);
    this.scene.add(grid);

    this.scene.add(this.group);

    // Dashboard DOM
    this._createDashboard();

    // Dots layer (sobre tudo)
    this.dotsLayer = el('div', {
      position: 'absolute', inset: '0',
      pointerEvents: 'none', zIndex: '55',
    });
    this.container.appendChild(this.dotsLayer);

    this._bindEvents();
    // Estado inicial dos painéis: nas caixas (prédio ainda não mostrado) ficam
    // fechados; show() reabre os dois quando o prédio é exibido.
    this._applyPanels();
    this._tick();
  }

  // ── Dashboard DOM ──────────────────────────────────────────────────────

  private _createDashboard(): void {
    this.dashOverlay = el('div', {
      position: 'absolute', inset: '0',
      zIndex: '52', pointerEvents: 'none',
      fontFamily: "'Inter',system-ui,sans-serif",
    });
    this.container.appendChild(this.dashOverlay);

    // ── Painel Esquerdo ───────────────────────────────────
    // top 60px: o HUD (barra de zoom/tema) renderiza ACIMA do prédio desde o
    // PR4.13 — o painel desce para não ficar escondido sob a barra.
    const leftPanel = el('div', {
      position: 'absolute', top: '60px', left: '16px',
      width: '200px',
      background: 'rgba(10,15,22,0.82)',
      border: '1px solid rgba(56,189,248,0.18)',
      borderRadius: '14px', padding: '16px',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      pointerEvents: 'auto', userSelect: 'none',
    });

    // Título
    const title = el('div', {
      color: '#38bdf8', fontWeight: '700',
      fontSize: '11px', letterSpacing: '0.12em',
      textTransform: 'uppercase', marginBottom: '12px',
    });
    title.textContent = '📊 Resumo';
    leftPanel.appendChild(title);

    // Grid de stats
    const grid2 = el('div', {
      display: 'grid', gridTemplateColumns: '1fr 1fr',
      gap: '8px', marginBottom: '14px',
    });

    const mkStat = (label: string, val: string, accent: string): HTMLElement => {
      const box = el('div', {
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '8px', padding: '8px 10px',
        border: `1px solid ${accent}22`,
      });
      const v = el('div', { color: accent, fontSize: '20px', fontWeight: '800', lineHeight: '1' });
      v.textContent = val;
      const l = el('div', { color: '#94a3b8', fontSize: '10px', marginTop: '3px' });
      l.textContent = label;
      box.appendChild(v); box.appendChild(l);
      return box;
    };

    // Guardamos referências para atualizar depois
    const boxStat  = mkStat('Andares', '0', '#38bdf8');
    const totStat  = mkStat('Total', '0', '#a78bfa');
    const noteStat = mkStat('Notas', '0', '#fbbf24');
    const photoStat= mkStat('Fotos', '0', '#34d399');
    const docStat  = mkStat('Docs', '0', '#f87171');
    const otherStat= mkStat('Outros', '0', '#94a3b8');

    this.statBoxes  = boxStat.firstElementChild  as HTMLElement;
    this.statTotal  = totStat.firstElementChild  as HTMLElement;
    this.statNotes  = noteStat.firstElementChild as HTMLElement;
    this.statPhotos = photoStat.firstElementChild as HTMLElement;
    this.statDocs   = docStat.firstElementChild  as HTMLElement;

    grid2.appendChild(boxStat); grid2.appendChild(totStat);
    grid2.appendChild(noteStat); grid2.appendChild(photoStat);
    grid2.appendChild(docStat); grid2.appendChild(otherStat);
    leftPanel.appendChild(grid2);

    // Donut chart
    const donutWrap = el('div', {
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', marginBottom: '10px',
    });
    this.donutCanvas = el('canvas', { width: '100px', height: '100px' }, { width: '100', height: '100' });
    donutWrap.appendChild(this.donutCanvas);

    // Legenda do donut
    const legend = el('div', {
      display: 'flex', flexWrap: 'wrap', gap: '6px 10px',
      justifyContent: 'center', marginTop: '8px',
    });
    const mkLeg = (color: string, label: string) => {
      const row = el('div', { display: 'flex', alignItems: 'center', gap: '4px' });
      const dot = el('div', { width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: '0' });
      const lbl = el('span', { color: '#94a3b8', fontSize: '10px' });
      lbl.textContent = label;
      row.appendChild(dot); row.appendChild(lbl);
      return row;
    };
    legend.appendChild(mkLeg('#fbbf24', 'Notas'));
    legend.appendChild(mkLeg('#34d399', 'Fotos'));
    legend.appendChild(mkLeg('#f87171', 'Docs'));
    legend.appendChild(mkLeg('#94a3b8', 'Outros'));
    donutWrap.appendChild(legend);
    leftPanel.appendChild(donutWrap);

    // Barra de ocupação por andar (mini)
    const barsLabel = el('div', {
      color: '#64748b', fontSize: '10px', letterSpacing: '0.08em',
      textTransform: 'uppercase', marginBottom: '6px',
    });
    barsLabel.textContent = 'Itens por andar';
    leftPanel.appendChild(barsLabel);

    // Container das barras (preenchido em setStats)
    const barsWrap = el('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    barsWrap.id = 'bv-bars';
    leftPanel.appendChild(barsWrap);

    // PR4.13 — refs p/ mover o painel entre o prédio e as caixas (e p/ o
    // setStats achar as barras sem depender de querySelector no dashOverlay)
    this.barsWrap     = barsWrap;
    this.summaryPanel = leftPanel;
    leftPanel.className = 'bv-summary';

    this.dashOverlay.appendChild(leftPanel);

    // ── Botão de Perfil do Usuário (Top Right) ─────────────
    this.profileBtn = el('button', {
      position: 'absolute', top: '16px', right: '16px',
      width: '210px', height: '48px',
      background: 'rgba(10,15,22,0.88)',
      border: '1px solid rgba(139,92,246,0.35)',
      borderRadius: '24px', padding: '6px 12px 6px 6px',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', gap: '10px',
      cursor: 'pointer', pointerEvents: 'auto',
      transition: 'border-color 0.15s, transform 0.15s, background 0.15s',
      color: '#f8fafc',
    });
    // Classe p/ o CSS: no celular a pílula some (o 👤 do HUD abre o mesmo
    // modal) — aqui ela nascia por baixo do HUD e dos painéis, intocável.
    this.profileBtn.className = 'bv-profile-btn';

    this.profileAvatarEl = el('div', {
      width: '36px', height: '36px',
      borderRadius: '50%',
      background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '13px', fontWeight: '700', color: '#ffffff',
      overflow: 'hidden', flexShrink: '0',
      border: '1.5px solid rgba(255,255,255,0.2)',
    });
    this.profileAvatarEl.textContent = '👤';

    const pInfo = el('div', {
      display: 'flex', flexDirection: 'column',
      alignItems: 'flex-start', overflow: 'hidden', flex: '1',
      textAlign: 'left',
    });

    this.profileNameEl = el('div', {
      fontSize: '12px', fontWeight: '700', color: '#f8fafc',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      width: '100%',
    });
    this.profileNameEl.textContent = 'Entrar / Perfil';

    const pStatusLine = el('div', {
      display: 'flex', alignItems: 'center', gap: '5px',
      marginTop: '2px',
    });

    this.profileStatusDot = el('div', {
      width: '7px', height: '7px', borderRadius: '50%',
      background: '#64748b', flexShrink: '0',
    });

    this.profileStatusText = el('div', {
      fontSize: '10px', color: '#94a3b8',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    });
    this.profileStatusText.textContent = 'Conectar';

    pStatusLine.appendChild(this.profileStatusDot);
    pStatusLine.appendChild(this.profileStatusText);
    pInfo.appendChild(this.profileNameEl);
    pInfo.appendChild(pStatusLine);

    this.profileBtn.appendChild(this.profileAvatarEl);
    this.profileBtn.appendChild(pInfo);

    this.profileBtn.addEventListener('click', () => {
      this.profileCb?.();
    });
    this.profileBtn.addEventListener('mouseenter', () => {
      this.profileBtn.style.borderColor = 'rgba(139,92,246,0.8)';
      this.profileBtn.style.transform = 'translateY(-1px)';
      this.profileBtn.style.background = 'rgba(18,24,38,0.95)';
    });
    this.profileBtn.addEventListener('mouseleave', () => {
      this.profileBtn.style.borderColor = 'rgba(139,92,246,0.35)';
      this.profileBtn.style.transform = 'none';
      this.profileBtn.style.background = 'rgba(10,15,22,0.88)';
    });

    this.dashOverlay.appendChild(this.profileBtn);

    // ── Painel Direito (lista de andares) ─────────────────
    const rightPanel = el('div', {
      position: 'absolute', top: '74px', right: '16px',
      width: '240px', boxSizing: 'border-box',
      maxHeight: 'calc(100vh - 160px)',
      overflowY: 'auto',
      background: 'rgba(10,15,22,0.82)',
      border: '1px solid rgba(56,189,248,0.18)',
      borderRadius: '14px', padding: '14px',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      pointerEvents: 'auto',
    });

    const rTitle = el('div', {
      color: '#38bdf8', fontWeight: '700',
      fontSize: '11px', letterSpacing: '0.12em',
      textTransform: 'uppercase', marginBottom: '10px',
      cursor: 'grab', touchAction: 'none', userSelect: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '8px',
    });
    rTitle.textContent = '🏢 Andares';
    // PR4.16 — pegador de arrasto: puxa o painel da DIREITA p/ a ESQUERDA
    // (e volta), para o usuário posicionar a lista onde consegue ler.
    const dragHint = el('span', { fontSize: '10px', color: '#64748b', letterSpacing: '0' });
    dragHint.textContent = '⠿';
    dragHint.title = t('ui.floorsDragHint');
    rTitle.appendChild(dragHint);
    rightPanel.appendChild(rTitle);

    this.floorListEl = el('div', { display: 'flex', flexDirection: 'column', gap: '5px' });
    rightPanel.appendChild(this.floorListEl);

    // PR4.13 — ref p/ mover o painel entre o prédio e as caixas
    this.floorsPanel = rightPanel;
    rightPanel.className = 'bv-floors';

    this.dashOverlay.appendChild(rightPanel);

    // PR4.16 — arrastar pelo título (muda left/right) + redimensionar
    // pela borda ESQUERDA (arrasta p/ a direita = painel mais largo, o
    // texto deixa de ser cortado). No celular o CSS toma left/right/width
    // com !important, então o arrasto vira no-op (painel já é full-width).
    this._makeDraggable(rightPanel, rTitle);
    this._makeResizable(rightPanel);

    // ── Barra de busca global (centro-baixo) ─────────────
    const searchWrap = el('div', {
      position: 'absolute', bottom: '20px',
      left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: '8px',
      background: 'rgba(10,15,22,0.90)',
      border: '1px solid rgba(56,189,248,0.3)',
      borderRadius: '30px', padding: '8px 16px',
      backdropFilter: 'blur(14px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      minWidth: '320px', pointerEvents: 'auto',
    });
    // Classe p/ o CSS: no celular o min-width de 320px estourava a tela
    searchWrap.className = 'bv-search-bar';

    const searchIcon = el('span', { color: '#38bdf8', fontSize: '16px', flexShrink: '0' });
    searchIcon.textContent = '🔍';
    searchWrap.appendChild(searchIcon);

    this.searchInput = el('input', {
      background: 'transparent', border: 'none', outline: 'none',
      color: '#e2e8f0', fontSize: '14px', flex: '1', minWidth: '0',
    }, { type: 'text', placeholder: 'Buscar em todos os andares...' });
    this.searchInput.style.setProperty('--placeholder-color', '#475569');

    // Estilo placeholder via CSS injection
    const style = document.createElement('style');
    style.textContent = `.bv-search::placeholder { color: #475569; }`;
    document.head.appendChild(style);
    this.searchInput.classList.add('bv-search');

    this.searchInput.addEventListener('input', () => {
      const q = this.searchInput.value;
      this.searchCb?.(q);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.searchInput.value = '';
        this.searchCb?.('');
      }
    });
    searchWrap.appendChild(this.searchInput);

    this.searchCountEl = el('span', {
      color: '#38bdf8', fontSize: '12px', flexShrink: '0',
      minWidth: '48px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
    });
    this.searchCountEl.textContent = '';
    searchWrap.appendChild(this.searchCountEl);

    this.dashOverlay.appendChild(searchWrap);

    // ── Loading Overlay ──────────────────────────────────
    this.loadingOverlay = el('div', {
      position: 'absolute', inset: '0',
      background: 'rgba(6, 10, 16, 0.94)',
      backdropFilter: 'blur(16px)',
      display: 'none', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      zIndex: '100', pointerEvents: 'auto',
      transition: 'opacity 0.25s ease',
      color: '#f8fafc',
    });

    const spinner = el('div', {
      width: '50px', height: '50px',
      border: '3px solid rgba(56,189,248,0.15)',
      borderTopColor: '#38bdf8',
      borderRadius: '50%',
      animation: 'bv-spin 0.8s linear infinite',
      marginBottom: '18px',
    });

    this.loadingTitleEl = el('div', {
      color: '#f8fafc', fontSize: '18px', fontWeight: '700',
      marginBottom: '6px', textAlign: 'center', letterSpacing: '-0.02em',
    });
    this.loadingTitleEl.textContent = '🏢 Carregando seu Prédio 3D…';

    this.loadingSubEl = el('div', {
      color: '#94a3b8', fontSize: '13px', textAlign: 'center',
    });
    this.loadingSubEl.textContent = 'Sincronizando andares e projetos…';

    this.loadingOverlay.appendChild(spinner);
    this.loadingOverlay.appendChild(this.loadingTitleEl);
    this.loadingOverlay.appendChild(this.loadingSubEl);
    this.container.appendChild(this.loadingOverlay);
  }

  // ── PR4.12: Métodos de Perfil e Loading ────────────────────────────────

  onProfileClick(cb: () => void): void {
    this.profileCb = cb;
  }

  showLoading(title?: string, sub?: string): void {
    if (this.loadingTitleEl && title) this.loadingTitleEl.textContent = title;
    if (this.loadingSubEl && sub) this.loadingSubEl.textContent = sub;
    if (this.loadingOverlay) {
      this.loadingOverlay.style.display = 'flex';
      this.loadingOverlay.style.opacity = '1';
    }
  }

  hideLoading(): void {
    if (!this.loadingOverlay) return;
    this.loadingOverlay.style.opacity = '0';
    setTimeout(() => {
      if (this.loadingOverlay) this.loadingOverlay.style.display = 'none';
    }, 250);
  }

  setUserProfile(profile: { name: string; email?: string; photo?: string | null; isAuth: boolean }): void {
    if (!this.profileBtn) return;
    if (profile.photo) {
      this.profileAvatarEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = profile.photo;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.borderRadius = '50%';
      img.style.objectFit = 'cover';
      this.profileAvatarEl.appendChild(img);
    } else {
      this.profileAvatarEl.innerHTML = '';
      const initials = profile.name
        .split(' ')
        .filter(Boolean)
        .map((s) => s[0])
        .slice(0, 2)
        .join('')
        .toUpperCase() || 'U';
      this.profileAvatarEl.textContent = profile.isAuth ? initials : '👤';
    }
    this.profileNameEl.textContent = profile.name || (profile.isAuth ? 'Usuário' : 'Entrar / Perfil');
    this.profileStatusDot.style.background = profile.isAuth ? '#10b981' : '#64748b';
    this.profileStatusText.textContent = profile.isAuth ? (profile.email || 'Conectado') : 'Conectar';
  }

  // ── Eventos ───────────────────────────────────────────────────────────

  private _bindEvents(): void {
    const cvs = this.renderer.domElement;
    cvs.style.cursor = 'grab';

    let downPos = { x: 0, y: 0 };
    let hasDragged = false;
    // PR mobile — apontador ativo (mouse OU dedo). Só um por vez: o segundo
    // dedo é ignorado (sem pinch na vista do prédio).
    let activePointer: number | null = null;

    // PR mobile — POINTER events em vez de mouse*: no toque o navegador não
    // sintetiza mousemove durante o arrasto, então a órbita da câmera do
    // prédio era inalcançável no celular ("não dá pra movimentar").
    cvs.addEventListener('pointerdown', (e) => {
      if (activePointer !== null) return;
      activePointer = e.pointerId;
      this.drag = { down: true, lx: e.clientX, ly: e.clientY };
      downPos = { x: e.clientX, y: e.clientY };
      hasDragged = false;
      cvs.style.cursor = 'grabbing';
      // Captura o apontador: o arrasto continua mesmo saindo do canvas
      // (dedo acelerado/fora da tela) e o pointerup chega sempre aqui.
      try {
        cvs.setPointerCapture(e.pointerId);
      } catch {
        /* nem todo navegador permite — o window listener abaixo cobre */
      }
    });

    const endDrag = (e: PointerEvent): void => {
      if (activePointer !== e.pointerId) return;
      activePointer = null;
      this.drag.down = false;
      cvs.style.cursor = this.hoveredId ? 'pointer' : 'grab';
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    cvs.addEventListener('pointermove', (e) => {
      if (this.drag.down) {
        if (e.pointerId !== activePointer) return;
        const x = e.clientX, y = e.clientY;
        const dx = x - this.drag.lx;
        const dy = y - this.drag.ly;
        if (Math.hypot(x - downPos.x, y - downPos.y) > 4) {
          hasDragged = true;
          this.tooltip.style.display = 'none';
        }
        this.drag.lx = x; this.drag.ly = y;
        this.cam.theta -= dx * 0.005;
        this.cam.phi = Math.max(0.15, Math.min(Math.PI - 0.15, this.cam.phi - dy * 0.005));
      } else if (e.pointerType === 'mouse') {
        // Hover/tooltip só para mouse: em toque não existe hover e o tooltip
        // ficaria preso na tela durante o gesto.
        this._handleHover(e.clientX, e.clientY, cvs);
      }
    });

    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.max(30, Math.min(300, this.cam.dist + e.deltaY * 0.1));
    }, { passive: false });

    cvs.addEventListener('click', (e) => {
      if (hasDragged) return;
      const { clientX: x, clientY: y } = e;
      const rect = cvs.getBoundingClientRect();
      const mx = ((x - rect.left) / rect.width)  * 2 - 1;
      const my = ((y - rect.top)  / rect.height) * -2 + 1;

      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
      const hits = ray.intersectObjects(this.clickableObjects, true);

      if (hits.length > 0) {
        const hit = hits[0].object;
        const boxId = hit.userData['boxId'] as string | undefined;
        if (boxId && boxId !== '__empty__') {
          this.selectedId = boxId;
          this._highlightSelected();
          this.clickCb?.(boxId);
        }
      }
    });

    window.addEventListener('resize', () => {
      const nw = this.container.clientWidth  || window.innerWidth;
      const nh = this.container.clientHeight || window.innerHeight;
      this.camera.aspect = nw / nh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(nw, nh);
    });
  }

  // ── Hover ─────────────────────────────────────────────────────────────

  private _handleHover(x: number, y: number, cvs: HTMLCanvasElement): void {
    const rect = cvs.getBoundingClientRect();
    const mx = ((x - rect.left) / rect.width)  * 2 - 1;
    const my = ((y - rect.top)  / rect.height) * -2 + 1;

    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const hits = ray.intersectObjects(this.clickableObjects, true);

    if (hits.length > 0) {
      const hit   = hits[0].object;
      const boxId = hit.userData['boxId']   as string | undefined;
      const name  = hit.userData['boxName'] as string | undefined;
      const num   = hit.userData['floorNum'] as number | undefined;
      if (boxId && boxId !== '__empty__') {
        this.hoveredId = boxId;
        cvs.style.cursor = 'pointer';
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top  = `${y}px`;
        this.tooltip.textContent = `F${num ?? 1} · ${name ?? 'Caixa'}`;
        return;
      }
    }
    this.hoveredId = null;
    cvs.style.cursor = 'grab';
    this.tooltip.style.display = 'none';
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  private _tick(): void {
    this.raf = requestAnimationFrame(() => this._tick());

    // Fade
    if (this.fadeDir !== 0) {
      this.fadeAlpha = Math.max(0, Math.min(1, this.fadeAlpha + this.fadeDir * 0.05));
      this.container.style.opacity = String(this.fadeAlpha);
      if (this.fadeAlpha <= 0 && this.fadeDir < 0) {
        this.fadeDir = 0;
        this.container.style.pointerEvents = 'none';
        this.tooltip.style.display = 'none';
        this.fadeCb?.(); this.fadeCb = null;
      } else if (this.fadeAlpha >= 1 && this.fadeDir > 0) {
        this.fadeDir = 0;
        this.container.style.pointerEvents = 'auto';
        this.fadeCb?.(); this.fadeCb = null;
      }
    }

    // Câmera
    const c = this.cam;
    this.camera.position.set(
      c.dist * Math.sin(c.phi) * Math.cos(c.theta),
      c.dist * Math.cos(c.phi) + c.ty,
      c.dist * Math.sin(c.phi) * Math.sin(c.theta),
    );
    this.camera.lookAt(0, c.ty, 0);
    this.renderer.render(this.scene, this.camera);

    // Atualiza posição dos dots de busca
    this._updateDots();
  }

  // ── Dots de busca ─────────────────────────────────────────────────────

  private _updateDots(): void {
    if (this.dotEls.length === 0) return;
    const w = this.container.clientWidth  || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    for (const { el: dotEl, floorY } of this.dotEls) {
      // Projeta o ponto 3D (centro do andar) para 2D
      const v = new THREE.Vector3(0, floorY, 0);
      v.project(this.camera);
      const sx = ((v.x + 1) / 2) * w;
      const sy = ((-v.y + 1) / 2) * h;
      dotEl.style.left = `${sx - 6}px`;
      dotEl.style.top  = `${sy - 6}px`;
      dotEl.style.display = (v.z < 1) ? 'flex' : 'none';
    }
  }

  // ── SetBoxes ──────────────────────────────────────────────────────────

  setBoxes(boxes: BoxEntityData[]): void {
    this.rawBoxes = [...boxes];
    this._rebuild();
  }

  /**
   * PR4.16 — filtro ⭐: quando ligado, SÓ os andares marcados com estrela
   * aparecem (na lista E na pilha 3D). Com zero favoritos o prédio fica vazio
   * e a lista explica por quê — o usuário desliga o filtro pelo mesmo botão.
   */
  setFavoriteFilter(on: boolean): void {
    if (this.favoriteFilterOn === on) return;
    this.favoriteFilterOn = on;
    this._rebuild();
  }

  isFavoriteFilterOn(): boolean {
    return this.favoriteFilterOn;
  }

  /** Caixas que devem aparecer respeitando o filtro ⭐. */
  private _visibleBoxes(): BoxEntityData[] {
    if (!this.favoriteFilterOn) return this.rawBoxes;
    return this.rawBoxes.filter((b) => b.isFavorite === true);
  }

  private _rebuild(): void {
    while (this.group.children.length > 0) {
      const c = this.group.children[0];
      if ('geometry' in c && (c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
      if ('material' in c) {
        const m = (c as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach(mat => mat.dispose());
        else if (m) (m as THREE.Material).dispose();
      }
      this.group.remove(c);
    }

    this.floors = [];
    this.clickableObjects = [];

    const visible = this._visibleBoxes();
    // Placeholder "Caixa Comum" só quando NÃO há caixas de verdade. Com o
    // filtro ⭐ ligado sem favoritos a cena fica vazia de propósito (senão o
    // usuário veria justamente os andares que pediu para esconder).
    const items =
      visible.length > 0
        ? visible
        : this.rawBoxes.length === 0
          ? [{ id: '__empty__', name: 'Caixa Comum', type: 'comum' as BoxType, pos: { x: 0, z: 0 }, halfSize: 40, wallHeight: 20, wallThickness: 2 }]
          : [];

    const geo = new THREE.BoxGeometry(FLOOR_WIDTH, FLOOR_HEIGHT - FLOOR_GAP, FLOOR_DEPTH);

    let y = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = this.selectedId === item.id;
      const hasSelection = this.selectedId !== null;
      const baseColor = FLOOR_COLOR[item.type] ?? FLOOR_COLOR.comum;
      const color = isSel ? new THREE.Color(baseColor).multiplyScalar(1.5) : new THREE.Color(baseColor);
      const opacity = isSel ? SELECTED_OPACITY : hasSelection ? DIM_OPACITY : DEFAULT_OPACITY;

      const mat = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity,
        emissive: new THREE.Color(0x000000),
        depthWrite: !hasSelection || isSel,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, y + (FLOOR_HEIGHT - FLOOR_GAP) / 2, 0);
      mesh.userData = { boxId: item.id, boxName: item.name, floorNum: i + 1, boxType: item.type };

      const edgeMat = new THREE.LineBasicMaterial({
        color: isSel ? 0xffffff : baseColor,
        transparent: true, opacity: isSel ? 1 : 0.45,
      });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edges.position.copy(mesh.position);

      this.group.add(mesh, edges);
      this.clickableObjects.push(mesh);

      const sprite = this._createLabelSprite(i + 1, item.name, item.id, isSel);
      sprite.position.set(-FLOOR_WIDTH / 2 - 3.5, mesh.position.y, 0);
      sprite.userData = { boxId: item.id, boxName: item.name, floorNum: i + 1 };
      this.group.add(sprite);
      this.clickableObjects.push(sprite);

      this.floors.push({ id: item.id, mesh, edges, sprite });
      y += FLOOR_HEIGHT;
    }

    const totalH = Math.max(1, items.length) * FLOOR_HEIGHT;
    this.cam.ty   = totalH / 2;
    this.cam.dist = Math.max(48, Math.min(160, totalH * 2.6 + 36));
    this.cam.theta = 2.35;
    this.cam.phi   = 1.15;

    // Atualiza painel direito
    this._updateFloorList();
  }

  // ── Sprite de rótulo ──────────────────────────────────────────────────

  private _createLabelSprite(floor: number, name: string, _id: string, isSel: boolean): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = isSel ? 'rgba(232,115,58,0.95)' : 'rgba(15,23,42,0.88)';
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(99,179,237,0.55)';
    ctx.lineWidth = 2;
    const r = 8;
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 56, r);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const text = `F${floor} · ${name || `Caixa ${floor}`}`;
    ctx.fillText(text.length > 38 ? text.slice(0, 36) + '…' : text, 18, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 999;
    sprite.scale.set(22, 2.75, 1);
    return sprite;
  }

  // ── Highlight ─────────────────────────────────────────────────────────

  private _highlightSelected(): void {
    for (const f of this.floors) {
      const isSel = f.id === this.selectedId;
      const mat = f.mesh.material as THREE.MeshPhongMaterial;
      const type = (f.mesh.userData['boxType'] as BoxType) ?? 'comum';
      const baseColor = FLOOR_COLOR[type] ?? FLOOR_COLOR.comum;
      mat.color.set(baseColor).multiplyScalar(isSel ? 1.5 : 1);
      mat.opacity = isSel ? SELECTED_OPACITY : this.selectedId ? DIM_OPACITY : DEFAULT_OPACITY;
    }
  }

  // ── Painel direito: lista de andares ──────────────────────────────────

  private _updateFloorList(): void {
    if (!this.floorListEl) return;
    this.floorListEl.innerHTML = '';

    const items = this._visibleBoxes();

    // Filtro ⭐ ligado sem nenhum favorito: explica em vez de listar nada.
    if (this.favoriteFilterOn && items.length === 0) {
      const hint = el('div', {
        color: '#94a3b8', fontSize: '12px', lineHeight: '1.5',
        padding: '10px 6px', textAlign: 'center',
      });
      hint.textContent = t('ui.favoritesEmpty');
      this.floorListEl.appendChild(hint);
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const box = items[i];
      // F1/F2… = posição na lista VISÍVEL (a mesma que a pilha 3D desenha
      // com o filtro ⭐ ligado) — lista e cena precisam bater para o clique.
      const stats = this.statsData?.boxes.find(s => s.boxId === box.id);
      const matchCount = this.searchMatches.filter(m => m.boxId === box.id).length;
      const hasMatch = matchCount > 0;
      const isFav = box.isFavorite === true;

      const row = el('div', {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '7px 10px', borderRadius: '8px', cursor: 'pointer',
        background: hasMatch
          ? 'rgba(56,189,248,0.12)'
          : 'rgba(255,255,255,0.03)',
        border: hasMatch
          ? '1px solid rgba(56,189,248,0.4)'
          : '1px solid transparent',
        transition: 'all 0.2s',
        boxShadow: hasMatch ? '0 0 12px rgba(56,189,248,0.25)' : 'none',
      });
      row.classList.add('bv-floor-row'); // alvo dos testes E2E (PR4.16)
      row.style.pointerEvents = 'auto';

      // Badge de andar
      const badge = el('div', {
        background: `#${FLOOR_COLOR[box.type ?? 'comum'].toString(16).padStart(6, '0')}`,
        color: '#fff', borderRadius: '5px',
        padding: '2px 6px', fontSize: '10px', fontWeight: '700',
        flexShrink: '0',
      });
      badge.textContent = `F${i + 1}`;

      const nameEl = el('div', {
        color: '#e2e8f0', fontSize: '12px', flex: '1',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      nameEl.textContent = box.name;

      const info = el('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' });
      if (stats) {
        const tot = el('div', { color: '#94a3b8', fontSize: '10px' });
        tot.textContent = `${stats.notes + stats.photos + stats.documents + stats.others} itens`;
        info.appendChild(tot);
      }
      if (hasMatch) {
        const mc = el('div', { color: '#38bdf8', fontSize: '10px', fontWeight: '700' });
        mc.textContent = `${matchCount} 🔍`;
        info.appendChild(mc);
      }

      // Estrela de favorito
      const favBtn = el('button', {
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: isFav ? '#fbbf24' : '#64748b', fontSize: '16px',
        transition: 'color 0.2s, transform 0.1s',
      });
      favBtn.classList.add('floor-fav-btn');
      favBtn.innerHTML = isFav ? '★' : '☆';
      favBtn.title = isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos';
      favBtn.style.pointerEvents = 'auto';
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.favoriteCb?.(box.id, !isFav);
      });
      favBtn.addEventListener('mouseenter', () => { favBtn.style.transform = 'scale(1.2)'; });
      favBtn.addEventListener('mouseleave', () => { favBtn.style.transform = 'scale(1)'; });

      row.appendChild(badge); row.appendChild(nameEl); row.appendChild(info); row.appendChild(favBtn);

      row.addEventListener('click', () => {
        this.selectedId = box.id;
        this._highlightSelected();
        this.clickCb?.(box.id);
      });
      row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.07)'; });
      row.addEventListener('mouseleave', () => {
        row.style.background = hasMatch ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.03)';
      });

      this.floorListEl.appendChild(row);
    }
  }

  // ── API pública: Stats ─────────────────────────────────────────────────

  setStats(data: BuildingStatsData): void {
    this.statsData = data;

    // Totais
    const totalBoxes = this.rawBoxes.length;
    let notes = 0, photos = 0, docs = 0, others = 0;
    for (const b of data.boxes) {
      notes  += b.notes;
      photos += b.photos;
      docs   += b.documents;
      others += b.others;
    }
    const total = notes + photos + docs + others;

    if (this.statBoxes)  this.statBoxes.textContent  = String(totalBoxes);
    if (this.statTotal)  this.statTotal.textContent   = String(total);
    if (this.statNotes)  this.statNotes.textContent   = String(notes);
    if (this.statPhotos) this.statPhotos.textContent  = String(photos);
    if (this.statDocs)   this.statDocs.textContent    = String(docs);

    // Donut
    drawDonut(this.donutCanvas, [
      { value: notes,  color: '#fbbf24' },
      { value: photos, color: '#34d399' },
      { value: docs,   color: '#f87171' },
      { value: others, color: '#475569' },
    ]);

    // Barras por andar (ref direta: o painel pode estar fora do dashOverlay)
    const barsWrap = this.barsWrap;
    if (barsWrap) {
      barsWrap.innerHTML = '';
      const maxItems = Math.max(1, ...data.boxes.map(b => b.notes + b.photos + b.documents + b.others));
      for (let i = 0; i < this.rawBoxes.length; i++) {
        const box = this.rawBoxes[i];
        const st = data.boxes.find(s => s.boxId === box.id);
        const cnt = st ? st.notes + st.photos + st.documents + st.others : 0;
        const pct = (cnt / maxItems) * 100;

        const row = el('div', { display: 'flex', alignItems: 'center', gap: '6px' });
        const lbl = el('div', { color: '#64748b', fontSize: '10px', width: '28px', textAlign: 'right', flexShrink: '0' });
        lbl.textContent = `F${i + 1}`;
        const track = el('div', { flex: '1', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' });
        const fill  = el('div', {
          height: '100%', borderRadius: '3px',
          background: `#${FLOOR_COLOR[box.type ?? 'comum'].toString(16).padStart(6, '0')}`,
          width: `${pct}%`, transition: 'width 0.5s ease',
        });
        const cnt2 = el('div', { color: '#64748b', fontSize: '10px', width: '20px', flexShrink: '0' });
        cnt2.textContent = String(cnt);
        track.appendChild(fill);
        row.appendChild(lbl); row.appendChild(track); row.appendChild(cnt2);
        barsWrap.appendChild(row);
      }
    }

    // Atualiza lista de andares com contagens
    this._updateFloorList();
  }

  // ── API pública: Busca / matches ───────────────────────────────────────

  setSearchMatches(matches: SearchMatch[], query: string): void {
    this.searchMatches = matches;

    // Glow nos andares com matches via emissive
    for (const f of this.floors) {
      const mat = f.mesh.material as THREE.MeshPhongMaterial;
      const hasMatch = matches.some(m => m.boxId === f.id);
      if (query && hasMatch) {
        mat.emissive.setHex(0x1e4a6e);
        mat.emissiveIntensity = 1;
        // Aumenta opacidade do andar com match
        const isSel = f.id === this.selectedId;
        mat.opacity = isSel ? SELECTED_OPACITY : 0.75;
      } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        const isSel = f.id === this.selectedId;
        mat.opacity = isSel ? SELECTED_OPACITY : this.selectedId ? DIM_OPACITY : DEFAULT_OPACITY;
      }
    }

    // Remove dots anteriores
    this._clearDots();

    // Cria dots para cada match
    if (query && matches.length > 0) {
      for (const match of matches) {
        const floorIdx = this.rawBoxes.findIndex(b => b.id === match.boxId);
        if (floorIdx < 0) continue;
        // Y center do andar
        const floorY = floorIdx * FLOOR_HEIGHT + (FLOOR_HEIGHT - FLOOR_GAP) / 2;
        this._createDot(match, floorY);
      }
    }

    // Atualiza contagem
    if (query) {
      this.searchCountEl.textContent = `${matches.length} resultado${matches.length !== 1 ? 's' : ''}`;
    } else {
      this.searchCountEl.textContent = '';
    }

    // Atualiza lista (glow no painel direito)
    this._updateFloorList();
  }

  private _createDot(match: SearchMatch, floorY: number): void {
    const dot = el('div', {
      position: 'absolute', width: '12px', height: '12px',
      borderRadius: '50%', background: '#38bdf8',
      boxShadow: '0 0 8px 3px rgba(56,189,248,0.7)',
      cursor: 'pointer', pointerEvents: 'auto',
      zIndex: '56', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontSize: '7px', color: '#fff', fontWeight: '700',
      transition: 'transform 0.15s',
    });
    dot.textContent = '●';
    dot.title = match.label || 'Nota';

    dot.addEventListener('mouseenter', () => { dot.style.transform = 'scale(1.5)'; });
    dot.addEventListener('mouseleave', () => { dot.style.transform = 'scale(1)'; });
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      this.itemClickCb?.(match.itemId, match.boxId);
    });

    this.dotsLayer.appendChild(dot);
    this.dotEls.push({ el: dot, match, floorY });
  }

  private _clearDots(): void {
    for (const { el: d } of this.dotEls) d.remove();
    this.dotEls = [];
  }

  // ── API pública: Visibilidade / callbacks ─────────────────────────────

  show(cb?: () => void): void {
    if (this.visible) { cb?.(); return; }
    this.visible  = true;
    this.fadeDir  = 1;
    this.fadeCb   = cb ?? null;
    // No prédio os dois painéis nascem abertos (comportamento original)
    this.summaryOpen = true;
    this.floorsOpen  = true;
    this._applyPanels();
  }

  hide(cb?: () => void): void {
    if (!this.visible) { cb?.(); return; }
    this.visible  = false;
    this.fadeDir  = -1;
    this.fadeCb   = cb ?? null;
    // Saindo do prédio os painéis voltam pro host e fecham (cena limpa nas
    // caixas) — reabrem pelos ícones do HUD. Se já estamos nas caixas, o
    // early-return acima preserva o que o usuário abriu (navegação entre
    // andares não fecha o menu).
    this.summaryOpen = false;
    this.floorsOpen  = false;
    this._applyPanels();
  }

  isVisible(): boolean { return this.visible; }

  /**
   * PR4.16 — fecha os painéis (Andares/Resumo) sem depender do estado do
   * prédio. Usado no logout: `hide()` tem early-return quando já estamos
   * "nas caixas", e aí os painéis ficariam abertos por cima do muro.
   */
  closePanels(): void {
    this.summaryOpen = false;
    this.floorsOpen  = false;
    this._applyPanels();
  }

  // ── PR4.13 — Painéis Resumo/Andares no prédio E nas caixas ─────────────

  /** Alterna um painel; retorna true se ele ficou aberto. */
  togglePanel(which: 'summary' | 'floors'): boolean {
    if (which === 'summary') this.summaryOpen = !this.summaryOpen;
    else this.floorsOpen = !this.floorsOpen;
    this._applyPanels();
    return which === 'summary' ? this.summaryOpen : this.floorsOpen;
  }

  isPanelOpen(which: 'summary' | 'floors'): boolean {
    return which === 'summary' ? this.summaryOpen : this.floorsOpen;
  }

  /** Sincroniza os ícones do HUD com o estado dos painéis. */
  onPanelsChange(cb: (floors: boolean, summary: boolean) => void): void {
    this.panelsChangeCb = cb;
  }

  // ── PR4.16 — painel de andares arrastável (dir. → esq.) e redimensionável

  /**
   * Arrasta o painel pelo cabeçalho. No PRIMEIRO movimento converte o
   * âncora `right` em `left` (o painel nasce colado à direita) e daí em
   * diante só o `left` muda — o usuário puxa da direita p/ a esquerda e
   * solta onde consegue ler. Limite: sempre dentro da janela.
   */
  private _makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startLeft = 0;

    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      // Converte right → left no primeiro arrasto
      if (startLeft === 0) {
        startLeft = rect.left;
        startX = e.clientX;
        panel.style.left = `${rect.left}px`;
        panel.style.right = 'auto';
        return;
      }
      const maxLeft = window.innerWidth - rect.width - 8;
      const next = Math.min(Math.max(startLeft + (e.clientX - startX), 8), Math.max(8, maxLeft));
      panel.style.left = `${next}px`;
    };

    const onUp = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        // pointer já solto — nada a fazer
      }
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      dragging = true;
      startX = e.clientX;
      startLeft = 0; // 0 = ainda não converteu a âncora
      handle.style.cursor = 'grabbing';
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation(); // não inicia o arrasto da câmera da cena
    });
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /**
   * Alça de redimensionar na borda ESQUERDA do painel: mantém a borda direita
   * ancorada e arrastar p/ a esquerda alarga (texto deixa de ser cortado),
   * arrastar de volta p/ a direita estreita.
   * No celular o CSS trava left/right/width com !important → no-op.
   */
  private _makeResizable(panel: HTMLElement): void {
    const grip = el('div', {
      position: 'absolute', left: '0', top: '0', bottom: '0',
      width: '12px', cursor: 'ew-resize', touchAction: 'none',
      borderRadius: '14px 0 0 14px', zIndex: '3',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    const gripBar = el('div', {
      width: '3px', height: '36px', borderRadius: '3px',
      background: 'rgba(56, 189, 248, 0.25)',
      transition: 'background 0.15s, height 0.15s',
      pointerEvents: 'none',
    });
    grip.appendChild(gripBar);
    grip.title = t('ui.floorsResizeHint');
    panel.appendChild(grip);

    let resizing = false;
    let startX = 0;
    let startW = 0;
    let anchorRight = 16;

    grip.addEventListener('pointerenter', () => {
      gripBar.style.background = 'rgba(56, 189, 248, 0.75)';
      gripBar.style.height = '48px';
    });
    grip.addEventListener('pointerleave', () => {
      if (!resizing) {
        gripBar.style.background = 'rgba(56, 189, 248, 0.25)';
        gripBar.style.height = '36px';
      }
    });

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const rect = panel.getBoundingClientRect();
      resizing = true;
      startX = e.clientX;
      startW = rect.width;
      anchorRight = Math.max(8, window.innerWidth - rect.right);
      panel.style.right = `${anchorRight}px`;
      panel.style.left = 'auto';
      gripBar.style.background = '#38bdf8';
      gripBar.style.height = '56px';
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const maxW = Math.min(680, Math.max(240, window.innerWidth - anchorRight - 12));
      const next = Math.min(Math.max(startW + (startX - e.clientX), 200), maxW);
      panel.style.width = `${next}px`;
    });
    const stop = (e: PointerEvent): void => {
      if (!resizing) return;
      resizing = false;
      gripBar.style.background = 'rgba(56, 189, 248, 0.25)';
      gripBar.style.height = '36px';
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        // pointer já solto
      }
    };
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }

  /**
   * Coloca cada painel no lugar certo: no prédio vivem no dashboard; nas
   * caixas (container com fade/opacity 0) vão para o host flutuante, fora do
   * fade, para continuarem visíveis e clicáveis sobre a cena.
   */
  private _applyPanels(): void {
    if (!this.boxPanelHost || !this.dashOverlay) return;
    const inBox = !this.visible;
    const place = (panel: HTMLElement, open: boolean): void => {
      panel.style.display = open ? '' : 'none';
      const target = inBox && open ? this.boxPanelHost : this.dashOverlay;
      if (panel.parentElement !== target) target.appendChild(panel);
    };
    place(this.summaryPanel, this.summaryOpen);
    place(this.floorsPanel, this.floorsOpen);
    // Nas caixas não existe o botão de perfil no canto → o painel de andares
    // pode subir para o topo; no prédio ele fica abaixo do perfil (74px).
    this.floorsPanel.style.top = inBox ? '16px' : '74px';
    this.panelsChangeCb?.(this.floorsOpen, this.summaryOpen);
  }

  onFloorClick(cb: FloorClickCallback):    void { this.clickCb     = cb; }
  onItemDotClick(cb: ItemClickCallback):   void { this.itemClickCb = cb; }
  onSearch(cb: SearchQueryCallback):        void { this.searchCb    = cb; }
  onFloorFavorite(cb: FavoriteCallback):    void { this.favoriteCb   = cb; }

  selectFloor(id: string | null): void {
    this.selectedId = id;
    this._highlightSelected();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.container.remove();
    this.boxPanelHost.remove();
  }
}
