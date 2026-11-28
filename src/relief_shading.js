// ============================================================================
// relief_shading.js — 立体贴图算法 / 三级着色构建 (a7o)
//
// 问题：原工程在移动端把 normal / roughness / metalness / ao 四个通道全部砍掉
//       （SKIP_PBR_EXTRA + mobile material trim），只剩 albedo 平贴；桌面虽有
//       normalMap，但只有均匀环境光、bumpScale 恒为 1、无接触遮蔽与轮廓光，
//       结果是「贴图像一张纸贴在 3D 上」。
//
// 解法（手写，不靠随机噪声糊弄）：
//   1) 把 法线XY / AO / 高度 压进 **一张 RGBA8 打包图**（Packed Relief Map）。
//      移动端只多 1 次采样，就同时拿回凹凸、遮蔽、微观高光；显存从
//      「4 张独立图」降到「1 张 256² 小图」。
//   2) 三级着色构建：L0 近景（视差位移 + 法线增强 + 曲率AO + 轮廓光）、
//      L1 中景/手机（无视差，1 次采样全套）、L2 远景/低端（0 次额外采样，
//      只靠顶点色烘焙 AO + 常量法线）。看门狗可 0→1→2 逐级降级。
//   3) 所有注入点严格对齐 three r169 的 ShaderChunk 顺序，且用「保留原
//      #include 再追加」的链式写法，与工程里已有的 slab macro-noise
//      onBeforeCompile 共存，不互相覆盖。
//      map_fragment(510) → color_fragment(511) → roughnessmap_fragment(515)
//      → normal_fragment_begin(517) → normal_fragment_maps(518)
//      → aomap_fragment(526) → opaque_fragment(528) → tonemapping_fragment(529)
//      打包图挂 three 原生 normalMap 槽位，复用它自动生成的 tbn /
//      vNormalMapUv / normalScale，省掉自写 cotangent frame 的兼容风险。
//
// 红线：任何输入缺失都不得产生黑图；shader 变体数固定且可枚举；
//       移动端常态 1 次额外采样、ALU ≤ ~30 条；L2 保证 0 次。
// ============================================================================

import * as THREE from 'three';

/** 三级构建参数。h0/h1 与 data/config_v3.json 的 streaming.lodRadii 对齐。 */
export const RELIEF_LEVELS = Object.freeze({
  0: Object.freeze({
    name: 'near', parallaxSteps: 3, parallaxScale: 0.018,
    normalBoost: 1.55, aoStrength: 0.95, aoDirect: 0.45,
    roughMix: 0.85, rimStrength: 0.30, curvature: 0.55,
    extraSamples: 3, maxSide: 512,
  }),
  1: Object.freeze({
    name: 'mid', parallaxSteps: 0, parallaxScale: 0,
    normalBoost: 1.28, aoStrength: 0.80, aoDirect: 0.30,
    roughMix: 0.60, rimStrength: 0.22, curvature: 0.30,
    extraSamples: 1, maxSide: 256,
  }),
  2: Object.freeze({
    name: 'far', parallaxSteps: 0, parallaxScale: 0,
    normalBoost: 1.0, aoStrength: 0.0, aoDirect: 0.0,
    roughMix: 0.0, rimStrength: 0.10, curvature: 0.0,
    extraSamples: 0, maxSide: 128,
  }),
});

export const LOD_RADII = Object.freeze({ h0: 180, h1: 420 });

/** 按设备档位决定允许的最高 relief level（性能护栏，硬上限）。 */
export function levelForTier(tier, isMobileUA) {
  if (!isMobileUA) return 0;                                  // 桌面：全开
  if (tier === 'mobileLow' || tier === 'min') return 2;      // 低端 / 极简：零额外采样
  return 1;                                                 // 手机主力：1 次采样
}

/** 按距离取 LOD 级：与 config_v3 的 h0/h1 一致。 */
export function levelForDistance(d, radii = LOD_RADII) {
  return d < radii.h0 ? 0 : d < radii.h1 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// 1. 打包图合成（CPU 侧，手写像素算法）
// ---------------------------------------------------------------------------

const _packCache = new Map();      // key -> DataTexture
let _packStats = { built: 0, fromNormal: 0, fromAlbedo: 0, fallback: 0, bytes: 0, skipped: 0 };

/** 1×1 中性白图：保证无 albedo 的材质也有 USE_MAP / vMapUv，避免 shader 里缺 varying。 */
let _whiteTex = null;
export function whitePixelTexture() {
  if (_whiteTex) return _whiteTex;
  const px = new Uint8Array([255, 255, 255, 255]);
  _whiteTex = new THREE.DataTexture(px, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  _whiteTex.colorSpace = THREE.SRGBColorSpace;
  _whiteTex.wrapS = _whiteTex.wrapT = THREE.RepeatWrapping;
  _whiteTex.needsUpdate = true;
  _whiteTex.userData.mcWhite = true;
  return _whiteTex;
}

/** 把任意 ImageLike 画进 canvas 并返回 RGBA Uint8ClampedArray。 */
function readPixels(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 1;          // 立刻回收 canvas backing store
  return d;
}

/** 亮度（Rec.709），用于从 albedo 推导法线/高度。 */
function luma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

/**
 * Sobel 从 albedo 亮度场求切线空间法线 XY。
 * 这是「没有 _N 图」时的降级路径，不是随机噪声：梯度来自贴图自身的纹理结构，
 * 砖缝/裂纹/窗框都会自然产生凹凸。边界 clamp，避免黑边。
 */
function sobelNormal(lum, w, h, out, strength) {
  const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
        + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
        + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      let nx = -gx * strength, ny = -gy * strength;
      const len = Math.hypot(nx, ny, 1);
      nx /= len; ny /= len;
      const i = (y * w + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    }
  }
}

/**
 * 合成一张 Packed Relief Map。
 *   R = 法线 X (0..1 ↔ -1..1)
 *   G = 法线 Y
 *   B = AO   (1 = 无遮蔽)
 *   A = 高度 (0..1，视差用；同时反推 roughness)
 *
 * @param {object} src
 *   src.albedo / normal / ao / ms : ImageLike|null
 *   src.key      : 缓存键（材质名）
 *   src.maxSide  : 上限（手机 256 / 桌面 512）
 *   src.normalStrength : Sobel 降级梯度强度
 * @returns {THREE.DataTexture}
 */
export function packReliefMap(src) {
  const key = src.key || 'anon';
  const maxSide = Math.max(64, Math.min(512, src.maxSide || 256));
  const ck = key + '|' + maxSide;
  if (_packCache.has(ck)) { _packStats.skipped++; return _packCache.get(ck); }
  const w = maxSide, h = maxSide;
  const out = new Uint8ClampedArray(w * h * 4);
  const a = src.albedo;

  if (!a || !a.width) {
    // 红线：绝不返回黑图。中性平面 = 法线 (0,0,1)、AO 全开、高度 0.5
    for (let i = 0; i < out.length; i += 4) {
      out[i] = 128; out[i + 1] = 128; out[i + 2] = 255; out[i + 3] = 128;
    }
    _packStats.fallback++;
  } else {
    const al = readPixels(a, w, h);
    const lum = new Float32Array(w * h);
    for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = luma(al[i], al[i + 1], al[i + 2]);

    // --- R/G：法线 ---
    if (src.normal && src.normal.width) {
      const nd = readPixels(src.normal, w, h);
      for (let p = 0, i = 0; p < lum.length; p++, i += 4) { out[i] = nd[i]; out[i + 1] = nd[i + 1]; }
      _packStats.fromNormal++;
    } else {
      sobelNormal(lum, w, h, out, src.normalStrength || 2.2);
      _packStats.fromAlbedo++;
    }

    // --- B：AO ---
    if (src.ao && src.ao.width) {
      const ad = readPixels(src.ao, w, h);
      for (let p = 0, i = 0; p < lum.length; p++, i += 4) out[i + 2] = ad[i];
    } else {
      // 亮度局部凹陷推导 AO：暗于 5×5 邻域均值 → 轻微遮蔽（手写 box，非噪声）
      const box = new Float32Array(w * h);
      const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += at(x + dx, y + dy);
        box[y * w + x] = s / 25;
      }
      for (let p = 0; p < lum.length; p++) {
        const dip = Math.max(0, box[p] - lum[p]);
        out[p * 4 + 2] = Math.round(Math.max(0.55, 1 - dip * 1.35) * 255);
      }
    }

    // --- A：高度 ---
    if (src.ms && src.ms.width) {
      const md = readPixels(src.ms, w, h);
      for (let p = 0, i = 0; p < lum.length; p++, i += 4) out[i + 3] = md[i + 3];
    } else {
      for (let p = 0; p < lum.length; p++) {
        out[p * 4 + 3] = Math.round(Math.min(1, Math.max(0, 0.25 + 0.65 * lum[p])) * 255);
      }
    }
  }

  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;       // 数据图，绝不能 sRGB
  tex.anisotropy = 2;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.userData.mcRelief = true;
  tex.userData.side = w;
  _packCache.set(ck, tex);
  _packStats.built++;
  _packStats.bytes += out.byteLength * 1.3333;      // 含 mip
  return tex;
}

/**
 * 中性占位打包图：法线 (0,0,1)、AO=1、高度 0.5。
 * 材质创建时同步挂上，shader 立刻编译成最终变体；图片异步到位后用
 * updateReliefMap 原地改写像素，避免二次编译。
 */
export function neutralReliefMap(maxSide = 256) {
  const w = Math.max(64, Math.min(512, maxSide));
  const px = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 128; px[i + 1] = 128; px[i + 2] = 255; px[i + 3] = 128;
  }
  const tex = new THREE.DataTexture(px, w, w, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.anisotropy = 2;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.userData.mcRelief = true;
  tex.userData.neutral = true;
  return tex;
}

/** 把 packReliefMap 的结果原地写回已挂载的贴图，不重建材质、不重编 shader。 */
export function updateReliefMap(tex, src) {
  if (!tex || !tex.image || !tex.image.data) return false;
  const fresh = packReliefMap(src);
  const dst = tex.image.data, s = fresh.image.data;
  if (dst.length !== s.length) {
    // 尺寸不一致（设备档位切换）：不硬拷，交给调用方重建
    return false;
  }
  dst.set(s);
  tex.userData.neutral = false;
  tex.userData.mcRelief = true;
  tex.needsUpdate = true;
  return true;
}

export function clearReliefCache() {
  for (const t of _packCache.values()) t.dispose();
  _packCache.clear();
  _packStats = { built: 0, fromNormal: 0, fromAlbedo: 0, fallback: 0, bytes: 0, skipped: 0 };
}

// ---------------------------------------------------------------------------
// 2. Shader 注入（严格按 r169 chunk 顺序，链式追加不覆盖已有 onBeforeCompile）
// ---------------------------------------------------------------------------

const RIM_COLOR = new THREE.Color(0x8fb4d9);        // 冷色天光轮廓，贴合赛博朋克

/**
 * 给 MeshStandard/PhysicalMaterial 挂 relief。
 * level 2 不挂图（零额外采样），只保留顶点色 AO 由几何侧提供。
 */
export function attachRelief(material, packedTex, level, opts = {}) {
  if (!material || !(material.isMeshStandardMaterial || material.isMeshPhysicalMaterial)) return () => {};
  const lv = Math.max(0, Math.min(2, level | 0));
  const P = RELIEF_LEVELS[lv];

  // 保证 USE_MAP / vMapUv 一定存在；无 albedo 的材质用 1×1 中性白
  if (!material.map) material.map = whitePixelTexture();

  const u = {
    uMcAO:          { value: P.aoStrength },
    uMcAODirect:    { value: P.aoDirect },
    uMcRoughMix:    { value: P.roughMix },
    // [角色发蓝修复] opts 可覆盖 rim：建筑夜景保留冷蓝轮廓，
    // 白天近景角色关掉/调暖，避免边缘糊一层蓝雾。
    uMcRim:         { value: opts.rimStrength !== undefined ? opts.rimStrength : P.rimStrength },
    uMcRimColor:    { value: opts.rimColor !== undefined
      ? new THREE.Color(opts.rimColor) : RIM_COLOR.clone() },
    uMcCurv:        { value: P.curvature },
    uMcParallax:    { value: P.parallaxScale },
    uMcNormalBoost: { value: P.normalBoost },
  };
  material.userData.mcReliefLevel = lv;
  material.userData.mcReliefAttached = lv < 2;

  // 打包图挂 three 原生 normalMap 槽位 → 自动获得 USE_NORMALMAP_TANGENTSPACE /
  // tbn / vNormalMapUv / normalScale。normalScale 保持 (1,1)，放大只在 shader 里
  // 用 uMcNormalBoost 做一次，避免双重放大。
  if (lv < 2 && packedTex) {
    material.normalMap = packedTex;
    material.normalScale.set(1, 1);
    material.normalMapType = THREE.TangentSpaceNormalMap;
    /* 硬约束：shader 用 vMapUv 采样这张打包图。若 albedo 是 tiled（例如
       texScale [20,10] 或底板 1/9 米制铺贴），打包图必须复用同一 repeat，
       否则「法线/凹凸」和「颜色纹理」错位，砖缝与窗框对不上 —— 比平贴还难看。 */
    const rp = opts.repeat || material.userData.mcReliefRepeat
             || (material.map && material.map.repeat) || null;
    if (rp) {
      const rx = Array.isArray(rp) ? rp[0] : rp.x, ry = Array.isArray(rp) ? rp[1] : rp.y;
      if (Number.isFinite(rx) && Number.isFinite(ry)) {
        packedTex.repeat.set(rx, ry);
        packedTex.needsUpdate = true;
      }
    }
  } else {
    material.normalMap = null;
    material.normalScale.set(1, 1);
  }
  // 信息已进打包图，去掉重复采样通道
  material.aoMap = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  // 顶点色 AO 由 relief_geometry.ensureColor / bakeVertexAO 保证所有共享几何都有
  // color attribute（全 1 中性或烘焙值），此处才能安全地打开 vertexColors。
  material.vertexColors = true;
  // 只修正 a7i 遗留的「metalness=1 且无 envMap → 纯黑」异常，不粗暴覆盖语义
  if (material.metalness === 1 && !material.envMap) material.metalness = 0.04;
  if (opts.roughness !== undefined) material.roughness = opts.roughness;
  if (opts.metalness !== undefined) material.metalness = opts.metalness;

  const prevOBC = material.onBeforeCompile;
  const obcTag = (typeof prevOBC === 'function')
    ? 'c' + prevOBC.toString().replace(/\s/g, '').length : 'n';

  material.onBeforeCompile = (sh, renderer) => {
    // 先让已有的注入（例如 slab macro-noise）跑完，再用「保留 include + 追加」
    // 的方式叠加，绝不整体替换同一 include 造成静默丢失。
    if (typeof prevOBC === 'function') prevOBC(sh, renderer);
    Object.assign(sh.uniforms, u);

    // --- fragment 公共声明（追加到 #include <common> 之后，保留原 include） ---
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
uniform float uMcAO;
uniform float uMcAODirect;
uniform float uMcRoughMix;
uniform float uMcRim;
uniform vec3  uMcRimColor;
uniform float uMcCurv;
uniform float uMcParallax;
uniform float uMcNormalBoost;
`);

    // --- 1) map_fragment 之后声明 mcUv（不替换采样，兼容已有 noise 注入） ---
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
vec2 mcUv = vMapUv;
`);

    // --- 2) normal_fragment_maps：视差位移 + 一次采样拿回 法线XY/AO/高度 ---
    // 视差只偏移「打包图」的采样点，albedo 保持原位：既有随视角移动的凹凸感，
    // 又不会把铺贴贴图撕出接缝，且与 map_fragment 的任何已有注入零冲突。
    if (lv < 2) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `
  vec2 mcRelUv = mcUv;
  if ( uMcParallax > 0.0 ) {
    // 固定 3 步展开，无 while；uniform 分支，移动端整帧走同一路径
    vec4 mcH0 = texture2D( normalMap, mcRelUv );
    vec2 mcG0 = mcH0.rg * 2.0 - 1.0;
    mcRelUv -= mcG0 * uMcParallax * ( 0.5 + mcH0.a );
    vec4 mcH1 = texture2D( normalMap, mcRelUv );
    vec2 mcG1 = mcH1.rg * 2.0 - 1.0;
    mcRelUv -= mcG1 * uMcParallax * ( 0.5 + mcH1.a ) * 0.5;
    vec4 mcH2 = texture2D( normalMap, mcRelUv );
    vec2 mcG2 = mcH2.rg * 2.0 - 1.0;
    mcRelUv -= mcG2 * uMcParallax * ( 0.5 + mcH2.a ) * 0.25;
    if ( any( greaterThan( abs( mcRelUv - mcUv ), vec2( 0.06 ) ) ) ) mcRelUv = mcUv;
  }
  vec4 mcRelief = texture2D( normalMap, mcRelUv );
  vec2 mcNxy = mcRelief.rg * 2.0 - 1.0;
  mcNxy *= uMcNormalBoost;
  vec3 mcMapN = vec3( mcNxy, sqrt( max( 0.0, 1.0 - dot( mcNxy, mcNxy ) ) ) );
  normal = normalize( tbn * mcMapN );
  // roughnessFactor 在 roughnessmap_fragment 已声明，lights_physical_fragment
  // 在其之后才读取，此处改来得及。
  roughnessFactor = clamp(
      roughnessFactor * mix( 1.0, 0.52 + 0.48 * ( 1.0 - mcRelief.a ), uMcRoughMix ),
      0.0525, 1.0 );
`);
    } else {
      // L2：零额外采样，沿用几何法线；立体感由顶点色 AO 提供
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `
  // L2 far: zero extra texture samples; vertex-color AO carries the depth cue
`);
    }

    // --- 3) aomap_fragment：AO 同时压间接光与部分直接光（接触感） ---
    sh.fragmentShader = sh.fragmentShader.replace('#include <aomap_fragment>', `
  float mcAOv = ${lv < 2 ? 'mcRelief.b' : '1.0'};
  mcAOv = mix( 1.0, mcAOv, uMcAO );
  reflectedLight.indirectDiffuse *= mcAOv;
  reflectedLight.directDiffuse   *= mix( 1.0, mcAOv, uMcAODirect );
  #if defined( USE_AOMAP )
    float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
    reflectedLight.indirectDiffuse *= ambientOcclusion;
  #endif
`);

    // --- 4) opaque_fragment 之后、tonemapping 之前：Fresnel 轮廓光 + 曲率 AO ---
    // 必须在 tone mapping **之前**加光，否则轮廓光绕开 ACES 曲线直接线性叠加，
    // 霓虹/夜景里会过曝成白边。曲率用 normal 的屏幕导数（零贴图采样），
    // 只在 L0/L1 生效；L2 只保留极弱轮廓，ALU 仍接近零。
    const curv = P.curvature > 0 ? `
  {
    vec3 mcDx = dFdx( normal ), mcDy = dFdy( normal );
    float mcEdge = clamp( ( length( mcDx ) + length( mcDy ) ) * 0.5, 0.0, 1.0 );
    gl_FragColor.rgb *= 1.0 - uMcCurv * mcEdge * 0.35;
  }` : '';
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
  {
    float mcNdV = clamp( dot( normalize( normal ), normalize( - vViewPosition ) ), 0.0, 1.0 );
    float mcF = pow( 1.0 - mcNdV, 3.0 );
    gl_FragColor.rgb += mcF * uMcRimColor * uMcRim;
  }
${curv}
`);
  };

  // 变体 key 必须把「是否有已有 onBeforeCompile」编进去：
  // 否则 slab（有 macro noise）与普通材质会被 three 判成同一程序而错误复用。
  material.customProgramCacheKey = () =>
    'mcRelief|L' + lv + '|' + obcTag + '|' +
    (material.map ? 'm' : '-') + (material.vertexColors ? 'v' : '-') +
    (material.transparent ? 't' : '-') + (material.alphaTest > 0 ? 'a' : '-');
  material.needsUpdate = true;

  return () => {
    material.onBeforeCompile = prevOBC || (() => {});
    material.normalMap = null;
    material.customProgramCacheKey = undefined;
    material.userData.mcReliefAttached = false;
    material.needsUpdate = true;
  };
}

/** 运行时降级：重挂到更低 level（看门狗调用）。 */
export function setReliefLevel(material, packedTex, level) {
  if (material.userData.mcReliefLevel === level) return false;
  attachRelief(material, packedTex, level);
  return true;
}

export function reliefStats() {
  return {
    ..._packStats,
    cached: _packCache.size,
    levels: Object.fromEntries(Object.entries(RELIEF_LEVELS)
      .map(([k, v]) => [k, { name: v.name, extraSamples: v.extraSamples, maxSide: v.maxSide }])),
  };
}

/** Node 单测入口：不依赖 DOM 的纯数学部分（Sobel）。 */
export function mathSobelNormal(lum, w, h, strength = 2.2) {
  const out = new Uint8ClampedArray(w * h * 4);
  sobelNormal(lum, w, h, out, strength);
  return out;
}
