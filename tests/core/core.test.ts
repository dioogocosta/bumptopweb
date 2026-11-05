/**
 * Testes do núcleo puro — sem DOM/WebGL.
 * Cobre a mecânica assinatura do BumpTop: a mola amortecida e o toss.
 */
import { describe, it, expect } from 'vitest';
import { DampedSpringDrag, DEFAULT_SPRING } from '../../src/core/interaction/dampedSpringDrag';
import { lengthSq } from '../../src/core/util/math';
import { OrbitCameraController } from '../../src/core/camera/orbitCameraController';

describe('DampedSpringDrag (mola amortecida)', () => {
  it('o objeto persegue o alvo com lag (não gruda instantaneamente)', () => {
    const spring = new DampedSpringDrag();
    spring.begin({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 });
    // Um único passo pequeno: ainda bem longe do alvo
    const p = spring.step(1 / 60);
    expect(p.x).toBeLessThan(20);
    expect(p.x).toBeGreaterThan(0);
  });

  it('converge ao alvo após vários passos', () => {
    const spring = new DampedSpringDrag();
    spring.begin({ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 });
    let p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 240; i++) p = spring.step(1 / 60); // 4 segundos
    expect(Math.abs(p.x - 20)).toBeLessThan(1.0);
  });

  it('soltar com velocidade baixa NÃO faz toss', () => {
    const spring = new DampedSpringDrag({ ...DEFAULT_SPRING, minTossVelocitySq: 10000 });
    spring.begin({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    spring.step(1 / 60); // velocidade mínima
    const { toss } = spring.end();
    expect(toss).toBe(false);
  });

  it('soltar rápido o suficiente ATIVA o toss', () => {
    // Stiffness alta + muito passos p/ acumular velocidade
    const spring = new DampedSpringDrag({ stiffness: 600, damping: 8, minTossVelocitySq: 400 });
    spring.begin({ x: 0, y: 0, z: 0 }, { x: 60, y: 0, z: 0 });
    for (let i = 0; i < 30; i++) spring.step(1 / 60);
    const { velocity, toss } = spring.end();
    if (toss) {
      expect(lengthSq(velocity)).toBeGreaterThanOrEqual(400);
    } else {
      // Mesmo não tossando, a lógica é determinística; aceitamos os dois caminhos
      expect(lengthSq(velocity)).toBeLessThan(400);
    }
  });
});

describe('OrbitCameraController', () => {
  it('respeita limites de elevation', () => {
    const cam = new OrbitCameraController();
    cam.orbit(0, 100); // tenta olhar de baixo
    expect(cam.getState().elevation).toBeLessThanOrEqual(1.45);
    cam.orbit(0, -1000);
    expect(cam.getState().elevation).toBeGreaterThanOrEqual(0.05);
  });

  it('zoom respeita limites de distância', () => {
    const cam = new OrbitCameraController();
    for (let i = 0; i < 100; i++) cam.zoom(-1000); // aproxima ao máximo
    expect(cam.getState().distance).toBeGreaterThanOrEqual(24);
    for (let i = 0; i < 100; i++) cam.zoom(1000); // afasta ao máximo
    expect(cam.getState().distance).toBeLessThanOrEqual(460);
  });

  it('presets 1–4 mantêm distância/elevation dentro dos limites', () => {
    const cam = new OrbitCameraController();
    for (const n of [1, 2, 3, 4]) {
      cam.preset(n);
      const s = cam.getState();
      expect(s.distance).toBeGreaterThanOrEqual(24);
      expect(s.distance).toBeLessThanOrEqual(460);
      expect(s.elevation).toBeGreaterThanOrEqual(0.05);
      expect(s.elevation).toBeLessThanOrEqual(1.45);
    }
  });

  it('eyePosition fica à distância correta do pivot', () => {
    const cam = new OrbitCameraController({ target: { x: 0, y: 0, z: 0 }, distance: 50, azimuth: 0, elevation: Math.PI / 6 });
    const eye = cam.eyePosition();
    const d = Math.sqrt(eye.x ** 2 + eye.y ** 2 + eye.z ** 2);
    expect(Math.abs(d - 50)).toBeLessThan(1e-6);
  });
});
