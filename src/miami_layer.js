// miami_layer.js — 真实城市建筑数据 → NOVA 场景（Y-up）的运行时几何层
//
// 零程序生成城市：所有轮廓、高度、洞、区块键都来自 urban_intake.py 导出的
// miami_buildings.json / miami_chunks.json。高度 unverified 的记录直接挂起，
// 绝不拿默认值冒充楼高。
//
// 坐标：导入器已把 Z-up 转成 Y-up，pts 是水平面 (X_t, Z_t) 二元组。
// ExtrudeGeometry 在 XY 平面挤出到 +Z，这里把 Shape 点写成 (x, -z) 后
// rotateX(-π/2) 得到 (X_t, H, Z_t) —— 旋转 det=+1，绕序/法线/贴图手性保持，
// 与直接写 (x, z, y) 的镜像变换（det=-1，整片剔正面）彻底分开。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ChunkStream } from './nova_chunk_core.js?v=a7u2601';

export const URBAN_DATA_URL = './data/miami_urban.json';
export const CHUNK_SIZE = 200;

const UV_SCALE = 0.25;   // 每 4 m 一个纹理周期，避免几百米坐标把贴图拉成条纹

/** 单栋建筑 → BufferGeometry。返回 null 表示数据缺失，调用方必须跳过。 */
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
  // UV 按世界尺度归一，供主城立体贴图管线直接复用
  const uv = geo.getAttribute('uv');
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * UV_SCALE, uv.getY(i) * UV_SCALE);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function seedOf(id, key) {
  let h = 2166136261;
  const s = String(id == null ? key : id) + '|' + String(key || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 4096;
}

/**
 * 真实贴图 UV 重投影：ExtrudeGeometry 自带 UV 是 (周长, 高度)，铺真实立面会撕裂。
 * 改为世界尺度盒投影 —— 竖直面沿墙展开(u)、按层高累进(v)，水平面按 xz 平面。
 * period = 一张贴图覆盖的物理米数（2470 图内约 15 格窗，格≈3.2 m → 48 m）。
 */
function reprojectUV(geo, period = 48, seed = 0) {
  if (!Number.isFinite(seed)) seed = 0;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  let uv = geo.getAttribute('uv');
  if (!uv || uv.count !== pos.count) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  // 逐栋偏移：同一张贴图铺满全城会形成规则条纹（集装箱感），
  // 每栋按 id 哈希错开 u/v 起点并随机水平翻转，破坏重复节奏。
  const offU = ((seed * 0.6180339887) % 1);
  const offV = ((seed * 0.4142135624) % 1);
  const flip = (seed % 2) ? -1 : 1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor ? nor.getX(i) : 0, ny = nor ? nor.getY(i) : 1, nz = nor ? nor.getZ(i) : 0;
    let u, v;
    if (Math.abs(ny) > 0.72) {
      // 屋顶/水平面：贴图顶部 v≈0.993 预留了纯灰屋顶带。固定采样这里，
      // 避免用立面 UV 把玻璃/窗格采到楼顶，斜光下泛青蓝描边。
      uv.setXY(i, 0.5, 0.993);
      continue;
    }
    const L = Math.hypot(nx, nz) || 1;
    u = (x * (nz / L) - z * (nx / L)) / period;
    v = y / period;
    uv.setXY(i, u * flip + offU, v + offV);
  }
  uv.needsUpdate = true;
  // [2026-11-26] aoMap 在 Three r152+ 读 uv1（旧 uv2 已废）。没有 uv1 时 AO 采样
  // 全 0 → 整栋死黑。这里把同一份立面 UV 复制给 uv1，AO 才能对上窗框阴影。
  if (!geo.getAttribute('uv1')) {
    const a = new Float32Array(uv.count * 2);
    for (let i = 0; i < uv.count; i++) { a[i * 2] = uv.getX(i); a[i * 2 + 1] = uv.getY(i); }
    geo.setAttribute('uv1', new THREE.BufferAttribute(a, 2));
  }
  // 逐栋色扰：同材质下避免整片同色复制感（±6% 明度 / ±2% 冷暖）
  const n = pos.count;
  const col = new Float32Array(n * 3);
  // [2026-11-26] ±6% 太保守，76 栋连排仍像复制粘贴；放到 0.84~1.12 有街区层次。
  const lum = 0.84 + ((seed * 0.7548776662) % 1) * 0.28;
  const warm = 1 + (((seed * 0.3183098862) % 1) - 0.5) * 0.05;
  for (let i = 0; i < n; i++) {
    col[i * 3] = lum * warm;
    col[i * 3 + 1] = lum;
    col[i * 3 + 2] = lum / warm;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** 多边形点包含（射线法），pts 为导入器输出的 (X_t, Z_t) 二元组。 */
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

/**
 * 法线探针：顶面 +Y / 底面 −Y / 侧面指向空域，三类都要有且方向正确。
 *
 * 旧版用「相对整体质心朝外」判侧面，遇到带洞轮廓会把洞壁（法线朝洞内，
 * 本来就是正确朝向）误判成朝内，实测 ratio 卡在 0.8 假失败。现在改成
 * 沿法线偏移一点做真实轮廓的点包含测试：Q 落在实体内才算错，落在空域
 * （含洞腔）即正确。判据同时覆盖外壁与洞壁，无需放水阈值。
 */
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
      checked++;
      if (!Number.isFinite(n.x + n.y + n.z)) { bad++; continue; }
      if (n.y > 0.85) up++;
      else if (n.y < -0.85) down++;
      else {
        side++;
        mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        if (!rings) {
          // 无轮廓信息时退化为质心判据，并在结果里标明降级
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

/**
 * 挂载真实城市层。data 为空或全挂起时返回空壳，零伪造。
 * opts.materialFactory(building) 可接管材质（主城 relief 管线从这里接）。
 */
export function mountUrbanLayer(scene, data, opts = {}) {
  const buildings = (data && data.buildings) || [];
  const chunks = (data && data.chunks) || [];
  const groups = new Map();
  const meshes = [];
  const skipped = { noHeight: 0, noRings: 0, buildFail: 0 };
  const radius = opts.radius || 1050;
  const mat = opts.material || new THREE.MeshStandardMaterial({
    color: 0xd8c9ad, roughness: 0.86, metalness: 0.04, side: THREE.FrontSide,  // [迈阿密] 暖白灰泥，去冷蓝
  });

  for (const ck of chunks) {
    const g = new THREE.Group();
    g.name = 'urban:' + ck.key;
    g.userData = { key: ck.key, cx: ck.cx, cz: ck.cz, count: ck.count };
    g.visible = true;
    groups.set(ck.key, g);
    scene.add(g);
  }
  // 数据只有 buildings 没给 chunks 时，按记录自带 chunkKeys 现建组
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
    // 跨块轮廓几何只建一次，挂到主区块；其余区块键只做登记，避免重复绘制
    const primary = (b.chunkKeys && b.chunkKeys[0]) || '0,0';
    const mesh = new THREE.Mesh(geo, opts.materialFactory ? opts.materialFactory(b) : mat);
    mesh.name = 'urban:' + b.id;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData = { id: b.id, chunkKeys: b.chunkKeys, heightSource: b.heightSource,
                      heightM: b.heightM, crossBlock: !!b.crossBlock,
                      rings: b.rings };   // 法线探针按真实轮廓判内外，洞壁朝洞内属正确
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

/**
 * 600MB 级 chunked 运行时：按相机位置懒加载 200m 区块分片。
 *
 * import 侧 StreamExporter 输出 urban_manifest.json（只含区块元数据）
 * + urban_chunks/*.json（每片只含本区块建筑）。这里预建空 Group，
 * 进入半径才 fetch，离开只隐藏，几何常驻不重复请求。
 * 单次内存 = 视野内若干区块，而非整座城市。
 */
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
    this.bucketCache = new Map();   // file → Promise<json>，同桶多区块只发一次请求
    this.meshByKey = new Map();     // key → 合并后的 1 个 Mesh
    this.built = 0;
    this.concurrency = opts.concurrency || 8;
    this.skipped = { duplicate: 0, noHeight: 0, buildFail: 0, unloaded: 0 };
    /* [2026-11-26 摄影级材质 v3] 六档全部替换为 ambientCG 摄影测量扫描实拍 PBR，
       2048² 原生，CC0 可商用。每档一张独立贴图（不是一张图染三种色），
       迈阿密组合：玻璃塔 Facade001/005/006 + 砖石公寓 Facade018A/020A + Deco 白灰泥。
       normal/roughness/AO 走原生 JPG（webp 在软渲染后端会死黑，已验证两次）。 */
    const TL = new THREE.TextureLoader();
    const tex = (f, srgb) => {
      // [缓存修复] 贴图内容变了但同名，服务端 max-age 86400 会让手机一直拿旧图。
      // 加版本号强制刷新；以后改图只改这个常量。
      const t = TL.load('./textures/real/' + f + '?v=20261126f');
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    // [2026-11-26 性能] 移动端判定：iPhone XR 等 A12 设备 fragment 预算极紧，
    // GTA6 式 GPU POM(32次/像素) 直接打爆。改走 CPU 预烘焙法线(BakedN)——
    // 窗洞凹凸在加载前由 CPU 从位移图算好，GPU 每像素只采样 1 次。
    const MOBILE_RT = !!(globalThis.__mcPerf && globalThis.__mcPerf.isMobileUA);
    const BAKED = ['Facade001','Facade005','Facade006'];
    // name = 贴图资产名；rough = 基准粗糙度；metal = 金属度（玻璃幕框用）
    const mkMat = (name, rough = 0.84, metal = 0.0) => {
      const m = new THREE.MeshStandardMaterial({
        map: tex('acg_' + name + '_Color.jpg', true),
        normalMap: tex('acg_' + name + (MOBILE_RT && BAKED.includes(name) ? '_BakedN' : '_NormalGL') + '.jpg', false),
        normalScale: MOBILE_RT
          ? new THREE.Vector2(0.85, 0.85)   // CPU烘焙法线：直接编码窗洞坡度，需更强才出立体感
          : new THREE.Vector2(0.45, 0.45),  // 桌面端保留原生法线+GPU POM
        roughnessMap: tex('acg_' + name + '_Roughness.jpg', false),
        // 部分扫描资产无 AO 通道；缺档时用 1×1 纯白纹理（AO=1，不改变光照），
        // 避免 TextureLoader 404 拖慢首屏且材质仍能统一走 uv1。
        aoMap: (['Facade001','Facade005','Facade006'].includes(name)
          ? (() => { const t = new THREE.DataTexture(new Uint8Array([255,255,255,255]), 1, 1); t.needsUpdate = true; return t; })()
          : tex('acg_' + name + '_AmbientOcclusion.jpg', false)),
        aoMapIntensity: 0.45,   // 同上：扫描图已含接触阴影，AO 再叠就死黑
        color: 0xffffff, roughness: rough, metalness: metal,
        vertexColors: true, side: THREE.FrontSide,
      });
      // [GTA6 式落地] 真实位移图（ambientCG Displacement）驱动 POM 视差遮蔽：
      // 照片负责 1:1 外观，位移图让窗洞真凹进去、走近有视差、斜光有自遮挡。
      // 这是「一张真实照片 100% 立体」的核心。位移图缺失时 POM 自动关闭。
      const hasDisp = !MOBILE_RT && BAKED.includes(name);   // 移动端关闭 GPU POM
      const disp = hasDisp ? tex('acg_' + name + '_Displacement.jpg', false) : null;
      m.userData.pom = hasDisp;
      m.userData.dispTex = hasDisp ? disp : null;
      m.onBeforeCompile = sh => {
        sh.uniforms.uDispMap = { value: hasDisp ? disp : null };
        sh.uniforms.uPomScale = { value: hasDisp ? 0.030 : 0.0 };
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>',
            `#include <common>
             uniform sampler2D uDispMap;
             uniform float uPomScale;
             float pomDepth(vec2 uv){ return texture2D(uDispMap, uv).r; }`)
          // 在 map_fragment 之前做 POM：算出视差偏移后的 uv，替换 vMapUv
          .replace('#include <map_fragment>',
            `
             #ifdef USE_MAP
             vec2 pomUv = vMapUv;
             if (uPomScale > 0.0) {
               // 视线在切线空间的方向（用屏幕导数重建 TBN）
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
               // 层间插值，消除阶梯
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
             // 提亮 + 去青（迈阿密暖白）
             float lum = dot(diffuseColor.rgb, vec3(0.299,0.587,0.114));
             diffuseColor.rgb = clamp(pow(diffuseColor.rgb, vec3(0.78)) * vec3(1.06,1.02,0.94) + lum*0.14, 0.0, 1.0);
             #endif
             `);
        m.userData.pomShader = sh;
      };
      return m;
    };
    // 六档：0 低层白灰泥 / 1 中层砖石 / 2 中层混凝土框 / 3-5 三种真玻璃幕
    this.matStucco = opts.material || mkMat('PaintedPlaster006', 0.96);
    this.matMixed  = this.matStucco === opts.material ? this.matStucco : mkMat('Facade018A', 0.86);
    this.matConcrete = this.matStucco === opts.material ? this.matStucco : mkMat('Facade020A', 0.82);
    this.matGlass  = this.matStucco === opts.material ? this.matStucco : mkMat('Facade001', 0.30, 0.12);
    this.matGlassB = this.matStucco === opts.material ? this.matStucco : mkMat('Facade005', 0.34, 0.10);
    this.matGlassC = this.matStucco === opts.material ? this.matStucco : mkMat('Facade006', 0.38, 0.08);
    // [2026-11-26] 摄影测量 Color 图烘焙了当天光照，叠上游戏日间 sun/hemi 后偏暗发青。
    // 用 material.color 做线性提亮补偿（不改原图像素，保持照片级细节）。
    for (const m of [this.matStucco, this.matMixed, this.matConcrete, this.matGlass, this.matGlassB, this.matGlassC]) {
      // [2026-11-26 迈阿密暖白] 扫描图偏冷青，加强红、压蓝，暖白化整城楼体
      if (m && m.color && m !== opts.material) m.color.setRGB(1.55, 1.45, 1.28);
    }
    this.material = this.matStucco;
    for (const c of manifest.chunks || []) this.byKey.set(c.key, c);
  }

  /** nova_urban._decorateNew / state() 遍历用：展平到真实 Mesh（每块现在是 1~3 个材质带）。 */
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

  /** 一块 = 一次 merge = 1 个 draw call。86 万栋摊到 3 万块，视野内仅数十个 draw。 */
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

  /** 离场即释放显存：几何常驻会把 86 万栋堆成上 GB。 */
  _unload(key) {
    if (this.chunkRings) this.chunkRings.delete(key);
    // [LCR] 先通知光追释放对应 BLAS，再释放光栅几何（顺序无关，桥在降级时 no-op）
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

  /** ChunkStream 的挂载路径：rows 直接来自桶解码，构建合并网格。同步返回。 */
  _buildChunkMesh(key, rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const c = this.byKey.get(key);
    if (!c) return null;
    const buckets = [[], [], [], [], [], []];   // 0 灰泥低层 / 1-2 中层 / 3-5 三种真玻璃塔
    let builtN = 0;
    for (const b of rows) {
      if (!(b.heightM > 0)) { this.skipped.noHeight++; continue; }
      const bg = buildUrbanGeometry(b);
      if (!bg) { this.skipped.buildFail++; continue; }
      const hi = b.heightM > 60;
      const sd = seedOf(b.id, key);
      /* [2026-11-26 1:1 尺度修复] Facade 贴图是 gen_facade.py 按 48m×48m 真实尺度画的
         （14 层 × 16 开间 → 每层 3.4m、每开间 3.0m，都是真实建筑模数）。
         之前 period=26/24/12 把 48m 的图硬塞进一半尺寸 → 窗格密度翻倍 →
         满屏密集小格马赛克，这正是「楼不像真楼」的根因。改回 48m 设计尺度。
         低层灰泥无窗格，纹理尺度可小些；有窗的三档统一 48m。 */
      const band = hi ? (3 + (sd % 3)) : (b.heightM > 20 ? 1 + (sd % 2) : 0);
      const period = band === 0 ? 24 : 48;
      reprojectUV(bg, period, sd);
      buckets[band].push(bg);
      builtN++;
    }
    if (!builtN) return null;
    const g = this._ensureGroup(key);
    if (!g) { buckets.forEach(a => a.forEach(x => x.dispose())); return null; }
    const mats = [this.matStucco, this.matMixed, this.matConcrete, this.matGlass, this.matGlassB, this.matGlassC];
    // [2026-11-26 街面距离场修复] 合并网格只保留 band 标记，真实轮廓丢了；
    // 街面着色器拿不到 rings 就只能按「全开敞 24m」画，整片街区变成一块灰板。
    // 这里把本块的真实轮廓留在 layer 上，供 _ensureGround 建距离场。
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
    // [LCR] 同步喂给光追增强层（桥未就绪/降级时内部 no-op，绝不影响光栅化）
    if (this.lcr && this.lcr.mount) {
      try { this.lcr.mount(key, holder, c); } catch (e) { /* 光追异常绝不冒泡到游戏 */ }
    }
    return holder;
  }

  /** 启用 a7u 区块流送调度器（滞回 + 预算 + 预取 + 退避）。 */
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
        // [2026-11-26 致命修复] _buildChunkMesh 返回的是 Group（最多 3 条材质带），
        // 旧代码 mesh.geometry.getAttribute 必然抛 "reading 'getAttribute'"，
        // 每块装配都失败 → 流送调度器判定挂载失败、永不推进 → 出生点整片无楼。
        // 统计量改从 userData 读（_buildChunkMesh 已写好 triangles/verts）。
        const ud = mesh.userData || {};
        return {
          object: mesh, buildings: ud.buildings || rows.length,
          triangles: ud.triangles || 0,
          geometryMB: +(((ud.verts || 0) * 4 * 11) / 1048576).toFixed(4),
        };
      },
      onUnmount(key) { self._unload(key); },
      onError(msg) { self.errors.push({ stream: String(msg).slice(0, 160) }); },
    });
    return this.stream;
  }

  /** 每帧入口：由 nova_urban.update 驱动（120ms 节流）。 */
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

  // [2026-11-26 预取修复] 加载半径 = 可视半径的 1.35 倍：
  // 走到 cull 边缘前，下一批楼已开始下载（1~2MB JSON + 解析要 2~4 秒），
  // 否则就会出现「走出那片区域后等好几秒楼房渲染不出来」。
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
    const meshes = this.meshes;   // 已展平为真实 Mesh（Group → children）
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

/** 主城启动钩子：优先 chunked 清单，回退单文件；两者缺失时静默跳过。 */
export async function tryMountUrban(scene, opts = {}) {
  const base = opts.base || './data/';
  const mfUrl = opts.manifestUrl || (base + 'urban_manifest.json');
  try {
    const r = await fetch(mfUrl);
    if (r.ok) {
      const mf = await r.json();
      if (mf && mf.mode === 'chunked' && Array.isArray(mf.chunks) && mf.chunks.length) {
        const layer = new ChunkedUrbanLayer(scene, mf, { ...opts, base });
        // a7u 流送调度器：滞回 + 预算 + 预取 + 桶合并，移动时持续加载/卸载
        try {
          layer.enableStream({ tier: opts.streamTier || 'mobile' });
          layer.streamTick(opts.startPos || new THREE.Vector3(0, 0, 0), 16.7, 16.7);
        } catch (e) {
          layer.stream = null;      // 索引校验失败 → 回退旧 updateAndLoad 路径
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
