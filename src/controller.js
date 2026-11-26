// controller.js — movement + web physics, adapted from the web-slinger reference.
// 2026-10-05 剥玩法改造：web-swing / wallrun / zip / dive 全部移除，仅保留
// 地面行走/奔跑/跳跃 + 空中滞落与碰撞（用户令：剥离原版玩法，保留城市漫游与
// 基础移动，为后续自研玩法腾出干净底座）。Semi-implicit Euler; raycast ground.
// Walls: AABB broad phase, but every push is VERIFIED against real geometry via
// castFn. Modes: ground | air.
import * as THREE from 'three';

const G_AIR = 30, G_SWING = 26;
const WALK = 8.5, SPRINT = 14;
const JUMP_V = 13;
const AIR_ACCEL = 14, AIR_MAX = 17;
const PUMP = 16, STEER = 9, REEL = 12;   // stronger pump/reel = higher arcs
const ZIP_SPEED = 40;
const MAX_SPEED = 68;
const R = 0.42, BODY_H = 1.7;
const STEP_H = 0.5;                 // ledges lower than this step up via ground snap

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _move = new THREE.Vector3();
const _o = new THREE.Vector3();     // ray origin scratch
const _rdir = new THREE.Vector3();  // ray direction scratch
const DOWN = new THREE.Vector3(0, -1, 0);

export class Controller {
  constructor(boxWorld, groundFn, castFn, events = {}) {
    this.bw = boxWorld;              // {aabbs, queryNearby}
    this.groundFn = groundFn;        // (x, z, yFrom) => groundY|null   (raycast on real geometry)
    this.castFn = castFn;            // (origin, dir, far) => {point, normal, distance}|null
    this.events = events;
    this.pos = new THREE.Vector3();
    this.prevY = 0;
    this.vel = new THREE.Vector3();
    this.mode = 'air';

    this.coyote = 0;
    this.airTime = 0;

    // last spot we stood on solid ground for a while — void-fall rescue target
    this.lastSafe = new THREE.Vector3();
    this.hasSafe = false;
    this.safeTimer = 0;
  }

  rescueTo(p) {
    this.pos.set(p.x, p.y + 0.5, p.z);
    this.prevY = this.pos.y;
    this.vel.set(0, 0, 0);
    this.mode = 'air';
    this.airTime = 0;
  }

  groundY() {
    return this.groundFn(this.pos.x, this.pos.z, this.pos.y + 3, this.pos.y);
  }

  hasSupport() {
    // real geometry only — groundFn multi-probes around the feet, which also
    // covers box-top standing (roofs are geometry too)
    const gh = this.groundY();
    return gh !== null && Math.abs(this.pos.y - gh) < 0.3;
  }

  update(dt, input, camYaw, camDir) {
    const { bw } = this;
    if (this.mode !== 'ground') this.safeTimer = 0;
    input.moveVector(_move);
    const space = input.down('Space');
    const spaceTap = input.pressed('Space');
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    const fwdHeld = input.down('KeyW');
    this.diving = false;
    this.steer = 0;

    _fwd.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));

    // ------------------------------------------------ ground
    if (this.mode === 'ground') {
      this.airTime = 0;
      this.safeTimer += dt;
      if (this.safeTimer > 0.5) {          // stood here a while — remember as rescue point
        this.lastSafe.copy(this.pos);
        this.hasSafe = true;
        this.safeTimer = 0;
      }
      const maxSp = shift ? SPRINT : WALK;
      const hsp = Math.hypot(this.vel.x, this.vel.z);
      const rate = hsp > SPRINT + 1 ? 2.2 : 10;      // preserve landing momentum
      const k = 1 - Math.exp(-rate * dt);
      this.vel.x += (_move.x * maxSp - this.vel.x) * k;
      this.vel.z += (_move.z * maxSp - this.vel.z) * k;
      this.vel.y = 0;

      if (spaceTap) {
        this.vel.y = JUMP_V + (shift ? 1.5 : 0);
        this.vel.x *= 1.06; this.vel.z *= 1.06;
        this.mode = 'air';
        this.coyote = 0;
        this.events.onJump?.();
      } else if (!this.hasSupport()) {
        this.coyote += dt;
        if (this.coyote > 0.12) this.mode = 'air';
      } else {
        this.coyote = 0;
      }
    }

    // ------------------------------------------------ air
    if (this.mode === 'air') {
      this.airTime += dt;
      this.vel.y -= G_AIR * dt;

      const hsp = Math.hypot(this.vel.x, this.vel.z);
      if (_move.lengthSq() > 0) {
        const cap = Math.max(AIR_MAX, hsp);
        this.vel.x += _move.x * AIR_ACCEL * dt;
        this.vel.z += _move.z * AIR_ACCEL * dt;
        const nh = Math.hypot(this.vel.x, this.vel.z);
        if (nh > cap) { const s = cap / nh; this.vel.x *= s; this.vel.z *= s; }
      }
      const sp = this.vel.length();
      const drag = 0.015 + 0.0016 * sp;
      this.vel.multiplyScalar(Math.max(0, 1 - drag * dt * 3));
    }

    const sp = this.vel.length();
    if (sp > MAX_SPEED) this.vel.multiplyScalar(MAX_SPEED / sp);

    // ------------------------------------------------ integrate
    this.prevY = this.pos.y;
    this.pos.addScaledVector(this.vel, dt);

    this.resolveCollisions(dt);
  }

  // ------------------------------------------------ collisions

  land(supportY) {
    const impact = -this.vel.y;
    this.pos.y = supportY;
    this.vel.y = 0;
    if (this.mode !== 'ground') {
      const hsp = Math.hypot(this.vel.x, this.vel.z);
      if (impact > 15 && hsp > 9) { this.vel.x *= 0.8; this.vel.z *= 0.8; }
      else if (impact > 15) { this.vel.x *= 0.35; this.vel.z *= 0.35; }
      if (this.webOn) this.detach();
      this.mode = 'ground';
      this.events.onLand?.(impact);
    }
  }

  resolveCollisions(dt) {
    // raycast ground (real geometry — streets, cars, slums, metro floors,
    // roofs; groundFn multi-probes so tile seams can't swallow the player).
    // Cast from the pre-integration height so a fast fall can't tunnel a roof.
    // high-altitude fast falls: if the last query found nothing, skip 2 frames
    // (ray reaches 11 m below the feet; worst-case advance between checks at
    // 68 m/s / 60 fps is ~3.4 m — plenty of margin, big saving during the dive)
    if (this._groundSkip > 0 && this.vel.y < -20 && this.pos.y > 40) {
      this._groundSkip--;
      return this.resolveWalls(dt);
    }
    const gh = this.groundFn(this.pos.x, this.pos.z,
                             Math.max(this.pos.y + 3, this.prevY + 0.3), this.pos.y);
    this._groundSkip = (gh === null && this.vel.y < -20 && this.pos.y > 40) ? 2 : 0;
    // land only when we actually crossed the surface from above this frame, or
    // it's a small step-up — otherwise walking/swinging UNDER a low canopy or
    // walkway teleports you onto its roof (the down-ray sees its top as "ground")
    if (gh !== null && this.pos.y < gh && this.vel.y <= 0 &&
        (this.prevY + 0.3 >= gh || gh - this.pos.y < 0.55)) {
      this.land(gh);
    }

    this.resolveWalls(dt);
  }

  resolveWalls(dt) {
    // swept rays along horizontal motion: real-geometry walls the boxes can't
    // represent (slum shacks, interior walls) + anti-tunneling at high speed.
    // THREE heights — a single chest ray let low rails and high beams clip
    const hsp = Math.hypot(this.vel.x, this.vel.z);
    if (hsp > 0.5 && dt > 0) {
      _rdir.set(this.vel.x / hsp, 0, this.vel.z / hsp);
      let hit = null;
      // chest ray EVERY frame (anti-tunneling); knee/head rays alternate frames
      // (rails & beams move slowly relative to us — 30 Hz coverage is plenty,
      // and tripling every-frame rays measurably hurt the step time)
      this._sweepPhase = !this._sweepPhase;
      const heights = this._sweepPhase ? [0.95, 0.35] : [0.95, 1.5];
      for (const hy of heights) {
        _o.set(this.pos.x - this.vel.x * dt, this.pos.y + hy, this.pos.z - this.vel.z * dt);
        const h = this.castFn(_o, _rdir, hsp * dt + R + 0.12);
        if (h && h.normal && (!hit || h.distance < hit.distance)) hit = h;
      }
      _o.set(this.pos.x - this.vel.x * dt, 0, this.pos.z - this.vel.z * dt);   // xz reference for pushback
      if (hit && hit.normal) {
        let nx = hit.normal.x, nz = hit.normal.z;
        const nh = Math.hypot(nx, nz);
        if (nh > 0.35) {                              // wall-ish, not a ramp/floor
          nx /= nh; nz /= nh;
          if (nx * _rdir.x + nz * _rdir.z > 0) { nx = -nx; nz = -nz; }
          const back = Math.max(0, hit.distance - R);
          this.pos.x = _o.x + _rdir.x * back;
          this.pos.z = _o.z + _rdir.z * back;
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; }
        }
      }
    }

    // AABB broad phase; every push is VERIFIED against real geometry, so an
    // oversized box (L-shaped tower, spanning prop) can't become an air wall
    const ids = this.bw.queryNearby(this.pos.x, this.pos.z, 3);
    for (const idx of ids) {
      const b = this.bw.aabbs[idx];
      if (!b.collide) continue;
      if (b.y1 - this.pos.y < STEP_H) continue;       // steppable — ground snap raises us
      if (this.pos.y + BODY_H <= b.y0) continue;
      const inX = this.pos.x > b.x0 - R && this.pos.x < b.x1 + R;
      const inZ = this.pos.z > b.z0 - R && this.pos.z < b.z1 + R;
      if (!inX || !inZ) continue;

      const px0 = this.pos.x - (b.x0 - R);
      const px1 = (b.x1 + R) - this.pos.x;
      const pz0 = this.pos.z - (b.z0 - R);
      const pz1 = (b.z1 + R) - this.pos.z;
      const m = Math.min(px0, px1, pz0, pz1);
      let nx = 0, nz = 0;
      if (m === px0) nx = -1;
      else if (m === px1) nx = 1;
      else if (m === pz0) nz = -1;
      else nz = 1;

      // verify the face is real: probe INTO the box at two heights; if neither
      // ray meets geometry within arm's reach, the box is hollow here — pass
      let real = false;
      for (const dy of [0.35, 1.35]) {
        const ry = THREE.MathUtils.clamp(this.pos.y + dy, b.y0 + 0.05, Math.max(b.y0 + 0.05, b.y1 - 0.05));
        _o.set(this.pos.x, ry, this.pos.z);
        _rdir.set(-nx, 0, -nz);
        if (this.castFn(_o, _rdir, R + 0.8)) { real = true; break; }
      }
      if (!real) continue;

      if (nx < 0) this.pos.x = b.x0 - R;
      else if (nx > 0) this.pos.x = b.x1 + R;
      else if (nz < 0) this.pos.z = b.z0 - R;
      else this.pos.z = b.z1 + R;

      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; }
    }
  }
}
