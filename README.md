# BumpTop 3D Web

Réplica web do **BumpTop** (desktop 3D nativo, Apache 2.0 / Google 2012) rodando
no navegador. Organize arquivos em **pilhas físicas 3D** com **inércia**, **arremesso (toss)**
e **salas com paredes** — a alma do original, em TypeScript + WebGL.

> Status: **M0–M6 completos + P0 (análise de vídeos)** — pilhas (Stack/Grid/Leaf),
> toss, shove, pinning, FS real (FS Access API + OPFS), notas adesivas, temas, PWA
> instalável, **i18n (pt-BR/en)**, grade/ordenar/duplicar/escalar seleção.
> **82 testes unit · 23 E2E (desktop+mobile) · 0 violações de arquitetura.**
> Ver `../PLANO_BUMPTOP_WEB.md` para o roadmap completo e
> `../RELATORIO_ANALISE_VIDEOS.md` para a análise dos demos originais.

## Rodando

```bash
npm install
npm run dev        # servidor de desenvolvimento (http://localhost:5173)
npm run build      # typecheck + build de produção (PWA) em dist/
npm run preview    # serve o build de produção (http://localhost:4173)
```

Após o build, o app é **instalável como PWA** (desktop Chrome/Edge e mobile) e
funciona **offline**.

## Testes e qualidade

```bash
npm test             # testes unitários do núcleo puro (Vitest)
npm run test:e2e     # smoke E2E no navegador (Playwright; requer `npx playwright install chromium`)
npm run typecheck    # TypeScript strict
npm run lint:arch    # garante que src/core/** permanece puro (sem DOM/WebGL/SQL)
```

A **CI** (`.github/workflows/ci.yml`, na raiz do repo) roda tudo a cada push que
muda `BumpTop3D/**`: build → lint:arch → unit → E2E (desktop + mobile) → `diag.mjs`.

## Arquitetura (Ports & Adapters)

O `src/core/` é **100% puro** — sem DOM, WebGL, Rapier ou SQL. Toda infraestrutura
(física, render, persistência, input) entra por **ports** (interfaces) implementadas
por **adapters**. Isso mantém a lógica de domínio testável e portável (futuro
Tauri/Electron troca só os adapters).

```
src/
  core/            PURO — modelo, piles, interação, câmera, ports/
  physics/         adapter Rapier (física WASM)
  render/          adapter three.js (WebGL)
  persistence/     adapter SQLite (WASM) — Worker, OPFS + fallback IndexedDB
  input/           adapter Pointer Events → ações semânticas (mouse+touch)
  overlay/         adapter DOM (menus, labels, toasts)
  app/             composition root (DI), main loop, bootstrap
  pwa/             Service Worker (injectManifest)
```

### Regras de arquitetura (garantidas por `lint:arch`)
1. `core/` importa apenas de dentro de `core/`.
2. `core/` não referencia DOM, WebGL, `localStorage`, `indexedDB` nem engines.
3. O input é **semântico** — o consome ações (`Drag`, `Zoom`, `Context`...), não eventos crus.
4. Render **condicional** (só re-desenha quando algo mudou) e física em **timestep fixo**.

## Persistência

SQLite real (WASM) num Worker dedicado, com dois backends escolhidos em runtime:
- `opfs-sqlite` — persiste em OPFS (Chromium/modern browsers). **Preferido.**
- `idb-sqlite`  — fallback: SQLite em memória exportado p/ IndexedDB (Firefox/iOS antigo).

O schema (`src/persistence/sqlite/schema.ts`) deriva do `.proto` original do BumpTop.

## Controles

| Ação | Desktop | Mobile |
|---|---|---|
| Selecionar/arrastar (mola amortecida) | clique + arrastar | toque + arrastar |
| Toss (arremesso) | soltar após arraste rápido | idem |
| **Laço (seleção múltipla)** | mouse no **chão vazio** + arrastar | — |
| Shove (empurrar objetos no chão) | — | arrastar o chão com o dedo |
| **Seleção aditiva** | **shift + clique** (ou girar o laço) | — |
| **Excluir selecionado(s)** | tecla **Delete** / menu → Excluir | menu → Excluir |
| **Renomear** | tecla **F2** / menu → Renomear… | menu → Renomear… |
| Zoom | scroll | pinch |
| **Scroll sobre pilha** | Grid: pagina (±); Stack: **peel** (gira) | — |
| Órbita da câmera | botão direito/meio + arrastar | arrastar com 2 dedos |
| Menu de contexto | botão direito | long-press |
| Abrir arquivo/pasta | duplo-clique | double-tap |
| **Abrir pilha em leque** | duplo-clique na pilha | duplo-tap na pilha |
| **Fechar leques** | duplo-clique no **chão vazio** | — |
| Presets de câmera | teclas **1–4** | — |
| **Reset Camera** | botão canto sup. direito / tecla **0** | botão |
| Ciclar tema (Night/Slate/Warm) | tecla **T** | — |
| Nova nota adesiva | menu do chão vazio → "Nova nota adesiva" | long-press no chão |
| Editar nota | duplo-clique na nota | double-tap na nota |
| **Auto-pilha por tipo** | menu do chão vazio → "Auto-pilha por tipo" | idem |
| **WallToss** | toss contra a parede → prende e mostra toast | idem |
| **Grade da seleção (Grid View)** | menu do item → "Grade da seleção" | idem |
| **Ordenar por tamanho/tipo** | menu → "Ordenar por tamanho/tipo" | idem |
| **Duplicar seleção** | menu → "Duplicar seleção" | idem |
| **Escalar seleção (±25%)** | teclas **+ / −** → menu → "Aumentar/Diminuir" | menu |
| **Tooltips do menu** | hover sobre o item (caixa preta) | — |

> **Nota — Duplicar**: cria uma cópia **visual** (mesmo `fsPath`), não copia o
> arquivo em disco — é um atalho para o mesmo arquivo, como um "link" espelhado.

## Idiomas (i18n)

UI em **português (pt-BR, padrão)** com **inglês** completo — camada leve e pura
em `src/core/i18n/i18n.ts` (`t(chave, { params })` com fallback pt-BR). O idioma
 vem do `settings` persistido (`lang`) ou de `navigator.language`, aplicado no
boot (`di.ts`). Para adicionar um idioma: copie o dicionário em `i18n.ts`, registre
em `DICTS` — o teste de paridade (`tests/core/i18n.test.ts`) acusa qualquer chave
esquecida.

## Mecânica-chave replicada

- **Mola amortecida** no arraste (`core/interaction/dampedSpringDrag.ts`) — origem do "peso"/inércia.
- **Toss**: ao soltar com `|v|² ≥ limiar`, o item vira projétil.
- **Ícones não colidem entre si** — só com piso/paredes (collision groups, como o original).
- **Câmera orbit restrita** (`core/camera/orbitCameraController.ts`) — não é free-fly.

## Licença

Apache-2.0 (mesma do BumpTop original).
