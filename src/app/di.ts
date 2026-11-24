/**
 * Composition root — fio todos os adapters nos ports do core.
 *
 * É o ÚNICO lugar que conhece implementações concretas (Rapier, three, SQLite,
 * Pointer, DOM). O `core` continua puro. Em Tauri/Electron, troca-se só aqui.
 */
import { World } from '@core/world';
import type { Vec3, BoxEntityData } from '@core/model/types';
import { rotateVec3ByQuat } from '@core/util/math';
import type { ContextMenuItem, IFileSystem, IRepo, InputAction } from '@core/ports/index';
import { isLang, setLang, t } from '@core/i18n/i18n';
import { RapierPhysics } from '@physics/rapier/rapierPhysics';
import { ThreeRenderer } from '@render/three/threeRenderer';
import { SqliteRepo } from '@persistence/sqlite/sqliteRepo';
import { PointerInput } from '@input/pointer/pointerInput';
import { DomOverlay } from '@overlay/overlay';
import { CloudflareAuth } from '@auth/cloudflareAuth';
import {
  TaigaError,
  fetchTaigaStories,
  fetchSprintStories,
  fetchTaigaSprints,
  fetchTaigaProjects,
  pickMyProjects,
  resolveProjectId,
  initTaigaTokenFromUrl,
  fetchStoryDetail,
  fetchTaigaMe,
  getTaigaToken,
  setTaigaToken,
  loginTaiga,
  changeTaigaPassword,
  type TaigaUser,
} from '@taiga/taiga';
import { makeNoteTexture, makeTaigaCardTexture } from './noteTexture';
import { isImagePath } from '../fs/thumbnails';
import { MainLoop } from './main-loop';
import { DEFAULT_ROOM, TypeFlags } from '@core/model/types';
import { THEMES } from '@core/theme/theme';
import { FsAccessFileSystem } from '@fs/fsAccess';
import { OpfsFileSystem } from '@fs/opfsFs';
import { iconForExt } from '@fs/fileIcons';
import { FileService } from './fileService';
import { BuildingView } from '../building/BuildingView';

export interface AppContext {
  world: World;
  repo: IRepo;
  loop: MainLoop;
  files: FileService;
  renderer: ThreeRenderer;
  overlay: DomOverlay;
  /** PR27 — auth/nuvem (Cloudflare D1 via Pages Functions same-origin). */
  auth: CloudflareAuth;
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
  initTaigaTokenFromUrl();
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
  // PR9/PR12 — a nota é DESENHADA no papel (textura na face de cima): o
  // provider recebe o meta inteiro (título/cor/lembrete/desenho) e pode
  // devolver Promise (o desenho carrega async).
  world.setNoteTextureProvider((meta) =>
    makeNoteTexture({
      text: (meta.noteText as string) ?? '',
      title: (meta.noteTitle as string) ?? undefined,
      bg: (meta.noteBg as string) ?? undefined,
      drawing: (meta.noteDrawing as string) ?? undefined,
      reminder: typeof meta.noteReminder === 'number' ? (meta.noteReminder as number) : undefined,
    }),
  );

  // PR4.11 — card do Taiga: face superior desenhada com quebra de linha do título completo
  world.setTaigaTextureProvider((meta, showTitle) =>
    makeTaigaCardTexture({
      ref: (meta.taigaRef as number) ?? 0,
      subject: (meta.taigaSubject as string) ?? '',
      statusName: (meta.taigaStatus as string) ?? '',
      statusColor: (meta.taigaStatusColor as string) ?? '#8b5cf6',
      showTitle,
    }),
  );

  // PR4.11 fix — re-sync automático de cards Taiga "velhos" (snapshot pré-PR4.11)
  world.setTaigaSyncProvider(async (boxId, type) => {
    const box = world.getBox(boxId);
    if (!box || !box.taigaProject) return;
    try {
      if (type === 'backlog') {
        const stories = await fetchTaigaStories(box.taigaProject);
        world.syncBoxStories(boxId, stories);
      } else if (type === 'sprint' || type === 'kanban') {
        let milestoneId = box.taigaSprintId;
        if (!milestoneId) {
          const projectId = await resolveProjectId(box.taigaProject);
          const sprints = await fetchTaigaSprints(projectId);
          const active = sprints.find((s) => !s.closed) ?? sprints[0];
          if (!active) return;
          milestoneId = active.id;
        }
        const stories = await fetchSprintStories(milestoneId);
        world.syncSprintStories(boxId, stories, milestoneId);
      }
    } catch {
      // Silencioso: o usuário pode clicar no andar novamente p/ forçar sync
    }
  });

  // Tema persistido (settings) — aplica no renderer
  const themeIdx = await repo.getSetting<number>('themeIndex', 0);
  const activeTheme = THEMES[themeIdx % THEMES.length];
  world.setTheme(activeTheme);
  overlay.setThemeActive(activeTheme.name);

  // Nomes dos arquivos (rótulos) — preferência persistida no menu do chão
  const showNames = await repo.getSetting<boolean>('showNames', true);
  world.setShowNames(showNames);

  // Filesystem (M2): Modo A (FS Access) com fallback Modo B (OPFS)
  const fs: IFileSystem = new FsAccessFileSystem(new OpfsFileSystem());
  await fs.requestDirectory().catch(() => false);
  const files = new FileService(world, fs, repo);

  // PR27 — auth (Cloudflare D1 via Pages Functions same-origin `/api/*`).
  // Sem a API (D1 não configurado/offline), tudo degrada: o app segue 100%
  // funcional em modo local (OPFS), como sempre.
  const auth = new CloudflareAuth();

  // PR4.5 — Backlog (Taiga): sincroniza uma caixa backlog com as user
  // stories PÚBLICAS do projeto configurado (só leitura; erro vira toast).
  // Chamada ao entrar na caixa (prédio/painel) e ao criá-la.
  async function syncBacklog(boxId: string): Promise<void> {
    const box = world.getBox(boxId);
    if (!box || box.type !== 'backlog') return;
    overlay.hideSprintBadge();
    if (!box.taigaProject) {
      overlay.toast(t('toast.backlogNoSlug'));
      return;
    }
    try {
      const stories = await fetchTaigaStories(box.taigaProject);
      const n = world.syncBoxStories(boxId, stories);
      if (n === 0) overlay.toast(t('toast.backlogEmpty', { slug: box.taigaProject }));
      else if (n > 0) overlay.toast(t('toast.backlogSynced', { name: box.name, n }));
    } catch (err) {
      overlay.toast(err instanceof TaigaError ? t(err.message) : t('ui.taiga.httpError'));
    }
  }

  // PR4.6/PR4.15 — Sprint (Taiga): sincroniza uma caixa sprint com a sprint ativa ou selecionada.
  async function syncSprint(boxId: string, forcedSprintId?: number, forcedSprintName?: string): Promise<void> {
    const box = world.getBox(boxId);
    if (!box || (box.type !== 'sprint' && box.type !== 'kanban')) {
      overlay.hideSprintBadge();
      return;
    }
    if (!box.taigaProject) {
      overlay.toast(t('toast.backlogNoSlug'));
      overlay.hideSprintBadge();
      return;
    }
    try {
      let milestoneId = forcedSprintId ?? box.taigaSprintId;
      let sprintName = forcedSprintName ?? box.taigaSprintName;
      if (!milestoneId) {
        const projectId = await resolveProjectId(box.taigaProject);
        const sprints = await fetchTaigaSprints(projectId);
        const active = sprints.find((s) => !s.closed) ?? sprints[0];
        if (!active) {
          overlay.toast(t('toast.backlogEmpty', { slug: box.taigaProject }));
          overlay.setSprintBadge('Sem sprints', false);
          return;
        }
        milestoneId = active.id;
        sprintName = active.name;
      }
      const stories = await fetchSprintStories(milestoneId);
      const n = world.syncSprintStories(boxId, stories, milestoneId, sprintName);
      overlay.setSprintBadge(sprintName || `Sprint #${milestoneId}`, true);
      if (n === 0) overlay.toast(t('toast.backlogEmpty', { slug: box.taigaProject }));
      else if (n > 0) overlay.toast(t('toast.backlogSynced', { name: box.name, n }));
    } catch (err) {
      overlay.toast(err instanceof TaigaError ? t(err.message) : t('ui.taiga.httpError'));
    }
  }

  // PR4.15 — Abre o seletor modal de Sprints do projeto vinculado à caixa
  async function openSprintSelector(boxId: string): Promise<void> {
    const box = world.getBox(boxId);
    if (!box || !box.taigaProject) {
      overlay.toast(t('toast.backlogNoSlug'));
      return;
    }

    overlay.toast(t('ui.sprintLoading'));
    try {
      const projectId = await resolveProjectId(box.taigaProject);
      const sprints = await fetchTaigaSprints(projectId);
      if (sprints.length === 0) {
        overlay.toast(t('ui.sprintNoSprints'));
        return;
      }

      overlay.showSprintPickerModal({
        boxName: box.name,
        projectName: box.taigaProject,
        currentSprintId: box.taigaSprintId,
        sprints,
        onSelect: async (selected) => {
          world.setBoxSprint(box.id, selected.id, selected.name);
          await syncSprint(box.id, selected.id, selected.name);
          await repo.saveScene(world.toSnapshot()).catch(() => {});
          overlay.toast(t('toast.sprintChanged', { name: selected.name }));
        },
      });
    } catch (err) {
      overlay.toast(err instanceof TaigaError ? t(err.message) : t('ui.taiga.httpError'));
    }
  }

  // PR4.4 — Building View: prédio 3D com andares = caixas (primeira tela ao carregar)
  const buildingHost = document.body || sceneRoot;
  const buildingView = new BuildingView();
  buildingView.mount(buildingHost);
  buildingView.setBoxes(world.listBoxes());
  buildingView.selectFloor(world.getCurrentBoxId());

  // A primeira tela a ser renderizada é sempre o prédio 3D
  const skipBuilding =
    typeof window !== 'undefined' &&
    window.location.search.includes('nobuilding=1');

  // ── Dashboard: stats, busca global e dots de match ───────────────────────
  // PR4.16 — persistência TRAVADA enquanto o muro de login está de pé: sem
  // isso o flush de 2 s (e o PUT da nuvem) gravaria o mundo ZERADO por cima
  // da cena do usuário — logout nunca pode apagar dado salvo.
  let persistLocked = false;
  /** Timer do PUT pendente na nuvem (declarado cedo p/ o muro cancelá-lo). */
  let cloudSyncTimer = 0;

  // PR4.16 — duas visões do mesmo app: prédio 1 = PESSOAL (caixas locais,
  // dados gravados na conta) e prédio 2 = TRABALHO (projetos do Taiga).
  // O snapshot guarda as DUAS; a visão ativa decide o que a UI mostra.
  let viewMode: 'personal' | 'work' = 'personal';
  /** Slugs dos projetos do Taiga dos quais sou membro (null = sem Taiga). */
  let mySlugs: Set<string> | null = null;
  /** Caixas da visão ativa — o que lista, pilha 3D, busca e resumo mostram. */
  let viewBoxes: BoxEntityData[] = [];

  const updateBuildingStats = () => {
    const rawStats = world.getBoxStats();
    const boxes = (viewBoxes.length > 0 ? viewBoxes : world.listBoxes()).map((box) => {
      const s = rawStats.find((r) => r.boxId === box.id);
      return {
        boxId:     box.id,
        notes:     s?.notes     ?? 0,
        photos:    s?.photos    ?? 0,
        documents: s?.documents ?? 0,
        others:    s?.others    ?? 0,
        noteItems: s?.noteItems ?? [],
      };
    });
    buildingView.setStats({ boxes });
  };

  /**
   * PR4.16 — recalcula as caixas visíveis (isolamento Taiga × visão ativa)
   * e sincroniza lista, pilha 3D, resumo e botão 🏠/🏢 do HUD.
   */
  const refreshBoxes = (): void => {
    const base = world
      .listBoxes()
      .filter((b) => mySlugs === null || !b.taigaProject || mySlugs.has(b.taigaProject));
    let vis =
      viewMode === 'work'
        ? base.filter((b) => !!b.taigaProject)
        : base.filter((b) => !b.taigaProject);
    // Prédio 2 sem nenhuma caixa (Taiga desconectado/sem projetos) → volta
    // pro prédio 1 em vez de mostrar uma visão vazia sem explicação.
    if (viewMode === 'work' && vis.length === 0) {
      viewMode = 'personal';
      vis = base.filter((b) => !b.taigaProject);
    }
    viewBoxes = vis;
    // Caixa ativa fora da visão atual? Pula para a primeira da visão —
    // senão a pessoa ficaria "dentro" de um prédio que não está na lista.
    if (vis.length > 0 && !vis.some((b) => b.id === world.getCurrentBoxId())) {
      world.setCurrentBox(vis[0]!.id);
    }
    buildingView.setBoxes(vis);
    buildingView.selectFloor(world.getCurrentBoxId());
    updateBuildingStats();
    overlay.setViewMode(viewMode);
  };
  updateBuildingStats();

  // PR4.12 — Abre o modal de perfil de usuário unificado
  async function openUserProfileModal(): Promise<void> {
    const customAvatar = await repo.getSetting<string | null>('userAvatar', null);
    const me = await fetchTaigaMe().catch(() => null);
    const token = getTaigaToken();
    const isAuth = !!me || !!auth.current();

    overlay.showUserProfileModal({
      name: me?.fullName || me?.username || auth.current()?.email || 'Visitante',
      email: me?.email || auth.current()?.email,
      username: me?.username,
      photo: customAvatar || me?.photo || null,
      isAuth,
      taigaConnected: !!token && !!me,
      onChangePhoto: (dataUrl) => {
        void repo.setSetting('userAvatar', dataUrl);
        buildingView.setUserProfile({
          name: me?.fullName || me?.username || 'Usuário',
          email: me?.email,
          photo: dataUrl,
          isAuth: true,
        });
        overlay.toast(t('ui.profile.changePhoto') + ': ' + t('ui.profile.passSuccess'));
      },
      onChangePassword: async (curPass, newPass) => {
        try {
          await changeTaigaPassword(curPass, newPass);
          return { ok: true };
        } catch (err: unknown) {
          const msg = err instanceof TaigaError ? t(err.message) : t('ui.taiga.httpError');
          return { ok: false, error: msg };
        }
      },
      onSignOut: () => {
        signOutReal();
      },
      onConnectTaiga: async (user, pass, tok) => {
        try {
          if (user && pass) {
            const newToken = await loginTaiga(user, pass);
            setTaigaToken(newToken);
          } else if (tok) {
            setTaigaToken(tok);
          }
          const newMe = await fetchTaigaMe();
          if (newMe) {
            overlay.toast(`${t('ui.taiga.authSuccess')} (${newMe.fullName})`);
            forceWall = false; // conexão Taiga = sessão → muro pode descer
            void initUserBuilding();
            return { ok: true };
          } else {
            setTaigaToken(null);
            return { ok: false, error: t('ui.taiga.invalidCredentials') };
          }
        } catch (err: unknown) {
          setTaigaToken(null);
          const msg = err instanceof TaigaError ? t(err.message) : t('ui.taiga.invalidCredentials');
          return { ok: false, error: msg };
        }
      },
      // PR4.12 fix — login/cadastro com conta do app (cloudflareAuth)
      onAppAuth: async (email, password) => {
        try {
          const res = await auth.signIn(email, password);
          if (res.ok) {
            overlay.toast(t('toast.authWelcome', { email: auth.current()!.email }));
            forceWall = false; // login explícito → muro pode descer
            void initUserBuilding();
            return { ok: true };
          }
          return { ok: false, error: res.error };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : t('toast.authFailed');
          return { ok: false, error: msg };
        }
      },
    });
  }

  // PR4.12 — Carrega o Prédio 3D do Usuário com tela de loading e sincronização automática
  // PR4.14 — Muro de login: sem sessão confirmada NADA é carregado (nem cena,
  // nem caixas, nem o demo) — e o modal de login/cadastro abre na cara.
  let loginWalled = false;
  /**
   * PR4.16 — muro FORÇADO: alguém saiu do sistema e o backend não deu para
   * confirmar a sessão (API fora / cookie ainda valendo). Sem este flag o
   * fail-open do PR4.14 religaria a cena — e o pedido é claro: depois de
   * sair, só pode sobrar a tela de login.
   */
  let forceWall = false;

  /**
   * PR4.16 — muro de login REAL: nada do prédio/caixas fica visível nem
   * clicável (véu cobre cena e HUD, só o modal de login fica por cima) e o
   * mundo em memória é zerado. O que está SALVO não é tocado: a persistência
   * fica travada até o próximo login, para o flush de 2 s nunca gravar o
   * mundo limpo por cima da cena do usuário.
   */
  const raiseLoginWall = (): void => {
    loginWalled = true;
    persistLocked = true;
    if (cloudSyncTimer) {
      window.clearTimeout(cloudSyncTimer);
      cloudSyncTimer = 0;
    }

    // Mundo em memória zerado: nenhuma caixa nem objeto para ver/clicar
    for (const o of world.listObjects()) world.removeObject(o.id);
    for (const b of world.listBoxes()) {
      if (b.id === 'box-default') continue; // sala raiz não é removível
      world.removeBoxEntity(b.id);
    }

    // Prédio, painéis da cena e demais flutuantes fechados
    buildingView.hide();
    buildingView.closePanels();
    buildingView.hideLoading();
    overlay.hideBoxesPanel();
    overlay.hideContextMenu();
    overlay.hideThemeMenu();
    overlay.hideBuildingBack();
    overlay.hideAuthModal();
    overlay.setFavoriteFilterActive(false);
    buildingView.setFavoriteFilter(false);
    overlay.setViewSwitchVisible(false);
    overlay.setAuthState(null);

    // Véu + tela de login na cara (abas Conta do BumpTop × Taiga FNDE)
    overlay.setAuthWall(true);
    void openUserProfileModal();
  };

  /** PR4.16 — sair do sistema: muro na hora e só depois confirma com o backend. */
  const signOutReal = (): void => {
    setTaigaToken(null);
    forceWall = true;
    raiseLoginWall();
    overlay.toast(t('ui.taiga.tokenRemoved'));
    void auth
      .signOut()
      .catch(() => {})
      .then(() => initUserBuilding()); // sessão confirmada ou não, o muro fica
  };

  async function initUserBuilding(): Promise<void> {
    // Com ?nobuilding=1 o prédio fica invisível (container opacity 0), mas o
    // loadingOverlay é filho dele com pointer-events:auto → bloqueava a cena
    // inteira nos ~1.5s iniciais (cliques do menu de contexto "não abriam").
    if (!skipBuilding) {
      buildingView.showLoading(t('ui.building.loading'), t('ui.building.loadingSub'));
    }

    // 1) Sessões ANTES de qualquer carga de cena (é o que decide o muro)
    initTaigaTokenFromUrl();
    const token = getTaigaToken();
    let me: TaigaUser | null = null;
    if (token) {
      try {
        me = await fetchTaigaMe();
      } catch {}
    }
    const appSession = auth.current() ?? (await auth.getSession().catch(() => null));

    // Visitante CONFIRMADO = sem Taiga, sem conta e o backend de auth respondeu
    // dizendo "não autenticado". Sem backend (dev/preview sem /api, rede fora)
    // a sessão fica indeterminada → fail-open, segue o modo demo normal.
    // `forceWall` cobre o caso de saída do sistema com a API fora: aí o muro
    // não depende da confirmação do backend.
    if (forceWall || (!me && !appSession && auth.isSessionKnown())) {
      raiseLoginWall();
      return; // sem snapshot, sem seedDemoScene, sem caixas: visitante vê zero
    }

    // 2) Carrega cena persistida (só autenticados chegam aqui)
    try {
      const saved = await repo.loadScene();
      if (saved && Array.isArray(saved.objects) && saved.objects.length > 0) {
        world.loadSnapshot(saved);
      } else {
        seedDemoScene(world);
      }
    } catch {
      seedDemoScene(world);
    }
    // Muro abaixo e persistência religada: a partir daqui a cena pode ser salva
    persistLocked = false;

    // 3) Avatar customizado salvo
    const customAvatar = await repo.getSetting<string | null>('userAvatar', null);

    // 4) Projetos do Taiga (isolamento: só os de MEMBRO — o /projects também
    //    devolve os públicos do servidor, que não são "do usuário")
    mySlugs = null;
    if (me) {
      const photo = customAvatar || me.photo || null;
      buildingView.setUserProfile({
        name: me.fullName || me.username,
        email: me.email,
        photo,
        isAuth: true,
      });

      try {
        const allProjects = await fetchTaigaProjects();
        const projects = pickMyProjects(allProjects);
        mySlugs = new Set(projects.map((p) => p.slug));
        if (projects.length > 0) {
          let changed = false;
          for (const p of projects) {
            const existing = world.listBoxes().find((b) => b.taigaProject === p.slug);
            if (!existing) {
              const cleanName = p.name.trim();
              const boxTitle = cleanName.toLowerCase().startsWith('backlog') ? cleanName : `Backlog ${cleanName}`;
              world.addBoxEntity(boxTitle, undefined, 'backlog', p.slug);
              changed = true;
            }
          }

          // Se tem o projeto principal Marcos Prescricionais, garante também caixa de Sprint
          const marcos = projects.find((p) => p.slug.includes('marcos'));
          if (marcos) {
            const hasSprint = world.listBoxes().some(
              (b) => (b.type === 'sprint' || b.type === 'kanban') && b.taigaProject === marcos.slug,
            );
            if (!hasSprint) {
              const marcosClean = marcos.name.trim();
              const sprintTitle = marcosClean.toLowerCase().startsWith('sprint') ? marcosClean : `Sprint - ${marcosClean}`;
              world.addBoxEntity(sprintTitle, undefined, 'sprint', marcos.slug);
              changed = true;
            }
          }

          // Limpeza: caixa de projeto visível no servidor mas do qual NÃO sou
          // membro (sincronizações antigas) sai de cena — com os cards dentro.
          const visibleSlugs = new Set(allProjects.map((p) => p.slug));
          for (const b of world.listBoxes()) {
            if (!b.taigaProject) continue; // caixas locais/notes são do usuário
            if (visibleSlugs.has(b.taigaProject) && !mySlugs.has(b.taigaProject)) {
              for (const o of world.listObjects()) {
                if (o.meta?.boxId === b.id) world.removeObject(o.id);
              }
              world.removeBoxEntity(b.id);
              changed = true;
            }
          }

          if (changed) {
            await repo.saveScene(world.toSnapshot()).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Erro ao sincronizar projetos do Taiga no prédio:', err);
      }
    } else if (appSession) {
      // Autenticado só na conta do app (sem Taiga) — cena local/demo disponível
      buildingView.setUserProfile({
        name: appSession.email,
        email: appSession.email,
        photo: customAvatar,
        isAuth: true,
      });
    } else {
      // Fail-open sem backend: visitante em modo demo (sem dados de ninguém)
      buildingView.setUserProfile({
        name: 'Entrar / Perfil',
        photo: customAvatar,
        isAuth: false,
      });
    }

    // 5) Caixas exibidas: isolamento Taiga (só MEUS projetos) × visão ativa
    //    (prédio 1 pessoal × prédio 2 trabalho). Sem Taiga, só o pessoal.
    if (me) {
      const savedView = await repo.getSetting<string>('viewMode', 'personal').catch(() => 'personal');
      viewMode = savedView === 'work' ? 'work' : 'personal';
    } else {
      viewMode = 'personal';
    }
    overlay.setViewSwitchVisible(!!me);
    refreshBoxes();

    // PR4.14/4.16 — saiu do muro (login/cadastro): reabre o dashboard e
    // abaixas o véu que cobria cena e HUD.
    if (loginWalled) {
      loginWalled = false;
      overlay.setAuthWall(false);
      if (!skipBuilding) buildingView.show();
    }

    // 6) Remove loading
    buildingView.hideLoading();
  }

  buildingView.onProfileClick(() => {
    void openUserProfileModal();
  });

  // Dispara a inicialização e sincronização do Prédio do usuário
  void initUserBuilding();

  // Busca global no dashboard do prédio
  buildingView.onSearch((query) => {
    if (!query.trim()) {
      buildingView.setSearchMatches([], '');
      return;
    }
    const rawStats = world.getBoxStats();
    // PR4.16 — busca só na visão ativa (pessoal × trabalho): o número do
    // andar precisa bater com a lista/pilha mostrada na tela.
    const boxes = viewBoxes.length > 0 ? viewBoxes : world.listBoxes();
    const matches: import('../building/BuildingView').SearchMatch[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      const s = rawStats.find((r) => r.boxId === box.id);
      if (!s) continue;
      const q = query.toLowerCase();
      for (const note of s.noteItems) {
        const hay = `${note.label}\n${note.text}`.toLowerCase();
        if (hay.includes(q)) {
          matches.push({ itemId: note.id, boxId: box.id, label: note.label, floorNum: i + 1 });
        }
      }
    }
    buildingView.setSearchMatches(matches, query);
  });

  // Clique em dot → navega até a nota específica
  buildingView.onItemDotClick((itemId, boxId) => {
    buildingView.hide(() => {
      overlay.hideBuildingBack();
      const box = world.getBox(boxId);
      if (box) {
        world.setCurrentBox(boxId);
        world.flyToBox(boxId);
        world.flyToObject(itemId);
        overlay.showBuildingBack();
        setTimeout(() => overlay.setZoomSliderValue(world.getCamera().distance), 600);
      }
    });
  });

  // PR4.13 — ícones do HUD (☰ Andares / 📊 Resumo) espelham o estado dos
  // painéis: aceso = aberto. show() dispara a sincronização inicial.
  buildingView.onPanelsChange((floors, summary) => {
    overlay.setPanelActive('floors', floors);
    overlay.setPanelActive('summary', summary);
  });
  overlay.setPanelActive('floors', buildingView.isPanelOpen('floors'));
  overlay.setPanelActive('summary', buildingView.isPanelOpen('summary'));

  if (!skipBuilding) {
    buildingView.show();
  }
  buildingView.onFloorClick((boxId) => {
    // Fade-out prédio → entra na caixa e voa a câmera para ela
    buildingView.hide(() => {
      overlay.hideBuildingBack();
      const box = world.getBox(boxId);
      if (box) {
        world.setCurrentBox(boxId);
        world.flyToBox(boxId);
        overlay.toast(t('toast.buildingEntered', { name: box.name }));
        overlay.showBuildingBack();
        void syncBacklog(boxId); // PR4.5 — backlog: puxa as stories do Taiga
        void syncSprint(boxId);  // PR4.6 — sprint: distribui stories nas raias
        // Sincroniza barra de zoom com a distância destino do flyToBox (~90)
        setTimeout(() => overlay.setZoomSliderValue(world.getCamera().distance), 600);
      }
    });
  });

  // PR4.16 — favorito do andar: grava no snapshot e re-renderiza a lista.
  // Persistência imediata (não espera o SAVE_INTERVAL): o usuário espera
  // que a estrela sobreviva a um F5 assim que ela acende/apaga.
  buildingView.onFloorFavorite((boxId, isFavorite) => {
    if (!world.setBoxFavorite(boxId, isFavorite)) return;
    refreshBoxes();
    if (!persistLocked) repo.saveScene(world.toSnapshot()).catch(() => {});
    const box = world.getBox(boxId);
    overlay.toast(
      isFavorite
        ? t('toast.favoriteAdded', { name: box?.name ?? '' })
        : t('toast.favoriteRemoved', { name: box?.name ?? '' })
    );
  });

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
  /** PR10 — alvo e tela do menu secundário "Configurações da imagem". */
  let ctxPhotoId: string | null = null;
  let ctxScreen: { x: number; y: number } = { x: 0, y: 0 };
  // Rastreio de arraste p/ detectar "soltar em pasta" (moveInto, M2)
  let dragSourceId: string | null = null;
  /**
   * Última pasta sob o cursor durante o arraste (excluindo o arrastado).
   * A pasta é empurrada pelo corpo cinemático do arrastado e pode deslizar
   * para fora do raio de captura antes do soltar — o cursor ainda conta
   * como "sobre a pasta" se estiver perto de onde ela foi vista por último.
   */
  let dropCandidate: { id: string; world: { x: number; y: number; z: number } } | null = null;
  /** Mesmo raio de captura do pickAt (unidades de mundo). */
  const DROP_RADIUS = 13;
  const distXZ = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

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

  /** Persistência imediata de um objeto (notas e nomes): não espera o flush de 2 s. */
  const persistObject = (id: string) => {
    const o = world.getObject(id);
    if (o) repo.upsertObject(o).catch((e) => console.warn('save do objeto falhou', e));
  };
  /** Remove o objeto do banco logo após apagá-lo do mundo (ex.: nota esvaziada). */
  const forgetObject = (id: string) => {
    repo.deleteObject(id).catch(() => {});
  };

  /** PR12 — abre o EDITOR RICO da nota (modal grande estilo Keep) e salva. */
  const openNoteEditor = (id: string, isNew = false) => {
    const o = world.getObject(id);
    if (!o) return;
    void overlay
      .editNoteRich({
        title: (o.meta.noteTitle as string) ?? '',
        text: (o.meta.noteText as string) ?? '',
        bg: (o.meta.noteBg as string) ?? undefined,
        drawing: (o.meta.noteDrawing as string) ?? null,
        reminder: typeof o.meta.noteReminder === 'number' ? (o.meta.noteReminder as number) : null,
      })
      .then((draft) => {
        // Nota NOVA vazia (sem texto, título e desenho) = não criar (Keep).
        // PR4.17 — nota EXISTENTE nunca é apagada pelo editor: mesmo que o
        // rascunho venha vazio por qualquer motivo, a anotação fica (em
        // branco) em vez de sumir do mundo e do banco. Perder nota é pior
        // que nota em branco — apagar continua possível pelo menu.
        const empty =
          draft.text.trim() === '' && draft.title.trim() === '' && draft.drawing === null;
        if (empty && isNew) {
          world.removeObject(id);
          forgetObject(id);
          overlay.toast(t('toast.noteRemoved'));
          return;
        }
        if (empty && !isNew) {
          console.warn('editor devolveu nota vazia — mantendo a anotação (anti-perda PR4.17)');
        }
        world.setNoteText(id, draft.text);
        world.setNoteMeta(id, {
          noteTitle: draft.title,
          noteBg: draft.bg,
          noteReminder: draft.reminder,
          noteDrawing: draft.drawing,
        });
        // 1º lembrete → pede permissão de notificação (push)
        if (draft.reminder !== null && 'Notification' in window && Notification.permission === 'default') {
          void Notification.requestPermission().catch(() => {});
        }
        persistObject(id);
        if (isNew) overlay.toast(t('toast.noteCreated'));
      });
  };

  /** Abre um objeto: preview in-app (item 3) / importado / download / toasts. */
  const openAndShow = (id: string) => {
    void files.openObject(id).then((r) => {
      if (r.kind === 'preview') overlay.showPreview(r);
      else if (r.kind === 'imported') overlay.toast(t('toast.folderImported'));
      else if (r.kind === 'downloaded') overlay.toast(t('toast.downloading'));
      else if (r.kind === 'unsupported')
        // Objeto demo ou sem arquivo real atrás (ex.: cena inicial) — antes era
        // silencioso e parecia "duplo-clique não funciona".
        overlay.toast(t('toast.unsupportedFile'));
      else if (r.kind === 'error') overlay.toast(t('toast.openFailed'));
    });
  };

  /** PR9 — abre um arquivo PELO CAMINHO (itens do modal de pasta). */
  const openPathAndShow = (path: string) => {
    void files.openPath(path).then((r) => {
      if (r.kind === 'preview') overlay.showPreview(r);
      else if (r.kind === 'downloaded') overlay.toast(t('toast.downloading'));
      else if (r.kind === 'error') overlay.toast(t('toast.openFailed'));
    });
  };

  /**
   * PR9 — modal de vidro com o conteúdo de uma pasta (duplo-clique).
   * Item-pasta navega (re-render do modal); item-arquivo abre.
   */
  const showFolderContents = (path: string, fallbackName: string) => {
    // PR10 — id do ícone da pasta (para extrair perto dela e repintar o contador)
    const dirId =
      world.listObjects().find((o) => o.meta.fsPath === path)?.id ?? undefined;
    void files.listFolder(path).then((items) => {
      overlay.showFolderModal({
        name: fallbackName,
        items,
        onOpen: (p, isDir) => {
          if (isDir) showFolderContents(p, p.split('/').pop() ?? p);
          else openPathAndShow(p);
        },
        onClose: () => {},
        // PR10 — excluir o arquivo de dentro da pasta (tomba + apaga)
        onDelete: (p) => {
          void files.deletePath(p).then(() => {
            if (dirId) void files.updateFolderCount(dirId);
            overlay.toast(t('toast.fileDeleted'));
            showFolderContents(path, fallbackName); // reabre atualizado
          });
        },
        // PR10 — tirar da pasta: move p/ a raiz e devolve o ícone à mesa
        onExtract: (p) => {
          void files.extractFromFolder(p, dirId).then((id) => {
            if (dirId) void files.updateFolderCount(dirId);
            if (id) persistObject(id);
            overlay.toast(t(id ? 'toast.itemExtracted' : 'toast.openFailed'));
            showFolderContents(path, fallbackName); // reabre atualizado
          });
        },
      });
    });
  };

  overlayRoot.addEventListener('ctxaction', (e) => {
    const a = (e as CustomEvent<string>).detail;
    if (a === 'open' && ctxTarget) {
      openAndShow(ctxTarget);
    } else if (a === 'photoConfig' && ctxTarget) {
      // PR10 — menu SECUNDÁRIO de configurações da imagem: abre outro menu
      // de contexto com as opções da foto. O alvo fica guardado em ctxPhotoId
      // (ctxTarget é limpo ao fim deste handler).
      ctxPhotoId = ctxTarget;
      const framed = world.getObject(ctxPhotoId)?.meta.photoFrame !== false;
      overlay.showContextMenu(ctxScreen, [
        {
          label: `${t('menu.photoFrame')} (${framed ? '✓' : '✗'})`,
          action: 'photoFrame',
        },
        { label: t('menu.scaleUp'), action: 'photoScaleUp' },
        { label: t('menu.scaleDown'), action: 'photoScaleDown' },
        { label: t('menu.rotate'), action: 'photoRotate' },
      ]);
      return; // mantém ctxPhotoId para as ações do menu secundário
    } else if (a === 'photoFrame' && ctxPhotoId) {
      const cur = world.getObject(ctxPhotoId)?.meta.photoFrame !== false;
      void files.applyPhotoFrame(ctxPhotoId, !cur).then((ok) => {
        overlay.toast(t(ok ? (cur ? 'toast.frameOff' : 'toast.frameOn') : 'toast.openFailed'));
      });
      ctxPhotoId = null;
    } else if ((a === 'photoScaleUp' || a === 'photoScaleDown') && ctxPhotoId) {
      toastScale(world.scaleSelection(a === 'photoScaleUp' ? 1 : -1, [ctxPhotoId]));
      ctxPhotoId = null;
    } else if (a === 'photoRotate' && ctxPhotoId) {
      world.rotateSelection(Math.PI / 4, [ctxPhotoId]);
      ctxPhotoId = null;
    } else if (a === 'saveFile' && ctxTarget) {
      // PR8: baixa uma cópia p/ a pasta Downloads (o navegador não abre o
      // Explorer num caminho — isso só num app desktop empacotado)
      void files.downloadObject(ctxTarget).then((r) => {
        if (r.kind === 'downloaded') overlay.toast(t('toast.saved', { name: r.name }));
        else if (r.kind === 'error') overlay.toast(t('toast.saveFailed'));
        else overlay.toast(t('toast.unsupportedFile'));
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
    } else if (a === 'rotate' && ctxTargets.length > 0) {
      const n = world.rotateSelection(Math.PI / 4, ctxTargets);
      overlay.toast(n > 0 ? t('toast.rotated', { n }) : t('toast.nothingToGrid'));
    } else if (a === 'makePile') {
      const loose = ctxTargets.filter((id) => !world.inPile(id) && !world.isPinned(id));
      const base = world.createPileFrom(loose);
      overlay.toast(base ? t('toast.lassoPiled', { n: loose.length }) : t('toast.nothingToPile2'));
    } else if (a === 'toggleWallPin') {
      const on = world.toggleAutoWallPin();
      overlay.toast(t(on ? 'toast.wallPinOn' : 'toast.wallPinOff'));
    } else if (a === 'physicsLevel') {
      const level = world.togglePhysicsLevel();
      overlay.toast(t(level === 2 ? 'toast.physicsLevel2' : 'toast.physicsLevel1'));
    } else if (a === 'toggleShowNames') {
      const on = world.toggleShowNames();
      repo.setSetting('showNames', on).catch(() => {});
      overlay.toast(t(on ? 'toast.showNamesOn' : 'toast.showNamesOff'));
    } else if (a === 'exportScene') {
      // Backup manual da cena (itens + pilhas + notas) em JSON
      const json = JSON.stringify(world.toSnapshot());
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `bumptop-cena-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      overlay.toast(t('toast.sceneExported'));
    } else if (a === 'importScene') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        void f
          .text()
          .then((txt) => {
            const snap: unknown = JSON.parse(txt);
            const objs = (snap as { objects?: unknown[] } | null)?.objects;
            if (!Array.isArray(objs)) throw new Error('formato inválido');
            world.loadSnapshot(snap as Parameters<typeof world.loadSnapshot>[0]);
            const n = objs.length;
            return repo.saveScene(world.toSnapshot()).then(() => n);
          })
          .then((n) => overlay.toast(t('toast.sceneImported', { n })))
          .catch((e) => {
            console.warn('import falhou', e);
            overlay.toast(t('toast.sceneImportFailed'));
          });
      };
      input.click();
    } else if (a === 'delete' && ctxTargets.length > 0) {
      // Multi-select: se o item clicado está na seleção, exclui a seleção
      // inteira; senão só o item clicado (Fase 7)
      const ids = ctxTargets;
      // Objetos de FS (pasta/arquivo com fsPath): o ícone sai da cena E o
      // conteúdo é apagado do sandbox (OPFS) — e o caminho é "tombado" p/ o
      // watcher de 5 s não recriar o ícone (bug: pasta excluída ressuscitava).
      // Objetos demo (sem fsPath): só o ícone sai, como antes.
      for (const id of ids) {
        if (typeof world.getObject(id)?.meta.fsPath === 'string') void files.deleteFsObject(id);
        else world.removeObject(id);
      }
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
            persistObject(id);
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
      // PR12 — cria a nota e abre o EDITOR RICO direto (modal grande)
      const id = world.addStickyNote(
        { x: ctxFloorPoint.x, y: 1.2, z: ctxFloorPoint.z },
        '',
      );
      openNoteEditor(id, true);
    } else if (a === 'newFolder' && ctxFloorPoint) {
      // Pasta virtual na cena (item 6): diretório no FS + ícone de pasta
      void files.createFolder(t('menu.newFolderName'), ctxFloorPoint).then((r) => {
        if (!r) overlay.toast(t('toast.folderCreateFailed'));
        else {
          persistObject(r.id);
          overlay.toast(t('toast.folderCreated', { name: r.name }));
        }
      });
    } else if (a === 'editNote' && ctxTarget && world.isStickyNote(ctxTarget)) {
      // PR12 — menu "Editar nota" abre o EDITOR RICO
      openNoteEditor(ctxTarget);
    }
    ctxTarget = null;
    ctxTargets = [];
  });

  world.onLassoMenu((screen, ids) => {
    ctxTargets = ids;
    ctxTarget = ids[0] ?? null;
    const items: ContextMenuItem[] = [
      { label: t('menu.scaleUp'), action: 'scaleUp', hint: t('hint.scaleUp') },
      { label: t('menu.duplicate'), action: 'duplicate', hint: t('hint.duplicate') },
      { label: t('menu.rotate'), action: 'rotate', hint: t('hint.rotate') },
      { label: t('menu.makePile'), action: 'makePile', hint: t('hint.makePile') },
      { label: t('menu.gridView'), action: 'gridView', hint: t('hint.gridView') },
      { label: t('menu.sortBySize'), action: 'sortBySize', hint: t('hint.sortBySize') },
      { label: t('menu.sortByType'), action: 'sortByType', hint: t('hint.sortByType') },
      { label: t('menu.scaleDown'), action: 'scaleDown', hint: t('hint.scaleDown') },
      { label: t('menu.delete'), action: 'delete', danger: true, hint: t('hint.delete') },
    ];
    overlay.showContextMenu(screen, items);
  });

  input.setListener((action: InputAction) => {
    if (action.type === 'context') {
      ctxTarget = world.pickObjectAt(action.world, action.screen);
      ctxScreen = { ...action.screen };
      // Alvos: seleção inteira se o item clicado está selecionado, senão só ele
      const selected = world.getSelectedIds();
      ctxTargets = ctxTarget
        ? selected.includes(ctxTarget)
          ? selected
          : [ctxTarget]
        : [];
      const items: ContextMenuItem[] = [];
      if (ctxTarget) items.push({ label: t('menu.open'), action: 'open', hint: t('hint.open') });
      if (
        ctxTarget &&
        typeof world.getObject(ctxTarget)?.meta.fsPath === 'string' &&
        world.getObject(ctxTarget)?.meta.isDir !== true
      ) {
        items.push({ label: t('menu.saveFile'), action: 'saveFile', hint: t('hint.saveFile') });
      }
      items.push({ label: t('menu.openDir'), action: 'openDir', hint: t('hint.openDir') });
      if (ctxTarget) {
        if (world.isStickyNote(ctxTarget)) {
          items.push({ label: t('menu.editNote'), action: 'editNote', hint: t('hint.editNote') });
        }
        // PR10 — imagens ganham o menu secundário de configurações (moldura…)
        const ctxObj = world.getObject(ctxTarget);
        const fsPathCtx = ctxObj?.meta.fsPath;
        if (
          typeof fsPathCtx === 'string' &&
          ctxObj?.meta.isDir !== true &&
          isImagePath(fsPathCtx)
        ) {
          items.push({ label: t('menu.photoConfig'), action: 'photoConfig' });
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
        items.push({ label: t('menu.rotate'), action: 'rotate', hint: t('hint.rotate') });
        if (ctxTargets.length >= 2) {
          items.push({ label: t('menu.makePile'), action: 'makePile', hint: t('hint.makePile') });
        }
        items.push({ label: t('menu.delete'), action: 'delete', danger: true, hint: t('hint.delete') });
      }
      // Chão vazio → criar nota adesiva + auto-pilha por tipo (M6 / Fase 7) + toggles P1
      if (!ctxTarget) {
        ctxFloorPoint = { ...action.world };
        items.push({ label: t('menu.newNote'), action: 'newNote', hint: t('hint.newNote') });
        items.push({ label: t('menu.newFolder'), action: 'newFolder', hint: t('hint.newFolder') });
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
        items.push({
          label: `${t('menu.toggleWallPin')} (${world.isAutoWallPin() ? '✓' : '✗'})`,
          action: 'toggleWallPin',
          hint: t('hint.toggleWallPin'),
        });
        items.push({
          label: t('menu.physicsLevel', { n: world.getPhysicsLevel() }),
          action: 'physicsLevel',
          hint: t('hint.physicsLevel'),
        });
        items.push({
          label: `${t('menu.toggleShowNames')} (${world.isShowNames() ? '✓' : '✗'})`,
          action: 'toggleShowNames',
          hint: t('hint.toggleShowNames'),
        });
        items.push({ label: t('menu.exportScene'), action: 'exportScene', hint: t('hint.exportScene') });
        items.push({ label: t('menu.importScene'), action: 'importScene', hint: t('hint.importScene') });
      }
      overlay.showContextMenu(action.screen, items);
      return;
    }
    if (action.type === 'doubleTap') {
      const target = world.pickObjectAt(action.world);
      if (target) openAndShow(target);
      return;
    }

    // PR4.11 — Hover sobre itens do Taiga exibe o título completo em tooltip flutuante
    if (action.type === 'hover') {
      const hoverId = world.pickObjectAt(action.world, action.screen);
      const hoverObj = hoverId ? world.getObject(hoverId) : null;
      if (hoverObj?.meta?.taigaStoryId !== undefined) {
        const fullTitle = hoverObj.label || (hoverObj.meta.taigaSubject as string) || '';
        overlay.setHoverTooltip(fullTitle, action.screen);
      } else {
        overlay.setHoverTooltip(null, null);
      }
    } else if (action.type === 'pointerDown') {
      overlay.setHoverTooltip(null, null);
    }

    // Soltar em pasta → move o arquivo (M2)
    if (action.type === 'pointerDown') {
      dragSourceId = world.pickObjectAt(action.world, action.screen);
      dropCandidate = null;
    }
    // Durante o arraste: lembra a ÚLTIMA pasta sob o cursor (excluindo o
    // arrastado). A pasta é empurrada pelo corpo cinemático do arrastado e
    // pode ter deslizado para fora do raio de captura no momento do soltar.
    if (action.type === 'pointerMove' && dragSourceId) {
      const hover = world.pickObjectAt(action.world, action.screen, dragSourceId);
      if (hover && world.getObject(hover)?.meta.isDir === true) {
        dropCandidate = { id: hover, world: { ...action.world } };
      }
    }
    world.processAction(action);
    if (action.type === 'pointerUp' && dragSourceId) {
      // Exclui o próprio arrastado: ele está sob o cursor (d≈0) e sem o
      // exclude ele sempre "ganha" o pick → dropTarget === dragSourceId →
      // o moveInto nunca dispara (bug: itens não entram nas pastas).
      let dropTarget = world.pickObjectAt(action.world, action.screen, dragSourceId);
      // A pasta empurrada: se durante a aproximação ela esteve sob o cursor e
      // o cursor ainda está perto de onde ela estava, aceita como alvo.
      if (
        dropCandidate &&
        (dropTarget === null || world.getObject(dropTarget)?.meta.isDir !== true) &&
        distXZ(action.world, dropCandidate.world) <= DROP_RADIUS
      ) {
        dropTarget = dropCandidate.id;
      }
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
      dropCandidate = null;
      dragSourceId = null;
    }
  });

  // -------------------------------------------------------------------------
  // PR8 — arrastar arquivo DO SISTEMA (Explorer/Finder) para a cena
  // -------------------------------------------------------------------------
  const canvas = renderer.getCanvas();
  canvas.addEventListener('pointerleave', () => overlay.setHoverTooltip(null, null));
  const acceptsFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  canvas.addEventListener('dragover', (e) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    canvas.classList.add('drop-file');
  });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-file'));
  canvas.addEventListener('drop', (e) => {
    canvas.classList.remove('drop-file');
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    const list = [...e.dataTransfer!.files];
    if (list.length === 0) return;
    // resolveFloor espera coordenada LOCAL do canvas (client − rect)
    const r = canvas.getBoundingClientRect();
    const at = resolveFloor({ x: e.clientX - r.left, y: e.clientY - r.top });
    void files.importFiles(list, at).then((res) => {
      const msg = t('toast.filesAdded', { n: res.files });
      overlay.toast(
        res.skipped ? `${msg} · ${t('toast.filesSkipped', { n: res.skipped ?? 0 })}` : msg,
      );
    });
  });

  // -------------------------------------------------------------------------
  // PR8/PR14 — clique numa nota adesiva abre o EDITOR RICO direto (sem o
  // card escuro de leitura). Clique vs. arrastar (moveu >6 px). O
  // duplo-clique também abre (fallback — normalmente o 1º clique já abriu
  // o modal, que cobre o canvas e engole o resto do duplo-clique).
  // -------------------------------------------------------------------------
  // PR: clique simples na nota apenas seleciona/foca; o duplo-clique (2 cliques) abre o editor
  let downScreen: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 0) downScreen = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('click', (e) => {
    const down = downScreen;
    downScreen = null;
    // Foi arrasto, não clique
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
  });

  // Duplo-clique (desktop) → em pilha: abre em leque; em nota: edita texto;
  // no chão vazio: fecha leques; senão: abre o objeto (M2/Fase 7)
  const onDblClick = (e: MouseEvent) => {
    const rect = renderer.getCanvas().getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const { direction } = renderer.screenToRay(screen);
    const worldPt = resolveFloor(screen);
    const target = world.pickObjectAt(worldPt, screen);
    if (!target) {
      // Parede (item 4): clique projetado fora da sala → foca a câmera nela
      // (direction.y >= 0 = raio não atinge o chão — "céu", não é parede)
      if (direction.y < -1e-4) {
        const wall = world.pickWall(worldPt);
        if (wall !== null) {
          world.focusWall(wall);
          return;
        }
      }
      // Chão vazio → fecha a pilha aberta em grade (PR9) e/ou leques
      if (world.closeOpenPile()) overlay.toast(t('toast.pileClosed'));
      if (world.collapseFanOuts() > 0) overlay.toast(t('toast.fansClosed'));
      return;
    }
    // Item de pilha → ABRE em grade sobre painel de vidro (PR9); se já é a
    // pilha aberta, o duplo-clique fecha (toggle, como o ✕)
    if (world.inPile(target)) {
      if (world.isPileOpen(target)) world.closeOpenPile();
      else world.openPileGrid(target);
      return;
    }
    // Pasta (com fsPath) → modal de vidro com o conteúdo (PR9); o menu
    // "Abrir" continua importando os itens para a cena
    const alvoObj = world.getObject(target);
    if (alvoObj?.meta?.taigaStoryId !== undefined) {
      void (async () => {
        try {
          const detail = await fetchStoryDetail(alvoObj.meta.taigaStoryId as number);
          if (!detail.projectSlug && typeof alvoObj.meta.taigaProjectSlug === 'string') {
            detail.projectSlug = alvoObj.meta.taigaProjectSlug as string;
          }
          overlay.showStoryModal(detail);
        } catch {
          overlay.toast(t('ui.taiga.httpError'));
        }
      })();
      return;
    }
    if (alvoObj?.meta.isDir === true && typeof alvoObj.meta.fsPath === 'string') {
      showFolderContents(alvoObj.meta.fsPath as string, alvoObj.label ?? 'Pasta');
      return;
    }
    if (world.isStickyNote(target)) {
      // Fallback: se o 1º clique não abriu o editor (ex.: foi arrasto),
      // o duplo-clique abre. O caso normal o modal já cobre o canvas.
      openNoteEditor(target);
      return;
    }
    openAndShow(target);
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
    } else if (e.key === 'PageUp') {
      // PR11 — zoom da câmera: aproximar (delta na escala do wheel: ~±100)
      world.zoomCamera(-80);
    } else if (e.key === 'PageDown') {
      // PR11 — zoom da câmera: afastar
      world.zoomCamera(80);
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
            persistObject(id);
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

  // Reset Camera (P0): botão na barra de ferramentas (overlay) → preset 1
  const onResetCamera = () => {
    world.setCameraPreset(1);
    // Sincroniza a barra de zoom com a nova distância
    overlay.setZoomSliderValue(world.getCamera().distance);
  };
  overlayRoot.addEventListener('resetcamera', onResetCamera);

  // Seleção de temas via menu suspenso do topo
  overlayRoot.addEventListener('themechange', (e) => {
    const { index, name, theme } = (e as CustomEvent).detail as {
      index: number;
      name: string;
      theme: (typeof THEMES)[0];
    };
    themeIdxRef.value = index;
    world.setTheme(theme);
    overlay.setThemeActive(name);
    void repo.setSetting('themeIndex', index);
    overlay.toast(t('toast.theme', { name: t(`theme.${name}`) || name }));
  });

  // PR15 — botão "Modo laço" (seleção múltipla no toque): liga/desliga o
  // modo no World e sincroniza o estado visual do botão (+ toast de ajuda)
  overlayRoot.addEventListener('lassomode', () => {
    world.setLassoMode(!world.isLassoMode());
  });
  world.onLassoModeChanged((on) => {
    overlay.setLassoModeActive(on);
    overlay.toast(t(on ? 'toast.lassoOn' : 'toast.lassoOff'));
  });

  // PR18 — busca nas notas: campo abre/fecha pelo botão 🔍; digitar filtra
  // (debounce no overlay), Enter/› voam para o próximo match, ‹ volta
  overlayRoot.addEventListener('searchtoggle', () => {
    const abrir = !overlay.isSearchBarVisible();
    overlay.showSearchBar(abrir);
    if (!abrir) world.endSearch();
  });
  overlayRoot.addEventListener('searchclose', () => {
    overlay.showSearchBar(false);
    world.endSearch();
  });
  overlayRoot.addEventListener('searchquery', (e) => {
    const q = (e as CustomEvent).detail as string;
    const ids = world.searchNotes(q);
    const st = world.getSearchState();
    overlay.setSearchCount(st ? Math.max(0, st.index + 1) : 0, ids.length);
    if (q.trim() !== '' && ids.length === 0) overlay.toast(t('toast.searchNone', { q: q.trim() }));
  });
  overlayRoot.addEventListener('searchnext', (e) => {
    world.gotoSearchMatch((e as CustomEvent).detail as 1 | -1);
    const st = world.getSearchState();
    if (st) overlay.setSearchCount(st.index + 1, st.ids.length);
  });

  // =========================================================================
  // PR4a — Control Manager: engrenagem abre o painel com as CAIXAS (espaços
  // chão+4 paredes onde pastas/arquivos/notas acontecem); clicar numa caixa
  // fecha o painel, vira a caixa ATIVA e voa até ela (anim. da busca, PR18)
  // =========================================================================
  overlayRoot.addEventListener('settingstoggle', () => {
    if (overlay.isBoxesPanelVisible()) {
      overlay.hideBoxesPanel();
      return;
    }
    const cur = world.getCurrentBoxId();
    const boxes = (viewBoxes.length > 0 ? viewBoxes : world.listBoxes()).map((b) => ({
      id: b.id,
      label: b.name,
      current: b.id === cur,
    }));
    overlay.showBoxesPanel(boxes);
  });
  overlayRoot.addEventListener('boxgoto', (e) => {
    const id = (e as CustomEvent).detail as string;
    world.setCurrentBox(id);
    world.flyToBox(id);
    void syncBacklog(id); // PR4.5 — backlog: atualiza as stories ao entrar
    void syncSprint(id);  // PR4.6 — sprint: atualiza raias ao entrar
    // Sincroniza barra de zoom com a distância destino do flyToBox (~90)
    setTimeout(() => overlay.setZoomSliderValue(world.getCamera().distance), 600);
  });
  // PR4.2 — CRUD de caixas: criar (nome automático "Caixa n"), renomear,
  // excluir (itens voltam p/ a Caixa Comum) — o painel re-renderiza em cima
  const reopenBoxesPanel = () => {
    refreshBoxes();
    if (!overlay.isBoxesPanelVisible()) return;
    const cur = world.getCurrentBoxId();
    overlay.showBoxesPanel(
      (viewBoxes.length > 0 ? viewBoxes : world.listBoxes()).map((b) => ({
        id: b.id,
        label: b.name,
        current: b.id === cur,
        type: b.type,
      })),
    );
  };
  overlayRoot.addEventListener('boxcreate', (e) => {
    // PR4.5/4.9 — detail virou objeto { type, project, projectName, sprintId, sprintName }
    const raw = (e as CustomEvent).detail as
      | string
      | { type?: string; project?: string; projectName?: string; sprintId?: number; sprintName?: string };
    const type = (typeof raw === 'string' ? raw : raw?.type) || 'comum';
    const project = typeof raw === 'string' ? '' : (raw?.project ?? '');
    const projectName = typeof raw === 'string' ? '' : (raw?.projectName ?? '');
    const sprintId = typeof raw === 'string' ? undefined : raw?.sprintId;
    const sprintName = typeof raw === 'string' ? '' : (raw?.sprintName ?? '');

    const n = world.listBoxes().length;
    let boxName = t('ui.boxNewName', { n });
    const refTitle = projectName || project;
    if (type === 'backlog' && refTitle) {
      boxName = `Backlog ${refTitle}`;
    } else if (type === 'sprint' && refTitle) {
      boxName = sprintName ? `${sprintName} - ${refTitle}` : `Sprint ${refTitle}`;
    }

    const box = world.addBoxEntity(
      boxName,
      undefined,
      type as 'comum' | 'root' | 'kanban' | 'backlog' | 'sprint',
      project,
    );
    if (sprintId !== undefined) {
      box.taigaSprintId = sprintId;
    }
    if (sprintName) {
      box.taigaSprintName = sprintName;
    }
    // PR4.16 — caixa nova fora da visão atual (pessoal × trabalho)? A visão
    // acompanha para a pessoa ver o que acabou de criar.
    if ((viewMode === 'work') !== !!project) {
      viewMode = project ? 'work' : 'personal';
      overlay.setViewMode(viewMode);
      repo.setSetting('viewMode', viewMode).catch(() => {});
    }
    overlay.toast(t('toast.boxCreated', { name: box.name }));
    reopenBoxesPanel();
    void syncBacklog(box.id); // PR4.5 — backlog: puxa as stories na criação
    void syncSprint(box.id);  // PR4.6/4.9 — sprint: puxa stories da sprint selecionada/ativa na criação
  });
  overlayRoot.addEventListener('boxrename', (e) => {
    const { id, name } = (e as CustomEvent).detail as { id: string; name: string };
    world.renameBox(id, name);
    reopenBoxesPanel();
  });
  overlayRoot.addEventListener('boxdelete', (e) => {
    const id = (e as CustomEvent).detail as string;
    const moved = world.removeBoxEntity(id);
    if (moved !== null) overlay.toast(t('toast.boxDeleted', { n: moved }));
    reopenBoxesPanel();
  });

  // PR4.4 — Building View: toggle prédio e voltar ao prédio
  overlayRoot.addEventListener('buildingtoggle', () => {
    if (buildingView.isVisible()) {
      buildingView.hide();
      const curBox = world.getBox(world.getCurrentBoxId());
      if (curBox?.type === 'sprint' || (curBox?.type === 'kanban' && curBox?.taigaProject)) {
        overlay.setSprintBadge(curBox.taigaSprintName || 'Sprint', true);
      }
    } else {
      // #58 (mobile): ao abrir o prédio o badge de sprint não faz sentido;
      // PR4.16: refreshBoxes sincroniza lista/resumo/🏠🏢 da visão ativa.
      overlay.hideSprintBadge();
      refreshBoxes();
      buildingView.show();
    }
  });

  // PR4.13 — ☰ Andares / 📊 Resumo: abrem e fecham TAMBÉM no ambiente das
  // caixas (os painéis saem do dashboard do prédio e flutuam sobre a cena).
  overlayRoot.addEventListener('floorspanel', () => {
    if (buildingView.togglePanel('floors')) updateBuildingStats();
  });
  overlayRoot.addEventListener('statspanel', () => {
    if (buildingView.togglePanel('summary')) updateBuildingStats();
  });

  // PR4.16 — ⭐ do HUD: filtra andares/projetos (lista E pilha 3D) pelos
  // favoritos. Se ainda não há nenhum, a lista explica em vez de ficar vazia.
  overlayRoot.addEventListener('favoritefilter', (e) => {
    const on = (e as CustomEvent<{ on: boolean }>).detail.on;
    buildingView.setFavoriteFilter(on);
    overlay.toast(t(on ? 'toast.filterFavOn' : 'toast.filterFavOff'));
  });

  // PR4.16 — 🏠/🏢 do HUD: alterna prédio 1 (pessoal) × prédio 2 (trabalho).
  // O snapshot guarda as duas visões; só muda o que a UI mostra.
  overlayRoot.addEventListener('viewswitch', (e) => {
    viewMode = (e as CustomEvent<{ mode: 'personal' | 'work' }>).detail.mode;
    refreshBoxes();
    repo.setSetting('viewMode', viewMode).catch(() => {});
    overlay.toast(t(viewMode === 'work' ? 'toast.viewWork' : 'toast.viewPersonal'));
  });

  // PR4.16 — clicar no véu do muro reabre o login (fechar o modal não pode
  // deixar a pessoa presa numa tela sem saída).
  overlayRoot.addEventListener('authwallreopen', () => {
    if (loginWalled) void openUserProfileModal();
  });
  overlayRoot.addEventListener('buildingback', () => {
    overlay.hideBuildingBack();
    // #58 (mobile): esconde o badge de sprint; PR4.16: refreshBoxes recalcula
    // a visão ativa (setBoxes + selectFloor + stats + 🏠/🏢).
    overlay.hideSprintBadge();
    refreshBoxes();
    buildingView.show(() => {
      overlay.toast(t('toast.buildingBack'));
    });
  });

  // PR4.15 — Seletor de Sprint do Taiga na caixa ativa ou pelo painel de caixas
  overlayRoot.addEventListener('sprintpick', () => {
    const curId = world.getCurrentBoxId();
    void openSprintSelector(curId);
  });
  overlayRoot.addEventListener('boxsprintpick', (e) => {
    const id = (e as CustomEvent).detail as string;
    void openSprintSelector(id);
  });

  // TRON Light Cycles — Modo Game (imersivo no ambiente 3D do BumpTop + Ranking/Nickname para logados)
  let activeTronGame: { dispose: () => void } | null = null;
  overlayRoot.addEventListener('gamemode', () => {
    if (activeTronGame) return;
    void (async () => {
      const { fetchTronRanking, submitTronScore, getSavedTronNickname } = await import('../game/tronRanking');
      const appSession = auth.current();
      const taigaToken = getTaigaToken();
      const taigaMe = taigaToken ? await fetchTaigaMe().catch(() => null) : null;
      const isLoggedIn = !!appSession || !!taigaMe;
      const defaultNick =
        getSavedTronNickname() ||
        taigaMe?.fullName ||
        taigaMe?.username ||
        appSession?.email?.split('@')[0] ||
        '';

      overlay.showTronGameGridModal(
        (playerColor, nickname, mode, splitOrientation) => {
          const wasInBuilding = buildingView.isVisible();
          const boxId = world.getCurrentBoxId();
          const prevShowNames = world.isShowNames();
          const chosenNick = nickname || defaultNick || undefined;

          const launchTron = () => {
            overlayRoot.style.display = 'none';
            if (prevShowNames) world.setShowNames(false);
            void import('../game/TronGameView').then(({ TronGameView }) => {
              activeTronGame = new TronGameView({
                parent: document.body || sceneRoot,
                renderer,
                world,
                playerColor,
                mode: mode ?? 'solo',
                splitOrientation: splitOrientation ?? 'vertical',
                boxId,
                rankingOpts: {
                  isLoggedIn,
                  onScoreSubmit: (score, level) =>
                    submitTronScore({
                      nickname: chosenNick,
                      score,
                      level,
                      taigaToken,
                      taigaName: taigaMe?.fullName || taigaMe?.username || null,
                    }),
                },
                onExit: () => {
                  activeTronGame = null;
                  overlayRoot.style.display = '';
                  if (prevShowNames) world.setShowNames(true);
                  if (wasInBuilding) buildingView.show();
                },
              });
            });
          };

          if (wasInBuilding) {
            buildingView.hide(launchTron);
          } else {
            launchTron();
          }
        },
        {
          isLoggedIn,
          initialNickname: defaultNick,
          loadRanking: isLoggedIn
            ? () =>
                fetchTronRanking({
                  taigaToken,
                  taigaName: taigaMe?.fullName || taigaMe?.username || null,
                })
            : undefined,
        },
      );
    })();
  });

  // =========================================================================
  // PR27 / PR4.12 — Conta (login/cadastro) + Perfil unificado
  // =========================================================================
  overlayRoot.addEventListener('authtoggle', () => {
    void openUserProfileModal();
  });
  overlayRoot.addEventListener('authswitch', () => {
    const mode = overlay.getAuthMode() === 'in' ? 'up' : 'in';
    overlay.showAuthModal({ mode, email: overlay.getAuthEmail(), error: null });
  });
  overlayRoot.addEventListener('authsubmit', (e) => {
    void (async () => {
      const { email, password, mode } = (e as CustomEvent).detail as {
        email: string;
        password: string;
        mode: 'in' | 'up';
      };
      // Validação local (i18n imediato, sem roundtrip)
      const clean = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        overlay.showAuthModal({ mode, email, error: t('toast.authBadEmail') });
        return;
      }
      if (password.length < 8) {
        overlay.showAuthModal({ mode, email, error: t('toast.authBadPassword') });
        return;
      }
      const res =
        mode === 'up' ? await auth.signUp(clean, password) : await auth.signIn(clean, password);
      if (!res.ok) {
        const key =
          res.error === 'AUTH_RATE'
            ? 'toast.authRate'
            : res.error === 'AUTH_BAD_EMAIL'
              ? 'toast.authBadEmail'
              : res.error === 'AUTH_BAD_PASSWORD'
                ? 'toast.authBadPassword'
                : res.error === 'AUTH_UNAVAILABLE'
                  ? 'toast.authUnavailable'
                  : 'toast.authFailed';
        overlay.showAuthModal({ mode, email, error: t(key) });
        return;
      }
      overlay.hideAuthModal();
      overlay.setAuthState(auth.current());
      overlay.toast(t('toast.authWelcome', { email: auth.current()!.email }));
      // PR4.14/4.16 — saiu do muro: (re)monta o prédio e a cena da conta
      forceWall = false;
      void initUserBuilding();
    })();
  });
  overlayRoot.addEventListener('authsignout', () => {
    // PR4.16 — mesmo caminho do "Sair do Sistema" do perfil: muro real
    signOutReal();
    overlay.hideAuthModal();
    overlay.toast(t('toast.authBye'));
  });
  // authclose: o modal já se esconde sozinho no overlay; nada a fazer aqui.

  /**
   * Login (aqui ou no resume abaixo): a NUVEM manda quando existe —
   * restaura o snapshot da conta; conta vazia → sobe a cena local (1ª vez).
   * Deslogar: mantém a cena local do browser (nada é apagado).
   */
  const onLogin = () => {
    void (async () => {
      // PR4.16 — muro de pé (logout): o mundo em memória está zerado; nada
      // sobe nem desce da nuvem senão o PUT apagaria a cena da conta.
      if (persistLocked) return;
      const remote = await auth.getRemoteScene();
      if (persistLocked) return; // saiu do sistema no meio do fetch
      if (remote && Array.isArray(remote.objects) && remote.objects.length > 0) {
        world.loadSnapshot(remote);
        await repo.saveScene(world.toSnapshot()).catch(() => {});
        overlay.toast(t('toast.cloudRestored', { n: remote.objects.length }));
      } else {
        const snap = world.toSnapshot();
        const ok = await auth.putRemoteScene(snap);
        if (ok) overlay.toast(t('toast.cloudUploaded', { n: snap.objects.length }));
        else console.warn('sync inicial na nuvem falhou (segue em modo local)');
      }
    })();
  };
  auth.onChanged((session) => {
    if (session) onLogin();
  });
  // Resume do cookie (recarregou a página logado): restaura a cena da conta
  void auth.getSession().then((s) => {
    overlay.setAuthState(s);
    if (s) onLogin();
  });

  // Sync por snapshot (spec PR27): PUT com debounce. O flush do loop roda a
  // cada 2 s, então NÃO resetamos o timer se já houver um PUT agendado —
  // senão o timer nunca expiraria (2s < 3s) e a nuvem nunca receberia nada.
  // O primeiro flush após uma mudança agenda o PUT para +3 s; flushs
  // subsequentes são absorvidos (o snapshot é lido no momento do PUT).
  // (cloudSyncTimer é declarado lá em cima: o muro de logout precisa cancelá-lo)
  const queueCloudSync = () => {
    if (!auth.current()) return;
    if (persistLocked) return; // muro de pé: não subir snapshot zerado
    if (cloudSyncTimer) return; // já há um PUT agendado — não resetar
    cloudSyncTimer = window.setTimeout(() => {
      cloudSyncTimer = 0;
      if (persistLocked) return; // logout entre agendar e disparar
      void auth
        .putRemoteScene(world.toSnapshot())
        .then((ok) => {
          if (!ok) console.warn('sync na nuvem falhou (seguindo em modo local)');
        });
    }, 3000);
  };

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

  // PR11 — handle de rotação: clique reseta (reto), arrastar gira em Y
  overlay.onRotateStart((e: PointerEvent) => {
    const ids = world.getSelectedIds();
    if (ids.length === 0) return;
    const id = ids[0];
    const obj = world.getObject(id);
    if (!obj) return;
    // Clique simples (sem movimento) = reseta rotação para 0 (reto)
    const rot0 = obj.pose.rotation;
    const startScreen = { x: e.clientX, y: e.clientY };
    let moved = false;
    const onMove = (me: PointerEvent) => {
      const dx = me.clientX - startScreen.x;
      if (Math.abs(dx) > 4) moved = true;
      // Giro em torno do eixo Y proporcional ao movimento horizontal
      const angle = (dx * 0.01) % (Math.PI * 2);
      const q = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
      // Aplica delta sobre a rotação inicial (quat = q * rot0)
      const r = rot0;
      const next = {
        x: r.w * q.x + r.x * q.w + r.y * q.z - r.z * q.y,
        y: r.w * q.y - r.x * q.z + r.y * q.w + r.z * q.x,
        z: r.w * q.z + r.x * q.y - r.y * q.x + r.z * q.w,
        w: r.w * q.w - r.x * q.x - r.y * q.y - r.z * q.z,
      };
      // rotateSelectionTo já marca o mundo como dirty
      world.rotateSelectionTo(id, next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        // Clique parado → reseta rotação (reto)
        world.rotateSelectionTo(id, { x: 0, y: 0, z: 0, w: 1 });
        overlay.toast(t('toast.rotationReset'));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    e.preventDefault();
    e.stopPropagation();
  });

  // PR11 — barra deslizável de zoom: converte distância ↔ slider
  overlay.onZoomSlider((distance: number) => {
    world.setCamera({ ...world.getCamera(), distance });
  });
  // Inicializa o slider com a distância do preset 1 (distance: 329)
  overlay.setZoomSliderValue(329);
  overlay.onPileCloseClick(() => {
    if (world.closeOpenPile()) overlay.toast(t('toast.pileClosed'));
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

  // Flush imediato de persistência: o rAF do loop morre com a aba oculta,
  // então salvamos na hora em que ela esconde/recarrega (fecha a janela de perda
  // de até 2 s do SAVE_INTERVAL — cobre notas, pose, pilhas e câmera).
  // A PRIMEIRA falha de save vira toast: antes era só console.warn e o usuário
  // só descobria a perda quando o F5 zerava a cena (bug do fallback idb-sqlite).
  let saveFailToastShown = false;
  const flushNow = () => {
    // PR4.16 — muro de pé: NUNCA gravar o mundo zerado do logout por cima
    // da cena salva do usuário (o dado continua no repo/nuvem, intacto).
    if (persistLocked) return;
    repo
      .saveScene(world.toSnapshot())
      .then(() => queueCloudSync())
      .catch((e) => {
        console.warn('save falhou', e);
        if (!saveFailToastShown) {
          saveFailToastShown = true;
          overlay.toast(t('toast.saveFailed'));
        }
      });
  };
  const onVisibilityFlush = () => {
    if (document.visibilityState === 'hidden') flushNow();
  };

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
          // PR11 — handle de rotação no canto oposto (inf-esq)
          overlay.setRotateHandle({ x: minX, y: maxY });
        } else {
          overlay.setResizeHandle(null);
          overlay.setRotateHandle(null);
        }
      } else {
        overlay.setResizeHandle(null);
        overlay.setRotateHandle(null);
      }

      // PR9 — pilha aberta em grade: painel de vidro no piso + botão ✕
      const aberta = world.getOpenGridPile();
      if (aberta) {
        renderer.setPilePanel({ x: aberta.center.x, z: aberta.center.z, hw: aberta.hw, hd: aberta.hd });
        const topo = renderer.projectToScreen({
          x: aberta.center.x,
          y: 4,
          z: aberta.center.z - aberta.hd,
        });
        overlay.setPileCloseBtn(topo.visible ? { x: topo.x, y: topo.y } : null);
      } else {
        renderer.setPilePanel(null);
        overlay.setPileCloseBtn(null);
      }

      // Atualiza Pile Widget Halo (P1): projeta topo central da pilha → tela
      const haloState = world.getPileHaloState();      if (haloState) {
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

      // PR18/PR20 — destaques da busca: um retângulo na BORDA da nota;
      // o match atual ganha o estilo `.cur` (voar até ele é do world).
      // O tamanho vem dos 8 cantos da caixa projetados na tela — o destaque
      // "veste" a nota em qualquer ângulo de câmera (chão/parede).
      const searchState = world.getSearchState();
      if (searchState && searchState.ids.length > 0) {
        const markers: Array<{ id: string; x: number; y: number; w: number; h: number; cur: boolean }> = [];
        for (let i = 0; i < searchState.ids.length; i++) {
          const o = world.getObject(searchState.ids[i]);
          if (!o) continue;
          const he = o.meta.halfExtents;
          if (!he) continue;
          const s0 = renderer.projectToScreen(o.pose.position);
          if (!s0.visible) continue;
          const esc = o.scale > 0 ? o.scale : 1;
          // 4 cantos da FACE DE CIMA da nota (+he.y) rotacionados pela pose →
          // envelope na tela (a face de baixo, projetada em perspectiva,
          // deslocava o destaque para fora da nota)
          let minX = s0.x, maxX = s0.x, minY = s0.y, maxY = s0.y;
          for (let c = 0; c < 4; c++) {
            const off = rotateVec3ByQuat(
              {
                x: (c & 1 ? 1 : -1) * he.x * esc,
                y: he.y * esc,
                z: (c & 2 ? 1 : -1) * he.z * esc,
              },
              o.pose.rotation,
            );
            const s = renderer.projectToScreen({
              x: o.pose.position.x + off.x,
              y: o.pose.position.y + off.y,
              z: o.pose.position.z + off.z,
            });
            if (!s.visible) continue;
            minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
            minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
          }
          markers.push({
            id: searchState.ids[i],
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            w: maxX - minX,
            h: maxY - minY,
            cur: i === searchState.index,
          });
        }
        overlay.setSearchMarkers(markers);
      } else {
        overlay.setSearchMarkers(null);
      }
    },
    onFlush: () => {
      if (activeTronGame) return;
      flushNow();
    },
  });
  loop.start();

  // Persistência (item A): salva ao esconder a aba e ao descarregar a página
  document.addEventListener('visibilitychange', onVisibilityFlush);
  window.addEventListener('pagehide', flushNow);

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

  // PR12 → alarme REAL do lembrete. O beep antigo era perdido: um AudioContext
  // novo nascia "suspended" fora de gesture (autoplay policy) e o toast sumia em
  // 2,6 s. Agora: bipes por ~12 s (param no 1º clique/tecla), banner fixo até
  // dispensar e Notification do sistema (clássica ou via service worker da PWA).
  let alarmCtx: AudioContext | null = null;
  let alarmTimer: number | null = null;

  const getAlarmCtx = (): AudioContext | null => {
    try {
      if (!alarmCtx) {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        alarmCtx = new Ctx();
      }
      if (alarmCtx.state === 'suspended') void alarmCtx.resume().catch(() => {});
      return alarmCtx;
    } catch {
      return null;
    }
  };

  // autoplay policy: áudio só toca após interação do usuário — destravamos o
  // contexto em QUALQUER clique/tecla para o próximo bipe valer.
  const unlockAudio = () => {
    if (alarmCtx?.state === 'suspended') void alarmCtx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  const stopAlarm = () => {
    if (alarmTimer !== null) {
      window.clearInterval(alarmTimer);
      alarmTimer = null;
    }
  };

  const startAlarm = () => {
    stopAlarm();
    const ac = getAlarmCtx();
    let left = 15; // 15 bipes × 800 ms ≈ 12 s de alarme
    const chirp = () => {
      if (!ac) return;
      try {
        const t0 = ac.currentTime;
        for (const [freq, off] of [
          [880, 0],
          [1175, 0.18],
        ] as const) {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t0 + off);
          gain.gain.exponentialRampToValueAtTime(0.25, t0 + off + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
          osc.connect(gain);
          gain.connect(ac.destination);
          osc.start(t0 + off);
          osc.stop(t0 + off + 0.18);
        }
      } catch {
        // sem áudio (ex.: headless) — o banner e a notificação ainda avisam
      }
    };
    chirp();
    alarmTimer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopAlarm();
        return;
      }
      unlockAudio();
      chirp();
    }, 800);
    // o usuário viu o aviso? o 1º clique/tecla encerra o alarme
    const halt = () => {
      stopAlarm();
      window.removeEventListener('pointerdown', halt);
      window.removeEventListener('keydown', halt);
    };
    window.addEventListener('pointerdown', halt);
    window.addEventListener('keydown', halt);
  };

  /** Notificação do sistema: desktop usa a clássica; Android exige SW da PWA. */
  const notifySystem = (title: string, body: string) => {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') {
        // nunca pediu → tenta agora (o banner cobre caso o usuário negue)
        void Notification.requestPermission()
          .then((p) => {
            if (p === 'granted') notifySystem(title, body);
          })
          .catch(() => {});
        return;
      }
      if (Notification.permission !== 'granted') return;
      try {
        new Notification(title, { body });
      } catch {
        // Android lança aqui → mostra via service worker da PWA
        void navigator.serviceWorker?.ready
          .then((reg) => reg.showNotification(title, { body, tag: 'bumptop-reminder' }))
          .catch(() => {});
      }
    } catch {
      // sem Notification (contexto inseguro) — banner + som avisam
    }
  };

  const checkReminders = () => {
    const now = Date.now();
    for (const o of world.listObjects()) {
      if ((o.typeFlags & TypeFlags.StickyNote) === 0) continue;
      if (typeof o.meta.noteReminder !== 'number') continue;
      if (o.meta.noteReminderFired === true) continue;
      if ((o.meta.noteReminder as number) > now) continue;
      world.markNoteReminderFired(o.id);
      persistObject(o.id);
      const nome =
        (o.meta.noteTitle as string) ||
        (o.meta.noteText as string)?.slice(0, 40) ||
        t('ui.noteTitle');
      startAlarm();
      overlay.alarm(t('toast.reminderDue', { title: nome }));
      notifySystem(nome, ((o.meta.noteText as string) ?? '').slice(0, 120));
    }
  };
  checkReminders(); // checagem imediata no bootstrap (vencidos ao carregar)
  const REMIND_MS = 5000; // era 10 s — 5 s de latência máxima no alarme
  const remitter = window.setInterval(checkReminders, REMIND_MS);

  return {
    world,
    repo,
    loop,
    files,
    renderer,
    overlay,
    auth,
    dispose() {
      loop.stop();
      window.clearInterval(watcher);
      window.clearInterval(remitter);
      input.detach();
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibilityFlush);
      window.removeEventListener('pagehide', flushNow);
      overlayRoot.removeEventListener('resetcamera', onResetCamera);
      renderer.getCanvas().removeEventListener('dblclick', onDblClick);
      renderer.dispose();
      physics.dispose();
      repo.close();
      buildingView.dispose();
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
