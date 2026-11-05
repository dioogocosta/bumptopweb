/**
 * Adapter de física — Rapier 3D (Rust → WASM).
 *
 * Implementa a porta `IPhysics`. Espelha o modelo do BumpTop (Novodex/PhysX):
 *  - Caixas dinâmicas ("ícones") num piso plano
 *  - Ícones NÃO colidem entre si (só com piso/paredes) — via collision groups
 *  - Gravidade "rápida" (10× -9.81)
 *  - Durante o drag, o corpo vira kinematic (segue a mola sem colidir)
 *  - Sleep optimization (corpos parados dormem → render condicional)
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type {
  BodyHandle,
  IPhysics,
  PhysicsConfig,
  Pose,
  RayHit,
  RoomConfig,
  Vec3,
} from '@core/ports/index';

// Grupos de colisão — replica DYNAMIC/FLOOR/WALL/ISOLATED do original.
const GROUP_DYNAMIC = 0x0001;
const GROUP_FLOOR = 0x0002;
const GROUP_WALL = 0x0004;

/** Rapier codifica membership (altos 16 bits) + filter (baixos 16 bits). */
const groups = (membership: number, filter: number): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

// Dynamic colide só com floor|wall (NUNCA com outro dynamic) — regra central.
const DYNAMIC_COLLIDES = groups(GROUP_DYNAMIC, GROUP_FLOOR | GROUP_WALL);
const FLOOR_COLLIDES = groups(GROUP_FLOOR, GROUP_DYNAMIC);
const WALL_COLLIDES = groups(GROUP_WALL, GROUP_DYNAMIC);

export class RapierPhysics implements IPhysics {
  private world!: RAPIER.World;
  private bodies = new Map<BodyHandle, RAPIER.RigidBody>();
  private nextHandle = 1;
  private config!: PhysicsConfig;

  async init(config: PhysicsConfig, _room: RoomConfig): Promise<void> {
    await RAPIER.init();
    this.config = config;
    this.world = new RAPIER.World({ x: 0, y: config.gravityY, z: 0 });
    // Timestep fixo — o main loop chama step(dt) explicitamente
    this.world.timestep = 1 / 60;
  }

  createRoom(room: RoomConfig): void {
    const { halfSize, wallHeight, wallThickness } = room;
    const f = this.config.friction;
    const r = this.config.restitution;

    // Piso (plano estático grande)
    const floorBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize * 4, 0.5, halfSize * 4)
        .setFriction(f)
        .setRestitution(r)
        .setCollisionGroups(FLOOR_COLLIDES),
      floorBody,
    );

    // 4 paredes estáticas (N/S/E/O)
    const wallDefs: Array<{ pos: Vec3; half: Vec3 }> = [
      { pos: { x: 0, y: wallHeight / 2, z: -halfSize }, half: { x: halfSize, y: wallHeight / 2, z: wallThickness / 2 } },
      { pos: { x: 0, y: wallHeight / 2, z: halfSize }, half: { x: halfSize, y: wallHeight / 2, z: wallThickness / 2 } },
      { pos: { x: -halfSize, y: wallHeight / 2, z: 0 }, half: { x: wallThickness / 2, y: wallHeight / 2, z: halfSize } },
      { pos: { x: halfSize, y: wallHeight / 2, z: 0 }, half: { x: wallThickness / 2, y: wallHeight / 2, z: halfSize } },
    ];
    for (const w of wallDefs) {
      const b = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(w.pos.x, w.pos.y, w.pos.z),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(w.half.x, w.half.y, w.half.z)
          .setFriction(f)
          .setRestitution(r)
          .setCollisionGroups(WALL_COLLIDES),
        b,
      );
    }
  }

  createBox(id: string, position: Vec3, halfExtents: Vec3): BodyHandle {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .enabledRotations(false, true, false)
        .setCanSleep(true)
        .setLinearDamping(0.4)
        .setAngularDamping(1.2),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setFriction(this.config.friction)
        .setRestitution(this.config.restitution)
        .setCollisionGroups(DYNAMIC_COLLIDES),
      body,
    );
    const handle = this.nextHandle++ as BodyHandle;
    this.bodies.set(handle, body);
    // `id` é usado pelo core p/ correlacionar; aqui o handle basta.
    void id;
    return handle;
  }

  removeBody(handle: BodyHandle): void {
    const b = this.bodies.get(handle);
    if (b) {
      this.world.removeRigidBody(b);
      this.bodies.delete(handle);
    }
  }

  getPose(handle: BodyHandle): Pose {
    const b = this.bodies.get(handle)!;
    const t = b.translation();
    const r = b.rotation();
    return { position: { x: t.x, y: t.y, z: t.z }, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  getVelocity(handle: BodyHandle): Vec3 {
    const v = this.bodies.get(handle)!.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }

  setPosition(handle: BodyHandle, p: Vec3): void {
    this.bodies.get(handle)!.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  }

  setRotation(handle: BodyHandle, q: Pose['rotation']): void {
    this.bodies.get(handle)!.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  setVelocity(handle: BodyHandle, v: Vec3): void {
    this.bodies.get(handle)!.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  }

  applyImpulse(handle: BodyHandle, impulse: Vec3): void {
    this.bodies.get(handle)!.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
  }

  /** Congela (kinematic p/ drag) ou devolve ao mundo dinâmico. */
  setFrozen(handle: BodyHandle, frozen: boolean): void {
    const b = this.bodies.get(handle)!;
    const type = frozen
      ? RAPIER.RigidBodyType.KinematicPositionBased
      : RAPIER.RigidBodyType.Dynamic;
    b.setBodyType(type, true);
    if (!frozen) b.wakeUp();
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z },
    );
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true);
    if (!hit) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    return {
      body: hit.collider.handle as unknown as BodyHandle,
      point: { x: point.x, y: point.y, z: point.z },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      distance: hit.timeOfImpact,
    };
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  isSleeping(handle: BodyHandle): boolean {
    return this.bodies.get(handle)!.isSleeping();
  }

  dispose(): void {
    this.world.free();
    this.bodies.clear();
  }
}
