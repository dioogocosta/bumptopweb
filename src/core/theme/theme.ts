/**
 * Sistema de temas — espelha o schema `theme/1.0.3` do original
 * (`trunk/win/Source/Themes/<Nome>/theme.json`). Aqui usamos um subconjunto
 * tipado p/ M1; o loader de theme.json completo entra no M6.
 */
export interface Theme {
  name: string;
  background: number;
  floor: number;
  wall: number;
  /** Paleta de cores p/ "ícones" (arquivos) sem thumbnail. */
  iconPalette: string[];
}

export const THEMES: Theme[] = [
  {
    // Padrão — espelha o visual do original: piso azul claro, paredes azuis,
    // sombras marcadas (ver RELATORIO_ANALISE_VIDEOS.md §paridade visual).
    name: 'BumpTop',
    background: 0x16283a,
    floor: 0x6e97c9,
    wall: 0x3f6ea8,
    iconPalette: ['#4f9cff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b'],
  },
  {
    name: 'Night',
    background: 0x1a1a20,
    floor: 0x2a2a33,
    wall: 0x33333d,
    iconPalette: ['#4f9cff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b'],
  },
  {
    name: 'Slate',
    background: 0x0f1115,
    floor: 0x1c2028,
    wall: 0x262b34,
    iconPalette: ['#5e8cff', '#ff7a7a', '#4dd4a0', '#f5c451', '#b98cff', '#ff9d5c'],
  },
  {
    name: 'Warm',
    background: 0x1c1512,
    floor: 0x2a221c,
    wall: 0x362b23,
    iconPalette: ['#e8a33d', '#e06c5a', '#7fbf6a', '#d9c25a', '#9c7be0', '#e0795a'],
  },
];

export const DEFAULT_THEME = THEMES[0];
