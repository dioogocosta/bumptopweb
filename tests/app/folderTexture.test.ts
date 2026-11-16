/**
 * PR20 — textura da pasta em PIXEL VOXEL: canvas fake que registra os
 * fillRect e reconstrói a grade de 32×32 voxels p/ verificar o desenho
 * (fundo coberto, aba, frente com faixas e o contador em dígitos 3×5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFolderTexture } from '../../src/app/folderTexture';

const CELL = 8; // 256px / 32 voxels

/** Canvas fake: registra fillRect no mapa `cells` (cor por voxel). */
function fakeCanvas(cells: Map<string, string>) {
  let corAtual = '#000';
  const ctx = {
    imageSmoothingEnabled: false,
    set fillStyle(v: string) {
      corAtual = v;
    },
    get fillStyle() {
      return corAtual;
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let gy = Math.round(y / CELL); gy < Math.round((y + h) / CELL); gy++) {
        for (let gx = Math.round(x / CELL); gx < Math.round((x + w) / CELL); gx++) {
          cells.set(`${gx},${gy}`, corAtual);
        }
      }
    },
  };
  const canvas = {
    width: 256,
    height: 256,
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,fake',
  };
  return { canvas, cells };
}

function stubDocument(cells: Map<string, string>): void {
  vi.stubGlobal('document', {
    createElement: () => fakeCanvas(cells).canvas,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeFolderTexture (pixel voxel)', () => {
  it('cobre toda a face (32×32 voxels) e devolve dataURL', () => {
    const cells = new Map<string, string>();
    stubDocument(cells);
    const url = makeFolderTexture(0);
    expect(url).toBe('data:image/png;base64,fake');
    expect(cells.size).toBe(32 * 32); // face toda pintada (sem buracos)
  });

  it('fora do browser (node sem document) devolve null', () => {
    expect(makeFolderTexture(3)).toBeNull();
  });

  it('contador: count>0 pinta dígitos BRANCOS no centro da frente', () => {
    const cells = new Map<string, string>();
    stubDocument(cells);
    makeFolderTexture(7);
    // voxel corrente: encontra as células brancas (dígito)
    const brancos = [...cells.entries()].filter(([, cor]) => cor === '#ffffff');
    expect(brancos.length).toBeGreaterThan(0);
    // dígitos ficam na metade de baixo da aba e centro horizontal
    // dígitos ficam no centro vertical da frente (abaixo do topo)
    const ys = brancos.map(([k]) => Number(k.split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThan(8); // abaixo do topo
    expect(Math.max(...ys)).toBeLessThan(26); // acima do rodapé
  });

  it('aba aparece no canto superior esquerdo (cor da aba)', () => {
    const cells = new Map<string, string>();
    stubDocument(cells);
    makeFolderTexture(0);
    const cores = new Set(cells.values());
    expect(cores).toContain('#8ecbf4'); // aba
    expect(cores).toContain('#5aa7e8'); // frente
    expect(cores).toContain('#123657'); // contorno escuro
  });
});
