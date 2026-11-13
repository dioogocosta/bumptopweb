/**
 * Adapter de overlay — DOM puro (menu de contexto, toasts, labels).
 * Espelha o `BT_OverlayComponent` do original: UI 2D sobre o mundo 3D.
 * Usa DOM direto p/ M0; pode migrar p/ Preact quando a UI crescer.
 */
import { t } from '@core/i18n/i18n';
import type {
  ContextMenuItem,
  DwellRingData,
  IOverlay,
  LassoData,
  PileHaloData,
  ScrubStripData,
} from '@core/ports/index';

export class DomOverlay implements IOverlay {
  private root: HTMLElement;
  private menuEl: HTMLDivElement | null = null;
  private labels = new Map<string, HTMLDivElement>();
  private lassoEl: HTMLDivElement | null = null;
  private resizeEl: HTMLDivElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private resizeCb: ((e: PointerEvent) => void) | null = null;
  private haloEl: HTMLDivElement | null = null;
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

  /** PR11 — botões de zoom na tela (topo). */
  private zoomCbIn: (() => void) | null = null;
  private zoomCbOut: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '10';

    // Botão "Reset Camera" (P0) — canto superior direito; dispara `resetcamera`
    // (mesmo padrão de evento do `ctxaction`; o composition root escuta).
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-cam';
    reset.textContent = t('ui.resetCamera');
    reset.setAttribute('aria-label', t('ui.resetCamera'));
    reset.addEventListener('click', () => {
      this.root.dispatchEvent(new CustomEvent('resetcamera', { bubbles: true }));
    });
    this.root.appendChild(reset);

    // PR11 — controles de zoom na tela (topo central)
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'zoom-controls';
    const btnIn = document.createElement('button');
    btnIn.type = 'button';
    btnIn.title = t('ui.zoomIn');
    btnIn.setAttribute('aria-label', t('ui.zoomIn'));
    btnIn.textContent = '🔍+';
    btnIn.addEventListener('click', () => this.zoomCbIn?.());
    const btnOut = document.createElement('button');
    btnOut.type = 'button';
    btnOut.title = t('ui.zoomOut');
    btnOut.setAttribute('aria-label', t('ui.zoomOut'));
    btnOut.textContent = '🔍-';
    btnOut.addEventListener('click', () => this.zoomCbOut?.());
    zoomWrap.appendChild(btnIn);
    zoomWrap.appendChild(btnOut);
    this.root.appendChild(zoomWrap);
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
      this.root.appendChild(el);
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

  toast(message: string): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2600);
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

  /** Registra callbacks dos botões de zoom na tela. */
  onZoom(cbIn: () => void, cbOut: () => void): void {
    this.zoomCbIn = cbIn;
    this.zoomCbOut = cbOut;
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
