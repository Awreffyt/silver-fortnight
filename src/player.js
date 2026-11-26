// player.js — character visual layer: Survivors skin + animation state mapping
// driven by the Controller. All physics lives in controller.js.
// 2026-10-05 剥玩法改造：摆荡动画映射与蛛丝绳渲染整体移除（保留
// idle/walk/run/sprint/jump/fall/land 全套基础移动动画）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const dracoLoader = new DRACOLoader().setDecoderPath('../../vendor/draco/');

// Keep only rotation tracks (+ pelvis position): scale tracks and the other
// constant rest-offset position tracks fight the rig.
function cleanClip(clip) {
  clip.tracks = clip.tracks.filter(tr => {
    const dot = tr.name.lastIndexOf('.');
    const bone = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
    if (prop === 'scale') return false;
    if (prop === 'position' && bone !== 'pelvis') return false;
    return true;
  });
  return clip;
}

const TRAVERSAL_CLIPS = {
  idle: 'Movement_Idle',
  walk: 'Movement_Walk_Forward',
  run: 'Movement_Run_Forward',
  jumpRun: 'Movement_Jump_fromRun_toRun',
  jumpLoop: 'Movement_Jump_InPlace_Loop',
  landSoft: 'Movement_Jump_InPlace_Landing',
  landRoll: 'Movement_Landing_Roll_toRun',
  fall: 'BarSwing_ForwardAcross_SwingJump_FallingLoop',
};
const STRIP_PELVIS_POS = new Set(['fall', 'jumpLoop', 'landRoll']);

export class Player {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mixer = null;
    this.actions = {};
    this.cur = null;
    this.yaw = Math.PI;
    this.bones = {};
    this.landTimer = 0;

  }

  async load(gender, matFactory, manager) {
    const loader = new GLTFLoader(manager || undefined).setDRACOLoader(dracoLoader);
    const gltf = await loader.loadAsync(`./chars/glb/${gender}.glb`);
    this.model = gltf.scene;
    this.model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.material = matFactory(o.material?.name);
        o.frustumCulled = false;
      }
      if (o.isBone) this.bones[o.name] = o;
    });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);

    const clips = {};
    for (const [key, file] of Object.entries(TRAVERSAL_CLIPS)) {
      const g = await loader.loadAsync(`./chars/anims/${file}.glb`);
      const clip = g.animations[0];
      if (!clip) { console.warn('no anim in', file); continue; }
      cleanClip(clip);
      if (STRIP_PELVIS_POS.has(key))
        clip.tracks = clip.tracks.filter(t => t.name !== 'pelvis.position');
      clips[key] = clip;
    }
    // sprint = the run clip at a higher tempo. The pack has no UE4-native
    // sprint; the MovementAnimsetPro one is on a Mixamo rig whose joint
    // frames don't match this skeleton — a name-only track remap tilts and
    // deforms the body (true retargeting needs bind-pose deltas).
    if (clips.run) {
      const c = clips.run.clone();
      c.name = 'SprintFromRun';
      clips.sprint = c;
    }
    for (const [key, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.clampWhenFinished = true;
      if (key === 'sprint') a.timeScale = 1.3;   // 11 m/s stride cadence -> ~14 m/s
      this.actions[key] = a;
    }
    this.play('idle', 0);
  }

  play(key, fade = 0.25, loop = true) {
    const a = this.actions[key];
    if (!a || this.cur === a) return;
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (this.cur && fade > 0) this.cur.crossFadeTo(a, fade, false);
    a.play();
    this.cur = a;
  }

  onLand(impact) {
    if (impact > 15) {
      this.play('landRoll', 0.08, false);
      this.landTimer = 1.15;
    } else if (impact > 5) {
      this.play('landSoft', 0.1, false);
      this.landTimer = 0.45;
    }
  }

  // ---------- visual update driven by controller ----------
  update(ctx) {
    const { dt, mode, pos, vel } = ctx;
    this.group.position.copy(pos);

    // facing: along horizontal velocity (smoothed)
    const hsp = Math.hypot(vel.x, vel.z);
    if (hsp > 1.2) {
      const target = Math.atan2(vel.x, vel.z);
      let d = (target - this.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * 10);
    }
    this.group.rotation.y = this.yaw;

    // animation mapping
    if (this.landTimer > 0) {
      this.landTimer -= dt;
    } else if (mode === 'ground') {
      this.play(hsp < 0.6 ? 'idle' : hsp < 6 ? 'walk' : hsp < 11 ? 'run' : 'sprint');
    } else if (mode === 'air') {
      this.play(vel.y > 1.5 ? 'jumpLoop' : 'fall', 0.3);
    }
    this.mixer.update(dt);
  }
}
