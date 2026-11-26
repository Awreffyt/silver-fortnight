// cameraRig.js — third-person cinematic camera:
// orbit, speed-reactive FOV/distance, velocity look-ahead, air banking,
// AABB occlusion pull-in.（2026-10-05 剥玩法：swing/zip 自动偏航已移除）
import * as THREE from 'three';
import { segmentAABB } from './cityBoxes.js?v=a7t';

const _look = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lat = new THREE.Vector3();

/** 宽画幅时收窄纵向 FOV 的比例系数（保持水平视角恒定） */
const BASE_ASPECT = 16 / 9;
const REF_FOV = 62;
export function aspectFovScale(aspect) {
  const a = aspect || BASE_ASPECT;
  // [2026-11-16a5] 竖屏：横向视角被压到 39°，贴墙走几乎看不到街道 →
  // 纵向 FOV 放大到 88°（62×1.42）补偿；横屏仍按原来的锁水平视角逻辑。
  if (a < 1) return Math.min(1.42, Math.max(1.0, 0.65 / a));
  if (!(a > BASE_ASPECT)) return 1;                 // 窄画幅保持原样
  const hFov = 2 * Math.atan(Math.tan(REF_FOV * Math.PI / 360) * BASE_ASPECT);
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / a);
  return Math.max(0.70, Math.min(1, (vFov * 180 / Math.PI) / REF_FOV));
}

export class CameraRig {
  constructor(camera, boxWorld) {
    this.camera = camera;
    this.bw = boxWorld;
    this.smoothLook = new THREE.Vector3();
    this.dist = 5;
    this.collT = 1;
    this.fov = camera.fov;
    this.roll = 0;
    this.initialized = false;

    // cinematic hand-off: blend from an external camera pose (the aerial menu
    // shot) into the rig's own framing over a short window
    this.fromPos = new THREE.Vector3();
    this.fromQuat = new THREE.Quaternion();
    this.blendT = 0;
    this.blendDur = 1;
  }

  blendFrom(camera, dur = 1.5) {
    this.fromPos.copy(camera.position);
    this.fromQuat.copy(camera.quaternion);
    this.blendT = this.blendDur = dur;
  }

  forward(out, input) {
    const cp = Math.cos(input.pitch), sp = Math.sin(input.pitch);
    const cy = Math.cos(input.yaw), sy = Math.sin(input.yaw);
    return out.set(-sy * cp, sp, -cy * cp);
  }

  update(dt, input, ctrl) {
    const cam = this.camera;
    const speed = ctrl.vel.length();
    const speedN = Math.min(1, speed / 52);

    _look.copy(ctrl.pos);
    _look.y += 1.35;
    _lat.copy(ctrl.vel).multiplyScalar(0.16);
    if (_lat.length() > 4.5) _lat.setLength(4.5);
    _look.add(_lat);
    if (!this.initialized) {
      this.smoothLook.copy(_look);
      this.initialized = true;
    }
    this.smoothLook.lerp(_look, 1 - Math.exp(-11 * dt));

    this.forward(_dir, input);

    let targetDist = 4.2 + speedN * 3.6;
    this.dist += (targetDist - this.dist) * (1 - Math.exp(-4 * dt));

    _desired.copy(this.smoothLook).addScaledVector(_dir, -this.dist);

    // occlusion: snap in, ease back out
    // [2026-11-16a5] 实机录屏：竖屏贴墙走时整屏发黑——旧实现 boom 下限 1.7m，
    // 墙离玩家不足 1.7m 时相机被塞进墙体内部（背面剔除 → 看到墙内一片黑）。
    // 现在允许吊臂收到肩位；收得太近时自动隐藏角色（近似第一人称），
    // 否则屏幕上只剩后脑勺。两条加起来保证「永远不会整屏黑」。
    let t = 1;
    const ids = this.bw.queryNearby(this.smoothLook.x, this.smoothLook.z, this.dist + 12);
    for (const idx of ids) {
      const b = this.bw.aabbs[idx];
      if (!b.collide) continue;
      const hit = segmentAABB(this.smoothLook, _desired, b, 0.28);
      if (hit < t) t = hit;
    }
    if (t < this.collT) this.collT = t;
    else this.collT += (t - this.collT) * (1 - Math.exp(-3.5 * dt));
    const boom = Math.max(0.45, this.dist * this.collT * 0.97);
    if (this.avatar) this.avatar.visible = boom > 1.5;
    _desired.copy(this.smoothLook).addScaledVector(_dir, -boom);
    if (_desired.y < 0.6) _desired.y = 0.6;
    cam.position.copy(_desired);

    cam.lookAt(this.smoothLook);

    let targetRoll = 0;
    if (ctrl.mode === 'air') {
      const rightX = Math.cos(input.yaw), rightZ = -Math.sin(input.yaw);
      const lat = ctrl.vel.x * rightX + ctrl.vel.z * rightZ;
      targetRoll = THREE.MathUtils.clamp(-lat * 0.0035, -0.10, 0.10);
    }
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-5 * dt));
    cam.rotateZ(this.roll);

    // 锁定水平 FOV：宽画幅（横屏/旋转态）时等比收窄纵向视角，
    // 否则 62° 纵向视角在 2.16 宽高比下会被拉成 120°+ 的鱼眼，画面变形、角色被压小。
    const targetFov = (62 + speedN * 17) * aspectFovScale(cam.aspect);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-4.5 * dt));
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    // menu → dive hand-off: ease from the stored pose into the rig's framing
    if (this.blendT > 0) {
      this.blendT = Math.max(0, this.blendT - dt);
      const k = this.blendT / this.blendDur;       // 1 → 0
      const e = k * k * (3 - 2 * k);               // smooth both ends
      cam.position.lerp(this.fromPos, e);
      cam.quaternion.slerp(this.fromQuat, e);
    }
  }
}
