/**
 * Controlador de câmera — port do `BT_Camera.cpp`.
 *
 * A câmera do BumpTop NÃO é free-fly: é uma sala vista em perspectiva com
 * órbita RESTRITA (só rotaciona o "piso"), zoom e pan. Espelha os presets e
 * o comportamento de zoom-nas-paredes do original.
 *
 * Puro — recebe entradas semânticas (zoom/pan/drag de órbita).
 */
import type { CameraState, Vec3 } from '../model/types';
import { clamp, lerp, vec3 } from '../util/math';

const MIN_ELEVATION = 0.05; // nunca olha de baixo do piso
const MAX_ELEVATION = 1.45; // quase top-down
const MIN_DISTANCE = 24;
const MAX_DISTANCE = 460; // sala ~130 de meia-distância
const PAN_BOUNDS = 140; // limita o pan dentro da sala

export class OrbitCameraController {
  private state: CameraState;

  constructor(initial?: Partial<CameraState>) {
    this.state = {
      target: initial?.target ?? vec3(0, 0, -10),
      distance: initial?.distance ?? 210,
      azimuth: initial?.azimuth ?? 0,
      elevation: initial?.elevation ?? 1.08,
      fov: initial?.fov ?? 48,
    };
  }

  getState(): CameraState {
    return {
      target: { ...this.state.target },
      distance: this.state.distance,
      azimuth: this.state.azimuth,
      elevation: this.state.elevation,
      fov: this.state.fov,
    };
  }

  setState(s: CameraState): void {
    this.state = {
      target: { ...s.target },
      distance: clamp(s.distance, MIN_DISTANCE, MAX_DISTANCE),
      azimuth: s.azimuth,
      elevation: clamp(s.elevation, MIN_ELEVATION, MAX_ELEVATION),
      fov: s.fov,
    };
  }

  /** Órbita (arrastar com botão direito / 2 dedos no mobile). */
  orbit(dAzimuth: number, dElevation: number): void {
    this.state.azimuth += dAzimuth;
    this.state.elevation = clamp(this.state.elevation + dElevation, MIN_ELEVATION, MAX_ELEVATION);
  }

  /** Zoom (wheel / pinch). Delta negativo aproxima. */
  zoom(delta: number): void {
    const factor = Math.exp(delta * 0.001);
    this.state.distance = clamp(this.state.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Pan do pivot (limitado à sala). */
  pan(dx: number, dy: number): void {
    const sin = Math.sin(this.state.azimuth);
    const cos = Math.cos(this.state.azimuth);
    // Pan relativo à orientação da câmera
    this.state.target.x = clamp(this.state.target.x + (dx * cos - dy * sin), -PAN_BOUNDS, PAN_BOUNDS);
    this.state.target.z = clamp(this.state.target.z + (dx * sin + dy * cos), -PAN_BOUNDS, PAN_BOUNDS);
  }

  /** Interpola suave até um preset (transições de "parede" do original). */
  moveTo(target: Vec3, distance: number, azimuth: number, elevation: number, t: number): void {
    this.state.target = {
      x: lerp(this.state.target.x, target.x, t),
      y: lerp(this.state.target.y, target.y, t),
      z: lerp(this.state.target.z, target.z, t),
    };
    this.state.distance = lerp(this.state.distance, distance, t);
    this.state.azimuth = lerp(this.state.azimuth, azimuth, t);
    this.state.elevation = lerp(this.state.elevation, elevation, t);
  }

  /**
   * Presets de câmera (teclas 1–4), espelhando as vistas do BT_Camera:
   * 1=perspectiva padrão, 2=top-down, 3=parede sul, 4=parede leste.
   */
  preset(n: number): void {
    switch (n) {
      case 1:
        this.state.azimuth = 0;
        this.state.elevation = 1.08;
        this.state.distance = 210;
        this.state.target = vec3(0, 0, -10);
        break;
      case 2:
        this.state.elevation = MAX_ELEVATION - 0.05;
        this.state.azimuth = Math.PI;
        this.state.distance = 300;
        break;
      case 3:
        this.state.elevation = 0.45;
        this.state.azimuth = Math.PI;
        this.state.distance = 240;
        this.state.target = vec3(0, 14, 0);
        break;
      case 4:
        this.state.elevation = 0.45;
        this.state.azimuth = Math.PI / 2;
        this.state.distance = 240;
        this.state.target = vec3(0, 14, 0);
        break;
      default:
        break;
    }
    this.state.elevation = clamp(this.state.elevation, MIN_ELEVATION, MAX_ELEVATION);
    this.state.distance = clamp(this.state.distance, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Posição da câmera no mundo (derivada do pivot + distância + ângulos). */
  eyePosition(): Vec3 {
    const { target, distance, azimuth, elevation } = this.state;
    const cosEl = Math.cos(elevation);
    return {
      x: target.x + distance * cosEl * Math.sin(azimuth),
      y: target.y + distance * Math.sin(elevation),
      z: target.z + distance * cosEl * Math.cos(azimuth),
    };
  }
}
