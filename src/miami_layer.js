// miami_layer.js — 真实迈阿密建筑数据 → NOVA 场景（Y-up）运行时几何层
//
// 设计原则（重写版）：
//   1. 零程序生成城市：轮廓 / 高度 / 洞 / 区块键全部来自 urban_intake.py 导出的
//      miami_urban.json + urban_chunks/*.json。heightM 缺失(unverified)直接跳过，
//      绝不拿默认值冒充楼高。
//   2. 城市的"像不像"取决于立面细节覆盖率：迈阿密真实数据里 94% 是 <20m 的低层，
//      旧版把 <20m 全塞进 band 0(无窗白灰泥)，满城光板 → 看起来像空地。
//      重写版把 8~20m 的低层公寓改用带窗砖石档，让绝大多数楼都有门窗。
//   3. 照片级外观由 ambientCG/AI 摄影贴图承担；几何只负责真实轮廓 + 世界尺度 UV。
//
// 坐标：导入器已把 Z-up 转 Y-up，pts 是水平面 (X_t, Z_t) 二元组。
// ExtrudeGeometry 在 XY 平面挤出到 +Z，把 Shape 点写成 (x,-z) 后 rotateX(-π/2)
// 得到 (X_t, H, Z_t)——det=+1，绕序/法线/贴图手性保持。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ChunkStream } from './nova_chunk_core.js?v=a7u2601';

export const URBAN_DATA_URL = './data/miami_urban.json';
export const CHUNK_SIZE = 200;

const UV_SCALE = 0.25;   // 每 4 m 一个纹理周期（未走盒投影的兜底几何用）

// ---------------------------------------------------------------------------
// 单栋建筑 → BufferGeometry
// ---------------------------------------------------------------------------
export function buildUrbanGeometry(building) {
  if (!building || !Array.isArray(building.rings) || !building.rings.length) return null;
  const H = building.heightM;
  if (!(H > 0)) return null;                 // heightConfidence=unverified → 零伪造
  const ext = building.rings.find(r => r.role === 'exterior') || building.rings[0];
  if (!ext.pts || ext.pts.length < 3) return null;

  const shape = new THREE.Shape();
  ext.pts.forEach((p, i) => i ? shape.lineTo(p[0], -p[1]) : shape.moveTo(p[0], -p[1]));
  shape.closePath();
  for (const h of building.rings) {
    if (h.role !== 'interior' || !h.pts || h.pts.length < 3) continue;
    const path = new THREE.Path();
    h.pts.forEach((p, i) => i ? path.lineTo(p[0], -p[1]) : path.moveTo(p[0], -p[1]));
    path.closePath();
    shape.holes.push(path);
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: H, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, building.baseY || 0, 0);
  // UV 按世界尺度归一，供未走 reproject 的路径直接复用
  const uv = geo.getAttribute('uv');
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * UV_SCALE, uv.getY(i) * UV_SCALE);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// 稳定伪随机：同一 (id,key) 每次得到同样的分档 / 色扰 / UV 偏移。
function seedOf(id, key) {
  let h = 2166136261;
  const s = String(id == null ? key : id) + '|' + String(key || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 4096;
}

// 立面分档（重写）：让低层也有窗，提升"城市感"覆盖率。
//   band 0 : <8m   灰泥（真低矮附属物：车库/围墙/设备房）
//   band 1 : 8~20m 砖石带窗低层公寓  ← 旧版这里是光板，迈阿密大多数楼
//   band 2 : 20~60m 混凝土框窗中层
//   band 3/4/5: >60m 三种玻璃幕墙塔
function bandOf(heightM, seed) {
  if (heightM > 60) return 3 + (seed % 3);
  if (heightM > 20) return 2;
  if (heightM > 8) return 1;
  return 0;
}

// 一张贴图覆盖的物理米数。带窗档统一 48m（14 层×16 开间，每层3.4m/每间3m），
// 避免把 48m 的图硬塞进一半尺寸导致窗格密度翻倍的马赛克。灰泥档无窗可小些。
function periodOf(band) {
  return band === 0 ? 24 : 48;
}

// ---------------------------------------------------------------------------
// 真实贴图 UV 重投影：ExtrudeGeometry 自带 UV 是 (周长,高度)，铺立面会撕裂。
// 改为世界尺度盒投影：竖直面沿墙展开(u)、按层高累进(v)，水平面采样屋顶带。
// ---------------------------------------------------------------------------
function reprojectUV(geo, period = 48, seed = 0) {
  if (!Number.isFinite(seed)) seed = 0;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  let uv = geo.getAttribute('uv');
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  // 逐栋错开 u/v 起点 + 随机水平翻转，破坏"全城同一张图"的集装箱条纹感。
  const offU = (seed * 0.6180339887) % 1;
  const offV = (seed * 0.4142135624) % 1;
  const flip = (seed % 2) ? -1 : 1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor ? nor.getX(i) : 0, ny = nor ? nor.getY(i) : 1, nz = nor ? nor.getZ(i) : 0;
    if (Math.abs(ny) > 0.72) {
      // 屋顶/水平面：固定采样贴图顶部预留的纯灰屋顶带，避免玻璃/窗格
      // 采到楼顶、斜光下泛青蓝描边。
      uv.setXY(i, 0.5, 0.993);
      continue;
    }
    const L = Math.hypot(nx, nz) || 1;
    const u = (x * (nz / L) - z * (nx / L)) / period;
    const v = y / period;
    uv.setXY(i, u * flip + offU, v + offV);
  }
  uv.needsUpdate = true;
  // aoMap 在 Three r152+ 读 uv1。复制同一份立面 UV，否则 AO 全采 0 → 整栋死黑。
  if (!geo.getAttribute('uv1')) {
    const a = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) { a[i * 2] = uv.getX(i); a[i * 2 + 1] = uv.getY(i); }
    geo.setAttribute('uv1', new THREE.BufferAttribute(a, 2));
  }
  // 逐栋色扰：同材质下避免复制粘贴感（明度 0.86~1.12 / 冷暖 ±2.5%）。
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const lum = 0.86 + ((seed * 0.7548776662) % 1) * 0.26;
  const warm = 1 + (((seed * 0.3183098862) % 1) - 0.5) * 0.05;
  for (let i = 0; i < n; i++) {
    col[i * 3] = lum * warm;
    col[i * 3 + 1] = lum;
    col[i * 3 + 2] = lum / warm;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// 多边形点包含（射线法），pts 为导入器输出的 (X_t, Z_t) 二元组。
// ---------------------------------------------------------------------------
function inRing(pts, px, pz) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function inSolid(rings, px, pz) {
  const ext = rings.find(r => r.role === 'exterior') || rings[0];
  if (!inRing(ext.pts, px, pz)) return false;
  for (const h of rings) if (h.role === 'interior' && inRing(h.pts, px, pz)) return false;
  return true;
}

// 法线探针：顶面+Y / 底面-Y / 侧面指向空域，三类都要有且方向正确。
// 沿法线偏移一点做真实轮廓点包含：Q 落实体内才算错，落空域(含洞腔)即正确。
export function probeNormals(meshes, limit = 40) {
  let up = 0, down = 0, side = 0, outward = 0, checked = 0, bad = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const EPS = 0.05;
  for (const m of meshes.slice(0, limit)) {
    const g = m.geometry, pos = g.getAttribute('position');
    if (!pos) continue;
    const rings = m.userData && m.userData.rings;
    const index = g.getIndex();
    const tri = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < Math.min(tri, 240); t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac).normalize();
      if (!Number.isFinite(n.x + n.y + n.z)) { bad++; continue; }
      checked++;
      if (n.y > 0.85) up++;
      else if (n.y < -0.85) down++;
      else {
        side++;
        mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        if (!rings) {
          g.computeBoundingBox(); const ctr = new THREE.Vector3();
          g.boundingBox.getCenter(ctr);
          if (n.dot(mid.clone().sub(ctr).setY(0)) > 0) outward++;
        } else {
          const qx = mid.x + n.x * EPS, qz = mid.z + n.z * EPS;
          if (!inSolid(rings, qx, qz)) outward++;
        }
      }
    }
  }
  const ratio = side ? +(outward / side).toFixed(4) : null;
  return { checked, up, down, side, outward, sideOutwardRatio: ratio,
           nonFinite: bad, ok: up > 0 && down > 0 && side > 0 && bad === 0
                      && (side === 0 || outward / side > 0.9) };
}

// ---------------------------------------------------------------------------
// 挂载真实城市层（整份单文件数据路径）。data 为空/全挂起时返回空壳，零伪造。
// ---------------------------------------------------------------------------
export function mountUrbanLayer(scene, data, opts = {}) {
  const buildings = (data && data.buildings) || [];
  const chunks = (data && data.chunks) || [];
  const groups = new Map();
  const meshes = [];
  const skipped = { noHeight: 0, noRings: 0, buildFail: 0 };
  const radius = opts.radius || 1050;
  const mat = opts.material || new THREE.MeshStandardMaterial({
    color: 0xd8c9ad, roughness: 0.86, metalness: 0.04, side: THREE.FrontSide,
  });

  for (const ck of chunks) {
    const g = new THREE.Group();
    g.name = 'urban:' + ck.key;
    g.userData = { key: ck.key, cx: ck.cx, cz: ck.cz, count: ck.count };
    g.visible = true;
    groups.set(ck.key, g);
    scene.add(g);
  }
  const ensureGroup = key => {
    let g = groups.get(key);
    if (!g) {
      const [ix, iz] = key.split(',').map(Number);
      g = new THREE.Group(); g.name = 'urban:' + key;
      g.userData = { key, cx: (ix + 0.5) * CHUNK_SIZE, cz: (iz + 0.5) * CHUNK_SIZE, count: 0 };
      groups.set(key, g); scene.add(g);
    }
    return g;
  };

  for (const b of buildings) {
    if (!b.rings || !b.rings.length) { skipped.noRings++; continue; }
    if (!(b.heightM > 0)) { skipped.noHeight++; continue; }
    let geo;
    try { geo = buildUrbanGeometry(b); }
    catch (e) { skipped.buildFail++; continue; }
    if (!geo) { skipped.buildFail++; continue; }
    const primary = (b.chunkKeys && b.chunkKeys[0]) || '0,0';
    const mesh = new THREE.Mesh(geo, opts.materialFactory ? opts.materialFactory(b) : mat);
    mesh.name = 'urban:' + b.id;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData = { id: b.id, chunkKeys: b.chunkKeys, heightSource: b.heightSource,
                      heightM: b.heightM, crossBlock: !!b.crossBlock, rings: b.rings };
    ensureGroup(primary).add(mesh);
    meshes.push(mesh);
  }

  const api = {
    brand: 'NOVA.urban', groups, meshes, skipped,
    chunkCount: groups.size, buildingCount: meshes.length,
    update(cameraPos, r = radius) {
      let visible = 0;
      const r2 = r * r;
      for (const g of groups.values()) {
        const dx = g.userData.cx - cameraPos.x, dz = g.userData.cz - cameraPos.z;
        const on = dx * dx + dz * dz <= r2;
        g.visible = on;
        if (on) visible++;
      }
      return visible;
    },
    setRadius(r) { api.radius = r; return api.update(new THREE.Vector3(0, 0, 0), r); },
    radius,
    normalsProbe() { return probeNormals(meshes); },
    state() {
      return {
        brand: 'NOVA.urban', chunkCount: groups.size, buildingCount: meshes.length,
        skipped, radius: api.radius,
        visibleChunks: [...groups.values()].filter(g => g.visible).length,
        triangles: meshes.reduce((s, m) => s + (m.geometry.getIndex()
          ? m.geometry.getIndex().count / 3 : m.geometry.getAttribute('position').count / 3), 0),
        uvScaled: UV_SCALE,
      };
    },
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      for (const g of groups.values()) scene.remove(g);
      if (!opts.materialFactory && mat.dispose) mat.dispose();
      meshes.length = 0; groups.clear();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 分块运行时：按相机位置懒加载 200m 区块，进入半径才 fetch，离场释放显存。
// ---------------------------------------------------------------------------
export class ChunkedUrbanLayer {
  constructor(scene, manifest, opts = {}) {
    this.scene = scene;
    this.manifest = manifest;
    this.base = opts.base || './data/';
    this.radius = opts.radius || 1050;
    this.groups = new Map();
    this.byKey = new Map();
    this.loaded = new Set();
    this.loading = new Set();
    this.seen = new Set();
    this.requests = 0;
    this.errors = [];
    this.bucketCache = new Map();   // file → Promise<json>，同桶多块只请求一次
    this.meshByKey = new Map();
    this.built = 0;
    this.concurrency = opts.concurrency || 8;
    this.skipped = { duplicate: 0, noHeight: 0, buildFail: 0, unloaded: 0 };

    // 六档照片级材质。map 是照片级迈阿密立面 Color；normal/roughness/位移
    // 沿用 ambientCG CC0 摄影测量数据，保证窗洞凹凸的真实立体感。
    const TL = new THREE.TextureLoader();
    // 全局贴图显存记账：uuid→字节，跨 chunk 去重（chunk 级会把共享贴图
    // 重复计几十次，实测 11.6GB 假账）。
    if (!globalThis.__texMemMap) { globalThis.__texMemMap = new Map(); globalThis.__texMemTotal = 0; }
    const tex = (f, srgb) => {
      // 贴图内容变了但同名时,服务端 max-age 会让手机一直拿旧图；
      // 改图只改这个版本号常量即可强制刷新。
      const t = TL.load('./textures/real/' + f + '?v=20261127sharp', loaded => {
        try {
          const img = loaded && loaded.image;
          const w = img && (img.width || img.videoWidth), h = img && (img.height || img.videoHeight);
          if (w && h && !globalThis.__texMemMap.has(loaded.uuid)) {
            const bytes = w * h * 4;
            globalThis.__texMemMap.set(loaded.uuid, bytes);
            globalThis.__texMemTotal += bytes;
          }
        } catch (e) { /* 记账失败不影响渲染 */ }
      });
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    // 移动端用 CPU 预烘焙法线（窗洞凹凸加载前算好，GPU 每像素只采样 1 次），
    // 桌面端保留原生法线 + GPU POM 视差。
    const MOBILE_RT = !!(globalThis.__mcPerf && globalThis.__mcPerf.isMobileUA);
    const BAKED = ['Facade001', 'Facade005', 'Facade006'];
    const mkMat = (name, rough = 0.84, metal = 0.0) => {
      const m = new THREE.MeshStandardMaterial({
        map: tex('acg_' + name + '_Color.jpg', true),
        normalMap: tex('acg_' + name + (MOBILE_RT && BAKED.includes(name) ? '_BakedN' : '_NormalGL') + '.jpg', false),
        normalScale: MOBILE_RT ? new THREE.Vector2(0.85, 0.85) : new THREE.Vector2(0.45, 0.45),
        roughnessMap: tex('acg_' + name + '_Roughness.jpg', false),
        aoMap: (['Facade001', 'Facade005', 'Facade006'].includes(name)
          ? (() => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; return t; })()
          : tex('acg_' + name + '_AmbientOcclusion.jpg', false)),
        aoMapIntensity: 0.45,
        color: 0xffffff, roughness: rough, metalness: metal,
        vertexColors: true, side: THREE.FrontSide,
      });
      const hasDisp = !MOBILE_RT && BAKED.includes(name);
      const disp = hasDisp ? tex('acg_' + name + '_Displacement.jpg', false) : null;
      m.userData.pom = hasDisp;
      m.userData.dispTex = hasDisp ? disp : null;
      m.onBeforeCompile = sh => {
        sh.uniforms.uDispMap = { value: hasDisp ? disp : null };
        sh.uniforms.uPomScale = { value: hasDisp ? 0.030 : 0.0 };
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>',
            '#include <common>\n uniform sampler2D uDispMap;\n uniform float uPomScale;\n float pomDepth(vec2 uv){ return texture2D(uDispMap, uv).r; }')
          .replace('#include <map_fragment>', `
            #ifdef USE_MAP
            vec2 pomUv = vMapUv;
            if (uPomScale > 0.0) {
              vec3 dpdx = dFdx(-vViewPosition);
              vec3 dpdy = dFdy(-vViewPosition);
              vec2 dtdx = dFdx(vMapUv);
              vec2 dtdy = dFdy(vMapUv);
              vec3 T = normalize(dpdx * dtdy.y - dpdy * dtdx.y);
              vec3 B = normalize(-dpdx * dtdx.x + dpdy * dtdx.y);
              vec3 N = normalize(vNormal);
              T = normalize(T - N * dot(N, T));
              B = normalize(cross(N, T));
              vec3 V = normalize(vViewPosition);
              vec2 vTangent = vec2(dot(V, T), dot(V, B));
              float layers = mix(28.0, 12.0, clamp(abs(V.z), 0.0, 1.0));
              float layerH = 1.0 / layers;
              float curDepth = 1.0;
              vec2 stepUv = vTangent * (uPomScale / layers) / max(abs(V.z), 0.35);
              vec2 pomCur = vMapUv;
              for (int i = 0; i < 32; i++) {
                float h = 1.0 - pomDepth(pomCur);
                if (h >= curDepth) break;
                pomCur -= stepUv;
                curDepth -= layerH;
              }
              float hAfter = 1.0 - pomDepth(pomCur);
              float hBefore = curDepth + layerH;
              float w = (hBefore - hAfter) / max(hBefore - curDepth, 1e-4);
              pomUv = pomCur - stepUv * (1.0 - clamp(w, 0.0, 1.0));
            }
            vec4 sampledDiffuseColor = texture2D(map, pomUv);
            #ifdef DECODE_VIDEO_TEXTURE
              sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
            #endif
            diffuseColor *= sampledDiffuseColor;
            diffuseColor.rgb = clamp(pow(diffuseColor.rgb, vec3(0.96)) * vec3(1.02,1.0,0.97), 0.0, 1.0);
            #endif
            `);
        m.userData.pomShader = sh;
      };
      return m;
    };
    // 六档：0 低矮灰泥 / 1 带窗砖石低层 / 2 混凝土中层 / 3-5 三种玻璃塔
    this.matStucco = opts.material || mkMat('PaintedPlaster006', 0.96);
    this.matMixed = this.matStucco === opts.material ? this.matStucco : mkMat('Facade018A', 0.86);
    this.matConcrete = this.matStucco === opts.material ? this.matStucco : mkMat('Facade020A', 0.82);
    // [2026-11-27 黑楼修复] 玻璃塔旧版 metalness 0.08~0.12：无 envMap 或软渲染下
    // 金属没有漫反射、只反射环境，环境贴图未就绪时就整栋纯黑剪影。归零金属度后
    // 玻璃材质靠贴图本身的高光/反射烘焙表现质感，任何设备都不再黑楼。
    this.matGlass = this.matStucco === opts.material ? this.matStucco : mkMat('Facade001', 0.30, 0.0);
    this.matGlassB = this.matStucco === opts.material ? this.matStucco : mkMat('Facade005', 0.34, 0.0);
    this.matGlassC = this.matStucco === opts.material ? this.matStucco : mkMat('Facade006', 0.38, 0.0);
    // 照片贴图已含真实反照率，只做极轻微暖偏，不再整体放大（避免白塔过曝）。
    for (const m of [this.matStucco, this.matMixed, this.matConcrete, this.matGlass, this.matGlassB, this.matGlassC]) {
      if (m && m.color && m !== opts.material) m.color.setRGB(1.04, 1.0, 0.95);
    }
    this.material = this.matStucco;
    for (const c of manifest.chunks || []) this.byKey.set(c.key, c);
  }

  get meshes() {
    const out = [];
    for (const o of this.meshByKey.values()) {
      if (o.isMesh) out.push(o);
      else o.traverse(c => { if (c.isMesh) out.push(c); });
    }
    return out;
  }

  _ensureGroup(key) {
    let g = this.groups.get(key);
    if (!g) {
      const c = this.byKey.get(key);
      if (!c) return null;
      g = new THREE.Group();
      g.name = 'urban:' + key;
      g.userData = { key, cx: c.cx, cz: c.cz, count: c.count, file: c.file };
      g.visible = true;
      this.groups.set(key, g);
      this.scene.add(g);
    }
    return g;
  }

  // 旧单文件加载路径（无 chunked 清单时的兜底）
  async load(key) {
    if (this.loaded.has(key) || this.loading.has(key)) return;
    const c = this.byKey.get(key);
    if (!c) return;
    this.loading.add(key);
    try {
      if (!this.bucketCache.has(c.file)) {
        this.bucketCache.set(c.file,
          fetch(this.base + c.file)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
        this.requests++;
      }
      const d = await this.bucketCache.get(c.file);
      const arr = d.byChunk ? (d.byChunk[key] || []) : (d.buildings || []);
      const geos = [];
      for (const b of arr) {
        if (!(b.heightM > 0)) { this.skipped.noHeight++; continue; }
        if (this.seen.has(b.id)) { this.skipped.duplicate++; continue; }
        let geo = null;
        try { geo = buildUrbanGeometry(b); } catch (e) { geo = null; }
        if (!geo) { this.skipped.buildFail++; continue; }
        this.seen.add(b.id);
        geos.push(geo);
      }
      if (geos.length) {
        let merged = geos[0];
        if (geos.length > 1) {
          const m = mergeGeometries(geos, false);
          if (m) { geos.forEach(g => g.dispose()); merged = m; }
          else { this.skipped.buildFail += geos.length; geos.forEach(g => g.dispose()); return; }
        }
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, this.material);
        mesh.name = 'urban:' + key;
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.userData = { key, buildings: geos.length, chunkKeys: [key] };
        const g = this._ensureGroup(key);
        if (!g) { merged.dispose(); return; }
        g.add(mesh);
        this.meshByKey.set(key, mesh);
        this.built += geos.length;
      }
      this.loaded.add(key);
    } catch (e) {
      this.bucketCache.delete(c.file);
      this.errors.push({ key, error: String(e && e.message || e).slice(0, 160) });
    } finally {
      this.loading.delete(key);
    }
  }

  _unload(key) {
    if (this.chunkRings) this.chunkRings.delete(key);
    if (this.lcr && this.lcr.unmount) {
      try { this.lcr.unmount(key); } catch (e) {}
    }
    const m = this.meshByKey.get(key);
    if (!m) { this.loaded.delete(key); return; }
    m.traverse(ch => { if (ch.isMesh && ch.geometry) ch.geometry.dispose(); });
    if (m.parent) m.parent.remove(m);
    this.meshByKey.delete(key);
    this.loaded.delete(key);
    this.skipped.unloaded++;
  }

  // ChunkStream 挂载路径：rows 来自桶解码，按 6 档构建合并网格（6 个 draw call）。
  _buildChunkMesh(key, rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const c = this.byKey.get(key);
    if (!c) return null;
    const buckets = [[], [], [], [], [], []];
    let builtN = 0;
    for (const b of rows) {
      if (!(b.heightM > 0)) { this.skipped.noHeight++; continue; }
      const bg = buildUrbanGeometry(b);
      if (!bg) { this.skipped.buildFail++; continue; }
      const sd = seedOf(b.id, key);
      const band = bandOf(b.heightM, sd);
      reprojectUV(bg, periodOf(band), sd);
      buckets[band].push(bg);
      builtN++;
    }
    if (!builtN) return null;
    const g = this._ensureGroup(key);
    if (!g) { buckets.forEach(a => a.forEach(x => x.dispose())); return null; }
    const mats = [this.matStucco, this.matMixed, this.matConcrete, this.matGlass, this.matGlassB, this.matGlassC];
    // 保留本块真实轮廓供街面着色器建距离场，避免整片街区变灰板。
    this.chunkRings = this.chunkRings || new Map();
    this.chunkRings.set(key, rows.map(b => b && b.rings).filter(Boolean));
    const holder = new THREE.Group();
    holder.name = 'urban:' + key;
    let tris = 0, verts = 0;
    for (let i = 0; i < mats.length; i++) {
      const arr = buckets[i];
      if (!arr.length) continue;
      let merged = arr.length > 1 ? mergeGeometries(arr, false) : arr[0];
      if (arr.length > 1) arr.forEach(x => x.dispose());
      if (!merged) { this.skipped.buildFail += arr.length; continue; }
      if (!merged.getAttribute('position') || !merged.getAttribute('position').count) {
        this.skipped.buildFail += arr.length; merged.dispose(); continue;
      }
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, mats[i]);
      m.frustumCulled = true;
      m.userData = { band: i };
      tris += merged.getIndex() ? merged.getIndex().count / 3 : merged.getAttribute('position').count / 3;
      verts += merged.getAttribute('position').count;
      holder.add(m);
    }
    if (!holder.children.length) return null;
    holder.userData = { key, triangles: tris, verts, buildings: builtN };
    g.add(holder);
    this.meshByKey.set(key, holder);
    this.loaded.add(key);
    this.built += builtN;
    if (this.lcr && this.lcr.mount) {
      try { this.lcr.mount(key, holder, c); } catch (e) {}
    }
    return holder;
  }

  enableStream(o = {}) {
    if (this.stream) return this.stream;
    const self = this;
    this.stream = new ChunkStream({
      manifest: this.manifest,
      tier: o.tier || 'mobile',
      base: this.base,
      onMount(key, rows) {
        const mesh = self._buildChunkMesh(key, rows);
        if (!mesh) return { object: null, buildings: 0, triangles: 0, geometryMB: 0 };
        const ud = mesh.userData || {};
        const textureMB = +((globalThis.__texMemTotal || 0) / 1048576).toFixed(2);
        return {
          object: mesh, buildings: ud.buildings || rows.length,
          triangles: ud.triangles || 0, textureMB,
          geometryMB: +(((ud.verts || 0) * 4 * 11) / 1048576).toFixed(4),
        };
      },
      onUnmount(key) { self._unload(key); },
      onError(msg) { self.errors.push({ stream: String(msg).slice(0, 160) }); },
    });
    return this.stream;
  }

  streamTick(cameraPos, dtMs, frameMs) {
    if (!this.stream) return null;
    this.stream.setCamera(cameraPos.x, cameraPos.z, 0, 1, dtMs || 16.7);
    return this.stream.tick(performance.now(), frameMs || 16.7);
  }

  update(cameraPos, radius = this.radius) {
    this.radius = radius;
    const r2 = radius * radius;
    const want = [];
    let visible = 0;
    for (const c of this.manifest.chunks || []) {
      const dx = c.cx - cameraPos.x, dz = c.cz - cameraPos.z;
      if (dx * dx + dz * dz <= r2) {
        this._ensureGroup(c.key);
        visible++;
        want.push(c.key);
      }
    }
    const wantSet = new Set(want);
    for (const [key, g] of this.groups) {
      const keep = wantSet.has(key);
      g.visible = keep;
      if (!keep && this.loaded.has(key)) this._unload(key);
    }
    return { visible, want, pending: want.filter(k => !this.loaded.has(k)) };
  }

  async updateAndLoad(cameraPos, radius = Math.round(this.radius * 1.35)) {
    const s = this.update(cameraPos, radius);
    const q = s.pending.slice();
    while (q.length) {
      const batch = q.splice(0, this.concurrency);
      await Promise.all(batch.map(k => this.load(k)));
    }
    return s;
  }

  normalsProbe() { return probeNormals(this.meshes); }

  state() {
    const meshes = this.meshes;
    return {
      brand: 'NOVA.urban', mode: 'chunked.merged',
      chunkCount: this.groups.size, loadedChunks: this.loaded.size,
      loadingChunks: this.loading.size,
      visibleChunks: [...this.groups.values()].filter(g => g.visible).length,
      buildingCount: this.built, declaredBuildings: this.manifest.buildingCount,
      meshes: meshes.length, requests: this.requests, radius: this.radius,
      skipped: this.skipped, errors: this.errors,
      triangles: meshes.reduce((s, m) => s + (m.geometry.getIndex()
        ? m.geometry.getIndex().count / 3 : m.geometry.getAttribute('position').count / 3), 0),
    };
  }

  dispose() {
    for (const m of this.meshByKey.values())
      m.traverse(c => { if (c.isMesh && c.geometry) c.geometry.dispose(); });
    for (const g of this.groups.values()) this.scene.remove(g);
    for (const m of new Set([this.matStucco, this.matMixed, this.matConcrete, this.matGlass, this.matGlassB, this.matGlassC]))
      if (m && m.dispose) m.dispose();
    this.meshByKey.clear(); this.groups.clear(); this.loaded.clear(); this.seen.clear();
  }
}

// 主城启动钩子：优先 chunked 清单，回退单文件；两者缺失时静默跳过。
export async function tryMountUrban(scene, opts = {}) {
  const base = opts.base || './data/';
  const mfUrl = opts.manifestUrl || (base + 'urban_manifest.json');
  try {
    const r = await fetch(mfUrl);
    if (r.ok) {
      const mf = await r.json();
      if (mf && mf.mode === 'chunked' && Array.isArray(mf.chunks) && mf.chunks.length) {
        const layer = new ChunkedUrbanLayer(scene, mf, { ...opts, base });
        try {
          layer.enableStream({ tier: opts.streamTier || 'mobile' });
          layer.streamTick(opts.startPos || new THREE.Vector3(0, 0, 0), 16.7, 16.7);
        } catch (e) {
          // 记录真实异常，便于定位（曾经静默吞掉导致 stream=null 却查不到原因）
          layer.errors.push({ streamInit: String(e && e.message || e).slice(0, 240),
                              stack: String(e && e.stack || '').slice(0, 600) });
          layer.stream = null;
          await layer.updateAndLoad(opts.startPos || new THREE.Vector3(0, 0, 0),
                                    opts.radius || 1050);
        }
        return layer;
      }
    }
  } catch (e) { /* 清单缺失属预期，继续回退 */ }
  try {
    const r = await fetch(opts.url || URBAN_DATA_URL);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !Array.isArray(d.buildings) || !d.buildings.length) return null;
    return mountUrbanLayer(scene, d, opts);
  } catch (e) {
    return null;
  }
}
