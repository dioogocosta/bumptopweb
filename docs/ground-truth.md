# Ground-truth — constantes extraídas do BumpTop original

Extraídas **direto do fonte** (`BumpTop-master/trunk/win/Source`), não do binário —
temos o código-fonte completo (Apache 2.0), então análise de binário é dispensável aqui.

## Física (`BT_Util.cpp` → `InitNovodex`)

| Constante | Valor original | Fonte | Nosso código |
|---|---|---|---|
| Gravidade | `gravityScale=10 × -9.81 = **-98.1**` | BT_Util.cpp:2632-2634 | `DEFAULT_PHYSICS.gravityY = -98.1` ✓ |
| Atrito estático | `0.55` | BT_Util.cpp:2622 | `DEFAULT_PHYSICS.friction = 0.55` ✓ |
| Atrito dinâmico | `0.675` | BT_Util.cpp:2623 | (Rapier usa um; 0.55 p/ M1) |

## Toss (`BT_Settings.cpp` / `BumpTop.cpp:1060`)

| Constante | Valor | Significado |
|---|---|---|
| `MinStartTossVelocitySq` | `100*100 = **10000**` | \|v\|² ≥ 10000 (i.e. \|v\| ≥ 100) inicia um toss |
| `EndTossVelocitySq` | `10*10 = **100**` | \|v\|² < 100 (i.e. \|v\| < 10) encerra o toss |

Condição (`BumpTop.cpp:1060`):
`settings.enableTossing && pickedActor && linVel² >= MinStartTossVelocitySq → modo toss`.

Consistência: objeto lançado a |v|=100 sob gravidade -98.1 atinge h = v²/2g ≈ 51 unidades
≈ altura da parede. A escala é auto-consistente.

## Paredes / sala (`BT_Util.cpp` → `CreateWalls`, `kWallPositionBuffer`)

| Constante | Valor | Fonte |
|---|---|---|
| Paredes E/O | x = ±**150** | BT_Util.cpp:2665-2666 |
| Paredes N/S | z = ±**120** | BT_Util.cpp:2663-2664 |
| Altura inicial parede | `WallHeight = 55.0` | BT_Util.cpp:2658 |
| Espessura parede | 10 | CreateCuboid(...,10) |
| `kWallPositionBuffer` | `10.0` | BT_Util.cpp:92 |
| `wallPos` (y) | `wallHeight - 10` | BT_Util.cpp:2661 |

Sala real: 300 (x) × 240 (z), paredes 55 altas. Nossa web usa sala quadrada
`halfSize=130, wallHeight=55, thickness=10` (proporção equivalente).

## Piles — log-altura (`BT_Pile.cpp` → `getLogHeightSteps`, l.462-482)

Quando `pileItems.size() > maxLinearPileHeight`:
```
lhExtraItems = size - maxLinearPileHeight
lhPileHeight = pow(log(1 + lhExtraItems), 2.4)
             + Σ_{i<maxLinearHeight} (2 * item[i].dims.z)   // altura da parte linear
logHeightStep = lhPileHeight / size                          // distribui entre todos
```
Abaixo do limiar, empilhamento linear (altura constante por item). Fórmula pronta p/ M3.

## Próximas constantes a extrair (M3+)
- `maxLinearPileHeight` (setting) — limiar linear vs log.
- Grid: `PILE_GRID_ROWSIZE/COLSIZE` (4×4) e escala `adjustToVisibleGridItems`.
- Thresholds de gestos (`BT_GestureManager`, `BT_CommonFiniteStates`).
- Parâmetros de câmera (presets, zoom bounds) — `BT_Camera.cpp`.
