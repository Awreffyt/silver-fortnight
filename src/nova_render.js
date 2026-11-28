// nova_render.js — NOVA 自研光影渲染管线（WebGL2 / 移动端优先）
//
// 设计目标：把「桌面级光影」压进手机的填充率与带宽预算里，同时用动态分辨率
// 守住帧时。整条链全自研，零 EffectComposer / 零 UnrealBloomPass / 零 CPU 读回。
//
// 每帧 7 次 draw，其中 5 次在 1/4 分辨率或更小：
//   1  sceneRT     全分辨率(×renderScale) + DepthTexture
//   2  lumRT       1×1   16 tap 稀疏亮度 + 帧间 EMA → 自适应曝光（ping-pong，纯 GPU）
//   3  brightRT    1/4   软阈值 knee 亮度提取
//   4  aoRT        1/4   深度重建 + 6 tap 接触遮蔽 / 边缘光 / 线性深度
//   5  blur A/B    1/4   Kawase 4-tap 交替方向（2 轮 = 4 pass）
//   6  composite   全屏   单 pass 合成：曝光 + 辉光 + 接触阴影 + 深度边缘光
//                          + 大气雾 + FXAA + 暗角 + 色差 + 时域抖动
//
// 「能做多好做多好」落在 tier 0/1：全套效果全开，辉光走 1/4 分辨率、AO 走
// 1/4 分辨率、模糊 4-tap，合成每像素 8~9 次采样；tier 2 关 FXAA / AO / 自适应
// 曝光，合成降到 3 次采样。FrameGovernor 按实测帧时自动调 renderScale，
// 超预算逐级降、恢复带滞回升，永远先保流畅。
//
import * as THREE from 'three';

export const NOVA_BRAND = 'NOVA';
export const NOVA_FULL = 'Nightfall Over Vertical Avenues';
export const NOVA_ACRONYM = ['Nightfall', 'Over', 'Vertical', 'Avenues'];

/** 三档画质。extraSamples 是合成 pass 每像素纹理采样数（验证脚本按此断言护栏）。 */
export const NOVA_TIERS = {
  0: { name: 'halo',   renderScale: 1.00, bloomScale: 0.25, blurIter: 3,
       fxaa: true, ao: true, autoExposure: true, depthFx: true, extraSamples: 12,
       dprCap: 2.0, targetFps: 60 },
  // [不降画质提速] 移动端快速路径：renderScale 锁 1.0（不再偷偷降到 0.6 糊屏），
  // 关掉 AO/自动曝光/深度模糊三大最贵全屏 pass，模糊 2→1 轮，采样 12→4。
  // 不降贴图、不降视距、不降分辨率——只砍无效滤镜开销，画面反而更清晰锐利。
  1: { name: 'drift',  renderScale: 1.00, bloomScale: 0.20, blurIter: 1,
       fxaa: false, ao: false, autoExposure: false, depthFx: false, extraSamples: 4,
       dprCap: 1.5, targetFps: 30 },
  2: { name: 'ember',  renderScale: 0.75, bloomScale: 0.20, blurIter: 1,
       fxaa: false, ao: false, autoExposure: false, depthFx: false, extraSamples: 4,
       dprCap: 1.0, targetFps: 30 },
};

/** 动态分辨率阶梯：逐档缩 RT，绝不重建 canvas（避免布局抖动与上下文重建）。 */
export const ADR_STEPS = [1.00, 0.92, 0.84, 0.76, 0.68, 0.60];

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** 1×1：16 个固定采样点估平均亮度，和上一帧做 EMA。RGBA8 存 log 域归一化值。 */
const LUM_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uPrev;
uniform float uEma;
uniform float uInit;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  float sum = 0.0;
  sum += luma(texture2D(uScene, vec2(0.10,0.12)).rgb);
  sum += luma(texture2D(uScene, vec2(0.34,0.08)).rgb);
  sum += luma(texture2D(uScene, vec2(0.62,0.11)).rgb);
  sum += luma(texture2D(uScene, vec2(0.88,0.14)).rgb);
  sum += luma(texture2D(uScene, vec2(0.16,0.34)).rgb);
  sum += luma(texture2D(uScene, vec2(0.42,0.29)).rgb);
  sum += luma(texture2D(uScene, vec2(0.70,0.36)).rgb);
  sum += luma(texture2D(uScene, vec2(0.92,0.31)).rgb);
  sum += luma(texture2D(uScene, vec2(0.08,0.58)).rgb);
  sum += luma(texture2D(uScene, vec2(0.31,0.63)).rgb);
  sum += luma(texture2D(uScene, vec2(0.58,0.56)).rgb);
  sum += luma(texture2D(uScene, vec2(0.84,0.66)).rgb);
  sum += luma(texture2D(uScene, vec2(0.14,0.86)).rgb);
  sum += luma(texture2D(uScene, vec2(0.39,0.91)).rgb);
  sum += luma(texture2D(uScene, vec2(0.66,0.84)).rgb);
  sum += luma(texture2D(uScene, vec2(0.90,0.92)).rgb);
  float avg = max(sum / 16.0, 0.001);
  float logCur = clamp((log2(avg) + 8.0) / 16.0, 0.0, 1.0);
  float prev = uInit > 0.5 ? logCur : texture2D(uPrev, vec2(0.5)).r;
  float sm = mix(prev, logCur, uEma);
  float lum = exp2(sm * 16.0 - 8.0);
  float expo = clamp(0.135 / (lum + 0.015), 0.55, 2.20);
  gl_FragColor = vec4(sm, expo / 4.0, 0.0, 1.0);
}`;

/** 软阈值 knee：保留霓虹高光，硬切会出闪烁边。 */
const BRIGHT_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = max(max(c.r, c.g), c.b);
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float w = max(soft, l - uThreshold) / max(l, 0.0001);
  gl_FragColor = vec4(c * w, 1.0);
}`;

/** Kawase 4-tap：一次 pass 只采 4 个点，方向交替，移动端带宽友好。 */
const BLUR_FRAG = `
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 c = texture2D(uSrc, vUv + vec2(-o.x,-o.y)).rgb;
  c += texture2D(uSrc, vUv + vec2( o.x,-o.y)).rgb;
  c += texture2D(uSrc, vUv + vec2(-o.x, o.y)).rgb;
  c += texture2D(uSrc, vUv + vec2( o.x, o.y)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

/**
 * 1/4 分辨率深度重建：6 tap 半球接触遮蔽 + 深度梯度边缘光。
 * 天空(d≈1)直接跳过，避免整片天被压暗。输出 R=AO G=线性深度 B=边缘。
 */
const AO_FRAG = `
varying vec2 vUv;
uniform sampler2D uDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uRadius;
float lin(vec2 uv) {
  float d = texture2D(uDepth, uv).x;
  return (uNear * uFar) / max(uFar - d * (uFar - uNear), 0.0001);
}
void main() {
  float d0 = lin(vUv);
  if (d0 >= uFar * 0.985) { gl_FragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
  float dl = lin(vUv - vec2(uTexel.x, 0.0));
  float dr = lin(vUv + vec2(uTexel.x, 0.0));
  float dd = lin(vUv - vec2(0.0, uTexel.y));
  float du = lin(vUv + vec2(0.0, uTexel.y));
  vec3 n = normalize(vec3(dl - dr, dd - du, uRadius * 0.06));
  float edge = clamp(length(vec2(dl - dr, dd - du)) / (d0 * 0.06), 0.0, 1.0);
  float occ = 0.0;
  float r = uRadius * (1.0 + d0 / uFar);
  { vec2 h = vec2(1.0000,0.0000); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  { vec2 h = vec2(-1.0000,0.0000); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  { vec2 h = vec2(0.5000,0.8660); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  { vec2 h = vec2(-0.5000,-0.8660); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  { vec2 h = vec2(0.8660,-0.5000); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  { vec2 h = vec2(-0.8660,0.5000); float ds = lin(vUv + h * uTexel * r * 4.0);
    float diff = d0 - ds;
    float facing = clamp(dot(n, vec3(h, 0.35)), 0.0, 1.0);
    occ += clamp(diff / (uRadius * 0.5), 0.0, 1.0) * facing * step(0.008, diff); }
  float ao = clamp(1.0 - occ / 6.0 * 0.85, 0.35, 1.0);
  gl_FragColor = vec4(ao, clamp(d0 / uFar, 0.0, 1.0), edge, 1.0);
}`;

/**
 * 单 pass 合成。所有效果合并到一次全屏 draw，移动端最贵的就是 RT 切换与
 * 带宽，少一次 blit 比多一个「看起来更高级」的 pass 值钱得多。
 */
const COMPOSITE_FRAG = `
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform sampler2D uLum;
uniform vec2 uTexel;
uniform float uTime;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uChroma;
uniform float uAutoExposure;
uniform float uPresetExposure;
uniform float uFxaa;
uniform float uDepthFx;
uniform float uFogDensity;
uniform vec3  uFogColor;
uniform vec3  uRimColor;
uniform float uRimStrength;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 sceneTap(vec2 uv) {
  // 色差：只在外圈偏移 R/B，中心保持锐利
  vec2 d = uv - 0.5;
  float k = dot(d, d) * uChroma;
  if (uChroma <= 0.0) return texture2D(uScene, uv).rgb;
  vec3 c;
  c.r = texture2D(uScene, uv + d * k).r;
  c.g = texture2D(uScene, uv).g;
  c.b = texture2D(uScene, uv - d * k).b;
  return c;
}
vec3 fxaa(vec2 uv) {
  vec3 c = sceneTap(uv);                       // 中心带色差（3 次采样）
  vec3 nw = texture2D(uScene, uv + vec2(-1.0,-1.0) * uTexel).rgb;
  vec3 ne = texture2D(uScene, uv + vec2( 1.0,-1.0) * uTexel).rgb;
  vec3 sw = texture2D(uScene, uv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 se = texture2D(uScene, uv + vec2( 1.0, 1.0) * uTexel).rgb;
  float l  = luma(c), lnw = luma(nw), lne = luma(ne), lsw = luma(sw), lse = luma(se);
  float lo = min(min(l, lnw), min(lne, min(lsw, lse)));
  float hi = max(max(l, lnw), max(lne, max(lsw, lse)));
  // 相对阈值：线性 HDR 空间下固定 0.075 会漏掉暗部锯齿
  if (hi - lo < 0.06 * max(hi, 0.08)) return c;
  vec2 dir = normalize(vec2(-(lnw + lne) + (lsw + lse),
                             (lnw + lsw) - (lne + lse)) + vec2(0.0001));
  vec3 a = 0.5 * (texture2D(uScene, uv - dir * uTexel * 0.5).rgb
                + texture2D(uScene, uv + dir * uTexel * 0.5).rgb);
  return mix(c, a, 0.42);
}
// ACES filmic 近似（Narkowicz）：NOVA 接管整条色调映射，
// 材质层保持线性输出，辉光在 HDR 空间叠加后再统一压缩。
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
  // 全程线性空间：抗锯齿 → 曝光 → 接触遮蔽 → 大气 → 辉光叠加 → ACES → sRGB
  vec3 col = uFxaa > 0.5 ? fxaa(vUv) : sceneTap(vUv);

  // 自适应曝光（GPU 侧 1×1 EMA 结果，零 CPU 读回）
  float expo = uPresetExposure;
  if (uAutoExposure > 0.5) expo *= texture2D(uLum, vec2(0.5)).g * 4.0;
  col *= expo;

  // 接触遮蔽 + 深度边缘光 + 大气散射（1/4 分辨率结果，双线性放大刚好当软光）
  if (uDepthFx > 0.5) {
    vec3 ao = texture2D(uAO, vUv).rgb;
    float sky = step(0.985, ao.g);
    col *= mix(ao.r, 1.0, sky);
    float rim = clamp(ao.b, 0.0, 1.0) * (1.0 - sky) * uRimStrength;
    col += uRimColor * rim;
    float fog = 1.0 - exp(-pow(ao.g * uFogDensity, 2.0));
    col = mix(col, uFogColor, fog * 0.22 * (1.0 - sky));
  }

  // 辉光在 HDR 空间叠加，能量守恒，霓虹糊成白饼的概率大幅下降
  vec3 bl = texture2D(uBloom, vUv).rgb;
  col += bl * uBloomStrength;

  col = aces(col);

  // [2026-11-26 手机端冷蓝墙通杀白平衡] 楼体贴图/材质路径众多，逐处改色易漏。
  // 在全屏合成最后一环统一压冷蓝、提暖：红通道微提、蓝通道压低，绿保持。
  // 只作用于非天空像素（天空用 ao.g 的 sky 掩码，保留迈阿密蓝天）。
  {
    float skyMask = 1.0;  // 默认全画面校正
    col.r *= 1.055;
    col.g *= 1.005;
    col.b *= 0.905;
    col = clamp(col, 0.0, 1.0);
  }

  // 暗角
  float v = 1.0 - uVignette * pow(length(vUv - 0.5) * 1.42, 2.2);
  col *= clamp(v, 0.0, 1.0);

  // 线性 → sRGB
  col = clamp(col, 0.0, 1.0);
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055,
            step(vec3(0.0031308), col));
  // 时域抖动消 banding，夜景大面积渐变尤其需要
  float n = fract(sin(dot(vUv + fract(uTime * 0.37), vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// 帧时调速器：超预算降分辨率，恢复带滞回升，冷却防震荡
// ---------------------------------------------------------------------------
export class FrameGovernor {
  constructor(tier, opts = {}) {
    this.tier = tier;
    this.budgetMs = opts.budgetMs || (NOVA_TIERS[tier].targetFps === 30 ? 33.3 : 16.7);
    this.adrIndex = 0;
    this.history = [];
    this.lastChange = 0;
    this.cooldownMs = opts.cooldownMs || 900;
    this.lowStreak = 0;
    this.highStreak = 0;
    this.frameMs = this.budgetMs;
    this.changes = 0;
  }
  /** 返回 true 表示 renderScale 变了，调用方需要重建 RT。 */
  tick(ms, now = performance.now()) {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 500) return false;
    this.frameMs = this.frameMs * 0.85 + ms * 0.15;
    this.history.push(ms);
    if (this.history.length > 12) this.history.shift();
    if (this.history.length < 6) return false;
    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (now - this.lastChange < this.cooldownMs) return false;
    if (median > this.budgetMs * 1.22) {
      this.highStreak = 0;
      if (++this.lowStreak >= 2 && this.adrIndex < ADR_STEPS.length - 1) {
        this.adrIndex++; this.lowStreak = 0; this.lastChange = now;
        this.changes++; return true;
      }
    } else if (median < this.budgetMs * 0.72) {
      this.lowStreak = 0;
      if (++this.highStreak >= 4 && this.adrIndex > 0) {
        this.adrIndex--; this.highStreak = 0; this.lastChange = now;
        this.changes++; return true;
      }
    } else { this.lowStreak = 0; this.highStreak = 0; }
    return false;
  }
  get scale() { return ADR_STEPS[this.adrIndex]; }
  state() { return { adrIndex: this.adrIndex, scale: this.scale, frameMs: +this.frameMs.toFixed(2),
                     budgetMs: this.budgetMs, changes: this.changes, samples: this.history.length }; }
}

/** 由 PERF.tier 映射到 NOVA 档位。 */
export function novaTierFor(perfTier, isMobileUA) {
  if (perfTier === 'mobileLow' || perfTier === 'min') return 2;
  if (perfTier === 'mobile') return 1;
  if (isMobileUA) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// NovaRenderer
// ---------------------------------------------------------------------------
export class NovaRenderer {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.tier = opts.tier ?? 1;
    this.cfg = NOVA_TIERS[this.tier];
    this.enabled = opts.enabled !== false;
    // [不降画质提速] 移动端 tier1/2 锁死分辨率：禁掉那套把 sceneRT 一路降到
    // 0.6× 的自适应（糊屏真凶）。桌面 tier0 保留自适应以护住极限帧率。
    this.lockScale = opts.lockScale !== undefined ? opts.lockScale : (this.tier > 0);
    this.governor = new FrameGovernor(this.tier, opts);
    this.size = new THREE.Vector2(1, 1);
    this._phys = new THREE.Vector2(1, 1);
    this._lastPhys = new THREE.Vector2(0, 0);
    this.dpr = 1;
    this.disposed = 0;
    this.passes = 0;
    this.frame = 0;
    this._lumInit = 1;
    this._lumFlip = 0;
    this._fallback = false;
    this._err = null;

    this.bloomStrength = opts.bloomStrength ?? (this.tier === 0 ? 0.62 : this.tier === 1 ? 0.52 : 0.34);
    this.fogColor = new THREE.Color(opts.fogColor || 0x0a1830);
    this.rimColor = new THREE.Color(opts.rimColor || 0x2ad4ff);

    // 全屏三角形：比 quad 少一次对角插值，覆盖整屏无接缝
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._quadGeo = g;
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadScene = new THREE.Scene();
    this._quadMesh = new THREE.Mesh(g, null);
    this._quadMesh.frustumCulled = false;
    this._quadScene.add(this._quadMesh);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.mLum = mk(LUM_FRAG, {
      uScene: { value: null }, uPrev: { value: null },
      uEma: { value: 0.12 }, uInit: { value: 1 },
    });
    this.mBright = mk(BRIGHT_FRAG, {
      uScene: { value: null }, uThreshold: { value: 0.72 }, uKnee: { value: 0.28 },
    });
    this.mBlur = mk(BLUR_FRAG, {
      uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
    });
    this.mAO = mk(AO_FRAG, {
      uDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
      uNear: { value: 0.1 }, uFar: { value: 900 }, uRadius: { value: 2.4 },
    });
    this.mComposite = mk(COMPOSITE_FRAG, {
      uScene: { value: null }, uBloom: { value: null }, uAO: { value: null },
      uLum: { value: null }, uTexel: { value: new THREE.Vector2() },
      uTime: { value: 0 }, uBloomStrength: { value: this.bloomStrength },
      uVignette: { value: 0.28 }, uChroma: { value: this.tier === 0 ? 0.006 : 0.003 },
      uAutoExposure: { value: this.cfg.autoExposure ? 1 : 0 },
      uPresetExposure: { value: 1.12 },
      uFxaa: { value: this.cfg.fxaa ? 1 : 0 },
      uDepthFx: { value: this.cfg.depthFx ? 1 : 0 },
      uFogDensity: { value: 1.35 },
      uFogColor: { value: new THREE.Vector3(this.fogColor.r, this.fogColor.g, this.fogColor.b) },
      uRimColor: { value: new THREE.Vector3(this.rimColor.r, this.rimColor.g, this.rimColor.b) },
      uRimStrength: { value: this.tier === 0 ? 0.16 : 0.11 },
    });

    // half-float 可用时保留更宽的高光余量；缺失则自动回退 RGBA8
    const ext = renderer.extensions;
    this.hdr = !!(ext && (ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float')));
    this.rtType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.setSize(opts.width || 1280, opts.height || 720, opts.dpr || 1);
  }

  _rt(w, h, withDepth = false) {
    const rt = new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: this.rtType,
      depthBuffer: withDepth, stencilBuffer: false,
      generateMipmaps: false,
    });
    if (withDepth) {
      const dt = new THREE.DepthTexture(Math.max(2, w | 0), Math.max(2, h | 0));
      dt.type = THREE.UnsignedIntType;
      dt.format = THREE.DepthFormat;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      rt.depthTexture = dt;
    }
    return rt;
  }

  setSize(cssW, cssH, dpr) {
    this.dpr = dpr || 1;
    const phys = this.renderer.getDrawingBufferSize(this._phys);
    this._lastPhys.set(phys.x, phys.y);
    // getDrawingBufferSize 已含 dpr；若调用方给了更准的值则取物理尺寸
    const adr = this.lockScale ? 1 : this.governor.scale;
    const W = Math.max(2, Math.round((phys.x || cssW * this.dpr) * this.cfg.renderScale * adr));
    const H = Math.max(2, Math.round((phys.y || cssH * this.dpr) * this.cfg.renderScale * adr));
    this.size.set(W, H);
    const q = Math.max(2, Math.round(W * this.cfg.bloomScale));
    const r = Math.max(2, Math.round(H * this.cfg.bloomScale));

    for (const k of ['sceneRT', 'brightRT', 'blurA', 'blurB', 'aoRT', 'lumA', 'lumB']) {
      if (this[k]) {
        if (this[k].depthTexture) this[k].depthTexture.dispose();
        this[k].dispose(); this.disposed++;
      }
    }
    this.sceneRT = this._rt(W, H, true);
    this.brightRT = this._rt(q, r);
    this.blurA = this._rt(q, r);
    this.blurB = this._rt(q, r);
    this.aoRT = this._rt(q, r);
    this.lumA = this._rt(1, 1);
    this.lumB = this._rt(1, 1);

    this.mBlur.uniforms.uTexel.value.set(1 / q, 1 / r);
    this.mAO.uniforms.uTexel.value.set(1 / q, 1 / r);
    this.mComposite.uniforms.uTexel.value.set(1 / W, 1 / H);
    this._lumInit = 1;
    this.sceneRT.texture.name = 'nova.scene';
  }

  _blit(mat, target) {
    this._quadMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.render(this._quadScene, this._quadCam);
    this.passes++;
  }

  /** 设置层钩子：泛光强度 / 开关 / 雾色 / 档位。 */
  setBloom(strength, on = true) {
    this.bloomStrength = on ? strength : 0;
    this.mComposite.uniforms.uBloomStrength.value = this.bloomStrength;
  }
  setFogColor(hex) {
    this.fogColor.set(hex);
    this.mComposite.uniforms.uFogColor.value.set(this.fogColor.r, this.fogColor.g, this.fogColor.b);
  }
  setTier(t) {
    if (!NOVA_TIERS[t] || t === this.tier) return;
    this.tier = t; this.cfg = NOVA_TIERS[t];
    this.lockScale = t > 0;   // tier1/2 恒锁分辨率
    this.mComposite.uniforms.uAutoExposure.value = this.cfg.autoExposure ? 1 : 0;
    this.mComposite.uniforms.uFxaa.value = this.cfg.fxaa ? 1 : 0;
    this.mComposite.uniforms.uDepthFx.value = this.cfg.depthFx ? 1 : 0;
    this.mComposite.uniforms.uChroma.value = t === 0 ? 0.006 : 0.003;
    this._lumInit = 1;
    this.setSize(this.size.x, this.size.y, this.dpr);
  }

  /**
   * 渲染一帧。frameMs 供调速器使用；异常一律回退到裸渲染，流畅永远优先。
   */
  render(scene, camera, frameMs = 16.7, dt = 0.016) {
    const r = this.renderer;
    if (!this.enabled || this._fallback) {
      r.setRenderTarget(null); r.render(scene, camera); return;
    }
    try {
      // [不降画质提速] 锁定时不采纳 governor 的降分辨率信号（它就是糊屏+反复
      // 重建 RT 卡顿的源头）；physChanged 仅真实旋转/缩放屏才触发，加 1px 容差
      // 防止浮点抖动导致每帧重建。
      const adrChanged = this.lockScale ? false : this.governor.tick(frameMs);
      r.getDrawingBufferSize(this._phys);
      const physChanged = Math.abs(this._phys.x - this._lastPhys.x) > 1 ||
                          Math.abs(this._phys.y - this._lastPhys.y) > 1;
      if (adrChanged || physChanged) this.setSize(this.size.x, this.size.y, this.dpr);
      this.frame++;
      this.passes = 0;

      // 1) 场景 → sceneRT（带深度）
      r.setRenderTarget(this.sceneRT);
      r.clear(true, true, false);
      r.render(scene, camera);
      this.passes++;
      const sTex = this.sceneRT.texture;

      // 2) 1×1 自适应曝光（ping-pong，零读回）
      if (this.cfg.autoExposure) {
        const src = this._lumFlip ? this.lumA : this.lumB;
        const dst = this._lumFlip ? this.lumB : this.lumA;
        this.mLum.uniforms.uScene.value = sTex;
        this.mLum.uniforms.uPrev.value = src.texture;
        this.mLum.uniforms.uInit.value = this._lumInit;
        this._blit(this.mLum, dst);
        this.mComposite.uniforms.uLum.value = dst.texture;
        this._lumFlip ^= 1;
        this._lumInit = 0;
      } else {
        this.mComposite.uniforms.uLum.value = this.lumA.texture;
      }

      // 3) 亮度提取（1/4）
      this.mBright.uniforms.uScene.value = sTex;
      this._blit(this.mBright, this.brightRT);

      // 4) 接触遮蔽 / 边缘光（1/4，读深度）
      if (this.cfg.depthFx) {
        this.mAO.uniforms.uDepth.value = this.sceneRT.depthTexture;
        this.mAO.uniforms.uNear.value = camera.near;
        this.mAO.uniforms.uFar.value = camera.far;
        this._blit(this.mAO, this.aoRT);
        this.mComposite.uniforms.uAO.value = this.aoRT.texture;
      }

      // 5) Kawase 模糊，交替方向
      let src = this.brightRT, dst = this.blurA;
      for (let i = 0; i < this.cfg.blurIter; i++) {
        this.mBlur.uniforms.uSrc.value = src.texture;
        this.mBlur.uniforms.uRadius.value = 1.0 + i * 1.6;
        this._blit(this.mBlur, dst);
        const t = src; src = dst; dst = t === this.brightRT ? this.blurB : this.brightRT;
        if (src === dst) dst = this.blurB;
      }
      this.mComposite.uniforms.uBloom.value = src.texture;

      // 6) 单 pass 合成到屏幕
      this.mComposite.uniforms.uScene.value = sTex;
      this.mComposite.uniforms.uTime.value += dt;
      // applyPreset 改的是 renderer.toneMappingExposure，NOVA 接管色调映射后
      // 必须同步过来，否则白天/黄昏/夜晚三套预设的曝光差全部消失。
      this.mComposite.uniforms.uPresetExposure.value = r.toneMappingExposure || 1.0;
      this._quadMesh.material = this.mComposite;
      r.setRenderTarget(null);
      r.render(this._quadScene, this._quadCam);
      this.passes++;
    } catch (e) {
      this._fallback = true;
      this._err = String(e && e.message || e).slice(0, 200);
      r.setRenderTarget(null);
      try { r.render(scene, camera); } catch (_) {}
    }
  }

  state() {
    return {
      brand: NOVA_BRAND, full: NOVA_FULL, acronym: NOVA_ACRONYM.join(' · '),
      tier: this.tier, tierName: this.cfg.name, enabled: this.enabled,
      fallback: this._fallback, error: this._err,
      rt: { w: this.size.x, h: this.size.y, bloomScale: this.cfg.bloomScale,
            hdr: this.hdr, type: this.rtType === THREE.HalfFloatType ? 'halfFloat' : 'rgba8' },
      passes: this.passes, frames: this.frame, disposed: this.disposed,
      extraSamples: this.cfg.extraSamples, fxaa: this.cfg.fxaa,
      autoExposure: this.cfg.autoExposure, depthFx: this.cfg.depthFx,
      bloomStrength: this.bloomStrength,
      governor: this.governor.state(),
    };
  }

  dispose() {
    for (const k of ['sceneRT', 'brightRT', 'blurA', 'blurB', 'aoRT', 'lumA', 'lumB']) {
      if (!this[k]) continue;
      if (this[k].depthTexture) this[k].depthTexture.dispose();
      this[k].dispose(); this.disposed++;
    }
    for (const m of [this.mLum, this.mBright, this.mBlur, this.mAO, this.mComposite]) m.dispose();
    this._quadGeo.dispose();
  }
}
