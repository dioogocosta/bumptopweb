/**
 * Adapter de overlay — DOM puro (menu de contexto, toasts, labels).
 * Espelha o `BT_OverlayComponent` do original: UI 2D sobre o mundo 3D.
 * Usa DOM direto p/ M0; pode migrar p/ Preact quando a UI crescer.
 */
import { t } from '@core/i18n/i18n';
import { THEMES } from '@core/theme/theme';
import { NOTE_COLORS, computeReminder, noteTextToHtml } from '@core/util/notes';
import {
  fetchTaigaProjects,
  pickMyProjects,
  getTaigaToken,
  setTaigaToken,
  fetchTaigaMe,
  loginTaiga,
  TaigaError,
  fetchTaigaSprints,
  resolveProjectId,
  type TaigaStoryDetail,
  type TaigaProject,
  type TaigaSprint,
} from '@taiga/taiga';
import type {
  ContextMenuItem,
  DwellRingData,
  IOverlay,
  LassoData,
  PileHaloData,
  ScrubStripData,
} from '@core/ports/index';

// -------------------------------------------------------------------------
// PR16 — colar com formatação: HTML da área de transferência → markdown-lite
// -------------------------------------------------------------------------
type MdStyles = { b: boolean; i: boolean; u: boolean; s: boolean };

const MD_BLOCK_TAGS = new Set([
  'DIV', 'P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
]);
const MD_SKIP_TAGS = new Set(['STYLE', 'SCRIPT', 'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME']);

/** Estilos inline suportados pelo markdown-lite das notas. */
const mdInlineStyle = (tag: string, st: MdStyles): MdStyles | null => {
  const s2: MdStyles = { ...st };
  if (tag === 'B' || tag === 'STRONG') s2.b = true;
  else if (tag === 'I' || tag === 'EM') s2.i = true;
  else if (tag === 'U' || tag === 'INS') s2.u = true;
  else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s2.s = true;
  else return null;
  return s2;
};

/**
 * PR16 — converte HTML colado (ex.: Google Keep, Gmail, Word) nos blocos do
 * editor rico: UM `nl-line` por parágrafo/`<br>`, negrito/itálico/sublinhado/
 * riscado viram os marcadores `**`/`*`/`__`/`~~`; links e demais elementos
 * contribuem só o texto. Sem isto, o colar nativo injeta o HTML cru dentro
 * de UMA linha e a serialização ignora as quebras — tudo gruda num blob.
 */
export function htmlToNoteMd(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  let cur = '';
  const flush = () => {
    lines.push(cur);
    cur = '';
  };
  // Espaços/quebras de texto corrido colapsam; quebras de BLOCO são reais
  const collapse = (s: string) => s.replace(/\s+/g, ' ');

  const walk = (n: Node, st: MdStyles): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      cur += collapse(n.textContent ?? '');
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    const tag = el.tagName;
    if (MD_SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      flush();
      return;
    }
    if (MD_BLOCK_TAGS.has(tag)) {
      // Bloco próprio: fecha a linha atual (se houver conteúdo), caminha os
      // filhos e fecha o bloco como linha própria (vazio = linha em branco)
      if (cur !== '') flush();
      el.childNodes.forEach((c) => walk(c, st));
      flush();
      return;
    }
    if (tag === 'A') {
      // Link: mantém o texto visível (o modelo de notas não tem âncoras)
      el.childNodes.forEach((c) => walk(c, st));
      return;
    }
    const st2 = mdInlineStyle(tag, st);
    if (st2) {
      const before = cur.length;
      el.childNodes.forEach((c) => walk(c, st2));
      const inner = cur.slice(before);
      if (inner.trim() !== '') {
        let wrapped = inner;
        if (st2.b && !st.b) wrapped = `**${wrapped}**`;
        if (st2.i && !st.i) wrapped = `*${wrapped}*`;
        if (st2.u && !st.u) wrapped = `__${wrapped}__`;
        if (st2.s && !st.s) wrapped = `~~${wrapped}~~`;
        cur = cur.slice(0, before) + wrapped;
      }
      return;
    }
    el.childNodes.forEach((c) => walk(c, st2 ?? st));
  };

  doc.body.childNodes.forEach((n) => walk(n, { b: false, i: false, u: false, s: false }));
  flush();
  return lines
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

export class DomOverlay implements IOverlay {
  private root: HTMLElement;
  /** PR4.13 — camada de labels/destaques ABAIXO do prédio 3D (z 2). */
  private underlay: HTMLDivElement;
  private menuEl: HTMLDivElement | null = null;
  private labels = new Map<string, HTMLDivElement>();
  private lassoEl: HTMLDivElement | null = null;
  private resizeEl: HTMLDivElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private resizeCb: ((e: PointerEvent) => void) | null = null;
  private haloEl: HTMLDivElement | null = null;
  /** PR15 — botão "Modo laço" (seleção múltipla no toque). */
  private lassoBtn: HTMLButtonElement | null = null;
  /** PR18 — busca nas notas: botão 🔍, barra e destaque por nota. */
  private searchBtn: HTMLButtonElement | null = null;
  private searchBar: HTMLDivElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchCount: HTMLSpanElement | null = null;
  private searchMarks = new Map<string, HTMLElement>();
  private haloHovered = false;
  private haloActionCb: ((pileId: string, action: string) => void) | null = null;
  private haloCurrentPileId: string | null = null;
  private dwellEl: HTMLDivElement | null = null;
  private dwellHovered = false;
  private scrubEl: HTMLDivElement | null = null;
  private scrubHovered = false;
  private scrubSelectCb: ((pileId: string, itemId: string) => void) | null = null;
  private scrubHoverCb: ((pileId: string, index: number) => void) | null = null;
  private scrubCurrentPileId: string | null = null;
  private previewEl: HTMLDivElement | null = null;
  private previewCleanup: (() => void) | null = null;
  /** PR9 — botão ✕ da pilha aberta em grade. */
  private pileCloseEl: HTMLButtonElement | null = null;
  private pileCloseCb: (() => void) | null = null;
  /** PR9 — modal de vidro com o conteúdo de uma pasta. */
  private folderEl: HTMLDivElement | null = null;
  private folderCleanup: (() => void) | null = null;

  /** PR11 — handle de rotação do selecionado (canto do bbox). */
  private rotateEl: HTMLDivElement | null = null;
  private rotateCb: ((e: PointerEvent) => void) | null = null;

  /** PR11 — barra deslizável de zoom na tela (topo). */
  private zoomSliderEl: HTMLInputElement | null = null;
  private zoomValueEl: HTMLElement | null = null;
  private zoomSliderCb: ((distance: number) => void) | null = null;
  /** PR27 — botão de conta + modal de login. */
  private authBtn: HTMLButtonElement | null = null;
  private authModal: HTMLElement | null = null;
  private authEmail: HTMLInputElement | null = null;
  private authPassword: HTMLInputElement | null = null;
  private authTitle: HTMLElement | null = null;
  private authError: HTMLElement | null = null;
  private authLogged: HTMLElement | null = null;
  private authForm: HTMLElement | null = null;
  private authSubmitBtn: HTMLButtonElement | null = null;
  private authSwitchBtn: HTMLButtonElement | null = null;
  private authMode: 'in' | 'up' = 'in';
  private authEmailWrap: HTMLElement | null = null;
  private authPassWrap: HTMLElement | null = null;

  /** PR4a (Control Manager) — engrenagem + painel de vidro com as CAIXAS. */
  private settingsBtn: HTMLButtonElement | null = null;
  private boxesModal: HTMLElement | null = null;
  private boxesList: HTMLElement | null = null;
  private boxesEmpty: HTMLElement | null = null;
  private boxesCleanup: (() => void) | null = null;
  /** PR4.2 — CRUD: dados do painel (p/ refiltrar/re-render) + campo busca. */
  private boxesData: Array<{ id: string; label: string; current?: boolean; type?: string }> = [];
  private boxesSearch: HTMLInputElement | null = null;
  /** PR4.3 — seletor de tipo da nova caixa (no cabeçalho). */
  private boxesType: HTMLSelectElement | null = null;
  /** PR4.5 — campo slug do projeto Taiga (aparece só quando o tipo = backlog). */
  private boxesProject: HTMLInputElement | null = null;
  /** PR4.9 — seletor de sprint ao criar caixa tipo sprint. */
  private boxesSprint: HTMLSelectElement | null = null;
  private cachedProjects: TaigaProject[] = [];

  /** PR4.4 — Building View: botão 🏢 e botão "Voltar ao Prédio". */
  private buildingBtn: HTMLButtonElement | null = null;
  private buildingBackBtn: HTMLButtonElement | null = null;

  /** PR4.13 — ícones que abrem/fecham os painéis Andares e Resumo. */
  private floorsBtn: HTMLButtonElement | null = null;
  /** PR4.16 — botão ⭐ do HUD: filtra o painel de andares p/ favoritos. */
  private favFilterBtn: HTMLButtonElement | null = null;
  private favFilterOn = false;
  /** PR4.16 — botão 🏠/🏢 do HUD: alterna a visão pessoal × trabalho. */
  private viewSwitchBtn: HTMLButtonElement | null = null;
  private viewMode: 'personal' | 'work' = 'personal';
  private statsBtn: HTMLButtonElement | null = null;

  /** PR4.15 — indicador e seletor da Sprint vinculada à caixa atual. */
  private sprintBadgeBtn: HTMLButtonElement | null = null;

  /** Menu de seleção de temas. */
  private themeBtn: HTMLButtonElement | null = null;
  private themeMenu: HTMLElement | null = null;
  private themeCleanup: (() => void) | null = null;
  private currentThemeName = 'BumpTop';

  constructor(root: HTMLElement) {
    this.root = root;
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '10';

    // PR4.13 — camada ABAIXO do prédio 3D (z 2): rótulos de objeto e
    // destaques de busca ficam atrás do canvas do prédio (como antes do PR44,
    // que montou o prédio em z 50), mas acima da cena das caixas (z auto).
    this.underlay = document.createElement('div');
    this.underlay.style.position = 'fixed';
    this.underlay.style.inset = '0';
    this.underlay.style.pointerEvents = 'none';
    this.underlay.style.zIndex = '2';
    (root.parentNode ?? document.body).appendChild(this.underlay);

    // PR11 — controles de zoom na tela (topo central)
    // PR16 — ícones em SVG (o emoji 🔍+ renderizava mal nos dispositivos)
    const zoomSvg = (plus: boolean): string =>
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<circle cx="10.5" cy="10.5" r="6.2" stroke="currentColor" stroke-width="2.3"/>` +
      `<line x1="15.2" y1="15.2" x2="20.4" y2="20.4" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>` +
      (plus
        ? `<line x1="7.8" y1="10.5" x2="13.2" y2="10.5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>` +
          `<line x1="10.5" y1="7.8" x2="10.5" y2="13.2" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>`
        : `<line x1="7.8" y1="10.5" x2="13.2" y2="10.5" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>`) +
      `</svg>`;
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'zoom-controls';

    // Barra deslizável de zoom: arrastar para ajustar distância da câmera.
    // Valor 50 = distância padrão (~210). Fórmula: dist = 460 - 4.36 * val
    const zoomSliderWrap = document.createElement('div');
    zoomSliderWrap.className = 'zoom-slider-wrap';
    zoomSliderWrap.title = t('ui.zoomSlider') ?? 'Zoom';

    const zoomIcon = document.createElement('span');
    zoomIcon.innerHTML = zoomSvg(false);
    zoomIcon.className = 'zoom-slider-icon';
    zoomSliderWrap.appendChild(zoomIcon);

    this.zoomSliderEl = document.createElement('input');
    this.zoomSliderEl.type = 'range';
    this.zoomSliderEl.className = 'zoom-slider';
    this.zoomSliderEl.min = '0';
    this.zoomSliderEl.max = '100';
    this.zoomSliderEl.value = '50';
    this.zoomSliderEl.step = '1';
    this.zoomSliderEl.setAttribute('aria-label', t('ui.zoomSlider') ?? 'Zoom');
    this.zoomSliderEl.addEventListener('input', () => {
      const val = Number(this.zoomSliderEl!.value);
      if (this.zoomValueEl) this.zoomValueEl.textContent = String(val);
      // val=0 → distância máx (longe); val=100 → distância mín (perto)
      const distance = Math.round(460 - 4.36 * val);
      this.zoomSliderCb?.(distance);
    });
    // Impede que o arraste do slider seja capturado como drag da cena
    this.zoomSliderEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    zoomSliderWrap.appendChild(this.zoomSliderEl);

    this.zoomValueEl = document.createElement('span');
    this.zoomValueEl.className = 'zoom-value';
    this.zoomValueEl.textContent = '50';
    zoomSliderWrap.appendChild(this.zoomValueEl);

    zoomWrap.appendChild(zoomSliderWrap);

    // Botão "Redefinir Câmera" como ícone
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'reset-cam-btn';
    resetBtn.title = t('ui.resetCamera');
    resetBtn.setAttribute('aria-label', t('ui.resetCamera'));
    resetBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<path d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5c-3.1 0-5.8 1.6-7.3 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `<path d="M3.5 3.5v4.5h4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
    resetBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('resetcamera', { bubbles: true }));
    });
    zoomWrap.appendChild(resetBtn);

    // Botão "Escolher Tema" como ícone
    this.themeBtn = document.createElement('button');
    this.themeBtn.type = 'button';
    this.themeBtn.className = 'theme-btn';
    this.themeBtn.title = t('ui.theme');
    this.themeBtn.setAttribute('aria-label', t('ui.theme'));
    this.themeBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<path d="M12 2.5C6.75 2.5 2.5 6.75 2.5 12s4.25 9.5 9.5 9.5c.8 0 1.45-.65 1.45-1.45 0-.37-.14-.7-.37-.96-.23-.25-.37-.58-.37-.94 0-.8.65-1.45 1.45-1.45H16c3.15 0 5.7-2.55 5.7-5.7 0-4.73-4.27-8.45-9.7-8.45z" stroke="currentColor" stroke-width="2"/>` +
      `<circle cx="7.5" cy="11.5" r="1.3" fill="currentColor"/>` +
      `<circle cx="10.5" cy="7.5" r="1.3" fill="currentColor"/>` +
      `<circle cx="14.5" cy="7.5" r="1.3" fill="currentColor"/>` +
      `<circle cx="17.5" cy="11.5" r="1.3" fill="currentColor"/>` +
      `</svg>`;
    this.themeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleThemeMenu();
    });
    zoomWrap.appendChild(this.themeBtn);

    // PR15 — botão "Modo laço": no TOQUE, arrastar o dedo no chão vazio
    // desenha o laço (seleção múltipla). Liga/desliga por aqui ou com um
    // toque parado no chão (o World avisa via onLassoModeChanged).
    this.lassoBtn = document.createElement('button');
    this.lassoBtn.type = 'button';
    this.lassoBtn.className = 'lasso-btn';
    this.lassoBtn.title = t('ui.lassoMode');
    this.lassoBtn.setAttribute('aria-label', t('ui.lassoMode'));
    // Ícone em SVG (PR16): o glifo ⬭ renderizava diferente entre plataformas
    this.lassoBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<ellipse cx="12" cy="9.5" rx="8" ry="5.5" stroke="currentColor" stroke-width="2"/>` +
      `<path d="M5.5 14.4c-1.7 1.6-2.7 3.5-3 5.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
      `</svg>`;
    this.lassoBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('lassomode', { bubbles: true }));
    });
    zoomWrap.appendChild(this.lassoBtn);

    // PR18 — botão de BUSCA nas notas: abre o campo de busca; os matches
    // ganham destaque na cena e a câmera "voa" de uma nota para a outra.
    this.searchBtn = document.createElement('button');
    this.searchBtn.type = 'button';
    this.searchBtn.className = 'search-btn';
    this.searchBtn.title = t('ui.searchNotes');
    this.searchBtn.setAttribute('aria-label', t('ui.searchNotes'));
    this.searchBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<circle cx="10.5" cy="10.5" r="6.2" stroke="currentColor" stroke-width="2.3"/>` +
      `<line x1="15.2" y1="15.2" x2="20.4" y2="20.4" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>` +
      `</svg>`;
    this.searchBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('searchtoggle', { bubbles: true }));
    });
    zoomWrap.appendChild(this.searchBtn);

    // PR4a (Control Manager) — ENGRENAGEM: abre o painel de vidro com a
    // lista de CAIXAS (pastas) da mesa; clicar numa caixa voa até ela.
    // (o CRUD completo entra no PR 4.2 — este PR é a porta de entrada)
    this.settingsBtn = document.createElement('button');
    this.settingsBtn.type = 'button';
    this.settingsBtn.className = 'settings-btn';
    this.settingsBtn.title = t('ui.boxes');
    this.settingsBtn.setAttribute('aria-label', t('ui.boxes'));
    this.settingsBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2.1"/>` +
      `<path d="M12 2.8v3.1M12 18.1v3.1M21.2 12h-3.1M5.9 12H2.8M18.4 5.6l-2.2 2.2M7.8 16.2l-2.2 2.2M18.4 18.4l-2.2-2.2M7.8 7.8L5.6 5.6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>` +
      `</svg>`;
    this.settingsBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('settingstoggle', { bubbles: true }));
    });
    zoomWrap.appendChild(this.settingsBtn);

    // PR27 — botão de CONTA (login com Cloudflare D1): abre o modal de
    // entrar/criar conta; logado, mostra o e-mail + "Sair".
    this.authBtn = document.createElement('button');
    this.authBtn.type = 'button';
    this.authBtn.className = 'auth-btn';
    this.authBtn.title = t('ui.auth');
    this.authBtn.setAttribute('aria-label', t('ui.auth'));
    this.authBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<circle cx="12" cy="8.2" r="3.6" stroke="currentColor" stroke-width="2.2"/>` +
      `<path d="M4.8 19.4c1.1-3.4 3.9-5.2 7.2-5.2s6.1 1.8 7.2 5.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `</svg>`;
    this.authBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('authtoggle', { bubbles: true }));
    });
    zoomWrap.appendChild(this.authBtn);

    // PR4.4 — botão 🏢 "Vista do Prédio"
    this.buildingBtn = document.createElement('button');
    this.buildingBtn.type = 'button';
    this.buildingBtn.className = 'building-btn';
    this.buildingBtn.title = t('ui.buildingView');
    this.buildingBtn.setAttribute('aria-label', t('ui.buildingView'));
    this.buildingBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<rect x="4" y="2" width="16" height="20" rx="1.5" stroke="currentColor" stroke-width="2"/>` +
      `<path d="M4 8h16M4 14h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
      `</svg>`;
    this.buildingBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('buildingtoggle', { bubbles: true }));
    });
    zoomWrap.appendChild(this.buildingBtn);

    // PR4.4 — botão "Voltar ao Prédio" como ícone
    this.buildingBackBtn = document.createElement('button');
    this.buildingBackBtn.type = 'button';
    this.buildingBackBtn.className = 'building-back-btn';
    this.buildingBackBtn.title = t('ui.buildingBack');
    this.buildingBackBtn.setAttribute('aria-label', t('ui.buildingBack'));
    this.buildingBackBtn.style.display = 'none';
    this.buildingBackBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<path d="M9 14l-4-4 4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M5 10h10a4 4 0 0 1 4 4v3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>` +
      `</svg>`;
    this.buildingBackBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('buildingback', { bubbles: true }));
    });
    zoomWrap.appendChild(this.buildingBackBtn);

    // PR4.13 — botão ☰ "Andares": abre/fecha a lista de andares p/ pular
    // rapidamente entre as caixas (funciona no prédio e no ambiente das caixas)
    this.floorsBtn = document.createElement('button');
    this.floorsBtn.type = 'button';
    this.floorsBtn.className = 'floors-btn';
    this.floorsBtn.title = t('ui.floorsPanel');
    this.floorsBtn.setAttribute('aria-label', t('ui.floorsPanel'));
    this.floorsBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<rect x="3.5" y="4.5" width="17" height="5" rx="1.4" stroke="currentColor" stroke-width="2"/>` +
      `<rect x="3.5" y="14.5" width="17" height="5" rx="1.4" stroke="currentColor" stroke-width="2"/>` +
      `</svg>`;
    this.floorsBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('floorspanel', { bubbles: true }));
    });
    zoomWrap.appendChild(this.floorsBtn);

    // PR4.13 — botão 📊 "Resumo": abre/fecha o painel de estatísticas
    this.statsBtn = document.createElement('button');
    this.statsBtn.type = 'button';
    this.statsBtn.className = 'stats-btn';
    this.statsBtn.title = t('ui.summaryPanel');
    this.statsBtn.setAttribute('aria-label', t('ui.summaryPanel'));
    this.statsBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">` +
      `<path d="M4.5 20V11.5M12 20V4.5M19.5 20v-6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>` +
      `</svg>`;
    this.statsBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('statspanel', { bubbles: true }));
    });
    zoomWrap.appendChild(this.statsBtn);

    // PR4.15 — botão/badge de Sprint da caixa atual (visível nas caixas sprint/kanban)
    this.sprintBadgeBtn = document.createElement('button');
    this.sprintBadgeBtn.type = 'button';
    this.sprintBadgeBtn.className = 'sprint-badge-btn';
    this.sprintBadgeBtn.title = t('ui.sprintBadgeTitle');
    this.sprintBadgeBtn.setAttribute('aria-label', t('ui.sprintBadgeTitle'));
    this.sprintBadgeBtn.style.display = 'none';
    this.sprintBadgeBtn.innerHTML =
      `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">` +
      `<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>` +
      `<span class="sprint-badge-label">Sprint</span>` +
      `<span class="sprint-badge-arrow">▾</span>`;
    this.sprintBadgeBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('sprintpick', { bubbles: true }));
    });
    zoomWrap.appendChild(this.sprintBadgeBtn);

    // PR4.16 — botão ⭐ "Só favoritos": filtra o painel de andares para
    // mostrar apenas os projetos marcados com estrela. Aceso = filtrando.
    this.favFilterBtn = document.createElement('button');
    this.favFilterBtn.type = 'button';
    this.favFilterBtn.className = 'fav-filter-btn';
    this.favFilterBtn.title = t('ui.favoritesFilter');
    this.favFilterBtn.setAttribute('aria-label', t('ui.favoritesFilter'));
    this.favFilterBtn.setAttribute('aria-pressed', 'false');
    this.favFilterBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 8.8l6.5-.9z"/></svg>`;
    this.favFilterBtn.addEventListener('click', () => {
      const on = !this.favFilterOn;
      this.setFavoriteFilterActive(on);
      this.root.dispatchEvent(new CustomEvent('favoritefilter', { detail: { on }, bubbles: true }));
    });
    zoomWrap.appendChild(this.favFilterBtn);

    // PR4.16 — botão de VISÃO: alterna Prédio 1 (dados pessoais) × Prédio 2
    // (projetos do Taiga). Só aparece quando o Taiga está conectado.
    this.viewSwitchBtn = document.createElement('button');
    this.viewSwitchBtn.type = 'button';
    this.viewSwitchBtn.className = 'view-switch-btn';
    this.viewSwitchBtn.title = t('ui.viewSwitch');
    this.viewSwitchBtn.setAttribute('aria-label', t('ui.viewSwitch'));
    this.viewSwitchBtn.setAttribute('aria-pressed', 'false');
    this.viewSwitchBtn.style.display = 'none';
    this.viewSwitchBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>`;
    this.viewSwitchBtn.addEventListener('click', () => {
      const next = this.viewMode === 'personal' ? 'work' : 'personal';
      this.setViewMode(next);
      this.root.dispatchEvent(new CustomEvent('viewswitch', { detail: { mode: next }, bubbles: true }));
    });
    zoomWrap.appendChild(this.viewSwitchBtn);

    this.root.appendChild(zoomWrap);

    // PR18 — barra de busca (campo + ‹ n/m › + ✕), logo abaixo dos zooms
    this.searchBar = document.createElement('div');
    this.searchBar.className = 'search-bar';
    this.searchBar.style.display = 'none';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'search-input';
    this.searchInput.placeholder = t('ui.searchNotes');
    this.searchInput.setAttribute('aria-label', t('ui.searchNotes'));
    let searchDebounce = 0;
    this.searchInput.addEventListener('input', () => {
      const input = this.searchInput;
      if (!input) return;
      window.clearTimeout(searchDebounce);
      const value = input.value;
      searchDebounce = window.setTimeout(() => {
        this.root.dispatchEvent(new CustomEvent('searchquery', { detail: value, bubbles: true }));
      }, 200);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.root.dispatchEvent(new CustomEvent('searchnext', { detail: 1, bubbles: true }));
      }
    });
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'search-nav search-prev';
    prevBtn.title = t('ui.searchPrev');
    prevBtn.setAttribute('aria-label', t('ui.searchPrev'));
    prevBtn.textContent = '‹';
    prevBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('searchnext', { detail: -1, bubbles: true }));
    });
    this.searchCount = document.createElement('span');
    this.searchCount.className = 'search-count';
    this.searchCount.textContent = '0/0';
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'search-nav search-next';
    nextBtn.title = t('ui.searchNext');
    nextBtn.setAttribute('aria-label', t('ui.searchNext'));
    nextBtn.textContent = '›';
    nextBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('searchnext', { detail: 1, bubbles: true }));
    });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'search-close';
    closeBtn.title = t('ui.close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('searchclose', { bubbles: true }));
    });
    this.searchBar.appendChild(this.searchInput);
    this.searchBar.appendChild(prevBtn);
    this.searchBar.appendChild(this.searchCount);
    this.searchBar.appendChild(nextBtn);
    this.searchBar.appendChild(closeBtn);
    this.root.appendChild(this.searchBar);

    // PR mobile — publica no CSS a altura REAL do HUD e da barra de busca
    // (--hud-h / --search-h). No celular a barra de controles quebra em 2-3
    // linhas; com offset fixo a busca/painéis ficavam por cima dos botões.
    this._syncHudMetrics(zoomWrap);
  }

  /**
   * PR mobile — mede o HUD (.zoom-controls) e a barra de busca e expõe as
   * alturas como variáveis CSS em :root. `ResizeObserver` cobre tanto a quebra
   * em várias linhas da barra (largura da tela) quanto a abertura/fechamento
   * da busca; o CSS posiciona busca, menu de temas e painéis ABAIXO dessas
   * medidas, então nada se sobrepõe em telas estreitas.
   */
  private _syncHudMetrics(zoomWrap: HTMLElement): void {
    const sync = (): void => {
      const root = document.documentElement;
      const hud = Math.round(zoomWrap.getBoundingClientRect().height);
      if (hud > 0) root.style.setProperty('--hud-h', `${hud}px`);
      const search = Math.round(this.searchBar?.getBoundingClientRect().height ?? 0);
      root.style.setProperty('--search-h', search > 0 ? `${search + 8}px` : '0px');
    };
    sync();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(sync);
      ro.observe(zoomWrap);
      if (this.searchBar) ro.observe(this.searchBar);
    }
    window.addEventListener('resize', sync);
  }

  /** PR15 — estado visual do botão "Modo laço" (ligado = realçado). */
  setLassoModeActive(on: boolean): void {
    this.lassoBtn?.classList.toggle('sel', on);
  }

  /** PR4.13 — estado visual dos ícones de painel (aceso = painel aberto). */
  setPanelActive(which: 'floors' | 'summary', on: boolean): void {
    (which === 'floors' ? this.floorsBtn : this.statsBtn)?.classList.toggle('sel', on);
  }

  /** PR4.16 — estado do filtro ⭐ (aceso = só favoritos). */
  setFavoriteFilterActive(on: boolean): void {
    this.favFilterOn = on;
    this.favFilterBtn?.classList.toggle('sel', on);
    this.favFilterBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /** PR4.16 — lê o estado atual do filtro ⭐. */
  isFavoriteFilterActive(): boolean {
    return this.favFilterOn;
  }

  /**
   * PR4.16 — visão ativa (prédio 1 = pessoal / prédio 2 = trabalho Taiga).
   * Troca o ícone 🏠 ↔ 🏢 para o usuário saber onde está.
   */
  setViewMode(mode: 'personal' | 'work'): void {
    this.viewMode = mode;
    if (!this.viewSwitchBtn) return;
    const houseIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>`;
    const buildingIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/></svg>`;
    this.viewSwitchBtn.innerHTML = mode === 'work' ? buildingIcon : houseIcon;
    this.viewSwitchBtn.title =
      mode === 'work' ? t('ui.viewSwitchToPersonal') : t('ui.viewSwitchToWork');
    this.viewSwitchBtn.setAttribute('aria-label', this.viewSwitchBtn.title);
    this.viewSwitchBtn.classList.toggle('sel', mode === 'work');
    this.viewSwitchBtn.setAttribute('aria-pressed', mode === 'work' ? 'true' : 'false');
  }

  getViewMode(): 'personal' | 'work' {
    return this.viewMode;
  }

  /** Mostra/esconde o seletor de visão (só existe com Taiga conectado). */
  setViewSwitchVisible(on: boolean): void {
    if (this.viewSwitchBtn) this.viewSwitchBtn.style.display = on ? '' : 'none';
    if (!on) this.setViewMode('personal');
  }

  // -------------------------------------------------------------------------
  // PR4a — Control Manager: painel de vidro com as CAIXAS da mesa
  // -------------------------------------------------------------------------

  /**
   * Painel de vidro listando as CAIXAS (espaços chão+4 paredes onde as
   * pastas/arquivos/notas acontecem). `boxes` = {id, label, current} —
   * o chamador lê do world (o overlay NÃO conhece o core). Eventos no
   * root: `boxgoto` {id}, `boxcreate` {type, project}, `boxrename` {id, name},
   * `boxdelete` {id}, `boxesclose`.
   */
  showBoxesPanel(boxes: Array<{ id: string; label: string; current?: boolean; type?: string }>): void {
    if (!this.boxesModal) this.buildBoxesModal();
    this.boxesData = boxes;
    const m = this.boxesModal!;
    m.style.display = 'flex';
    this.settingsBtn?.classList.add('sel');
    this.renderBoxesList();
    // Esc fecha (cleanup guardado p/ o hide)
    if (!this.boxesCleanup) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.hideBoxesPanel();
      };
      document.addEventListener('keydown', onKey);
      this.boxesCleanup = () => document.removeEventListener('keydown', onKey);
    }
  }

  /**
   * PR4.5 — preenche o datalist com os projetos PÚBLICOS do Taiga (auxílio
   * p/ digitar o slug). Falha silenciosa: o campo aceita slug digitado.
   */
  private async fillProjectDatalist(dl: HTMLDataListElement): Promise<void> {
    try {
      dl.textContent = '';
      // PR4.14 — só sugere projetos dos quais o usuário é membro
      const projetos = pickMyProjects(await fetchTaigaProjects());
      this.cachedProjects = projetos;
      for (const p of projetos.slice(0, 100)) {
        const opt = document.createElement('option');
        opt.value = p.slug;
        opt.label = p.name;
        dl.appendChild(opt);
      }
    } catch {
      /* offline/erro — o slug pode ser digitado à mão */
    }
  }

  /** PR4.7 — renderiza o painel de conexão/autenticação com Taiga (Login ou Token JWT). */
  private async renderTaigaAuthBar(container: HTMLElement, dl: HTMLDataListElement): Promise<void> {
    container.textContent = '';
    const token = getTaigaToken();
    if (token) {
      const me = await fetchTaigaMe();
      if (me) {
        const info = document.createElement('div');
        info.className = 'boxes-taiga-info';
        info.innerHTML = `<span>✓</span> <span>${t('ui.taiga.authSuccess')} <strong>${me.fullName}</strong>${me.email ? ` (${me.email})` : ''}</span>`;
        const logoutBtn = document.createElement('button');
        logoutBtn.type = 'button';
        logoutBtn.className = 'boxes-taiga-btn-danger';
        logoutBtn.textContent = t('ui.taiga.disconnect');
        logoutBtn.addEventListener('click', () => {
          setTaigaToken(null);
          this.toast(t('ui.taiga.tokenRemoved'));
          void this.renderTaigaAuthBar(container, dl);
          void this.fillProjectDatalist(dl);
        });
        container.appendChild(info);
        container.appendChild(logoutBtn);
        return;
      } else {
        setTaigaToken(null);
      }
    }

    const form = document.createElement('div');
    form.className = 'boxes-taiga-form-card';

    const title = document.createElement('div');
    title.className = 'boxes-taiga-title';
    title.innerHTML = `<strong>Taiga.io (Conexão Direta API / Auth)</strong>`;
    form.appendChild(title);

    const rowCreds = document.createElement('div');
    rowCreds.className = 'boxes-taiga-row';

    const userInput = document.createElement('input');
    userInput.type = 'text';
    userInput.className = 'boxes-taiga-input';
    userInput.placeholder = t('ui.taiga.userPh');
    userInput.title = t('ui.taiga.userLabel');

    const passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.className = 'boxes-taiga-input';
    passInput.placeholder = t('ui.taiga.passLabel');
    passInput.title = t('ui.taiga.passLabel');

    rowCreds.appendChild(userInput);
    rowCreds.appendChild(passInput);
    form.appendChild(rowCreds);

    const tokenInput = document.createElement('input');
    tokenInput.type = 'text';
    tokenInput.className = 'boxes-taiga-input boxes-taiga-token-input';
    tokenInput.placeholder = t('ui.taiga.tokenPh');
    tokenInput.title = t('ui.taiga.tokenLabel');
    form.appendChild(tokenInput);

    const actionRow = document.createElement('div');
    actionRow.className = 'boxes-taiga-actions';

    const connectBtn = document.createElement('button');
    connectBtn.type = 'button';
    connectBtn.className = 'boxes-taiga-btn-primary';
    connectBtn.textContent = t('ui.taiga.testAndAuth');

    const handleConnect = async () => {
      const u = userInput.value.trim();
      const p = passInput.value;
      const tok = tokenInput.value.trim();

      if (!u && !p && !tok) {
        this.toast(t('ui.taiga.missingCredentials'));
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = '...';

      try {
        if (u && p) {
          const newToken = await loginTaiga(u, p);
          tokenInput.value = newToken;
        } else if (tok) {
          setTaigaToken(tok);
        }

        const me = await fetchTaigaMe();
        if (me) {
          this.toast(`${t('ui.taiga.authSuccess')} (${me.fullName})`);
          void this.renderTaigaAuthBar(container, dl);
          void this.fillProjectDatalist(dl);
        } else {
          setTaigaToken(null);
          this.toast(t('ui.taiga.invalidCredentials'));
        }
      } catch (err: unknown) {
        setTaigaToken(null);
        const msg = err instanceof TaigaError ? t(err.message) : t('ui.taiga.invalidCredentials');
        this.toast(msg);
      } finally {
        connectBtn.disabled = false;
        connectBtn.textContent = t('ui.taiga.testAndAuth');
      }
    };

    connectBtn.addEventListener('click', () => void handleConnect());
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void handleConnect();
    });
    passInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void handleConnect();
    });
    tokenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void handleConnect();
    });

    actionRow.appendChild(connectBtn);
    form.appendChild(actionRow);
    container.appendChild(form);
  }

  /** PR4.2 — (re)desenha a lista com o filtro de pesquisa aplicado. */
  private renderBoxesList(): void {
    const list = this.boxesList!;
    const q = (this.boxesSearch?.value ?? '').trim().toLowerCase();
    list.textContent = '';
    const filtradas = this.boxesData.filter((b) =>
      q === '' ? true : (b.label || '').toLowerCase().includes(q),
    );
    for (const b of filtradas) {
      const item = document.createElement('div');
      item.className = b.current ? 'boxes-item cur' : 'boxes-item';
      const nome = document.createElement('button');
      nome.type = 'button';
      nome.className = 'boxes-item-name';
      nome.textContent = b.label || t('ui.boxesUnnamed');
      nome.title = b.label || t('ui.boxesUnnamed');
      nome.addEventListener('click', () => {
        this.hideBoxesPanel();
        this.root.dispatchEvent(new CustomEvent('boxgoto', { detail: b.id, bubbles: true }));
      });
      item.appendChild(nome);
      // PR4.3 — badge de tipo (Raiz/Kanban) — só para caixas não-comum
      if (b.type && b.type !== 'comum') {
        const badge = document.createElement('span');
        badge.className = 'boxes-type-badge boxes-type-badge-' + b.type;
        badge.textContent = t('ui.boxType.' + b.type);
        item.appendChild(badge);
      }
      // Ações (PR4.2): renomear ✏️ + excluir 🗑 (a caixa padrão não exclui)
      const actions = document.createElement('span');
      actions.className = 'boxes-item-actions';
      const ren = document.createElement('button');
      ren.type = 'button';
      ren.className = 'boxes-act boxes-act-ren';
      ren.textContent = '✏️';
      ren.title = t('ui.boxesRename');
      ren.setAttribute('aria-label', t('ui.boxesRename'));
      ren.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.startBoxRename(item, b);
      });
      actions.appendChild(ren);
      // PR4.15 — Se for uma caixa tipo sprint, adiciona botão rápido para escolher/trocar sprint
      if (b.type === 'sprint') {
        const spBtn = document.createElement('button');
        spBtn.type = 'button';
        spBtn.className = 'boxes-act boxes-act-sprint';
        spBtn.textContent = '🏃';
        spBtn.title = t('ui.sprintBadgeTitle');
        spBtn.setAttribute('aria-label', t('ui.sprintBadgeTitle'));
        spBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.hideBoxesPanel();
          this.root.dispatchEvent(new CustomEvent('boxsprintpick', { detail: b.id, bubbles: true }));
        });
        actions.appendChild(spBtn);
      }
      // PR4.2 — a caixa padrão NÃO exclui (a ativa pode: volta p/ a Comum)
      if (b.id !== 'box-default') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'boxes-act boxes-act-del';
        del.textContent = '🗑️';
        del.title = t('ui.boxesDelete');
        del.setAttribute('aria-label', t('ui.boxesDelete'));
        del.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.confirmBoxDelete(item, b);
        });
        actions.appendChild(del);
      }
      item.appendChild(actions);
      list.appendChild(item);
    }
    this.boxesEmpty!.style.display = filtradas.length === 0 ? 'block' : 'none';
  }

  /** PR4.2 — renomear inline: troca o nome por input; Enter/blur commita. */
  private startBoxRename(item: HTMLElement, b: { id: string; label: string }): void {
    const nome = item.querySelector('.boxes-item-name') as HTMLElement | null;
    if (!nome || item.querySelector('.boxes-rename')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'boxes-rename';
    input.maxLength = 60;
    input.value = b.label || '';
    input.setAttribute('aria-label', t('ui.boxesRename'));
    nome.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const value = input.value.trim();
      if (value && value !== b.label) {
        this.root.dispatchEvent(
          new CustomEvent('boxrename', { detail: { id: b.id, name: value }, bubbles: true }),
        );
      } else {
        this.renderBoxesList(); // volta ao normal sem mudar nada
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = b.label || '';
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  }

  /** PR4.2 — confirmação de excluir dentro do próprio item. */
  private confirmBoxDelete(item: HTMLElement, b: { id: string; label: string }): void {
    if (item.querySelector('.boxes-confirm')) return;
    item.textContent = '';
    item.classList.add('confirming');
    const msg = document.createElement('span');
    msg.className = 'boxes-confirm-msg';
    msg.textContent = t('ui.boxesDeleteConfirm');
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'boxes-act boxes-yes';
    yes.textContent = t('ui.boxesYes');
    yes.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('boxdelete', { detail: b.id, bubbles: true }));
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'boxes-act boxes-no';
    no.textContent = t('ui.boxesNo');
    no.addEventListener('click', () => this.renderBoxesList());
    item.appendChild(msg);
    item.appendChild(yes);
    item.appendChild(no);
  }

  hideBoxesPanel(): void {
    if (this.boxesModal) this.boxesModal.style.display = 'none';
    if (this.boxesSearch) this.boxesSearch.value = '';
    this.settingsBtn?.classList.remove('sel');
    this.boxesCleanup?.();
    this.boxesCleanup = null;
  }

  isBoxesPanelVisible(): boolean {
    return !!this.boxesModal && this.boxesModal.style.display !== 'none';
  }

  /** PR4.4 — mostra/oculta botão "↩ Voltar ao Prédio" no HUD. */
  showBuildingBack(): void {
    if (this.buildingBackBtn) this.buildingBackBtn.style.display = '';
  }

  hideBuildingBack(): void {
    if (this.buildingBackBtn) this.buildingBackBtn.style.display = 'none';
  }

  /** PR4.15 — mostra e atualiza o badge de Sprint no HUD. */
  setSprintBadge(sprintName: string, active = true): void {
    if (!this.sprintBadgeBtn) return;
    const label = this.sprintBadgeBtn.querySelector('.sprint-badge-label');
    if (label) label.textContent = sprintName;
    this.sprintBadgeBtn.style.display = 'inline-flex';
    if (active) {
      this.sprintBadgeBtn.classList.add('active');
    } else {
      this.sprintBadgeBtn.classList.remove('active');
    }
  }

  /** PR4.15 — esconde o badge de Sprint no HUD. */
  hideSprintBadge(): void {
    if (this.sprintBadgeBtn) {
      this.sprintBadgeBtn.style.display = 'none';
    }
  }

  /** Define qual tema está visualmente marcado como ativo no menu. */
  setThemeActive(name: string): void {
    this.currentThemeName = name;
    if (this.themeMenu && this.themeMenu.style.display !== 'none') {
      this.renderThemeMenu();
    }
  }

  toggleThemeMenu(): void {
    if (this.themeMenu && this.themeMenu.style.display !== 'none') {
      this.hideThemeMenu();
    } else {
      this.showThemeMenu();
    }
  }

  showThemeMenu(): void {
    if (!this.themeMenu) this.buildThemeMenu();
    this.renderThemeMenu();
    this.themeMenu!.style.display = 'flex';
    this.themeBtn?.classList.add('sel');

    if (!this.themeCleanup) {
      const onDocClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (
          this.themeMenu &&
          target &&
          !this.themeMenu.contains(target) &&
          target !== this.themeBtn &&
          !this.themeBtn?.contains(target)
        ) {
          this.hideThemeMenu();
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.hideThemeMenu();
      };
      setTimeout(() => {
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKey);
      }, 0);
      this.themeCleanup = () => {
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onKey);
      };
    }
  }

  hideThemeMenu(): void {
    if (this.themeMenu) this.themeMenu.style.display = 'none';
    this.themeBtn?.classList.remove('sel');
    this.themeCleanup?.();
    this.themeCleanup = null;
  }

  private buildThemeMenu(): void {
    const menu = document.createElement('div');
    menu.className = 'theme-menu';
    this.themeMenu = menu;
    this.root.appendChild(menu);
  }

  private renderThemeMenu(): void {
    if (!this.themeMenu) return;
    this.themeMenu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'theme-menu-head';
    head.textContent = t('ui.themeTitle');
    this.themeMenu.appendChild(head);

    THEMES.forEach((th, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = th.name === this.currentThemeName ? 'theme-menu-item active' : 'theme-menu-item';

      const dot = document.createElement('span');
      dot.className = 'theme-menu-dot';
      const c = '#' + th.floor.toString(16).padStart(6, '0');
      dot.style.background = c;

      const label = document.createElement('span');
      label.className = 'theme-menu-name';
      label.textContent = t(`theme.${th.name}`) || th.name;

      btn.appendChild(dot);
      btn.appendChild(label);

      if (th.name === this.currentThemeName) {
        const check = document.createElement('span');
        check.className = 'theme-menu-check';
        check.textContent = '✓';
        btn.appendChild(check);
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.currentThemeName = th.name;
        this.hideThemeMenu();
        this.root.dispatchEvent(
          new CustomEvent('themechange', {
            detail: { index: idx, name: th.name, theme: th },
            bubbles: true,
          }),
        );
      });

      this.themeMenu!.appendChild(btn);
    });
  }

  private buildBoxesModal(): void {
    const m = document.createElement('div');
    m.className = 'boxes-modal';
    this.boxesModal = m;
    // Clique no FUNDO (fora do card) também fecha
    m.addEventListener('click', (e) => {
      if (e.target === m) this.hideBoxesPanel();
    });
    const card = document.createElement('div');
    card.className = 'boxes-card';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'boxes-close';
    close.title = t('ui.close');
    close.setAttribute('aria-label', t('ui.close'));
    close.textContent = '✕';
    close.addEventListener('click', () => {
      this.hideBoxesPanel();
      this.root.dispatchEvent(new CustomEvent('boxesclose', { bubbles: true }));
    });
    const head = document.createElement('div');
    head.className = 'boxes-head';
    const title = document.createElement('h2');
    title.className = 'boxes-title';
    title.textContent = t('ui.boxesTitle');
    head.appendChild(title);
    // PR4.3/4.5/4.6 — seletor de tipo da nova caixa
    this.boxesType = document.createElement('select');
    this.boxesType.className = 'boxes-type-sel';
    this.boxesType.setAttribute('aria-label', t('ui.boxesType'));
    const optComum = document.createElement('option');
    optComum.value = 'comum';
    optComum.textContent = t('ui.boxType.comum');
    const optRoot = document.createElement('option');
    optRoot.value = 'root';
    optRoot.textContent = t('ui.boxType.root');
    const optKanban = document.createElement('option');
    optKanban.value = 'kanban';
    optKanban.textContent = t('ui.boxType.kanban');
    const optBacklog = document.createElement('option');
    optBacklog.value = 'backlog';
    optBacklog.textContent = t('ui.boxType.backlog');
    const optSprint = document.createElement('option');
    optSprint.value = 'sprint';
    optSprint.textContent = t('ui.boxType.sprint');
    this.boxesType.appendChild(optComum);
    this.boxesType.appendChild(optRoot);
    this.boxesType.appendChild(optKanban);
    this.boxesType.appendChild(optBacklog);
    this.boxesType.appendChild(optSprint);
    head.appendChild(this.boxesType);
    // PR4.5/4.6 — slug do projeto Taiga (aparece quando tipo = backlog ou sprint)
    this.boxesProject = document.createElement('input');
    this.boxesProject.type = 'text';
    this.boxesProject.className = 'boxes-project';
    this.boxesProject.placeholder = t('ui.boxesProjectPh');
    this.boxesProject.setAttribute('aria-label', t('ui.boxesProject'));
    this.boxesProject.title = t('ui.boxesProject');
    const dl = document.createElement('datalist');
    dl.id = 'boxes-projects-dl';
    this.boxesProject.setAttribute('list', dl.id);
    this.boxesProject.style.display = 'none';

    // PR4.9 — seletor de sprint ativa/específica ao criar caixa tipo sprint
    this.boxesSprint = document.createElement('select');
    this.boxesSprint.className = 'boxes-sprint-sel';
    this.boxesSprint.style.display = 'none';
    this.boxesSprint.innerHTML = '<option value="">Sprint ativa (automática)</option>';

    const updateSprintsForProject = async () => {
      if (this.boxesType?.value !== 'sprint' || !this.boxesSprint) return;
      const slug = (this.boxesProject?.value ?? '').trim();
      if (!slug) {
        this.boxesSprint.innerHTML = '<option value="">Sprint ativa (automática)</option>';
        return;
      }
      try {
        const pId = await resolveProjectId(slug);
        const sprints = await fetchTaigaSprints(pId);
        this.boxesSprint.innerHTML = '';
        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = 'Sprint ativa (automática)';
        this.boxesSprint.appendChild(defOpt);
        for (const s of sprints) {
          const opt = document.createElement('option');
          opt.value = String(s.id);
          opt.setAttribute('data-name', s.name);
          opt.textContent = `${s.name}${!s.closed ? ' (Ativa)' : ''}`;
          if (!s.closed) opt.selected = true;
          this.boxesSprint.appendChild(opt);
        }
      } catch {
        /* se falhar ao resolver id, mantém automático */
      }
    };

    this.boxesType.addEventListener('change', () => {
      const type = this.boxesType?.value;
      const needsSlug = type === 'backlog' || type === 'sprint';
      this.boxesProject!.style.display = needsSlug ? '' : 'none';
      if (this.boxesSprint) this.boxesSprint.style.display = type === 'sprint' ? '' : 'none';
      if (needsSlug && !dl.childElementCount) void this.fillProjectDatalist(dl);
      if (type === 'sprint') void updateSprintsForProject();
    });
    this.boxesProject.addEventListener('change', () => void updateSprintsForProject());
    this.boxesProject.addEventListener('input', () => {
      const val = (this.boxesProject?.value ?? '').trim().toLowerCase();
      const matched = this.cachedProjects.some((p) => p.slug.toLowerCase() === val || p.name.toLowerCase() === val);
      if (matched) void updateSprintsForProject();
    });

    head.appendChild(this.boxesProject);
    head.appendChild(dl);
    head.appendChild(this.boxesSprint);
    // PR4.2 — botão "+ Nova caixa" (envia o tipo escolhido no evento boxcreate)
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'boxes-add';
    add.textContent = `+ ${t('ui.boxesAdd')}`;
    add.title = t('ui.boxesAdd');
    add.setAttribute('aria-label', t('ui.boxesAdd'));
    add.addEventListener('click', () => {
      const type = this.boxesType?.value || 'comum';
      const needsSlug = type === 'backlog' || type === 'sprint';
      const project = needsSlug ? (this.boxesProject?.value ?? '').trim() : '';
      const matchedProj = this.cachedProjects.find(
        (p) => p.slug.toLowerCase() === project.toLowerCase() || p.name.toLowerCase() === project.toLowerCase(),
      );
      const projectName = matchedProj ? matchedProj.name : project;
      const sprintOpt = this.boxesSprint?.selectedOptions[0];
      const sprintId = sprintOpt && sprintOpt.value ? Number(sprintOpt.value) : undefined;
      const sprintName = sprintOpt?.getAttribute('data-name') || undefined;

      this.root.dispatchEvent(
        new CustomEvent('boxcreate', {
          detail: { type, project, projectName, sprintId, sprintName },
          bubbles: true,
        }),
      );
      this.boxesType!.value = 'comum'; // volta ao padrão
      if (this.boxesProject) {
        this.boxesProject.value = '';
        this.boxesProject.style.display = 'none';
      }
      if (this.boxesSprint) {
        this.boxesSprint.innerHTML = '<option value="">Sprint ativa (automática)</option>';
        this.boxesSprint.style.display = 'none';
      }
    });
    head.appendChild(add);
    const hint = document.createElement('div');
    hint.className = 'boxes-hint';
    hint.textContent = t('ui.boxesHint');
    // PR4.2 — pesquisa de caixas por nome (filtro local, sem tocar no core)
    this.boxesSearch = document.createElement('input');
    this.boxesSearch.type = 'text';
    this.boxesSearch.className = 'boxes-search';
    this.boxesSearch.placeholder = t('ui.boxesSearch');
    this.boxesSearch.setAttribute('aria-label', t('ui.boxesSearch'));
    this.boxesSearch.addEventListener('input', () => this.renderBoxesList());
    this.boxesList = document.createElement('div');
    this.boxesList.className = 'boxes-list';
    this.boxesEmpty = document.createElement('div');
    this.boxesEmpty.className = 'boxes-empty';
    this.boxesEmpty.textContent = t('ui.boxesEmpty');
    this.boxesEmpty.style.display = 'none';
    card.appendChild(close);
    card.appendChild(head);
    // PR4.7 — Barra de autenticação/sessão do Taiga
    const taigaBar = document.createElement('div');
    taigaBar.className = 'boxes-taiga-bar';
    void this.renderTaigaAuthBar(taigaBar, dl);
    card.appendChild(taigaBar);
    card.appendChild(hint);
    card.appendChild(this.boxesSearch);
    card.appendChild(this.boxesList);
    card.appendChild(this.boxesEmpty);
    m.appendChild(card);
    this.root.appendChild(m);
  }

  // -------------------------------------------------------------------------
  // PR27 — conta (login/cadastro com Cloudflare D1)
  // -------------------------------------------------------------------------

  /**
   * Modal de vidro (login/cadastro OU sessão ativa). `mode: 'in' | 'up' |
   * 'logged'`. Eventos no root: `authsubmit` {email, password, mode},
   * `authswitch`, `authsignout`, `authclose`.
   */
  showAuthModal(spec: { mode: 'in' | 'up' | 'logged'; email: string; error: string | null }): void {
    if (!this.authModal) this.buildAuthModal();
    const m = this.authModal!;
    const form = this.authForm!;
    const logged = this.authLogged!;
    const email = this.authEmail!;
    if (spec.mode === 'logged') {
      form.style.display = 'none';
      logged.style.display = 'flex';
      // O campo de e-mail é reutilizado como display — religa no bloco "logado"
      email.classList.remove('auth-logged-email');
      logged.prepend(email);
      this.authTitle!.textContent = t('ui.authLogged');
      email.value = spec.email;
      email.readOnly = true;
      email.type = 'email';
      this.authPassWrap!.style.display = 'none';
    } else {
      form.style.display = 'flex';
      logged.style.display = 'none';
      this.authEmailWrap!.appendChild(email); // volta p/ o formulário
      email.readOnly = false;
      email.type = 'email';
      email.value = spec.email;
      this.authPassWrap!.style.display = 'flex';
      this.authMode = spec.mode;
      this.authTitle!.textContent = spec.mode === 'up' ? t('ui.authTitleUp') : t('ui.authTitle');
      this.authSubmitBtn!.textContent = spec.mode === 'up' ? t('ui.authSubmitUp') : t('ui.authSubmit');
      this.authSwitchBtn!.textContent =
        spec.mode === 'up' ? t('ui.authSwitchIn') : t('ui.authSwitchUp');
    }
    if (this.authError) {
      this.authError.textContent = spec.error ?? '';
      this.authError.style.display = spec.error ? 'block' : 'none';
    }
    m.style.display = 'flex';
    this.authBtn?.classList.add('sel');
    if (spec.mode !== 'logged') this.authEmail!.focus();
  }

  hideAuthModal(): void {
    if (this.authModal) this.authModal.style.display = 'none';
    if (this.authPassword) this.authPassword.value = '';
    if (this.authError) this.authError.style.display = 'none';
    this.authBtn?.classList.remove('sel');
  }

  isAuthModalVisible(): boolean {
    return !!this.authModal && this.authModal.style.display !== 'none';
  }

  /** Modo atual do modal (p/ o botão de alternância entrar↔criar). */
  getAuthMode(): 'in' | 'up' {
    return this.authMode;
  }

  /** E-mail digitado (mantém o valor ao alternar entrar↔criar). */
  getAuthEmail(): string {
    return this.authEmail?.value ?? '';
  }

  /** Estado do botão na barra: logado → dica com o e-mail + pontinho. */

  // ── PR4.16 — muro de login (logout real: só a tela de login sobra) ────
  private authWallEl: HTMLElement | null = null;

  /**
   * Sobe/desce o muro: um véu cobre cena + HUD (z 10000; só o modal de
   * perfil, z 10001, fica por cima). Depois de sair do sistema nada do
   * prédio/caixas fica visível nem clicável. Clicar no véu reabre o login —
   * fechar o modal não pode deixar a pessoa presa num tela preta.
   */
  setAuthWall(on: boolean): void {
    if (on) {
      if (!this.authWallEl) {
        const w = document.createElement('div');
        w.className = 'auth-wall';
        w.setAttribute('aria-hidden', 'true');
        w.addEventListener('click', () => {
          this.root.dispatchEvent(new CustomEvent('authwallreopen', { bubbles: true }));
        });
        this.root.appendChild(w);
        this.authWallEl = w;
      }
      this.authWallEl.style.display = 'block';
      document.body.classList.add('auth-walled');
    } else {
      if (this.authWallEl) this.authWallEl.style.display = 'none';
      document.body.classList.remove('auth-walled');
    }
  }

  /** O muro está de pé? */
  isAuthWallUp(): boolean {
    return !!this.authWallEl && this.authWallEl.style.display !== 'none';
  }

  setAuthState(session: { email: string } | null): void {
    if (!this.authBtn) return;
    this.authBtn.classList.toggle('logged', !!session);
    this.authBtn.title = session ? `${t('ui.authLogged')}: ${session.email}` : t('ui.auth');
    this.authBtn.setAttribute('aria-label', this.authBtn.title);
  }

  private buildAuthModal(): void {
    const m = document.createElement('div');
    m.className = 'auth-modal';
    this.authModal = m; // <-- campos this.* precisam ser atribuídos (showAuthModal usa this.authModal etc.)
    const card = document.createElement('div');
    card.className = 'auth-card';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'auth-close';
    close.title = t('ui.close');
    close.setAttribute('aria-label', t('ui.close'));
    close.textContent = '✕';
    close.addEventListener('click', () => {
      this.hideAuthModal();
      this.root.dispatchEvent(new CustomEvent('authclose', { bubbles: true }));
    });
    this.authTitle = document.createElement('h2');
    this.authTitle.className = 'auth-title';
    this.authError = document.createElement('div');
    this.authError.className = 'auth-error';
    this.authError.style.display = 'none';
    this.authForm = document.createElement('div');
    this.authForm.className = 'auth-form';
    const emailWrap = document.createElement('label');
    emailWrap.className = 'auth-field';
    const emailLabel = document.createElement('span');
    emailLabel.textContent = t('ui.authEmail');
    this.authEmail = document.createElement('input');
    this.authEmail.type = 'email';
    this.authEmail.autocomplete = 'email';
    this.authEmail.placeholder = 'voce@exemplo.com';
    this.authEmailWrap = emailWrap;
    const passWrap = document.createElement('label');
    passWrap.className = 'auth-field';
    const passLabel = document.createElement('span');
    passLabel.textContent = t('ui.authPassword');
    this.authPassword = document.createElement('input');
    this.authPassword.type = 'password';
    this.authPassword.autocomplete = 'current-password';
    this.authPassword.placeholder = '••••••••';
    this.authPassWrap = passWrap;
    emailWrap.append(emailLabel, this.authEmail);
    passWrap.append(passLabel, this.authPassword);
    this.authSubmitBtn = document.createElement('button');
    this.authSubmitBtn.type = 'button';
    this.authSubmitBtn.className = 'auth-submit';
    this.authSubmitBtn.addEventListener('click', () => this.emitSubmit());
    this.authSwitchBtn = document.createElement('button');
    this.authSwitchBtn.type = 'button';
    this.authSwitchBtn.className = 'auth-switch';
    this.authSwitchBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('authswitch', { bubbles: true }));
    });
    this.authForm.append(emailWrap, passWrap, this.authSubmitBtn, this.authSwitchBtn);
    // PR4.14 — "Esqueci a senha" (recuperação de conta)
    const forgotBtn = document.createElement('button');
    forgotBtn.type = 'button';
    forgotBtn.className = 'auth-forgot';
    forgotBtn.textContent = t('ui.authForgot');
    forgotBtn.addEventListener('click', () => this.showForgotPasswordModal());
    this.authForm.appendChild(forgotBtn);
    // Sessão ativa: e-mail + botão Sair
    this.authLogged = document.createElement('div');
    this.authLogged.className = 'auth-logged';
    // O campo de e-mail é REUTILIZADO entre os dois estados (form ↔ display
    // "logado"); quem o religa em cada modo é showAuthModal — aqui ele fica
    // no formulário e o bloco "logado" só tem o botão Sair.
    const outBtn = document.createElement('button');
    outBtn.type = 'button';
    outBtn.className = 'auth-submit';
    outBtn.textContent = t('ui.authSignOut');
    outBtn.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('authsignout', { bubbles: true }));
    });
    this.authLogged.appendChild(outBtn);
    card.append(close, this.authTitle, this.authError, this.authForm, this.authLogged);
    m.appendChild(card);
    // Clique no fundo escuro fecha (mesmo padrão do modal de pasta)
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) {
        this.hideAuthModal();
        this.root.dispatchEvent(new CustomEvent('authclose', { bubbles: true }));
      }
    });
    this.root.appendChild(m);
    // Enter envia (login/cadastro)
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.emitSubmit();
      }
    });
  }

  private emitSubmit(): void {
    if (!this.authEmail || !this.authPassword || this.authMode === undefined) return;
    const mode = this.authMode;
    const email = this.authEmail.value;
    const password = this.authPassword.value;
    if (!email || !password) return;
    this.root.dispatchEvent(
      new CustomEvent('authsubmit', { detail: { email, password, mode }, bubbles: true }),
    );
  }

  // -------------------------------------------------------------------------
  // PR18 — busca nas notas
  // -------------------------------------------------------------------------

  /** Abre/fecha a barra de busca (abrir já dá foco ao campo). */
  showSearchBar(on: boolean): void {
    if (!this.searchBar || !this.searchInput) return;
    this.searchBar.style.display = on ? 'flex' : 'none';
    this.searchBtn?.classList.toggle('sel', on);
    if (on) {
      this.searchInput.focus();
    } else {
      this.searchInput.value = '';
    }
  }

  isSearchBarVisible(): boolean {
    return !!this.searchBar && this.searchBar.style.display !== 'none';
  }

  /** Contador "atual/total" (0/n até o primeiro Enter/seta). */
  setSearchCount(cur: number, total: number): void {
    if (!this.searchCount || !this.searchBar) return;
    this.searchCount.textContent = `${Math.max(0, cur)}/${total}`;
    const prev = this.searchBar.querySelector('.search-prev');
    const next = this.searchBar.querySelector('.search-next');
    if (prev) (prev as HTMLButtonElement).disabled = total === 0;
    if (next) (next as HTMLButtonElement).disabled = total === 0;
  }

  /** Destaques por frame: um retângulo na borda de cada nota encontrada. */
  setSearchMarkers(
    markers: Array<{ id: string; x: number; y: number; w: number; h: number; cur: boolean }> | null,
  ): void {
    if (!markers || markers.length === 0) {
      for (const el of this.searchMarks.values()) el.remove();
      this.searchMarks.clear();
      return;
    }
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let el = this.searchMarks.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'search-hl';
        this.underlay.appendChild(el);
        this.searchMarks.set(m.id, el);
      }
      el.classList.toggle('cur', m.cur);
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
      // PR20 — o destaque "veste" a nota: retângulo do envelope na tela
      const w = Math.max(34, m.w + 8); // +8px = respiro ao redor da borda
      const h = Math.max(34, m.h + 8);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    for (const [id, el] of this.searchMarks) {
      if (!seen.has(id)) {
        el.remove();
        this.searchMarks.delete(id);
      }
    }
  }

  showContextMenu(screen: { x: number; y: number }, items: ContextMenuItem[]): void {
    this.hideContextMenu();
    if (!items || items.length === 0) return;

    const R = 140; // Raio do menu radial (diâmetro 280px)
    const cx = Math.max(R + 10, Math.min(window.innerWidth - R - 10, screen.x));
    const cy = Math.max(R + 10, Math.min(window.innerHeight - R - 10, screen.y));

    const menu = document.createElement('div');
    menu.className = 'ctx-menu radial-menu';
    menu.style.pointerEvents = 'auto';
    menu.style.position = 'absolute';
    menu.style.left = `${cx}px`;
    menu.style.top = `${cy}px`;
    menu.style.width = '280px';
    menu.style.height = '280px';
    menu.style.margin = '-140px 0 0 -140px';

    const triggerAction = (action: string) => {
      // Despacha com o menu AINDA anexado ao DOM: o evento precisa borbulhar
      // até o overlayRoot (app). Só esconde DEPOIS se o handler não abriu
      // outro menu em sincronia (ex.: "Configurações da imagem…" abre o menu
      // secundário — esconder depois apagaria o menu recém-aberto).
      menu.dispatchEvent(new CustomEvent('ctxaction', { detail: action, bubbles: true }));
      if (this.menuEl === menu) this.hideContextMenu();
    };

    // SVG radial com fatias em forma de cunha anelar (pie slices)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'radial-pie-svg');
    svg.setAttribute('viewBox', '-140 -140 280 280');

    const N = items.length;
    const Rout = 136;
    const Rin = 48;
    const step = (2 * Math.PI) / N;
    const gap = N > 1 ? 0.024 : 0;
    const theta0 = -Math.PI / 2; // Começa no topo (12 horas)

    // Centro (Hub) do menu radial
    const hub = document.createElement('div');
    hub.className = 'radial-hub';
    hub.title = 'BumpTop';
    const defaultHubHtml = `
      <div class="radial-hub-inner">
        <div class="radial-hub-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#60a5fa" stroke-width="2">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
        </div>
        <div class="radial-hub-title">BumpTop</div>
      </div>
    `;
    hub.innerHTML = defaultHubHtml;
    hub.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideContextMenu();
    });

    const resetHub = () => {
      hub.innerHTML = defaultHubHtml;
    };

    const hintBar = document.createElement('div');
    hintBar.className = 'radial-hint-bar';
    hintBar.style.opacity = '0';

    const buttons: HTMLButtonElement[] = [];
    const slices: SVGPathElement[] = [];

    items.forEach((item, i) => {
      const a1 = theta0 + i * step + gap / 2;
      const a2 = theta0 + (i + 1) * step - gap / 2;

      const xo1 = (Rout * Math.cos(a1)).toFixed(1);
      const yo1 = (Rout * Math.sin(a1)).toFixed(1);
      const xo2 = (Rout * Math.cos(a2)).toFixed(1);
      const yo2 = (Rout * Math.sin(a2)).toFixed(1);
      const xi2 = (Rin * Math.cos(a2)).toFixed(1);
      const yi2 = (Rin * Math.sin(a2)).toFixed(1);
      const xi1 = (Rin * Math.cos(a1)).toFixed(1);
      const yi1 = (Rin * Math.sin(a1)).toFixed(1);
      const large = (a2 - a1) > Math.PI ? 1 : 0;

      const d = `M ${xo1} ${yo1} A ${Rout} ${Rout} 0 ${large} 1 ${xo2} ${yo2} L ${xi2} ${yi2} A ${Rin} ${Rin} 0 ${large} 0 ${xi1} ${yi1} Z`;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `radial-slice ${item.danger ? 'danger' : ''}`);
      svg.appendChild(path);
      slices.push(path);

      // Posição do botão de ação sobre a fatia
      const amid = theta0 + (i + 0.5) * step;
      const Rmid = 92;
      const bx = 140 + Rmid * Math.cos(amid);
      const by = 140 + Rmid * Math.sin(amid);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item radial-btn' + (item.danger ? ' danger' : '');
      if (item.hint) btn.dataset.hint = item.hint;
      btn.style.position = 'absolute';
      btn.style.margin = '0';
      btn.style.left = `${bx.toFixed(1)}px`;
      btn.style.top = `${by.toFixed(1)}px`;
      btn.style.transform = 'translate(-50%, -50%)';

      const iconSvg = getActionIcon(item.action);
      btn.innerHTML = `
        <span class="radial-btn-icon">${iconSvg}</span>
        <span class="radial-btn-label">${item.label}</span>
      `;

      const setHoverState = (hover: boolean) => {
        path.classList.toggle('active', hover);
        btn.classList.toggle('active', hover);
        if (hover) {
          hub.innerHTML = `
            <div class="radial-hub-inner">
              <div class="radial-hub-icon">${iconSvg}</div>
              <div class="radial-hub-title" title="${item.label}">${item.label}</div>
            </div>
          `;
          if (hintBar && item.hint) {
            hintBar.textContent = item.hint;
            hintBar.style.opacity = '1';
          }
        } else {
          resetHub();
          if (hintBar) {
            hintBar.textContent = '';
            hintBar.style.opacity = '0';
          }
        }
      };

      btn.addEventListener('pointerenter', () => setHoverState(true));
      btn.addEventListener('pointerleave', () => setHoverState(false));
      path.addEventListener('pointerenter', () => setHoverState(true));
      path.addEventListener('pointerleave', () => setHoverState(false));

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerAction(item.action);
      };

      path.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerAction(item.action);
      });

      buttons.push(btn);
    });

    menu.appendChild(svg);
    menu.appendChild(hub);
    buttons.forEach((b) => menu.appendChild(b));
    menu.appendChild(hintBar);

    this.root.appendChild(menu);
    this.menuEl = menu;

    const onOutside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) this.hideContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.hideContextMenu();
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey);
    }, 0);
    this.menuCleanup = () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }

  hideContextMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
    this.menuEl?.remove();
    this.menuEl = null;
  }

  setLabel(
    id: string,
    text: string | null,
    screen: { x: number; y: number } | null,
    opts?: { note?: boolean },
  ): void {
    let el = this.labels.get(id);
    if (text === null || screen === null) {
      el?.remove();
      this.labels.delete(id);
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'obj-label';
      this.underlay.appendChild(el);
      this.labels.set(id, el);
    }
    // Nota adesiva: bloco amarelo sobre o card, multi-linha, truncado pelo
    // CSS (line-clamp) até preencher o tamanho do card — com "…" se não couber.
    el.classList.toggle('note', opts?.note === true);
    el.textContent = text;
    // Garante que o label nunca ultrapasse as bordas da tela (mobile ou desktop).
    // O label tem transform: translate(-50%, 0) → a borda esquerda fica em left - width/2.
    // Usa halfWidth generoso (100) p/ cobrir labels até ~200px + padding.
    const halfWidth = 100;
    const clampedX = Math.max(halfWidth + 4, Math.min(window.innerWidth - halfWidth - 4, screen.x));
    const clampedY = Math.max(4, Math.min(window.innerHeight - 24, screen.y));
    el.style.left = `${clampedX}px`;
    el.style.top = `${clampedY}px`;
  }

  private hoverTooltipEl: HTMLDivElement | null = null;

  /** PR4.11 — Tooltip flutuante exibido no hover com o título completo do item do Taiga. */
  setHoverTooltip(text: string | null, screen: { x: number; y: number } | null): void {
    if (!text || !screen) {
      if (this.hoverTooltipEl) {
        this.hoverTooltipEl.style.display = 'none';
      }
      return;
    }
    if (!this.hoverTooltipEl) {
      this.hoverTooltipEl = document.createElement('div');
      this.hoverTooltipEl.className = 'story-hover-tooltip';
      this.root.appendChild(this.hoverTooltipEl);
    }
    this.hoverTooltipEl.textContent = text;
    this.hoverTooltipEl.style.display = 'block';

    const padding = 16;
    const x = Math.min(screen.x + 16, Math.max(padding, window.innerWidth - 460));
    const y = Math.max(padding, Math.min(screen.y - 10, window.innerHeight - 80));
    this.hoverTooltipEl.style.left = `${Math.max(padding, x)}px`;
    this.hoverTooltipEl.style.top = `${y}px`;
  }

  toast(message: string): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  /**
   * Aviso de LEMBRETE vencido — banner fixo que fica ATÉ o usuário dispensar.
   * Diferente do `toast` (2,6 s, some se a aba estiver em segundo plano),
   * o alarme precisa garantir que o aviso foi visto.
   */
  alarm(message: string): void {
    this.root.querySelector('.alarm-banner')?.remove();
    const el = document.createElement('div');
    el.className = 'alarm-banner';
    el.setAttribute('role', 'alert');
    // o #overlay-root inteiro é pointer-events:none (HUD) — filhos clicáveis
    // precisam reativar senão o clique cai no canvas da cena
    el.style.pointerEvents = 'auto';
    const msg = document.createElement('span');
    msg.className = 'alarm-msg';
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'alarm-dismiss';
    btn.textContent = t('ui.alarmDismiss');
    btn.addEventListener('click', () => el.remove());
    el.append(msg, btn);
    this.root.appendChild(el);
  }

  /**
   * Laço de seleção sobre a cena (retângulo com traço livre pontilhado e caneta azul — P1).
   * null esconde — chamado pelo World durante a seleção por laço.
   */
  setLasso(data: LassoData | null): void {
    if (data === null) {
      this.lassoEl?.remove();
      this.lassoEl = null;
      return;
    }
    if (!this.lassoEl) {
      const el = document.createElement('div');
      el.className = 'lasso-rect';
      this.root.appendChild(el);
      this.lassoEl = el;
    }
    this.lassoEl.style.left = `${data.x}px`;
    this.lassoEl.style.top = `${data.y}px`;
    this.lassoEl.style.width = `${data.w}px`;
    this.lassoEl.style.height = `${data.h}px`;

    if (data.points && data.points.length >= 3) {
      const pts = data.points;
      const rel = (p: { x: number; y: number }) => ({ x: p.x - data.x, y: p.y - data.y });
      const relPts = pts
        .map((p) => {
          const r = rel(p);
          return `${r.x.toFixed(1)},${r.y.toFixed(1)}`;
        })
        .join(' ');
      const origin = rel(data.start ?? pts[0]);
      const pen = rel(pts[pts.length - 1]);
      const discR = data.startRadius ?? 0;
      const disc =
        discR > 0
          ? `<circle cx="${origin.x.toFixed(1)}" cy="${origin.y.toFixed(1)}" r="${discR}" class="lasso-start-disc${data.closed ? ' is-closed' : ''}" />`
          : '';
      const cross = data.crossTarget ? rel(data.crossTarget) : null;
      const crossEl = cross
        ? `<g class="lasso-cross" transform="translate(${cross.x.toFixed(1)} ${cross.y.toFixed(1)})">
             <circle r="16" class="lasso-cross-ring" />
             <rect x="-7" y="-9" width="12" height="9" rx="1.5" class="lasso-cross-card" />
             <rect x="-5" y="-6" width="12" height="9" rx="1.5" class="lasso-cross-card" />
             <path d="M1 12 L1 5 M-2 8 L1 5 L4 8" class="lasso-cross-arrow" />
           </g>`
        : '';
      this.lassoEl.innerHTML = `
        <svg class="lasso-svg">
          <polygon points="${relPts}" class="lasso-polygon" />
          ${disc}
          <polyline points="${relPts}" class="lasso-line" />
          ${crossEl}
          <circle cx="${origin.x.toFixed(1)}" cy="${origin.y.toFixed(1)}" r="4" class="lasso-start-ring" />
          <circle cx="${pen.x.toFixed(1)}" cy="${pen.y.toFixed(1)}" r="5" class="lasso-pen-tip" />
        </svg>
      `;
    } else if (data.w > 2 && data.h > 2) {
      // Elipse pontilhada curva suave (estilo BumpTop original)
      const cx = (data.w / 2).toFixed(1);
      const cy = (data.h / 2).toFixed(1);
      const rx = (data.w / 2).toFixed(1);
      const ry = (data.h / 2).toFixed(1);
      this.lassoEl.innerHTML = `
        <svg class="lasso-svg" viewBox="0 0 ${data.w} ${data.h}">
          <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" class="lasso-polygon" />
          <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" class="lasso-line" />
          <circle cx="${cx}" cy="${cy}" r="3" class="lasso-start-ring" />
          <circle cx="${data.w}" cy="${data.h}" r="4.5" class="lasso-pen-tip" />
        </svg>
      `;
    } else {
      this.lassoEl.innerHTML = '';
    }
  }

  /**
   * Handle de resize (A — arrastar p/ redimensionar): quadrado no canto do
   * bbox da seleção; null esconde.
   */
  setResizeHandle(screen: { x: number; y: number } | null): void {
    if (screen === null) {
      if (this.resizeEl) this.resizeEl.style.display = 'none';
      return;
    }
    if (!this.resizeEl) {
      const el = document.createElement('div');
      el.className = 'resize-handle';
      el.dataset.hint = t('hint.resizeHandle');
      el.style.pointerEvents = 'auto';
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.resizeCb?.(e);
      });
      this.root.appendChild(el);
      this.resizeEl = el;
    }
    this.resizeEl.style.display = 'block';
    this.resizeEl.style.left = `${screen.x}px`;
    this.resizeEl.style.top = `${screen.y}px`;
  }

  /** Registra o callback de início do gesto de resize. */
  onResizeStart(cb: (e: PointerEvent) => void): void {
    this.resizeCb = cb;
  }

  /**
   * Handle de rotação (PR11): círculo no canto do bbox da seleção.
   * Clique = reseta rotação (reto); arrastar = gira em torno do eixo Y.
   */
  setRotateHandle(screen: { x: number; y: number } | null): void {
    if (screen === null) {
      if (this.rotateEl) this.rotateEl.style.display = 'none';
      return;
    }
    if (!this.rotateEl) {
      const el = document.createElement('div');
      el.className = 'rotate-handle';
      el.title = t('hint.rotateHandle');
      el.setAttribute('aria-label', t('hint.rotateHandle'));
      el.textContent = '↻';
      el.style.pointerEvents = 'auto';
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.rotateCb?.(e);
      });
      this.root.appendChild(el);
      this.rotateEl = el;
    }
    this.rotateEl.style.display = 'block';
    this.rotateEl.style.left = `${screen.x}px`;
    this.rotateEl.style.top = `${screen.y}px`;
  }

  /** Registra o callback de início do gesto de rotação. */
  onRotateStart(cb: (e: PointerEvent) => void): void {
    this.rotateCb = cb;
  }

  /** Registra callback da barra deslizável de zoom (distância da câmera). */
  onZoomSlider(cb: (distance: number) => void): void {
    this.zoomSliderCb = cb;
  }

  /**
   * Sincroniza a barra de zoom com a distância real da câmera.
   * val = round((460 - distance) / 4.36), clamped 0–100.
   */
  setZoomSliderValue(distance: number): void {
    const val = Math.round((460 - distance) / 4.36);
    const clamped = Math.max(0, Math.min(100, val));
    if (this.zoomSliderEl) this.zoomSliderEl.value = String(clamped);
    if (this.zoomValueEl) this.zoomValueEl.textContent = String(clamped);
  }

  /**
   * Editor inline de nota: textarea amarelo posicionado sobre a cena.
   * Resolve com o texto salvo; string vazia = descartar.
   */
  editNote(
    screen: { x: number; y: number },
    initial: string,
    placeholder = t('ui.notePlaceholder'),
  ): Promise<string> {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'note-editor';
      wrap.style.pointerEvents = 'auto';
      wrap.style.position = 'absolute';
      wrap.style.left = `${Math.min(screen.x, window.innerWidth - 200)}px`;
      wrap.style.top = `${Math.min(screen.y, window.innerHeight - 160)}px`;

      const ta = document.createElement('textarea');
      ta.className = 'note-textarea';
      ta.value = initial;
      ta.placeholder = placeholder;
      ta.rows = 6;

      const row = document.createElement('div');
      row.className = 'note-actions';
      const save = document.createElement('button');
      save.textContent = t('ui.save');
      save.className = 'ctx-item';
      const cancel = document.createElement('button');
      cancel.textContent = t('ui.cancel');
      cancel.className = 'ctx-item';

      const done = (text: string) => {
        wrap.remove();
        resolve(text);
      };
      save.onclick = () => done(ta.value.trim());
      cancel.onclick = () => done(initial); // cancela = mantém o texto original

      row.appendChild(save);
      row.appendChild(cancel);
      wrap.appendChild(ta);
      wrap.appendChild(row);
      this.root.appendChild(wrap);
      ta.focus();
    });
  }

  /** PR4.12 — Modal de Perfil de Usuário com troca de foto, troca de senha e logout. */
  showUserProfileModal(spec: {
    name: string;
    email?: string;
    username?: string;
    photo?: string | null;
    isAuth: boolean;
    taigaConnected: boolean;
    onChangePhoto?: (dataUrl: string) => void;
    onChangePassword?: (currentPass: string, newPass: string) => Promise<{ ok: boolean; error?: string }>;
    onSignOut?: () => void;
    onConnectTaiga?: (user: string, pass: string, token?: string) => Promise<{ ok: boolean; error?: string }>;
    onAppAuth?: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  }): void {
    const existing = this.root.querySelector('.user-profile-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.className = 'user-profile-modal';
    m.style.pointerEvents = 'auto';

    const card = document.createElement('div');
    card.className = 'user-profile-card';
    card.style.pointerEvents = 'auto';

    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) e.stopPropagation();
    });

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      m.remove();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', onKey);

    m.addEventListener('click', (e) => {
      if (e.target === m) cleanup();
    });

    // Botão Fechar
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'user-profile-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Fechar';
    closeBtn.addEventListener('click', cleanup);
    card.appendChild(closeBtn);

    // Header com Avatar e Nome
    const header = document.createElement('div');
    header.className = 'user-profile-header';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'user-profile-avatar-wrap';

    const avatarEl = document.createElement('div');
    avatarEl.className = 'user-profile-avatar-large';

    const renderAvatarImg = (photoSrc: string | null | undefined) => {
      avatarEl.innerHTML = '';
      if (photoSrc) {
        const img = document.createElement('img');
        img.src = photoSrc;
        avatarEl.appendChild(img);
      } else {
        const initials = spec.name
          .split(' ')
          .filter(Boolean)
          .map((s) => s[0])
          .slice(0, 2)
          .join('')
          .toUpperCase() || 'U';
        avatarEl.textContent = spec.isAuth ? initials : '👤';
      }
    };
    renderAvatarImg(spec.photo);

    // Botão de trocar foto de perfil
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          renderAvatarImg(reader.result);
          spec.onChangePhoto?.(reader.result);
        }
      };
      reader.readAsDataURL(file);
    });

    const changePhotoBtn = document.createElement('button');
    changePhotoBtn.type = 'button';
    changePhotoBtn.className = 'user-profile-change-photo-btn';
    changePhotoBtn.innerHTML = '📷 ' + t('ui.profile.changePhoto');
    changePhotoBtn.addEventListener('click', () => fileInput.click());

    avatarWrap.appendChild(avatarEl);
    avatarWrap.appendChild(fileInput);
    avatarWrap.appendChild(changePhotoBtn);
    header.appendChild(avatarWrap);

    // Nome
    const nameEl = document.createElement('div');
    nameEl.className = 'user-profile-name';
    nameEl.textContent = spec.name || (spec.isAuth ? 'Usuário Autenticado' : 'Visitante');
    header.appendChild(nameEl);

    // Email
    if (spec.email) {
      const emailEl = document.createElement('div');
      emailEl.className = 'user-profile-email';
      emailEl.textContent = spec.email;
      header.appendChild(emailEl);
    }

    // Badge de status
    const badge = document.createElement('div');
    badge.className = `user-profile-badge ${spec.taigaConnected ? 'connected' : 'disconnected'}`;
    badge.textContent = spec.taigaConnected
      ? '✓ Taiga FNDE Conectado'
      : '○ Não conectado ao Taiga';
    header.appendChild(badge);

    card.appendChild(header);

    // Seção de Trocar Senha ou Fazer Login
    if (spec.isAuth || spec.taigaConnected) {
      // 1. Seção Trocar Senha
      const passSec = document.createElement('div');
      passSec.className = 'user-profile-section';

      const togglePassBtn = document.createElement('button');
      togglePassBtn.type = 'button';
      togglePassBtn.className = 'user-profile-btn-outline';
      togglePassBtn.innerHTML = '🔑 ' + t('ui.profile.changePassword');

      const passForm = document.createElement('form');
      passForm.className = 'user-profile-form';
      passForm.style.display = 'none';

      const curPassInput = document.createElement('input');
      curPassInput.type = 'password';
      curPassInput.className = 'user-profile-input';
      curPassInput.placeholder = t('ui.profile.currentPass');
      curPassInput.required = true;

      const newPassInput = document.createElement('input');
      newPassInput.type = 'password';
      newPassInput.className = 'user-profile-input';
      newPassInput.placeholder = t('ui.profile.newPass');
      newPassInput.required = true;

      const confirmPassInput = document.createElement('input');
      confirmPassInput.type = 'password';
      confirmPassInput.className = 'user-profile-input';
      confirmPassInput.placeholder = t('ui.profile.confirmPass');
      confirmPassInput.required = true;

      const passStatus = document.createElement('div');
      passStatus.style.fontSize = '12px';
      passStatus.style.display = 'none';

      const submitPassBtn = document.createElement('button');
      submitPassBtn.type = 'submit';
      submitPassBtn.className = 'user-profile-submit';
      submitPassBtn.textContent = t('ui.profile.updatePassBtn');

      passForm.appendChild(curPassInput);
      passForm.appendChild(newPassInput);
      passForm.appendChild(confirmPassInput);
      passForm.appendChild(passStatus);
      passForm.appendChild(submitPassBtn);

      togglePassBtn.addEventListener('click', () => {
        const isHidden = passForm.style.display === 'none';
        passForm.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) curPassInput.focus();
      });

      passForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cur = curPassInput.value;
        const n1 = newPassInput.value;
        const n2 = confirmPassInput.value;
        if (n1 !== n2) {
          passStatus.style.display = 'block';
          passStatus.style.color = '#f87171';
          passStatus.textContent = t('ui.profile.passMismatch');
          return;
        }
        submitPassBtn.disabled = true;
        submitPassBtn.textContent = '...';
        passStatus.style.display = 'none';
        try {
          const res = await spec.onChangePassword?.(cur, n1);
          if (res?.ok) {
            passStatus.style.display = 'block';
            passStatus.style.color = '#34d399';
            passStatus.textContent = t('ui.profile.passSuccess');
            curPassInput.value = '';
            newPassInput.value = '';
            confirmPassInput.value = '';
            this.toast(t('ui.profile.passSuccess'));
          } else {
            passStatus.style.display = 'block';
            passStatus.style.color = '#f87171';
            passStatus.textContent = res?.error || t('ui.taiga.invalidCredentials');
          }
        } catch (err: unknown) {
          passStatus.style.display = 'block';
          passStatus.style.color = '#f87171';
          passStatus.textContent = err instanceof Error ? t(err.message) : t('ui.taiga.httpError');
        } finally {
          submitPassBtn.disabled = false;
          submitPassBtn.textContent = t('ui.profile.updatePassBtn');
        }
      });

      passSec.appendChild(togglePassBtn);
      passSec.appendChild(passForm);
      card.appendChild(passSec);

      // 2. Seção Sair do Sistema
      const outSec = document.createElement('div');
      outSec.className = 'user-profile-section';

      const signOutBtn = document.createElement('button');
      signOutBtn.type = 'button';
      signOutBtn.className = 'user-profile-btn-danger';
      signOutBtn.innerHTML = '🚪 ' + t('ui.profile.signOut');
      signOutBtn.addEventListener('click', () => {
        cleanup();
        spec.onSignOut?.();
      });

      outSec.appendChild(signOutBtn);
      card.appendChild(outSec);
    } else {
      // Seção Login / Cadastro — oferece ambos: Conta do App + Taiga FNDE
      const loginSec = document.createElement('div');
      loginSec.className = 'user-profile-section';

      // Abas para alternar entre App Auth e Taiga Auth
      const tabs = document.createElement('div');
      tabs.className = 'user-profile-tabs';

      const appTab = document.createElement('button');
      appTab.type = 'button';
      appTab.className = 'user-profile-tab active';
      appTab.textContent = t('ui.profile.appAuth');

      const taigaTab = document.createElement('button');
      taigaTab.type = 'button';
      taigaTab.className = 'user-profile-tab';
      taigaTab.textContent = t('ui.profile.taigaAuth');

      tabs.appendChild(appTab);
      tabs.appendChild(taigaTab);
      loginSec.appendChild(tabs);

      // Painel App Auth (e-mail/senha do BumpTop)
      const appPanel = document.createElement('div');
      appPanel.className = 'user-profile-panel active';

      const appTitle = document.createElement('div');
      appTitle.style.fontSize = '13px';
      appTitle.style.fontWeight = '700';
      appTitle.style.marginBottom = '10px';
      appTitle.textContent = t('ui.profile.signIn');
      appPanel.appendChild(appTitle);

      const appForm = document.createElement('form');
      appForm.className = 'user-profile-form';

      const appEmailInput = document.createElement('input');
      appEmailInput.type = 'email';
      appEmailInput.className = 'user-profile-input';
      appEmailInput.placeholder = t('ui.authEmail');
      appEmailInput.required = true;
      appEmailInput.autocomplete = 'email';

      const appPassInput = document.createElement('input');
      appPassInput.type = 'password';
      appPassInput.className = 'user-profile-input';
      appPassInput.placeholder = t('ui.authPassword');
      appPassInput.required = true;
      appPassInput.autocomplete = 'current-password';

      const appStatus = document.createElement('div');
      appStatus.style.fontSize = '12px';
      appStatus.style.display = 'none';

      const appSubmitBtn = document.createElement('button');
      appSubmitBtn.type = 'submit';
      appSubmitBtn.className = 'user-profile-submit';
      appSubmitBtn.textContent = t('ui.authSubmit');

      // Link "Esqueci a senha"
      const appForgotLink = document.createElement('a');
      appForgotLink.href = '#';
      appForgotLink.className = 'user-profile-forgot';
      appForgotLink.textContent = t('ui.authForgot');
      appForgotLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.showForgotPasswordModal();
      });

      appForm.appendChild(appEmailInput);
      appForm.appendChild(appPassInput);
      appForm.appendChild(appStatus);
      appForm.appendChild(appSubmitBtn);
      appForm.appendChild(appForgotLink);
      appPanel.appendChild(appForm);

      // Link "Criar conta" (alterna p/ modo cadastro no modal de auth)
      const appSwitchLink = document.createElement('a');
      appSwitchLink.href = '#';
      appSwitchLink.style.fontSize = '12px';
      appSwitchLink.style.marginTop = '8px';
      appSwitchLink.style.display = 'block';
      appSwitchLink.textContent = t('ui.authSwitchUp');
      appSwitchLink.addEventListener('click', (e) => {
        e.preventDefault();
        cleanup();
        // Abre o modal de auth em modo cadastro
        this.showAuthModal({ mode: 'up', email: '', error: null });
      });
      appPanel.appendChild(appSwitchLink);

      // Painel Taiga Auth
      const taigaPanel = document.createElement('div');
      taigaPanel.className = 'user-profile-panel';
      taigaPanel.style.display = 'none';

      const taigaTitle = document.createElement('div');
      taigaTitle.style.fontSize = '13px';
      taigaTitle.style.fontWeight = '700';
      taigaTitle.style.marginBottom = '10px';
      taigaTitle.textContent = t('ui.profile.signIn');
      taigaPanel.appendChild(taigaTitle);

      const taigaForm = document.createElement('form');
      taigaForm.className = 'user-profile-form';

      const userInput = document.createElement('input');
      userInput.type = 'text';
      userInput.className = 'user-profile-input';
      userInput.placeholder = t('ui.taiga.userPh');
      userInput.required = true;

      const passInput = document.createElement('input');
      passInput.type = 'password';
      passInput.className = 'user-profile-input';
      passInput.placeholder = t('ui.taiga.passLabel');
      passInput.required = true;

      const tokenInput = document.createElement('input');
      tokenInput.type = 'text';
      tokenInput.className = 'user-profile-input';
      tokenInput.placeholder = t('ui.taiga.tokenPh');
      tokenInput.style.marginTop = '8px';

      const taigaStatus = document.createElement('div');
      taigaStatus.style.fontSize = '12px';
      taigaStatus.style.display = 'none';

      const taigaBtn = document.createElement('button');
      taigaBtn.type = 'submit';
      taigaBtn.className = 'user-profile-submit';
      taigaBtn.textContent = t('ui.taiga.testAndAuth');

      taigaForm.appendChild(userInput);
      taigaForm.appendChild(passInput);
      taigaForm.appendChild(tokenInput);
      taigaForm.appendChild(taigaStatus);
      taigaForm.appendChild(taigaBtn);
      taigaPanel.appendChild(taigaForm);

      loginSec.appendChild(appPanel);
      loginSec.appendChild(taigaPanel);
      card.appendChild(loginSec);

      // Alternância de abas
      const switchTab = (showApp: boolean) => {
        appTab.classList.toggle('active', showApp);
        taigaTab.classList.toggle('active', !showApp);
        appPanel.style.display = showApp ? 'block' : 'none';
        taigaPanel.style.display = showApp ? 'none' : 'block';
      };
      appTab.addEventListener('click', () => switchTab(true));
      taigaTab.addEventListener('click', () => switchTab(false));

      // Submit App Auth
      appForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        appSubmitBtn.disabled = true;
        appSubmitBtn.textContent = '...';
        appStatus.style.display = 'none';
        try {
          const email = appEmailInput.value.trim().toLowerCase();
          const password = appPassInput.value;
          // Usa o auth do app (cloudflareAuth)
          const res = await spec.onAppAuth?.(email, password);
          if (res?.ok) {
            cleanup();
          } else {
            appStatus.style.display = 'block';
            appStatus.style.color = '#f87171';
            appStatus.textContent = res?.error || t('toast.authFailed');
          }
        } catch (err: unknown) {
          appStatus.style.display = 'block';
          appStatus.style.color = '#f87171';
          appStatus.textContent = err instanceof Error ? t(err.message) : t('toast.authFailed');
        } finally {
          appSubmitBtn.disabled = false;
          appSubmitBtn.textContent = t('ui.authSubmit');
        }
      });

      // Submit Taiga Auth
      taigaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        taigaBtn.disabled = true;
        taigaBtn.textContent = '...';
        taigaStatus.style.display = 'none';
        try {
          const res = await spec.onConnectTaiga?.(userInput.value, passInput.value, tokenInput.value || undefined);
          if (res?.ok) {
            cleanup();
          } else {
            taigaStatus.style.display = 'block';
            taigaStatus.style.color = '#f87171';
            taigaStatus.textContent = res?.error || t('ui.taiga.invalidCredentials');
          }
        } catch (err: unknown) {
          taigaStatus.style.display = 'block';
          taigaStatus.style.color = '#f87171';
          taigaStatus.textContent = err instanceof Error ? t(err.message) : t('ui.taiga.invalidCredentials');
        } finally {
          taigaBtn.disabled = false;
          taigaBtn.textContent = t('ui.taiga.testAndAuth');
        }
      });
    }

    m.appendChild(card);
    this.root.appendChild(m);
  }

  /** PR4.12 fix — Modal "Esqueci a senha" (app auth). */
  showForgotPasswordModal(): void {
    const existing = this.root.querySelector('.forgot-password-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.className = 'forgot-password-modal';
    m.style.pointerEvents = 'auto';

    const card = document.createElement('div');
    card.className = 'forgot-password-card';
    card.style.pointerEvents = 'auto';

    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) m.remove();
    });

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      m.remove();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', onKey);

    m.addEventListener('click', (e) => {
      if (e.target === m) cleanup();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'forgot-password-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Fechar';
    closeBtn.addEventListener('click', cleanup);
    card.appendChild(closeBtn);

    const title = document.createElement('h2');
    title.className = 'forgot-password-title';
    title.textContent = t('ui.authForgot');
    card.appendChild(title);

    const desc = document.createElement('p');
    desc.style.fontSize = '13px';
    desc.style.color = 'var(--muted, #64748b)';
    desc.style.margin = '0 0 16px';
    desc.textContent = t('ui.authResetSent');
    card.appendChild(desc);

    const form = document.createElement('form');
    form.className = 'forgot-password-form';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.className = 'forgot-password-input';
    emailInput.placeholder = t('ui.authEmail');
    emailInput.required = true;
    emailInput.autocomplete = 'email';

    const status = document.createElement('div');
    status.style.fontSize = '12px';
    status.style.display = 'none';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'forgot-password-submit';
    submitBtn.textContent = t('ui.authForgot');

    form.appendChild(emailInput);
    form.appendChild(status);
    form.appendChild(submitBtn);
    card.appendChild(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      submitBtn.textContent = '...';
      status.style.display = 'none';
      try {
        // TODO: integrar com backend de reset de senha quando houver
        // Por enquanto simula sucesso (não expõe se e-mail existe)
        await new Promise((r) => setTimeout(r, 500));
        status.style.display = 'block';
        status.style.color = '#34d399';
        status.textContent = t('ui.authResetSent');
        setTimeout(cleanup, 1500);
      } catch (err: unknown) {
        status.style.display = 'block';
        status.style.color = '#f87171';
        status.textContent = t('ui.authResetError');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = t('ui.authForgot');
      }
    });

    m.appendChild(card);
    this.root.appendChild(m);
    emailInput.focus();
  }

  hideUserProfileModal(): void {
    const existing = this.root.querySelector('.user-profile-modal');
    if (existing) existing.remove();
  }

  /** PR4.9 — Modal de inspeção e detalhes completos de uma User Story do Taiga. */
  showStoryModal(story: TaigaStoryDetail): void {
    const existing = this.root.querySelector('.story-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.className = 'story-modal';
    m.style.pointerEvents = 'auto';

    const card = document.createElement('div');
    card.className = 'story-card';
    card.style.pointerEvents = 'auto';

    // Evita propagação de cliques/drag para a cena 3D abaixo
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) e.stopPropagation();
    });

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      m.remove();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', onKey);

    m.addEventListener('click', (e) => {
      if (e.target === m) cleanup();
    });

    // Header
    const header = document.createElement('div');
    header.className = 'story-header';
    const title = document.createElement('h3');
    title.className = 'story-title';
    title.textContent = `#${story.ref} ${story.subject}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'boxes-close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('ui.close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
    header.appendChild(title);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Meta row (Badges)
    const metaRow = document.createElement('div');
    metaRow.className = 'story-meta-row';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'story-badge';
    statusBadge.style.backgroundColor = story.statusColor || '#8b5cf6';
    statusBadge.style.color = '#fff';
    statusBadge.textContent = story.statusName;
    metaRow.appendChild(statusBadge);

    if (story.milestoneName) {
      const sprintBadge = document.createElement('span');
      sprintBadge.className = 'story-badge';
      sprintBadge.style.backgroundColor = 'rgba(14, 165, 233, 0.2)';
      sprintBadge.style.color = '#38bdf8';
      sprintBadge.textContent = `🏃 ${story.milestoneName}`;
      metaRow.appendChild(sprintBadge);
    }

    if (story.totalPoints !== undefined && story.totalPoints !== null) {
      const pointsBadge = document.createElement('span');
      pointsBadge.className = 'story-badge';
      pointsBadge.style.backgroundColor = 'rgba(234, 179, 8, 0.2)';
      pointsBadge.style.color = '#facc15';
      pointsBadge.textContent = `⭐ ${story.totalPoints} pts`;
      metaRow.appendChild(pointsBadge);
    }

    if (story.projectName || story.projectSlug) {
      const projBadge = document.createElement('span');
      projBadge.className = 'story-badge';
      projBadge.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
      projBadge.style.color = '#e2e8f0';
      projBadge.textContent = `🏢 ${story.projectName || story.projectSlug}`;
      metaRow.appendChild(projBadge);
    }
    card.appendChild(metaRow);

    // Body
    const body = document.createElement('div');
    body.className = 'story-body';

    // Responsável
    const assignedSec = document.createElement('div');
    const assignedTitle = document.createElement('div');
    assignedTitle.className = 'story-section-title';
    assignedTitle.textContent = 'Atribuído a';
    const assignedVal = document.createElement('div');
    assignedVal.className = 'story-user-badge';
    if (story.assignedToPhoto) {
      const img = document.createElement('img');
      img.className = 'story-user-avatar';
      img.src = story.assignedToPhoto;
      img.alt = story.assignedToName || '';
      assignedVal.appendChild(img);
    } else {
      const icon = document.createElement('span');
      icon.textContent = '👤';
      assignedVal.appendChild(icon);
    }
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = story.assignedToName || 'Não atribuído';
    assignedVal.appendChild(nameSpan);
    assignedSec.appendChild(assignedTitle);
    assignedSec.appendChild(assignedVal);
    body.appendChild(assignedSec);

    // Criador / Owner
    if (story.ownerName) {
      const ownerSec = document.createElement('div');
      const ownerTitle = document.createElement('div');
      ownerTitle.className = 'story-section-title';
      ownerTitle.textContent = 'Criado por';
      const ownerVal = document.createElement('div');
      ownerVal.className = 'story-user-badge';
      ownerVal.innerHTML = `<span>✍️</span> <span>${story.ownerName}</span>`;
      ownerSec.appendChild(ownerTitle);
      ownerSec.appendChild(ownerVal);
      body.appendChild(ownerSec);
    }

    // Descrição / Escopo
    const descSec = document.createElement('div');
    const descTitle = document.createElement('div');
    descTitle.className = 'story-section-title';
    descTitle.textContent = 'Descrição / Escopo';
    const descBox = document.createElement('div');
    descBox.className = 'story-desc-box';
    descBox.textContent = story.description || 'Nenhuma descrição detalhada informada.';
    descSec.appendChild(descTitle);
    descSec.appendChild(descBox);
    body.appendChild(descSec);

    card.appendChild(body);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'story-footer';
    const closeBtn2 = document.createElement('button');
    closeBtn2.type = 'button';
    closeBtn2.className = 'boxes-taiga-btn';
    closeBtn2.textContent = t('ui.close');
    closeBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
    footer.appendChild(closeBtn2);

    if (story.projectSlug && story.ref) {
      const link = document.createElement('a');
      link.className = 'story-link-btn';
      link.href = `https://taiga.fnde.gov.br/project/${story.projectSlug}/us/${story.ref}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Abrir no Taiga ↗';
      footer.appendChild(link);
    }
    card.appendChild(footer);

    m.appendChild(card);
    this.root.appendChild(m);
  }

  /** PR4.15 — Modal interativo de escolha de Sprint para a caixa. */
  showSprintPickerModal(spec: {
    boxName: string;
    projectName?: string;
    currentSprintId?: number;
    sprints: TaigaSprint[];
    onSelect: (sprint: TaigaSprint) => void | Promise<void>;
  }): void {
    const existing = this.root.querySelector('.sprint-picker-modal');
    if (existing) existing.remove();

    const m = document.createElement('div');
    m.className = 'sprint-picker-modal';
    m.style.pointerEvents = 'auto';

    const card = document.createElement('div');
    card.className = 'sprint-picker-card';
    card.style.pointerEvents = 'auto';

    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    card.addEventListener('click', (e) => e.stopPropagation());
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m) e.stopPropagation();
    });

    const cleanup = () => {
      window.removeEventListener('keydown', onKey);
      m.remove();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    };
    window.addEventListener('keydown', onKey);

    m.addEventListener('click', (e) => {
      if (e.target === m) cleanup();
    });

    // Header
    const header = document.createElement('div');
    header.className = 'sprint-picker-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'sprint-picker-title';
    title.innerHTML = `🏃 ${t('ui.sprintPickerTitle')}`;

    const sub = document.createElement('p');
    sub.className = 'sprint-picker-sub';
    sub.textContent = `${spec.boxName}${spec.projectName ? ` • ${spec.projectName}` : ''}`;

    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'boxes-close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('ui.close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // List
    const list = document.createElement('div');
    list.className = 'sprint-picker-list';

    if (spec.sprints.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sprint-picker-empty';
      empty.textContent = t('ui.sprintNoSprints');
      list.appendChild(empty);
    } else {
      for (const s of spec.sprints) {
        const item = document.createElement('div');
        const isCur = s.id === spec.currentSprintId;
        item.className = isCur ? 'sprint-picker-item current' : 'sprint-picker-item';

        const info = document.createElement('div');
        info.className = 'sprint-picker-item-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'sprint-picker-item-name';
        nameEl.textContent = s.name;
        info.appendChild(nameEl);

        if (s.estimated_start || s.estimated_finish) {
          const datesEl = document.createElement('div');
          datesEl.className = 'sprint-picker-item-dates';
          datesEl.textContent = `${s.estimated_start ?? '—'} até ${s.estimated_finish ?? '—'}`;
          info.appendChild(datesEl);
        }

        const badges = document.createElement('div');
        badges.className = 'sprint-picker-badges';

        const statusBadge = document.createElement('span');
        statusBadge.className = s.closed
          ? 'sprint-status-badge sprint-status-closed'
          : 'sprint-status-badge sprint-status-active';
        statusBadge.textContent = s.closed ? t('ui.sprintClosed') : t('ui.sprintActive');
        badges.appendChild(statusBadge);

        if (isCur) {
          const curBadge = document.createElement('span');
          curBadge.className = 'sprint-current-badge';
          curBadge.textContent = `✓ ${t('ui.sprintCurrent')}`;
          badges.appendChild(curBadge);
        }

        item.appendChild(info);
        item.appendChild(badges);

        item.addEventListener('click', () => {
          cleanup();
          void spec.onSelect(s);
        });

        list.appendChild(item);
      }
    }

    card.appendChild(list);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'sprint-picker-footer';
    const closeBtn2 = document.createElement('button');
    closeBtn2.type = 'button';
    closeBtn2.className = 'boxes-taiga-btn';
    closeBtn2.textContent = t('ui.close');
    closeBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      cleanup();
    });
    footer.appendChild(closeBtn2);
    card.appendChild(footer);

    m.appendChild(card);
    this.root.appendChild(m);
  }

  /**
   * Modal de pré-visualização in-app (item 3): imagem, PDF ou texto.
   * Fecha com ✕, Esc ou clique no fundo; revoga a `url` (blob) ao fechar.
   */
  showPreview(spec: { name: string; mime: string; url?: string; text?: string }): void {
    this.hidePreview();

    const backdrop = document.createElement('div');
    backdrop.className = 'file-preview-backdrop';
    backdrop.style.pointerEvents = 'auto';

    const modal = document.createElement('div');
    modal.className = 'file-preview';
    modal.dataset.testid = 'file-preview';

    const head = document.createElement('div');
    head.className = 'file-preview-head';
    const title = document.createElement('span');
    title.className = 'file-preview-name';
    title.textContent = spec.name;
    const close = document.createElement('button');
    close.className = 'file-preview-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', t('ui.previewClose'));
    close.title = t('ui.previewClose');
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = 'file-preview-body';
    if (spec.url && spec.mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'file-preview-image';
      img.src = spec.url;
      img.alt = spec.name;
      body.appendChild(img);
    } else if (spec.url && spec.mime === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'file-preview-pdf';
      frame.src = spec.url;
      frame.title = spec.name;
      body.appendChild(frame);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'file-preview-text';
      pre.textContent = spec.text ?? '';
      body.appendChild(pre);
    }

    modal.appendChild(head);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    this.root.appendChild(backdrop);

    const hide = () => this.hidePreview();
    close.onclick = hide;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) hide();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);

    this.previewEl = backdrop;
    this.previewCleanup = () => {
      document.removeEventListener('keydown', onKey);
      if (spec.url) URL.revokeObjectURL(spec.url);
    };
  }

  /** Esconde o modal de pré-visualização e revoga a url (blob). */
  hidePreview(): void {
    if (!this.previewEl) return;
    this.previewEl.remove();
    this.previewEl = null;
    this.previewCleanup?.();
    this.previewCleanup = null;
  }

  /**
   * PR12 — editor RICO de nota em modal GRANDE (estilo Keep): formatação
   * (H1/H2/Aa/B/I/U/S via markdown-lite), cor de fundo, lembrete, checklist,
   * desenho em canvas e undo/redo. Fechar (✕/Esc/backdrop) salva e resolve
   * com o estado final. `null` nunca — o cancelamento é o undo.
   */
  editNoteRich(spec: {
    title: string;
    text: string;
    bg?: string;
    drawing?: string | null;
    reminder?: number | null;
  }): Promise<{ title: string; text: string; bg: string; drawing: string | null; reminder: number | null }> {
    return new Promise((resolve) => {
      const draft = {
        title: spec.title,
        text: spec.text,
        bg: spec.bg ?? '#ffd43b',
        drawing: spec.drawing ?? null,
        reminder: spec.reminder ?? null,
      };

      const backdrop = document.createElement('div');
      backdrop.className = 'note-rich-backdrop';
      backdrop.style.pointerEvents = 'auto';
      const modal = document.createElement('div');
      modal.className = 'note-rich-modal';
      modal.dataset.testid = 'note-rich';
      modal.style.background = draft.bg;

      // ---- Cabeçalho: título + ✕ ----
      const head = document.createElement('div');
      head.className = 'note-rich-head';
      const titleIn = document.createElement('input');
      titleIn.className = 'note-rich-title';
      titleIn.type = 'text';
      titleIn.placeholder = t('ui.noteTitlePlaceholder');
      titleIn.value = draft.title;
      titleIn.addEventListener('input', () => {
        draft.title = titleIn.value;
        pushUndo();
      });
      const closeBtn = document.createElement('button');
      closeBtn.className = 'note-rich-close';
      closeBtn.textContent = '✕';
      closeBtn.title = t('ui.close');
      head.appendChild(titleIn);
      head.appendChild(closeBtn);

      // ---- Corpo: editor WYSIWYG (contentEditable) ou canvas (desenho) ----
      // PR13 — a formatação renderiza NO ATO (sem ** / # visíveis): o editor
      // é um contentEditable com blocos .nl-line; o modelo de armazenamento
      // continua markdown-lite (serializado do DOM a cada digitação).
      const body = document.createElement('div');
      body.className = 'note-rich-body';
      const editor = document.createElement('div');
      editor.className = 'note-rich-content';
      editor.contentEditable = 'true';
      editor.setAttribute('role', 'textbox');
      editor.dataset.placeholder = t('ui.notePlaceholder');
      editor.innerHTML = noteTextToHtml(draft.text);
      editor.classList.toggle('empty', draft.text === '');
      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'note-rich-canvas-wrap';
      canvasWrap.style.display = 'none';
      const canvas = document.createElement('canvas');
      canvas.className = 'note-rich-canvas';
      const drawBar = document.createElement('div');
      drawBar.className = 'note-rich-draw-bar';
      canvasWrap.appendChild(canvas);
      canvasWrap.appendChild(drawBar);
      body.appendChild(editor);
      body.appendChild(canvasWrap);

      // ---- Pilhas de undo/redo (snapshots título+texto) ----
      const undoStack: Array<{ title: string; text: string }> = [];
      const redoStack: Array<{ title: string; text: string }> = [];
      let undoTimer = 0;
      let lastSnap = JSON.stringify({ title: draft.title, text: draft.text });
      const pushUndo = () => {
        const snap = JSON.stringify({ title: draft.title, text: draft.text });
        if (snap === lastSnap) return;
        undoStack.push(JSON.parse(lastSnap) as { title: string; text: string });
        if (undoStack.length > 60) undoStack.shift();
        redoStack.length = 0;
        lastSnap = snap;
      };
      const scheduleUndo = () => {
        window.clearTimeout(undoTimer);
        undoTimer = window.setTimeout(pushUndo, 400);
      };
      const applySnap = (s: { title: string; text: string }) => {
        draft.title = s.title;
        draft.text = s.text;
        titleIn.value = s.title;
        editor.innerHTML = noteTextToHtml(s.text);
        editor.classList.toggle('empty', s.text === '');
        lastSnap = JSON.stringify(s);
      };
      const doUndo = () => {
        if (undoStack.length === 0) return;
        redoStack.push(JSON.parse(lastSnap) as { title: string; text: string });
        applySnap(undoStack.pop()!);
      };
      const doRedo = () => {
        if (redoStack.length === 0) return;
        undoStack.push(JSON.parse(lastSnap) as { title: string; text: string });
        applySnap(redoStack.pop()!);
      };

      // ---- PR13 — DOM ⇄ markdown-lite (WYSIWYG) ----
      type St = { b: boolean; i: boolean; u: boolean; s: boolean };
      const styleOf = (e: HTMLElement, st: St): St => {
        const tag = e.tagName.toLowerCase();
        const s2: St = { ...st };
        if (tag === 'b' || tag === 'strong') s2.b = true;
        else if (tag === 'i' || tag === 'em') s2.i = true;
        else if (tag === 'u') s2.u = true;
        else if (tag === 's' || tag === 'strike' || tag === 'del') s2.s = true;
        return s2;
      };
      /**
       * Serializa a linha p/ markdown E devolve o mapa DOM→markdown
       * (`map[domIdx] = mdIdx`) — usado p/ dividir a linha no cursor no Enter.
       */
      const serializeMapped = (line: HTMLElement): { md: string; map: number[] } => {
        const map: number[] = [];
        let out = '';
        const add = (t: string): number => {
          for (let k = 0; k < t.length; k++) map.push(out.length + k);
          out += t;
          return t.length;
        };
        const wrapSeg = (
          mdStart: number,
          mdEnd: number,
          domStart: number,
          domN: number,
          pre: string,
        ) => {
          if (mdEnd <= mdStart) return;
          const suf = [...pre].reverse().join('');
          out = out.slice(0, mdStart) + pre + out.slice(mdStart, mdEnd) + suf + out.slice(mdEnd);
          for (let k = domStart; k < domStart + domN && k < map.length; k++) map[k] += pre.length;
        };
        const walk = (n: Node, st: St): number => {
          if (n.nodeType === Node.TEXT_NODE) return add(n.textContent ?? '');
          if (n.nodeType !== Node.ELEMENT_NODE) return 0;
          const e = n as HTMLElement;
          if (e.classList.contains('nl-box')) return 0; // checkbox não é texto
          if (e.tagName === 'BR') return 0; // quebra visual, não de modelo
          const st2 = styleOf(e, st);
          const domStart = map.length;
          const mdStart = out.length;
          let domN = 0;
          e.childNodes.forEach((c) => {
            domN += walk(c, st2);
          });
          const mdEnd = out.length;
          let off = 0;
          if (st2.b && !st.b) {
            wrapSeg(mdStart + off, mdEnd + off, domStart, domN, '**');
            off += 2;
          }
          if (st2.i && !st.i) {
            wrapSeg(mdStart + off, mdEnd + off, domStart, domN, '*');
            off += 1;
          }
          if (st2.u && !st.u) {
            wrapSeg(mdStart + off, mdEnd + off, domStart, domN, '__');
            off += 2;
          }
          if (st2.s && !st.s) {
            wrapSeg(mdStart + off, mdEnd + off, domStart, domN, '~~');
            off += 2;
          }
          return domN;
        };
        walk(line, { b: false, i: false, u: false, s: false });
        return { md: out, map };
      };
      /**
       * PR4.17 — posiciona o cursor numa contagem de caracteres do texto do
       * editor. Usado para restaurar a seleção depois de reconstruir o DOM.
       */
      const placeCaretAtTextOffset = (off: number): void => {
        const sel = window.getSelection();
        if (!sel) return;
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let node = walker.nextNode() as Text | null;
        let last: Text | null = null;
        while (node) {
          const len = node.data.length;
          if (acc + len >= off) {
            const r = document.createRange();
            r.setStart(node, Math.max(0, off - acc));
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            return;
          }
          acc += len;
          last = node;
          node = walker.nextNode() as Text | null;
        }
        if (last) {
          const r = document.createRange();
          r.setStart(last, last.data.length);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      };

      /**
       * PR4.17 — ANTI-PERDA: garante que TODO conteúdo do editor esteja dentro
       * de um bloco `.nl-line` antes de serializar.
       *
       * O contentEditable do navegador solta conteúdo fora dos blocos (Ctrl+A
       * e digitar por cima, clique no vazio abaixo do texto, Enter sem linha
       * atual…) e o `serializeRich` lê SÓ `.nl-line`. O texto continuava
       * VISÍVEL na tela, mas o modelo ficava vazio — ao fechar o modal o
       * editor devolvia nota vazia e o chamador apagava a anotação inteira
       * (bug de notas sumindo ao clicar fora/fechar). Todo nó órfão vira
       * bloco pelo mesmo conversor do colar, com o cursor restaurado; com a
       * estrutura íntegra é um no-op (não mexe em nada no caso comum).
       */
      const normalizeEditor = (): void => {
        const isLine = (n: Node): boolean =>
          n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('nl-line');
        // Inócios p/ o modelo: `<br>` e espaço que o navegador deixa na raiz
        // (helper de cursor). Ignorados na hora de decidir se há órfão.
        const isHarmless = (n: Node): boolean =>
          (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).tagName === 'BR') ||
          (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === '');
        const kids = Array.from(editor.childNodes);
        const hasOrphan = kids.some((n) => !isLine(n) && !isHarmless(n));
        if (!hasOrphan) return; // estrutura íntegra — não mexe em nada (caso comum)

        // Posição do cursor em caracteres (restaurada depois do rebuild)
        const sel0 = window.getSelection();
        let caret = -1;
        if (sel0 && sel0.rangeCount > 0 && editor.contains(sel0.anchorNode)) {
          const pre = document.createRange();
          pre.selectNodeContents(editor);
          try {
            pre.setEnd(sel0.anchorNode!, sel0.anchorOffset);
            caret = pre.toString().length;
          } catch {
            caret = -1;
          }
        }

        const frag = document.createDocumentFragment();
        let buf = '';
        const flush = (): void => {
          if (buf === '') return;
          const md = htmlToNoteMd(buf);
          buf = '';
          if (md === '') return;
          const tpl = document.createElement('template');
          tpl.innerHTML = noteTextToHtml(md);
          frag.append(...Array.from(tpl.content.childNodes));
        };
        for (const n of kids) {
          if (isLine(n)) {
            flush();
            frag.appendChild(n);
          } else if (n.nodeType === Node.TEXT_NODE) {
            buf += n.textContent ?? '';
          } else if (n.nodeType === Node.ELEMENT_NODE) {
            buf += (n as HTMLElement).outerHTML;
          }
        }
        flush();

        editor.innerHTML = '';
        if (frag.childNodes.length > 0) editor.appendChild(frag);
        // Sem nenhum bloco (tudo apagado): mantém o bloco raiz vazio p/ o
        // placeholder e para a próxima digitação nascer dentro de um bloco.
        if (editor.querySelectorAll('.nl-line').length === 0) {
          editor.innerHTML = noteTextToHtml('');
        }
        editor.classList.toggle('empty', (editor.textContent ?? '').trim() === '');
        if (caret >= 0) placeCaretAtTextOffset(caret);
      };

      const serializeRich = (): string => {
        normalizeEditor(); // nunca serializar com conteúdo fora dos blocos
        const lines: string[] = [];
        editor.querySelectorAll<HTMLElement>('.nl-line').forEach((line) => {
          const { md } = serializeMapped(line);
          if (line.classList.contains('nl-h1')) lines.push(`# ${md}`);
          else if (line.classList.contains('nl-h2')) lines.push(`## ${md}`);
          else if (line.classList.contains('nl-item')) {
            lines.push(`${line.dataset.done === '1' ? '- [x] ' : '- [ ] '}${md}`);
          } else lines.push(md);
        });
        return lines.join('\n');
      };
      const syncModel = () => {
        draft.text = serializeRich();
        editor.classList.toggle('empty', draft.text === '');
        scheduleUndo();
      };

      // ---- Cursor / blocos ----
      const currentLine = (): HTMLElement | null => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        let n: Node | null = sel.anchorNode;
        while (n && n !== editor) {
          if (n instanceof HTMLElement && n.classList.contains('nl-line')) return n;
          n = n.parentNode;
        }
        return null;
      };
      const caretIndexInLine = (line: HTMLElement): number => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return -1;
        const r = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.selectNodeContents(line);
        try {
          pre.setEnd(r.endContainer, r.endOffset);
        } catch {
          return -1;
        }
        return pre.toString().length;
      };
      const setCaretInLine = (line: HTMLElement, idx: number) => {
        const target = (line.querySelector('.nl-text') as HTMLElement) ?? line;
        const sel = window.getSelection();
        const r = document.createRange();
        r.selectNodeContents(target);
        let left = Math.max(0, idx);
        let placed = false;
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        for (let tn = walker.nextNode(); tn !== null; tn = walker.nextNode()) {
          const t2 = tn as Text;
          if (left <= t2.length) {
            r.setStart(t2, left);
            placed = true;
            break;
          }
          left -= t2.length;
        }
        if (!placed) r.setStart(target, target.childNodes.length);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
      };
      const placeCaretAtStart = (line: HTMLElement) => {
        const target = (line.querySelector('.nl-text') as HTMLElement) ?? line;
        if (target.childNodes.length === 0) target.appendChild(document.createTextNode(''));
        const sel = window.getSelection();
        const r = document.createRange();
        r.setStart(target, 0);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
      };
      const lineKindOf = (line: HTMLElement): 'text' | 'h1' | 'h2' | 'item' => {
        if (line.classList.contains('nl-item')) return 'item';
        if (line.classList.contains('nl-h1')) return 'h1';
        if (line.classList.contains('nl-h2')) return 'h2';
        return 'text';
      };
      /** Substitui a linha por um bloco novo gerado de markdown-lite. */
      const rebuildLine = (
        line: HTMLElement,
        kind: 'text' | 'h1' | 'h2' | 'item',
        done: boolean,
        md: string,
      ): HTMLElement => {
        const raw =
          kind === 'item'
            ? `${done ? '- [x] ' : '- [ ] '}${md}`
            : kind === 'h1'
              ? `# ${md}`
              : kind === 'h2'
                ? `## ${md}`
                : md;
        const tpl = document.createElement('template');
        tpl.innerHTML = noteTextToHtml(raw);
        const nl = tpl.content.firstElementChild as HTMLElement;
        line.replaceWith(nl);
        return nl;
      };

      editor.addEventListener('input', () => syncModel());
      // Undo/redo nativo do contentEditable desativado — pilhas próprias
      editor.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          doUndo();
        } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
          e.preventDefault();
          doRedo();
        }
      });
      /**
       * PR13/PR4.17 — Enter interceptado: cria um bloco NOVO (item→item
       * pendente; h1/h2→texto normal). O Enter nativo clonaria o bloco
       * (checkbox duplo).
       *
       * PR4.17 — cobre TAMBÉM `insertLineBreak` (Shift+Enter) e o caso de
       * cursor FORA dos blocos (clique na área vazia do editor, logo abaixo
       * do texto). Sem isto o Enter nativo injeta `<br>`/texto na RAIZ do
       * editor; o modelo lê só `.nl-line`, ignorava a quebra e ao salvar
       * "tudo grudava numa linha só" (a anotação voltava ao estado antigo,
       * com a formatação perdida). Shift+Enter também não podia virar `<br>`
       * dentro da linha: `serializeMapped` descarta `<br>` de propósito —
       * a quebra simplesmente sumia do modelo.
       */
      editor.addEventListener('beforeinput', (e) => {
        if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;
        e.preventDefault();
        pushUndo();
        const line = currentLine();
        if (!line) {
          // Cursor na raiz do editor: nasce um bloco vazio no ponto do cursor
          const tpl = document.createElement('template');
          tpl.innerHTML = noteTextToHtml('');
          const nl = tpl.content.firstElementChild as HTMLElement;
          const sel = window.getSelection();
          let placed = false;
          if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
            try {
              sel.getRangeAt(0).insertNode(nl);
              placed = true;
            } catch {
              placed = false;
            }
          }
          if (!placed) editor.appendChild(nl);
          placeCaretAtStart(nl);
          syncModel();
          return;
        }
        const { md, map } = serializeMapped(line);
        const domIdx = caretIndexInLine(line);
        const mdIdx = domIdx >= 0 && domIdx < map.length ? map[domIdx] : md.length;
        const left = md.slice(0, mdIdx);
        const right = md.slice(mdIdx);
        const kind = lineKindOf(line);
        const done = line.dataset.done === '1';
        const leftMd =
          kind === 'item'
            ? `${done ? '- [x] ' : '- [ ] '}${left}`
            : kind === 'h1'
              ? `# ${left}`
              : kind === 'h2'
                ? `## ${left}`
                : left;
        const rightMd = kind === 'item' ? `- [ ] ${right}` : right;
        const tpl = document.createElement('template');
        tpl.innerHTML = noteTextToHtml(`${leftMd}\n${rightMd}`);
        const nodes = Array.from(tpl.content.children) as HTMLElement[];
        line.replaceWith(...nodes);
        if (nodes.length > 1) placeCaretAtStart(nodes[1]);
        syncModel();
      });
      // PR16 — COLAR preservando a formatação: converte o HTML da área de
      // transferência (Keep, Gmail, Word...) em markdown-lite com UM bloco
      // por parágrafo. O colar nativo injetava o HTML cru dentro de UMA
      // linha; `<br>`/`<div>` não eram quebras no modelo e tudo grudava.
      editor.addEventListener('paste', (ev: ClipboardEvent) => {
        const dt = ev.clipboardData;
        if (!dt) return;
        ev.preventDefault();
        const html = dt.getData('text/html');
        const plain = dt.getData('text/plain');
        const pastedMd =
          html !== '' ? htmlToNoteMd(html) : (plain ?? '').replace(/\r\n?/g, '\n');
        if (pastedMd === '') return;
        pushUndo();
        const pastedLines = pastedMd.split('\n');
        const line = currentLine();
        if (!line) {
          // Sem cursor no editor: anexa no fim
          const tpl = document.createElement('template');
          tpl.innerHTML = noteTextToHtml(pastedMd);
          const nodes = Array.from(tpl.content.children) as HTMLElement[];
          editor.append(...nodes);
          if (nodes.length > 0) placeCaretAtStart(nodes[nodes.length - 1]);
          syncModel();
          return;
        }
        const kind = lineKindOf(line);
        const done = line.dataset.done === '1';
        const { md: lineMd, map } = serializeMapped(line);
        const domIdx = caretIndexInLine(line);
        const mdIdx = domIdx >= 0 && domIdx < map.length ? map[domIdx] : lineMd.length;
        const left = lineMd.slice(0, mdIdx);
        const right = lineMd.slice(mdIdx);
        const leftMd =
          kind === 'item'
            ? `${done ? '- [x] ' : '- [ ] '}${left}`
            : kind === 'h1'
              ? `# ${left}`
              : kind === 'h2'
                ? `## ${left}`
                : left;
        // A 1ª linha colada entra NO bloco do cursor (herda h1/h2/checklist);
        // as demais viram blocos próprios; a parte direita fecha por último
        const full = [
          leftMd + (pastedLines[0] ?? ''),
          ...pastedLines.slice(1),
          ...(kind === 'item' ? [`- [ ] ${right}`] : right !== '' ? [right] : []),
        ].join('\n');
        const tpl = document.createElement('template');
        tpl.innerHTML = noteTextToHtml(full);
        const nodes = Array.from(tpl.content.children) as HTMLElement[];
        line.replaceWith(...nodes);
        // Cursor no início da linha que carrega a parte direita (se houver)
        const caretAt = right !== '' ? pastedLines.length : Math.max(0, nodes.length - 1);
        if (nodes[caretAt]) placeCaretAtStart(nodes[caretAt]);
        syncModel();
      });
      // PR13 — checkbox CLICÁVEL: marcar ✓ riscado; não rouba o foco
      editor.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest?.('.nl-box')) e.preventDefault();
      });
      editor.addEventListener('click', (e) => {
        const box = (e.target as HTMLElement).closest?.('.nl-box') as HTMLElement | null;
        if (!box) return;
        const line = box.closest('.nl-line') as HTMLElement;
        pushUndo();
        line.dataset.done = line.dataset.done === '1' ? '0' : '1';
        syncModel();
      });

      // ---- Ações de formatação (toolbar/popover) ----
      const execInline = (cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough') => {
        editor.focus();
        document.execCommand('styleWithCSS', false, 'false');
        document.execCommand(cmd, false);
        syncModel();
      };
      /** Formato de BLOCO (H1/H2/texto) na linha do cursor (toggle). */
      const applyBlockFormat = (kind: 'h1' | 'h2' | 'text') => {
        const line = currentLine();
        if (!line) return;
        const domIdx = Math.max(0, caretIndexInLine(line));
        const cur = lineKindOf(line);
        const target = cur === kind ? 'text' : kind;
        pushUndo();
        const { md } = serializeMapped(line);
        const nl = rebuildLine(line, target, false, md);
        setCaretInLine(nl, domIdx);
        syncModel();
      };
      /** Liga/desliga checklist na linha do cursor. */
      const applyChecklist = () => {
        const line = currentLine();
        if (!line) return;
        const domIdx = Math.max(0, caretIndexInLine(line));
        const isItem = lineKindOf(line) === 'item';
        pushUndo();
        const { md } = serializeMapped(line);
        const nl = rebuildLine(line, isItem ? 'text' : 'item', false, md);
        setCaretInLine(nl, domIdx);
        syncModel();
      };

      // ---- Popovers (um por vez, acima da toolbar) ----
      let popEl: HTMLDivElement | null = null;
      // PR13 — commit PENDENTE do datetime-local: o `input` grava o valor
      // escolhido e o closePop consolida (antes, o Fechar removia o campo do
      // DOM ANTES do `change` disparar → o lembrete nunca era gravado).
      let pendingRemind: number | null = null;
      const commitRemind = () => {
        if (pendingRemind === null) return;
        pushUndo();
        draft.reminder = computeReminder('custom', Date.now(), pendingRemind);
        pendingRemind = null;
        refreshRemindInfo();
      };
      const closePop = () => {
        if (popEl?.classList.contains('remind')) commitRemind();
        popEl?.remove();
        popEl = null;
      };
      const openPop = (anchor: HTMLElement, build: (pop: HTMLDivElement) => void) => {
        if (popEl) {
          closePop();
          return;
        }
        const pop = document.createElement('div');
        pop.className = 'note-rich-pop';
        build(pop);
        modal.appendChild(pop);
        // Posiciona acima da toolbar, alinhado ao botão
        const ar = anchor.getBoundingClientRect();
        const mr = modal.getBoundingClientRect();
        pop.style.left = `${Math.max(8, ar.left - mr.left)}px`;
        pop.style.bottom = `${mr.bottom - ar.top + 6}px`;
        popEl = pop;
      };

      // ---- Formatação de texto (1º ícone: Aa) → execInline/applyBlockFormat ----

      // ---- Toolbar ----
      const toolbar = document.createElement('div');
      toolbar.className = 'note-rich-toolbar';
      const mkBtn = (glyph: string, titleKey: string, onClick: (e: MouseEvent) => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'note-rich-tool';
        b.textContent = glyph;
        b.title = t(titleKey);
        b.setAttribute('aria-label', t(titleKey));
        // mousedown preventDefault: NÃO rouba o foco/seleção do editor
        // (crítico p/ execCommand aplicar no texto selecionado)
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => onClick(e));
        toolbar.appendChild(b);
        return b;
      };

      // 1º ícone — formatação (Aa ▾)
      mkBtn('Aa ▾', 'ui.formatText', (e) =>
        openPop(e.currentTarget as HTMLElement, (pop) => {
          pop.classList.add('fmt');
          const row = document.createElement('div');
          row.className = 'note-rich-fmt-row';
          const fmtItem = (label: string, tip: string, run: () => void) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'note-rich-fmt-item';
            b.textContent = label;
            b.title = t(tip);
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', () => {
              run();
              closePop();
            });
            row.appendChild(b);
          };
          fmtItem('H1', 'ui.h1', () => applyBlockFormat('h1'));
          fmtItem('H2', 'ui.h2', () => applyBlockFormat('h2'));
          fmtItem('Aa', 'ui.normalText', () => applyBlockFormat('text'));
          const sep = document.createElement('span');
          sep.className = 'note-rich-fmt-sep';
          row.appendChild(sep);
          const inline = (label: string, tip: string, cmd: 'bold' | 'italic' | 'underline' | 'strikeThrough') =>
            fmtItem(label, tip, () => execInline(cmd));
          inline('B', 'ui.bold', 'bold');
          inline('I', 'ui.italic', 'italic');
          inline('U', 'ui.underline', 'underline');
          inline('S', 'ui.strike', 'strikeThrough');
          pop.appendChild(row);
        }),
      );

      // 2º ícone — cor do plano de fundo (🎨)
      mkBtn('🎨', 'ui.bgColor', (e) =>
        openPop(e.currentTarget as HTMLElement, (pop) => {
          pop.classList.add('palette');
          const label = document.createElement('div');
          label.className = 'note-rich-pop-label';
          label.textContent = t('ui.bgColor');
          pop.appendChild(label);
          const grid = document.createElement('div');
          grid.className = 'note-rich-swatch-grid';
          for (const c of NOTE_COLORS) {
            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'note-rich-swatch';
            sw.style.background = c;
            sw.title = c;
            if (c === draft.bg) sw.classList.add('sel');
            sw.addEventListener('click', () => {
              pushUndo();
              draft.bg = c;
              modal.style.background = c;
              closePop();
            });
            grid.appendChild(sw);
          }
          pop.appendChild(grid);
        }),
      );

      // 3º ícone — lembrete (⏰)
      const remindInfo = document.createElement('span');
      remindInfo.className = 'note-rich-remind-info';
      const fmtWhen = (ms: number): string =>
        new Date(ms).toLocaleString(undefined, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      const refreshRemindInfo = () => {
        remindInfo.textContent = draft.reminder !== null ? `⏰ ${fmtWhen(draft.reminder)}` : '';
      };
      refreshRemindInfo();
      mkBtn('⏰', 'ui.remindLater', (e) =>
        openPop(e.currentTarget as HTMLElement, (pop) => {
          pop.classList.add('remind');
          const label = document.createElement('div');
          label.className = 'note-rich-pop-label';
          label.textContent = t('ui.remindLater');
          pop.appendChild(label);
          const simpleRow = (labelText: string, right: string, val: () => number | null) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'note-rich-remind-row';
            const l = document.createElement('span');
            l.textContent = labelText;
            const r = document.createElement('span');
            r.className = 'note-rich-remind-when';
            r.textContent = right;
            b.appendChild(l);
            b.appendChild(r);
            b.addEventListener('click', () => {
              pendingRemind = null; // opção rápida cancela custom pendente
              pushUndo();
              draft.reminder = val();
              refreshRemindInfo();
              closePop();
            });
            pop.appendChild(b);
          };
          simpleRow(t('ui.remindToday'), '18:00', () => computeReminder('today', Date.now()));
          simpleRow(t('ui.remindTomorrow'), '08:00', () => computeReminder('tomorrow', Date.now()));
          simpleRow(t('ui.remindNextWeek'), 'seg., 08:00', () => computeReminder('nextweek', Date.now()));
          const customRow = document.createElement('label');
          customRow.className = 'note-rich-remind-row';
          const cl = document.createElement('span');
          cl.textContent = `⏲ ${t('ui.remindCustom')}`;
          const dt = document.createElement('input');
          dt.type = 'datetime-local';
          dt.className = 'note-rich-remind-dt';
          // PR13 — `input` (não `change`): grada o valor no ATO, pois o
          // closePop pode remover o campo antes do `change` disparar
          dt.addEventListener('input', () => {
            pendingRemind = null;
            if (dt.value === '') return;
            const ms = new Date(dt.value).getTime();
            if (!Number.isFinite(ms)) return;
            pendingRemind = ms;
          });
          customRow.appendChild(cl);
          customRow.appendChild(dt);
          pop.appendChild(customRow);
          if (draft.reminder !== null) {
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'note-rich-remind-row danger';
            rm.textContent = t('ui.remindRemove');
            rm.addEventListener('click', () => {
              pendingRemind = null;
              draft.reminder = null;
              refreshRemindInfo();
              closePop();
            });
            pop.appendChild(rm);
          }
        }),
      );

      // 4º ícone — lista com marcadores (☑)
      mkBtn('☑', 'ui.checklist', () => applyChecklist());

      // 5º ícone — desenhar (✍)
      mkBtn('✍', 'ui.draw', () => {
        enterDraw();
      });

      // undo/redo
      mkBtn('↶', 'ui.undo', () => doUndo());
      mkBtn('↷', 'ui.redo', () => doRedo());

      const spacer = document.createElement('span');
      spacer.className = 'note-rich-spacer';
      toolbar.appendChild(spacer);
      toolbar.appendChild(remindInfo);
      const closeBig = document.createElement('button');
      closeBig.type = 'button';
      closeBig.className = 'note-rich-done';
      closeBig.textContent = t('ui.close');
      closeBig.addEventListener('click', () => finish());
      toolbar.appendChild(closeBig);

      // ---- Modo desenho ----
      let drawMode = false;
      let tool: 'pen' | 'eraser' = 'pen';
      const enterDraw = () => {
        drawMode = true;
        editor.style.display = 'none';
        editor.blur();
        canvasWrap.style.display = 'flex';
        drawBar.innerHTML = '';
        const penBtn = document.createElement('button');
        penBtn.type = 'button';
        penBtn.className = 'note-rich-tool sel';
        penBtn.textContent = '✒';
        penBtn.title = t('ui.drawPen');
        const erBtn = document.createElement('button');
        erBtn.type = 'button';
        erBtn.className = 'note-rich-tool';
        erBtn.textContent = '◌';
        erBtn.title = t('ui.drawEraser');
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'note-rich-tool';
        clearBtn.textContent = '🗑';
        clearBtn.title = t('ui.drawClear');
        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'note-rich-tool';
        doneBtn.textContent = '✓';
        doneBtn.title = t('ui.drawDone');
        drawBar.appendChild(penBtn);
        drawBar.appendChild(erBtn);
        drawBar.appendChild(clearBtn);
        drawBar.appendChild(doneBtn);
        penBtn.addEventListener('click', () => {
          tool = 'pen';
          penBtn.classList.add('sel');
          erBtn.classList.remove('sel');
        });
        erBtn.addEventListener('click', () => {
          tool = 'eraser';
          erBtn.classList.add('sel');
          penBtn.classList.remove('sel');
        });
        clearBtn.addEventListener('click', () => {
          pushUndo();
          const c2 = canvas.getContext('2d');
          c2?.clearRect(0, 0, canvas.width, canvas.height);
        });
        doneBtn.addEventListener('click', () => {
          pushUndo();
          // Canvas vazio (nada desenhado) → remove o desenho
          const c2 = canvas.getContext('2d');
          const data = c2?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
          let ink = false;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] !== 0) {
              ink = true;
              break;
            }
          }
          draft.drawing = ink ? canvas.toDataURL('image/png') : null;
          exitDraw();
        });
        // Ajusta o canvas ao tamanho real do corpo (após visível)
        requestAnimationFrame(() => {
          const rect = canvasWrap.getBoundingClientRect();
          if (rect.width < 10 || rect.height < 10) return;
          canvas.width = Math.floor(rect.width);
          canvas.height = Math.floor(rect.height - drawBar.offsetHeight - 10);
          const c2 = canvas.getContext('2d');
          if (c2 && draft.drawing) {
            const img = new Image();
            img.onload = () => {
              const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
              c2.drawImage(img, 0, 0, img.width * scale, img.height * scale);
            };
            img.src = draft.drawing;
          }
        });
        // Gesto de desenhar
        let drawing = false;
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', (ev) => {
          drawing = true;
          const c2 = canvas.getContext('2d');
          if (!c2) return;
          c2.beginPath();
          c2.moveTo(ev.offsetX, ev.offsetY);
        });
        canvas.addEventListener('pointermove', (ev) => {
          if (!drawing) return;
          const c2 = canvas.getContext('2d');
          if (!c2) return;
          c2.lineCap = 'round';
          c2.lineJoin = 'round';
          c2.strokeStyle = tool === 'pen' ? '#1f2933' : 'rgba(0,0,0,1)';
          c2.globalCompositeOperation = tool === 'pen' ? 'source-over' : 'destination-out';
          c2.lineWidth = tool === 'pen' ? 4 : 26;
          c2.lineTo(ev.offsetX, ev.offsetY);
          c2.stroke();
        });
        const stop = () => {
          drawing = false;
        };
        canvas.addEventListener('pointerup', stop);
        canvas.addEventListener('pointerleave', stop);
      };
      const exitDraw = () => {
        drawMode = false;
        canvasWrap.style.display = 'none';
        editor.style.display = '';
      };

      // ---- Montagem + fechamento (FECHAR SALVA) ----
      modal.appendChild(head);
      modal.appendChild(body);
      modal.appendChild(toolbar);
      backdrop.appendChild(modal);
      this.root.appendChild(backdrop);

      let finished = false;
      // PR17 — teclado no celular: fallback (iOS/Android sem
      // `interactive-widget=resizes-content`) — encosta o modal na área
      // VISÍVEL do visualViewport enquanto o teclado estiver aberto.
      const vp = window.visualViewport;
      const fitKb = () => {
        if (!vp) return;
        const tecladoAberto = vp.height + vp.offsetTop < window.innerHeight - 60;
        if (tecladoAberto) {
          modal.style.height = `${Math.max(280, Math.round(vp.height - 2))}px`;
        } else {
          modal.style.height = '';
        }
      };
      vp?.addEventListener('resize', fitKb);
      vp?.addEventListener('scroll', fitKb);
      fitKb();
      const finish = () => {
        if (finished) return;
        finished = true;
        // PR13 — popover de lembrete aberto ao fechar: consolida o datetime
        if (popEl?.classList.contains('remind')) commitRemind();
        if (drawMode) {
          // Sai do modo desenho mantendo o que há (rascunho no canvas)
          const c2 = canvas.getContext('2d');
          if (c2) {
            const data = c2.getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = false;
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 0) {
                ink = true;
                break;
              }
            }
            if (ink) draft.drawing = canvas.toDataURL('image/png');
          }
        }
        vp?.removeEventListener('resize', fitKb);
        vp?.removeEventListener('scroll', fitKb);
        modal.style.height = '';
        // PR4.17 — serializa AGORA: o último `input` pode ainda não ter sido
        // processado (composição de IME, colar programático) e o draft ficaria
        // defasado. E nunca devolve nota "vazia" enquanto o editor ainda
        // mostra texto na tela — aí guardamos o texto cru em vez de descartar.
        draft.text = serializeRich();
        if (draft.text.trim() === '' && draft.title.trim() === '' && draft.drawing === null) {
          const raw = htmlToNoteMd(editor.innerHTML).trim();
          if (raw !== '') draft.text = raw;
        }
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        resolve({ ...draft });
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') finish();
      };
      document.addEventListener('keydown', onKey);
      // PR14 — guard: o 2º clique de um duplo-clique na nota cai no backdrop
      // (o modal acabou de cobrir o canvas) e fecharia o editor na sequência.
      // Cliques no backdrop nos primeiros 350 ms são ignorados.
      const openedAt = Date.now();
      closeBtn.addEventListener('click', () => finish());
      backdrop.addEventListener('click', (e) => {
        if (e.target !== backdrop) return;
        if (Date.now() - openedAt < 350) return;
        finish();
      });
      // Clique fora fecha popover (não o modal)
      modal.addEventListener('pointerdown', (e) => {
        const tgt = e.target as HTMLElement;
        if (popEl && !popEl.contains(tgt) && !tgt.closest('.note-rich-tool')) closePop();
      });
      titleIn.focus();
    });
  }

  /** Indica se o cursor está sobre o Pile Widget Halo no overlay. */
  isHaloHovered(): boolean {
    return this.haloHovered;
  }

  /** Registra o callback de clique em ação do halo. */
  onPileHaloAction(cb: (pileId: string, action: string) => void): void {
    this.haloActionCb = cb;
  }

  /**
   * Renderiza/atualiza o anel de widgets ao redor da pilha (Pile Widget Halo).
   * Null esconde o halo.
   */
  setPileHalo(halo: PileHaloData | null): void {
    if (halo === null) {
      if (this.haloEl) this.haloEl.style.display = 'none';
      this.haloCurrentPileId = null;
      return;
    }

    this.haloCurrentPileId = halo.pileId;

    if (!this.haloEl) {
      const el = document.createElement('div');
      el.className = 'pile-halo';
      el.style.pointerEvents = 'auto';

      el.addEventListener('pointerenter', () => {
        this.haloHovered = true;
      });
      el.addEventListener('pointerleave', () => {
        this.haloHovered = false;
      });

      // 5 widgets do halo (P1)
      const widgets = [
        {
          id: 'fan',
          icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="3" width="10" height="14" rx="2" transform="rotate(-15 12 10)"/><rect x="7" y="3" width="10" height="14" rx="2" transform="rotate(15 12 10)"/><rect x="7" y="3" width="10" height="14" rx="2"/></svg>',
          hint: t('halo.fan'),
        },
        {
          id: 'grid',
          icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
          hint: t('halo.grid'),
        },
        {
          id: 'leaf',
          icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M12 6l3 3-3 3"/></svg>',
          hint: t('halo.leaf'),
        },
        {
          id: 'messy',
          icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2" transform="rotate(12 12 12)" stroke-dasharray="2 2"/><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
          hint: t('halo.messy'),
        },
        {
          id: 'break',
          icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8l4-4m0 0h-4m4 0v4M8 8L4 4m0 0h4M4 4v4m8 8l4 4m0 0h-4m4 0v-4m-8-8l-4 4m0 0h4m-4 0v-4"/></svg>',
          hint: t('halo.break'),
        },
      ];

      const R = 64;
      const count = widgets.length;
      for (let i = 0; i < count; i++) {
        const w = widgets[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pile-halo-btn';
        btn.dataset.action = w.id;
        btn.dataset.hint = w.hint;
        btn.innerHTML = w.icon;

        // Distribui ao longo de um arco superior de -150° a -30°
        const angleDeg = -150 + (i * 120) / (count - 1);
        const rad = (angleDeg * Math.PI) / 180;
        const x = Math.round(Math.cos(rad) * R);
        const y = Math.round(Math.sin(rad) * R);
        btn.style.left = `${x}px`;
        btn.style.top = `${y}px`;

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.haloCurrentPileId) {
            this.haloActionCb?.(this.haloCurrentPileId, w.id);
          }
        });
        el.appendChild(btn);
      }

      this.root.appendChild(el);
      this.haloEl = el;
    }

    // Atualiza estado ativo dos botões
    const fanBtn = this.haloEl.querySelector<HTMLButtonElement>('[data-action="fan"]');
    const gridBtn = this.haloEl.querySelector<HTMLButtonElement>('[data-action="grid"]');
    const messyBtn = this.haloEl.querySelector<HTMLButtonElement>('[data-action="messy"]');
    if (fanBtn) fanBtn.classList.toggle('active', halo.layout === 2); // PileLayout.Leaf
    if (gridBtn) gridBtn.classList.toggle('active', halo.layout === 1); // PileLayout.Grid
    if (messyBtn) messyBtn.classList.toggle('active', !halo.messy);

    // Clamp: garante que o halo fique dentro da viewport (especialmente mobile)
    const HALO_R = 124; // 70 (metade do halo) + 54 (raio dos botões) + margem
    const clampedX = Math.max(HALO_R, Math.min(window.innerWidth - HALO_R, halo.screen.x));
    const clampedY = Math.max(HALO_R, Math.min(window.innerHeight - HALO_R, halo.screen.y));

    this.haloEl.style.display = 'block';
    this.haloEl.style.left = `${clampedX}px`;
    this.haloEl.style.top = `${clampedY}px`;
  }

  setDwellRing(data: DwellRingData | null): void {
    if (!data) {
      if (this.dwellEl) this.dwellEl.style.display = 'none';
      return;
    }

    if (!this.dwellEl) {
      const el = document.createElement('div');
      el.className = 'dwell-ring';
      el.innerHTML = `
        <svg viewBox="0 0 44 44" class="dwell-svg">
          <circle class="dwell-bg" cx="22" cy="22" r="18" fill="none" stroke="rgba(81, 207, 102, 0.25)" stroke-width="3" />
          <circle class="dwell-fg" cx="22" cy="22" r="18" fill="none" stroke="#51cf66" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="113.1" transform="rotate(-90 22 22)" />
        </svg>
      `;
      el.addEventListener('pointerenter', () => {
        this.dwellHovered = true;
      });
      el.addEventListener('pointerleave', () => {
        this.dwellHovered = false;
      });
      this.root.appendChild(el);
      this.dwellEl = el;
    }

    this.dwellEl.style.display = 'block';
    this.dwellEl.style.left = `${data.screen.x}px`;
    this.dwellEl.style.top = `${data.screen.y}px`;
    this.dwellEl.classList.toggle('active', data.active);

    const fg = this.dwellEl.querySelector<SVGCircleElement>('.dwell-fg');
    if (fg) {
      const offset = (1 - Math.max(0, Math.min(1, data.progress))) * 113.1;
      fg.style.strokeDashoffset = `${offset}`;
    }
  }

  setScrubStrip(data: ScrubStripData | null): void {
    if (!data) {
      if (this.scrubEl) this.scrubEl.style.display = 'none';
      this.scrubCurrentPileId = null;
      return;
    }

    this.scrubCurrentPileId = data.pileId;

    if (!this.scrubEl) {
      const el = document.createElement('div');
      el.className = 'scrub-strip';
      el.addEventListener('pointerenter', () => {
        this.scrubHovered = true;
      });
      el.addEventListener('pointerleave', () => {
        this.scrubHovered = false;
      });
      this.root.appendChild(el);
      this.scrubEl = el;
    }

    this.scrubEl.style.display = 'flex';
    this.scrubEl.style.left = `${data.screen.x}px`;
    this.scrubEl.style.top = `${data.screen.y + 40}px`;

    // Renderiza chips se a lista mudou ou atualiza a classe active
    const chips = this.scrubEl.querySelectorAll<HTMLDivElement>('.scrub-chip');
    if (chips.length !== data.items.length) {
      this.scrubEl.innerHTML = '';
      data.items.forEach((item, idx) => {
        const chip = document.createElement('div');
        chip.className = `scrub-chip ${idx === data.activeIndex ? 'active' : ''}`;
        chip.dataset.id = item.id;
        chip.dataset.hint = item.label;
        if (item.thumb) {
          chip.innerHTML = `<img src="${item.thumb}" class="scrub-chip-thumb" alt="${item.label}" />`;
        } else {
          chip.innerHTML = `<span class="scrub-chip-icon" style="background:${item.color ?? '#4f9cff'}">${(item.label || '?').slice(0, 2).toUpperCase()}</span>`;
        }
        chip.addEventListener('pointerenter', () => {
          if (this.scrubCurrentPileId) {
            this.scrubHoverCb?.(this.scrubCurrentPileId, idx);
          }
        });
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.scrubCurrentPileId) {
            this.scrubSelectCb?.(this.scrubCurrentPileId, item.id);
          }
        });
        this.scrubEl!.appendChild(chip);
      });
    } else {
      chips.forEach((chip, idx) => {
        chip.classList.toggle('active', idx === data.activeIndex);
      });
    }
  }

  onScrubItemSelect(cb: (pileId: string, itemId: string) => void): void {
    this.scrubSelectCb = cb;
  }

  onScrubHover(cb: (pileId: string, index: number) => void): void {
    this.scrubHoverCb = cb;
  }

  isScrubHovered(): boolean {
    return this.scrubHovered || this.dwellHovered;
  }

  // -------------------------------------------------------------------------
  // PR9 — pilha aberta em grade: botão ✕ flutuante
  // -------------------------------------------------------------------------

  setPileCloseBtn(screen: { x: number; y: number } | null): void {
    if (screen === null) {
      // Esconde (não remove): evita destruir/recriar o elemento a cada frame
      // quando a projeção oscila — o botão fica estável para clique.
      if (this.pileCloseEl) this.pileCloseEl.style.display = 'none';
      return;
    }
    if (!this.pileCloseEl) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pile-close-btn';
      btn.textContent = '✕';
      btn.setAttribute('aria-label', t('ui.close'));
      btn.title = t('ui.close');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pileCloseCb?.();
      });
      this.root.appendChild(btn);
      this.pileCloseEl = btn;
    }
    this.pileCloseEl.style.display = '';
    this.pileCloseEl.style.left = `${screen.x}px`;
    this.pileCloseEl.style.top = `${screen.y}px`;
  }

  onPileCloseClick(cb: () => void): void {
    this.pileCloseCb = cb;
  }

  // -------------------------------------------------------------------------
  // PR9 — modal de vidro com o conteúdo de uma pasta
  // -------------------------------------------------------------------------

  showFolderModal(spec: {
    name: string;
    items: Array<{ path: string; name: string; isDir: boolean; thumb: string | null }>;
    emptyLabel?: string;
    onOpen: (path: string, isDir: boolean) => void;
    onClose: () => void;
    onDelete?: (path: string) => void;
    onExtract?: (path: string) => void;
  }): void {
    this.hideFolderModal();

    const backdrop = document.createElement('div');
    backdrop.className = 'folder-backdrop';
    backdrop.style.pointerEvents = 'auto';

    const modal = document.createElement('div');
    modal.className = 'folder-modal';
    modal.dataset.testid = 'folder-modal';

    const head = document.createElement('div');
    head.className = 'folder-head';
    const title = document.createElement('span');
    title.className = 'folder-name';
    title.textContent = spec.name;
    const close = document.createElement('button');
    close.className = 'folder-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', t('ui.close'));
    close.title = t('ui.close');
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = 'folder-grid';
    if (spec.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-empty';
      empty.textContent = spec.emptyLabel ?? t('ui.folderEmpty');
      body.appendChild(empty);
    }
    for (const item of spec.items) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'folder-item';
      const img = document.createElement('img');
      img.className = 'folder-thumb';
      img.alt = item.name;
      img.src = item.thumb ?? '';
      const label = document.createElement('span');
      label.className = 'folder-item-name';
      label.textContent = item.name;
      cell.appendChild(img);
      cell.appendChild(label);
      // PR10 — ações por item: tirar da pasta (⇪) e excluir (✕)
      if (spec.onExtract || spec.onDelete) {
        const acts = document.createElement('span');
        acts.className = 'folder-item-acts';
        if (spec.onExtract) {
          const ex = document.createElement('button');
          ex.type = 'button';
          ex.className = 'folder-item-act';
          ex.textContent = '⇪';
          ex.title = t('menu.extract');
          ex.setAttribute('aria-label', t('menu.extract'));
          ex.addEventListener('click', (e) => {
            e.stopPropagation();
            spec.onExtract?.(item.path);
          });
          acts.appendChild(ex);
        }
        if (spec.onDelete) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'folder-item-act folder-item-act-danger';
          del.textContent = '✕';
          del.title = t('menu.delete');
          del.setAttribute('aria-label', t('menu.delete'));
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            spec.onDelete?.(item.path);
          });
          acts.appendChild(del);
        }
        cell.appendChild(acts);
      }
      cell.addEventListener('click', () => spec.onOpen(item.path, item.isDir));
      body.appendChild(cell);
    }

    const hide = () => this.hideFolderModal();
    close.onclick = () => {
      spec.onClose();
      hide();
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        spec.onClose();
        hide();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        spec.onClose();
        hide();
      }
    };
    document.addEventListener('keydown', onKey);

    modal.appendChild(head);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    this.root.appendChild(backdrop);
    this.folderEl = backdrop;
    this.folderCleanup = () => document.removeEventListener('keydown', onKey);
  }

  hideFolderModal(): void {
    if (!this.folderEl) return;
    this.folderEl.remove();
    this.folderEl = null;
    this.folderCleanup?.();
    this.folderCleanup = null;
  }
}

/** Ícones SVG temáticos estilo BumpTop para as fatias do Blue Pie Menu */
function getActionIcon(action: string): string {
  switch (action) {
    case 'newNote':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
    case 'autoPile':
    case 'pileLayout':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/><rect x="2" y="3" width="20" height="18" rx="2"/></svg>`;
    case 'toggleAutoAlign':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="10" y1="3" x2="14" y2="3"/><line x1="3" y1="10" x2="3" y2="14"/></svg>`;
    case 'toggleExplodingPiles':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
    case 'open':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    case 'openDir':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    case 'editNote':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    case 'rename':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="7" x2="20" y2="7"/><line x1="12" y1="7" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>`;
    case 'fanOut':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="3" width="10" height="14" rx="2" transform="rotate(-15 12 10)"/><rect x="7" y="3" width="10" height="14" rx="2" transform="rotate(15 12 10)"/><rect x="7" y="3" width="10" height="14" rx="2"/></svg>`;
    case 'breakPile':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8l4-4m0 0h-4m4 0v4M8 8L4 4m0 0h4M4 4v4m8 8l4 4m0 0h-4m4 0v-4m-8-8l-4 4m0 0h4m-4 0v-4"/></svg>`;
    case 'shakePile':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h3l3-7 4 14 3-7h7"/></svg>`;
    case 'pilePage':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    case 'pin':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-2l-2-3V5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v7l-2 3v2z"/></svg>`;
    case 'gridView':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
    case 'sortBySize':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="4" y2="14"/><line x1="10" y1="20" x2="10" y2="10"/><line x1="16" y1="20" x2="16" y2="6"/><line x1="22" y1="20" x2="22" y2="2"/></svg>`;
    case 'sortByType':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`;
    case 'duplicate':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    case 'scaleUp':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    case 'scaleDown':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    case 'rotate':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
    case 'makePile':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="13" width="16" height="4" rx="1"/><rect x="5" y="8" width="14" height="4" rx="1"/><rect x="6" y="3" width="12" height="4" rx="1"/><line x1="12" y1="23" x2="12" y2="19"/></svg>`;
    case 'physicsLevel':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="8" height="8" rx="1"/><rect x="13" y="12" width="8" height="8" rx="1"/><rect x="8" y="3" width="8" height="8" rx="1"/></svg>`;
    case 'delete':
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
    default:
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  }
}
