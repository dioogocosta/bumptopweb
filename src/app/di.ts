/**
 * Composition root — fio todos os adapters nos ports do core.
 *
 * É o ÚNICO lugar que conhece implementações concretas (Rapier, three, SQLite,
 * Pointer, DOM). O `core` continua puro. Em Tauri/Electron, troca-se só aqui.
 */
import { World } from '@core/world';
import type { Vec3 } from '@core/model/types';
import type { ContextMenuItem, IFileSystem, IRepo, InputAction } from '@core/ports/index';
import { isLang, setLang, t } from '@core/i18n/i18n';
import { RapierPhysics } from '@physics/rapier/rapierPhysics';
import { ThreeRenderer } from '@render/three/threeRenderer';
import { SqliteRepo } from '@persistence/sqlite/sqliteRepo';
import { PointerInput } from '@input/pointer/pointerInput';
import { DomOverlay } from '@overlay/overlay';
import { MainLoop } from './main-loop';
import { DEFAULT_ROOM } from '@core/model/types';
import { THEMES } from '@core/theme/theme';
import { FsAccessFileSystem } from '@fs/fsAccess';
import { OpfsFileSystem } from '@fs/opfsFs';
import { iconForExt } from '@fs/fileIcons';
import { FileService } from './fileService';

export interface AppContext {
  world: World;
  repo: IRepo;
  loop: MainLoop;
  files: FileService;
  renderer: ThreeRenderer;
  overlay: DomOverlay;
  dispose(): void;
}

/** Projeção screen → ponto no plano do piso (y=0), p/ picking e arraste. */
function makeFloorResolver(renderer: ThreeRenderer): (s: { x: number; y: number }) => Vec3 {
  return (s) => {
    const { origin, direction } = renderer.screenToRay(s);
    // Interseção com o plano y = 0
    if (Math.abs(direction.y) < 1e-6) return { x: origin.x, y: 0, z: origin.z };
    const t = -origin.y / direction.y;
    if (t < 0) return { x: origin.x, y: 0, z: origin.z };
    return {
      x: origin.x + direction.x * t,
      y: 0,
      z: origin.z + direction.z * t,
    };
  };
}

export async function createApp(sceneRoot: HTMLElement, overlayRoot: HTMLElement): Promise<AppContext> {
  const renderer = new ThreeRenderer();
  await renderer.init(sceneRoot, DEFAULT_ROOM);

  const physics = new RapierPhysics();
  const repo = new SqliteRepo();
  await repo.init();

  // Idioma (i18n): setting persistido → detecção do navegador → pt-BR
  const storedLang = await repo.getSetting<string>('lang', '');
  let lang = storedLang;
  if (!isLang(lang)) {
    lang =
      typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')
        ? 'en'
        : 'pt-BR';
    void repo.setSetting('lang', lang);
  }
  setLang(lang);
  document.documentElement.lang = lang;

  // Textos da UI estática (index.html) no idioma ativo
  const pwaLabel = document.querySelector('#pwa-toast span');
  if (pwaLabel) pwaLabel.textContent = t('pwa.update');
  const pwaRefresh = document.getElementById('pwa-refresh');
  if (pwaRefresh) pwaRefresh.textContent = t('pwa.refresh');
  const pwaDismiss = document.getElementById('pwa-dismiss');
  if (pwaDismiss) pwaDismiss.textContent = t('pwa.dismiss');

  const overlay = new DomOverlay(overlayRoot);

  const world = new World({ physics, renderer, overlay });
  await world.init();

  // Tema persistido (settings) — aplica no renderer
  const themeIdx = await repo.getSetting<number>('themeIndex', 0);
  world.setTheme(THEMES[themeIdx % THEMES.length]);

  // Filesystem (M2): Modo A (FS Access) com fallback Modo B (OPFS)
  const fs: IFileSystem = new FsAccessFileSystem(new OpfsFileSystem());
  await fs.requestDirectory().catch(() => false);
  const files = new FileService(world, fs, repo);

  // Input semântico: injeta o resolvedor de piso (sem three no adapter)
  const resolveFloor = makeFloorResolver(renderer);
  const input = new PointerInput(resolveFloor);
  input.attach(renderer.getCanvas());

  // Listener de ações → world (e menu de contexto p/ overlay)
  // Alvo atual do menu de contexto (atualizado a cada abertura)
  let ctxTarget: string | null = null;
  // Alvos da ação: a seleção INTEIRA se o item clicado está nela, senão só ele
  let ctxTargets: string[] = [];
  // Ponto de chão onde o menu foi aberto (p/ criar nota adesiva)
  let ctxFloorPoint: { x: number; y: number; z: number } | null = null;
  // Rastreio de arraste p/ detectar "soltar em pasta" (moveInto, M2)
  let dragSourceId: string | null = null;

  /** Feedback de escala (P0): limite ("não dá para mais!") ou % atual. */
  const toastScale = (r: {
    changed: number;
    limit: 'max' | 'min' | null;
    scale: number | null;
  }) => {
    if (r.limit === 'max') overlay.toast(t('toast.scaleMax'));
    else if (r.limit === 'min') overlay.toast(t('toast.scaleMin'));
    else if (r.changed > 0 && r.scale != null)
      overlay.toast(t('toast.scalePct', { pct: Math.round(r.scale * 100) }));
    else overlay.toast(t('toast.nothingToScale'));
  };

  overlayRoot.addEventListener('ctxaction', (e) => {
    const a = (e as CustomEvent<string>).detail;
    if (a === 'open' && ctxTarget) {
      const id = ctxTarget;
      void files.openObject(id).then((r) => {
        if (r === 'imported') overlay.toast(t('toast.folderImported'));
        else if (r === 'error') overlay.toast(t('toast.openFailed'));
      });
    } else if (a === 'openDir') {
      void (async () => {
        const ok = await files.requestDirectory();
        if (!ok) {
          overlay.toast(t('toast.selectionCancelled'));
          return;
        }
        const r = await files.importDirectory();
        overlay.toast(t('toast.dirStats', { total: r.total, files: r.files, thumbs: r.thumbs }));
        await files.savePath();
      })();
    } else if (a === 'delete' && ctxTargets.length > 0) {
      // Multi-select: se o item clicado está na seleção, exclui a seleção
      // inteira; senão só o item clicado (Fase 7)
      const ids = ctxTargets;
      for (const id of ids) world.removeObject(id);
      if (ids.length > 1) overlay.toast(t('toast.deleted', { n: ids.length }));
    } else if (a === 'rename' && ctxTarget) {
      const id = ctxTarget;
      const current = world.getObject(id)?.label ?? '';
      const pos = world.getObject(id)!.pose.position;
      const screen = renderer.projectToScreen(pos);
      void overlay
        .editNote({ x: screen.x + 40, y: screen.y - 80 }, current, t('ui.namePlaceholder'))
        .then((text) => {
          const next = text.trim();
          if (next !== '' && next !== current) {
            world.renameObject(id, next);
            overlay.toast(t('toast.renamed'));
          }
        });
    } else if (a === 'autoPile') {
      const n = world.autoStackByType();
      overlay.toast(n > 0 ? t('toast.pilesCreated', { n }) : t('toast.nothingToPile'));
    } else if (a === 'toggleAutoAlign') {
      const on = world.toggleAutoAlign();
      overlay.toast(on ? t('toast.autoAlignOn') : t('toast.autoAlignOff'));
    } else if (a === 'toggleExplodingPiles') {
      const on = world.toggleExplodingPiles();
      overlay.toast(on ? t('toast.explodingPilesOn') : t('toast.explodingPilesOff'));
    } else if (a === 'pileLayout' && ctxTarget) {
      world.togglePileLayout(ctxTarget);
    } else if (a === 'fanOut' && ctxTarget) {
      world.fanOutPile(ctxTarget);
      overlay.toast(t('toast.pileFanned'));
    } else if (a === 'breakPile' && ctxTarget) {
      world.breakPile(ctxTarget);
    } else if (a === 'shakePile' && ctxTarget) {
      world.shakePile(ctxTarget);
    } else if (a === 'pilePage' && ctxTarget) {
      world.nextPilePage(ctxTarget);
    } else if (a === 'pin' && ctxTarget) {
      const pinned = world.togglePin(ctxTarget);
      overlay.toast(pinned ? t('toast.pinned') : t('toast.unpinned'));
    } else if (a === 'gridView') {
      // P0 — Grid View da seleção
      const n = world.gridViewSelection(ctxTargets);
      overlay.toast(n > 0 ? t('toast.gridApplied') : t('toast.nothingToGrid'));
    } else if (a === 'sortBySize' || a === 'sortByType') {
      // P0 — Sort by Size / Sort by Type
      const bySize = a === 'sortBySize';
      const n = world.sortSelection(bySize ? 'size' : 'type', ctxTargets);
      overlay.toast(
        n > 0 ? t(bySize ? 'toast.sortedBySize' : 'toast.sortedByType') : t('toast.nothingToGrid'),
      );
    } else if (a === 'duplicate') {
      // P0 — Duplicar seleção
      const n = world.duplicateSelection(ctxTargets);
      overlay.toast(n > 0 ? t('toast.duplicated', { n }) : t('toast.nothingToDuplicate'));
    } else if (a === 'scaleUp' || a === 'scaleDown') {
      // P0 — Escala com feedback de limite
      toastScale(world.scaleSelection(a === 'scaleUp' ? 1 : -1, ctxTargets));
    } else if (a === 'newNote' && ctxFloorPoint) {
      // Cria a nota e abre o editor (ponto no piso, levemente elevado)
      const id = world.addStickyNote(
        { x: ctxFloorPoint.x, y: 1.2, z: ctxFloorPoint.z },
        '',
      );
      const screen = renderer.projectToScreen(world.getObject(id)!.pose.position);
      void overlay.editNote({ x: screen.x + 40, y: screen.y - 80 }, '').then((text) => {
        if (text === '') {
          world.removeObject(id); // cancelou sem escrever
        } else {
          world.setNoteText(id, text);
          overlay.toast(t('toast.noteCreated'));
        }
      });
    } else if (a === 'editNote' && ctxTarget && world.isStickyNote(ctxTarget)) {
      const id = ctxTarget;
      const current = (world.getObject(id)?.meta.noteText as string) ?? '';
      const screen = renderer.projectToScreen(world.getObject(id)!.pose.position);
      void overlay.editNote({ x: screen.x + 40, y: screen.y - 80 }, current).then((text) => {
        if (text === '') {
          world.removeObject(id); // esvaziou = apaga a nota
          overlay.toast(t('toast.noteRemoved'));
        } else {
          world.setNoteText(id, text);
        }
      });
    }
    ctxTarget = null;
    ctxTargets = [];
  });

  input.setListener((action: InputAction) => {
    if (action.type === 'context') {
      ctxTarget = world.pickObjectAt(action.world);
      // Alvos: seleção inteira se o item clicado está selecionado, senão só ele
      const selected = world.getSelectedIds();
      ctxTargets = ctxTarget
        ? selected.includes(ctxTarget)
          ? selected
          : [ctxTarget]
        : [];
      const items: ContextMenuItem[] = [];
      if (ctxTarget) items.push({ label: t('menu.open'), action: 'open', hint: t('hint.open') });
      items.push({ label: t('menu.openDir'), action: 'openDir', hint: t('hint.openDir') });
      if (ctxTarget) {
        if (world.isStickyNote(ctxTarget)) {
          items.push({ label: t('menu.editNote'), action: 'editNote', hint: t('hint.editNote') });
        }
        items.push({ label: t('menu.rename'), action: 'rename', hint: t('hint.rename') });
        items.push({
          label: t('menu.pileLayout'),
          action: 'pileLayout',
          hint: t('hint.pileLayout'),
        });
        if (world.inPile(ctxTarget)) {
          items.push({ label: t('menu.fanOut'), action: 'fanOut', hint: t('hint.fanOut') });
          items.push({
            label: t('menu.breakPile'),
            action: 'breakPile',
            danger: true,
            hint: t('hint.breakPile'),
          });
          items.push({
            label: t('menu.shakePile'),
            action: 'shakePile',
            hint: t('hint.shakePile'),
          });
        }
        if (world.isGridPile(ctxTarget)) {
          items.push({ label: t('menu.pilePage'), action: 'pilePage', hint: t('hint.pilePage') });
        }
        const pinned = world.isPinned(ctxTarget);
        items.push({
          label: pinned ? t('menu.unpin') : t('menu.pin'),
          action: 'pin',
          hint: pinned ? t('hint.unpin') : t('hint.pin'),
        });
        // P0 — operações sobre a SELEÇÃO (grade, ordenar, duplicar, escala)
        items.push({ label: t('menu.gridView'), action: 'gridView', hint: t('hint.gridView') });
        items.push({
          label: t('menu.sortBySize'),
          action: 'sortBySize',
          hint: t('hint.sortBySize'),
        });
        items.push({
          label: t('menu.sortByType'),
          action: 'sortByType',
          hint: t('hint.sortByType'),
        });
        items.push({
          label: t('menu.duplicate'),
          action: 'duplicate',
          hint: t('hint.duplicate'),
        });
        items.push({ label: t('menu.scaleUp'), action: 'scaleUp', hint: t('hint.scaleUp') });
        items.push({ label: t('menu.scaleDown'), action: 'scaleDown', hint: t('hint.scaleDown') });
        items.push({ label: t('menu.delete'), action: 'delete', danger: true, hint: t('hint.delete') });
      }
      // Chão vazio → criar nota adesiva + auto-pilha por tipo (M6 / Fase 7) + toggles P1
      if (!ctxTarget) {
        ctxFloorPoint = { ...action.world };
        items.push({ label: t('menu.newNote'), action: 'newNote', hint: t('hint.newNote') });
        items.push({ label: t('menu.autoPile'), action: 'autoPile', hint: t('hint.autoPile') });
        items.push({
          label: `${t('menu.toggleAutoAlign')} (${world.isAutoAlign() ? '✓' : '✗'})`,
          action: 'toggleAutoAlign',
          hint: t('hint.toggleAutoAlign'),
        });
        items.push({
          label: `${t('menu.toggleExplodingPiles')} (${world.isExplodingPiles() ? '✓' : '✗'})`,
          action: 'toggleExplodingPiles',
          hint: t('hint.toggleExplodingPiles'),
        });
      }
      overlay.showContextMenu(action.screen, items);
      return;
    }
    if (action.type === 'doubleTap') {
      const target = world.pickObjectAt(action.world);
      if (target) {
        void files.openObject(target).then((r) => {
          if (r === 'imported') overlay.toast(t('toast.folderImported'));
          else if (r === 'error') overlay.toast(t('toast.openFailed'));
        });
      }
      return;
    }

    // Soltar em pasta → move o arquivo (M2)
    if (action.type === 'pointerDown') {
      dragSourceId = world.pickObjectAt(action.world);
    }
    world.processAction(action);
    if (action.type === 'pointerUp' && dragSourceId) {
      const dropTarget = world.pickObjectAt(action.world);
      const src = world.getObject(dragSourceId);
      if (
        dropTarget &&
        dropTarget !== dragSourceId &&
        src?.meta.fsPath !== undefined &&
        world.getObject(dropTarget)?.meta.isDir === true
      ) {
        const srcId = dragSourceId;
        void files.moveInto(srcId, dropTarget).then((ok) => {
          overlay.toast(ok ? t('toast.fileMoved') : t('toast.moveFailed'));
        });
      }
      dragSourceId = null;
    }
  });

  // Duplo-clique (desktop) → em pilha: abre em leque; em nota: edita texto;
  // no chão vazio: fecha leques; senão: abre o objeto (M2/Fase 7)
  const onDblClick = (e: MouseEvent) => {
    const rect = renderer.getCanvas().getBoundingClientRect();
    const worldPt = resolveFloor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const target = world.pickObjectAt(worldPt);
    if (!target) {
      // Chão vazio → fecha leques (Fase 7: duplo-clique no chão recolhe)
      if (world.collapseFanOuts() > 0) overlay.toast(t('toast.fansClosed'));
      return;
    }
    // Item de pilha → fan out (leque) como no original
    if (world.inPile(target)) {
      world.fanOutPile(target);
      overlay.toast(t('toast.pileFanned'));
      return;
    }
    if (world.isStickyNote(target)) {
      const current = (world.getObject(target)?.meta.noteText as string) ?? '';
      const screen = renderer.projectToScreen(world.getObject(target)!.pose.position);
      void overlay.editNote({ x: screen.x + 40, y: screen.y - 80 }, current).then((text) => {
        if (text === '') {
          world.removeObject(target);
          overlay.toast(t('toast.noteRemoved'));
        } else {
          world.setNoteText(target, text);
        }
      });
      return;
    }
    void files.openObject(target).then((r) => {
      if (r === 'imported') overlay.toast(t('toast.folderImported'));
      else if (r === 'error') overlay.toast(t('toast.openFailed'));
    });
  };
  renderer.getCanvas().addEventListener('dblclick', onDblClick);

  // Resize
  const resize = () => {
    const w = sceneRoot.clientWidth || window.innerWidth;
    const h = sceneRoot.clientHeight || window.innerHeight;
    renderer.resize(w, h);
    world.setCamera(world.getCamera()); // força re-render
  };
  window.addEventListener('resize', resize);
  resize();

  // Teclado: presets de câmera (1–4), reset (0), escala (+/−), tema (T),
  // renomear (F2), excluir (Delete)
  const themeIdxRef = { value: themeIdx % THEMES.length };
  const onKey = (e: KeyboardEvent) => {
    // Não rouba atalhos enquanto o usuário digita (editor de nota/nome)
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key >= '1' && e.key <= '4') {
      world.setCameraPreset(Number(e.key));
    } else if (e.key === '0') {
      // Reset Camera (P0) — mesma vista do botão (preset 1)
      world.setCameraPreset(1);
    } else if (e.key === '+' || e.key === '=') {
      // P0 — escala da seleção com feedback de limite
      toastScale(world.scaleSelection(1));
    } else if (e.key === '-' || e.key === '_') {
      toastScale(world.scaleSelection(-1));
    } else if (e.key === 't' || e.key === 'T') {
      const next = (themeIdxRef.value + 1) % THEMES.length;
      themeIdxRef.value = next;
      world.setTheme(THEMES[next]);
      repo.setSetting('themeIndex', next).catch(() => {});
      overlay.toast(t('toast.theme', { name: THEMES[next].name }));
    } else if (e.key === 'F2') {
      // Renomear o selecionado (Fase 7)
      const id = world.getSelectedId();
      if (!id) return;
      const current = world.getObject(id)?.label ?? '';
      const screen = renderer.projectToScreen(world.getObject(id)!.pose.position);
      e.preventDefault();
      void overlay
        .editNote({ x: screen.x + 40, y: screen.y - 80 }, current, t('ui.namePlaceholder'))
        .then((text) => {
          const next = text.trim();
          if (next !== '' && next !== current) {
            world.renameObject(id, next);
            overlay.toast(t('toast.renamed'));
          }
        });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Excluir seleção múltipla (Fase 7)
      const ids = world.getSelectedIds();
      if (ids.length === 0) return;
      for (const id of ids) world.removeObject(id);
      if (ids.length > 1) overlay.toast(t('toast.deleted', { n: ids.length }));
    }
  };
  window.addEventListener('keydown', onKey);

  // Reset Camera (P0): botão no canto superior direito (overlay) → preset 1
  const onResetCamera = () => world.setCameraPreset(1);
  overlayRoot.addEventListener('resetcamera', onResetCamera);

  // Persistência: carrega cena salva ou cria cenário de demonstração
  const saved = await repo.loadScene();
  if (saved && saved.objects.length > 0) {
    world.loadSnapshot(saved);
    overlay.toast(
      t('toast.sceneRestored', { n: saved.objects.length, backend: repo.backend() }),
    );
  } else {
    seedDemoScene(world);
    overlay.toast(t('toast.newScene', { backend: repo.backend() }));
  }

  // A (resize por arraste): estado do gesto
  let resizeGesture: { startScale: number; center: { x: number; y: number; z: number }; dist0: number } | null = null;

  // Handle de resize: callback do overlay — inicia listeners globais p/ move/up
  overlay.onResizeStart((e: PointerEvent) => {
    const bounds = world.getSelectionBounds();
    if (!bounds) return;
    const center = bounds.center;
    const screenCenter = renderer.projectToScreen(center);
    if (!screenCenter.visible) return;
    const dx = e.clientX - screenCenter.x;
    const dy = e.clientY - screenCenter.y;
    const dist0 = Math.hypot(dx, dy);
    if (dist0 < 1) return;
    const ids = world.getSelectedIds();
    let avgScale = 1;
    if (ids.length > 0) {
      let sum = 0;
      for (const id of ids) {
        const obj = world.getObject(id);
        if (obj) sum += obj.scale > 0 ? obj.scale : 1;
      }
      avgScale = sum / ids.length;
    }
    resizeGesture = { startScale: avgScale, center, dist0 };

    // Listeners globais p/ o gesto de resize
    const onMove = (me: PointerEvent) => {
      if (!resizeGesture) return;
      const dx = me.clientX - screenCenter.x;
      const dy = me.clientY - screenCenter.y;
      const dist = Math.hypot(dx, dy);
      const factor = dist / resizeGesture.dist0;
      const targetScale = resizeGesture.startScale * factor;
      world.setScaleSelection(targetScale);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      resizeGesture = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
    e.stopPropagation();
  });

  // Pile Widget Halo (P1): ações do anel de widgets da pilha
  overlay.onPileHaloAction((pileId, action) => {
    switch (action) {
      case 'grid':
        world.togglePileGrid(pileId);
        break;
      case 'fan':
        world.togglePileFan(pileId);
        break;
      case 'leaf':
        world.navigatePile(pileId, 1);
        break;
      case 'messy':
        world.togglePileMessy(pileId);
        break;
      case 'break':
        world.breakPile(pileId);
        break;
    }
  });

  // Ações de Scrub (P1 — Dwell & Scrub)
  overlay.onScrubItemSelect((pileId, itemId) => {
    world.selectScrubItem(pileId, itemId);
  });
  overlay.onScrubHover?.((pileId, index) => {
    world.setScrubIndex(pileId, index);
  });

  // Main loop com flush de persistência + handle de resize + halo de pilha
  const loop = new MainLoop({
    world,
    onRender: () => {
      renderer.render();
      // Atualiza handle de resize (A): projeta 8 cantos do bbox → AABB tela → canto sup-dir
      const bounds = world.getSelectionBounds();
      if (bounds && world.getSelectedIds().length > 0) {
        const { min, max } = bounds;
        const corners = [
          { x: min.x, y: min.y, z: min.z },
          { x: max.x, y: min.y, z: min.z },
          { x: min.x, y: max.y, z: min.z },
          { x: max.x, y: max.y, z: min.z },
          { x: min.x, y: min.y, z: max.z },
          { x: max.x, y: min.y, z: max.z },
          { x: min.x, y: max.y, z: max.z },
          { x: max.x, y: max.y, z: max.z },
        ];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let anyVisible = false;
        for (const c of corners) {
          const s = renderer.projectToScreen(c);
          if (s.visible) {
            anyVisible = true;
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x);
            maxY = Math.max(maxY, s.y);
          }
        }
        if (anyVisible) {
          overlay.setResizeHandle({ x: maxX, y: minY });
        } else {
          overlay.setResizeHandle(null);
        }
      } else {
        overlay.setResizeHandle(null);
      }

      // Atualiza Pile Widget Halo (P1): projeta topo central da pilha → tela
      const haloState = world.getPileHaloState();
      if (haloState) {
        const center = world.getPileCenter(haloState.pileId);
        if (center) {
          const s = renderer.projectToScreen(center);
          if (s.visible) {
            overlay.setPileHalo({
              pileId: haloState.pileId,
              screen: { x: s.x, y: s.y },
              layout: haloState.layout,
              messy: haloState.messy,
              itemCount: haloState.itemCount,
            });
          } else {
            overlay.setPileHalo(null);
          }
        } else {
          overlay.setPileHalo(null);
        }
      } else {
        overlay.setPileHalo(null);
      }

      // Atualiza Dwell Ring (P1 — Dwell & Scrub): projeta centro da pilha → tela
      const dwellState = world.getDwellRingState();
      if (dwellState) {
        const center = world.getPileCenter(dwellState.pileId);
        if (center) {
          const s = renderer.projectToScreen(center);
          if (s.visible) {
            overlay.setDwellRing({
              pileId: dwellState.pileId,
              screen: { x: s.x, y: s.y },
              progress: dwellState.progress,
              active: dwellState.active,
            });
          } else {
            overlay.setDwellRing(null);
          }
        } else {
          overlay.setDwellRing(null);
        }
      } else {
        overlay.setDwellRing(null);
      }

      // Atualiza Scrub Strip (P1 — Faixa de miniaturas do scrub): projeta centro da pilha → tela
      const scrubState = world.getScrubStripState();
      if (scrubState) {
        const center = world.getPileCenter(scrubState.pileId);
        if (center) {
          const s = renderer.projectToScreen(center);
          if (s.visible) {
            overlay.setScrubStrip({
              pileId: scrubState.pileId,
              screen: { x: s.x, y: s.y },
              items: scrubState.items,
              activeIndex: scrubState.activeIndex,
            });
          } else {
            overlay.setScrubStrip(null);
          }
        } else {
          overlay.setScrubStrip(null);
        }
      } else {
        overlay.setScrubStrip(null);
      }
    },
    onFlush: () => {
      repo.saveScene(world.toSnapshot()).catch((e) => console.warn('save falhou', e));
    },
  });
  loop.start();

  // Watcher de pasta (M2): polling + diff, pausado com a aba oculta
  const WATCH_MS = 5000;
  const watcher = window.setInterval(() => {
    if (document.hidden) return;
    void files.syncDirectory().then((d) => {
      if (d.added || d.removed) {
        overlay.toast(t('toast.folderUpdated', { added: d.added, removed: d.removed }));
      }
    });
  }, WATCH_MS);

  return {
    world,
    repo,
    loop,
    files,
    renderer,
    overlay,
    dispose() {
      loop.stop();
      window.clearInterval(watcher);
      input.detach();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      overlayRoot.removeEventListener('resetcamera', onResetCamera);
      renderer.getCanvas().removeEventListener('dblclick', onDblClick);
      renderer.dispose();
      physics.dispose();
      repo.close();
    },
  };
}

/** Cenário de demonstração: cards finos deitados na mesa com ícone e rótulo. */
function seedDemoScene(world: World): void {
  const colors = ['#4f9cff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b'];
  const labels = ['relatorio.pdf', 'foto.jpg', 'notas.txt', 'planilha.xlsx', 'apresentacao.pptx', 'codigo.zip'];
  for (let i = 0; i < 6; i++) {
    const x = (i % 3) * 26 - 26;
    const z = Math.floor(i / 3) * 26 - 13;
    // Fichas finas deitadas no chão (halfExtents.y = 0.6)
    const id = world.addBox({ x, y: 0.8, z }, { x: 7, y: 0.6, z: 8.5 }, colors[i], labels[i]);
    // Textura do card com ícone + nome impresso
    world.setObjectThumb(id, iconForExt(labels[i].split('.').pop() ?? '', labels[i]));
  }
  // Um empilhado p/ testar depois
  const pileId = world.addBox({ x: 50, y: 0.8, z: 0 }, { x: 7, y: 0.6, z: 8.5 }, '#20c997', 'Minha Pasta');
  world.setObjectThumb(pileId, iconForExt('folder', 'Minha Pasta'));
}

// O filesystem real (Modo A/B) entra no M2; placeholder p/ tipar o contexto.
export type FileSystemLike = IFileSystem;
