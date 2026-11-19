import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTaigaCardTexture } from '../../src/app/noteTexture';

describe('makeTaigaCardTexture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retorna null quando document não está definido (fora do browser)', () => {
    vi.stubGlobal('document', undefined);
    expect(
      makeTaigaCardTexture({
        ref: 89,
        subject: 'Criação de Mecanismos de Alertas',
        statusName: 'Aberto',
        statusColor: '#8b5cf6',
      }),
    ).toBeNull();
  });

  it('cria textura com canvas e retorna dataURL para item do Taiga', () => {
    const filledRects: Array<{ x: number; y: number; w: number; h: number; fillStyle: string }> = [];
    const filledTexts: string[] = [];
    let currentFillStyle = '#000000';

    const fakeCtx = {
      set fillStyle(val: string) {
        currentFillStyle = val;
      },
      get fillStyle() {
        return currentFillStyle;
      },
      fillRect(x: number, y: number, w: number, h: number) {
        filledRects.push({ x, y, w, h, fillStyle: currentFillStyle });
      },
      strokeRect: vi.fn(),
      fillText(text: string) {
        filledTexts.push(text);
      },
      measureText: (text: string) => ({ width: text.length * 10 }),
    };

    const fakeCanvas = {
      width: 512,
      height: 512,
      getContext: () => fakeCtx,
      toDataURL: () => 'data:image/png;base64,taiga-card-texture',
    };

    vi.stubGlobal('document', {
      createElement: () => fakeCanvas,
    });

    const res = makeTaigaCardTexture({
      ref: 89,
      subject: 'MPCII-SP6-HU89 - Alertas no SIGPC',
      statusName: 'Pronto para Desenvolvimento',
      statusColor: '#10b981',
      showTitle: true,
    });

    expect(res).toBe('data:image/png;base64,taiga-card-texture');
    // Deve conter o ref no cabeçalho
    expect(filledTexts).toContain('#89');
    // Deve conter o nome do status em uppercase
    expect(filledTexts).toContain('PRONTO PARA DESENVOLVIMENTO');
    // Deve renderizar as palavras do título na capa do card
    expect(filledTexts.some((t) => t.includes('MPCII-SP6-HU89'))).toBe(true);
  });

  it('quando showTitle é false, exibe apenas ref no centro sem quebra de título', () => {
    const filledTexts: string[] = [];
    const fakeCtx = {
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: (t: string) => filledTexts.push(t),
      measureText: (t: string) => ({ width: t.length * 10 }),
    };
    const fakeCanvas = {
      width: 512,
      height: 512,
      getContext: () => fakeCtx,
      toDataURL: () => 'data:image/png;base64,taiga-no-title',
    };
    vi.stubGlobal('document', {
      createElement: () => fakeCanvas,
    });

    const res = makeTaigaCardTexture({
      ref: 42,
      subject: 'Demanda Secreta',
      statusName: 'Em andamento',
      showTitle: false,
    });

    expect(res).toBe('data:image/png;base64,taiga-no-title');
    expect(filledTexts).toContain('#42');
    expect(filledTexts).not.toContain('Demanda Secreta');
  });
});
