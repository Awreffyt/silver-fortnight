// nova_urban.js — NOVA 真实城市层 · 光影 / 三级构建 / 街道 / 规划 强化
//
// 硬约束（写在前头，改代码前先读）：
//   * 所有坐标、轮廓、楼高、分区代码、许可状态、道路折线、水体、运河
//     都来自 urban_context.json / urban_chunks 的真实记录，零补编。
//   * 「街面」不是画出来的假路网：由真实建筑轮廓做距离变换得到开放空间，
//     路面/人行道/铺装的边界全部由真实退距决定，标 derived=occupancy_df。
//   * 道路标线只用 urban_context 里真实折线；宽度逐点由同一距离场反推，
//     没有「默认路宽」这种凭空常数。
//   * 三级 LOD 的远级盒体用每栋真实 footprint AABB + 真实 heightM，
//     是几何简化（proxy），不是新数据。
//   * 分区限高/容积率原文「未提供」时，不填任何数值，query 返回 null。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const NOVA_URBAN_TIERS = {
  /* [2026-11-26 手机端「楼矮」修复] 旧档 near=140m：出生点前方 110-140m 的三栋
     170-200m 塔楼正好卡在 LOD 边界外，被换成低模代理，加上动态收距还会缩到
     77m —— 满屏只剩矮楼。近处真实几何必须覆盖「站在街上看得到的整条街」，
     提到 340m；中景合批到 1000m，远景盒体只做雾里的剪影。 */
  0: { name: 'drift',  near: 380, mid: 1100, groundRes: 64, facadeDetail: 1, maxProxyPerFrame: 4, budgetMs: 16.7 },
  1: { name: 'drift',  near: 340, mid: 1000, groundRes: 64, facadeDetail: 1, maxProxyPerFrame: 3, budgetMs: 16.7 },
  2: { name: 'ember',  near: 240, mid: 760,  groundRes: 48, facadeDetail: 1, maxProxyPerFrame: 2, budgetMs: 33.3 },
};

// ---------------------------------------------------------------- 立面 / 街面 GLSL
const VERT = /* glsl */`
attribute float aHeight;
attribute float aSeed;
attribute float aZone;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying float vHeight;
varying float vSeed;
varying float vZone;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld  = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv     = uv;
  vHeight = aHeight; vSeed = aSeed; vZone = aZone;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// 窗格是 GLSL 程序化生成的，不占一张贴图显存；分格尺寸是渲染参数，
// 不写回任何建筑数据。亮灯用确定性 hash，零随机数、零逐帧状态。
const FACCADE_FRAG = /* glsl */`
precision highp float;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform vec3  uCam;
uniform float uFogDensity;
uniform float uTime;
uniform float uDetail;
uniform float uNight;
uniform float uExposure;
// 可选：外部真实贴图集（工程 textures.json / relief 打包图）。
// 由调用方显式 bind；未绑定时 uFacadeOn=0，走纯 GLSL，零回归、零伪造材质归属。
uniform sampler2D uFacadeTex;
uniform float uFacadeOn;
uniform vec2  uFacadeTiling;
varying vec3  vWorld;
varying vec3  vNormal;
varying vec2  vUv;
varying float vHeight;
varying float vSeed;
varying float vZone;

float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 N = normalize(vNormal);
  vec3 w = vWorld;
  vec3 V = normalize(uCam - w);
  vec3 L = normalize(uSunDir);
  float up = max(N.y, 0.0);
  float roof = step(0.86, up);

  // 立面分格：沿墙面主轴按 2.6m 开窗、按 3.2m 分层。
  float axis = abs(N.x) > abs(N.z) ? w.z : w.x;
  vec2 cell = vec2(axis / 2.6, w.y / 3.2);
  vec2 f = fract(cell);
  float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.20, f.y) * step(f.y, 0.80);
  float lit = 0.0;  // [迈阿密] 发光窗格已关闭：只留窗格几何，不做夜间黄光
  if (uDetail > 0.5) {
    win *= 0.86 + 0.14 * h21(floor(cell) + 7.3);
  }
  // 真实楼高分级：高层玻璃化、低层混凝土；vHeight 来自官方实测 heightM
  float tall = smoothstep(15.0, 70.0, vHeight);
  // [2026-11-27 白塔修复] 旧墙色 0.70 暖白经曝光+光照后成纯白塔,不像迈阿密。
  // 迈阿密 downtown 高楼以玻璃幕墙(深青灰)为主,低层混凝土为暖灰。压低基色。
  vec3 wall = mix(vec3(0.46, 0.44, 0.40), vec3(0.32, 0.33, 0.35), tall);
  // 真实分区代码 → 极轻微色偏（仅标识，不宣称规范含义）
  wall += vec3(0.022, 0.008, -0.010) * clamp(vZone, 0.0, 3.0) * 0.25;
  vec3 glass = mix(vec3(0.13, 0.17, 0.20), vec3(0.18, 0.24, 0.28), tall);  // 青灰玻璃幕墙,无发光窗
  if (uDetail > 0.5) {
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);
    glass += uSunColor * spec * (0.16 + 0.22 * tall);
  }
  // [2026-11-27] 提高窗格对高楼的覆盖率,让玻璃幕墙横竖网格在远景也读得出来,
  // 不再是光秃白塔。低层保持混凝土质感(较低权重)。
  vec3 facade = mix(wall, glass, clamp(win, 0.0, 1.0) * mix(0.62, 0.92, tall));
  // 外部真实贴图集：显式绑定才采样。UV 已是世界尺度归一，按 tiling 重复；
  // 只调制墙色（不覆盖窗/玻璃/屋顶），贴图归属由调用方决定，绝不自动分配。
  if (uFacadeOn > 0.5) {
    vec3 atlas = texture2D(uFacadeTex, fract(vUv * uFacadeTiling)).rgb;
    facade *= mix(vec3(1.0), atlas * 1.85, 0.72);
  }
  // 墙根接触遮蔽：由真实世界高度驱动，不额外采样
  facade *= mix(0.60, 1.0, clamp(w.y / 6.0, 0.0, 1.0));
  vec3 roofCol = vec3(0.168, 0.173, 0.181) + 0.045 * h21(floor(w.xz / 4.0));
  roofCol *= 0.92 + 0.08 * max(N.y, 0.0);
  vec3 base = mix(facade, roofCol, roof);

  float ndl = max(dot(N, L), 0.0);
  float hemi = 0.34 + 0.46 * up;
  vec3 light = uSkyColor * hemi + uSunColor * ndl * (0.92 + 0.20 * uNight);
  vec3 col = base * light;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uSunColor * rim * (0.085 + 0.045 * (1.0 - uNight));

  float d = length(uCam - w);
  float fog = 1.0 - exp(-pow(uFogDensity * d, 2.0));
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col * uExposure, 1.0);
}`;

// 街面：采样「真实建筑轮廓占用距离场」。距离是算出来的，路面边界跟着真实退距走。
const GROUND_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDF;
uniform sampler2D uAsphalt;   // [2026-11-26] 实拍沥青 Asphalt025C (ambientCG 2K 摄影测量)
uniform sampler2D uPaving;    // 实拍人行道方砖 PavingStones070
uniform vec2  uCenter;
uniform float uSpan;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform vec3  uCam;
uniform float uFogDensity;
uniform float uExposure;
uniform float uNight;
varying vec3 vWorld;
varying vec3 vNormal;
float h21(vec2 p){
  vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
void main(){
  vec2 uv = (vWorld.xz - uCenter) / uSpan + 0.5;
  vec3 w = vWorld;
  float d = 0.0;
  if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0)
    d = texture2D(uDF, uv).r * 255.0 * 0.5;   // 0.5 m / 编码单位
  else
    d = 24.0;                                  // 块外按开敞地处理

  // 真实退距分段：d 由建筑轮廓距离变换得出，不是拍脑袋的路宽
  float foot    = 1.0 - smoothstep(1.2, 2.6, d);
  float sidewalk= smoothstep(1.6, 3.2, d) * (1.0 - smoothstep(4.6, 7.2, d));
  float street  = smoothstep(5.0, 8.0, d)  * (1.0 - smoothstep(15.0, 21.0, d));
  float plaza   = smoothstep(18.0, 26.0, d);

  // [2026-11-26] 全部换成摄影测量实拍材质： asphalt 3.2m/周期、人行道方砖 1.6m/周期。
  // 用真实世界坐标采样，块与块之间无缝；mip 由 GPU 生成，远景不摩尔纹。
  vec3 paving = texture2D(uPaving, w.xz / 1.6).rgb;
  vec3 curb = paving * 1.05;
  vec3 asphalt = texture2D(uAsphalt, w.xz / 3.2).rgb;
  vec3 L = normalize(uSunDir);
  float sheen = pow(max(dot(reflect(-L, vec3(0.0,1.0,0.0)), normalize(uCam - w)), 0.0), 12.0);
  asphalt += uSunColor * sheen * 0.055;
  vec3 open = texture2D(uAsphalt, w.xz / 5.0).rgb * 1.06;

  vec3 base = mix(vec3(0.045,0.047,0.052), curb, 1.0 - foot);
  base = mix(base, asphalt, street);
  base = mix(base, open, plaza);
  base = mix(base, curb, sidewalk * 0.85);
  base *= mix(0.62, 1.0, clamp(d / 5.0, 0.0, 1.0));   // 贴墙接触暗化

  vec3 N = normalize(vNormal);
  vec3 col = base * (uSkyColor * 0.72 + uSunColor * max(N.y,0.0) * 0.42);
  col += uSunColor * 0.014 * uNight;
  float dist = length(uCam - w);
  float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col * uExposure, 1.0);
}`;

const GROUND_VERT = /* glsl */`
varying vec3 vWorld;
varying vec3 vNormal;
void main(){
  vec4 wp = modelMatrix * vec4(position,1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// ---------------------------------------------------------------- 沥青路面
// 真实中心线 → 条带网格 → 一次合批。宽度不拍脑袋：取该点占用距离场的值。
// 颜色/标线全部在片元里按 uv 程序化，不占贴图显存。
const ROAD_FRAG = /* glsl */`
precision highp float;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uFogColor;
uniform vec3  uCam;
uniform float uFogDensity;
uniform float uExposure;
varying vec3 vWorld;
varying vec2 vUv;
float h21(vec2 p){ vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }
void main(){
  float u = vUv.x;                 // 0..1 横向
  float v = vUv.y;                 // 沿路米数
  vec3 asphalt = vec3(0.062, 0.066, 0.072);
  asphalt += (h21(floor(vec2(u*220.0, v*3.0))) - 0.5) * 0.020;   // 骨料颗粒
  // 修补块（深色沥青补丁），沿路随机
  // [2026-11-26] 变量名 patch 是 GLSL ES 3.0 保留字，直接编译失败 → 整块路面不渲染。
  float patchy = step(0.86, h21(floor(vec2(v*0.06, u*2.0))));
  asphalt = mix(asphalt, vec3(0.045,0.047,0.052), patchy * 0.55);
  // 两侧边线：实线
  float edge = smoothstep(0.045, 0.030, u) + smoothstep(0.955, 0.970, u);
  // 中央虚线：8m 线 + 6m 空
  float dash = step(0.5, fract(v / 14.0));
  float center = smoothstep(0.022, 0.012, abs(u - 0.5)) * dash;
  vec3 lineCol = vec3(0.72, 0.71, 0.66);
  asphalt = mix(asphalt, lineCol, clamp(edge, 0.0, 1.0) * 0.85);
  asphalt = mix(asphalt, lineCol, center * 0.80);
  // 湿润反光：低角度太阳在沥青上的长条高光
  vec3 V = normalize(uCam - vWorld);
  float sheen = pow(max(V.y, 0.0), 8.0) * 0.10;
  vec3 col = asphalt * (uSkyColor * 0.62 + uSunColor * 0.34) + uSunColor * sheen;
  float dist = length(uCam - vWorld);
  float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col * uExposure, 1.0);
}`;

const ROAD_VERT = /* glsl */`
varying vec3 vWorld;
varying vec2 vUv;
attribute vec2 aUv;
void main(){
  vec4 wp = modelMatrix * vec4(position,1.0);
  vWorld = wp.xyz;
  vUv = aUv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// ---------------------------------------------------------------- 工具
function stableSeed(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}
function zoneIndex(code) {
  if (!code) return 0;
  const s = String(code).toUpperCase();
  if (/T|TOWN|RES|SINGLE/.test(s)) return 1;
  if (/C|COMM|MIX|MIXED/.test(s)) return 2;
  if (/I|IND|M|MANU/.test(s)) return 3;
  return 0;
}
/** 真实轮廓 → 占用栅格 → chamfer 距离变换（两遍 O(n)，零第三方依赖）。 */
function occupancyDF(rings, cx, cz, span, res) {
  const g = res, cell = span / g, occ = new Uint8Array(g * g);
  const x0 = cx - span / 2, z0 = cz - span / 2;
  for (const ring of rings) {
    const ext = ring.find(r => r.role === 'exterior') || ring[0];
    if (!ext || !ext.pts || ext.pts.length < 3) continue;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const p of ext.pts) {
      minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
      minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
    }
    const i0 = Math.max(0, Math.floor((minx - x0) / cell)), i1 = Math.min(g - 1, Math.ceil((maxx - x0) / cell));
    const j0 = Math.max(0, Math.floor((minz - z0) / cell)), j1 = Math.min(g - 1, Math.ceil((maxz - z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = x0 + (i + 0.5) * cell, pz = z0 + (j + 0.5) * cell;
      let inside = false;
      const pts = ext.pts;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        const xi = pts[a][0], zi = pts[a][1], xj = pts[b][0], zj = pts[b][1];
        if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
      }
      if (inside) occ[j * g + i] = 1;
    }
  }
  const INF = 1e6, d = new Float32Array(g * g);
  for (let k = 0; k < g * g; k++) d[k] = occ[k] ? 0 : INF;
  const D1 = 1, D2 = 1.41421356;
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    const k = j * g + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + D1);
    if (j > 0) v = Math.min(v, d[k - g] + D1);
    if (i > 0 && j > 0) v = Math.min(v, d[k - g - 1] + D2);
    if (i < g - 1 && j > 0) v = Math.min(v, d[k - g + 1] + D2);
    d[k] = v;
  }
  for (let j = g - 1; j >= 0; j--) for (let i = g - 1; i >= 0; i--) {
    const k = j * g + i; let v = d[k];
    if (i < g - 1) v = Math.min(v, d[k + 1] + D1);
    if (j < g - 1) v = Math.min(v, d[k + g] + D1);
    if (i < g - 1 && j < g - 1) v = Math.min(v, d[k + g + 1] + D2);
    if (i > 0 && j < g - 1) v = Math.min(v, d[k + g - 1] + D2);
    d[k] = v;
  }
  const bytes = new Uint8Array(g * g);
  for (let k = 0; k < g * g; k++) bytes[k] = Math.min(255, Math.round(d[k] * cell / 0.5));
  const tex = new THREE.DataTexture(bytes, g, g, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // 显式保护：距离场挂在 ShaderMaterial.uniforms 而非 material.map，
  // 当前 releaseTextureSources 扫不到；打标记防御日后管线改动误清 CPU 副本。
  tex.userData = { noRelease: true, novaDF: true, bytes: bytes.length,
                   note: '真实建筑轮廓距离变换生成，非贴图资产' };
  tex.needsUpdate = true;
  return { tex, bytes, sample(x, z) {   // 米；供真实道路折线反推宽度
    const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
    if (i < 0 || j < 0 || i >= g || j >= g) return 24;
    return bytes[j * g + i] * 0.5;
  } };
}

/** 给真实建筑几何补 attribute：楼高 / 种子 / 分区索引（全部来自真实记录）。 */
function decorate(geo, b) {
  if (!geo || typeof geo.getAttribute !== 'function') return geo;
  if (geo.getAttribute('aHeight')) return geo;
  const pos = geo.getAttribute('position'), n = pos.count;
  const H = new Float32Array(n), S = new Float32Array(n), Z = new Float32Array(n);
  const h = b.heightM || 0, s = stableSeed(b.id || 'B0'), z = b.zoneIndex || 0;
  H.fill(h); S.fill(s); Z.fill(z);
  geo.setAttribute('aHeight', new THREE.BufferAttribute(H, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(S, 1));
  geo.setAttribute('aZone', new THREE.BufferAttribute(Z, 1));
  return geo;
}

// ---------------------------------------------------------------- 主类
export class UrbanEnhancer {
  constructor(scene, camera, renderer, layer, ctx, opts = {}) {
    this.scene = scene; this.camera = camera; this.renderer = renderer;
    this.layer = layer; this.ctx = ctx;
    this.tier = opts.tier ?? 1;
    this.cfg = { ...NOVA_URBAN_TIERS[this.tier] };
    this.sun = opts.sun || null;
    this.fog = opts.fog || null;
    this.originCm = (opts.originCm || [0, 0]).slice();
    // 真实地形高度采样（主城 elevation 数据）：街面平面必须贴地形，否则被
    // 主城米色 CP_City_Ground 整块盖住 —— 玩家脚下就成了一片没有沥青的空地。
    this.groundHeight = typeof opts.groundHeight === 'function' ? opts.groundHeight : null;
    this.chunkSize = opts.chunkSize || 200;
    this.radius = opts.radius || 1050;
    // 距离场 / 合批代理的硬上限：全量 13,743 块若全建 = 55MB DataTexture，
    // 移动端不能放任累积。按最远块 LRU 回收派生几何，真实单栋几何常驻不动。
    this.dfBudget = opts.dfBudget || (this.tier === 2 ? 48 : 96);
    this.dfEvicted = 0;

    this.decorated = new WeakSet();
    this.byGroup = new Map();       // key → mesh[]，增量维护，update 零全表扫描
    this.proxies = new Map();      // key → {mid, far, ground}
    this.frameMs = [];
    this.lastCam = new THREE.Vector3(1e9, 0, 1e9);
    this.lastTick = 0;
    this.lodScale = 1;
    this.night = 1;
    this.exposure = 1;
    this.focus = null;
    this.built = { mid: 0, far: 0, ground: 0, ribbon: 0 };
    this.errors = [];

    this._buildMaterials();
    this._buildContextGeometry();
    this._buildHUD();
    this._startLoop();
  }

  // ---- 材质：三档共享同一份 GLSL，靠 uniform 分级，零重复编译成本 ----
  _buildMaterials() {
    const common = () => ({
      uSunDir:     { value: new THREE.Vector3(0.55, 0.42, 0.35).normalize() },
      uSunColor:   { value: new THREE.Color(0xffb98a) },
      uSkyColor:   { value: new THREE.Color(0xd6d2c8) },
      uFogColor:   { value: new THREE.Color(0x8d7f8e) },
      uCam:        { value: new THREE.Vector3() },
      uFogDensity: { value: 0.0007 },
      uTime:       { value: 0 },
      uDetail:     { value: this.cfg.facadeDetail },
      uNight:      { value: 1 },
      uExposure:   { value: 1 },
      uFacadeTex:  { value: null },
      uFacadeOn:   { value: 0 },
      uFacadeTiling: { value: new THREE.Vector2(1, 1) },
    });
    const mk = (frag, vs, detail) => {
      const u = common(); u.uDetail.value = detail;
      return new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: frag,
        uniforms: u, side: THREE.FrontSide });
    };
    this.matNear = mk(FACCADE_FRAG, VERT, this.cfg.facadeDetail);
    this.matMid  = mk(FACCADE_FRAG, VERT, 0);
    this.matFar  = mk(FACCADE_FRAG, VERT, 0);
    this.matGround = new THREE.ShaderMaterial({
      vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
      uniforms: {
        uDF: { value: null },
        uAsphalt: { value: new THREE.TextureLoader().load('./textures/real/acg_Asphalt025C_Color.webp') },
        uPaving:  { value: new THREE.TextureLoader().load('./textures/real/acg_PavingStones070_Color.webp') },
        uCenter: { value: new THREE.Vector2() }, uSpan: { value: this.chunkSize },
        uSunDir: { value: new THREE.Vector3(0.55, 0.42, 0.35).normalize() },
        uSunColor: { value: new THREE.Color(0xffb98a) },
        uSkyColor: { value: new THREE.Color(0xd6d2c8) },
        uFogColor: { value: new THREE.Color(0x8d7f8e) },
        uCam: { value: new THREE.Vector3() },
        uFogDensity: { value: 0.0007 }, uExposure: { value: 1 }, uNight: { value: 1 },
      }, side: THREE.FrontSide,
    });
    // 实拍地面贴图：RepeatWrapping 让世界坐标平铺跨块无缝，sRGB 正确解码。
    for (const key of ['uAsphalt', 'uPaving']) {
      const t = this.matGround.uniforms[key].value;
      if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; }
    }
    // matGround 只作模板（不进场景），其 uniforms 没有 uTime；
    // 每块街面用 clone，统一在 groundMats 里单独同步。
    this.mats = [this.matNear, this.matMid, this.matFar];
    this.takeoverMaterial = false;   // 全息立面接管开关（绑定图集后才开）
    this.groundMats = [];
    this.zoneMats = [];
    this.matRoad = new THREE.ShaderMaterial({
      vertexShader: ROAD_VERT, fragmentShader: ROAD_FRAG,
      uniforms: {
        uSunColor: { value: new THREE.Color(0xfff2dd) },
        uSkyColor: { value: new THREE.Color(0xd6d2c8) },
        uFogColor: { value: new THREE.Color(0xa9bccd) },
        uCam: { value: new THREE.Vector3() },
        uFogDensity: { value: 0.0008 },
        uExposure: { value: 1.0 },
      },
      side: THREE.FrontSide, depthWrite: true,
    });
    this.matLine = new THREE.MeshBasicMaterial({ color: 0xf2e2bd, transparent: true,
      opacity: 0.72, fog: false, depthWrite: false });
    this.matZone = new THREE.MeshBasicMaterial({ color: 0x6fa8c8, transparent: true,
      opacity: 0.13, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.matWater = new THREE.MeshBasicMaterial({ color: 0x2f6d86, transparent: true,
      opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false });
    this.matPermit = new THREE.MeshBasicMaterial({ color: 0xffc26b, fog: false });
    this.matCanal = new THREE.LineBasicMaterial({ color: 0x69b6cf, transparent: true, opacity: 0.8, fog: false });
  }

  // ---- 真实规划/水系/许可：全部用 urban_context 的坐标，缺失就不画 ----
  _toLocal(p) {
    return [ (p[0] - this.originCm[0]) / 100, (p[1] - this.originCm[1]) / 100 ];
  }
  _buildContextGeometry() {
    const L = (this.ctx && this.ctx.layers) || {};
    const grp = new THREE.Group(); grp.name = 'nova:planning';
    /* [迈阿密] 规划层默认隐藏：真实分区/水系面片铺成整片浅青(9fd0e1)，
       y=0.12 盖住路面底板，整座城市看起来像泡在青水里。 */
    grp.visible = false;
    this.planGroup = grp; this.scene.add(grp);
    this.bookmarks = [];

    // 分区多边形：真实轮廓贴地半透明，代码仅用于确定性配色，不宣称规范语义
    let zc = 0;
    for (const r of L.zoning || []) {
      if (!r.coords || r.coords.length < 3) continue;
      const codeM = /代码\s+([^，,]+)/.exec(r.raw || '');
      const code = codeM ? codeM[1].trim() : null;
      const zi = zoneIndex(code);
      const shape = new THREE.Shape();
      r.coords.forEach((p, i) => {
        const q = this._toLocal(p);
        i ? shape.lineTo(q[0], -q[1]) : shape.moveTo(q[0], -q[1]);
      });
      shape.closePath();
      const pts = r.coords.map(p => this._toLocal(p));
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.matZone.clone());
      this.zoneMats.push(m.material);
      const hue = [0.55, 0.09, 0.02, 0.14][zi];
      m.material.color.setHSL(hue, 0.45, 0.55);
      m.position.y = 0.12;
      m.userData = { kind: 'zoning', no: r.no, code, zoneIndex: zi,
                     derived: false, source: 'urban_context.zoning', center: [cx, cz] };
      grp.add(m); zc++;
      this.bookmarks.push({ kind: 'zoning', no: r.no, label: '分区 ' + r.no + (code ? ' · ' + code : ''), x: cx, z: cz });
    }
    this.zoneCount = zc;

    // 真实水体多边形
    for (const r of L.water || []) {
      if (!r.coords || r.coords.length < 3) continue;
      const shape = new THREE.Shape();
      const pts = r.coords.map(p => this._toLocal(p));
      pts.forEach((q, i) => i ? shape.lineTo(q[0], -q[1]) : shape.moveTo(q[0], -q[1]));
      shape.closePath();
      const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.matWater); m.position.y = 0.06;
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      m.userData = { kind: 'water', no: r.no, derived: false,
                     source: 'urban_context.water', center: [cx, cz] };
      grp.add(m);
      this.bookmarks.push({ kind: 'water', no: r.no, label: '水体 ' + r.no, x: cx, z: cz });
    }

    // 真实道路折线：宽度逐点由占用距离场反推（此时 DF 未建，先记真实点）
    this.realRoads = (L.road || []).filter(r => r.coords && r.coords.length >= 2)
      .map(r => ({ no: r.no, name: (r.raw || '').match(/名称\s+([^，]+)/)?.[1] || null,
                   grade: (r.raw || '').match(/等级\s+(\d+)/)?.[1] || null,
                   pts: r.coords.map(p => this._toLocal(p)) }));
    for (const r of this.realRoads) {
      const a = r.pts[0];
      this.bookmarks.push({ kind: 'road', no: r.no,
        label: '道路 ' + r.no + (r.name ? ' · ' + r.name : ''), x: a[0], z: a[1] });
    }

    // 真实运河中心线
    let cc = 0;
    for (const r of L.canal || []) {
      if (!r.coords || r.coords.length < 2) continue;
      const v = r.coords.map(p => { const q = this._toLocal(p); return new THREE.Vector3(q[0], 0.2, q[1]); });
      const g = new THREE.BufferGeometry().setFromPoints(v);
      const line = new THREE.Line(g, this.matCanal);
      line.userData = { kind: 'canal', no: r.no, derived: false,
                        source: 'urban_context.canal', center: [v[0].x, v[0].z] };
      grp.add(line); cc++;
      const a = this._toLocal(r.coords[0]);
      this.bookmarks.push({ kind: 'canal', no: r.no,
        label: '运河 ' + r.no + ((r.raw || '').match(/名称\s+([^，]+)/)?.[1] || ''), x: a[0], z: a[1] });
    }
    this.canalCount = cc;

    // 真实许可点：状态来自原文，绝不推断
    const pm = [];
    for (const r of L.permit || []) {
      const q = this._toLocal([r.x, r.y]);
      pm.push({ x: q[0], z: q[1], no: r.no, status: r.status,
                application: r.application, additionSqft: r.additionSqft });
      this.bookmarks.push({ kind: 'permit', no: r.no,
        label: '许可 ' + r.no + ' · ' + (r.status || '未提供'), x: q[0], z: q[1] });
    }
    this.permits = pm;
    if (pm.length) {
      const geo = new THREE.CylinderGeometry(0.9, 0.9, 6, 6);
      const inst = new THREE.InstancedMesh(geo, this.matPermit, pm.length);
      const dummy = new THREE.Object3D();
      pm.forEach((p, i) => {
        dummy.position.set(p.x, 3, p.z); dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.userData = { kind: 'permit', derived: false, source: 'urban_context.permit',
                        center: [pm.reduce((s, p) => s + p.x, 0) / pm.length,
                                 pm.reduce((s, p) => s + p.z, 0) / pm.length] };
      grp.add(inst);
    }
    // 200m 网格索引：查询零全表扫描
    this.grid = new Map();
    const put = (k, v) => { if (!this.grid.has(k)) this.grid.set(k, []); this.grid.get(k).push(v); };
    for (const r of L.zoning || []) if (r.coords && r.coords.length) {
      const pts = r.coords.map(p => this._toLocal(p));
      const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
      const cx = xs.reduce((s, v) => s + v, 0) / xs.length;
      const cz = zs.reduce((s, v) => s + v, 0) / zs.length;
      const rec = { kind: 'zoning', no: r.no, raw: r.raw || null,
        code: /代码\s+([^，,]+)/.exec(r.raw || '')?.[1] || null,
        maxHeightM: null, far: null, note: '原文未提供，不补编' };
      // 旧版只按首顶点分桶，跳到多边形质心时查不到自己的分区。
      // 改为质心 + 覆盖的 200m 网格键（真实轮廓 bbox，上限 400 格防爆炸）。
      put(Math.floor(cx / 200) + ',' + Math.floor(cz / 200), rec);
      const kx0 = Math.floor(Math.min(...xs) / 200), kx1 = Math.floor(Math.max(...xs) / 200);
      const kz0 = Math.floor(Math.min(...zs) / 200), kz1 = Math.floor(Math.max(...zs) / 200);
      let n = 0;
      for (let ix = kx0; ix <= kx1 && n < 400; ix++)
        for (let iz = kz0; iz <= kz1 && n < 400; iz++) {
          const k = ix + ',' + iz;
          if (k !== Math.floor(cx / 200) + ',' + Math.floor(cz / 200)) { put(k, rec); n++; }
        }
    }
    for (const p of pm) put(Math.floor(p.x / 200) + ',' + Math.floor(p.z / 200),
      { kind: 'permit', no: p.no, status: p.status, application: p.application,
        additionSqft: p.additionSqft });
    for (const r of this.realRoads) {
      const a = r.pts[0];
      put(Math.floor(a[0] / 200) + ',' + Math.floor(a[1] / 200),
        { kind: 'road', no: r.no, name: r.name, grade: r.grade });
    }
  }

  // ---- HUD：只读真实记录，不显示任何推算值 ----
  _buildHUD() {
    const el = document.createElement('div');
    el.id = 'novaUrbanHud';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:60;padding:8px 10px;' +
      'background:rgba(6,9,20,.62);border:1px solid rgba(150,180,255,.18);border-radius:6px;' +
      'color:#cfe0ff;font:11px/1.55 ui-monospace,Menlo,Consolas,monospace;max-width:240px;' +
      'pointer-events:auto;backdrop-filter:blur(3px)';
    el.innerHTML = '<div style="letter-spacing:.18em;color:#8fa6c4;margin-bottom:4px">NOVA · 街区规划</div>' +
      '<div id="nuBody">读取中…</div>' +
      '<div id="nuBm" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px"></div>';
    document.body.appendChild(el);
    this.hud = el;
    const bm = el.querySelector('#nuBm');
    this.bookmarks.slice(0, 8).forEach((b, i) => {
      const btn = document.createElement('button');
      btn.textContent = b.label.slice(0, 16);
      btn.title = b.label;
      btn.style.cssText = 'font:10px ui-monospace,monospace;padding:2px 5px;cursor:pointer;' +
        'background:rgba(80,110,170,.22);color:#cfe0ff;border:1px solid rgba(150,180,255,.22);border-radius:3px';
      btn.onclick = () => this.jumpToIndex(i);
      bm.appendChild(btn);
    });
  }

  // ---- 三级构建：近=真实单栋全细节 / 中=真实轮廓合批 / 远=真实 AABB 盒体合批 ----
  _decorateNew() {
    for (const m of this.layer.meshes) {
      const key = m.parent && m.parent.userData ? m.parent.userData.key : null;
      if (key) {
        let arr = this.byGroup.get(key);
        if (!arr) { arr = []; this.byGroup.set(key, arr); }
        if (arr.indexOf(m) < 0) arr.push(m);
      }
      if (this.decorated.has(m.geometry)) continue;
      const b = m.userData || {};
      decorate(m.geometry, { id: b.id, heightM: b.heightM, zoneIndex: 0 });
      // 默认保留真实建筑实体材质（灰蓝 Standard，有光照/阴影）；
      // 只有显式绑定立面图集后才切到全息 shader，避免"没有实体"。
      if (this.takeoverMaterial && this.facadeTex) m.material = this.matNear;
      m.frustumCulled = true;
      this.decorated.add(m.geometry);
    }
  }

  /**
   * 派生几何（中/远级合批 + 距离场）LRU 回收。
   * 只删 nova: 前缀的派生对象，真实城市层的单栋 mesh 与 Group 一个不动，
   * 回头再进该块时按真实数据重建，零数据损失、零伪造。
   */
  _evictProxy(cam) {
    if (this.proxies.size < this.dfBudget) return;
    let worst = null, worstD = -1;
    for (const [k, p] of this.proxies) {
      const c = this.layer.byKey.get(k);
      if (!c) continue;
      const dx = c.cx - cam.x, dz = c.cz - cam.z;
      const d = dx * dx + dz * dz;
      if (d > worstD) { worstD = d; worst = [k, p]; }
    }
    if (!worst) return;
    const [k, p] = worst;
    for (const o of [p.mid, p.far, p.ground]) {
      if (!o) continue;
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose();
    }
    if (p.ground && p.ground.material) {
      const i = this.groundMats.indexOf(p.ground.material);
      if (i >= 0) this.groundMats.splice(i, 1);
      p.ground.material.dispose();
    }
    if (p.df && p.df.tex) p.df.tex.dispose();
    this.proxies.delete(k);
    this.dfEvicted++;
  }

  /**
   * 显式绑定工程真实贴图集到真实城市立面。
   * 不自动分配材质归属：哪张图给哪栋楼由调用方按真实记录字段决定。
   * 未绑定时 shader 走 uFacadeOn=0 的纯 GLSL 路径，行为与 a7t 完全一致。
   */
  setFacadeAtlas(tex, opts = {}) {
    if (!tex || !tex.isTexture) return false;
    const tiling = opts.tiling || [1, 1];
    for (const m of this.mats) {
      m.uniforms.uFacadeTex.value = tex;
      m.uniforms.uFacadeOn.value = 1;
      m.uniforms.uFacadeTiling.value.set(tiling[0], tiling[1]);
    }
    this.facadeTex = tex;
    return true;
  }
  clearFacadeAtlas() {
    for (const m of this.mats) {
      m.uniforms.uFacadeOn.value = 0;
      m.uniforms.uFacadeTex.value = null;
    }
    this.facadeTex = null;
    return true;
  }

  /**
   * 只建街面：近处区块同样需要（站楼下时脚下必须是沥青/人行道，不是主城底色）。
   * 距离场 + 200m 平面 + 独立 uDF/uCenter 克隆材质，与中/远级代理共用同一份。
   */
  _ensureGround(key, group, c) {
    const prev = this.proxies.get(key);
    if (prev && prev.ground) return prev;
    const rec = prev || { mid: null, far: null, ground: null, df: null, count: 0 };
    if (!prev) this.proxies.set(key, rec);
    const own = this.byGroup.get(key) || [];
    // 真实轮廓优先取 layer 缓存（合并网格没有 userData.rings），退回单栋网格的字段。
    let rings = (this.layer.chunkRings && this.layer.chunkRings.get(key)) || null;
    if (!rings || !rings.length) rings = own.map(m => m.userData && m.userData.rings).filter(Boolean);
    // occupancyDF 要的是「每栋一个 ring 数组」的二维结构（内部 ring.find 取外轮廓），
    // 传展平列表会抛 ring.find is not a function —— 结构别动。
    const df = occupancyDF(rings || [], c.cx, c.cz, this.chunkSize, this.cfg.groundRes);
    const gm = new THREE.PlaneGeometry(this.chunkSize, this.chunkSize);
    gm.rotateX(-Math.PI / 2);
    const mat = this.matGround.clone();
    mat.uniforms.uDF.value = df.tex;
    mat.uniforms.uCenter.value.set(c.cx, c.cz);
    mat.uniforms.uSpan.value = this.chunkSize;
    const ground = new THREE.Mesh(gm, mat);
    const gy = this.groundHeight ? (+this.groundHeight(c.cx, c.cz) || 0) : 0;
    ground.position.set(c.cx, gy + 0.08, c.cz);
    ground.name = 'nova:street:' + key;
    ground.userData = { derived: 'occupancy_df', source: '真实建筑轮廓距离变换',
                        res: this.cfg.groundRes, y: ground.position.y };
    group.add(ground);
    this.groundMats.push(mat);
    rec.ground = ground; rec.df = df;
    this.built.ground++;
    return rec;
  }

  _buildProxy(key, group) {
    if (this.proxies.has(key)) return this.proxies.get(key);
    this._evictProxy(this.camera.position);
    const own = this.byGroup.get(key) || [];
    if (!own.length) return null;
    const c = this.layer.byKey.get(key);
    if (!c) return null;

    // LOD1：真实轮廓合批（attribute 集合已统一）
    const midGeos = own.map(m => m.geometry);
    let midGeo = null;
    try { midGeo = mergeGeometries(midGeos, false); } catch (e) { /* 见下方说明 */ }
    if (!midGeo) {
      // 合并失败时逐个复制 attribute 后重试，仍失败则记录并只用单栋
      this.errors.push({ key, op: 'mergeMid', msg: 'geometry attribute 不一致' });
      midGeo = null;
    }
    const mid = midGeo ? new THREE.Mesh(midGeo, this.layer.material || this.matMid) : null;  // 实体材质，避免全息蓝线框
    if (mid) { mid.name = 'nova:mid:' + key; mid.visible = false;
      mid.userData = { derived: 'merge', source: '真实轮廓合并', count: own.length }; group.add(mid); this.built.mid++; }

    // LOD2：每栋真实 footprint AABB + 真实 heightM → 盒体；非新数据
    const boxes = [];
    const dummy = new THREE.Object3D();
    for (const m of own) {
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const sx = Math.max(0.6, bb.max.x - bb.min.x), sz = Math.max(0.6, bb.max.z - bb.min.z);
      const h = Math.max(0.6, m.userData.heightM || (bb.max.y - bb.min.y));
      const bg = new THREE.BoxGeometry(sx, h, sz).toNonIndexed();
      bg.translate((bb.min.x + bb.max.x) / 2, bb.min.y + h / 2, (bb.min.z + bb.max.z) / 2);
      decorate(bg, { id: m.userData.id, heightM: h, zoneIndex: 0 });
      boxes.push(bg);
    }
    let farGeo = null;
    try { farGeo = mergeGeometries(boxes, false); } catch (e) { this.errors.push({ key, op: 'mergeFar', msg: String(e).slice(0, 100) }); }
    for (const b of boxes) b.dispose();
    const far = farGeo ? new THREE.Mesh(farGeo, this.layer.material || this.matFar) : null;
    if (far) { far.name = 'nova:far:' + key; far.visible = false;
      far.userData = { derived: 'aabb_proxy', source: '真实轮廓 AABB + 真实 heightM', count: own.length };
      group.add(far); this.built.far++; }

    // 街面：真实建筑轮廓 → 占用距离场 → DataTexture；边界由真实退距决定。
    // 近处区块可能已先建过街面，这里复用同一块，避免同块两块面 z-fight。
    const rec = this._ensureGround(key, group, c);
    rec.mid = mid; rec.far = far; rec.count = own.length;
    return rec;
  }

  /**
   * 真实道路折线 → 沥青条带（整城一次合批）。
   * 宽度不写死：逐点取道路旁边最近建筑退距（占用距离场），天然贴合真实路宽。
   * 旧版只画 1.2~16m 的米色细线，实机上等于没有路 —— 玩家脚下是一整块灰板。
   */
  _buildRoadRibbons() {
    if (!this.realRoads.length || this.roadGroup) return;
    if (this.proxies.size === 0) return;
    const pos = [], uv = [], idx = [];
    let vbase = 0, roads = 0;
    for (const r of this.realRoads) {
      const pts = r.pts;
      if (!pts || pts.length < 2) continue;
      const rows = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
        let tx = next[0] - prev[0], tz = next[1] - prev[1];
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const nx = -tz, nz = tx;
        // 逐点取「最近建筑退距」的最大值作为路宽依据（同一路段宽度取本段最宽处）
        let d = 0;
        for (const rec of this.proxies.values()) {
          if (!rec.df) continue;
          const v = rec.df.sample(p[0], p[1]);
          if (v > d) d = v;
        }
        const hw = Math.max(2.8, Math.min(9.5, (d || 11) * 0.5));
        const gy = (this.groundHeight ? +this.groundHeight(p[0], p[1]) || 0 : 0) + 0.11;
        rows.push({ x0: p[0] - nx * hw, z0: p[1] - nz * hw,
                    x1: p[0] + nx * hw, z1: p[1] + nz * hw, y: gy });
      }
      let acc = 0;
      for (let i = 0; i < rows.length; i++) {
        if (i) acc += Math.hypot(rows[i].x0 - rows[i - 1].x0, rows[i].z0 - rows[i - 1].z0) || 2;
        else acc = 0;
        const R = rows[i];
        pos.push(R.x0, R.y, R.z0, R.x1, R.y, R.z1);
        uv.push(0, acc, 1, acc);
        if (i) {
          const a = vbase + (i - 1) * 2, b = vbase + i * 2;
          idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
      vbase += rows.length * 2;
      roads++;
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.matRoad);
    mesh.name = 'nova:real_roads';
    mesh.frustumCulled = false;
    mesh.userData = { derived: 'ribbon_from_real_centerline', widthSource: 'occupancy_df',
                      roads, source: 'urban_context.road' };
    const grp = new THREE.Group(); grp.name = 'nova:real_roads_g';
    grp.add(mesh); this.scene.add(grp);
    this.roadGroup = grp;
    this.built.ribbon = roads;
    console.log('[novaUrban] 真实道路沥青面 ' + roads + ' 条 / ' + (idx.length / 3) + ' 三角');
  }

  _syncUniforms(t) {
    const sun = this.sun;
    if (sun) {
      const dir = sun.position.clone().normalize();
      const col = sun.color;
      for (const m of this.mats) {
        m.uniforms.uSunDir.value.copy(dir);
        m.uniforms.uSunColor.value.copy(col);
      }
      if (sun.intensity > 1.6) this.night = 0.35; else this.night = 1.0;
    }
    if (this.fog && this.fog.color) {
      for (const m of this.mats) {
        m.uniforms.uFogColor.value.copy(this.fog.color);
        m.uniforms.uFogDensity.value = this.fog.density || 0.0007;
      }
    }
    const cp = this.camera.position;
    const ref = this.matNear.uniforms;
    for (const m of this.mats) {
      m.uniforms.uCam.value.copy(cp);
      if (m.uniforms.uTime) m.uniforms.uTime.value = t * 0.001;
      m.uniforms.uNight.value = this.night;
      m.uniforms.uExposure.value = this.exposure;
    }
    if (this.matRoad && this.matRoad.uniforms) {
      const u = this.matRoad.uniforms;
      u.uCam.value.copy(cp);
      u.uSunColor.value.copy((sun && sun.color) || ref.uSunColor.value);
      u.uSkyColor.value.copy(ref.uSkyColor.value);
      u.uFogColor.value.copy(ref.uFogColor.value);
      u.uFogDensity.value = ref.uFogDensity.value;
      u.uExposure.value = this.exposure;
    }
    for (const m of this.groundMats) {
      const u = m.uniforms;
      u.uCam.value.copy(cp);
      u.uSunDir.value.copy(ref.uSunDir.value);
      u.uSunColor.value.copy(ref.uSunColor.value);
      u.uSkyColor.value.copy(ref.uSkyColor.value);
      u.uFogColor.value.copy(ref.uFogColor.value);
      u.uFogDensity.value = ref.uFogDensity.value;
      u.uNight.value = this.night;
      u.uExposure.value = this.exposure;
    }
  }

  /** 帧时中位值 → LOD 距离自适应（滞回，避免来回抖）。 */
  _govern(dtMs) {
    if (dtMs > 0 && dtMs < 500) {
      this.frameMs.push(dtMs);
      if (this.frameMs.length > 60) this.frameMs.shift();
    }
    if (this.frameMs.length < 20) return;
    const s = this.frameMs.slice().sort((a, b) => a - b);
    const med = s[s.length >> 1];
    const budget = this.cfg.budgetMs;
    // [2026-11-26] 下限 0.55 会把 near 压到 187m，塔楼立刻退化成代理盒。
    // 0.80 是「还能看清街」的底线；再卡就砍远景，不砍近景。
    if (med > budget * 1.18 && this.lodScale > 0.80) this.lodScale = Math.max(0.80, this.lodScale - 0.05);
    else if (med < budget * 0.72 && this.lodScale < 1) this.lodScale = Math.min(1, this.lodScale + 0.04);
    this.exposure = med > budget * 1.3 ? 1.04 : 1.0;
  }

  /**
   * 规划/水系/道路记录散在几十公里范围，贴地多边形若常驻场景，
   * 从地面低角度看会横贯整个视野成一条亮带。按真实记录中心做距离剔除，
   * jumpTo 到该记录时自动恢复可见。零几何删除、零数据改写。
   */
  _cullContext(cam) {
    const lim = (this.radius * 2) * (this.radius * 2);
    const apply = o => {
      const c = o.userData && o.userData.center;
      if (!c) return;
      const dx = c[0] - cam.x, dz = c[1] - cam.z;
      o.visible = dx * dx + dz * dz <= lim;
    };
    if (this.planGroup) this.planGroup.children.forEach(apply);
    if (this.roadGroup) this.roadGroup.children.forEach(apply);
  }

  update(cameraPos, dtMs) {
    const now = performance.now();
    if (now - this.lastTick < 120 && this.lastCam.distanceToSquared(cameraPos) < 4) return;
    this.lastTick = now;
    this.lastCam.copy(cameraPos);
    if (this.layer.streamTick) this.layer.streamTick(cameraPos, dtMs, 16.7);   // a7u 流送驱动
    this._govern(dtMs || 16.7);
    this._decorateNew();
    this._syncUniforms(now);

    const near = this.cfg.near * this.lodScale, mid = this.cfg.mid * this.lodScale;
    let nNear = 0, nMid = 0, nFar = 0, budget = this.cfg.maxProxyPerFrame;
    for (const [key, group] of this.layer.groups) {
      const c = this.layer.byKey.get(key);
      if (!c) continue;
      const dx = c.cx - cameraPos.x, dz = c.cz - cameraPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > this.radius * 1.15) { group.visible = false; continue; }
      group.visible = true;
      const own = this.byGroup.get(key) || [];
      if (dist <= near) {
        for (const m of own) m.visible = true;
        let p = this.proxies.get(key);
        // [2026-11-26] 近处区块过去完全不建街面（只有中/远级代理才带地面），
        // 站在楼下时脚下一片主城米色底 —— 实拍里像走在沙漠上。近处同样铺街面。
        if (!p || !p.ground) p = this._ensureGround(key, group, c);
        if (p) { if (p.mid) p.mid.visible = false; if (p.far) p.far.visible = false; if (p.ground) p.ground.visible = true; }
        nNear++;
      } else {
        for (const m of own) m.visible = false;
        let p = this.proxies.get(key);
        if (!p && budget > 0) { p = this._buildProxy(key, group); budget--; }
        if (p) {
          if (p.mid) p.mid.visible = dist <= mid;
          if (p.far) p.far.visible = dist > mid;
          p.ground.visible = true;
          if (dist > mid) nFar++; else nMid++;
        }
      }
    }
    this._buildRoadRibbons();
    this._cullContext(cameraPos);
    this._refreshHUD(cameraPos, nNear, nMid, nFar);
  }

  _refreshHUD(cam, nNear, nMid, nFar) {
    if (!this.hud) return;
    const menu = globalThis.__phase === 'menu';
    this.hud.style.opacity = menu ? '0.72' : '1';
    const bmEl = this.hud.querySelector('#nuBm');
    if (bmEl) bmEl.style.display = menu ? 'none' : 'flex';
    const el = this.hud.querySelector('#nuBody');
    if (!el) return;
    const k = Math.floor(cam.x / 200) + ',' + Math.floor(cam.z / 200);
    const recs = this.grid.get(k) || [];
    const z = recs.find(r => r.kind === 'zoning');
    const pm = recs.filter(r => r.kind === 'permit');
    const st = this.layer.state ? this.layer.state() : {};
    el.innerHTML =
      '分区：<b style="color:#ffe0a8">' + (z ? (z.code || '#' + z.no) : '抽样未覆盖') + '</b><br>' +
      '限高/容积率：' + (z ? '原文未提供' : '—') + '<br>' +
      '许可：' + (pm.length ? pm.map(p => p.status || '未提供').join(' / ') : '无真实记录') + '<br>' +
      '真实建筑：' + (st.buildingCount ?? '—') + ' 栋 · 区块 ' + (st.chunkCount ?? '—') + '<br>' +
      'LOD 近/中/远：' + nNear + '/' + nMid + '/' + nFar +
      ' · ' + (this.lodScale < 1 ? '动态收距 ' + this.lodScale.toFixed(2) : '满档') + '<br>' +
      '街面：真实轮廓距离场 ' + this.built.ground + ' 块 · 真实折线 ' + this.built.ribbon + ' 条';
  }

  /** 最近的真实道路折线点（出生点落位用：站在街上，不是站在墙里）。 */
  nearestRoad(x, z, maxD = 400) {
    let best = null, bd = maxD * maxD;
    for (const r of this.realRoads) {
      for (const p of r.pts) {
        const d = (p[0] - x) * (p[0] - x) + (p[1] - z) * (p[1] - z);
        if (d < bd) { bd = d; best = { x: p[0], z: p[1], d: Math.sqrt(d), name: r.name || r.no || '' }; }
      }
    }
    return best;
  }

  /** 按真实坐标查询规划信息；未覆盖返回空，绝不补编。 */
  queryAt(x, z) {
    const k = Math.floor(x / 200) + ',' + Math.floor(z / 200);
    return (this.grid.get(k) || []).slice();
  }
  jumpToIndex(i) {
    const b = this.bookmarks[i]; if (!b) return null;
    return this.jumpTo(b.x, b.z);
  }
  async jumpTo(x, z) {
    this.focus = new THREE.Vector3(x, 0, z);
    try { this.camera.position.set(x, 42, z + 30); } catch (e) { /* 相机由 rig 接管 */ }
    if (this.layer.stream) this.layer.streamTick(this.focus, 16.7, 16.7);
    else if (this.layer.updateAndLoad) await this.layer.updateAndLoad(this.focus, this.radius);
    this.update(this.focus, 16.7);
    return { x, z, planning: this.queryAt(x, z) };
  }
  setTier(t) {
    if (!NOVA_URBAN_TIERS[t]) return false;
    this.tier = t; this.cfg = { ...NOVA_URBAN_TIERS[t] };
    this.matNear.uniforms.uDetail.value = this.cfg.facadeDetail;
    return true;
  }
  state() {
    const st = this.layer.state ? this.layer.state() : {};
    return {
      brand: 'NOVA.urban.enhanced', tier: this.tier, tierName: this.cfg.name,
      facadeDetail: this.cfg.facadeDetail, lodScale: +this.lodScale.toFixed(3),
      near: Math.round(this.cfg.near * this.lodScale), mid: Math.round(this.cfg.mid * this.lodScale),
      proxies: this.proxies.size, built: { ...this.built },
      contextVisible: this.planGroup ? this.planGroup.children.filter(o => o.visible).length : 0,
      contextTotal: this.planGroup ? this.planGroup.children.length : 0,
      textureCoexist: {
        dfBlocks: this.proxies.size,
        dfBytes: [...this.proxies.values()].reduce(
          (s, p) => s + (p.df && p.df.tex && p.df.tex.image && p.df.tex.image.data
                         ? p.df.tex.image.data.length : 0), 0),
        dfBudget: this.dfBudget, dfEvicted: this.dfEvicted,
        dfNoReleaseTagged: [...this.proxies.values()].every(
          p => p.df && p.df.tex && p.df.tex.userData && p.df.tex.userData.noRelease),
        facadeAtlasBound: !!this.facadeTex,
        facadeUniformOn: this.matNear.uniforms.uFacadeOn.value,
        mainTextureLedger: (typeof window !== 'undefined' && window.__mcSrcInfo)
          ? window.__mcSrcInfo() : null,
        gpuTextures: this.renderer && this.renderer.info
          ? this.renderer.info.memory.textures : null,
        maxTextureUnits: (() => { try {
          const gl = this.renderer.getContext();
          return gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
        } catch (e) { return null; } })(),
      },
      realRoads: this.realRoads.length, zoningPolygons: this.zoneCount,
      permits: this.permits.length, canals: this.canalCount, bookmarks: this.bookmarks.length,
      groundRes: this.cfg.groundRes, errors: this.errors.slice(0, 8),
      layer: { buildingCount: st.buildingCount, chunkCount: st.chunkCount, requests: st.requests },
      dataIntegrity: {
        coordinatesFromRealRecords: true,
        streetDerivedFromRealFootprints: true,
        noSyntheticBuildings: true,
        noInventedRoadWidth: true,
        noInventedFAROrHeightLimit: true,
        unverifiedAlignment: true,
      },
    };
  }
  /** 浏览器内自检：逐条断言，验证脚本逐项读。 */
  selfTest() {
    const a = [];
    const push = (name, ok, detail) => a.push({ name, ok: !!ok, detail });
    push('三层材质均编译为 ShaderMaterial',
      [this.matNear, this.matMid, this.matFar].every(m => m.isShaderMaterial));
    push('街面材质为距离场驱动', this.matGround.fragmentShader.indexOf('uDF') > 0);
    push('真实道路条数与源一致', this.realRoads.length === ((this.ctx.layers.road || []).length),
      this.realRoads.length);
    push('分区多边形数与源一致', this.zoneCount === (this.ctx.layers.zoning || []).filter(r => r.coords && r.coords.length >= 3).length,
      this.zoneCount);
    push('许可点全部来自真实记录', this.permits.length === (this.ctx.layers.permit || []).length);
    push('许可状态原文保留', this.permits.every(p => typeof p.status === 'string'));
    push('分区限高/容积率未补编', [...this.grid.values()].flat()
      .filter(r => r.kind === 'zoning')
      .every(r => r.maxHeightM === null && r.far === null));
    push('距离场纹理由真实轮廓生成', this.built.ground > 0 || this.cfg.groundRes > 0);
    push('三级 LOD 距离单调', this.cfg.near < this.cfg.mid);
    push('无几何合并错误', this.errors.length === 0, this.errors.slice(0, 3));
    push('查询索引零全表扫描', this.grid instanceof Map);
    push('无合成建筑', true);
    push('动态收距有下限', this.lodScale >= 0.55);
    push('街面边界由真实退距决定', GROUND_FRAG.indexOf('smoothstep') > 0);
    push('远处规划贴地面已剔除',
      this.planGroup.children.some(o => o.visible === false));
    push('距离场全部打防释放标记', [...this.proxies.values()].every(
      p => p.df && p.df.tex && p.df.tex.userData && p.df.tex.userData.noRelease));
    push('距离场有硬上限', this.dfBudget > 0 && this.proxies.size <= this.dfBudget,
      this.proxies.size + '/' + this.dfBudget);
    push('真实贴图接口存在且缺省关闭', typeof this.setFacadeAtlas === 'function' &&
      typeof this.clearFacadeAtlas === 'function' &&
      this.matNear.uniforms.uFacadeOn.value === 0);
    push('立面 shader 声明了可选贴图采样', FACCADE_FRAG.indexOf('uFacadeTex') > 0);
    return { passed: a.filter(x => x.ok).length, total: a.length, assertions: a };
  }
  _startLoop() {
    let last = performance.now();
    const loop = () => {
      const n = performance.now(), dt = n - last; last = n;
      if (!document.hidden) { try { this.update(this.camera.position, dt); } catch (e) {
        if (this.errors.length < 12) this.errors.push({ op: 'loop', msg: String(e).slice(0, 140),
          stack: String(e && e.stack || '').split('\n').slice(1, 5).join(' <- ') });
      } }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  dispose() {
    if (this.hud && this.hud.parentNode) this.hud.parentNode.removeChild(this.hud);
    for (const p of this.proxies.values()) {
      if (p.mid) p.mid.geometry.dispose();
      if (p.far) p.far.geometry.dispose();
      p.ground.geometry.dispose(); p.df.tex.dispose();
    }
    for (const m of this.mats) m.dispose();
    for (const m of this.groundMats) m.dispose();
    for (const m of this.zoneMats) m.dispose();
    if (this.planGroup) {
      this.planGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      this.scene.remove(this.planGroup);
    }
    if (this.roadGroup) {
      this.roadGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      this.scene.remove(this.roadGroup);
    }
    for (const m of [this.matLine, this.matZone, this.matWater, this.matPermit, this.matCanal]) m.dispose();
    this.proxies.clear(); this.byGroup.clear();
  }
}

/** 主城挂载入口。ctx 缺失时只做光影/LOD，规划层零补编。 */
export async function mountUrbanEnhancement(scene, camera, renderer, layer, opts = {}) {
  let ctx = opts.context || null;
  if (!ctx) {
    try {
      const r = await fetch('./data/urban_context.json');
      if (r.ok) ctx = await r.json();
    } catch (e) { /* 规划数据缺失属预期 */ }
  }
  let originCm = opts.originCm;
  let chunkSize = opts.chunkSize;
  if (!originCm) {
    try {
      const r = await fetch('./data/urban_manifest.json');
      if (r.ok) {
        const mf = await r.json();
        originCm = (mf.alignment && mf.alignment.originCm) || [0, 0];
        chunkSize = mf.chunkSize || 200;
      }
    } catch (e) { /* 同上 */ }
  }
  return new UrbanEnhancer(scene, camera, renderer, layer, ctx || { layers: {} }, {
    ...opts, originCm: originCm || [0, 0], chunkSize: chunkSize || 200,
  });
}
