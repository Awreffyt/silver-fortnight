// urban_full.js — 其余五层真实数据接入：地面轮廓 / 道路 / 路口许可 / 高程
// 全部来自全量导出（地块 596,654 / 分区 49,429 / 水体 12,149 /
// 道路 116,464 / 运河 1,357 / 路口 368,288 / 许可 238,089 / 高程 958×1077）
// 按块加载、离场释放，每块合并为一次 draw。
import * as THREE from 'three';

const Y_GROUND = 0.05, Y_LINE = 0.08, Y_POINT = 0.12;

function segsFromRings(rings, y, out) {
  for (const r of rings || []) {
    const p = r.pts;
    if (!p || p.length < 2) continue;
    for (let i = 0; i < p.length - 1; i++) {
      out.push(p[i][0], y, p[i][1], p[i + 1][0], y, p[i + 1][1]);
    }
  }
}
function segsFromPolyline(pts, y, out) {
  if (!pts || pts.length < 2) return;
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(pts[i][0], y, pts[i][1], pts[i + 1][0], y, pts[i + 1][1]);
  }
}

class Layer {
  constructor(scene, manifest, color, opts = {}) {
    this.scene = scene; this.manifest = manifest;
    this.base = opts.base || './data/';
    this.radius = opts.radius || 1500;
    this.color = color;
    this.maxChunks = opts.maxChunks || 60;
    this.groups = new Map(); this.byKey = new Map();
    this.loaded = new Set(); this.loading = new Set();
    this.files = new Map(); this.meshes = new Map();
    this.mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.16, depthWrite: false });
    this.stats = { loaded: 0, lines: 0, errors: 0 };
    for (const c of manifest.chunks || []) this.byKey.set(c.key, c);
  }
  _group(key) {
    let g = this.groups.get(key);
    if (!g) {
      const c = this.byKey.get(key); if (!c) return null;
      g = new THREE.Group(); g.name = 'full:' + key; g.visible = true;
      this.groups.set(key, g); this.scene.add(g);
    }
    return g;
  }
  _unload(key) {
    const m = this.meshes.get(key);
    if (m) { m.geometry.dispose(); m.parent && m.parent.remove(m); this.meshes.delete(key); }
    this.loaded.delete(key);
  }
  async load(key) {
    if (this.loaded.has(key) || this.loading.has(key)) return;
    const c = this.byKey.get(key); if (!c) return;
    this.loading.add(key);
    try {
      let d = this.files.get(c.file);
      if (!d) {
        this.files.set(c.file, fetch(this.base + c.file)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
        d = this.files.get(c.file);
      }
      const j = await d;
      const pack = j[key] || {};
      const pos = [];
      this.collect(pack, pos);
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.computeBoundingSphere();
        const mesh = new THREE.LineSegments(geo, this.mat);
        mesh.frustumCulled = true;
        const g = this._group(key); if (!g) { geo.dispose(); return; }
        g.add(mesh); this.meshes.set(key, mesh);
        this.stats.lines += pos.length / 6;
      }
      this.loaded.add(key); this.stats.loaded++;
    } catch (e) { this.stats.errors++; }
    finally { this.loading.delete(key); }
  }
  collect() { }
  _box(c) {
    const sp = this.manifest.chunkSize || 1000;
    const p = String(c.key).split(',');
    const x0 = (+p[0]) * sp, z0 = (+p[1]) * sp;
    return [x0, x0 + sp, z0, z0 + sp];
  }
  _d2(c, x, z) {
    const b = this._box(c);
    const dx = x < b[0] ? b[0] - x : (x > b[1] ? x - b[1] : 0);
    const dz = z < b[2] ? b[2] - z : (z > b[3] ? z - b[3] : 0);
    return dx * dx + dz * dz;
  }
  update(cam, radius = this.radius) {
    const r2 = radius * radius; const want = [];
    for (const c of this.manifest.chunks || []) {
      if (this._d2(c, cam.x, cam.z) <= r2) want.push(c.key);
    }
    want.sort((a, b) => this._d2(this.byKey.get(a), cam.x, cam.z) - this._d2(this.byKey.get(b), cam.x, cam.z));
    const keep = new Set(want.slice(0, this.maxChunks));
    for (const [k, g] of this.groups) { g.visible = keep.has(k); if (!keep.has(k)) this._unload(k); }
    return [...keep].filter(k => !this.loaded.has(k));
  }
}

/* [实体地面] 原实现把地块/水体只画成轮廓线 → 玩家脚下没有面，远看一层蓝膜。
   现在把真实地块三角化填成实体地面：地块之间的空隙＝真实街道网络，
   水体填深蓝＝比斯坎湾真正显形。规划分区线单独一层，默认关闭。 */
class GroundLayer extends Layer {
  constructor(scene, manifest, color, opts = {}) {
    super(scene, manifest, color, opts);
    this.radius = opts.radius || 1250;
    this.maxChunks = opts.maxChunks || 18;
    // [2026-11-27 地面显形] 264MB 真实地块数据此前被画成纯色块 MeshBasicMaterial(0x6f6d66),
    // 玩家脚下/远看都是一块灰板 —— 这正是"几百MB不如程序生成"的根因。换成实拍铺石贴图。
    const TL = new THREE.TextureLoader();
    const texPave = TL.load('./textures/real/acg_PavingStones070_Color.webp');
    texPave.wrapS = texPave.wrapT = THREE.RepeatWrapping;
    texPave.colorSpace = THREE.SRGBColorSpace;
    texPave.anisotropy = 4;
    this.matParcel = new THREE.MeshStandardMaterial({ map: texPave, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    this.matWater  = new THREE.MeshStandardMaterial({ color: 0x2f6d8a, roughness: 0.18, metalness: 0.1, side: THREE.DoubleSide, transparent: false });
    this.matZone   = new THREE.LineBasicMaterial({ color: 0x74b6ff, transparent: true, opacity: 0.34, depthWrite: false });
    this.planVisible = false;
    this.zMeshes = new Map();
    this.stats = { parcels: 0, water: 0, zoning: 0, loaded: 0, errors: 0 };
  }

  /* rings → 三角面（只收 3~96 点的地块，绝大多数是 4~12 点的矩形/多边形） */
  /* items = [{rings:[{pts:[[x,z],...]}]}]；每个 item 可能有多个环（洞），逐环三角化。 */
  _fill(items, y, pos, idx, maxPts = 2400) {
    let n = 0;
    for (const it of items || []) {
      for (const r of it.rings || []) {
        const p = r.pts;
        if (!p || p.length < 3 || p.length > maxPts) continue;
        const c = p.map(q => new THREE.Vector2(q[0], q[1]));
        if (c.length > 1 && c[0].distanceTo(c[c.length - 1]) < 0.5) c.pop();
        if (c.length < 3) continue;
        let tris = null;
        try { tris = THREE.ShapeUtils.triangulateShape(c, []); } catch (e) { continue; }
        if (!tris || !tris.length) continue;
        const base = pos.length / 3;
        for (const v of c) pos.push(v.x, y, v.y);
        for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
        n++;
      }
    }
    return n;
  }
  _mesh(pos, idx, mat, y) {
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nor = new Float32Array(pos.length);
    for (let i = 0; i < nor.length; i += 3) nor[i + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    // [2026-11-27 地面显形] 真实地块多边形此前无 uv → 贴图无法平铺。按世界 XZ 生成 uv,
    // 每 24m 一个贴图周期(与立面 48m 尺度一致的一半,地面颗粒更细)。
    const uv = new Float32Array((pos.length / 3) * 2);
    for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
      uv[j] = pos[i] / 24; uv[j + 1] = pos[i + 2] / 24;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = true;
    return m;
  }
  async load(key) {
    if (this.loaded.has(key) || this.loading.has(key)) return;
    const c = this.byKey.get(key); if (!c) return;
    this.loading.add(key);
    try {
      let d = this.files.get(c.file);
      if (!d) {
        this.files.set(c.file, fetch(this.base + c.file)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
        d = this.files.get(c.file);
      }
      const pack = (await d)[key] || {};
      const g = this._group(key); if (!g) { this.loaded.add(key); return; }

      const pp = [], pi = [], wp = [], wi = [];
      this.stats.parcels += this._fill(pack.parcel, Y_GROUND, pp, pi);
      /* 水体整块覆盖（每块 20+ 个 1km 级面），会把底板与街道全部糊成青色水面。
         关闭填充：海/湾交给地平线色，陆地由基底路面与地块承担。 */
      // this.stats.water += ... (已停用)

      const mp = this._mesh(pp, pi, this.matParcel);
      const mw = this._mesh(wp, wi, this.matWater);
      if (mp) { mp.renderOrder = 1; g.add(mp); }
      if (mw) { mw.renderOrder = 2; g.add(mw); }
      if (mp || mw) this.meshes.set(key, mp || mw);

      // 分区线（默认隐藏，一次开关全城切换）
      const zp = [], zi = [];
      for (const z of pack.zoning || []) segsFromRings(z.rings, Y_GROUND + 0.06, zp);
      this.stats.zoning += (pack.zoning || []).length;
      if (zp.length) {
        const zg = new THREE.BufferGeometry();
        zg.setAttribute('position', new THREE.Float32BufferAttribute(zp, 3));
        zg.computeBoundingSphere();
        const zm = new THREE.LineSegments(zg, this.matZone);
        zm.visible = this.planVisible;
        g.add(zm); this.zMeshes.set(key, zm);
      }
      this.loaded.add(key); this.stats.loaded++;
    } catch (e) { this.stats.errors++; }
    finally { this.loading.delete(key); }
  }
  _unload(key) {
    const z = this.zMeshes.get(key);
    if (z) { z.geometry.dispose(); z.parent && z.parent.remove(z); this.zMeshes.delete(key); }
    const g = this.groups.get(key);
    if (g) {
      for (const ch of [...g.children]) {
        if (ch.isMesh) { ch.geometry.dispose(); g.remove(ch); }
      }
    }
    this.meshes.delete(key); this.loaded.delete(key);
  }
  setPlan(on) {
    this.planVisible = !!on;
    for (const z of this.zMeshes.values()) z.visible = this.planVisible;
  }
}
class LineLayer extends Layer {
  constructor(scene, manifest, color, opts = {}) {
    super(scene, manifest, color, opts);
    this.mat = new THREE.LineBasicMaterial({ color: 0x4a5058, transparent: true, opacity: 0.75, depthWrite: false });
    this.stats = { lines: 0, loaded: 0, errors: 0 };
  }
  collect(pack, pos) {
    for (const r of pack.road || []) segsFromPolyline(r.pts, Y_LINE, pos);
    for (const c of pack.canal || []) segsFromPolyline(c.pts, Y_LINE + 0.01, pos);
  }
}

class PointLayer {
  constructor(scene, manifest, opts = {}) {
    this.scene = scene; this.manifest = manifest; this.base = opts.base || './data/';
    this.radius = opts.radius || 2000;
    this.groups = new Map(); this.files = new Map(); this.byKey = new Map();
    this.loaded = new Set(); this.loading = new Set(); this.meshes = new Map();
    this.maxChunks = opts.maxChunks || 24;
    this.matJ = new THREE.MeshBasicMaterial({ color: 0x9aa4ae });
    this.matP = new THREE.MeshBasicMaterial({ color: 0xd8b25a });
    this.geo = new THREE.BoxGeometry(2.2, 0.6, 2.2);
    this.stats = { junction: 0, permit: 0, loaded: 0, errors: 0 };
    for (const c of manifest.chunks || []) this.byKey.set(c.key, c);
  }
  _group(key) {
    let g = this.groups.get(key);
    if (!g) { const c = this.byKey.get(key); if (!c) return null;
      g = new THREE.Group(); g.name = 'pts:' + key; this.groups.set(key, g); this.scene.add(g); }
    return g;
  }
  _unload(key) {
    const arr = this.meshes.get(key) || [];
    for (const m of arr) { m.geometry.dispose && m.geometry.dispose(); m.parent && m.parent.remove(m); }
    this.meshes.delete(key); this.loaded.delete(key);
  }
  async load(key) {
    if (this.loaded.has(key) || this.loading.has(key)) return;
    const c = this.byKey.get(key); if (!c) return;
    this.loading.add(key);
    try {
      let d = this.files.get(c.file);
      if (!d) { this.files.set(c.file, fetch(this.base + c.file)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })); d = this.files.get(c.file); }
      const pack = (await d)[key] || {};
      const g = this._group(key); if (!g) return;
      const out = [];
      const mk = (arr, mat) => {
        if (!arr || !arr.length) return;
        const im = new THREE.InstancedMesh(this.geo, mat, arr.length);
        const m4 = new THREE.Matrix4();
        arr.forEach((p, i) => { m4.makeTranslation(p.x, Y_POINT, p.z); im.setMatrixAt(i, m4); });
        im.instanceMatrix.needsUpdate = true;
        im.frustumCulled = true;
        im.userData = { key, count: arr.length };
        g.add(im); out.push(im);
      };
      mk(pack.junction, this.matJ); mk(pack.permit, this.matP);
      this.stats.junction += (pack.junction || []).length;
      this.stats.permit += (pack.permit || []).length;
      if (out.length) this.meshes.set(key, out);
      this.loaded.add(key); this.stats.loaded++;
    } catch (e) { this.stats.errors++; }
    finally { this.loading.delete(key); }
  }
  _box(c) {
    const sp = this.manifest.chunkSize || 1000;
    const p = String(c.key).split(',');
    const x0 = (+p[0]) * sp, z0 = (+p[1]) * sp;
    return [x0, x0 + sp, z0, z0 + sp];
  }
  _d2(c, x, z) {
    const b = this._box(c);
    const dx = x < b[0] ? b[0] - x : (x > b[1] ? x - b[1] : 0);
    const dz = z < b[2] ? b[2] - z : (z > b[3] ? z - b[3] : 0);
    return dx * dx + dz * dz;
  }
  update(cam, radius = this.radius) {
    const r2 = radius * radius; const want = [];
    for (const c of this.manifest.chunks || []) {
      if (this._d2(c, cam.x, cam.z) <= r2) want.push(c.key);
    }
    const keep = new Set(want.slice(0, this.maxChunks));
    for (const [k, g] of this.groups) { g.visible = keep.has(k); if (!keep.has(k)) this._unload(k); }
    return [...keep].filter(k => !this.loaded.has(k));
  }
}


/* ---------------------------------------------------------------- 沥青路面层
   全量 116,464 条真实道路中心线（urban_lines）→ 条带网格。
   旧版只有 1px 的 LineBasicMaterial 灰线，实机上等于没有街道；这里把每条
   中心线扩成半宽 5.5m 的双向车道面，一次合批一个 draw。
   宽度是渲染参数（数据里没有路宽字段），如实标注，不冒充实测。 */
const ROAD_V = `
varying vec2 vUv;
varying vec3 vWorld;
attribute vec2 aUv;
void main(){
  vec4 wp = modelMatrix * vec4(position,1.0);
  vWorld = wp.xyz; vUv = aUv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ROAD_F = `
precision highp float;
uniform vec3 uSunColor, uSkyColor, uFogColor, uCam;
uniform float uFogDensity, uExposure;
varying vec2 vUv;
varying vec3 vWorld;
float h21(vec2 p){ vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
void main(){
  float u = vUv.x, v = vUv.y;
  vec3 c = vec3(0.060,0.064,0.070) + (h21(floor(vec2(u*180.0, v*2.0))) - 0.5) * 0.018;
  float edge = smoothstep(0.05,0.032,u) + smoothstep(0.95,0.968,u);
  float dash = step(0.5, fract(v/14.0));
  float center = smoothstep(0.020,0.010,abs(u-0.5)) * dash;
  vec3 lc = vec3(0.70,0.69,0.64);
  c = mix(c, lc, clamp(edge,0.0,1.0)*0.85);
  c = mix(c, lc, center*0.8);
  vec3 col = c * (uSkyColor*0.62 + uSunColor*0.34);
  float d = length(uCam - vWorld);
  col = mix(col, uFogColor, clamp(1.0 - exp(-pow(uFogDensity*d,2.0)),0.0,1.0));
  gl_FragColor = vec4(col*uExposure, 1.0);
}`;

class RoadLayer {
  constructor(scene, manifest, opts = {}) {
    this.scene = scene; this.base = opts.base || './data/';
    this.radius = opts.radius || 1400; this.maxChunks = opts.maxChunks || 40;
    this.groups = new Map(); this.byKey = new Map(); this.files = new Map();
    this.loaded = new Set(); this.loading = new Set(); this.meshes = new Map();
    this.stats = { chunks: 0, roads: 0, loaded: 0, errors: 0 };
    this.mat = new THREE.ShaderMaterial({
      vertexShader: ROAD_V, fragmentShader: ROAD_F,
      uniforms: {
        uSunColor: { value: new THREE.Color(0xfff2dd) },
        uSkyColor: { value: new THREE.Color(0xbcd6f5) },
        uFogColor: { value: new THREE.Color(0xa9bccd) },
        uCam: { value: new THREE.Vector3() },
        uFogDensity: { value: 0.0008 },
        uExposure: { value: 1.0 },
      },
    });
    for (const c of manifest.chunks || []) this.byKey.set(c.key, c);
    this.stats.chunks = this.byKey.size;
  }
  update(cam) {
    const want = [];
    const r2 = this.radius * this.radius;
    for (const c of this.byKey.values()) {
      const dx = c.cx - cam.x, dz = c.cz - cam.z;
      if (dx * dx + dz * dz > r2) continue;
      want.push([c.key, dx * dx + dz * dz]);
    }
    want.sort((a, b) => a[1] - b[1]);
    /* [2026-11-26 网络风暴修复] 旧代码对「半径内所有块」发请求（半径 1.4km 有
       150+ 块，每块一个 JSON），线上实测 errors 3 万+、请求互相挤占带宽，
       真正要看的近处道路反而排不上。只装最近 maxChunks 块。 */
    this.failed = this.failed || new Set();
    for (let i = 0; i < Math.min(this.maxChunks, want.length); i++) {
      const k = want[i][0];
      if (!this.loaded.has(k) && !this.loading.has(k) && !this.failed.has(k)) this.load(k);
    }
    const keep = new Set(want.slice(0, this.maxChunks).map(w => w[0]));
    for (const [k, g] of this.groups) {
      const on = keep.has(k);
      g.visible = on;
      if (!on && this.meshes.has(k)) this._unload(k);
      else if (!on) this.loaded.delete(k);
    }
    return want.filter(w => !this.loaded.has(w[0])).length;
  }
  async load(key) {
    const c = this.byKey.get(key); if (!c) return;
    this.loading.add(key);
    try {
      let d = this.files.get(c.file);
      if (!d) {
        this.files.set(c.file, fetch(this.base + c.file)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
        d = this.files.get(c.file);
      }
      const pack = (await d)[key] || {};
      const roads = pack.road || [];
      if (!roads.length) { this.loaded.add(key); return; }
      const pos = [], uv = [], idx = [];
      let vb = 0, n = 0;
      for (const r of roads) {
        const pts = r.pts; if (!pts || pts.length < 2) continue;
        let acc = 0;
        const base = vb;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const pr = pts[Math.max(0, i - 1)], nx2 = pts[Math.min(pts.length - 1, i + 1)];
          let tx = nx2[0] - pr[0], tz = nx2[1] - pr[1];
          const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          const nx = -tz, nz = tx, hw = 5.5;
          if (i) acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) || 2;
          pos.push(p[0] - nx * hw, Y_LINE + 0.05, p[1] - nz * hw,
                   p[0] + nx * hw, Y_LINE + 0.05, p[1] + nz * hw);
          uv.push(0, acc, 1, acc);
          if (i) { const a = base + (i - 1) * 2, b = base + i * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
        }
        vb += pts.length * 2; n++;
      }
      if (!idx.length) { this.loaded.add(key); return; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.mat);
      m.name = 'road:' + key; m.frustumCulled = false;
      m.userData = { derived: 'real_centerline', halfWidthM: 5.5, roads: n };
      let grp = this.groups.get(key);
      if (!grp) { grp = new THREE.Group(); grp.name = 'roads:' + key; this.groups.set(key, grp); this.scene.add(grp); }
      grp.add(m); this.meshes.set(key, m);
      this.loaded.add(key); this.stats.roads += n; this.stats.loaded = this.loaded.size;
    } catch (e) { this.stats.errors++; (this.failed || (this.failed = new Set())).add(key); }
    finally { this.loading.delete(key); }
  }
  _unload(key) {
    const m = this.meshes.get(key);
    if (m) { m.geometry.dispose(); m.parent && m.parent.remove(m); this.meshes.delete(key); }
    this.loaded.delete(key);
  }
  setCam(cam) {
    if (!this.mat || !this.mat.uniforms) return;
    this.mat.uniforms.uCam.value.set(cam.x, cam.y, cam.z);
  }
}

export class UrbanFull {
  constructor(scene, camera, opts = {}) {
    this.scene = scene; this.camera = camera; this.base = opts.base || './data/';
    this.radius = opts.radius || 1500;
    this.layers = []; this.elevation = null; this.ready = false;
    this.stats = { parcels: 0, zoning: 0, water: 0, roads: 0, canals: 0 };
  }

  async init() {
    const g = async (f) => {
      try { const r = await fetch(this.base + f); if (!r.ok) return null; return await r.json(); }
      catch (e) { return null; }
    };
    const [gm, lm, pm] = await Promise.all([
      g('urban_ground_manifest.json'), g('urban_lines_manifest.json'), g('urban_points_manifest.json')]);
    if (gm) this.layers.push(new GroundLayer(this.scene, gm, 0x8a8779, { base: this.base, radius: Math.min(this.radius, 1400), maxChunks: 18 }));
    if (lm) {
      // 真实街道沥青面（116,464 条中心线）：替代只有 1px 的灰线层
      this.roadLayer = new RoadLayer(this.scene, lm, { base: this.base, radius: Math.min(this.radius, 1400), maxChunks: 40 });
      this.layers.push(this.roadLayer);
    }
    if (pm) this.layers.push(new PointLayer(this.scene, pm, { base: this.base, radius: this.radius * 1.4, maxChunks: 15 }));
    /* [基底路面] 真实地块多边形只覆盖建筑占地，地块之间的街道是空的，
       城市看起来像"浮在水上的建筑群"。补一张覆盖全域的沥青底板。 */
    try {
      /* 全域包围盒（来自全量建筑清单实测）：cx -56.7~19.7 km，cz -4.7~78.1 km */
      const x0 = -56700, x1 = 19700, z0 = -4700, z1 = 78100, pad = 4000;
      const geo = new THREE.PlaneGeometry((x1 - x0) + pad * 2, (z1 - z0) + pad * 2, 96, 96);
      geo.rotateX(-Math.PI / 2);
      // [2026-11-27 地面显形] 全域纯色底板 0x7c7a72 就是"紫色地面"元凶。换真实沥青贴图,
      // 世界尺度平铺 uv(plane 的 uv 是 0..1,按米数换算 repeat),让 8 万米路面有真实颗粒。
      const TL2 = new THREE.TextureLoader();
      const texAsphalt = TL2.load('./textures/real/acg_Asphalt025C_Color.webp');
      texAsphalt.wrapS = texAsphalt.wrapT = THREE.RepeatWrapping;
      texAsphalt.colorSpace = THREE.SRGBColorSpace;
      texAsphalt.repeat.set(((x1 - x0) + pad * 2) / 24, ((z1 - z0) + pad * 2) / 24);
      texAsphalt.anisotropy = 4;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: texAsphalt, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
      mesh.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);   // 高于水体(-0.02)：陆地路面优先，海面后续用掩码单独铺
      mesh.name = 'urban:roadbed';
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;   // 8 万米见方的单块几何，包围球误判会被整块剔除
      this.scene.add(mesh);
      this.roadbed = mesh;
    } catch (e) { /* 基底失败不阻断主流程 */ }
    this.elevation = await g('elevation.json');
    this.ready = true;
    return this.state();
  }

  async update(camPos) {
    if (!this.ready) return;
    const cam = { x: camPos.x, z: camPos.z };
    this.lastCam = [Math.round(cam.x), Math.round(cam.z)];
    this.diag = [];
    if (this.roadLayer) this.roadLayer.setCam(camPos);
    for (const L of this.layers) {
      const pending = L.update(cam);
      this.diag.push({ want: pending.length + L.loaded.size, pend: pending.length, loaded: L.loaded.size });
      const q = pending.slice(0, 14);
      await Promise.all(q.map(k => L.load(k)));
    }
  }

  setPlanVisible(on) {
    for (const L of this.layers) if (L.setPlan) L.setPlan(on);
    this.planVisible = !!on;
    return this.planVisible;
  }

  state() {
    const s = this.stats;
    return {
      brand: 'NOVA.urban.full', ready: this.ready,
      layers: this.layers.map(L => ({
        chunks: L.byKey.size, loaded: L.loaded.size,
        lines: L.stats ? Math.round(L.stats.lines || 0) : undefined,
        junction: L.stats && L.stats.junction, permit: L.stats && L.stats.permit,
        errors: L.stats && L.stats.errors,
      })),
      elevationRows: this.elevation ? this.elevation.rows : 0,
      elevationCols: this.elevation ? this.elevation.cols : 0,
    };
  }
}

export async function mountUrbanFull(scene, camera, opts = {}) {
  const u = new UrbanFull(scene, camera, opts);
  const st = await u.init();
  console.log('[urbanFull]', st);
  window.__setPlanLines = (on) => u.setPlanVisible(on);   // 规划图层一键开关
  return u;
}
