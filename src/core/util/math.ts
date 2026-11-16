/** Utilitários matemáticos puros. Sem dependências. */
import type { Quat, Vec3 } from '../model/types';

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-8 ? scale(a, 1 / l) : vec3();
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const identityQuat = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/** Aplica a rotação do quaternion `q` ao vetor `v` (v' = q * v * q⁻¹). */
export const rotateVec3ByQuat = (v: Vec3, q: Quat): Vec3 => {
  // t = 2 * (q_v × v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

/** Sub-passo de integração de velocidade (usado no toss e no spring). */
export const integrate = (pos: Vec3, vel: Vec3, dt: number): Vec3 =>
  add(pos, scale(vel, dt));

/** Distância ao quadrado entre dois pontos. */
export const distSq = (a: Vec3, b: Vec3): number => lengthSq(sub(a, b));
