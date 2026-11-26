// lcr_bridge.js — 光锥光追系统 ⇆ NOVA 游戏 适配桥（六条契约的游戏侧实现）
//
// 设计原则（铁律）：
//   1. 光追是【增强层】，不是替换层。现有 WebGLRenderer + composer 光栅管线永远是底座。
//   2. 光追不可用时（无 WebGPU / -init 失败 / 设备丢失 / 任何异常）→ 静默降级，
//      mode='raster-fallback'，本模块变成空操作，游戏画面 100% 不变、绝不抛错。
//   3. 有 WebGPU 的真机上：光追在【独立 canvas】上出画（B 模式），
//      以叠加层方式盖在游戏画面之上；角色/相机/光照通过契约三同步。
//   4. 两套后端纹理不互通（WebGPU GPUTexture ≠ WebGLTexture），因此采用
//      【双 canvas 叠加】而非纹理回灌：光追 canvas 在下，游戏 canvas 在上做透明合成。
//      这样既拿到真光追，又不破坏角色/HUD/后处理。
//
// 契约映射：
//   一 数据入口：_toGeometryGroup() 把游戏 holder 转成 {buckets,userData}
//   二 生命周期：attach() 把 ChunkStream 的 onMount/onUnmount 同时接到光追
//   三 状态同步：每帧 syncCamera + setLightingPreset + setDynamicObjects
//   四 材质：光追侧自行加载 textures/real/facade_*_color.webp（已就位）
//   五 输出：outputMode='B'，光追自绘；游戏画布透明叠加（见 main.js 挂点）
//   六 降级：mode!=='webgpu-rt' 时全部 no-op

import { GameAdapter, RUN_MODE } from './lightcone_rt.js';

export class LCRBridge {
  constructor(opts = {}) {
    this.opts = opts;
    this.adapter = null;
    this.mode = RUN_MODE.RASTER_FALLBACK;
    this.ready = false;
    this.enabled = opts.enabled !== false;       // 总开关，默认开；关则永远降级
    this.canvas = opts.canvas || null;           // 光追专用叠加 canvas（独立）
    this.errors = [];
    this.stats = { mounts: 0, unmounts: 0, frames: 0, lastSample: 0 };
    this._scene = opts.scene || null;
    this._camera = opts.camera || null;
    this._preset = 'day';
    this._onMode = opts.onMode || (() => {});
  }

  /** 异步初始化；无论成功失败都不抛到调用方。 */
  async init() {
    if (!this.enabled) { this._onMode(this.mode, 'disabled'); return this; }
    try {
      this.adapter = await GameAdapter.create({
        canvas: this.canvas,
        outputMode: 'B',                          // 光追自绘到独立 canvas
        textureBaseUrl: './',
        onMode: (mode, reason) => this._setMode(mode, reason),
        onError: (e) => this._err('adapter', e),
      });
      this.mode = this.adapter.mode;
      this.ready = this.mode === RUN_MODE.WEBGPU_RT;
      this._onMode(this.mode, this.adapter.degradeReason);
      if (this.ready) {
        const tr = this.adapter.tracer;
        // 游戏合成层接管 tonemapping → 关掉光追自带 present 的额外 gamma（保持线性）
        if (tr && 'enablePresent' in tr) tr.enablePresent = true; // 独立 canvas 需要自绘
        this.adapter.setLightingPreset(this._preset);
      }
    } catch (e) {
      this._err('init', e);
      this._setMode(RUN_MODE.RASTER_FALLBACK, 'bridge-init-failed');
    }
    return this;
  }

  _setMode(mode, reason) {
    this.mode = mode;
    this.ready = mode === RUN_MODE.WEBGPU_RT;
    this._onMode(mode, reason);
  }

  _err(where, e) {
    const msg = `[LCR:${where}] ` + (e && e.message || String(e));
    this.errors.push(msg.slice(0, 200));
    if (this.errors.length > 20) this.errors.shift();
    if (this.ready) this._setMode(RUN_MODE.RASTER_FALLBACK, where + '-error');
  }

  get active() { return this.ready && this.mode === RUN_MODE.WEBGPU_RT && !!this.adapter; }

  // ---------- 契约一：几何转换 ----------
  // 游戏侧 _buildChunkMesh 产出 holder(THREE.Group)：
  //   holder.children = [Mesh(bucket0), Mesh(bucket1), Mesh(bucket2)]（缺桶跳过）
  //   holder.userData = {key, triangles, verts, buildings}
  // manifest 里另有 {key,cx,cz,count,file}。
  // 光追要的是 {buckets:[G|null ×3], userData:{key,cx,cz,count,file}}。
  _toGeometryGroup(key, holder, manifestEntry) {
    const buckets = [null, null, null];
    // 游戏侧 mesh.userData.band = 桶号（0/1/2）
    for (const ch of (holder.children || [])) {
      const band = ch.userData && Number.isInteger(ch.userData.band) ? ch.userData.band : -1;
      if (band >= 0 && band < 3 && ch.geometry) buckets[band] = ch.geometry;
    }
    // 没写 band 时按顺序兜底
    if (buckets.every(b => !b)) {
      let i = 0;
      for (const ch of (holder.children || [])) { if (i < 3 && ch.geometry) buckets[i++] = ch.geometry; }
    }
    const c = manifestEntry || {};
    const [ix, iz] = String(key).split(',').map(Number);
    // 契约强制 userData.cx/cz === key 解析出的整数索引（validateChunkUserData 校验），
    // 不能用 manifest 里的浮点世界坐标（那是块中心，会校验失败）。
    return {
      buckets,
      userData: {
        key,
        cx: ix,
        cz: iz,
        count: Math.max(1, c.count || (holder.userData && holder.userData.buildings) || 1),
        file: c.file || ('urban_chunks/' + key + '.json'),
      },
    };
  }

  // ---------- 契约二：生命周期（由 main/miami_layer 调用） ----------
  mount(key, holder, manifestEntry) {
    if (!this.active) return;
    try {
      const gg = this._toGeometryGroup(key, holder, manifestEntry);
      const r = this.adapter.mount(key, gg, ['stucco', 'mixed', 'glass']);
      if (r && r.ok) this.stats.mounts++;
      else if (r && !r.ok) this.errors.push(`[LCR:mount ${key}] ${r.reason || 'fail'}`);
    } catch (e) { this._err(`mount ${key}`, e); }
  }

  unmount(key) {
    if (!this.active) return;
    try { this.adapter.unmount(key); this.stats.unmounts++; }
    catch (e) { this._err(`unmount ${key}`, e); }
  }

  // ---------- 契约三：每帧状态同步 ----------
  syncCamera(camera) {
    if (!this.active || !camera) return;
    try { this.adapter.syncCamera(camera); } catch (e) { this._err('syncCamera', e); }
  }

  setLightingPreset(name) {
    this._preset = name;
    if (!this.active) return;
    try { this.adapter.setLightingPreset(name); } catch (e) { this._err('preset', e); }
  }

  /** 动态对象（角色）：从 THREE.Group 的世界坐标取代理椭球位置。 */
  syncPlayer(playerGroup) {
    if (!this.active || !playerGroup) return;
    try {
      const p = playerGroup.position;
      this.adapter.setDynamicObjects([{ translation: [p.x, p.y + 0.95, p.z], radius: [0.42, 0.95, 0.42] }]);
    } catch (e) { this._err('player', e); }
  }

  // ---------- 主循环：每帧调用（menu/play 均可，降级时零开销） ----------
  render(dt) {
    if (!this.active) return null;
    try {
      if (this._camera) this.syncCamera(this._camera);
      const r = this.adapter.render(dt);
      this.stats.frames++;
      if (r && typeof r.sampleCount === 'number') this.stats.lastSample = r.sampleCount;
      return r;
    } catch (e) { this._err('render', e); return null; }
  }

  /** 调试面板数据（沿用 __novaState 风格） */
  state() {
    return {
      brand: 'LCR.bridge',
      mode: this.mode,
      active: this.active,
      ready: this.ready,
      preset: this._preset,
      ...this.stats,
      errors: this.errors.slice(-5),
      adapter: this.active ? this.adapter.stats() : null,
    };
  }

  dispose() {
    try { this.adapter && this.adapter.dispose(); } catch (_) {}
    this.adapter = null; this.ready = false;
    this.mode = RUN_MODE.RASTER_FALLBACK;
  }
}

export default LCRBridge;
