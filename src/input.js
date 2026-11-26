// input.js — keyboard + pointer-lock mouse state (from the web-slinger reference).
export class Input {
  constructor(domElement) {
    this.keys = new Set();
    this.yaw = Math.PI;
    this.pitch = -0.12;
    this.sensitivity = 0.0023;
    this.locked = false;
    this.rmb = false;
    this.justPressed = new Set();
    // [修复] 设置面板改键后立即失效映射缓存，不用刷新页面。
    window.addEventListener('mc:settings-changed', () => { this._kb = undefined; });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;            // OS auto-repeat would spam jumps/webs
      // [2026-11-20 审查修复 F-15] keyForward/Back/Left/Right/Jump/Sprint 之前没有
      // 消费端（改绑定无效）。在入口把绑定的 code 映射回默认键码，下游零改动。
      // ⚠️ 不能写 e.code = ...：KeyboardEvent.code 是只读 getter，赋值会抛 TypeError。
      const code = this._mapBind(e.code) || e.code;
      this.keys.add(code);
      this.justPressed.add(code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(this._mapBind(e.code) || e.code); });
    window.addEventListener('blur', () => this.keys.clear());

    domElement.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = Math.max(-1.25, Math.min(1.35, this.pitch));
    });
    domElement.addEventListener('mousedown', (e) => {
      if (e.button === 2) { this.rmb = true; this.justPressed.add('RMB'); }
      if (e.button === 0) this.justPressed.add('LMB');
    });
    domElement.addEventListener('mouseup', (e) => { if (e.button === 2) this.rmb = false; });
    domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement !== null;
      if (!this.locked) this.keys.clear();
    });
  }

  // [F-15] 读取设置里的按键重绑定，映射回默认键码
  _mapBind(code) {
    if (this._kb === undefined) {
      this._kb = {};
      try {
        const o = JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}');
        const D = { keyForward: 'KeyW', keyBack: 'KeyS', keyLeft: 'KeyA', keyRight: 'KeyD', keyJump: 'Space', keySprint: 'ShiftLeft' };
        for (const [k, def] of Object.entries(D)) if (o[k] && o[k] !== def) this._kb[o[k]] = def;
      } catch { this._kb = {}; }
    }
    return this._kb[code] || null;
  }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.justPressed.has(code); }
  endFrame() { this.justPressed.clear(); }

  // camera-relative movement vector from WASD, on the XZ plane
  moveVector(out) {
    let x = 0, z = 0;
    if (this.down('KeyW')) z += 1;
    if (this.down('KeyS')) z -= 1;
    if (this.down('KeyA')) x -= 1;
    if (this.down('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) { x /= len; z /= len; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    out.set(-sin * z + cos * x, 0, -cos * z - sin * x);
    return out;
  }
}
