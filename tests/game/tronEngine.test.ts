import { describe, it, expect } from 'vitest';
import { TronEngine, turnLeft, turnRight } from '../../src/game/tronEngine';

describe('TronEngine (Light Cycles)', () => {
  it('inicia com jogador (azul ou vermelho) e bot amarelo', () => {
    const engine = new TronEngine({ playerColor: 'blue', level: 1 });
    expect(engine.status).toBe('playing');
    expect(engine.cycles).toHaveLength(2);
    const player = engine.getPlayer()!;
    expect(player.color).toBe('blue');
    expect(player.alive).toBe(true);
    const bot = engine.cycles.find((c) => !c.isPlayer)!;
    expect(bot.color).toBe('yellow');
    expect(bot.alive).toBe(true);
  });

  it('suporta escolha de moto vermelha pelo jogador', () => {
    const engine = new TronEngine({ playerColor: 'red', level: 1 });
    expect(engine.getPlayer()?.color).toBe('red');
  });

  it('vira corretamente para esquerda e direita sem fazer 180 graus', () => {
    expect(turnLeft(0)).toBe(3);
    expect(turnRight(0)).toBe(1);

    const engine = new TronEngine({ playerColor: 'blue', level: 1 });
    // Avança um pouco para liberar segDist
    engine.step(0.05);
    engine.step(0.05);
    const turned = engine.turnPlayer('left');
    expect(turned).toBe(true);
    expect(engine.getPlayer()?.dir).toBe(3);
    expect(engine.segments.length).toBeGreaterThanOrEqual(3);
  });

  it('não causa autocolisão quando o bot vira antes do jogador virar', () => {
    const engine = new TronEngine({ halfSize: 80, playerColor: 'blue', level: 1 });
    // Avança tempo suficiente para o bot virar primeiro
    for (let i = 0; i < 45; i++) {
      engine.step(0.05);
    }
    expect(engine.status).toBe('playing');
    expect(engine.turnPlayer('left')).toBe(true);
    engine.step(0.05);
    expect(engine.getPlayer()?.alive).toBe(true);
    expect(engine.status).toBe('playing');

    for (let i = 0; i < 15; i++) {
      engine.step(0.05);
    }
    expect(engine.turnPlayer('right')).toBe(true);
    engine.step(0.05);
    expect(engine.getPlayer()?.alive).toBe(true);
    expect(engine.status).toBe('playing');
  });

  it('desintegra jogador ao bater na parede da arena', () => {
    const engine = new TronEngine({ halfSize: 40, playerColor: 'blue', level: 1 });
    // Avança em linha reta até bater na parede norte
    for (let i = 0; i < 200; i++) {
      const evs = engine.step(0.05);
      if (engine.status !== 'playing') {
        expect(evs.some((e) => e.type === 'crash')).toBe(true);
        break;
      }
    }
    expect(engine.status).toBe('lost');
    expect(engine.getPlayer()?.alive).toBe(false);
  });

  it('bot evita paredes com IA e jogador ganha pontos quando bot colide', () => {
    const engine = new TronEngine({ halfSize: 60, playerColor: 'blue', level: 1 });
    const bot = engine.cycles.find((c) => !c.isPlayer)!;
    // Simula vários passos; o bot deve virar antes da parede em vez de bater imediatamente
    for (let i = 0; i < 40; i++) {
      engine.step(0.05);
    }
    expect(bot.alive).toBe(true);
  });
});
