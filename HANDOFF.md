# HANDOFF — BumpTop Web

Documento de continuidade para a próxima IA ou desenvolvedor. Leia inteiro antes de mexer no código.

## 1. O projeto

- **O que é:** uma versão web do BumpTop, o desktop 3D com física (Google, 2012, Apache 2.0). Os arquivos viram objetos numa sala 3D e podem ser arrastados, arremessados, empilhados, pregados nas paredes e selecionados com laço.
- **Repositório:** https://github.com/dioogocosta/bumptopweb (branch `main`)
- **Site publicado:** https://bumptopweb.vercel.app/. A Vercel publica a `main` automaticamente a cada push.
- **Fonte do original, para consulta:** https://github.com/bumptop/BumpTop, principalmente `trunk/win/Source` (`BT_Util.cpp`, `BT_Pile.cpp`, `BumpTop.cpp`).
- **Vídeo de referência usado pelo dono:** "Keepin' It Real: Pushing the Desktop Metaphor with Physics, Piles and the Pen" (DGP Toronto). Ele mostra: Lasso'n'Cross, LassoMenu, Pile Widgets (Fisheye, Leafer, Compression Browse, Fan-Out, Grid, Messy/Tidy), Pressure Lock, Drag'n'Cross, Dwell and Scrub, Hierarchical Piles, Exploding Piles, Enforcing Axis-Alignment e papéis "crumple/crease".
- **Idioma:** o dono fala português do Brasil. A interface é pt-BR por padrão, com en completo.

## 2. Stack e comandos

TypeScript, Vite 8, three.js (render), Rapier 3D WASM (física), SQLite WASM em Worker (persistência em OPFS, com IndexedDB como reserva), Preact, PWA. Testes com Vitest (unitários) e Playwright (E2E, desktop e mobile).

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # unit (Vitest)  — 114 testes
npm run test:e2e     # E2E (Playwright) — 29 passam, 3 são pulados de propósito
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

- Os ajustes vão em branch e PR. O dono pediu explicitamente para publicar na `main` quando estiver pronto, e a Vercel publica sozinha.
- Commits em Conventional Commits, em português.
- Antes de publicar: `npm run typecheck && npm test && npm run lint:arch && npm run build`, mais o E2E quando mexer em UI.
- O dono tem créditos limitados: priorize mudanças pequenas, verificadas e publicadas.
