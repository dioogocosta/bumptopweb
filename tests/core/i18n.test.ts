/**
 * Testes do módulo i18n (P0 — camada de tradução).
 * Garante paridade dos dicionários pt-BR/en e a interpolação de `{param}`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getLang, keysOf, langs, setLang, t } from '../../src/core/i18n/i18n';

describe('i18n (P0)', () => {
  afterEach(() => setLang('pt-BR'));

  it('dicionários pt-BR e en têm exatamente as mesmas chaves (paridade)', () => {
    expect(keysOf('en')).toEqual(keysOf('pt-BR'));
    expect(keysOf('pt-BR').length).toBeGreaterThan(70); // cobre menus/toasts/UI
  });

  it('todo valor de tradução é uma string não-vazia', () => {
    for (const lang of langs()) {
      setLang(lang);
      for (const key of keysOf(lang)) {
        expect(t(key), `${lang}:${key}`).not.toBe('');
      }
    }
  });

  it('interpola parâmetros {chave} em ambos os idiomas', () => {
    setLang('pt-BR');
    expect(t('toast.deleted', { n: 3 })).toBe('3 itens excluídos');
    setLang('en');
    expect(t('toast.deleted', { n: 3 })).toBe('3 items deleted');
    // Parâmetro com valor parcial em uma frase maior
    setLang('pt-BR');
    expect(t('toast.dirStats', { total: 9, files: 5, thumbs: 2 })).toBe(
      '9 itens · 5 arquivos · 2 thumbs',
    );
  });

  it('pt-BR é o padrão; setLang troca o idioma ativo', () => {
    expect(getLang()).toBe('pt-BR');
    expect(t('menu.delete')).toBe('Excluir');
    setLang('en');
    expect(getLang()).toBe('en');
    expect(t('menu.delete')).toBe('Delete');
  });

  it('idioma inválido cai no pt-BR (fallback)', () => {
    setLang('en');
    setLang('xx-YY');
    expect(getLang()).toBe('pt-BR');
    expect(t('ui.save')).toBe('Salvar');
  });

  it('chave desconhecida devolve a própria chave (buraco visível em dev)', () => {
    expect(t('nao.existe')).toBe('nao.existe');
  });

  it('textos-chave do P0 existem nos dois idiomas', () => {
    for (const lang of langs()) {
      setLang(lang);
      expect(t('menu.gridView'), lang).not.toBe('menu.gridView');
      expect(t('menu.duplicate'), lang).not.toBe('menu.duplicate');
      expect(t('toast.scaleMax'), lang).not.toBe('toast.scaleMax');
      expect(t('hint.scaleUp'), lang).not.toBe('hint.scaleUp');
      expect(t('ui.resetCamera'), lang).not.toBe('ui.resetCamera');
    }
    setLang('pt-BR');
    expect(t('toast.scaleMax')).toBe('Não dá para aumentar mais! Não cabe na área de trabalho.');
  });
});
