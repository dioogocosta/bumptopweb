# HANDOFF — BumpTop Web

Documento de continuidade para a próxima IA ou desenvolvedor. Leia inteiro antes de mexer no código.

## 1. O projeto

- **O que é:** uma versão web do BumpTop, o desktop 3D com física (Google, 2012, Apache 2.0). Os arquivos viram objetos numa sala 3D e podem ser arrastados, arremessados, empilhados, pregados nas paredes e selecionados com laço.
- **Repositório:** https://github.com/dioogocosta/bumptopweb (branch `main`)
- **Site publicado:** https://bumptopweb.pages.dev/ — **Cloudflare Pages** publica a `main` automaticamente a cada push. (Vercel: conta bloqueada; Netlify de produção pausado — ver §8.)
- **Fonte do original, para consulta:** https://github.com/bumptop/BumpTop, principalmente `trunk/win/Source` (`BT_Util.cpp`, `BT_Pile.cpp`, `BumpTop.cpp`).
- **Vídeo de referência usado pelo dono:** "Keepin' It Real: Pushing the Desktop Metaphor with Physics, Piles and the Pen" (DGP Toronto). Ele mostra: Lasso'n'Cross, LassoMenu, Pile Widgets (Fisheye, Leafer, Compression Browse, Fan-Out, Grid, Messy/Tidy), Pressure Lock, Drag'n'Cross, Dwell and Scrub, Hierarchical Piles, Exploding Piles, Enforcing Axis-Alignment e papéis "crumple/crease".
- **Idioma:** o dono fala português do Brasil. A interface é pt-BR por padrão, com en completo.

## 2. Stack e comandos

TypeScript, Vite 8, three.js (render), Rapier 3D WASM (física), SQLite WASM em Worker (persistência em OPFS, com IndexedDB como reserva), Preact, PWA. Testes com Vitest (unitários) e Playwright (E2E, desktop e mobile).

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # unit (Vitest)  — 226 testes
npm run test:e2e     # E2E (Playwright) — 66 passam; 6 pulados; 0 falhas (PR #56)
npm run lint:arch    # garante que src/core/** continua puro
npm run build
node scripts/validate-sheets.mjs   # validação das folhas finas (BASE_URL=http://localhost:5174 se a porta padrão estiver ocupada)
```

O app fica exposto em `window.__bumptop` = `{ world, repo, loop, files, renderer, overlay }`. É muito útil para testes no navegador. Exemplos: `world.listObjects()`, `renderer.projectToScreen(pos)`, `world.isInsideRoom(id)`, `world.getLassoState()`.

## 3. Arquitetura (Ports & Adapters)

```
src/core/        PURO (sem DOM/WebGL/Rapier/SQL) — lint:arch verifica
  world.ts       o coração (~2200 linhas): objetos, gestos, pilhas, laço, grupo, paredes
  ports/index.ts contratos IPhysics, IRenderer, IOverlay, LassoData...
  model/types.ts PhysicsConfig (inclui `level`), RoomConfig, DEFAULT_*
  piles/         PileManager + layouts (Stack/Grid/Leaf)
  interaction/   mola amortecida (DampedSpringDrag), FSM de gestos
  i18n/i18n.ts   dicionários pt/en (o teste de paridade acusa chave faltando)
physics/rapier/  adapter de física
render/three/    adapter de render
overlay/         DOM: menu radial, laço SVG, halo da pilha, scrub, labels, toasts
input/pointer/   Pointer Events → ações semânticas
app/di.ts        composição: menus de contexto, LassoMenu, atalhos, halo, loop
```

Regras: `core/` não importa nada de fora dele. Toda engine entra por porta. O input chega como ações semânticas (`pointerDown`, `pointerMove`, `context`...). Os mocks das portas ficam em `tests/core/world.test.ts` e `tests/core/selection.test.ts`. Ao adicionar um método numa porta, atualize **os dois** mocks.

## 4. Estado atual: o que foi feito nesta sessão (todo já na `main`)

> **Nota (18/11/2026):** esta tabela é o histórico da primeira sessão (PR1/PR2). O estado **recente** do projeto — Control Manager (fases 4a, 4.2, 4.3 e 4.4), login/D1 (PR27), perfil do usuário (PR4.12) e as pendências abertas — está em **§8**. Contadores atualizados em §2 (226 unit / 66 E2E passando).

| Commit / PR | O que mudou |
|---|---|
| `01dbb32` | **Render em telas de alta densidade:** `resize()` sobrescrevia `canvas.width/height` depois do `setSize`, e a cena saía ampliada e deslocada em telas com DPR maior que 1. |
| PR #1 | **Paredes sólidas:** o arraste fica limitado à face interna. As paredes de colisão têm 8× a altura visual e há um teto invisível. Os itens têm CCD e uma rede de segurança (`containEscapees`) devolve qualquer item que escape. Itens novos nascem dentro da sala. |
| PR #1 | **Laço do vídeo:** disco azul na origem. Fechar o laço e soltar no disco abre o **LassoMenu** (callback `world.onLassoMenu`, montado em `di.ts`). Depois de fechar, cruzar o alvo central (**Lasso'n'Cross**) empilha a seleção. |
| PR #1 | **Seleção em grupo:** arrastar um item de uma seleção múltipla move o grupo mantendo a formação (`beginGroupDrag` / `releaseGroup`). Clique sem arrastar deixa só o item clicado selecionado. |
| PR #1 | **Física em 2 níveis** (`PhysicsConfig.level`, alternável no menu do chão). Nível 1: itens se atravessam. Nível 2 (padrão): caixas colidem, empurram e empilham (`setItemCollisions`). |
| PR #1 | **Girar 45°** (`rotateSelection`). O menu radial fecha com Esc e clique fora. Itens pregados ficam **de pé** na parede (quaternions por parede em `pinToWall`). |
| PR #2 | **Halo da pilha clicável:** a âncora agora fica no centro da pilha. Antes, os botões ficavam a ~70 px e sumiam no caminho até eles. |
| PR #2 | **Prender na parede é opcional e vem desligado** (`autoWallPin`, toggle "Prender ao jogar na parede" no menu do chão). Itens presos são escolhidos pela posição na tela (`pickPinnedOnScreen`), então dá para puxá-los de volta. |
| `124b6a8` | **Itens finos como folhas:** `asSheet()` deixa a meia-espessura em 5% da largura (0,35 num item de 14; antes era 1,6). Vale para itens novos e para cenas carregadas. **Verificado no navegador em 10/11/2026** (ver §5.1). |

## 5. Pendências conhecidas (por prioridade)

1. ~~Verificar no navegador a mudança para folhas finas~~ — **RESOLVIDO em 10/11/2026**: validado com `node scripts/validate-sheets.mjs` (9/9): 7/7 itens a 5% de espessura, zero flicker entre frames (sem z-fighting com o piso), drift 0 após assentar e após arremesso, pilha de 4 folhas com altura 2,55 (= 3 x 0,85, empilhamento exato), 7/7 labels dentro da tela e zero erros de console. `SHEET_HALF_THICKNESS = 0,35` mantido — nada tremeu, não precisou do plano B (0,5).
2. **Itens só giram no eixo Y** (`enabledRotations(false, true, false)`). Um item apoiado na quina de outro não tomba e fica "flutuando". No vídeo, os itens inclinam nas pilhas bagunçadas. Uma opção é liberar a rotação X/Z só no nível 2, com amortecimento angular alto, e endireitar o item quando ele parar.
3. **Câmera padrão corta a parede norte:** um item pregado nela fica fora da tela. Ajustar o preset em `core/camera/orbitCameraController.ts` ou a altura dos itens pregados.
4. **Lista do dono a validar ou implementar:**
   - arrastar arquivos do computador para a mesa (há FS Access e OPFS em `src/fs/` e `app/fileService.ts`; falta conferir o drop de arquivos);
   - salvar posições automaticamente e reabrir igual (o SQLite existe; validar o fluxo de ponta a ponta);
   - busca e organização por atributos (não existe);
   - massa por tipo de arquivo (não existe);
   - personalização do ambiente (há temas Night/Slate/Warm na tecla T);
   - gestos multitouch (pinch, long-press e 2 dedos existem; falta teste em aparelho real).
5. **Widgets do vídeo ainda parciais:** Fisheye, Leafer e Compression Browse; Pressure Lock; Drag'n'Cross; Hierarchical Piles; Crumple/Crease.
6. **README desatualizado:** diz "82 unit / 23 E2E" e cita uma CI em `.github/workflows/ci.yml` que **não existe** neste repositório. Criar a CI (typecheck, lint:arch, unit e build) seria um bom próximo passo.

## 6. Armadilhas (descobertas na prática)

- **Kinematic e paredes:** no Rapier, corpo cinemático não colide com corpo fixo. O item arrastado atravessa a parede se o código não limitar a posição. Limite a **posição** (`clampToRoom` em `update`), **não o alvo** da mola, senão o arremesso perde força perto da parede.
- **WallToss** precisa da velocidade **antes** do `step`, porque o impacto com a parede zera a velocidade (`preStep` em `update`).
- **Picking** é por distância no plano XZ do chão (`pickAt`, raio 13). Itens no alto (pregados) precisam de picking pela tela.
- **Rotação de 45°** muda a área ocupada no chão: use `floorExtents()` (considera o yaw), não `halfExtents.x`.
- **Playwright** considera invisível um elemento de tamanho 0×0. A âncora do halo tem 2×2 px por isso.
- **O E2E deste ambiente** usou o Chromium já instalado em `/opt/pw-browsers/chromium` via `launchOptions.executablePath`. Em máquina normal, rode `npx playwright install chromium`.
- **PWA:** depois de publicar, o navegador pode mostrar a versão antiga. Use Ctrl+F5.

## 7. Fluxo de trabalho combinado com o dono

- Os ajustes vão em branch e PR. O dono pediu explicitamente para publicar na `main` quando estiver pronto, e o **Cloudflare Pages** publica sozinha (ver §8).
- Commits em Conventional Commits, em português.
- Antes de publicar: `npm run typecheck && npm test && npm run lint:arch && npm run build`, mais o E2E quando mexer em UI.
- O dono tem créditos limitados: priorize mudanças pequenas, verificadas e publicadas.

## 8. PR27 — Login/conta com Cloudflare D1 + cena na nuvem · estado do Control Manager (nov 2026)

**Deploy principal: Cloudflare Pages (`bumptopweb.pages.dev`) — Netlify de produção pausado (sem créditos).**

### Arquitetura da conta
- **Backend**: `functions/api/*.ts` (Pages Functions same-origin, publicadas automaticamente pelo Cloudflare). Rotas: `POST /api/signup|login|logout`, `GET /api/session`, `GET|PUT /api/scene` (snapshot = formato do export JSON).
- **Banco**: Cloudflare **D1**, bind **`DB`** (criado pelo dono: `bumptop-db`). O schema se auto-garante no 1º uso (`ensureSchema` em `_lib.ts`); `docs/d1-setup.sql` é a referência canônica.
- **Porta**: `IAuthPort` em `src/core/ports/index.ts` — o core NUNCA vê fetch/D1. Adapter: `src/auth/cloudflareAuth.ts` (fora do core), ligado no `di.ts` (também faz o sync da cena).
- **UI**: botão de conta na `.zoom-controls` + modal `.auth-*` (vidro); i18n `ui.auth*`/`toast.auth*`/`toast.cloud*` em pt-BR + en.

### Regras duras (não desviar)
- Senha: PBKDF2-SHA256 (100k iterações = mínimo da spec; 150k estourava o limite de CPU do plano free do Workers em produção → 500 no signup/login; wrangler local não aplica o limite), salt 16 bytes por usuário, via WebCrypto do Worker; nunca armazenar a senha.
- Sessão: token 32 bytes; no banco SÓ o SHA-256 do token; cookie HttpOnly+Secure+SameSite=Strict (30 dias).
- `user_id` SEMPRE resolvido do cookie no servidor (`WHERE user_id = ?`) — o front nunca manda.
- Erro genérico em login/signup (não revelar existência de conta). Rate limit por IP: 10 tentativas/5 min (em memória por isolate — best-effort; migrar p/ KV se precisar de limite global).

### Comportamento de sync/degadação
- Login: nuvem manda quando existe (restaura snapshot + salva local); conta vazia → SOBE a cena local (nada "some"); deslogar mantém a cena local.
- Sync: a cada flush local (loop 2 s) agenda PUT com debounce 3 s — **não resetar o timer se já houver PUT agendado** (2 s < 3 s: senão nunca expira).
- Sem API (404 — vite preview/dev/Netlify): adapter marca `apiDown` e corta `/api/*` — app 100% funcional em modo local (OPFS). Com D1 não bindado: 503 genérico.

### Validação
- Sonda: `BASE_URL=... node scripts/validate-pr27.mjs` — 13/13 com D1 local (`npx wrangler pages dev dist --d1 DB`); em produção o P27c só roda com o D1 bindado (sonda POST dummy: 503 → pula, 400 → roda).
- Unitários do adapter: `tests/auth/cloudflareAuth.test.ts` (7 testes).

### Pendências abertas (pós-PR27)
1. **Control Manager (item 4 do dono) — EM ANDAMENTO por fases** (✅ publicadas: **4a · 4.2 · 4.3 · 4.4**; ⏳ pendente: Backlog/Taiga): ref. horizonx.so (Energy Command Dashboard: torre diagonal de blocos selecionáveis + dashboard lateral de vidro). **CONCEITO (do dono): CAIXA = o espaço (chão + 4 paredes) onde TUDO acontece — pastas/arquivos/notas ficam DENTRO dela; caixa ≠ pasta.** Modelo escolhido: caixas LADO A LADO no mesmo mundo 3D (cada uma com chão+paredes próprios); a sala original migrou para ser a 1ª caixa ("Caixa Comum", `box-default`).
   - **PR4a ✅ refeito**: `BoxEntityData` no core (`id/name/type/pos/halfSize`), física+render com `origin` por caixa, clamp/parede/wall-pin/wall-toss/auto-align box-aware (`meta.boxId` por item), snapshot com `boxes`+`currentBoxId` (migração automática de mundos antigos sem `boxes`), `World.addBoxEntity/flyToBox/setCurrentBox`, pan da câmera limitado à caixa ativa, painel `.boxes-*` lista caixas (ativa marcada com ● verde). Sonda: `scripts/validate-pr4a.mjs` (6/6).
   - **PR4.2 ✅ — CRUD de caixas**: criar (`+ Nova caixa`, nome automático "Caixa n", nasce na diagonal da torre `{x:340k, z:-340k}` e vira a ativa)/renomear inline (Enter/blur commita, Esc restaura, trim+60 chars)/pesquisar por nome (filtro local)/excluir com confirmação dentro do item (itens voltam à Caixa Comum clampados, pregados despregam de pé; `box-default` é intocável; a ativa PODE ser excluída — a Comum assume). Porta nova `removeRoom(room)` em IPhysics+IRenderer (rapier: `roomBodies` por `${ox}|${oz}`; three: `roomGroups`/`roomMats`, setTheme pinta todas). Bug real achado pela sonda: o worker SQLite descartava `boxes`/`currentBoxId` no `saveScene` (caixas sumiam no F5) — migração v2 (`scene.boxes_json`+`scene.current_box_id`) + leitura no `loadScene` (a nuvem já gravava o snapshot inteiro). Sonda: `scripts/validate-pr4b.mjs` (8/8 no wrangler e em produção). Regressões produção: PR4a 6/6 · PR27 13/13 · PR18 6/6 · PR17 4/4. Playwright 63/64 (falha pré-existente PR10).
   - **PR4.3 ✅ — Tipos de caixa**: `BoxType` funcional (`'comum'|'root'|'kanban'|'backlog'`). `World.setBoxType` (recusa `box-default`) + porta `setRoomType`/`setRoomDashboard` em IRenderer. **ROOT** = dashboard pixel-voxel na parede norte (canvas 512×256, NearestFilter; `syncDashboard()` no `update()` só empurra stats quando a assinatura muda — dirty flag). **Kanban** = 3 raias verticais no chão (A Fazer/Fazendo/Feito) + `meta.kanbanLane` 0..2 pela posição x, atualizado em `addBox`/`placeAt`. Painel: select `.boxes-type-sel` (Backlog desabilitado), badge `.boxes-type-badge` no item, `boxcreate` com `detail` do tipo. Sonda: `scripts/validate-pr4c.mjs` (8/8 no wrangler e em produção — ATENÇÃO: fecha o modal e espera 10 s antes do reload; recarregar com save em andamento abre o OPFS em conflito e o snapshot não carrega). Regressões produção: PR4b 8/8 · PR4a 6/6 · PR27 13/13 · PR18 6/6 · PR17 4/4. Playwright 63/64 (falha pré-existente PR10).
   - **PR4.4 ✅ — Tela de entrada = PRÉDIO com andares** (PR #39, +431 linhas, `src/building/BuildingView.ts` com 306): prédio 3D onde **cada andar = uma caixa existente** (rótulo `F{n}` em sprite, cor por `BoxType`, `cam.ty` recentrado no meio do prédio; sem caixas → "chão" placeholder `__empty__`). Render em canvas próprio (scene/camera/WebGLRenderer próprios, container `z-index: 50`) com fade in/out (~370 ms), órbita por arrastar/zoom e raycast no clique do andar. Fluxo: **clique no andar** → fade-out → `setCurrentBox` + toast "Entrando na caixa" → mostra **"↩ Voltar ao Prédio"** (`.building-back-btn`); **botão 🏢** (`.building-btn`, barra de zoom) alterna prédio/caixa a qualquer momento. Referência do dono: arc0050 (`C:\Projetos\BumpTop3D\arc0050-1.0.1\arc0050`, imagem `image-1.png`). **Validado em produção (18/11/2026)**: bundle `index-*.js` contém as strings do PR + sonda funcional **6/6** (botão presente, prédio visível, entra no andar com fade+toast, volta ao prédio, 0 erros de console).
   - **Pendente do item 4 — Backlog (Taiga)**: select de tipo já oferece "Backlog (em breve)" desabilitado; a implementação (mapear caixas/issues do **Taiga** `taiga.fnde.gov.br` — API `/api/v1` via Pages Functions por CORS) é **PR próprio** — é o "item 6" da lista do dono (planejar antes de codar).
   - **PR4.12 ✅ — perfil do usuário + loading do prédio** (PR #55): modal de perfil (avatar, troca de senha, logout via Taiga), `initUserBuilding()` com tela de loading e sync de projetos.
   - **PR4.13 ✅ — ícones de painel nas caixas + fix do tema** (PR #56): (a) o container do prédio estava em `z-index: 50` sobre `document.body` e cobria o `#overlay-root` (z 10) — a **barra de botões inteira era inacessível na primeira tela** (não dava para trocar o tema); agora `z 5` (acima da cena, abaixo do HUD). (b) novos botões **☰ Andares** e **📊 Resumo** na barra abrem/fecham os painéis **também no ambiente das caixas** (host `boxPanelHost` z 8, fora do fade do prédio; labels/`search-hl` foram para uma camada `underlay` z 2 para continuarem atrás do prédio). `show()` reabre os dois painéis / `hide()` fecha (navegar entre andares não fecha o menu). Bug colateral corrigido: com `?nobuilding=1` o `loadingOverlay` (invisível, `pointer-events: auto`) bloqueava os cliques nos ~1.5 s iniciais. Suíte E2E atualizada para o comportamento do `main` (notas por duplo-clique `f17d34b`, preset 1 = 329, voo da busca centralizando `423579d`, testes de cena com `?nobuilding=1`): **66/66 verdes** (o `main` tinha 42 falhas — ver §5.6).
2. Reset/backup por usuário: a cena vai em UMA linha por usuário (sem histórico de versões) — merge de mudanças offline não existe (nuvem manda).
3. Rate limit global (KV/DO) e verificação de e-mail: não implementados (v1).
4. PWA: cache do SW pode servir bundle velho — Ctrl+F5; após bind do D1, o re-deploy é o que ativa o binding das Functions.
5. ~~**Quebra pré-existente na `main` (nov 2026)**~~ — **RESOLVIDA no PR #56**: os testes de cena agora abrem com `?nobuilding=1` (a primeira tela é o prédio desde o PR4.4 e o canvas das caixas ficava coberto); o `loadingOverlay` com `?nobuilding=1` também foi corrigido (bloqueava cliques iniciais). Playwright **66/66**.
6. **Estado dos deploys**: Vercel com conta bloqueada (check vermelho pré-existente em todos os PRs — ignorar); Netlify de produção pausado; **Cloudflare Pages** é o deploy real (`bumptopweb.pages.dev`, publica a `main`); deploy previews saem no Netlify/Cloudflare.
