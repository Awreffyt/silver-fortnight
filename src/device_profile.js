// device_profile.js — 深度设备适配层（执行位原型 · A · 2026-10-04）
// 职责：设备能力探测→高/中/低分档→环境预置（iOS/安卓/微信）→运行时帧率监控动态降档
// 红线：零侵入镜像。独立 rAF 测帧（不动 main.js L1298 主循环）；只调 renderer.setPixelRatio
//      与 bloomPass.enabled 两个已批挂点。桌面端不激活任何降档。
// 依据：汇总员规格升级令 16:05（①②③④）+ 验收锚点"静态分档+动态降档双保险"。
// 注意：镜像无 fastcap（勘误 16:07），MSAA 创建时定死不可关，低档由 DPR 兜底。

const PRESETS = {
  // [2026-11-16a5] iOS 由 1.25 提到 1.5：实机录屏显示画面整体发糊——手机屏幕是 3×
  // 像素，而画布被压到 1.25×，等于把渲染结果拉伸 2.4 倍显示。提到 1.5 与桌面同口径，
  // 真掉帧时仍有下面的动态降档兜底。
  ios:    { dprCap: 1.5,  bloom: true,  note: 'WKWebView 内存 300-500MB 上限，DPR 保守压低防白屏' },
  wechat: { dprCap: 1.25, bloom: true,  note: '安卓X5内核/苹果WKWebView，按iOS口径从严' },
  android:{ dprCap: 1.5,  bloom: true,  note: '高配安卓可维持源站 1.5' },
  desktop:{ dprCap: 1.5,  bloom: true,  note: '桌面零变化（源站原值）' },
};

function detectEnv() {
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

// GPU renderer 因子（汇总员 16:23 批令补齐，凑足五因子）：仅桌面/安卓探测；
// iOS/微信 WebGL 出于隐私不暴露真实型号（仅返回笼统 "Apple GPU"），记 0 且跳过探测。
function detectGpu(env) {
  if (env === 'ios' || env === 'wechat') return { score: 0, gpu: 'skipped(iOS/微信拿不到)' };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { score: 0, gpu: 'no-webgl' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
                    : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();  // 即刻释放，不占浏览器 context 名额
    let score = 0;
    const adreno = gpu.match(/Adreno[^0-9]*(\d{3})/i);
    const mali   = gpu.match(/Mali-G(\d{3})/i);
    if (/Apple\s+M\d/i.test(gpu))               score = 2;  // Apple Silicon（桌面 Safari）
    else if (adreno && adreno[1][0] === '7')    score = 2;  // Adreno 7xx 旗舰（骁龙8系）
    else if (adreno && adreno[1][0] === '6')    score = 1;  // Adreno 6xx 高端
    else if (mali && mali[1][0] === '7')        score = 2;  // Mali G-7xx（Valhall/Immortalis 旗舰）
    else if (mali && mali[1][0] === '6')        score = 1;  // Mali G-6xx 中端
    return { score, gpu };
  } catch { return { score: 0, gpu: 'error' }; }
}

function detectTier(env) {
  // 评分制（五因子）：内存(0-3) + 核数(0-2) + 屏幕规模(0-1) + GPU renderer(0-2) → 高/中/低
  // 阈值随新分布微调：high≥6 / mid≥3.5（原三因子 high≥5 / mid≥3）。
  // 依据（典型机打样，deviceMemory 缺省按 4 计 = 1.5 分）：
  //   S24 Ultra (Adreno750)  1.5+2+1+2 = 6.5 → high（旧分布 4.5 误判 mid，GPU 因子修正）
  //   Galaxy A54 (Mali-G68)  1.5+2+1+1 = 5.5 → mid  ✓
  //   Redmi 9A  (Adreno505)  1.5+1+0+0 = 2.5 → low  ✓
  //   iPhone15 Pro（GPU 记0） 1.5+1+1+0 = 3.5 → mid（iOS 三档 dprCap 均 1.25，mid/high 无实差）
  let s = 0;
  const mem = navigator.deviceMemory || 4;          // iOS 不提供，按中档 4 起
  if (mem >= 8) s += 3; else if (mem >= 4) s += 1.5;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores >= 8) s += 2; else if (cores >= 4) s += 1;
  const px = screen.width * screen.height * (window.devicePixelRatio > 1.5 ? 2 : 1);
  if (px > 2200 * 1080) s += 1;
  const g = detectGpu(env);
  detectTier.lastGpu = g.gpu;
  detectTier.lastGpuScore = g.score;
  return s >= 6 ? 'high' : s >= 3.5 ? 'mid' : 'low';
}

export class DeviceProfile {
  constructor() {
    this.env = detectEnv();
    this.tier = detectTier(this.env);              // 五因子（含 GPU renderer，16:23 批令）
    this.gpu = detectTier.lastGpu;                 // GPU 字符串留档（自检/报表用）
    this.preset = { ...PRESETS[this.env] };
    // 低档机全平台压 DPR；高档不压
    if (this.tier === 'low')  this.preset.dprCap = Math.min(this.preset.dprCap, 1.0), this.preset.bloom = false;
    if (this.tier === 'mid')  this.preset.dprCap = Math.min(this.preset.dprCap, 1.25);
    this.appliedLevel = 0;         // 已降级级数 0..2
    this._samples = [];            // 帧时间滑动窗
  }

  // 应用静态分档（启动时一次）：只动已批的两个挂点
  apply(renderer) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.dprCap);
    renderer.setPixelRatio(dpr);
    this.currentDpr = dpr;
    return this;                   // bloom 开关由宿主在拿到 bloomPass 后调 this.applyBloom(pass)
  }

  applyBloom(bloomPass) { this._bloomPass = bloomPass; bloomPass.enabled = this.preset.bloom; }

  // iOS WebGL 白屏自愈
  // [2026-11-17a2] 删掉旧实现的 `location.reload()`：main.js 已经在
  // webglcontextrestored 里做了「重新挂缩略图 + 按距离逐张恢复原图」的原地重建。
  // 在那里再 reload 一遍，等于把整个页面重新加载一次（TCP/解析/建场全部重来），
  // 内存峰值又冲上去 → 再丢 context → 再 reload……在 iPhone 上就是
  // Safari「重复出现问题」的直接成因。这里只拦截默认行为，重建交给 main.js。
  bindContextGuard(canvas) {
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      console.warn('[dp] context restored — 交由 main.js 原地重建');
    }, false);
  }

  // 独立 rAF 测帧（与主循环同拍，不注入 main.js）
  startMonitor(renderer) {
    const loop = () => {
      const now = performance.now();
      if (this._last) {
        this._samples.push(now - this._last);
        if (this._samples.length > 120) this._samples.shift();   // ~2s 窗口
        this._maybeDowngrade(renderer);
      }
      this._last = now;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _maybeDowngrade(renderer) {
    if (this.appliedLevel >= 2 || this._samples.length < 90) return;   // 最多降2级、样本够再判
    // [2026-11-20 审查修复 F-36] 之前 _streak 每帧递增，「两个窗口」实际是两帧 →
    // 连续两帧就降档。改为每 2 秒评估一次窗口，两个相隔 ≥2s 的窗口都卡才降。
    const now = performance.now();
    if (now - (this._lastWin || 0) < 2000) return;
    this._lastWin = now;
    const avg = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    if (avg < 1000 / 45) return;                                       // >45fps 无需动作
    // 连续两个窗口都卡才降，防偶发抖动
    this._streak = (this._streak || 0) + 1;
    if (this._streak < 2) { this._samples.length = 0; return; }
    this._streak = 0;
    this.appliedLevel++;
    if (this.appliedLevel === 1) {
      this.currentDpr = Math.max(0.75, this.currentDpr - 0.25);
      renderer.setPixelRatio(this.currentDpr);
    } else if (this._bloomPass) {
      this._bloomPass.enabled = false;                                 // 终极：关 bloom
    }
    this._samples.length = 0;
  }
}

// 自检入口（仅 node 环境生效；浏览器无 process，先 typeof 防炸）
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const dp = new DeviceProfile();
  console.log(JSON.stringify({ env: dp.env, tier: dp.tier, gpu: dp.gpu, preset: dp.preset }, null, 2));
}

// 总开关（红线「一键还原原版」）：URL 加 ?dp0 或 localStorage['dp_off']='1' → 本文件零动作
const DP_OFF = new URLSearchParams(location.search).has('dp0')
            || localStorage.getItem('dp_off') === '1';

// 自动挂接（暴露点口径已预批：__renderer / __bloomPass，同 __input 款，__ 前缀不进业务逻辑）
// 出现即按序执行：静态分档 → bloom 开关 → contextlost 自愈 → 帧率监控动态降档
export function autoWire(maxWaitMs = 60000) {
  if (DP_OFF) return;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const r = window.__renderer;
    if (r) {
      clearInterval(timer);
      const dp = new DeviceProfile();
      if (dp.env !== 'desktop') {
        dp.apply(r);                                  // 桌面跳过：DPR/Bloom 保持源站原值原态
        dp.bindContextGuard(r.domElement);
        if (window.__bloomPass) dp.applyBloom(window.__bloomPass);
        dp.startMonitor(r);                           // 桌面不启降档监控=零行为差异
      }
    } else if (Date.now() - t0 > maxWaitMs) clearInterval(timer);
  }, 250);
}

// 自启动（index.html 仅 src 引用即生效；总开关关闭时上面已 return）
autoWire();
