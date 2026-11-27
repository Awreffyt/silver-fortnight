// NOVA — Nightfall Over Vertical Avenues · three.js web explorer
// Data + assets produced by the unitypackage-to-web pipeline (see SKILL.md).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// [a7t] NOVA 自研光影管线：移动端全档常开，动态分辨率守帧
import { NovaRenderer, novaTierFor, NOVA_TIERS, ADR_STEPS, FrameGovernor } from './nova_render.js?v=a7t';
import { tryMountUrban } from './miami_layer.js?v=a7u2601';
// [LCR] 光锥光追增强层（双后端：无 WebGPU 自动降级为纯光栅化，画面不变）
import { LCRBridge } from './lcr_bridge.js?v=lcr1';
import { mountUrbanFull } from './urban_full.js?v=a7u2601';
import { mountUrbanEnhancement } from './nova_urban.js?v=a7u2601';
import { Player } from './player.js?v=a7t';
// [a7o] 立体贴图算法 + 三级 LOD 构建。零程序生成数据，只处理已有贴图与几何。
import { attachRelief, packReliefMap, updateReliefMap, neutralReliefMap,
         levelForTier, levelForDistance, RELIEF_LEVELS, LOD_RADII,
         reliefStats, setReliefLevel, whitePixelTexture } from './relief_shading.js?v=a7t';
import { bakeVertexAO, extrudeFlat, buildLodTiers, lodTierStats,
         ensureUV, ensureColor, ensureReliefColors, simplifyGeometry } from './relief_geometry.js?v=a7t';

// build stamp: shown in the HUD + console so a stale-cache session is
// recognizable at a glance (a mixed old/new module graph once reproduced the
// "restart from the sky every few seconds" loop with zero errors)
const BUILD = '2026-11-23a7t';  // a7t：NOVA 自研移动端光影管线 + 单模式主城
console.log(`[build] ${BUILD}`);

// ---------- coordinate convention (verified: case A — Blender FBX->glTF export_yup) ----------
// three world == mirrorX(unity world): glTF geometry is already the X-mirror of Unity's,
// so transforms are CONJUGATED: pos(-x,y,z), quat(x,-y,-z,w), scale unchanged.
const convPos  = t => new THREE.Vector3(-t[0], t[1], t[2]);
const convQuat = r => new THREE.Quaternion(r[0], -r[1], -r[2], r[3]);
// three r169 PropertyBinding.sanitizeNodeName (GLTFLoader applies it to node names)
const sanitize = s => s.replace(/\s/g, '_').replace(/[\[\].:\\/]/g, '');
const strip = n => n.replace(/\.\d{3}$/, '');   // Blender .001 suffixes

// ---------- [MC-SET] 画质设置迁移（必须在读 MC 之前执行） ----------
/* [2026-11-17a2] 上一版为防崩把画质一路往下压（min 档 / 512 贴图 / DPR 1 /
   连续崩溃砍半）。这些结论存在 localStorage 里，新版启动会继续沿用 →
   用户看到的还是"糊"，白改。本版重做了显存与档位策略，旧的低画质结论全部
   作废：一次性清掉画质相关项与崩溃计数，操作类设置（灵敏度等）保留。 */
try {
  const MCQ_VER = 'q3';
  if (localStorage.getItem('megacity.mcq') !== MCQ_VER) {
    let st = {};
    try { st = JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}') || {}; } catch {}
    for (const k of ['renderPath', 'textureMaxSize', 'maxPixelRatio', 'vramBudgetMB',
                     'bloom', 'shadows', 'anisotropy', 'renderScale', 'fpsCap',
                     'contentStreamRadius', 'fogDistance']) delete st[k];
    localStorage.setItem('megacity.settings.v1', JSON.stringify(st));
    localStorage.removeItem('megacity.boot.state');      // 清零崩溃连击计数
    // 注意：不动 megacity.vramreport / vrambudget —— head 里的 vram_probe 已经
    // 按 probe 版本号自行作废旧报告并重算，这里再删会把刚算好的预算抹掉。
    localStorage.setItem('megacity.mcq', MCQ_VER);
    console.log('[mc] 画质设置已迁移到 q3（旧的降档/崩溃标记已清除）');
  }
} catch (e) { /* 隐私模式下 localStorage 不可用，忽略 */ }

// [2026-11-21a7f] q4 迁移：只清 fpsCap 一项。历史上 settings.set 会整包写盘，
// 所以几乎所有用户的 raw 里都躺着旧默认 fpsCap:'60' —— 移动端「默认锁 30 帧」
// 对他们永远不生效。与 q3 同一套一次性迁移机制（megacity.mcq4 标记），
// 用户此后手动设的档位永远优先。
try {
  if (localStorage.getItem('megacity.mcq4') !== 'q4') {
    let st = {};
    try { st = JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}') || {}; } catch {}
    delete st.fpsCap;
    localStorage.setItem('megacity.settings.v1', JSON.stringify(st));
    localStorage.setItem('megacity.mcq4', 'q4');
    console.log('[mc] q4 迁移：fpsCap 已重置（移动端默认锁 30 帧，桌面 60 不变）');
  }
} catch (e) {}

// ---------- [MC-SET] 手动设置读取（贴图上限 / 各向异性） ----------
const MC = (() => { try { return JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}'); } catch { return {}; } })();

// ---------- 渲染档位：按实测显存分三档（可手动锁定） ----------
// 手机卡的不是加载，是每帧要画的量：735 网格 / 594 万三角形 + 泛光 + MSAA。
// 档位只改渲染路径，不删任何资源、不改玩法。
const PERF = (() => {
  const raw = MC.renderPath || 'auto';
  /* [2026-11-17a2] 崩溃根因之二：档位判定只看显存探测值，而 iOS 的统一内存
     会让旧探针报出 2GB+ → tier='full' → DPR2 + MSAA + 泛光 + 阴影 + 5.8km
     logdepth 全开。iPhone 上这就是必崩配置。
     现在：**移动端永远不进 full 档**，走独立的 mobile 档 —— 关掉所有非必要
     的显存/GPU 大户（MSAA、后处理、阴影），但 DPR 保留 1.5 保证不糊。 */
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // [运行时修复 R1] 绝不能用 (pointer: coarse) 判手机：任何带触屏的桌面 /
  // 触控一体机都会命中。实测同一台桌面 Chrome 仅开启 has_touch，
  // 档位就从 full → mobile（雾浓 3 倍、cull 1400→800、相机 far 9000→800、
  // 后处理/阴影全关），而 game-shell 仍按 UA 判成桌面不锁 30 帧 —— 两套
  // 判定当场打架。与 game-shell.startShell 统一为 UA 口径。
  const isMobileUA = isIOS || /Android|Mobile|MicroMessenger/i.test(ua);
  let mb = 0;
  try { mb = parseInt(localStorage.getItem('megacity.vrambudget') || '0', 10) || 0; } catch {}
  // URL 画质开关：?q=low / ?q=mid / ?q=high
  // 用户手上那台设备到底能跑哪一档，只有实测才知道。给一个可以直接改地址试的
  // 开关，比让我在这边猜机型快得多。
  const q = ((location.search.match(/[?&]q=(low|mid|high)/) || [])[1] || '').toLowerCase();
  let tier;
  if (q === 'low') tier = 'mobileLow';
  else if (q === 'high') tier = 'full';
  else if (q === 'mid') tier = isMobileUA ? 'mobile' : 'lite';
  else if (raw === 'full' || raw === 'lite' || raw === 'min') tier = raw;   // 手动锁定优先
  else if (isMobileUA) tier = mb > 0 && mb < 128 ? 'mobileLow' : 'mobile';
  // [2026-11-20 审查修复 F-04] 桌面 vram_probe 不写预算（budgetMB=0 不落 localStorage）
  // → mb=0 之前掉进 min 档：composer/bloom/MSAA 全关、DPR1、cull 240。
  // 桌面没有显存约束，mb=0（未探测/不限制）一律 full；历史遗留低值按 lite 兜底。
  else tier = mb >= 700 ? 'lite' : 'full';
  const P = {
    // [a7f-hotfix] 真实阴影默认全关：阴影 pass 会把 draw call 与三角形数翻倍
    // （实测 1378→2756 calls / 3.3M→6.6M tris），在真实设备上直接打成幻灯片。
    // 阴影代码保留（REAL_SHADOWS 开关可开：URL ?shadows=1 或 localStorage
    // megacity.realshadows=1），但默认不牺牲帧率换阴影。
    full:      { composer: true,  bloom: true,  dprCap: 2,    cull: 1400, shadows: false, msaa: true  },
    lite:      { composer: true,  bloom: false, dprCap: 1.25, cull: 520,  shadows: false, msaa: true  },
    min:       { composer: false, bloom: false, dprCap: 1,    cull: 240,  shadows: false, msaa: false },
    // 手机主力档 [a7g 回退]：a7f 试过 Bloom + MSAA + DPR2，结果是显存被推回红线 →
    // WebGL 上下文丢失（整片发黑 / 黑块 / 贴图全丢）。显存省出来的是「余量」，
    // 不是「预算」，不能全花掉。回退到 a7e 的省显存配置，只保留 30 帧锁。
    // [2026-11-26 iPhone XR 卡崩修复] 2.0×DPR 在 2x 屏等于渲染 4 倍像素
    // （828×1792 CSS → 1656×3584），A12 fragment 直接饱和；配合已关的 POM，
    // DPR 降到 1.15 仍清晰（烘焙法线保立体感），像素量减少约 3 倍。cull 同步收紧。
    mobile:    { composer: false, bloom: false, dprCap: 1.15, cull: 1100, shadows: false, msaa: false },  // [2026-11-26 城市空修复] 700把真实城市圈(1208m)砍掉4成→视野外全是空地; 远景走AABB代理成本极低,拉回1100
    // 低端机（deviceMemory < 4）：DPR 再降，剔除半径收紧
    // [a7i] 0.85 → 1.0：0.85 在 3x 屏上等于整屏糊一层灰，低端机也至少要 1:1 像素。
    mobileLow: { composer: false, bloom: false, dprCap: 1.0, cull: 620, shadows: false, msaa: false },  // [同上] 320几乎贴脸,拉到620保底城市感
  }[tier];
  return Object.assign({ tier, isMobileUA }, P);
})();
window.__mcPerf = PERF;

/* ---------- [a7o] 立体贴图 / 三级着色总配置 ---------------------------------
   旧行为：移动端 SKIP_PBR_EXTRA + mobile trim 把法线/AO/粗糙/金属四通道全砍，
   只剩 albedo 平贴 → 「贴图像一张纸」。现在改成：四通道不上传 GPU，
   只在 CPU 侧压成 **一张 256² RGBA8 打包图**（法线XY / AO / 高度），
   手机每像素只多 1 次采样，却拿回凹凸、接触遮蔽、微观高光与轮廓光。
   三级：L0 桌面近景（视差+曲率+轮廓，3 次采样）/ L1 手机主力（1 次）
   / L2 低端与远景（0 次，靠顶点色 AO）。看门狗可逐级降。            */
const RELIEF = (() => {
  const forced = (location.search.match(/[?&]relief=(0|1|2)/) || [])[1];
  const off = /[?&]relief=off/.test(location.search);
  const base = forced !== undefined ? parseInt(forced, 10) : levelForTier(PERF.tier, PERF.isMobileUA);
  const lv = Math.max(0, Math.min(2, base));
  return {
    off, forced: forced !== undefined, baseLevel: lv, currentLevel: lv,
    maxSide: RELIEF_LEVELS[lv].maxSide,
    built: 0, failed: 0, queued: 0, downgrades: 0,
    manualUntil: 0,          // [a7o 第三轮] 手动设档冷却，防看门狗立刻抢回去
  };
})();
window.__mcReliefCfg = RELIEF;
window.__mcReliefStats = () => ({ ...RELIEF, pack: reliefStats() });

// [a7f-hotfix] 真实阴影总开关：默认关（阴影 pass 翻倍 draw call，实测会打成幻灯片）。
// 想开：URL 加 ?shadows=1，或 localStorage.setItem('megacity.realshadows','1')。
const REAL_SHADOWS = (() => {
  try {
    if (/[?&]shadows=1/.test(location.search)) return true;
    if (localStorage.getItem('megacity.realshadows') === '1') return true;
  } catch (e) {}
  return PERF.shadows === true;
})();
globalThis.__mcRealShadows = REAL_SHADOWS;

const $ = id => document.getElementById(id);
// ---------- real loading progress (bar + counter) ----------
const loadMsg = m => { $('loadMsg').textContent = m; };
const loadMgr = new THREE.LoadingManager();
let loadDone = false;
loadMgr.onLoad = () => {
  loadDone = true;
  $('barFill').style.width = '100%';
  $('loadPct').textContent = '100%';
  if (window.__showMenu) window.__showMenu();
  // [a7d] 全部资源落地 → 2 秒后全量置换 CPU 副本（不等逐张 5s 排程）。
  // 建场期 232 张解码 canvas 的 RAM 峰值（~230MB）是 iOS 上下文丢失的主因，
  // GPU 早已全部上传完毕，此刻置换画面零变化、RAM 直降 100~170MB。
  setTimeout(() => {
    for (const info of SRC_INFO.values()) { try { swapOutCpuCopy(info); } catch (_) {} }
    console.log('[mc] 全量 CPU 副本置换完成（RAM 释放，GPU 贴图不变）');
  }, 2000);
};
loadMgr.onProgress = (url, loaded, total) => {
  const pct = Math.round(loaded / total * 100);
  $('barFill').style.width = pct + '%';
  $('loadPct').textContent = pct + '%';
  loadMsg(`loading assets · ${loaded} / ${total}`);
};
window.addEventListener('error', e => { loadMsg('ERROR: ' + e.message); });

const J = u => { loadMgr.itemStart(u); return fetch(u).then(r => r.json()).finally(() => loadMgr.itemEnd(u)); };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({
  // [2026-11-17a2] 手机上关 MSAA：DPR 1.5 自带超采样，而 4x MSAA 的
  // 多重采样缓冲在 3x 屏是几十 MB 级显存 + 每帧 resolve 开销，是崩溃推手。
  antialias: PERF.msaa !== false,
  powerPreference: 'high-performance',
  // [2026-11-17a2] 手机端关掉对数深度缓冲：它要求片元着色器写 gl_FragDepth，
  // 在 Apple GPU 上会禁用 early-Z（先深度后着色），整帧填充率翻倍 —— 这是
  // iPhone 上「越走越烫、然后崩」的隐性推手。代价是深度精度下降，所以手机端
  // 同时把相机 far 从 9000 收到 800（剔除半径才 420m，够用），420m 处精度
  // 仍有 ~3.5cm，不会出现闪烁穿模。
  logarithmicDepthBuffer: !PERF.isMobileUA,
});
// [MC-SET] 像素比上限按设置走（手机 3x 屏按 1.5 渲染，GPU 负载约减半）
renderer.setPixelRatio(Math.min(devicePixelRatio, PERF.dprCap, (() => {
  const v = parseInt(MC.maxPixelRatio, 10);
  return Number.isFinite(v) && v > 0 ? v : 1.5;
})()));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping;   // [a7t] NOVA 合成 pass 统一接管色调映射，材质层保持线性输出
renderer.toneMappingExposure = 1.12;
renderer.info.autoReset = false;   // composer renders multiple passes per frame; HUD sums them
renderer.shadowMap.enabled = REAL_SHADOWS;   // [a7f-hotfix] 默认关：真实阴影翻倍 draw call
$('app').appendChild(renderer.domElement);
/* 手机（尤其 iOS WKWebView）在内存吃紧时会回收 WebGL 上下文：画面整片发黑、
   只有 UI 还在，几秒后自己恢复。恢复后 three 需要重新上传所有纹理，但本项目
   为省内存已把上传完的 CPU 副本释放掉了（releaseTextureSources）——
   没有这段重建逻辑，恢复后就是「墙只剩颜色、地面发黑、贴图全糊」且永不复原。 */
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.warn('[gl] context lost — 等待自动恢复');
  // [a7d] 不再对用户显示「显存不足」：这是系统回收 GPU 上下文的内部事件，
  // 恢复链路会静默完成（缩略图先挂回 → 驻留调度按位置重传），玩家最多看到
  // 1~2 秒低清然后自动复原。吓人的措辞解决不了任何问题。
  try { showMsg('画面恢复中…', 2.5); } catch {}
}, false);
renderer.domElement.addEventListener('webglcontextrestored', () => {
  console.warn('[gl] context restored');
  // 上下文丢失后所有 GL 纹理都没了。这里只把「缩略图」重新挂上去（每张 21KB，
  // 232 张合计 5MB），全分辨率交给驻留调度按玩家位置逐张恢复。
  // [2026-11-16a6] 旧实现一次性 requestResident(全部) → 5 秒内又爆显存 →
  // 再次丢失 → 再恢复……iOS 上就是无限崩溃循环（Safari 报「重复出现问题」）。
  for (const info of SRC_INFO.values()) {
    info.resident = false; info.pending = false; info.failed = false;
    info.imgReleased = false;   // [a7d] 上下文丢了：旧副本标记作废，重新驻留时重排
  }
  RESIDENT_BYTES = 0;
  for (const [id, e] of TEX_REG) {
    const info = e.info;
    const img = info && info.thumb;
    /* [深度修复 D13] 旧实现漏掉 TEX_CLONES 与 info.tex：恢复后 clone 仍持有旧尺寸
       GL 纹理，而 source.data 已被换成 thumb，下次重传必然报 Offset overflows。
       统一走 syncSourceTextures（dispose + 完整 texImage2D 重建）。 */
    if (info && img) {
      syncSourceTextures(info, img);
      info.bytes = texBytesOf(img.width, img.height);
      RESIDENT_BYTES += info.bytes;
    }
  }
}, false);
// 贴图边长上限：0 = 原始分辨率（默认满配，不删不降）。
// 手机若显存不够，可在「设置 → 画质 → 贴图分辨率上限」手动下调，或用
// 「设置 → 手机与界面 → 省内存模式」一键切到 512。
/* 设备档位：手机（含 iPadOS 伪装成 Mac 的情况）走保守策略 */
const IS_MOBILE = (() => {
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|MicroMessenger/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;   // iPadOS
  // [运行时修复 R1] 同上：不用 pointer:coarse，避免桌面触屏误判。
  return false;
})();
/* 显存预算（MB）：vram_probe 实测写入。拿不到时给手机一个保守默认值——
   [2026-11-16a6] 崩溃根因：预算为 0 时旧代码「不限制」→ 232 张贴图全部 1024²
   同时驻留 ≈ 1.2GB，iPhone 的 WebContent 进程直接被系统杀掉，Safari 报
   「重复出现问题」。任何情况下都必须有一个硬上限。 */
const VRAM_BUDGET_MB = (() => {
  let manual = 0;
  try {
    const st = JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}');
    manual = parseInt(st.vramBudgetMB, 10) || 0;
  } catch {}
  if (manual > 0) return manual;
  if (!IS_MOBILE) return 0;               // 桌面：不限制（与源站一致）
  let probe = 0;
  try { probe = parseInt(localStorage.getItem('megacity.vrambudget') || '0', 10) || 0; } catch {}
  // 探针在个别机型上会报出远超安全线的数字，手机上再压一道硬上限
  return Math.min(probe || 96, 512);
})();
// 贴图边长上限：0 = 原始分辨率。
// [2026-11-16a6] 旧版把下限抬到 1024（想修"糊"），结果手机显存直接爆掉。
// 现在按「实测预算」反推：一张 1024² 带 mip 约 5.3MB，512² 约 1.4MB。
/* ---------- 崩溃自愈 ----------
   iPhone 上如果显存仍然不够，Safari 会把 WebContent 进程杀掉并显示
   「重复出现问题」。页面被杀时 JS 来不及做任何事，只能在「下一次启动」时
   发现自己上回没走完加载流程 → 自动把贴图档位再降一档，直到能稳定跑起来。
   正常情况下这段代码零副作用。 */
const CRASH_STREAK = (() => {
  try {
    const raw = localStorage.getItem('megacity.boot.state');
    const prev = raw ? JSON.parse(raw) : null;
    let streak = 0;
    if (prev && !prev.ok && Date.now() - (prev.t || 0) < 120000) streak = (prev.streak || 0) + 1;
    localStorage.setItem('megacity.boot.state', JSON.stringify({ t: Date.now(), ok: false, streak }));
    return Math.min(streak, 3);
  } catch (e) { return 0; }
})();
const TEX_SAFE_MAX = (() => {
  if (!IS_MOBILE) return 0;               // 桌面：不设上限
  /* [2026-11-17a2] 旧公式把「全城 240 张贴图同时驻留」当作前提反推单张边长，
     96MB 预算解出来是 256px —— 于是每一面墙都被压成 256，这就是用户说的
     「贴图糊成一坨」。但驻留早就有距离驱逐兜底（trimToBudget + residencyPass），
     「同时驻留」根本不是必要条件。现在只定 **单张上限**，总量交给预算硬约束：
     近处 512 清晰，超预算时从最远的开始驱逐，不会爆。 */
  // [2026-11-17a5] 用户实测：iPhone XR 已经能流畅走动，但「贴图糊成一坨」。
  // 根因就是这里 —— 源资产是 1024²，我在 a4 为了保显存把它整城压到 512²，
  // 在 3x 屏上等于 1/4 的像素密度，近处墙面必然是一块块色斑。
  // 现在预算 224MB（有 CRASH_STREAK 自愈兜底），单张上限放到源分辨率 1024。
  // [2026-11-17a6] 224MB 预算档允许 2048 —— 但仅作「单张上限」，2048 只给
  // TEX_2048_RE 白名单的 4 张核心立面（Windows×2/Skyscraper×2），
  // 其余仍按距离驻留在 1024/512，总量由 trimToBudget 硬约束。
  let side = VRAM_BUDGET_MB >= 224 ? 2048
           : VRAM_BUDGET_MB >= 192 ? 1024
           // [a7i] 160~192 档（安卓 deviceMemory≈4，预算 176）原来给 512：
           // 单张 512 在 3x 屏上贴脸就是色斑。总量由 trimToBudget 硬约束，
           // 单张上限没必要跟着预算一起砍 —— 给 1024，近处只留十几张，装得下。
           : VRAM_BUDGET_MB >= 160 ? 1024
           : VRAM_BUDGET_MB >= 96  ? 512
           : 256;
  if (CRASH_STREAK >= 2) {
    // 连续两次没能走完加载（关闭标签页只算一次，不会误判）→ 认为显存不够，砍半
    side = side / Math.pow(2, CRASH_STREAK - 1);
    console.warn(`[mc] 上次启动未完成（疑似显存崩溃）→ 单张贴图降到 ${Math.max(128, Math.floor(side))}`);
  }
  if (side >= 2048) return 2048;
  if (side >= 1024) return 1024;
  if (side >= 512) return 512;
  if (side >= 256) return 256;
  return 128;
})();
const TEX_MAX = (() => {
  const raw = MC.textureMaxSize;
  if (!(raw === undefined || raw === 'auto' || raw === '')) {
    const v = parseInt(raw, 10);
    if (Number.isFinite(v)) {
      /* [2026-11-17a6] 真机「怎么改都没变」的元凶：崩溃恢复弹窗会把
         textureMaxSize 永久写成 512，之后每次启动都沿用 → TEX_NEAR/TEX_MID
         被压回 512，1024/2048 永远没机会生效。
         这里做一道自愈：只要这条设置不是「自动降档」留下的（_autoDown），
         且预算档已经到 288MB，就忽略低于 768 的遗留值。 */
      const ad = MC._autoDown;
      const staleDown = ad && ((ad.boots || 0) >= 1 || (Date.now() - (ad.at || 0)) > 6 * 3600e3);
      // [a7i] 阈值 224 → 160：安卓 deviceMemory=4 的预算只有 176MB，够不到 224，
      // 历史上被写成 512 的 textureMaxSize 就一直生效 —— 这类机器「怎么调都糊」。
      if ((!ad || staleDown) && VRAM_BUDGET_MB >= 160 && v < 768) {
        console.warn(`[mc] 忽略遗留贴图上限 ${v}（${ad ? '旧自动降档已过期' : '非自动降档'}，预算 ${VRAM_BUDGET_MB}MB）→ 按探测档 ${TEX_SAFE_MAX}`);
        return TEX_SAFE_MAX;
      }
      // 手动档位不得超过安全上限：否则「省内存模式」以外的手动调高会重新撑爆显存
      return TEX_SAFE_MAX ? Math.min(v, TEX_SAFE_MAX) : v;
    }
  }
  return TEX_SAFE_MAX;
})();
const ANISO_CAP = (() => {
  const v = parseInt(MC.anisotropy, 10);
  // [2026-11-17a5] 默认 4 → 8；[a6] 8 → 16（拉满）：斜视角下 mip 选得过粗造成的
  // 糊在 iPhone 上是零成本的（采样器开销可忽略），XR/A15 支持到 16。
  return Number.isFinite(v) && v > 0 ? v : 16;
})();
const MAXANISO = Math.min(renderer.capabilities.getMaxAnisotropy(), ANISO_CAP);

/* ---------- 贴图克隆的同步上传（2026-11-17a4） ----------
   底板 / 补地 / 部分材质用 `texture(...).clone()` 来拿到独立的 repeat，
   而 clone 与原贴图共享同一个 Source。问题：这些 clone 在**建场时**就被
   `needsUpdate = true` 上传了一次，那时图片还在下载 → GPU 上是一张空纹理；
   等源图到达时只有原贴图被重新上传，clone 的 version 没人动 → 那块地面
   **永远停在纯黑**。这正是「脚下路面一片黑、只有标线可见」的成因。
   现在把所有 clone 按 source 登记，源图落地时统一 bump。 */
const TEX_CLONES = new Map();
const _texClone = THREE.Texture.prototype.clone;
THREE.Texture.prototype.clone = function () {
  const c = _texClone.call(this);
  const id = this.source && this.source.uuid;
  if (id) { let set = TEX_CLONES.get(id); if (!set) TEX_CLONES.set(id, set = new Set()); set.add(c); }
  return c;
};
function bumpClones(source, image) {
  /* [2026-11-17a6] 这里原来是 full 的 bug：只把 clone 标了 needsUpdate，
     却没把新的 image 赋给 clone。Three 的 Texture.clone() 在 copy 时把 image
     浅拷贝成**当时**的值（通常是 null），之后原贴图落地，clone 的 image 仍然是
     null → 上传时报 "Texture marked for update but no image data found"，
     该 clone 永远是空图（纯黑）。
     底板和补地（12m 一格的贴地网格）全都是 clone 出来的 → 玩家脚下永远是黑的。 */
  const set = source && TEX_CLONES.get(source.uuid);
  if (!set) return;
  for (const t of set) {
    try {
      if (image && t.image !== image) {
        t.image = image;
        /* [2026-11-17a6] 只设 needsUpdate 是不够的：three 会走「局部更新」
           texSubImage2D，新图尺寸和旧纹理不一致时直接报
           GL_INVALID_VALUE: Offset overflows texture dimensions，纹理永远停在空图。
           先 dispose 丢掉旧 GL 纹理，再 needsUpdate，才会走完整 texImage2D 重建。
           这也是「贴图升级 512→1024 后看起来还是糊」的真正原因。 */
        t.dispose();
      }
      t.needsUpdate = true;
    } catch (_) {}
  }
}

/* [2026-11-17a6e] 远景「黑成一团」的真凶：
   贴图没加载时材质上仍挂着 map，但 map.image 为空 —— three 采样空图直接返回
   黑色（不是灰色/白色）。于是 240m 外的楼全是黑色剪影，肉眼观感就是"糊成一坨"。
   这里统一做「占位灰」：map 未就绪 → 基色压成中性灰（像雾里的体块），
   图到了立刻恢复原基色。1.2s 扫一次场景材质，几百个材质，开销可忽略。 */
const _phSeen = new Set();
function refreshMapPlaceholders() {
  const mats = _phSeen;
  scene.traverse(o => {
    const m = o.material;
    if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach(x => { if (x && x.map) mats.add(x); });
  });
  for (const mat of mats) {
    if (!mat.map) { mats.delete(mat); continue; }
    // [2026-11-20 审查修复 F-03] 桌面会释放贴图的 CPU 副本（releaseTextureSources 把
    // source.data 置 null），此时 map.image 为 null 但 GPU 纹理仍在、画面完全正常 ——
    // 不能据此把材质打成「未就绪」变灰，否则所有已释放材质永久灰死且无法恢复。
    // ready 判据改为：CPU 有图，或 GPU 已有真实纹理（__webglTexture 存在）。
    const ready = !!mat.map.image
      || !!(renderer?.properties?.get?.(mat.map)?.__webglTexture);
    if (!ready && !mat.userData.__gray) {
      mat.userData.__origColor = mat.color.getHex();
      mat.color.setHex(0x9aa0a6);      // 中性灰：远处楼像被雾罩住，而不是黑洞
      mat.userData.__gray = true;
      mat.needsUpdate = true;
    } else if (ready && mat.userData.__gray) {
      mat.color.setHex(mat.userData.__origColor ?? 0xffffff);
      mat.userData.__gray = false;
      mat.needsUpdate = true;
    }
  }
}
setInterval(refreshMapPlaceholders, 1200);

/* [2026-11-17a6] 贴图未就绪时的「等待灰底」：
   沥青图解码要几百毫秒（真机）到几秒（弱机），这段时间如果材质挂着空 map，
   采样结果就是纯黑 —— 玩家一进场看到的就是一个黑洞。先给中性灰的基色，
   图片到了再挂上并恢复白色基色，任何时刻都不会出现黑块。 */
function applyMapWhenReady(mat, tex) {
  const wire = () => {
    mat.map = tex;
    mat.emissiveMap = tex;
    // [2026-11-20 审查修复 F-41] 之前无条件 setScalar(1)，会把地面材质的 ×1.7 提亮
    // 在贴图真正到达时清掉 → 移动端地面「灰底亮、图到了反而变暗」。改读 __boost。
    mat.color.setScalar(mat.userData.__boost || 1);
    mat.needsUpdate = true;
  };
  if (tex && tex.image) { wire(); return; }
  let tries = 0;
  const id = setInterval(() => {
    if ((tex && tex.image) || ++tries > 240) {
      clearInterval(id);
      if (tex && tex.image) wire();
    }
  }, 250);
}

/** 按贴图上限降采样：这是手机端显存与加载速度的关键（解码后显存 ∝ 边长²） */
function fitImage(img, maxSide) {
  const lim = maxSide || TEX_MAX;
  const m = Math.max(img.width || 0, img.height || 0);
  if (!lim || !m || m <= lim) return img;
  const s = lim / m;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* ---------- 贴图驻留管理：按显存预算做真实分配 ----------
   浏览器没有「读显存」API，所以显存预算来自 shared/vram.js 的实测值
   （连续分配 GPU 纹理直到驱动拒绝）。超出预算时，把远处不再使用的贴图
   从 GPU 释放掉（贴图文件仍在本地，走近时自动重新加载）——
   分辨率不降、不删任何资源，只是不让整座城同时占着显存。 */
const SRC_INFO = new Map();      // source.uuid -> {url, tex, bytes, resident, pending, lastUsed}
let RESIDENT_BYTES = 0;
let RESIDENCY_FRAME = 0;
const RESIDENCY_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
const _wp = new THREE.Vector3();
/* 贴图槽位静态登记表：sourceId -> {info, users:[{mat, slot, tex, owner}], minD}
   场景构建完成后一次性建立（buildTexRegistry），驱逐/恢复全程以此为准——
   被驱逐的材质槽位为 null，只有登记表还记得它原来挂的是哪张图。 */
const TEX_REG = new Map();
/** 驱逐贴图时的占位像素：1×1 中性灰。用于代替 null —— 让任何漏登记的引用
    渲染成一块灰色而不是「采到空数据」的纯黑。 */
const EVICT_PLACEHOLDER = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  const g = c.getContext('2d'); g.fillStyle = '#6f6f6f'; g.fillRect(0, 0, 1, 1);
  return c;
})();

function texBytesOf(w, h) { return w * h * 4 * 1.3333; }   // 含 mipmap 约 1/3 开销

function registerSource(t, url, srgb) {
  const id = t.source.uuid;
  if (!SRC_INFO.has(id)) {
    SRC_INFO.set(id, { url, srgb, tex: t, bytes: 0, resident: false, pending: false, lastUsed: 0, failed: false });
  }
  return SRC_INFO.get(id);
}

/** 生成 64px 缩略图：贴图被驱逐时用它顶上——远处建筑保住颜色和大致图案，
    而不是变成一块死灰（旧版置 null 或纯灰，视觉上就是"贴图没了"）。
    64² 带 mip 只有 21KB，232 张全算上不到 5MB。 */
function makeThumb(img, size = 64) {
  try {
    const w = img.width || img.naturalWidth || 0, h = img.height || img.naturalHeight || 0;
    if (!w || !h) return null;
    const s = size / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } catch (e) { return null; }
}

let LOAD_SEQ = 0;
/* 分档常量：近 / 中 / 远。
   [2026-11-17a2] 「全城同一分辨率」是死结 —— 要么全 1024 撑爆（1.3GB，iOS 必崩），
   要么全 256 糊成一片。真实观感只取决于**你身边**那几十米，所以按距离分三档：
     近(110m 内)  512²  → 墙面/地面细节清晰
     中(300m 内)  256²  → 轮廓和色块正确，雾效下看不出差别
     远(300m 外)  64² 缩略图 → 只剩颜色，反正 cull 半径外也不渲染
   总量仍由 VRAM_BUDGET_MB 硬约束，超了从最远的开始降。 */
// [2026-11-17a4] 砍掉纯 PBR 通道后，手机端只剩 82 张 albedo/emissive，
// 全部按 512 驻留 ≈ 110MB，装得下 —— 于是不再需要「近 512 / 中 256」的分档，
// 整城统一 512。这一步同时消灭了升降档抖动（之前的驱逐/重载全来自分档）。
// [2026-11-17a5] 用户反馈「贴图糊」没有解决 —— 因为 a4 把整城统一压成了 512。
// 现在恢复分档，但档位是真·源分辨率：
//   近(190m 内)   1024² —— 源就是 1024，等于零损失，墙面/招牌/车体贴脸清晰
//   中(190~900m)   512² —— 雾效 + 距离下与 1024 不可分辨
//   地面类         1024² 常驻 —— 沥青/人行道/瓷砖是脚下大面积重复材质，
//                                玩家永远贴着看，且只有 14 张，常驻最高清最划算
// 预算 224MB：14×5.6 + 68×1.4 ≈ 173MB 基线，余量够 9 张近景动态 1024。
const TEX_NEAR_SIDE = () => (IS_MOBILE ? Math.min(1024, TEX_MAX || 1024) : 0);
/* [a7i] 中景 640 → 512。实测 82 张 640 驻留 254MB，把 288 预算顶到 88%：
   trim 每轮都在挤，最后 22 张（含 CP_City_Ground / Asphalt / Windows_01 /
   Skyscraper —— 全是眼前的东西）被踢成 64px 缩略图 → 「一锅粥」。
   512 面积是 640 的 64%，一套账单降到 ~190MB，留足余量，不再有驱逐抖动。
   512 与 640 在 90m 外的雾效下肉眼无差；贴脸 <240m 仍是 1024。 */
const TEX_MID_SIDE  = () => (IS_MOBILE ? Math.min(512, TEX_MAX || 512) : 0);
const TEX_FAR_SIDE  = () => (IS_MOBILE ? Math.min(256, TEX_MAX || 256) : 0);
/** 地面类贴图：整片平铺、视角永远贴着地面 → 永远给最高清，不参与距离降档 */
const GROUND_TEX_RE = /(Asphalt|Sidewalk|Pavement|Brick|Tile|Floor|Ground|Curbstone|Road_)/i;
// [2026-11-17a6] 建筑立面高频贴图：楼体玩家随时贴脸看，建场即按近景档（不再"先糊后清"）
// [2026-11-26 修复] 把 ambientCG 摄影立面 acg_* 纳入高清通道：此前它们不匹配旧立面正则，
// 被当普通贴图近景只给 512、远景 256 → 窗格糊成马赛克。纳入后近景 1024、中景 512。
const FACADE_TEX_RE = /(Skyscraper|Windows_|Wall_Panel|Plaster|Trim_Sheet|Concrete_0|Brick_Wall|Asian_Shop|Slums_Pack|Metal_Panel|Glass_Showcase|Roller_Shutters|Column_Concrete|Wall_Interior|Quadron|acg_Facade|acg_.*Facade|_Color\.jpg)/i;
// 核心中的核心：2x 超分到 2048 的 4 张（占屏幕面积最大的窗户与楼体）。每张 GL 驻留 22MB，4 张 90MB —— 超过这个数预算必爆
const TEX_2048_RE = /(Windows_01|Windows_02|Skyscraper_01|Skyscraper_02)/i;
const TEX_2048_SIDE = () => (IS_MOBILE ? Math.min(2048, TEX_SAFE_MAX || 2048) : 0);
/* [2026-11-17a6c] 近景半径提到模块级：建场、驻留调度、2048 距离判定共用，
   避免三处数字漂移。300 → 240：预算账本实测装不下 300m 的全量 1024
   （trim 每轮都在挤，出生点反而被挤糊），240m 收紧后账本才平。 */
const TEX_NEAR_R = 240;
const TEX_MID_R  = 900;
/* [深度修复 D7] 滞回半径提到模块级：trim 的保护半径必须与 residency 的升档
   滞回带用同一个数。旧代码 trim 保护 220m、residency 近景 240m / 滞回 360m，
   [220,240) 环带里刚升到 1024 的贴图下一轮就被 trim 降回去，反复 GPU 重传。 */
const TEX_HYST_R = TEX_NEAR_R + 120;   // 360
/** 该贴图在手机端的目标边长（建场与驻留升级共用同一来源，避免两处逻辑漂移）。
    dist=undefined 时按远景档给（2048 白名单落回 1024）——建场阶段没有距离信息，
    先按保守档上传，进了驻留调度会立刻按真实距离升到 2048。 */
function texTargetSide(url, dist) {
  const u = decodeURIComponent(url || '');
  if (!IS_MOBILE) return 0;                       // 桌面不限制
  const d = dist === undefined ? TEX_NEAR_R : dist;
  // [a7i] 2048 收紧到 70m 且**同时最多 2 张**：单张 GL 驻留 22MB，
  // 5 张就是 110MB —— 实测把 288MB 预算顶到 293MB（超上限）。
  // 只有真正贴脸的那一两栋值得，其余 1024 足够。
  if (TEX_2048_RE.test(u)) {
    if (d < 70) {
      let n2k = 0;
      /* [深度修复 D8] side 会被 pending 竞态虚报（见 D9），不能用它数 2K 张数。
         改用真实驻留字节判断，账本与 GPU 占用同口径。 */
      const twoK = texBytesOf(2048, 2048) * 0.9;
      for (const si of SRC_INFO.values()) if (si.resident && (si.bytes || 0) >= twoK) n2k++;
      return n2k < 2 ? TEX_2048_SIDE() : 1024;
    }
    return d < TEX_NEAR_R ? 1024 : TEX_MID_SIDE();
  }
  if (GROUND_TEX_RE.test(u)) return TEX_NEAR_SIDE();   // 地面 14 张常驻高清（脚下大面积平铺）
  // [a7i] 立面不再无条件 1024：240m 外仍给 1024 会把 57 张立面全顶到高清，
  // trim 只好把近处踢掉。现在按距离三档，账单才平。
  if (FACADE_TEX_RE.test(u)) return d < TEX_NEAR_R ? TEX_NEAR_SIDE()
                                 : d < TEX_MID_R ? TEX_MID_SIDE() : TEX_FAR_SIDE();
  return d < TEX_NEAR_R ? TEX_MID_SIDE() : TEX_FAR_SIDE();
}

function onSourceLoaded(info, img, side) {
  const w = img.width || img.naturalWidth || 0, h = img.height || img.naturalHeight || 0;
  info.seq = ++LOAD_SEQ;
  const prev = info.bytes || 0;
  info.bytes = texBytesOf(w, h);
  info.fullBytes = info.bytes;
  info.side = side || Math.max(w, h);
  if (!info.thumb) info.thumb = makeThumb(img);
  info.resident = true;
  info.pending = false;
  info.imgReleased = false;      // [a7d] 新副本已存在，重置置换标志
  RESIDENT_BYTES += info.bytes - prev;
  maybeTrimTextures();          // 边加载边压回预算：峰值不越界，手机才不会被 OOM 杀掉
  scheduleSwapOut(info);        // [a7d] 上传 GPU 后延时置换 CPU 副本（防内存峰值）
}

/** 重新驻留一张贴图（走近时触发）：下载 → 写回共享 source → 按登记表把材质槽位挂回。
    [2026-11-16a2 修复] 旧实现把「挂回」依赖当次 traverse 抓到的 users——但被驱逐的
    材质槽位已是 null，后续 traverse 根本扫不到它 → 驱逐过的贴图永远无法恢复，
    表现为「走远后墙面只剩纯色，走近也不恢复」。现在恢复路径走静态登记表 TEX_REG。 */
function requestResident(info, wantSide, priority) {
  const cap = TEX_MAX || 0;            // 0 = 桌面不限制，原图上传
  const target = cap ? Math.max(64, Math.min(cap, wantSide || cap)) : 0;
  // 已驻留且分辨率不低于目标 → 无需动作（这是"不反复重载"的闸门）
  if (info.resident && (info.side || 0) >= target) return;
  if (info.pending) { info._want = Math.max(info._want || 0, target); return; }
  // 加载失败进入 30s 冷却而非永久拉黑：手机网络抖动一次不该判贴图死刑，
  // 否则走远后这张图永远糊着不恢复（旧逻辑 info.failed 一票否决）。
  if (info.failed && performance.now() - (info.failedAt || 0) < 30000) return;
  info.failed = false;
  info.pending = true;
  info._want = target;
  const url = info.url;
  enqueueImage(url,
    (img) => {
      info.pending = false;
      const wantSide = Math.max(target, info._want || 0);
      const fitted = fitImage(img, wantSide);
      const realSide = Math.max(fitted.width || fitted.naturalWidth || 0,
                                fitted.height || fitted.naturalHeight || 0) || wantSide;
      /* [深度修复 D9] pending 期间 _want 可能被提升到更高档，但已发出 job 的
         maxSide 仍是第一次的 target —— createImageBitmap 已经把源图缩到那个尺寸，
         fitImage 不会放大。若仍按 wantSide 记账，就得到「side=1024 / 实际 256」
         的虚高账本，requestResident 的闸门 `resident && side>=target` 永远放行，
         这张图永久停在低分辨率（mobile 档实测复现）。按真实图宽记账。 */
      const effectiveSide = Math.min(wantSide || realSide, realSide);
      if (effectiveSide > 256 && !info.mid) info.mid = makeThumb(fitted, 256);
      syncSourceTextures(info, fitted);
      onSourceLoaded(info, fitted, effectiveSide);
      if (wantSide > realSide) {
        // 真正需要更高档：重排一次升级（新 job 的 maxSide=wantSide，不会再被缩小）
        setTimeout(() => { try { requestResident(info, wantSide, true); } catch (_) {} }, 0);
      }
    },
    () => { info.pending = false; info.failed = true; info.failedAt = performance.now(); },
    // [2026-11-17a5] 玩家身边的升级请求插队：否则它排在远处首次加载之后，
    // 进场后要先糊十几秒才变清晰 —— 用户说的「刷新很乱」。
    !!priority, target || 0);
}

/** [深度修复 D10] 统一同步一个 source 上的全部 texture：
    主贴图 info.tex + TEX_REG 的所有 users + TEX_CLONES 里的所有 clone。
    三者是互相独立的 THREE.Texture，各有自己的 GL 资源。旧代码在
    evictSource / 上下文恢复 / swapSourceImage 里只遍历 e.users，漏掉 clone：
      · 驱逐时账本减掉整张图 bytes，clone 的 GL 纹理却仍驻留 → 硬预算被架空
        （mobile 档实测驱逐后 clone.gpu 仍为 true）；
      · 换 image 后不 dispose 会走 texSubImage2D 局部更新，新旧尺寸不一致时
        Chromium 报 GL_INVALID_VALUE: Offset overflows。
    这里一次性 image / dispose / needsUpdate / 槽位挂回，所有路径共用。 */
function syncSourceTextures(info, img) {
  const id = info.tex.source.uuid;
  const e = TEX_REG.get(id);
  const texs = new Set([info.tex]);
  if (e) for (const u of e.users) texs.add(u.tex);
  const clones = TEX_CLONES.get(id);
  if (clones) for (const t of clones) texs.add(t);
  for (const t of texs) {
    try { t.image = img; t.dispose(); t.needsUpdate = true; } catch (_) {}
  }
  if (e) for (const u of e.users) u.mat[u.slot] = u.tex;   // 槽位挂回（保留各自 repeat/colorSpace）
  return texs.size;
}

/** 在同一张 source 上换一张已解码的图（降档用，不重新下载）。
    不 dispose：dispose 会删共享的 GL 纹理，多用户材质会一起变白；
    直接换 image + needsUpdate 由 three 自己重传。 */
function swapSourceImage(info, img) {
  const prev = info.bytes || 0;
  const w = img.width || 1, h = img.height || 1;
  // [深度修复 D11] 旧实现 e 存在时把 info.tex 排除在集合外，且只靠 bumpClones
  // 补 clone；统一走 syncSourceTextures，杜绝漏 dispose 的纹理。
  syncSourceTextures(info, img);
  info.bytes = texBytesOf(w, h);
  info.side = Math.max(w, h);
  RESIDENT_BYTES += info.bytes - prev;
}

/** 中距离降档：512 → 256（用缓存的中图，零下载）。没有中图就直接不降。 */
function downgradeToMid(info) {
  if (!info.resident || !info.mid) return;
  if ((info.side || 0) <= 256) return;
  swapSourceImage(info, info.mid);
  window.__mcDowngraded = (window.__mcDowngraded || 0) + 1;
}

/** 就地缩到任意边长（1024 → 512）：直接拿当前 GPU 上的 image 再缩一次，
    不下载不解码，开销是几次 canvas 缩放（~2ms/张）。
    [2026-11-17a5] 近景动态 1024 的回收路径：走出滞回带且预算吃紧时用它，
    比 evict 到 64px 缩略图温和得多（不会看到贴图"消失"）。 */
function downgradeToSide(info, side) {
  if (!info || !info.resident || info.pending) return;
  if ((info.side || 0) <= side) return;
  // [a7d] CPU 副本已被置换（上传即释放）：改走重新 fetch，不从 256px 中图上采样
  if (info.imgReleased) { refetchDowngrade(info, side); return; }
  const img = info.tex && info.tex.image;
  if (!img) return;
  const w = img.width || img.naturalWidth || 0;
  if (!w) return;
  const fitted = fitImage(img, side);
  if (fitted === img) return;
  swapSourceImage(info, fitted);
  window.__mcDowngraded = (window.__mcDowngraded || 0) + 1;
}

/** 把一张贴图降级到 64px 缩略图：GPU 上只留 21KB，材质槽位保持挂接（不会变灰块/黑块），
    走近时再由 requestResident 换回全分辨率。 */
function evictSource(info) {
  if (!info.resident) return;
  const thumb = info.thumb || EVICT_PLACEHOLDER;
  /* [深度修复 D12] 旧实现只 dispose TEX_REG.users，TEX_CLONES 里的 clone 是
     独立 texture、GL 资源原封不动 → 账本减了 bytes 但显存没释放（mobile 实测
     驱逐后 clone.gpu 仍为 true），硬显存预算被架空。统一同步。 */
  syncSourceTextures(info, thumb);
  info.resident = false;
  const after = texBytesOf(thumb.width || 1, thumb.height || 1);
  RESIDENT_BYTES -= Math.max(0, info.bytes - after);
  info.bytes = after;
  info.side = Math.max(thumb.width || 1, thumb.height || 1);
  window.__mcEvicted = (window.__mcEvicted || 0) + 1;
}

/* ---------- [2026-11-21a7d] CPU 副本置换：上传完 GPU 就不再留大图 ----------
   「显存不足」弹窗（webglcontextlost）的根因不是 GPU 预算，而是**内存峰值**：
   iOS 统一内存下，GPU 驻留 288MB + 全部贴图的 CPU canvas 副本（~160MB）+
   解码瞬时的 blob/ImageBitmap 叠在一起顶穿 WebContent 进程的 jetsam 线。
   解法：一张贴图上传 GPU 成功后，把所有引用它的 texture 的 image 悄悄换成
   256px 中图（不调 needsUpdate → GPU 纹理保持全分辨率不动），大 canvas 交给
   GC。GPU 侧一个字节都不省、画面完全不变；RAM 侧每张 2048² 省 16MB。
   降级时如果发现副本已被置换，走「重新 fetch + 重新缩放」（HTTP force-cache
   秒回），不再依赖常驻原图。 */
const SWAP_OUT_DELAY = 5000;   // 上传后 5s 再置换：避开入场阶段的上传风暴
function swapOutCpuCopy(info) {
  if (!info || info.imgReleased || !info.resident || info.pending) return;
  const keep = info.mid || info.thumb;
  if (!keep) return;
  const e = TEX_REG.get(info.tex.source.uuid);
  const texs = new Set([info.tex]);
  if (e) for (const t of e.users) texs.add(t.tex);
  const set = TEX_CLONES.get(info.tex.source.uuid);
  if (set) for (const t of set) texs.add(t);
  for (const t of texs) {
    try { if (t.image && t.image !== keep) t.image = keep; } catch (_) {}
    // ⚠️ 故意不设 needsUpdate：GPU 上的全分辨率纹理保持原样
  }
  info.imgReleased = true;
}
function scheduleSwapOut(info) {
  if (!info || info.imgReleased || !info.resident) return;
  setTimeout(() => { try { swapOutCpuCopy(info); } catch (_) {} }, SWAP_OUT_DELAY);
}
/** 副本已被置换后的降级：不再从常驻 canvas 缩放，重新 fetch 原图按目标边重做。
    （force-cache 下 blob 命中磁盘缓存，通常几十 ms；期间 GPU 上还是原来的大图，
    画面无任何变化。） */
function refetchDowngrade(info, side) {
  if (info.pending) return;
  info.pending = true;
  enqueueImage(info.url,
    (img) => {
      info.pending = false;
      const fitted = fitImage(img, side);
      swapSourceImage(info, fitted);
      info.imgReleased = false;    // [a7d] 新副本已生成，允许再次排程置换
      window.__mcDowngraded = (window.__mcDowngraded || 0) + 1;
      scheduleSwapOut(info);
    },
    () => { info.pending = false; },
    1);   // 低优先级：降级不抢玩家身边的升级请求
}

/* ---------- 硬性显存上限 ----------
   [2026-11-16a6] iPhone 崩溃（Safari「重复出现问题」）的真因：
   232 张贴图按 1024² 同时驻留 ≈ 1.24GB，WebContent 进程被系统直接杀掉。
   下面这个裁剪函数在「每张图加载完成时」和「每 20 帧」都会执行，
   保证驻留字节数始终贴着预算，峰值不超过预算 + 在飞的几张图。 */
let TRIM_AT = 0;
/** 需求中心（玩家位置）。加载期可能早于控制器/相机初始化 → 一律走 window 引用兜底，
    绝不能在模块初始化阶段触发 TDZ（否则每张图都抛错、裁剪永远不生效）。 */
function residentOrigin() {
  const c = window.__ctrl;
  if (c && c.pos) return c.pos;
  const cam = window.__camera;
  return cam ? cam.position : { x: 0, z: 0 };
}
function trimToBudget(force = false) {
  if (!VRAM_BUDGET_MB) return;                    // 桌面：不限制
  const budget = VRAM_BUDGET_MB * 1048576;
  const target = budget * 0.85;
  if (!force && RESIDENT_BYTES <= budget * 0.98) return;
  if (!force && performance.now() - TRIM_AT < 250) return;   // 限频，别每张图都全表排序
  TRIM_AT = performance.now();
  // 场景还没建完时物体还没进场景图 → distToContent 全退化成"原点附近"，
  // 按距离裁剪会一张都裁不掉。此阶段按加载顺序（FIFO）降级：先加载的多是
  // 通用街景材质，进游戏后驻留调度会立刻把玩家身边的重新拉回来（HTTP 缓存命中）。
  const origin = residentOrigin();
  const cands = [];
  for (const [id, e] of TEX_REG) {
    const info = e.info;
    if (!info || !info.resident) continue;
    if (!BUILD_DONE) { cands.push([info, -(info.seq || 0)]); continue; }
    let minD = Infinity;
    for (const u of e.users) {
      const d = distToContent(u.owner, origin.x, origin.z);
      if (d < minD) minD = d;
    }
    /* [深度修复 D7] 保护半径必须与 residency 的升档滞回带一致（360m）。
       旧值 220m 与近景 240m 冲突：[220,240) 环带刚升档就被降回去，反复重传。 */
    if (minD < TEX_HYST_R) continue;
    cands.push([info, minD]);
  }
  if (!cands.length) {
    // 兜底：整座城几乎都是「覆盖全城的 InstancedMesh」，按内容包围球算出的距离
    // 会全部小于 60m → 找不到候选。此时按单张体积从大到小降级，保证硬上限不被突破。
    // [a7i] 地面贴图排到最后：它们是脚下最大一块屏幕，最后才动。
    const all = [];
    for (const [id, e] of TEX_REG) if (e.info && e.info.resident) all.push(e.info);
    all.sort((a, b) => (GROUND_TEX_RE.test(a.url || '') - GROUND_TEX_RE.test(b.url || '')) || (b.bytes - a.bytes));
    // [a7i] 兜底也必须「先降级、后驱逐」：旧版直接 evict 会把 1024 打成 64px 缩略图，
    // 而 2048→1024 每张省 16MB、1024→512 每张省 4MB，肉眼几乎无损。
    for (const pass of [1024, 512]) {
      for (const info of all) {
        if (RESIDENT_BYTES <= target) break;
        if ((info.side || 0) > pass) downgradeToSide(info, pass);
      }
    }
    for (const info of all) {
      if (RESIDENT_BYTES <= target) break;
      if (GROUND_TEX_RE.test(info.url || '')) continue;
      evictSource(info);
    }
    return;
  }
  cands.sort((a, b) => b[1] - a[1]);              // 最远（建场阶段=最早加载）的先降级
  /* [2026-11-17a6c] 三轮温和降级：旧版 1024 直接砍到 512（面积只剩 1/4，
     玩家回出生点看到的就是"变糊了"）。现在先落 1024（2048→1024 只省一半），
     还超预算才 512，最后才驱逐成缩略图。每一步都是肉眼渐变，不是断崖。 */
  for (const [info] of cands) {
    if (RESIDENT_BYTES <= target) break;
    if ((info.side || 0) > 1024) downgradeToSide(info, 1024);
  }
  for (const [info] of cands) {
    if (RESIDENT_BYTES <= target) break;
    if ((info.side || 0) > 512) downgradeToSide(info, 512);
  }
  for (const [info] of cands) {
    if (RESIDENT_BYTES <= target) break;
    if ((info.side || 0) <= 512) {
      // [a7i] 地面贴图（Asphalt/Sidewalk/Tile/Ground）永不降到 64px：
      // 它占脚下最大的屏幕面积，一糊就是「地上一团色斑」，比远处少一张 1024 值得多。
      if (GROUND_TEX_RE.test(info.url || '')) continue;
      evictSource(info);
    }
  }
}
/** 加载期钩子：低频调用，避免每张图都做一次全表扫描 */
let TRIM_LOADS = 0;
function maybeTrimTextures() {
  if (!VRAM_BUDGET_MB) return;
  const budget = VRAM_BUDGET_MB * 1048576;
  if (RESIDENT_BYTES <= budget * 0.92) return;
  if (++TRIM_LOADS % 4 !== 0) return;
  trimToBudget(true);
}

/** 每 20 帧做一次驻留调度：以玩家所在位置为需求中心。
    [2026-11-16a2 重构] 改用静态登记表 TEX_REG（场景构建后一次性建立）：
    · 驱逐后槽位为 null 的材质仍能被找回并恢复（旧版当场失联）；
    · 免去每 20 帧全场景 traverse（弱机每帧卡顿来源之一）。 */
let LAST_RESIDENCY = 0;
function residencyPass() {
  RESIDENCY_FRAME++;
  // [2026-11-17a3] 「每 20 帧」在 60fps 是 0.33s，但在 26fps 的真机上是 0.77s、
  // 软渲染下更久 —— 167 张升级请求要排 40 秒，贴图一直糊。改成按时间节流，
  // 任何帧率下调度节奏一致。
  const now = performance.now();
  if (now - LAST_RESIDENCY < 300 || !TEX_REG.size) return;
  LAST_RESIDENCY = now;

  // 预算：统一用模块级 VRAM_BUDGET_MB（手机永远有硬上限，桌面为 0 = 不限制）
  const budget = VRAM_BUDGET_MB * 1048576;
  if (!budget) return;

  // 需求中心：玩家位置（菜单高空视角下，整座城市都在视野里，
  // 若按相机算则永远无法驱逐；按玩家算才是「你走到哪，街景就加载到哪」）
  const origin = residentOrigin();
  // [2026-11-17a3] 半径放大：用户实拍指出 110~300m 的建筑是 256，糊。
  // 现预算 240MB，300m 内 167 张 512² ≈ 234MB 刚好装下 → 近档半径提到 260，
  // 260~430m（略大于 cull 420）保持 256，420m 外反正被剔除。
  // [2026-11-17a5] 恢复真实分档：190m 内 1024（源分辨率），之外 512。
  // 滞回带 190→280m：避免站在 189m 边界上反复升降导致 GPU 重传抖动。
  // [2026-11-17a6] 190 → 300；[a6c] → 240（TEX_NEAR_R）：300m 的 1024 需求量
  // 超出预算，trim 每轮都在挤掉别人（包括出生点的 1024），账本必须先平。
  const R_NEAR = TEX_NEAR_R;
  const R_MID = TEX_MID_R;
  const R_HYST = TEX_HYST_R;
  const needed = new Set();
  // [2026-11-17a2] 每轮最多排 14 个加载：167 张一次性全塞进队列会把
  // TEX_ACTIVE(4) 占满十几秒，后面的关键贴图（主角）只能干等。
  let reqLeft = 14;   // 300ms 一轮 × 14 = 46 张/秒
  const want = (info, side, prio) => {
    if (reqLeft <= 0 || !info || info.pending) return;
    if (info.resident && (info.side || 0) >= side) return;
    reqLeft--;
    requestResident(info, side, prio);
  };
  for (const [id, e] of TEX_REG) {
    let minD = Infinity;
    for (const u of e.users) {
      const d = distToContent(u.owner, origin.x, origin.z);
      if (d < minD) minD = d;
    }
    e.minD = minD;
    if (minD >= R_MID) continue;
    needed.add(id);
    const info = e.info;
    if (!info) continue;
    // 地面类永远最高清（14 张，玩家脚下大面积平铺、贴脸看）；
    // 建筑立面只在近景 300m 内吃高清档，超出走中景 —— 否则 57 张同时 1024
    // 会把 288MB 预算顶穿，trimToBudget 从最远处开始驱逐，远处楼反而变成 64px 假糊。
    const isGround = GROUND_TEX_RE.test(info.url || '');
    if (isGround || minD < R_NEAR) {
      want(info, texTargetSide(info.url, minD), true);   // 近景：插队（2048 按距离）
    } else if (minD < R_HYST) {
      if (!info.resident) want(info, TEX_MID_SIDE());
    } else {
      if (!info.resident) want(info, TEX_MID_SIDE());
      // 中远 + 预算吃紧才降档（就地缩放，零下载零解码）。2048 白名单降到 1024 而不是 512：
      // 窗户/楼体从 2048 直接掉到 512 肉眼可见，是「走近突然变糊」的直接来源。
      else {
        const hi = TEX_2048_RE.test(info.url || '');
        const floorSide = hi ? 1024 : 512;
        if ((info.side || 0) > floorSide && RESIDENT_BYTES > budget * 0.80) downgradeToSide(info, floorSide);
      }
    }
  }

  // 超预算 → 从「离玩家最远」的开始降级到缩略图
  trimToBudget();
  // 更新活跃时间
  for (const id of needed) {
    const info = TEX_REG.get(id)?.info;
    if (info) info.lastUsed = RESIDENCY_FRAME;
  }
  window.__mcResident = {
    mb: Math.round(RESIDENT_BYTES / 1048576), budgetMB: Math.round(budget / 1048576),
    sources: SRC_INFO.size, resident: [...SRC_INFO.values()].filter(x => x.resident).length,
    needed: needed.size, evicted: window.__mcEvicted || 0,
  };
}

/* ---------- 距离剔除：弱机只画附近的城市 ----------
   [关键修复] 整座城是 InstancedMesh——物体自身位置永远在 (0,0,0)，
   实例坐标全在 instanceMatrix 里。旧代码拿物体原点算距离：手机档
   （cull 240~520m）玩家一走出这个范围，全部 735 个实例网格瞬间
   visible=false，地形/楼/街道集体消失，只剩远处照片地毯和云片。
   现在按预计算的「实例分布包围球」判断：网格里任何一个实例靠近
   玩家就保留，纯靠物体原点的误杀彻底消除。 */
const _cp = new THREE.Vector3();
let CULL_FRAME = 0;
let LAST_CULL = 0;
/* ---------- 自适应画质（2026-11-17a4） ----------
   真机上「卡成 PPT」的成因随设备/场景而变化，写死一套参数必然在别的机型上翻车。
   这里按实测帧率闭环调整两个最有效的旋钮：
     · renderScale：渲染分辨率倍率（0.55×~1.0×）—— 直接决定填充率，收益最大
     · CULL_SCALE：视距倍率（0.5×~1.0×）—— 分块后视距直接决定 draw call 与三角形
   降档快（连续 2 个 1 秒窗口掉帧就降）、升档慢（连续 6 秒富余才升一级），
   避免来回抖动。 */
let CULL_SCALE = 1;
let RENDER_SCALE = 1;
const ADAPT = { ema: 60, lowWin: 0, highWin: 0, last: 0 };
function adaptTick(dtMs) {
  if (dtMs <= 0) return;
  const inst = 1000 / dtMs;
  ADAPT.ema = ADAPT.ema * 0.88 + Math.min(inst, 120) * 0.12;
  const now = performance.now();
  if (now - ADAPT.last < 1000) return;
  ADAPT.last = now;
  const f = ADAPT.ema;
  /* [a7i 关键修复] 阈值必须跟着帧率上限走。上一版写死「f<26 降 / f>45 升」，
     而 a7f 给手机加了 30 帧锁 —— 锁死后 fps 永远到不了 45，于是一旦因进场
     波动掉过一次档，RENDER_SCALE 就永远卡在 0.55（DPR 0.83），整屏发虚、
     退出重进才会恢复。这是「加载出来糊成一坨」的主因。
     现在：降档线 = min(26, cap×0.78)，升档线 = min(45, cap×0.90)。
     60 帧设备保持原行为；30 帧设备 23.4 降 / 27 升，能正常爬回来。 */
  const cap = Math.max(24, parseInt(globalThis.__fpsCapLimit, 10) || 60);
  const LOW = Math.min(26, cap * 0.78);
  const HIGH = Math.min(45, cap * 0.90);
  if (f < LOW) { ADAPT.lowWin++; ADAPT.highWin = 0; } else if (f > HIGH) { ADAPT.highWin++; ADAPT.lowWin = 0; } else { ADAPT.lowWin = 0; ADAPT.highWin = 0; }
  if (ADAPT.lowWin >= 2) {
    ADAPT.lowWin = 0;
    // [a7i] 分辨率下限 0.55 → 0.70：0.55 在 3x 屏上就是 0.83 DPR，肉眼全是糊，
    // 为了几帧把画面毁掉不值；视距先降，像素保底。
    // [2026-11-26 手机糊屏修复] 0.70×1.5=1.05 DPR，实拍就是一片糊。手机屏小、
    // 看点全在立面窗格，像素保底 0.85：宁可少几帧也不毁清晰度。
    if (RENDER_SCALE > 0.85) { RENDER_SCALE = Math.max(0.85, RENDER_SCALE - 0.075); applyRenderScale(); }
    else if (CULL_SCALE > 0.62) { CULL_SCALE = Math.max(0.62, CULL_SCALE - 0.12); LAST_CULL = 0; }
    else if (!PERF.adaptedLow) { PERF.adaptedLow = true; }
    console.warn(`[adapt] ${f.toFixed(0)}fps → render ${RENDER_SCALE.toFixed(2)}× / 视距 ${CULL_SCALE.toFixed(2)}×`);
  } else if (ADAPT.highWin >= 6) {
    ADAPT.highWin = 0;
    if (CULL_SCALE < 1) { CULL_SCALE = Math.min(1, CULL_SCALE + 0.1); LAST_CULL = 0; }
    else if (RENDER_SCALE < 1) { RENDER_SCALE = Math.min(1, RENDER_SCALE + 0.1); applyRenderScale(); }
  }
}
function applyRenderScale() {
  // [修复] 设置面板的 renderScale / maxPixelRatio 与运行时自适应 RENDER_SCALE
  // 必须走同一个入口，否则两边各自 setPixelRatio 互相覆盖：改一次设置把自适应
  // 结果打回，掉一次帧又把用户设置打回。
  const pref = globalThis.__mcRenderPref;
  const maxDpr = pref && pref.maxDpr > 0 ? pref.maxDpr : PERF.dprCap;
  const base = Math.min(devicePixelRatio || 1, PERF.dprCap, maxDpr);
  const scale = (pref && pref.scale > 0 ? pref.scale : 1) * RENDER_SCALE;
  // [a7i] 底线从 0.6 提到 0.75：0.6×1.5 = 0.9 DPR 已是极限，再低整屏发虚。
  const dpr = Math.max(0.85, base * scale);
  renderer.setPixelRatio(dpr);
  /* [深度修复 D2] composer._pixelRatio 是构造时快照，renderer.setPixelRatio
     不会同步它。自适应/设置改 DPR 后必须显式 setPixelRatio，否则后处理
     renderTarget 永远停在初始 DPR，与画布错配（实测 DPR 1.5→1.125 时
     composer 仍按 1.5 渲染）。 */
  const _c = globalThis.__composer;
  if (_c && typeof _c.setPixelRatio === 'function') _c.setPixelRatio(dpr);
  if (typeof window.__updateFov === 'function') window.__updateFov();
}
globalThis.__mcApplyRenderScale = applyRenderScale;

/* [a7m] 普通网格在启动期一次性收集；运行期新增的都是 InstancedMesh，
   全部走 OBJ_DIST 表。旧版每 400ms scene.traverse 整棵场景树（含上千实例网格）
   并对每个对象做一次 Math.hypot，现在两者都不再做。 */
const CULL_PLAIN = [];
function cullPass() {
  CULL_FRAME++;
  const now = performance.now();
  if (now - LAST_CULL < 400) return;
  LAST_CULL = now;
  const base = PERF.cull * (phase === 'menu' ? 0.5 : 1) * CULL_SCALE;
  const cx = camera.position.x, cz = camera.position.z;
  for (let i = 0; i < CULL_PLAIN.length; i++) {
    const o = CULL_PLAIN[i];
    if (o.userData.noCull) continue;
    let g = o.userData.__gs;
    if (g === undefined) {
      if (o.geometry && o.geometry.boundingBox === null) o.geometry.computeBoundingBox();
      const bb = o.geometry && o.geometry.boundingBox;
      const sc = Math.max(o.scale.x, o.scale.y, o.scale.z) || 1;
      g = bb ? ((bb.max.y - bb.min.y) * sc < 3 &&
                ((bb.max.x - bb.min.x) * sc > 60 || (bb.max.z - bb.min.z) * sc > 60)) : false;
      o.userData.__gs = g;
    }
    if (g) { o.visible = true; continue; }   // 贴地大平面永不剔除（防踏空）
    const R = Math.max(base, o.userData.cullR || 0);
    o.visible = distToContent(o, cx, cz) < R;
  }
  for (const [im, od] of OBJ_DIST) {
    if (!im.isInstancedMesh) continue;        // 普通网格已由 CULL_PLAIN 覆盖
    const R = Math.max(base, im.userData.cullR || 0);
    const dx = od.cx - cx, dz = od.cz - cz;
    im.visible = (Math.sqrt(dx * dx + dz * dz) - od.r) < R;
  }
}

/* ---------- 分帧加载队列（手机端不再长时间阻塞主线程） ---------- */
const TEX_QUEUE = [];
let TEX_ACTIVE = 0;
let TEX_GEN = 0;          // [深度修复 D15] 泄漏自愈换代，旧代任务不得扣新代计数
let TEX_BIG_ACTIVE = 0;   // [2026-11-17a6c] ≥1024 的大图在飞数：串行解码，防内存尖峰
const TEX_MAX_ACTIVE = IS_MOBILE ? 4 : 8;   // 同时在飞的图片数：手机减半，压峰值内存
let TEX_RELEASED = false;
let BUILD_DONE = false;      // 场景构建完成标记：贴图释放必须等它，否则材质还没绑上

function enqueueImage(url, onImage, onError, priority, maxSide) {
  // [2026-11-17a2] 支持插队：角色贴图必须在"玩家一睁眼"时就到位。
  // 线上实测它被排在 160+ 张街景升级任务之后，30 秒还没加载 → 主角是个黑剪影。
  if (priority) TEX_QUEUE.splice(Math.min(TEX_QUEUE.length, 8), 0, { url, onImage, onError, maxSide });
  else TEX_QUEUE.push({ url, onImage, onError, maxSide });
  pumpTexQueue();
}

let LAST_TEX_DONE = performance.now();
let LAST_TEX_START = 0;
/* [2026-11-17a6c] 周期泵 —— 死锁修复：pumpTexQueue 只被「入队」和「上一张完成」
   触发，而它内部有 120ms 限流闸。在飞数归零的瞬间若恰好撞闸 return，
   之后再没有任何东西会调它 → 队列永久冻结（实测 171 张卡死 70 秒不动）。
   这也是真机「永远有几张贴图不加载」的候选元凶。250ms 周期兜底，
   内部闸门自行节流，不会增加解码压力。 */
setInterval(pumpTexQueue, 250);
function pumpTexQueue() {
  // [2026-11-17a4] 帧率闸门：解码/上传本身就是主线程活（createImageBitmap 的
  // 回调用 canvas 落地 + three 上传纹理都在主线程）。实测贴图任务占到启动期
  // 47% 的 CPU 采样，216 张排队解码直接把帧率压到个位数 —— 用户看到的就是
  // 「一进游戏就卡成 PPT」。现在按当前帧率动态发牌：
  //   <26fps：完全不启动新媒体加载，先把帧救回来
  //   26~42fps：只留 1 个在飞
  //   >42fps：正常并发
  const f = ADAPT.ema;
  const now = performance.now();
  /* [2026-11-17a6] 名额泄漏自愈：请求既不 resolve 也不 reject 时（真机上遇到过），
     TEX_ACTIVE 会被永久占住，队列彻底停摆 —— 表现就是「永远有几张贴图不加载、
     脚下一直是黑的」。只要 15 秒没有任何一张完成，就认为名额泄漏并强制复位。 */
  if (TEX_ACTIVE > 0 && now - LAST_TEX_DONE > 15000) {
    console.warn(`[tex] 队列疑似卡死（${TEX_ACTIVE} 个在飞、15s 无完成）→ 强制复位`);
    TEX_ACTIVE = 0;
    TEX_BIG_ACTIVE = 0;
    TEX_GEN++;          // [D15] 旧代任务完成后不得再扣减新一代的计数
    LAST_TEX_DONE = now;
  }
  // 任何情况下都至少放行 1 个：完全停掉会让整座城永远糊着（低端机永远到不了
  // 26fps），那是比卡更糟的体验。低帧率时靠拉开发车间隔来限流。
  const budget = f < 20 ? 1 : f < 30 ? 2 : TEX_MAX_ACTIVE;
  if (now - LAST_TEX_START < (f < 25 ? 120 : 0)) return;
  let guard = 64, started = 0;
  while (TEX_ACTIVE < budget && TEX_QUEUE.length && guard-- > 0) {
    /* [2026-11-17a6c] 大图串行：2048² 的解码位图 16MB、1024² 4MB，
       4 张并发解码就是瞬时 30~60MB 尖峰 —— 真机上这正是「落地走两步被系统杀掉」
       的形状。≥1024 的同一时刻只放行 1 张，小图不受影响。 */
    if (TEX_BIG_ACTIVE >= 1 && (TEX_QUEUE[0].maxSide || 0) >= 1024) break;
    const job = TEX_QUEUE.shift();
    startImageLoad(job); started++;
  }
  /* [深度修复 D14] 只在真正发出 job 时刷新时间戳。big-gate break 时一个都没发
     却把 120ms 闸重新上锁，低帧率下后续小图要等下一次 250ms 周期泵。 */
  if (started) LAST_TEX_START = now;
  if (!TEX_QUEUE.length && !TEX_ACTIVE && !TEX_RELEASED && BUILD_DONE) {
    TEX_RELEASED = true;
    requestAnimationFrame(() => requestAnimationFrame(releaseTextureSources));
  }
}

function startImageLoad(job) {
  const { url, onImage, onError, maxSide } = job;
  const gen = TEX_GEN;   // [D15] 捕获代际
  TEX_ACTIVE++;
  const isBig = (maxSide || 0) >= 1024;
  if (isBig) TEX_BIG_ACTIVE++;
  let settled = false;
  /* [2026-11-17a6] 看门狗 —— 用户看到的「地上一整片纯黑」的真凶：
     CP_Asphalt_A 的 createImageBitmap 请求既不 resolve 也不 reject（挂死），
     settled 永远为 false → TEX_ACTIVE 名额泄漏 → 这张图 pending:true 卡到天荒地老，
     底板/补地（共用它）永远是空图，近处 12m×N 全是黑块。
     没有超时的加载队列 = 一颗定时炸弹，这里补上两级兜底：
       8s 未完成 → 换成 <img> 路径重试；再 8s 仍未完成 → 明确失败（会进重试队列）。 */
  let phase = 'bitmap';
  let watchdog = setTimeout(() => {
    if (settled) return;
    if (phase === 'bitmap') {
      phase = 'img';
      console.warn('[tex] bitmap timeout → <img> 兜底:', url);
      try { legacyImage(); } catch (_) { done(null); }
      // [2026-11-20 审查修复 F-38] <img> 路径也需要自己的看门狗：之前只有一级，
      // <img> 再挂起时 settled 永远 false → TEX_ACTIVE 名额永久泄漏。
      watchdog = setTimeout(() => {
        if (!settled) {
          console.warn('[tex] <img> 兜底仍超时，放弃本次:', url);
          done(null);
        }
      }, 8000);
    } else {
      console.warn('[tex] 加载超时，放弃本次:', url);
      done(null);
    }
  }, 8000);
  const done = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    /* [深度修复 D15] 代际守卫：自愈清零后旧任务仍会完成，若直接扣减会把
       新放行的 big job 的 TEX_BIG_ACTIVE 误减到 0 → 大图并发、内存尖峰。
       旧代任务仍需走 onError 复位对应 info.pending，只是不动计数。 */
    if (gen === TEX_GEN) {
      TEX_ACTIVE = Math.max(0, TEX_ACTIVE - 1);
      if (isBig) TEX_BIG_ACTIVE = Math.max(0, TEX_BIG_ACTIVE - 1);
      LAST_TEX_DONE = performance.now();
    }
    if (v) onImage?.(v); else onError?.();
    pumpTexQueue();
  };
  // [2026-11-17a4] 解码搬到工作线程。
  // 旧路径 `new Image().src + canvas.drawImage(高质量缩放)` 全部跑在主线程：
  // 解码一张 2048² JPEG 约 40~120ms，276 张贴图串起来 = 十几秒主线程长任务，
  // 期间 rAF 无法推进 —— 这就是「一进去就卡成 PPT」（实测 20 秒里 13.7 秒被
  // 长任务占满）。createImageBitmap 的解码和缩放都在独立线程，主线程只剩
  // 一次 1:1 drawImage（≤512²，约 1~3ms）。
  if (!window.createImageBitmap) { legacyImage(); return; }
  fetch(url, { cache: 'force-cache' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); })
    .then(blob => createImageBitmap(blob))
    .then(async (bmp) => {
      const m = Math.max(bmp.width, bmp.height);
      // 超限时在解码线程里直接缩到目标边长（resizeQuality 高质量走 CPU 线程池）
      if (maxSide && m > maxSide + 1) {
        const k = maxSide / m;
        const w = Math.max(1, Math.round(bmp.width * k));
        const h = Math.max(1, Math.round(bmp.height * k));
        try {
          const small = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
          bmp.close();
          bmp = small;
        } catch (_) { /* 老 Safari 不支持 resize 选项：保持原尺寸，后面 fitImage 兜底 */ }
      }
      // 转回 canvas：three 对 canvas 的 flipY / UNPACK 语义与 <img> 完全一致，
      // 直接用 ImageBitmap 上传会在部分浏览器上忽略 flipY，导致所有贴图上下颠倒。
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      done(c);
    })
    .catch(() => legacyImage());

  function legacyImage() {
    if (settled) return;
    phase = 'img';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = url;
    // <img> 也可能挂（网络半开）：由外层 watchdog 的第二次触发兜住
  }
}

/** 带上限的贴图加载（替代 THREE.TextureLoader.load，避免整张 2K 图进显存） */
function cappedTexture(url) {
  const tex = new THREE.Texture();
  // [2026-11-17a2] 必须登记到 SRC_INFO：releaseTextureSources 的「角色贴图
  // 永不释放」保护是按 SRC_INFO 的 url 判断的，没登记就等于没保护 →
  // 主角贴图 CPU 副本被清掉后，线上表现为「角色全黑剪影」（本地复现不了，
  // 因为本地加载快、释放时机落在挂载之后）。
  registerSource(tex, url, true);
  loadMgr.itemStart(url);
  enqueueImage(url,
    (img) => {
      // 建场阶段一般按「中档」上传（避免几十张 1024 同时撑爆峰值内存）。
      // [2026-11-17a5] 但地面类例外：沥青/人行道/瓷砖一共 14 张、玩家永远贴着看，
      // 一进场就必须是清晰的 —— 否则脚下先是糊的、几秒后才"刷新"变清。
      const buildSide = texTargetSide(url);
      const fitted = fitImage(img, buildSide);
      if (tex.image !== fitted) { tex.image = fitted; tex.dispose(); }
      tex.needsUpdate = true;
      bumpClones(tex.source, fitted);
      const side = Math.max(fitted.width || 0, fitted.height || 0);
      // 中图缓存只给手机（降级要复用）；桌面不限制分辨率，缓存中图纯属浪费 JS 堆
      const mid = (IS_MOBILE && side > 256) ? makeThumb(img, 256) : null;
      const info = SRC_INFO.get(tex.source.uuid);
      if (info) {
        const prev = info.bytes || 0;
        info.side = side;
        info.mid = mid;
        info.bytes = texBytesOf(fitted.width || 1, fitted.height || 1);
        info.resident = true;
        // [2026-11-17a2] 补记账：建场路径不走 onSourceLoaded，旧代码这里不累加
        // RESIDENT_BYTES → 预算统计偏低 → trimToBudget 迟迟不触发 → 峰值失控。
        RESIDENT_BYTES += info.bytes - prev;
        // [a7d] 与驻留路径对齐：生成 64px 缩略图 + 上传后延时置换 CPU 副本
        if (!info.thumb) info.thumb = makeThumb(fitted);
        scheduleSwapOut(info);
      }
      tex.userData.side = side;
      if (mid) tex.userData.mid = mid;
      loadMgr.itemEnd(url);
    },
    () => { console.warn('[tex] missing', url); loadMgr.itemError(url); loadMgr.itemEnd(url); },
    // [2026-11-17a5] 地面类贴图同样插队：它们原本排在建场顺序的末尾，
    // 进场后 20~40 秒脚下一直是黑板 —— 这是「刷得不合理」最直接的来源。
    /\/chars\//i.test(url) || GROUND_TEX_RE.test(decodeURIComponent(url)) || FACADE_TEX_RE.test(decodeURIComponent(url)),
    texTargetSide(url) || TEX_MAX || 0);
  return tex;
}

/**
 * 释放贴图的 CPU 侧副本（解码后的 Image / Canvas 各 4~16MB）。
 * GPU 上的纹理照常保留 → 画质不降、常驻内存大幅下降（手机不被 OOM 杀掉的关键）。
 * 只在贴图全部上传到 GPU 之后执行，释放前不再触发重传。
 */
function releaseTextureSources() {
  // [a7d] 移动端不再直接跳过：a4 时代不释放是为了 clone 的 source 不能置 null
  //（会黑块）。现在 clone 走 swapOutCpuCopy（置换成 64px 缩略图而非 null），
  // 意外触发重传也只会显示低清缩略图而不是纯黑——移动端同样纳入释放。
  const seen = new Set();
  let freed = 0, bytes = 0;
  // 角色贴图永不释放：它们体量很小（几张），却最影响观感，
  // 且一旦上下文丢失需要重新上传，CPU 副本没了就变黑块。
  const keep = new Set();
  window.__player?.group?.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        if (m[k]?.source) keep.add(m[k].source.uuid);
      }
    }
  });
  scene.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        const t = m[k];
        if (!t || !t.source || seen.has(t.source)) continue;
        seen.add(t.source);
        const d = t.source.data;
        if (!d) continue;
        if (t.userData?.noRelease) continue;   // 角色贴图：永久保留 CPU 副本
        const si = SRC_INFO.get(t.source.uuid);
        if (si && !si.resident) continue;   // 当前挂的是 64px 缩略图：保留，用于重建/重绑
        // 只释放「已经真正上传到 GPU」的贴图：没上传过的（被视锥剔除、还没露过面）
        // 一旦释放就再也传不上去 → 会变成黑块
        if (keep.has(t.source.uuid)) continue;
        // [2026-11-17a2] 角色贴图按 URL 兜底保护：上面的 keep 集合依赖
        // window.__player.group 已建立，而建场完成后的首次释放可能早于角色挂载
        // → keep 为空 → 主角贴图的 CPU 副本被清掉，线上表现为「角色全黑剪影」。
        const ci = SRC_INFO.get(t.source.uuid);
        if (ci && /chars\//i.test(ci.url || '')) continue;
        // [a7d] 有 clone 的 source 改走「置换缩略图」：clone 与原贴图共享 source.data，
        // 置 null 后 clone 任何一次 needsUpdate 都会上传空图 → 纯黑块。换成 thumb
        // 则意外重传也只是一张 64px 低清图，画面永不黑。
        if (TEX_CLONES.has(t.source.uuid)) { if (ci) swapOutCpuCopy(ci); continue; }
        const props = renderer.properties?.get?.(t);
        if (!props || !props.__webglTexture) continue;
        const w = d.width || d.naturalWidth || 0, h = d.height || d.naturalHeight || 0;
        bytes += w * h * 4;
        /* [a7i] 真凶修复：不再 `source.data = null`。
           null 之后只要发生一次 needsUpdate（材质重建 / clone 同步 / 上下文恢复 /
           驻留升级），three 就会把「空图」上传成空纹理 → 地面和墙面直接纯黑；
           而 info.side 仍记着 1024，residencyPass 以为它清晰，永远不再重传。
           射线实测命中黑区就是 CP_Asphalt：img=NULL / srcData=null / gpu=true / side=1024。
           现在统一置换为 256px 中图（每张 ~0.26MB）：万一重传最多降清，绝不变黑。 */
        if (ci && (ci.mid || ci.thumb)) {
          const was = ci.imgReleased;
          swapOutCpuCopy(ci);
          if (ci.imgReleased !== was) freed++;
          continue;
        }
        // 连中图都生成不了：宁可多占内存，也不能留 null 变黑块
      }
    }
  });
  if (freed) window.__mcReleasedMB = (window.__mcReleasedMB || 0) + Math.round(bytes / 1048576);
  if (freed && !window.__mcReleaseLogged) { window.__mcReleaseLogged = true; console.log(`[mc] 逐步释放贴图 CPU 副本（累计约 ${window.__mcReleasedMB} MB）`); }
}

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xc3d4e2, 0.00052);  // [2026-11-26 雾蒙蒙修复] 灰蓝0.00085在600m就有23%灰罩、1200m 65% → 换迈阿密亮天色、密度降4成，远处淡入天空而非糊一层灰

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.3, PERF.isMobileUA ? 800 : 9000);
// 锁定水平 FOV：横屏（宽画幅）时若沿用 75° 纵向视角，水平视角会被拉到 120°+，
// 画面被拉宽、角色被压小。把纵向 FOV 随宽高比收窄，构图才正常。
const BASE_FOV = 75, BASE_ASPECT = 16 / 9;
function updateAdaptiveFov(cam) {
  const aspect = (cam.aspect || BASE_ASPECT);
  // [2026-11-16a5] 竖屏（手机不旋转）时按「锁定水平视角」算出来的纵向 FOV 会被
  // 上限 75° 压回去，横向只剩 39°——实机录屏里正是这个原因让人「只看到一堵墙」。
  // 竖屏放开到 88°（横向约 48°），至少能看到街道两侧。
  if (aspect < 1) {
    const vPortrait = 2 * Math.atan(Math.tan(28 * Math.PI / 180) / aspect) * 180 / Math.PI;
    const fovP = Math.max(BASE_FOV, Math.min(88, vPortrait));
    if (Math.abs(cam.fov - fovP) > 0.01) { cam.fov = fovP; cam.updateProjectionMatrix(); }
    return;
  }
  const hFov = 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) * BASE_ASPECT);
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / aspect);
  const fov = Math.max(42, Math.min(BASE_FOV, vFov * 180 / Math.PI));
  if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
}
updateAdaptiveFov(camera);

// ---------- procedural sky dome (shader-built; day / dusk / night presets) ----------
const skyUniforms = {
  uSunDir:   { value: new THREE.Vector3(0, -1, 0) },
  uZenith:   { value: new THREE.Color(0x23272e) },
  uHorizon:  { value: new THREE.Color(0x555c66) },
  uGround:   { value: new THREE.Color(0x2a2e34) },
  uSunColor: { value: new THREE.Color(0xfff4e0) },
  uSunSize:  { value: 0.012 },   // disk radius (radians)
  uSunGlow:  { value: 300.0 },   // halo tightness
  uHalo:     { value: 0.0 },     // halo strength
  uSunDisk:  { value: 2.5 },     // disk HDR intensity (feeds bloom — keep moderate)
  uTime:     { value: 0.0 },
  uCloudCover: { value: 0.52 },
  uCloudCol: { value: new THREE.Color(0x262c38) },
  uCloudLit: { value: 0.35 },
  uCloudAlpha: { value: 0.8 },
  uCloudScale: { value: 0.85 },
  uWind:     { value: new THREE.Vector2(0.012, 0.005) },
  uStars:    { value: 1.0 },
  uMoon:     { value: 1.0 },
  uMoonDir:  { value: new THREE.Vector3(-0.45, 0.5, -0.35).normalize() },
  uMoonCol:  { value: new THREE.Color(0xdfe6ff) },
  uMoonSize: { value: 0.022 },
};
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(100, 32, 16),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;   // pin to far plane — dome follows camera
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 uSunDir, uZenith, uHorizon, uGround, uSunColor;
      uniform float uSunSize, uSunGlow, uHalo, uSunDisk;
      uniform float uTime, uCloudCover, uCloudLit, uCloudAlpha, uCloudScale;
      uniform vec3 uCloudCol;
      uniform vec2 uWind;
      uniform float uStars, uMoon, uMoonSize;
      uniform vec3 uMoonDir, uMoonCol;

      float hash(vec2 p){ p = fract(p*vec2(123.34, 345.45)); p += dot(p, p+34.345); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i+vec2(0.,0.)), hash(i+vec2(1.,0.)), u.x),
                   mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y);
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.55;
        for(int i=0;i<5;i++){ v += a*vnoise(p); p = p*2.03 + 7.1; a *= 0.5; }
        return v;
      }
      float hash3(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }

      void main() {
        vec3 v = normalize(vDir);
        float h = v.y;
        float sky = pow(clamp(h, 0.0, 1.0), 0.45);
        vec3 col = mix(uHorizon, uZenith, sky);
        col = mix(uGround, col, smoothstep(-0.22, 0.04, h));   // below horizon

        // sun
        float d = max(dot(v, uSunDir), 0.0);
        col += uSunColor * pow(d, uSunGlow) * uHalo;           // halo
        float ang = acos(d);
        float disk = 1.0 - smoothstep(uSunSize * 0.85, uSunSize, ang);
        col += uSunColor * disk * uSunDisk;                    // HDR disk (blooms)

        // stars (night)
        if (uStars > 0.001 && h > 0.0) {
          vec3 ip = floor(v * 260.0);
          float sh = hash3(ip);
          float star = smoothstep(0.9965, 1.0, sh);
          star *= 0.75 + 0.25 * sin(uTime * 2.5 + sh * 90.0);  // twinkle
          star *= smoothstep(0.0, 0.35, h);                    // fade near horizon
          col += vec3(star) * uStars;
        }

        // moon (night)
        if (uMoon > 0.001) {
          float md = max(dot(v, uMoonDir), 0.0);
          float mang = acos(md);
          float mdisk = 1.0 - smoothstep(uMoonSize * 0.92, uMoonSize, mang);
          float mott = fbm(v.xy * 6.0 + 11.0);
          col += uMoonCol * (0.72 + 0.28 * mott) * mdisk * 2.6 * uMoon;
          col += uMoonCol * pow(md, 400.0) * 0.6 * uMoon;      // glow
        }

        // clouds — planar projection, two FBM layers, sun-lit tint
        if (uCloudAlpha > 0.001) {
          float proj = h + 0.18;
          vec2 cuv = v.xz / max(proj, 0.035) * uCloudScale + uWind * uTime;
          float n1 = fbm(cuv);
          float n2 = fbm(cuv * 2.13 + 19.7 - uWind * uTime * 0.6);
          float cd = smoothstep(uCloudCover, uCloudCover + 0.28, n1);
          cd = max(cd, smoothstep(uCloudCover + 0.12, uCloudCover + 0.42, n2) * 0.85);
          cd *= smoothstep(0.015, 0.22, h);                    // fade at horizon
          float sunFace = pow(max(dot(normalize(vec3(v.x, 0.3, v.z)), uSunDir), 0.0), 3.0);
          vec3 cc = mix(uCloudCol, uSunColor, clamp(sunFace * uCloudLit, 0.0, 1.0));
          cc *= 0.85 + 0.15 * n2;                              // internal shading
          col = mix(col, cc, clamp(cd * uCloudAlpha, 0.0, 1.0));
        }

        gl_FragColor = vec4(col, 1.0);
      }`,
  }));
skyDome.frustumCulled = false;
skyDome.renderOrder = -1;
skyDome.userData.noCull = true;   // 天穹永远跟随相机，绝不参与距离剔除
scene.add(skyDome);

// ---------- environment map from the pack's own reflection probe (cross -> equirect, see SKILL.md) ----------
const pmrem = new THREE.PMREMGenerator(renderer);
{
  const tex = cappedTexture('./data/env_equirect.png');
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const envTex = tex;
  const waitEnv = () => {
    if (!envTex.image) { setTimeout(waitEnv, 60); return; }
    scene.environment = pmrem.fromEquirectangular(envTex).texture;
    scene.environmentIntensity = SKY_PRESETS[presetName].envInt;
    envTex.dispose();
  };
  waitEnv();
}

// ---------- lights (driven by the sky preset) ----------
const hemi = new THREE.HemisphereLight(0xcfd2d4, 0x2a2622, 1.3);
// [2026-11-17a4] 手机端补一盏弱环境光：沥青路面反照率只有 0.06~0.1，仅靠半球光
// 在 dusk/night 下就是一片纯黑（用户反馈的「地面是黑的」）。0.55 的均匀环境光
// 能把路面从 8/255 抬到 25/255 左右，同时不破坏夜景对比（桌面端不加，保持原设定）。
const mobileAmbient = new THREE.AmbientLight(0xd8d2c6, IS_MOBILE ? 1.05 : 0);
scene.add(mobileAmbient);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e2, 0.55);
scene.add(sun);
globalThis.__mcSunLight = sun;   // [F-13] 设置面板 shadowMapSize 的落地目标（game-shell 消费）
// [a7f 真实阴影] shadowMap 以前只是个空开关——全库没有任何 castShadow 标记。
// 现在补真：太阳投影 + 正交阴影相机跟随相机走（只有身边一圈参与深度 pass，
// 桌面 300m / 手机 170m，地图尺寸桌面 2048 / 手机 1024）。
if (REAL_SHADOWS) {
  sun.castShadow = true;
  const ext = PERF.tier === 'full' ? 300 : PERF.tier === 'lite' ? 220 : 170;
  const sc = sun.shadow;
  sc.mapSize.set(PERF.tier === 'full' ? 2048 : 1024, PERF.tier === 'full' ? 2048 : 1024);
  sc.camera.left = -ext; sc.camera.right = ext;
  sc.camera.top = ext; sc.camera.bottom = -ext;
  sc.camera.near = 1; sc.camera.far = 900;   // 光源在跟随点上方 400m（见 SUN_OFF）
  sc.bias = -0.00035;
  sc.normalBias = 0.8;                       // 城市尺度大三角形，法线偏置压 acne
  scene.add(sun.target);
}
const SUN_OFF = new THREE.Vector3();           // 每次昼夜预设后刷新 = 太阳方向 × 400
globalThis.__mcSunFollow = fp => {             // 主循环每帧调用；也暴露给调试
  if (!sun.castShadow) return;
  sun.target.position.copy(fp);
  sun.position.copy(fp).add(SUN_OFF);
};
/* 夜间补光：跟着玩家走的柔和点光（r169 物理光照单位，26cd → 6m 处约 0.7 照度）。
   实机录屏显示背街/巷子里除了霓虹没有任何光源，走进去就是全黑——统一提亮半球光会
   把出生点这种霓虹密集区冲爆，所以只在夜间给玩家一盏近场补光，保证"脚下永远看得见"。 */
const fillLight = new THREE.PointLight(0xc8d4e0, 0, 34, 2);
scene.add(fillLight);

// presets: sky colors + sun + light + post + fog per time of day
const SKY_PRESETS = {
  night: {  // moon + stars + dark cloud silhouettes over the pack's own overcast mood
    zenith: 0x141821, horizon: 0x3a414c, ground: 0x0d1015,
    sunDir: [0, -1, 0], sunColor: 0xfff4e0, sunSize: 0.012, sunGlow: 300, halo: 0,
    cloudCover: 0.52, cloudCol: 0x2b323f, cloudLit: 0.3, cloudAlpha: 0.8, cloudScale: 0.85,
    wind: [0.012, 0.005], stars: 1.0, moon: 1.0,
    moonDir: [-0.45, 0.5, -0.35], moonCol: 0xdfe6ff, moonSize: 0.022,
    // [2026-11-16a5 修复] 实机录屏实测：夜间画面亮度均值仅 6~15/255（26 秒几乎全黑）。
    // 根因一：方向光沿 sunDir=(0,-1,0) 从地底向上照，地面/墙面完全收不到；
    // 根因二：hemisphere 强度 1.3 压不住暗色路面反照率。改为「月光方向」打光
    // （沿 moonDir 从天上照）并整体提亮，巷子/背街不再纯黑。
    lightDir: [-0.45, 0.5, -0.35],
    hemiSky: 0xb0bac8, hemiGnd: 0x4a4238, hemiInt: 3.05,   // [a6c] 2.4 → 3.05：远楼不再是剪影
    sunInt: 0.85, sunLightCol: 0xbfd0e8,
    // [2026-11-20 审查修复 F-02] fog/fogD 之前被挤进行内注释后面，字段丢失 →
    // applyPreset 把 scene.fog.density 写成 undefined。三个预设必须带 fog/fogD。
    exposure: 1.44, bloom: [0.38, 0.5, 0.9],               // [a6c] bloom 0.55 → 0.38：压掉死白
    fog: 0x454c56, fogD: 0.00085,
    envInt: 0.75, clouds: 0x9aa0a8, bg: 0x141821,
  },
  day: {  // blue sky with white drifting clouds
    zenith: 0x2a6ad0, horizon: 0xc9dff2, ground: 0x8b8880,   // [迈阿密] 大地灰：地平线以下是城市而非黑洞
    sunDir: [0.35, 0.75, 0.45], sunColor: 0xfff4e0, sunSize: 0.011, sunGlow: 380, halo: 1.0, sunDisk: 2.5,
    cloudCover: 0.46, cloudCol: 0xf4f8fc, cloudLit: 0.55, cloudAlpha: 0.92, cloudScale: 1.0,
    wind: [0.02, 0.008], stars: 0.0, moon: 0.0,
    moonDir: [-0.45, 0.5, -0.35], moonCol: 0xdfe6ff, moonSize: 0.022,
    hemiSky: 0xbcd6f5, hemiGnd: 0x7a7268, hemiInt: 2.25,   // [a6c] 1.75 → 2.25：街谷不再死黑
    sunInt: 1.9, sunLightCol: 0xfff2dd,
    exposure: 1.12, bloom: [0.22, 0.4, 0.95],              // [a6c] 压 bloom
    fog: 0xa9bccd, fogD: 0.0003,    // [2026-11-26] 米褐 0xb9b4a8 → 海雾蓝灰：米褐把整城洗成白墙
    envInt: 0.9, clouds: 0xffffff, bg: 0x9fc2e8,
  },
  dusk: {  // sunset clouds lit pink/orange, first stars, neon pops
    zenith: 0x262a55, horizon: 0xf2a06a, ground: 0x1e222b,
    sunDir: [0.8, 0.12, 0.35], sunColor: 0xffb27a, sunSize: 0.014, sunGlow: 140, halo: 1.4, sunDisk: 2.0,
    cloudCover: 0.42, cloudCol: 0x54465e, cloudLit: 1.6, cloudAlpha: 0.92, cloudScale: 0.9,
    wind: [0.015, 0.006], stars: 0.3, moon: 0.0,
    moonDir: [-0.45, 0.5, -0.35], moonCol: 0xdfe6ff, moonSize: 0.022,
    hemiSky: 0x8a86b0, hemiGnd: 0x554840, hemiInt: 1.85,   // [a6c]
    sunInt: 1.05, sunLightCol: 0xffb98a,
    exposure: 1.16, bloom: [0.42, 0.5, 0.85],              // [a6c]
    fog: 0x8d7f8e, fogD: 0.0007,
    envInt: 0.65, clouds: 0xf0c0a0, bg: 0x262a55,
  },
};
const PRESET_ORDER = ['night', 'day', 'dusk'];
let presetName = 'day';   // [迈阿密] 默认白天：真实 PBR 贴图/玻璃反射/海岸线只在日光下成立；夜间只会看到一片深蓝
const cloudMeshes = [];   // filled during scene build; tinted per preset
function applyPreset(name) {
  presetName = name;
  const p = SKY_PRESETS[name];
  skyUniforms.uZenith.value.set(p.zenith);
  skyUniforms.uHorizon.value.set(p.horizon);
  // [a7i] 地平线以下的天空球颜色：以前用 p.ground（夜间 0x0d1015 / 黄昏 0x1e222b，近黑）。
  // 手机 cull 只有 800m，远处建筑被裁掉后露出的就是这一大块近黑，
  // 在用户眼里就是「没加载出来的一团黑」。手机端改为雾色 —— 远景消失在雾里，不是掉进黑洞。
  skyUniforms.uGround.value.set(p.ground);   // [迈阿密] 地平线以下用大地色：程序化地面已关，别露黑洞
  skyUniforms.uSunColor.value.set(p.sunColor);
  skyUniforms.uSunDir.value.set(...p.sunDir).normalize();
  skyUniforms.uSunSize.value = p.sunSize;
  skyUniforms.uSunGlow.value = p.sunGlow;
  skyUniforms.uHalo.value = p.halo;
  skyUniforms.uSunDisk.value = p.sunDisk ?? 2.5;
  skyUniforms.uCloudCover.value = p.cloudCover;
  skyUniforms.uCloudCol.value.set(p.cloudCol);
  skyUniforms.uCloudLit.value = p.cloudLit;
  skyUniforms.uCloudAlpha.value = p.cloudAlpha;
  skyUniforms.uCloudScale.value = p.cloudScale;
  skyUniforms.uWind.value.set(p.wind[0], p.wind[1]);
  skyUniforms.uStars.value = p.stars;
  skyUniforms.uMoon.value = p.moon;
  skyUniforms.uMoonDir.value.set(...p.moonDir).normalize();
  skyUniforms.uMoonCol.value.set(p.moonCol);
  skyUniforms.uMoonSize.value = p.moonSize;
  hemi.color.set(p.hemiSky); hemi.groundColor.set(p.hemiGnd); hemi.intensity = p.hemiInt;
  sun.color.set(p.sunLightCol); sun.intensity = p.sunInt;
  sun.position.copy(skyUniforms.uSunDir.value).multiplyScalar(400);
  // 夜间方向光改从「月光方向」照下来：旧的 sunDir=(0,-1,0) 让平行光从地底往上打，
  // 地面和墙面一点都收不到，只剩一盏半球光——实机里就是"走出霓虹区全黑"。
  if (p.lightDir) sun.position.set(p.lightDir[0], p.lightDir[1], p.lightDir[2]).multiplyScalar(400);
  SUN_OFF.copy(sun.position);   // [a7f] 阴影相机跟随用的太阳方向偏移（指向光源）
  fillLight.intensity = name === 'night' ? 46 : 0;
  renderer.toneMappingExposure = p.exposure;
  // [2026-11-17a4] 手机屏幕小、亮度低，dusk/night 的背街在实机上会糊成一片黑，
  // 用户反馈的「黑色区域」有一半是这个。移动端把半球光与环境曝光各抬一点，
  // 让贴图细节在暗部也能读出来（桌面端保持原美术设定不变）。
  // [a7i] 空法线/空 AO 修好后，这里不再需要为「黑布」陪跑：
  // 1.55/1.32 会把夜景推成白夜（白天路面几近纯白）。回到克制档。
  if (PERF.isMobileUA) {
    // 夜间本来有大量霓虹/环境光，且手机没有 Bloom 压高光，再叠就成白夜。
    // 夜间略压（0.94），白天略抬（1.12），保证「暗但有细节」。
    const nightBoost = name === 'night';
    // [2026-11-26 街谷补光] 手机站在塔楼之间时，两侧墙把天空遮掉一半，
    // 角色和近地面偏暗（实拍「黑」的来源）。白天半球光再抬一档、曝光 +4%。
    hemi.intensity *= nightBoost ? 0.94 : 1.20;
    renderer.toneMappingExposure *= nightBoost ? 0.98 : 1.12;
  }
  // [修复] 泛光强度：以时段预设为基准，用设置项做等比缩放（默认 0.55 → 系数 1，
  // 不破坏白天/黄昏/夜晚的美术差异），关闭泛光时归零。之前 applySettings 先写
  // 强度、applyPreset 后写预设值，导致「泛光强度」设置永远无效。
  const bs = (() => { try { return JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}') || {}; } catch { return {}; } })();
  const userStr = +bs.bloomStrength;
  const k = Number.isFinite(userStr) && userStr > 0 ? userStr / 0.55 : 1;
  bloom.strength = bs.bloom === false ? 0 : p.bloom[0] * k;
  bloom.radius = p.bloom[1]; bloom.threshold = p.bloom[2];
  // [2026-11-20 审查修复 F-02] 防御：预设缺 fog/fogD 时绝不能把 undefined 写进 scene.fog
  // [修复] 雾密度以「预设基准 × 用户可视距离调制」为单一来源，每次从常量重算，
  // 不依赖上一次 density（否则重复调用会复合缩放）。设置面板的「雾开关/可视距离」
  // 因此真正生效，且 F-43 / a7i 的手机端剔除边界遮蔽下限都保留。
  if (typeof p.fogD === 'number' && Number.isFinite(p.fogD)) {
    const fs = (() => { try { return JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}') || {}; } catch { return {}; } })();
    const fogOn = fs.fog !== false;                     // 未写盘时默认开
    const fogDist = Math.max(200, +fs.fogDistance || 880);
    const base = p.fogD * (880 / fogDist);
    /* [a7i] 手机端雾密度必须保证「剔除边界处基本全遮」：cull=800 时
       FogExp2 在 800m 只剩 exp(-(0.00085*800)²)=0.63 → 37% 雾，
       建筑凭空消失、露出天空球，整片远景像被挖空。抬到 1.75/cullR（≈0.0022），
       800m 处 96% 被雾吃掉；240m 处仍有 76% 清晰，街景不受影响。 */
    // [运行时修复 R4] 下限半径要跟随用户可视距离：旧写法恒用 PERF.cull(800)，
    // 用户把 fogDistance 调到 300 时 floor 仍压住 base，设置看起来完全无效
    // （实测 300 与 880 的 density 都是 0.0021875）。
    const shadeR = Math.min(PERF.cull || 800, fogDist);
    // [2026-11-26 画质修复] 1.75/cull 的浓雾把手机整屏染成青蓝（实测 density 0.00219，
    // 400m 处 53% 雾、地面/角色全被雾色 #c3d4e2 染蓝）。降到 1.2/cull：
    // 800m 边界仍有 ~77% 雾遮住剔除面，但 200m 内回到清晰，中景不再糊成蓝墙。
    // [2026-11-26 手机糊白修复] 1.2/cull 在 400m 就 25% 雾、800m 66% 雾，实拍是一片
    // 奶白玻璃。0.95 在 400m 约 12%、剔除边界（1200m）约 50%：远景有雾但不是白墙。
    const floor = PERF.isMobileUA ? 0.95 / Math.max(shadeR, 900) : 0;
    scene.fog.density = fogOn ? Math.max(base, floor) : 0;
  }
  if (p.fog !== undefined) scene.fog.color.set(p.fog);
  // [2026-11-26] NOVA 全屏合成有独立的雾色/uFogColor（与 Three 场景雾是两套），
  // 预设切换必须同步，否则 day 也套着默认深蓝黑雾。夜间沿用深蓝、白天用预设中性色。
  if (window.__nova && typeof window.__nova.setFogColor === 'function') {
    window.__nova.setFogColor(p.fog !== undefined ? p.fog : 0xb9b4a8);
  }
  scene.background = new THREE.Color(p.bg);
  scene.environmentIntensity = p.envInt;
  for (const c of cloudMeshes) c.material.color.set(p.clouds);
  // [LCR] 光照预设同步到光追（降级时 no-op）
  if (window.__lcr && window.__lcr.active) window.__lcr.setLightingPreset(name);
}

// ---------- data ----------
const [MATS, PREFABS, SCALES, SCENE, SIGN_FIXES, FBXORD] = await Promise.all([
  J('./data/materials.json'), J('./data/prefabs.json'),
  J('./data/scales.json'), J('./data/scene.json'),
  J('./data/sign_fixes.json'), J('./data/fbx_mat_order.json'),
]);
loadMsg('loading models & textures…');

// procedural deck/plaza clutter (scripts/gen_deck_clutter.py): the bare
// stacked-slum platforms and synthetic plazas read as empty plates — scatter
// the pack's own props over them. Placements merge into the normal pipeline
// (same per-prefab InstancedMeshes, zero extra draw calls). ?noclutter skips
// (the generator uses it to probe the raw surfaces).
if (!location.search.includes('noclutter')) {
  const [clutter, belt, furn] = await Promise.all([
    fetch('./data/deck_clutter.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch('./data/belt.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
    // [2026-11-17a5] 全要素微规划（模板 v1.1 硬规则）：路灯 35m 双侧交错 / 井盖 40m /
    // 路口四角垃圾桶 / 长椅 / 贫民区垃圾堆与大垃圾箱。骨架取自真实道路+人行道块，
    // prefab 全部来自实测校验资产池（gen_street_furniture.py 生成，233 件）。
    fetch('./data/street_furniture.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (clutter?.length) SCENE.placements.push(...clutter);
  if (belt?.length) SCENE.placements.push(...belt);
  if (furn?.length) SCENE.placements.push(...furn);
  console.log(`deck clutter: ${clutter?.length ?? 0}, belt: ${belt?.length ?? 0}, street furniture: ${furn?.length ?? 0}`);
}

// synthetic material for the slums' elevated deck surfaces (see bakePrefab):
// their authored UVs stretch the city-photo's highway strip into blank gray
// "steel plates" — re-projected planar UVs + tiled concrete read as real decks
MATS.CP_Deck = {
  tex: 'CP_Concrete_03_A.tga', normalTex: 'CP_Concrete_03_N.tga',
  // [2026-11-16a6] 0.32 的反照率在夜间几乎没有可读亮度（整条街看起来是黑的），
  // 抬到 0.52：仍是深灰混凝土，但夜里能看清铺装与缝线。
  texScale: [1, 1], color: [0.52, 0.535, 0.565, 1], emission: [0, 0, 0, 1],
  metallic: 0, smoothness: 0.08, mode: 0, cutoff: 0.5, bumpScale: 1, shader: 'builtin',
};


// ---------- texture factory ----------
// deploy build: prefer .webp (manifest), fall back to .png (master bundle)
const WEBP_SET = new Set(await fetch('./data/textures_webp.json')
  .then(r => (r.ok ? r.json() : [])).catch(() => []));
function texFile(file) {
  const base = file.replace(/\.(tga|psd|tif|png|webp)$/i, '');  // [F-40] webp 也要剥，否则拼出 a.webp.png
  return WEBP_SET.has(base + '.webp') ? base + '.webp' : base + '.png';
}
const texCache = {};
/* 移动端跳过纯 PBR 附加通道（法线 / 金属-光滑 / AO）。
   245 张贴图里有 180 张是这三个通道，albedo 只有 57 张：跳过它们意味着
   解码量少 2/3、显存少 2/3（240MB → ~80MB）、像素着色少 3 次采样。
   代价是墙面没有凹凸感、金属反射变成哑光 —— 在 5fps 面前这是划算的交换。 */
const SKIP_PBR_EXTRA = IS_MOBILE && !/[?&]notrim/.test(location.search);
const isPbrExtra = f => /(_N|_MS|_AO)\.(webp|png|tga)$/i.test(f);
const BLANK_TEX = (() => {
  const t = new THREE.Texture();
  t.userData.blank = true;
  return t;
})();
function texture(file, srgb = true) {
  file = texFile(file);
  /* [a7i 真凶] 跳过 PBR 通道时必须返回 null（不绑定），绝不能返回空纹理。
     旧实现返回 BLANK_TEX（无 image）：材质仍带 normalMap/aoMap，着色器照常
     采样，拿到的是 (0,0,0,1) —— 法线归零、AO 归零，整个表面收不到光照，
     贴图完好也渲染成纯黑。手机端「没加载出来的一团黑」就是这一条。 */
  if (SKIP_PBR_EXTRA && isPbrExtra(file)) return null;
  const key = file + (srgb ? '' : '#lin');
  if (!texCache[key]) {
    const url = './textures/' + encodeURIComponent(file);
    const t = cappedTexture(url);
    t.flipY = false;                       // glTF UV convention
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = MAXANISO;
    texCache[key] = t;
    const info = registerSource(t, url, srgb);
    // 首次加载完成后登记字节数
    const prevOnLoad = t.userData.__onLoad;
    t.userData.__onLoad = true;
    let tries = 0;
    const check = () => {
      if (t.image) { onSourceLoaded(info, t.image); return; }
      if (++tries > 150) return;            // 最多等 12 秒，防止无限轮询
      setTimeout(check, 80);
    };
    setTimeout(check, 0);
  }
  return texCache[key];
}
// Unity MetallicSmoothness (R=metallic, A=smoothness) -> three metalnessMap(B)/roughnessMap(G)
const msCache = {};
function packMetalRough(file, onReady) {
  if (SKIP_PBR_EXTRA) return;          // 移动端已砍掉金属/粗糙通道，不必再打包
  const url = './textures/' + encodeURIComponent(texFile(file));
  if (msCache[url]) return onReady(msCache[url]);
  enqueueImage(url,
    (img) => {
      // [MC-SET] 先按上限降采样：像素循环量 ∝ 边长²
      const src = fitImage(img);
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const metal = px[i], smooth = px[i + 3];
        px[i + 1] = 255 - smooth;   // G = roughness
        px[i + 2] = metal;          // B = metalness
        px[i] = 0; px[i + 3] = 255;
      }
      // 直接用像素缓冲做 DataTexture：少一份 canvas 常驻（每张省 4~16MB）
      const t = new THREE.DataTexture(px, c.width, c.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.LinearSRGBColorSpace;
      t.anisotropy = MAXANISO;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      msCache[url] = t;
      const msInfo = registerSource(t, url, false);
      onSourceLoaded(msInfo, { width: c.width, height: c.height });
      onReady(t);
      c.width = c.height = 1;    // 立刻回收 canvas
    },
    () => console.warn('MS texture missing:', url));
}

/* ---------- [a7o] Packed Relief Map：CPU 侧异步合成 --------------------------
   四个 PBR 通道在移动端原本被 SKIP_PBR_EXTRA 直接丢弃（连 CPU 副本都不读），
   于是表面只剩 albedo。这里改用 enqueueImage 只取 CPU image，压成一张
   256² RGBA8 打包图后上传 GPU：4 张原图始终不进显存，也就不占 TEX_REG /
   maybeTrimTextures 的账本。合成按「每帧最多 1 个作业」分片，绝不堆在主线程。 */
const RELIEF_IMG = new Map();          // url -> Promise<image|null>
/** baseDir 让底板 / 角色贴图（./chars/textures/）也能进同一条合成管线。 */
function reliefImage(file, baseDir) {
  if (!file) return Promise.resolve(null);
  const url = (baseDir || './textures/') + encodeURIComponent(texFile(file));
  if (RELIEF_IMG.has(url)) return RELIEF_IMG.get(url);
  const p = new Promise(res => {
    enqueueImage(url, img => res(img || null), () => res(null), false, RELIEF.maxSide);
  });
  RELIEF_IMG.set(url, p);
  return p;
}

const RELIEF_JOBS = [];
let RELIEF_JOB_ACTIVE = 0, RELIEF_TICKING = false, RELIEF_DETACH = new Map();

/** 给材质同步挂上「中性打包图」，让 shader 一次编译到位；图片到位后原地改像素。 */
function ensureRelief(name, rec, mat, baseDir) {
  if (RELIEF.off || mat.userData.mcReliefAttached) return;
  const tex = neutralReliefMap(RELIEF.maxSide);
  const detach = attachRelief(mat, tex, RELIEF.currentLevel, {});
  mat.userData.mcReliefName = name;
  mat.userData.mcReliefBase = baseDir || './textures/';
  mat.userData.mcReliefRec = rec;
  mat.userData.mcReliefRepeat = rec.texScale || [1, 1];
  RELIEF_DETACH.set(mat, detach);
  // L2 零额外采样，不挂打包图，自然也不需要合成任何像素
  if (RELIEF.currentLevel < 2) {
    RELIEF_JOBS.push({ name, rec, tex, mat, baseDir: mat.userData.mcReliefBase });
    RELIEF.queued = RELIEF_JOBS.length;
    wakeRelief();
  }
}

function pumpReliefJobs() {
  if (RELIEF_JOB_ACTIVE || !RELIEF_JOBS.length) return;
  const job = RELIEF_JOBS.shift();
  RELIEF_JOB_ACTIVE = 1;
  RELIEF.queued = RELIEF_JOBS.length;
  const bd = job.baseDir || './textures/';
  Promise.all([
    reliefImage(job.rec.tex, bd), reliefImage(job.rec.normalTex, bd),
    reliefImage(job.rec.aoTex, bd), reliefImage(job.rec.metalTex, bd),
  ]).then(([albedo, normal, ao, ms]) => {
    try {
      const ok = updateReliefMap(job.tex, {
        albedo, normal, ao, ms,
        key: 'relief:' + job.name, maxSide: RELIEF.maxSide, normalStrength: 2.2,
      });
      if (ok) RELIEF.built++; else RELIEF.failed++;
      job.mat.userData.mcReliefReady = !!ok;
    } catch (e) {
      RELIEF.failed++;
      console.warn('[relief] 合成失败(保持中性平面):', job.name, e);
    }
    RELIEF_JOB_ACTIVE = 0;
  }).catch(() => { RELIEF.failed++; RELIEF_JOB_ACTIVE = 0; });
}

/** 队列空时自动停，避免常驻 rAF；每帧最多推进一个作业。 */
function wakeRelief() {
  if (RELIEF_TICKING) return;
  RELIEF_TICKING = true;
  const tick = () => {
    pumpReliefJobs();
    if (RELIEF_JOBS.length || RELIEF_JOB_ACTIVE) requestAnimationFrame(tick);
    else RELIEF_TICKING = false;
  };
  requestAnimationFrame(tick);
}

/** 看门狗 / 手动降档：把全部已挂材质重挂到更低 level，并同步更新配置。 */
function setGlobalReliefLevel(lv, manual = false) {
  const next = Math.max(0, Math.min(2, lv | 0));
  if (next === RELIEF.currentLevel) { if (manual) RELIEF.manualUntil = performance.now() + 30000; return false; }
  RELIEF.currentLevel = next;
  /* [a7o 第三轮实测] 手动/调试设档后，软渲染低 fps 会让看门狗在下一次 5s
     检查把档位又抢回去（实测设 L0 立刻变 L1）。给 30s 冷却，用户选的画质
     在这段时间内不会被自动逻辑覆盖；冷却结束再恢复自动升降。        */
  if (manual) RELIEF.manualUntil = performance.now() + 30000;
  RELIEF.downgrades++;
  for (const [mat, detach] of RELIEF_DETACH) {
    // 必须先恢复最初的 onBeforeCompile，否则每次降档都包一层 relief 注入，
    // 同一 include 被反复追加，shader 越长越慢（链式嵌套是真 bug）。
    if (typeof detach === 'function') detach();
    const tex = neutralReliefMap(RELIEF_LEVELS[next].maxSide);
    const d = attachRelief(mat, tex, next, {});
    RELIEF_DETACH.set(mat, d);
    const nm = mat.userData.mcReliefName || 'anon';
    const bd = mat.userData.mcReliefBase || './textures/';
    const rec = mat.userData.mcReliefRec || MATS[nm] || {};
    if (next < 2) RELIEF_JOBS.push({ name: nm, rec, tex, mat, baseDir: bd });
  }
  wakeRelief();
  return true;
}
window.__mcSetReliefLevel = (lv) => setGlobalReliefLevel(lv, true);   // 手动设档：带 30s 冷却

// ---------- material factory ----------
const matCache = {};
function tiledClone(base, repeat) {
  const t = base.clone();
  t.needsUpdate = true;
  t.repeat.set(repeat[0], repeat[1]);
  return t;
}
function matFor(name) {
  if (!name || !MATS[name]) name = 'CP_Base';
  if (matCache[name]) return matCache[name];
  const i = MATS[name], m = new THREE.MeshStandardMaterial({ name });
  const rep = i.texScale || [1, 1], tiled = rep[0] !== 1 || rep[1] !== 1;
  m.color.setRGB(i.color[0], i.color[1], i.color[2], THREE.SRGBColorSpace);
  if (i.tex) m.map = tiled ? tiledClone(texture(i.tex), rep) : texture(i.tex);
  if (i.normalTex) {
    const nt = texture(i.normalTex, false);
    if (nt) {
      m.normalMap = tiled ? tiledClone(nt, rep) : nt;
      m.normalScale.setScalar(i.bumpScale ?? 1);
    }
  }
  if (i.metalTex) {
    if (SKIP_PBR_EXTRA) {
      /* [a7i 真凶] 手机端砍掉 MetallicSmoothness 通道后，packMetalRough 直接 return，
         但这里仍把 metalness 设成 1 → 纯金属、无 envMap → 完全不吃 albedo，
         地面/墙面渲染成纯黑（射线实测：贴图 1024 完好、材质 metalness=1）。
         这正是「贴图没加载出来的一团黑」：其实贴图在，只是被金属度吃掉了。
         非金属表面按 0.02 处理，让贴图正常参与漫反射。 */
      m.metalness = 0.02;
      m.roughness = THREE.MathUtils.clamp(1 - (i.smoothness ?? 0.3), 0.35, 1);
    } else if (!RELIEF.off) {
      /* [a7o 真 bug] 第二轮浏览器实测抓到：packMetalRough 是异步回调，
         在 ensureRelief 之后才把 metalnessMap/roughnessMap 挂回材质 ——
         桌面 L0 于是同时采样「打包图 + 两张独立 PBR 图」，反而更贵，
         而且 metalness=1 无 envMap 有变黑风险。MS 图改由打包图 A 通道接管。 */
      m.metalness = 0.04;
      m.roughness = THREE.MathUtils.clamp(1 - (i.smoothness ?? 0.3), 0.35, 1);
    } else {
      m.metalness = 1; m.roughness = 1;
      packMetalRough(i.metalTex, t => {
        m.metalnessMap = tiled ? tiledClone(t, rep) : t;
        m.roughnessMap = m.metalnessMap;
        m.needsUpdate = true;
      });
    }
  } else {
    m.metalness = Math.min(i.metallic ?? 0, 0.5);
    m.roughness = THREE.MathUtils.clamp(1 - (i.smoothness ?? 0.3), 0.35, 1);
  }
  if (i.aoTex) { const at = texture(i.aoTex, false); if (at) m.aoMap = at; }
  if (i.emission[0] + i.emission[1] + i.emission[2] > 0.03) {
    m.emissive.setRGB(i.emission[0], i.emission[1], i.emission[2], THREE.SRGBColorSpace);
    m.emissiveMap = i.emisTex ? texture(i.emisTex) : (m.map || null);
  }
  if (i.mode === 1) {                                   // cutout (signboards, grates)
    m.alphaTest = i.cutoff ?? 0.5;
    m.alphaToCoverage = true;
  } else if (i.mode >= 2) {                             // transparent (decals, glass)
    m.transparent = true;
    m.opacity = Math.max(i.color[3], 0.25);
    m.depthWrite = false;
    m.side = THREE.DoubleSide;
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  }
  // [a7o] 同步挂中性打包图（shader 一次编译到位），像素异步合成后原地写入。
  ensureRelief(name, i, m);
  return (matCache[name] = m);
}

// ---------- model templates from category GLBs ----------
const templates = {};          // sanitized model name -> ROOT_ node
const dracoLoader = new DRACOLoader(loadMgr).setDecoderPath('../../vendor/draco/');
const glbLoader = new GLTFLoader(loadMgr).setDRACOLoader(dracoLoader);
const glbFiles = ['Background', 'Car', 'Combined_Building', 'Decals', 'Environment',
                  'Facade_Details', 'Metro', 'Modules', 'Street'];
// [a7t] 单个 GLB 缺失不得让整个主城模块在顶层 await 处中断。
// 完整资产包未随源码分发时，其余管线（含真实城市层）必须照常启动。
await Promise.all(glbFiles.map(f => glbLoader.loadAsync('./glb/' + f + '.glb').then(gltf => {
  gltf.scene.traverse(o => {
    if (o.name.startsWith('ROOT_')) {
      const name = o.name.slice(5);
      templates[name] = o;
      o.userData.skinned = false;
      o.traverse(c => { if (c.isSkinnedMesh) o.userData.skinned = true; });
      const gs = SCALES[name];                       // per-model globalScale fix (none in this pack)
      if (gs && gs !== 1) for (const c of o.children) {
        c.scale.multiplyScalar(gs); c.position.multiplyScalar(gs);
      }
    }
  });
}).catch(err => {
  console.warn('[assets] missing ' + f + '.glb — 跳过该模板，主城继续启动',
               String(err && err.message || err).slice(0, 140));
  return null;
})));
loadMsg('binding materials…');

// ---------- bind materials to primitives ----------
// Unity submesh j renders prefab m_Materials[j], and j follows the FIRST-
// APPEARANCE order of material indices over the FBX polygons — Blender's
// FBX→glTF path emits primitives in CONNECTION order instead, so binding by
// primitive index rotated whole atlases onto the wrong surfaces (building
// facades baked onto the slums ground = the "flattened stickers" bug).
// The GLB primitives keep FBX-internal material names; fbx_mat_order.json
// (scripts/extract_fbx_mat_order.py) maps name -> Unity slot.
function assignMaterials(modelName) {
  const tpl = templates[sanitize(modelName)];
  if (!tpl || tpl.userData.matsDone) return tpl;
  tpl.userData.matsDone = true;
  const parts = {};
  const raw = partsByModel[modelName] || {};
  for (const k in raw) parts[sanitize(strip(k))] = raw[k];
  const orders = {};
  const rawOrd = FBXORD[modelName] || {};
  for (const k in rawOrd) orders[sanitize(strip(k))] = rawOrd[k];
  tpl.traverse(o => {
    if (!o.isMesh) return;
    const key = sanitize(strip(o.name));
    const parentKey = o.parent ? sanitize(strip(o.parent.name)) : '';
    const fbxName = (o.material?.name || '').replace(/\.\d+$/, '');
    const mats = parts[key] || parts[parentKey];
    if (mats?.length) {
      const order = orders[key] || orders[parentKey];
      let idx = order ? order.indexOf(fbxName) : -1;
      if (idx < 0) {
        // no slot table / unknown name — legacy sibling-order fallback
        const sibs = o.parent.children.filter(c => c.isMesh);
        idx = sibs.length > 1 ? Math.min(Math.max(sibs.indexOf(o), 0), mats.length - 1) : 0;
      }
      o.material = matFor(mats[Math.min(idx, mats.length - 1)]);
    } else if (MATS[fbxName]) {
      // renderers the prefab table doesn't cover (LOD copies, extra parts like
      // doors, car wheels): the FBX material name is a real material — use it
      o.material = matFor(fbxName);
    } else {
      o.material = matFor(null);
    }
  });
  return tpl;
}
const partsByModel = {};
for (const pn in PREFABS) {
  const p = PREFABS[pn];
  if (p.model && p.parts) partsByModel[p.model] = p.parts;
}

// ---------- bake each prefab: one merged geometry per material ----------
function normalizeGeo(g, world) {
  const out = g.clone().applyMatrix4(world);
  // [a7o] color 也保留：relief 材质开 vertexColors，缺 color 会黑屏
  for (const k of Object.keys(out.attributes))
    if (!['position', 'normal', 'uv', 'uv2', 'color'].includes(k)) out.deleteAttribute(k);
  if (!out.attributes.uv)
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  if (!out.attributes.uv2)
    out.setAttribute('uv2', new THREE.BufferAttribute(out.attributes.uv.array.slice(0), 2)); // aoMap uses uv2
  // [a7o] mergeGeometries 要求所有输入属性集合完全一致；缺 normal 会让
  // mergeGeometries 返回 null → 该材质槽位凭空消失 → buildOne 越界 → 空白块。
  if (!out.attributes.normal) out.computeVertexNormals();
  ensureColor(out);
  out.morphAttributes = {};
  return out;
}
const bakeCache = {};
/* [a7m] 烘焙几何常驻池 --------------------------------------------------
   旧实现：区块一卸载就把 prefab 的 merged 几何 dispose + 删 bakeCache，
   玩家走回去时重新 merge 全部几何（整条链路里最贵的 CPU 活），于是
   「跨格必卡顿 + 反复 GC 尖峰」。新实现：几何常驻，按 LRU + 字节预算
   在空闲时淘汰最冷的，且带 30s 冷却，杜绝刚淘汰又重烘焙。 */
let BAKE_POOL_BYTES = 0;
function bakeBytes(b) {
  // [a7o] 三级几何都常驻池里，必须一起计入字节预算，否则 LRU 会低估内存。
  const groups = b.lods ? b.lods.map(t => t.merged) : [b.merged];
  let n = 0;
  for (const merged of groups) {
    for (let i = 0; i < merged.length; i++) {
      const g = merged[i].geo;
      if (g.index) n += g.index.array.byteLength || 0;
      for (const k in g.attributes) n += g.attributes[k].array.byteLength || 0;
    }
  }
  return n;
}
// Unity LODGroups (603/609 prefabs) render ONE level; the GLBs carry all of
// them — without this filter LOD1/LOD2 draw stacked on LOD0 (coplanar
// z-fighting patches + ~168 redundant meshes). Collider hulls (16
// `*_Collider` nodes, MeshCollider-only in Unity) must not render either —
// they used to draw as gray shells over the combined buildings.
// [a7o] 捕获 LOD 级别：旧版直接丢弃 LOD1/LOD2（只留 LOD0），三级构建名存实亡。
// 现在收进独立 authored 桶，由 buildLodTiers 组装成真正的距离分级；
// 三级几何不会同时挂进场景，因此仍不会 coplanar z-fighting。
const LOD_RE = /_lod([1-9])\d*(?:[_.]|$)/i;
const COLLIDER_RE = /collider/i;
function bakePrefab(prefabName) {
  if (bakeCache[prefabName] !== undefined) return bakeCache[prefabName];
  const model = PREFABS[prefabName]?.model;
  const tpl = model && assignMaterials(model);
  if (!tpl || tpl.userData.skinned) return (bakeCache[prefabName] = null);
  tpl.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(tpl.matrixWorld).invert();
  const byMat = new Map();
  const byMatLod = [null, new Map(), new Map()];
  tpl.traverse(o => {
    if (!o.isMesh) return;
    const nm = o.name + '|' + (o.parent && o.parent.name || '');
    if (COLLIDER_RE.test(nm)) return;
    const lm = LOD_RE.exec(nm);
    const rel = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
    const tier = lm ? Math.min(2, parseInt(lm[1], 10)) : 0;
    const bucket = tier === 0 ? byMat : byMatLod[tier];
    const list = bucket.get(o.material) || bucket.set(o.material, []).get(o.material);
    list.push(normalizeGeo(o.geometry, rel));
  });
  const mergeBucket = (b) => {
    const arr = [];
    for (const [mat, geos] of b) {
      const g = geos.length === 1 ? geos[0] : BufferGeometryUtils.mergeGeometries(geos, false);
      if (g) arr.push({ geo: g, mat });
    }
    return arr;
  };
  const merged = mergeBucket(byMat);
  // GLB 自带 LOD 网格（真实资产，非程序生成）；缺哪级由 buildLodTiers 明确
  // 标记 synthesized，绝不冒充原资产。
  const authored = {
    1: byMatLod[1].size ? mergeBucket(byMatLod[1]) : null,
    2: byMatLod[2].size ? mergeBucket(byMatLod[2]) : null,
  };
  // Stacked-city surfaces: CP_City_Ground primitives hold base grounds AND
  // elevated decks/plates whose authored UVs collapse onto the photo texture's
  // highway strip — from the air they smear into blank "steel plates". Detect
  // degenerate mapping PER TRIANGLE (uv-area vs world-area density) and rebuild
  // those faces with planar UVs + tiled concrete; healthy faces (real grounds,
  // highway ribbons with lane markings) keep the authored photo mapping.
  const DECK_UV_DENSITY = 1.5e-6;   // photo tile baseline ≈ (1/200 m)² = 2.5e-5
  for (let mi = merged.length - 1; mi >= 0; mi--) {
    // huge-triangle plates exist under SEVERAL materials (City_Ground photo
    // planes AND slums-atlas-smeared deck faces) — the area rule is universal;
    // the UV-density rule stays City_Ground-only (atlas walls are legit)
    const isCG = merged[mi].mat.name === 'CP_City_Ground';
    if (merged[mi].mat === matFor('CP_Deck')) continue;
    const srcG = merged[mi].geo;
    const src = srcG.index ? srcG.toNonIndexed() : srcG;
    const p = src.attributes.position, srcUv = src.attributes.uv;
    /* [a7m] 旧版用 3 个普通数组 push 几十万次（扩容 + 装箱 + 再拷贝成
       Float32BufferAttribute）。改成一次性预分配 typed array + 游标写入：
       启动期这一段的分配次数从 O(顶点数) 降到 O(几何数)，零中间 GC。 */
    const vcount = p.count;
    const bpA = new Float32Array(vcount * 3);
    const buA = new Float32Array(vcount * 2);
    const dpA = new Float32Array(vcount * 3);
    let bpN = 0, buN = 0, dpN = 0;
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
    for (let t = 0; t < p.count; t += 3) {
      e1.set(p.getX(t + 1) - p.getX(t), p.getY(t + 1) - p.getY(t), p.getZ(t + 1) - p.getZ(t));
      e2.set(p.getX(t + 2) - p.getX(t), p.getY(t + 2) - p.getY(t), p.getZ(t + 2) - p.getZ(t));
      cr.crossVectors(e1, e2);
      const worldArea = cr.length() / 2;
      const horiz = worldArea > 0 && Math.abs(cr.y) / (worldArea * 2) > 0.75;
      const du1 = srcUv.getX(t + 1) - srcUv.getX(t), dv1 = srcUv.getY(t + 1) - srcUv.getY(t);
      const du2 = srcUv.getX(t + 2) - srcUv.getX(t), dv2 = srcUv.getY(t + 2) - srcUv.getY(t);
      const uvArea = Math.abs(du1 * dv2 - du2 * dv1) / 2;
      const density = uvArea / Math.max(worldArea, 1e-9);
      const degenerate = horiz && (worldArea > 2500 ||
                         (isCG && worldArea > 1 && density < DECK_UV_DENSITY) ||
                         (!isCG && worldArea > 4 && density < 6e-4));
      if (degenerate) {
        for (let k = 0; k < 3; k++) {
          dpA[dpN++] = p.getX(t + k); dpA[dpN++] = p.getY(t + k); dpA[dpN++] = p.getZ(t + k);
        }
      } else {
        for (let k = 0; k < 3; k++) {
          bpA[bpN++] = p.getX(t + k); bpA[bpN++] = p.getY(t + k); bpA[bpN++] = p.getZ(t + k);
          buA[buN++] = srcUv.getX(t + k); buA[buN++] = srcUv.getY(t + k);
        }
      }
    }
    if (src !== srcG) src.dispose();          // toNonIndexed 的临时几何不再滞留
    if (!dpN) continue;
    const out = [];
    if (bpN) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(bpA.subarray(0, bpN), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(buA.subarray(0, buN), 2));
      geo.setAttribute('uv2', new THREE.BufferAttribute(buA.slice(0, buN), 2));
      geo.computeVertexNormals();
      out.push({ geo, mat: merged[mi].mat });
    }
    const dgeo = new THREE.BufferGeometry();
    const duv = new Float32Array((dpN / 3) * 2);
    for (let v = 0, u = 0; v < dpN; v += 3, u += 2) {
      duv[u] = dpA[v] * 0.12; duv[u + 1] = dpA[v + 2] * 0.12;   // ~8.3 m tiles
    }
    dgeo.setAttribute('position', new THREE.BufferAttribute(dpA.subarray(0, dpN), 3));
    dgeo.setAttribute('uv', new THREE.BufferAttribute(duv, 2));
    dgeo.setAttribute('uv2', new THREE.BufferAttribute(duv.slice(), 2));
    dgeo.computeVertexNormals();
    ensureColor(dgeo);      // 地面不压 AO，只补中性 color，保证 vertexColors 安全
    out.push({ geo: dgeo, mat: matFor('CP_Deck') });
    merged.splice(mi, 1, ...out);
  }
  /* [a7o] 三级 LOD 构建：L0 = 完整几何（顶点 AO 已烘焙）；L1/L2 优先复用
     GLB 自带网格，缺失才做确定性简化并标记 synthesized。三级 merged 的
     material 槽位强制与 L0 一一对应，buildOne 的 it.mi 才不会越界。 */
  const tiers = buildLodTiers(merged, authored, { lod1Ratio: 0.55, lod2Ratio: 0.22 });
  const baked = { merged, lods: tiers.lods, lodStats: tiers.stats };
  baked.bytes = bakeBytes(baked);
  baked.lastUsed = performance.now();
  BAKE_POOL_BYTES += baked.bytes;
  return (bakeCache[prefabName] = baked);
}// ---------- build the city: one InstancedMesh per (prefab, material) ----------
const world = new THREE.Group();
scene.add(world);
// placements: drop byte-identical duplicates (author errors); same-spot rotated
// layers (the pack stacks 90°-rotated slum blocks for density) get a 3cm lift so
// their coplanar ground planes don't z-fight
const dupSeen = new Map();
const placements = [];
let fixCount = 0;
const fixSign = pl => {   // snap authored-floating billboards onto the nearest tower facade
  for (const f of SIGN_FIXES) {
    if (f.p === pl.p && Math.abs(f.ot[0] - pl.t[0]) < 0.6 &&
        Math.abs(f.ot[1] - pl.t[1]) < 0.6 && Math.abs(f.ot[2] - pl.t[2]) < 0.6) {
      fixCount++;
      return { p: pl.p, t: f.t.slice(), r: f.r.slice(), s: pl.s };
    }
  }
  return pl;
};
for (const pl of SCENE.placements) {
  const k = pl.p + '|' + pl.t.map(v => v.toFixed(2)).join(',');
  const prev = dupSeen.get(k);
  if (prev) {
    if (prev.r === pl.r.join(',') && prev.s === pl.s.join(',')) continue;   // exact dup — drop
    placements.push(fixSign({ p: pl.p, t: [pl.t[0], pl.t[1] + 0.03, pl.t[2]], r: pl.r, s: pl.s }));
  } else {
    dupSeen.set(k, { r: pl.r.join(','), s: pl.s.join(',') });
    placements.push(fixSign(pl));
  }
}
const byPrefab = new Map();
for (const pl of placements) {
  if (!byPrefab.has(pl.p)) byPrefab.set(pl.p, []);
  byPrefab.get(pl.p).push(pl);
}
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
// [a7e] 区块登记表：建场循环往里写装配计划（声明必须先于循环——模块顶层即执行）
/* [a7m] 区块网格索引 ---------------------------------------------------
   旧实现靠字符串 key 全表 Map + 每 400ms 遍历 625 块算 hypot。现在给每块
   一个整数 packed 坐标，O(1) 定位；流送器只在「玩家跨格」时算增量窗口，
   站着不动时流送器零成本。 */
const CHUNK_SIZE = 200;
const CELL_BIAS = 512, CELL_STRIDE = 1024;
const packCell = (ix, iz) => (ix + CELL_BIAS) * CELL_STRIDE + (iz + CELL_BIAS);
const cellOf = (x, z) => packCell(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
const CHUNK_CELLS = new Map();       // packed -> rec
const CHUNK_RESIDENT = new Set();    // 当前在场（builtCount>0）的 rec
const RAY_CELLS = new Map();         // packed -> Set<InstancedMesh> 地面射线索引
const RAY_GLOBAL = new Set();            // 包围球跨 >3 格的网格（避免注册成百上千个格）
const _rayCandsA = new Set(), _rayCandsB = new Set();   // 查询复用，零每帧分配
const STATS = { loaded: 0, partial: 0, building: 0, failed: 0 };
const PREFAB_LIVE = new Map();       // prefab -> 在装配的实例项数
const CHUNKS = new Map();            // key -> rec（调试钩子只读检视）
function chunkRec(key) {
  let c = CHUNKS.get(key);
  if (!c) {
    const sp = key.split(',');
    const ix = +sp[0], iz = +sp[1];
    c = {
      key, ix, iz, packed: packCell(ix, iz),
      cx: (ix + 0.5) * CHUNK_SIZE, cz: (iz + 0.5) * CHUNK_SIZE,
      items: [], built: [], state: 'empty',
      unloadableTotal: 0, unloadableLeft: 0,
      builtCount: 0, permCount: 0, cursor: 0,
      failedIdx: [], failAt: 0, failCount: 0, retryAt: 0,
      d2: Infinity, prio: Infinity, lastUsed: 0,
    };
    CHUNKS.set(key, c);
    CHUNK_CELLS.set(c.packed, c);
  }
  return c;
}
function setState(rec, s) {
  if (rec.state === s) return;
  if (STATS[rec.state] !== undefined) STATS[rec.state]--;
  if (STATS[s] !== undefined) STATS[s]++;
  rec.state = s;
}
let skipped = 0;
const cloudPlacements = [];
const _chunkSizeV = new THREE.Vector3();
for (const [prefabName, list] of byPrefab) {
  const baked = bakePrefab(prefabName);
  if (!baked) {                                // pure-FX prefab
    skipped += list.length;
    if (prefabName.startsWith('CP_Cloud')) cloudPlacements.push(...list);
    continue;
  }
  // 镜像实例需要 DoubleSide：单次遍历分成两个数组，不再 filter 两遍
  const pos = [], neg = [];
  for (let i = 0; i < list.length; i++) {
    const pl = list[i];
    (pl.s[0] * pl.s[1] * pl.s[2] < 0 ? neg : pos).push(pl);
  }
  for (let mi = 0; mi < baked.merged.length; mi++) {
    const { geo, mat } = baked.merged[mi];
    if (!geo.boundingBox) geo.computeBoundingBox();
    const _gb = geo.boundingBox;
    _gb.getSize(_chunkSizeV);
    const clutter = Math.max(_chunkSizeV.x, _chunkSizeV.y, _chunkSizeV.z) < 4.5;
    const flatGround = _chunkSizeV.y < 1.6 && Math.max(_chunkSizeV.x, _chunkSizeV.z) > 30;
    const cullR = flatGround ? 4000 : (clutter ? (IS_MOBILE ? 150 : 220) : (IS_MOBILE ? 620 : 1600));
    const triPer = (geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3);
    for (let gi = 0; gi < 2; gi++) {
      const group = gi === 0 ? pos : neg;
      if (!group.length) continue;
      const buckets = new Map();
      for (let i = 0; i < group.length; i++) {
        const pl = group[i];
        const k = Math.floor(pl.t[0] / 200) + ',' + Math.floor(pl.t[2] / 200);
        let arr = buckets.get(k); if (!arr) buckets.set(k, arr = []);
        arr.push(pl);
      }
      for (const [k, arr] of buckets) {
        const rec = chunkRec(k);
        const perm = cullR >= 4000;          // 地面件永不卸载（防踏空）
        rec.items.push({ prefab: prefabName, mi, flip: gi === 1, cullR, triPer, list: arr, perm });
        if (!perm) rec.unloadableTotal += arr.length;
        else rec.permCount++;
      }
    }
  }
}
console.log(`city chunk plan: ${CHUNKS.size} chunks from ${placements.length}/${SCENE.placements.length} placements ` +
            `(${SCENE.placements.length - placements.length} duplicates dropped, ${skipped} FX-only skipped, ` +
            `${fixCount}/${SIGN_FIXES.length} sign fixes applied)`);

// ============================================================
// [a7m] 区块装配 / 卸载 v2
// ------------------------------------------------------------
// 旧实现的四个硬伤，全部重做：
//  1. assembleChunk 一次把整块所有 InstancedMesh 建完 → 跨格单帧尖峰；
//     现在按「每帧毫秒预算」把一块拆到多帧推进（cursor 续建）。
//  2. 卸载即 dispose 模板几何 → 走回去必重烘焙（最贵的 CPU 活）；
//     现在几何常驻池 + LRU 字节预算，零重烘焙。
//  3. registerObjDist 两次遍历实例 + getMatrixAt 逐次 Matrix4 拷贝；
//     现在直接读 instanceMatrix.array，两遍变两遍但零对象分配且无拷贝。
//  4. unregisterTexUsers 每次卸载全表 filter（O(TEX_REG×槽位)）；
//     现在反向索引 + swap-remove，O(该网格槽位数)。
// 另加：地面射线按 200m 格建索引，groundRayHit 从「遍历上千网格」
//       变成「只查脚下那一格」。
// 状态：empty → building（分帧中）→ loaded / failed（模板缺失）
//       卸载后只剩永久地面件 → partial
// ============================================================
const BAKE_POOL_BUDGET = (IS_MOBILE ? 48 : 192) * 1048576;
let LAST_POOL_TRIM = 0;
function prefabTouch(name, n = 1) {
  PREFAB_LIVE.set(name, (PREFAB_LIVE.get(name) || 0) + n);
  const b = bakeCache[name];
  if (b) {
    b.lastUsed = performance.now();
    if (b.bytes === undefined) { b.bytes = bakeBytes(b); BAKE_POOL_BYTES += b.bytes; }
  }
}
function prefabRelease(name, n = 1) {
  const left = (PREFAB_LIVE.get(name) || 0) - n;
  if (left > 0) { PREFAB_LIVE.set(name, left); return; }
  PREFAB_LIVE.delete(name);
  const b = bakeCache[name];
  if (b) b.lastUsed = performance.now();      // 变冷，等待空闲淘汰
}
/** 只在真正超出字节预算时淘汰最冷模板；30s 冷却避免刚淘汰又重烘焙。 */
function prefabTrimPool(now) {
  if (now - LAST_POOL_TRIM < 10000 || BAKE_POOL_BYTES <= BAKE_POOL_BUDGET) return;
  LAST_POOL_TRIM = now;
  const cold = [];
  for (const name in bakeCache) {
    if (PREFAB_LIVE.has(name)) continue;
    const b = bakeCache[name];
    if (!b || !b.merged) { delete bakeCache[name]; continue; }   // 模板缺失占位（bakePrefab 记的 null）
    if (now - (b.lastUsed || 0) < 30000) continue;
    cold.push([name, b]);
  }
  cold.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  for (let i = 0; i < cold.length && BAKE_POOL_BYTES > BAKE_POOL_BUDGET * 0.8; i++) {
    const [name, b] = cold[i];
    for (const m of b.merged) m.geo.dispose();
    BAKE_POOL_BYTES -= b.bytes || 0;
    delete bakeCache[name];
    window.__mcGeoDisposed = (window.__mcGeoDisposed || 0) + 1;
  }
}
/** 单遍（两轮线性扫描但零分配）算实例分布包围球，并挂进射线格索引。 */
function registerObjDist(im) {
  const n = im.count;
  if (!n) return;
  const e = im.instanceMatrix.array;        // Float32Array，平移在 [12]/[14]
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0, o = 12; i < n; i++, o += 16) {
    const x = e[o], z = e[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  let far2 = 0;
  for (let i = 0, o = 12; i < n; i++, o += 16) {
    const dx = e[o] - cx, dz = e[o + 2] - cz, d2 = dx * dx + dz * dz;
    if (d2 > far2) far2 = d2;
  }
  if (!im.geometry.boundingSphere) im.geometry.computeBoundingSphere();
  const od = { cx, cz, r: Math.sqrt(far2) + im.geometry.boundingSphere.radius * 1.3 + 2 };
  OBJ_DIST.set(im, od);
  rayCellAdd(im, od);
}
function rayCellAdd(im, od) {
  const span = Math.ceil((od.r + 3) / CHUNK_SIZE) + 1;
  /* [a7m] 包围球跨 >3 格的网格（云、超大地面片、跨 4km 的测试合成块）
     逐格注册会变成 (2span+1)² 个格 × 上千网格，装配直接被拖垮。
     放进全局集合，查询时无条件加入候选，注册代价恒为 O(1)。 */
  if (span > 3) {
    RAY_GLOBAL.add(im);
    im.userData.__rayCells = null;
    im.userData.__rayGlobal = true;
    return;
  }
  const cix = Math.floor(od.cx / CHUNK_SIZE), ciz = Math.floor(od.cz / CHUNK_SIZE);
  const cells = [];
  for (let a = -span; a <= span; a++) for (let b = -span; b <= span; b++) {
    const p = packCell(cix + a, ciz + b);
    let s = RAY_CELLS.get(p);
    if (!s) RAY_CELLS.set(p, s = new Set());
    s.add(im); cells.push(p);
  }
  im.userData.__rayCells = cells;
}
function rayCellRemove(im) {
  if (im.userData.__rayGlobal) {
    RAY_GLOBAL.delete(im);
    im.userData.__rayGlobal = false;
    return;
  }
  const cells = im.userData.__rayCells;
  if (!cells) return;
  for (let i = 0; i < cells.length; i++) {
    const s = RAY_CELLS.get(cells[i]);
    if (s) { s.delete(im); if (!s.size) RAY_CELLS.delete(cells[i]); }
  }
  im.userData.__rayCells = null;
}
/** 建一个装配项。返回 false 表示模板暂不可用（记入 failedIdx 供退避重试）。 */
function buildOne(rec, i) {
  const it = rec.items[i];
  if (rec.built[i]) return true;
  const had = bakeCache[it.prefab] !== undefined;
  const baked = bakePrefab(it.prefab);
  if (!baked) return false;
  /* [a7o] 三级构建真正落地：按区块中心到相机的距离选几何。
     200 m 区块粒度 → 只在跨格装配时换级，没有每帧切换的开销；
     槽位数不一致时安全回退到 L0，绝不产生空白块。 */
  const dx = rec.cx - camera.position.x, dz = rec.cz - camera.position.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const lv = RELIEF.off ? 0 : levelForDistance(dist, LOD_RADII);
  const tier = baked.lods && baked.lods[lv];
  const useMerged = (tier && tier.merged.length === baked.merged.length)
    ? tier.merged : baked.merged;
  const mg = useMerged[it.mi];
  if (!mg) return false;
  window.__mcLodUse = window.__mcLodUse || [0, 0, 0];
  window.__mcLodUse[lv]++;
  if (!had) window.__mcRebaked = (window.__mcRebaked || 0) + 1;
  baked.lastUsed = performance.now();
  const material = it.flip ? Object.assign(mg.mat.clone(), { side: THREE.DoubleSide }) : mg.mat;
  const im = new THREE.InstancedMesh(mg.geo, material, it.list.length);
  im.userData.prefab = it.prefab;
  im.userData.cullR = it.cullR;
  im.userData.triPer = it.triPer;
  const L = it.list.length;
  for (let k = 0; k < L; k++) {
    const pl = it.list[k];
    _m.compose(convPos(pl.t), convQuat(pl.r), _s.set(pl.s[0], pl.s[1], pl.s[2]));
    im.setMatrixAt(k, _m);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  if (mg.mat.transparent) im.renderOrder = 2;
  im.castShadow = it.cullR < 4000;
  im.receiveShadow = true;
  world.add(im);
  rec.built[i] = { im, matOwn: it.flip ? material : null, item: it };
  rec.builtCount++;
  registerObjDist(im);
  registerTexUsers(im.material, im);
  prefabTouch(it.prefab);
  if (!it.perm) rec.unloadableLeft += L;
  rec.lastUsed = performance.now();
  CHUNK_RESIDENT.add(rec);
  return true;
}
function finalizeChunk(rec) {
  const n = rec.items.length;
  const done = rec.cursor >= n;
  const fails = rec.failedIdx.length;
  if (done && fails === 0 && rec.builtCount === n) {
    setState(rec, 'loaded'); rec.failAt = 0; rec.failCount = 0; rec.retryAt = 0;
  } else if (done && fails > 0) {
    /* 模板不可用绝不标 loaded：否则 tick 两个分支都不命中 → 永久空白块 */
    setState(rec, 'failed');
    rec.failCount++;
    rec.failAt = performance.now();
    rec.retryAt = performance.now() + Math.min(20000, 1000 * (1 << Math.min(5, rec.failCount)));
  } else {
    setState(rec, 'building'); rec.failAt = 0;
  }
}
/** 同步全量装配（budgetMs 不传 = 一次建完，兼容启动建场与调试钩子）；
    传毫秒数则按时间切片推进 cursor，未完成的块留到下一帧继续。 */
function assembleChunk(rec, budgetMs = Infinity) {
  if (rec.state === 'loaded') return 0;
  const t0 = performance.now();
  const n = rec.items.length;
  let builtNow = 0;
  rec.failAt = 0;
  for (let i = rec.cursor; i < n; i++) {
    if (rec.built[i]) { rec.cursor = i + 1; continue; }
    if (buildOne(rec, i)) builtNow++;
    else rec.failedIdx.push(i);
    rec.cursor = i + 1;
    if (performance.now() - t0 >= budgetMs) break;
  }
  finalizeChunk(rec);
  return builtNow;
}
function retryFailed(rec) {
  const arr = rec.failedIdx;
  let w = 0;
  for (let j = 0; j < arr.length; j++) {
    const i = arr[j];
    if (rec.built[i]) continue;
    if (buildOne(rec, i)) continue;
    arr[w++] = i;
  }
  arr.length = w;
  rec.cursor = rec.items.length;
  finalizeChunk(rec);
}
function dismantleChunk(rec) {
  if (rec.state === 'empty' || rec.builtCount === 0) return;
  const released = new Map();
  let removed = 0;
  for (let i = 0; i < rec.built.length; i++) {
    const b = rec.built[i];
    if (!b || b.item.perm) continue;        // 地面件永不卸载
    world.remove(b.im);
    rayCellRemove(b.im);
    b.im.dispose();                         // L1：实例矩阵 GPU 缓冲（不碰共享几何）
    if (b.matOwn) b.matOwn.dispose();
    unregisterTexUsers(b.im);
    OBJ_DIST.delete(b.im);
    released.set(b.item.prefab, (released.get(b.item.prefab) || 0) + 1);
    rec.unloadableLeft -= b.item.list.length;
    rec.built[i] = null;
    removed++; rec.builtCount--;
  }
  if (removed) {
    for (const [name, n] of released) prefabRelease(name, n);
    rec.cursor = 0;                         // 重装配时跳过仍在场的永久项
    rec.failedIdx.length = 0;
    setState(rec, rec.builtCount > 0 ? 'partial' : 'empty');
    rec.failAt = 0; rec.retryAt = 0;
    if (rec.builtCount === 0) CHUNK_RESIDENT.delete(rec);
  }
}

// ---------- 区块流送器（Minecraft 同款：排队渐进 + 滞回双半径） ----------
const CHUNK_STREAM = (() => {
  /* 装配/卸载半径（沿用分档），窗口用整数格偏移表预生成，按距离平方排序。 */
  const TIER_R = { full: [1800, 2100], lite: [760, 920], min: [480, 600],
                   mobile: [1050, 1250], mobileLow: [560, 680] };
  const [R_LOAD, R_UNLOAD] = TIER_R[PERF.tier] || TIER_R.lite;
  const R_LOAD2 = R_LOAD * R_LOAD, R_UNLOAD2 = R_UNLOAD * R_UNLOAD;
  const LR = Math.ceil(R_LOAD / CHUNK_SIZE) + 1;
  const KR = Math.ceil(R_UNLOAD / CHUNK_SIZE) + 1;
  const LOAD_OFF = [], KEEP_OFF = [];
  for (let a = -LR; a <= LR; a++) for (let b = -LR; b <= LR; b++)
    if (a * a + b * b <= LR * LR) LOAD_OFF.push([a, b, a * a + b * b]);
  LOAD_OFF.sort((p, q) => p[2] - q[2]);
  for (let a = -KR; a <= KR; a++) for (let b = -KR; b <= KR; b++)
    if (a * a + b * b <= KR * KR) KEEP_OFF.push([a, b]);

  const _fwd = new THREE.Vector3();
  let last = 0, lastCenter = -1, lastPx = 0, lastPz = 0, lastRetry = 0;
  let overlay = null, overlayOn = false, lastStats = '';
  let wantLoad = new Set(), wantKeep = new Set();
  let loadQ = [], unloadQ = [];
  const FAILED = new Set();
  let windowDirty = true, lastBudget = 0;
  const stats = { enter: 0, exit: 0, assembled: 0, dismantled: 0, spentMs: 0, windows: 0 };

  function refreshOverlay() {
    if (!overlay || !overlayOn) return;
    const posL = [], posE = [], posP = [], posT = [];
    const y = 1.4, H = CHUNK_SIZE / 2;
    for (const rec of CHUNKS.values()) {
      const arr = rec.unloadableTotal === 0 ? posP
                : rec.state === 'loaded' ? posL
                : rec.state === 'partial' ? posT : posE;
      const x0 = rec.cx - H, x1 = rec.cx + H, z0 = rec.cz - H, z1 = rec.cz + H;
      arr.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1,
               x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
    }
    const parts = [['gL', posL], ['gE', posE], ['gP', posP], ['gT', posT]];
    for (const [k, arr] of parts) {
      const g = overlay.userData[k].geometry;
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeBoundingSphere();
    }
  }
  function toggle(force) {
    overlayOn = force !== undefined ? !!force : !overlayOn;
    if (overlayOn && !overlay) {
      const mk = c => new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthTest: false, fog: false }));
      overlay = new THREE.Group();
      const gL = mk(0x39ff6e), gE = mk(0xff5533), gP = mk(0x4499ff), gT = mk(0xffd23e);
      overlay.add(gL, gE, gP, gT);
      overlay.userData = { gL, gE, gP, gT };
      for (const s of [gL, gE, gP, gT]) s.renderOrder = 999;
      scene.add(overlay);
    }
    if (overlay) overlay.visible = overlayOn;
    if (overlayOn) refreshOverlay();
    showMsg(`区块边框：${overlayOn ? '开（绿=全量 黄=仅地面 红=空 蓝=纯地面块）' : '关'}`, 1.6);
    return overlayOn;
  }
  /** 只在玩家跨格（或强制）时重算窗口：enter → 加载队列，exit → 卸载队列。
      优先级 = 距离² − 视锥前方加成 − 移动方向加成（预测性预取）。 */
  function recomputeWindows(cix, ciz, px, pz, now, menuMode) {
    camera.getWorldDirection(_fwd);
    let fx = _fwd.x, fz = _fwd.z;
    const fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
    let vx = 0, vz = 0;
    const c = window.__ctrl;
    if (c && c.vel) { vx = c.vel.x || 0; vz = c.vel.z || 0; }
    else { vx = px - lastPx; vz = pz - lastPz; }
    const vl = Math.sqrt(vx * vx + vz * vz);
    if (vl > 0.001) { vx /= vl; vz /= vl; } else { vx = vz = 0; }
    lastPx = px; lastPz = pz;

    const nk = new Set(), nl = new Set();
    for (let i = 0; i < KEEP_OFF.length; i++) {
      const rec = CHUNK_CELLS.get(packCell(cix + KEEP_OFF[i][0], ciz + KEEP_OFF[i][1]));
      if (rec) nk.add(rec);
    }
    for (let i = 0; i < LOAD_OFF.length; i++) {
      const rec = CHUNK_CELLS.get(packCell(cix + LOAD_OFF[i][0], ciz + LOAD_OFF[i][1]));
      if (!rec) continue;
      const dx = rec.cx - px, dz = rec.cz - pz, d2 = dx * dx + dz * dz;
      if (d2 > R_LOAD2) continue;
      nl.add(rec);
      const ahead = Math.max(0, dx * fx + dz * fz);
      const move = Math.max(0, dx * vx + dz * vz);
      rec.prio = d2 - ahead * 400 - move * 250 - (rec.state === 'building' ? 1e12 : 0);
    }
    // 退出保留窗口 → 卸载（滞回：仍在 [R_LOAD, R_UNLOAD] 环带内的块不动）
    const ex = [];
    if (!menuMode) {
      for (const rec of CHUNK_RESIDENT) {
        if (nk.has(rec)) continue;
        const dx = rec.cx - px, dz = rec.cz - pz;
        rec.d2 = dx * dx + dz * dz;
        if (rec.d2 > R_UNLOAD2) ex.push(rec);
      }
      ex.sort((p, q) => q.d2 - p.d2);
    }
    unloadQ = ex;
    loadQ.length = 0;
    for (const rec of nl) {
      if (rec.state === 'loaded') continue;
      if (rec.state === 'failed' && !(now > rec.retryAt)) continue;
      loadQ.push(rec);
    }
    loadQ.sort((p, q) => p.prio - q.prio);
    wantLoad = nl; wantKeep = nk;
    stats.windows++;
    stats.enter = loadQ.length;
    stats.exit = ex.length;
  }

  function tick(force) {
    if (window.__mcChunkFreeze) return;
    const now = performance.now();
    if (!force && now - last < 100) return;     // 100ms 节流（原 400ms，跨格立即触发）
    last = now;
    if (phase === 'pause') return;
    const menuMode = phase === 'menu';
    const o = residentOrigin();
    const px = o.x, pz = o.z;
    const cix = Math.floor(px / CHUNK_SIZE), ciz = Math.floor(pz / CHUNK_SIZE);
    const center = packCell(cix, ciz);
    if (center !== lastCenter || force || windowDirty) {
      recomputeWindows(cix, ciz, px, pz, now, menuMode);
      lastCenter = center; windowDirty = false;
    }
    // 模板缺失的块指数退避重试（只扫很小的 FAILED 集合，不再全表扫描）
    if (now - lastRetry > 1000) {
      lastRetry = now;
      for (const rec of FAILED) {
        if (now <= rec.retryAt) continue;
        retryFailed(rec);
        if (rec.state !== 'failed') FAILED.delete(rec);
      }
      for (const rec of CHUNK_RESIDENT) if (rec.state === 'failed') FAILED.add(rec);
    }
    prefabTrimPool(now);
    /* 时间切片预算：跟着实测 JS 帧耗时自适应，忙时少建、闲时多建。
       一块没建完就留在队头，下一 tick 从 cursor 继续，绝不单帧尖峰。 */
    const budget = Math.max(1.5, Math.min(menuMode ? 10 : 6, 9 - (JS_MS || 2)));
    lastBudget = budget;
    let spent = 0;
    stats.assembled = 0;
    while (loadQ.length && spent < budget) {
      const rec = loadQ[0];
      const t0 = performance.now();
      const made = assembleChunk(rec, budget - spent);
      spent += performance.now() - t0;
      stats.assembled += made;
      if (rec.state === 'loaded' || rec.state === 'failed') loadQ.shift();
      else break;                              // building：下轮继续
    }
    let n = 0;
    stats.dismantled = 0;
    while (unloadQ.length && n < 8) { dismantleChunk(unloadQ.shift()); n++; stats.dismantled++; }
    stats.spentMs = +spent.toFixed(2);

    const loaded = STATS.loaded;
    const partial = STATS.partial + STATS.building + STATS.failed;
    const st = `${loaded + partial}/${CHUNKS.size}`;
    if (st !== lastStats) {
      lastStats = st;
      window.__mcChunkInfo = { loaded: loaded + partial, full: loaded, partial,
        total: CHUNKS.size, loadR: R_LOAD, unloadR: R_UNLOAD,
        geoDisposed: window.__mcGeoDisposed || 0, rebaked: window.__mcRebaked || 0 };
      console.log(`[chunks v2] 在场 ${st}（全量 ${loaded}）装配 ${R_LOAD}m / 卸载 ${R_UNLOAD}m` +
        ` 窗口 ${wantLoad.size}/${wantKeep.size} 池 ${(BAKE_POOL_BYTES / 1048576).toFixed(1)}MB` +
        ` 重烘焙 ${window.__mcRebaked || 0}`);
    }
    if (overlayOn && (stats.assembled || stats.dismantled)) refreshOverlay();
    window.__mcTickDebug = { px: Math.round(px), pz: Math.round(pz), phase,
      cands: loadQ.length, assembled: stats.assembled, dismantled: stats.dismantled,
      window: { load: wantLoad.size, keep: wantKeep.size, enter: stats.enter, exit: stats.exit,
                windows: stats.windows }, budgetMs: +budget.toFixed(2), spentMs: stats.spentMs,
      queue: loadQ.length, unloadQueue: unloadQ.length, resident: CHUNK_RESIDENT.size };
  }
  window.__mcStreamDebug = () => ({
    loadR: R_LOAD, unloadR: R_UNLOAD,
    offsets: { load: LOAD_OFF.length, keep: KEEP_OFF.length },
    windows: { load: wantLoad.size, keep: wantKeep.size, recomputes: stats.windows },
    queue: loadQ.length, unloadQueue: unloadQ.length,
    resident: CHUNK_RESIDENT.size, failed: FAILED.size, stats: { ...stats },
    pool: { bytes: BAKE_POOL_BYTES, budget: BAKE_POOL_BUDGET,
            entries: Object.keys(bakeCache).length,
            geoDisposed: window.__mcGeoDisposed || 0, rebaked: window.__mcRebaked || 0 },
    budgetMs: lastBudget, center: lastCenter,
  });
  return { tick: () => tick(false), step: () => tick(true), toggle, radii: () => [R_LOAD, R_UNLOAD] };
})();
window.__mcAssembleBudget = (key, ms) => {
  const rec = CHUNKS.get(key);
  return rec ? assembleChunk(rec, ms) : -1;
};
window.__mcChunkToggle = f => CHUNK_STREAM.toggle(f);
window.__mcChunkStep = () => CHUNK_STREAM.step();   // 测试/调试钩子：无视节流立刻跑一轮
window.__mcChunksMap = CHUNKS;                      // 调试：区块登记表只读检视
window.__mcSrcInfo = (list) => list ? [...SRC_INFO.values()].map(v => v.url) : SRC_INFO.size;
window.__mcMemDebug = () => {
  let built = 0, items = 0, texUsers = 0;
  for (const rec of CHUNKS.values()) { built += rec.built.filter(Boolean).length; items += rec.items.length; }
  for (const e of TEX_REG.values()) texUsers += e.users.length;
  return { bake: Object.keys(bakeCache).length, live: PREFAB_LIVE.size,
           built, items, objDist: OBJ_DIST.size, texUsers,
           srcInfo: SRC_INFO.size, texReg: TEX_REG.size };
};
// [a7i 诊断] 强制重新下载并重传一张贴图（验证「空纹理」是否可救）
window.__mcRefetchTex = async (part) => {
  for (const [id, e] of TEX_REG) {
    const info = e.info;
    if (!info || !(info.url || '').includes(part)) continue;
    const want = info.side || TEX_NEAR_SIDE() || 1024;
    const blob = await fetch(info.url, { cache: 'force-cache' }).then(r => r.blob());
    const bmp = await createImageBitmap(blob);
    const fitted = fitImage(bmp, want);
    const texs = new Set(e.users.map(u => u.tex));
    if (info.tex) texs.add(info.tex);
    for (const t of texs) {
      t.image = fitted; t.dispose(); t.needsUpdate = true;
    }
    info.bytes = texBytesOf(fitted.width || 1, fitted.height || 1);
    info.side = Math.max(fitted.width || 1, fitted.height || 1);
    info.resident = true; info.imgReleased = false;
    return { url: info.url, side: info.side, texs: texs.size };
  }
  return 'not found: ' + part;
};
// [a7i 诊断] 命中物体的材质实况：map 在不在、image 多大、GPU 纹理有没有
window.__mcMatInfo = (nx = 0, ny = 0) => {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
  rc.far = 600;
  const hits = rc.intersectObjects(scene.children, true).slice(0, 3);
  return hits.map(h => {
    const o = h.object;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const t = m && m.map;
    const si = t && t.source ? SRC_INFO.get(t.source.uuid) : null;
    const props = t ? renderer.properties?.get?.(t) : null;
    return {
      prefab: o.userData.prefab, mat: m && m.name,
      color: m && m.color ? '#' + m.color.getHexString() : null,
      mapName: t && t.name, img: t && t.image ? `${t.image.width || t.image.naturalWidth}x${t.image.height || t.image.naturalHeight}` : 'NULL',
      srcData: t && t.source ? (t.source.data ? 'img' : 'null') : 'nosrc',
      gpu: !!props?.__webglTexture, side: si ? (si.resident ? si.side : 0) : -1,
      metal: m && m.metalness, rough: m && m.roughness, emissive: m && m.emissive ? '#' + m.emissive.getHexString() : null,
      url: si ? (si.url || '').split('/').pop() : '', d: +h.distance.toFixed(1),
    };
  });
};
// [a7i 诊断] 屏幕坐标射线：确认「一团黑」到底打在什么物体上（地面缺失？深色材质？）
window.__mcRayHit = (nx = 0, ny = 0) => {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
  rc.far = 600;
  const hits = rc.intersectObjects(scene.children, true).slice(0, 4);
  return hits.map(h => ({
    name: h.object.name, prefab: h.object.userData.prefab,
    mat: (Array.isArray(h.object.material) ? h.object.material[0] : h.object.material)?.name,
    d: +h.distance.toFixed(1), y: +h.point.y.toFixed(2),
  }));
};
// [a7i 诊断] 列出相机附近 InstancedMesh 的贴图实况（定位「灰块」到底是哪张图/多少像素）
window.__mcSceneDump = (n = 30, maxD = 400) => {
  const out = [];
  const c = window.__camera ? window.__camera.position : { x: 0, y: 0, z: 0 };
  scene.traverse(o => {
    if (!o.isInstancedMesh || !o.visible) return;
    const bs = o.boundingSphere || o.geometry.boundingSphere;
    const dx = (bs ? bs.center.x : o.position.x) - c.x;
    const dz = (bs ? bs.center.z : o.position.z) - c.z;
    const d = Math.hypot(dx, dz);
    if (d > maxD) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const texs = [];
    for (const m of mats) {
      if (!m) continue;
      for (const k of RESIDENCY_SLOTS) {
        const t = m[k];
        if (!t || !t.source) continue;
        const si = SRC_INFO.get(t.source.uuid);
        texs.push({ slot: k, side: si ? (si.resident ? si.side : 0) : -1,
                    url: ((si && si.url) || '').split('/').pop().slice(-28) });
      }
    }
    out.push({ prefab: o.userData.prefab || '?', mat: mats[0] && mats[0].name, d: Math.round(d), texs });
  });
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, n);
};
window.__mcTexStat = () => {
  const hist = {}, byUrl = [];
  for (const info of SRC_INFO.values()) {
    const s = info.resident ? (info.side || 0) : 0;
    const k = s >= 2048 ? '2048' : s >= 1024 ? '1024' : s >= 640 ? '640'
            : s >= 512 ? '512' : s >= 256 ? '256' : s > 0 ? '<256' : (info.failed ? 'failed' : 'evicted/64');
    hist[k] = (hist[k] || 0) + 1;
    if (s < 512) byUrl.push({ s, u: (info.url || '').split('/').pop().slice(0, 32), r: info.resident });
  }
  return { hist, low: byUrl.slice(0, 40), residentMB: Math.round(RESIDENT_BYTES / 1048576),
           budgetMB: Math.round(VRAM_BUDGET_MB) || 0, texMax: TEX_MAX, texSafe: TEX_SAFE_MAX,
           dpr: +renderer.getPixelRatio().toFixed(2), tier: PERF.tier,
           near: [...TEX_REG.values()].filter(e => e.minD < 240).length };
};

// ---------- city ground plane: REMOVED (see bundle/main.js) ----------

// ---------- scene-native meshes (neon strips: builtin Cube/Plane/Cylinder) ----------
for (const e of SCENE.meshes || []) {
  let geo = null;
  if (e.builtin === 'Cube') geo = new THREE.BoxGeometry(1, 1, 1);
  else if (e.builtin === 'Plane') geo = new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2);
  else if (e.builtin === 'Cylinder') geo = new THREE.CylinderGeometry(0.5, 0.5, 2, 24);
  else continue;
  ensureColor(geo);
  const mat = matFor(e.mats?.[0]);
  const mesh = new THREE.Mesh(geo, mat);
  _m.compose(convPos(e.t), convQuat(e.r), _s.set(e.s[0], e.s[1], e.s[2]));
  mesh.applyMatrix4(_m);
  world.add(mesh);
}

// ---------- sky clouds (particle billboards -> camera-facing, low opacity) ----------
// plain textured planes at 450–960 m read as floating concrete slabs from the
// air; billboards with soft blending stay wispy from every angle
for (const pl of cloudPlacements) {
  const texFile = pl.p + '.png';
  const mat = new THREE.MeshBasicMaterial({
    map: texture(texFile), transparent: true, depthWrite: false,
    opacity: 0.45, side: THREE.DoubleSide, fog: true, color: 0x9aa0a8,
  });
  const sc = Math.min(pl.s[0], 20);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(30 * sc / pl.s[0], 15 * sc / pl.s[0]), mat);
  _m.compose(convPos(pl.t), convQuat(pl.r), _s.set(pl.s[0], pl.s[1], pl.s[2]));
  mesh.applyMatrix4(_m);
  mesh.renderOrder = 1;
  world.add(mesh);
  cloudMeshes.push(mesh);
}

// ---------- street-level paving over authored voids: REMOVED by user decision ----------
// The paving grid (29.6k sidewalk quads at y=-0.02) z-fought with 128 authored
// road/sidewalk pieces sharing those cells (8 cm apart) and read as a giant
// forcibly-added dark lot. Falls into genuine holes are handled by the
// lastSafe rescue instead.

// ---------- landmarks (computed from placement data) ----------
function centroid(pred) {
  const ps = SCENE.placements.filter(pl => pred(pl.p));
  if (!ps.length) return null;
  const c = new THREE.Vector3();
  for (const pl of ps) c.add(convPos(pl.t));
  return c.multiplyScalar(1 / ps.length);
}
const bounds = new THREE.Box3();
for (const pl of SCENE.placements) bounds.expandByPoint(convPos(pl.t));
const center = bounds.getCenter(new THREE.Vector3());

// invisible physics floor over authored voids; the visual slab sits 1 cm under
const SAFETY_FLOOR_Y = -1.24;
// [2026-11-26 迈阿密高楼区落地] 全量数据 cm级坐标已转米。给高楼区街面一个兜底，
// 避免区块尚未流送到位时脚下无几何→下坠→被救援拉回原点村落。
const URBAN_BOUNDS = { x0: -57000, x1: 20000, z0: -5000, z1: 79000 };

// the pack's scene-native photo-carpet planes ("city from above" mattes) —
// giant flat plain Meshes rendered above the slab. groundAt stands the player
// on them; gen_belt.py keeps props off them.
const matteRects = [];
{
  const _bb = new THREE.Box3();
  for (const c of world.children) {
    if (c.isInstancedMesh || !c.isMesh || !c.geometry) continue;
    if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
    _bb.copy(c.geometry.boundingBox).applyMatrix4(c.matrix);   // world group is at origin
    if (_bb.max.x - _bb.min.x < 100 || _bb.max.z - _bb.min.z < 100) continue;
    if (_bb.max.y <= SAFETY_FLOOR_Y) continue;           // below the slab: irrelevant
    if (_bb.max.y > 5) continue;             // high sheet (pre-billboard cloud), not ground
    if (_bb.max.y - _bb.min.y > 4) continue;             // not a flat carpet
    matteRects.push({ x0: _bb.min.x, z0: _bb.min.z, x1: _bb.max.x, z1: _bb.max.z,
                      y: _bb.max.y + 0.02 });
  }
  if (matteRects.length) console.log(`photo mattes: ${matteRects.length}`);
}

// ---------- ground slab: the pack only paves the authored corridor + district
// tiles; everywhere else the demo scene has NOTHING below street level (the
// Unity demo camera never leaves the corridor). A city-wide asphalt slab turns
// those authored voids into plain empty lots — no more sky-under-your-feet —
// and gives the invisible safety floor a visible surface. Kept OUT of `world`
// so it never enters collision raycasts or city boxes.
{
  const pad = 80;
  const x0 = bounds.min.x - pad, x1 = bounds.max.x + pad;
  const z0 = bounds.min.z - pad, z1 = bounds.max.z + pad;
  const shape = new THREE.Shape([
    new THREE.Vector2(x0, z0), new THREE.Vector2(x1, z0),
    new THREE.Vector2(x1, z1), new THREE.Vector2(x0, z1),
  ]);
  // probed open-air sub-street areas (metro trench, stairwell) stay open
  for (const [hx0, hz0, hx1, hz1] of [[-20, 20, 20, 92], [112, 88, 132, 108]]) {
    shape.holes.push(new THREE.Path([
      new THREE.Vector2(hx0, hz0), new THREE.Vector2(hx1, hz0),
      new THREE.Vector2(hx1, hz1), new THREE.Vector2(hx0, hz1),
    ]));
  }
  // full asphalt PBR (albedo+normal+MS), identical to the streets' material,
  // so the filler ground is indistinguishable from authored pavement.
  // ShapeGeometry UVs are raw meters — tile every 9 m like the road meshes.
  const rep = 1 / 9;
  // [2026-11-17a4] 底板不再挂贴图：它是一块 2.7km × 3.1km 的兜底地面，
  // 之前用 `texture(...).clone()` 共享贴图源，源数据一旦被释放/未上传，
  // 整块地面就是纯黑（手机实拍的「脚下全黑」）。纯色材质没有这个风险，
  // 也不会因为 onBeforeCompile 换掉着色器而在移动端编译失败。
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.94,
    side: THREE.DoubleSide });
  /* [2026-11-17a5] 恢复沥青贴图。
     a4 的纯色方案修掉了「纯黑」，但代价是玩家脚下变成一块**没有任何纹理的大灰板**
     —— 用户说的「贴图糊成一坨」，第一眼看到的就是它。
     现在 clone 的同步上传（TEX_CLONES + bumpClones）已经修好，手机端也不再释放
     CPU 副本，共享源失效的根因不存在了，可以安全挂回。
     ShapeGeometry 的 UV 是米制 → repeat=1/9 恰好 9m 一铺，与街道材质一致。 */
  // 注意：texFile() 只剥 tga/psd/tif/png，传 'xxx.webp' 会被拼成 'xxx.webp.png' → 404
  /* [2026-11-17a6] 原来用 CP_Asphalt_A：实测这张图的请求会偶发卡死（既不成功
     也不失败），它是底板+补地唯一的贴图源 → 一旦卡住，玩家脚下一整片纯黑。
     CP_Broken_Asphalt_A 是同系列沥青（破损裂纹），实测稳定落地且是 1024²，
     纹理观感一致 —— 地面宁可带裂纹，也不能是黑板。 */
  const slabMap = texture('CP_Broken_Asphalt_A.png').clone();
  slabMap.repeat.set(rep, rep);
  slabMap.needsUpdate = true;
  if (slabMap.image) { slabMat.map = slabMap; slabMat.emissiveMap = slabMap; }
  else { slabMat.color.setHex(0x6e747c); }          // 等待灰底（沥青等待时不黑洞）
  slabMat.userData.__boost = IS_MOBILE ? 1.7 : 1;   // [F-41] 贴图到达后 wire 恢复提亮用
  applyMapWhenReady(slabMat, slabMap);
  slabMat.emissive = new THREE.Color(0xffffff);
  slabMat.emissiveIntensity = 0.08;   // 桌面兜底；手机端会被统一地面提亮覆盖为 0.34
  slabMat.userData.isGroundMat = true;
  if (IS_MOBILE) { slabMat.emissive.setScalar(0.30); slabMat.emissiveIntensity = 0.22; }  // [迈阿密] 降自发光，避免地面死白
  // macro variation: the 9 m tile repeated over ~1 km reads as one synthetic
  // sheet from eye level. Multiply albedo by 3 octaves of world-XZ value noise
  // (170/41/9.5 m) so the expanse breaks into weathered patches and stains.
  slabMat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSlabW;')
      .replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvSlabW = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSlabW;
float slabHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float slabNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(slabHash(i), slabHash(i + vec2(1.0, 0.0)), u.x),
             mix(slabHash(i + vec2(0.0, 1.0)), slabHash(i + vec2(1.0, 1.0)), u.x), u.y);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float n1 = slabNoise(vSlabW.xz / 170.0);
  float n2 = slabNoise(vSlabW.xz / 41.0 + 7.3);
  float n3 = slabNoise(vSlabW.xz / 9.5 + 2.1);
  float shade = 0.68 + 0.47 * (0.55 * n1 + 0.33 * n2 + 0.12 * n3);
  diffuseColor.rgb *= shade;
}`);
  };
  /* [a7o] 旧版在这里把 CP_Asphalt_MS 的 metalnessMap/roughnessMap 真挂到材质上，
     手机上就是 3 次额外采样 + metalness=1 无 envMap 的纯黑风险。现在把 MS 图
     压进 relief 打包图的 A 通道（高度/粗糙），GPU 只多 1 次采样。 */
  slabMat.roughness = 0.92;
  slabMat.metalness = 0.02;
  // 底板也挂立体贴图：它是玩家脚下最大面积的表面，最不该是「一张纸」。
  // attachRelief 是链式追加，slab 自己的 macro-noise onBeforeCompile 会先执行，
  // 两者注入点互不覆盖（common / map_fragment 都保留原 include 再追加）。
  ensureRelief('__slab__', {
    tex: 'CP_Broken_Asphalt_A.png', metalTex: 'CP_Asphalt_MS.tga',
    texScale: [rep, rep],            // 与 slabMap.repeat 严格一致，砖缝才对得上
  }, slabMat);
  // [a7o] 底板原来是零厚度 ShapeGeometry：从侧面/低视角看就是一张纸。
  // 挤出 0.18 m 实体（带侧壁），顶点数只从 4 增到 ~16，移动端零负担。
  const slabGeo = extrudeFlat(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2),
    { depth: 0.18, maxTriangles: 20000, uvScale: 1,
      ao: { strength: 0.12, floor: 0.88 } });   // 米制 UV，9 m 铺贴交给 slabMap.repeat
  const slab = new THREE.Mesh(slabGeo, slabMat);
  // BELOW every authored surface: the slum districts' own grounds sit at
  // y≈-1..-0.42 — a slab at street level buried them (and all their clutter)
  slab.position.y = SAFETY_FLOOR_Y - 0.01;
  // [2026-11-17a4 关键修复] 这块底板是整座城的「兜底地面」，它没有 noCull 标记，
  // 于是被距离剔除当成远处物体隐藏 → 屏幕下方出现一整片纯黑（其实是天穹背面），
  // 玩家走过去就踏空坠落 → 触发救援「把你传送回安全点」。
  // 用户反复反馈的「走出那片范围地面变黑 + 被传回出生点」就是这一条。
  slab.userData.noCull = true;
  slab.frustumCulled = false;
  slab.renderOrder = -1;
  scene.add(slab);
}
// frame a district: stand back from its centroid and look at it
function frameView(c, back = 55, up = 9, lookUp = 3) {
  if (!c) return [null, null];
  const pos = c.clone().add(new THREE.Vector3(back, up, back));
  const q = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(pos, c.clone().setY(c.y + lookUp), new THREE.Vector3(0, 1, 0)));
  return [pos, q];
}
const metro = centroid(p => p.startsWith('CP_Metro'));
const slums = centroid(p => p.startsWith('CP_Slums'));
const towers = centroid(p => p.startsWith('CP_Skyscraper'));
const aerialPos = center.clone().setY(bounds.max.y + 260);
const aerialQuat = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(aerialPos, center, new THREE.Vector3(0, 0, -1)));
const LANDMARKS = [
  ['1 街道起点', convPos(SCENE.camera.t), convQuat(SCENE.camera.r)],
  ['2 地铁站', ...frameView(metro)],
  ['3 贫民窟', ...frameView(slums)],
  ['4 摩天楼', ...frameView(towers, 140, 90, 50)],
  ['5 鸟瞰全城', aerialPos, aerialQuat],
];

// ---------- character materials (Survivors pack) ----------
const CHAR_MATS = await J('./chars/data/materials.json');
let CHAR_RELIEF_SEQ = 0;      // [a7o] charMatFor 每次新建材质，打包图缓存键需唯一
const charTexCache = {};
function charTexture(file, srgb = true) {
  file = texFile(file);
  if (!charTexCache[file]) {
    const t = cappedTexture('./chars/textures/' + encodeURIComponent(file));
    // [2026-11-17a2] 永不释放标记：材质上挂的就是这个对象，标记随对象走，
    // 不依赖 __player / SRC_INFO / URL 任何一处是否就绪 —— 那三处都会因为
    // 建场时序而失效（线上就失效了，主角变成黑剪影）。
    t.userData.noRelease = true;
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = MAXANISO;
    charTexCache[file] = t;
  }
  return charTexCache[file];
}
// character MetallicSmoothness repack (loads from ./chars/textures/)
function charPackMetalRough(file, onReady) {
  const img = new Image();
  img.onload = () => {
    // [MC-SET] 先按上限降采样：像素循环量 ∝ 边长²，1024 上限比 2048 快 4 倍
    const src = fitImage(img);
    const c = Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const metal = px[i], smooth = px[i + 3];
      px[i + 1] = 255 - smooth; px[i + 2] = metal; px[i] = 0; px[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; t.colorSpace = THREE.LinearSRGBColorSpace;
    onReady(t);
  };
  img.src = './chars/textures/' + encodeURIComponent(texFile(file));
}
function charMatFor(name) {
  const rec = CHAR_MATS[name];
  if (!rec) return new THREE.MeshStandardMaterial({ color: 0xff00ff });
  const m = new THREE.MeshStandardMaterial();
  m.color.setRGB(rec.color[0], rec.color[1], rec.color[2], THREE.SRGBColorSpace);
  if (rec.tex) m.map = charTexture(rec.tex);
  if (rec.normalTex) { m.normalMap = charTexture(rec.normalTex, false); m.normalScale.setScalar(rec.bumpScale ?? 1); }
  if (rec.metalTex) {
    /* [a7o] 旧版 metalness=1 + 异步挂 metalnessMap/roughnessMap：无 envMap 时
       就是「纯黑剪影」的经典配方。MS 图现在压进打包图 A 通道，GPU 只多 1 次采样。 */
    m.metalness = 0.04;
    m.roughness = THREE.MathUtils.clamp(1 - (rec.smoothness ?? 0.3), 0.4, 1);
  } else {
    m.metalness = Math.min(rec.metallic ?? 0, 0.4);
    m.roughness = THREE.MathUtils.clamp(1 - (rec.smoothness ?? 0.3), 0.4, 1);
  }
  // [a7o] 角色也走立体贴图（独立目录），键带序号避免 charMatFor 反复调用互相覆盖
  ensureRelief('__char__' + name + '#' + (++CHAR_RELIEF_SEQ), rec, m, './chars/textures/');
  if (rec.mode === 1) { m.alphaTest = rec.cutoff ?? 0.5; m.alphaToCoverage = true; }
  else if (rec.mode >= 2) {
    m.transparent = true;
    // mode 3 = glass layers (cornea!): honor near-zero authored alpha — the old
    // 0.35 floor put a white film over the eyeballs and erased the pupils
    m.opacity = Math.max(rec.color[3], rec.mode >= 3 ? 0.04 : 0.35);
    m.depthWrite = rec.mode < 3;
  }
  return m;
}


// ---------- game layer (architecture adapted from the web-slinger reference) ----------
import { buildCityBoxes } from './cityBoxes.js?v=a7t';
import { Controller } from './controller.js?v=a7t';
import { CameraRig } from './cameraRig.js?v=a7t';
import { Input } from './input.js?v=a7t';

// ---------- floating-decal cull ----------
// Ground decals (road markings, manholes, dirt) are authored ON surfaces the
// pack never built in the void blocks — they hover as lone stickers over the
// sunken slab. Hide every FLAT decal instance with no opaque support just
// beneath it. Wall posters (tall AABBs) are untouched.
{
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const org = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _c = new THREE.Vector3();
  const isDecalMat = m => (m.transparent && m.polygonOffset) || m.alphaTest > 0;   // mode>=2 decals + mode 1 cutouts
  const supported = (x, y, z, selfIm) => {
    ray.set(org.set(x, y + 0.3, z), down);
    ray.far = 1.9;
    for (const im of rayCandidates(x, z, 0, 0, 1.9)) {
      if (!im.isInstancedMesh || im === selfIm || isDecalMat(im.material)) continue;
      if (ray.intersectObject(im, false).length) return true;
    }
    return false;
  };
  let culled = 0;
  for (const im of [...world.children]) {
    if (!im.isInstancedMesh || !isDecalMat(im.material)) continue;
    if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox;
    const kept = [];
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, _m);
      let y0 = 1e9, y1 = -1e9, cx = 0, cz = 0;
      for (const xx of [bb.min.x, bb.max.x]) for (const yy of [bb.min.y, bb.max.y])
        for (const zz of [bb.min.z, bb.max.z]) {
          _c.set(xx, yy, zz).applyMatrix4(_m);
          y0 = Math.min(y0, _c.y); y1 = Math.max(y1, _c.y);
          cx += _c.x / 8; cz += _c.z / 8;
        }
      const flat = y1 - y0 < 0.2;                   // ground decal, not a wall poster
      if (!flat || supported(cx, (y0 + y1) / 2, cz, im)) kept.push(_m.clone());
      else culled++;
    }
    if (kept.length < im.count) {
      kept.forEach((m, i) => im.setMatrixAt(i, m));
      im.count = kept.length;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }
  console.log(`floating decals culled: ${culled}`);
}

// ---------- foundation podiums (auto-generated) ----------
// The stage set stacks baked upper blocks on top of street-level facade
// modules (blocks start at ~5 m, facades only dress the street side), and
// props like monorail columns are authored against terrain that was never
// paved — from the open side those bases visibly hover. For every rendered
// instance whose perimeter hangs in the air, extrude a dark plinth from its
// base down to whatever is below (slab at worst). Added to `world` BEFORE the
// box build so podiums collide, occlude and take webs like real structure.
{
  const SKIP_RE = /Signboard|Wires|Canopy|Air_Traffic|Cloud|Overhang|Cable|Lamp|Light|Antenna|Vent|Conditioner|Pipe|Feeder|Camera|Banner|Decal|Track|Train|Rail|Tunnel|Smoke|Dust/i;
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const org = new THREE.Vector3();
  const probe = (x, y, z, far) => {   // nearest surface below (x,y,z), else null
    ray.set(org.set(x, y, z), down);
    ray.far = far;
    let best = null;
    for (const im of rayCandidates(x, z, 0, 0, far)) {
      if (!im.isInstancedMesh) continue;
      const hits = ray.intersectObject(im, false);
      if (hits.length && (best === null || hits[0].point.y > best)) best = hits[0].point.y;
    }
    return best;
  };
  const _bm = new THREE.Matrix4();
  const _bc = new THREE.Vector3();

  /* ---------- [2026-11-17a5] 落地吸附：把"本该躺在地上"的物件拉回地面 ----------
     用户实拍「很多东西悬空」。逐实例检测（8 角点求真实底部 + 向下探地）后，
     悬空量最大的不是大楼，而是两类别扭：
       CP_Sidewalk_C_8x4m  铺装块（8×4m，厚度≈0）→ 悬空 ~1.0m
       CP_Fence_B_5m_01    围栏（5m 长）        → 悬空 ~1.5m
     它们被作者放在了和街面不相容的地面基准上。挂墙件（空调外机 13m、
     女儿墙栏杆 4m、配电箱 3.5m）不动 —— 那些本来就该悬空。
     只吸 0.15~2.5m 的轻微悬空，更大间隙通常是作者有意做的高台。 */
  {
    const SNAP_PAVE_RE = /Sidewalk|Pavement|Road_|Plaza|Curb/i;
    const SNAP_PROP_RE = /Fence|Barrier|Bollard|Bench|Bin|Trash|Crate|Planter|Hydrant|Street_Lamp|Manhole|Dumpster|Garbage/i;
    const bm2 = new THREE.Matrix4(), bc2 = new THREE.Vector3();
    const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
    let snapped = 0;
    // 用 scene.traverse 而非 world.children：CP_Sidewalk_C 这类铺装块并不挂在
    // world 下（所以旧的 plinth 循环也漏了它们），只扫一层 children 会整类漏掉。
    const snapTargets = [];
    const seen = new Set();
    for (const root of [world, scene]) {
      if (!root) continue;
      root.traverse(o => { if (o.isInstancedMesh && o.geometry && !seen.has(o)) { seen.add(o); snapTargets.push(o); } });
    }
    for (const im of snapTargets) {
      const name = im.userData.prefab || '';
      const isPave = SNAP_PAVE_RE.test(name), isProp = SNAP_PROP_RE.test(name);
      if (!isPave && !isProp) continue;
      if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
      const bb = im.geometry.boundingBox;
      let dirty = false;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, bm2);
        let y0 = 1e9;
        for (const xx of [bb.min.x, bb.max.x]) for (const yy of [bb.min.y, bb.max.y]) for (const zz of [bb.min.z, bb.max.z]) {
          bc2.set(xx, yy, zz).applyMatrix4(bm2);
          if (bc2.y < y0) y0 = bc2.y;
        }
        if (y0 > 9) continue;                       // 屋顶/高台上的同类：不动
        bc2.set((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2).applyMatrix4(bm2);
        const cx = bc2.x, cz = bc2.z;
        // 探地时跳过自身（否则射线先命中自己的底面，gap 恒为 0）
        ray.set(org.set(cx, y0 + 0.6, cz), down);
        ray.far = 3.4;
        let obs = null;
        for (const im2 of snapTargets) {
          if (im2 === im) continue;
          const hits = ray.intersectObject(im2, false);
          if (hits.length && (obs === null || hits[0].point.y > obs)) obs = hits[0].point.y;
        }
        // 探不到任何几何（下面是虚空/底板，底板是 scene 子级不参与这一步射线）：
        // 若物件本身就在街面高度附近，按街面 y=0 兜底 —— 这正是
        // CP_Sidewalk_C_8x4m 悬空 1m 的成因（铺装块下面什么都没有，射线打空）。
        if (obs == null) {
          if (y0 > -0.3 && y0 < 2.6) obs = 0; else continue;
        }
        const gap = y0 - obs;
        if (gap < 0.15 || gap > 2.5) continue;
        bm2.decompose(tp, tq, ts);
        tp.y -= gap;
        bm2.compose(tp, tq, ts);
        im.setMatrixAt(i, bm2);
        dirty = true; snapped++;
      }
      if (dirty) im.instanceMatrix.needsUpdate = true;
    }
    if (snapped) console.log(`[a5] ground-snap: ${snapped} instances pulled down to pavement`);
  }

  const pods = [];
  for (const im of [...world.children]) {
    if (!im.isInstancedMesh) continue;
    if (SKIP_RE.test(im.userData.prefab || '')) continue;
    if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
    const bb = im.geometry.boundingBox;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, _bm);
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const xx of [bb.min.x, bb.max.x]) for (const yy of [bb.min.y, bb.max.y])
        for (const zz of [bb.min.z, bb.max.z]) {
          _bc.set(xx, yy, zz).applyMatrix4(_bm);
          if (_bc.x < x0) x0 = _bc.x; if (_bc.x > x1) x1 = _bc.x;
          if (_bc.z < z0) z0 = _bc.z; if (_bc.z > z1) z1 = _bc.z;
          if (_bc.y < y0) y0 = _bc.y; if (_bc.y > y1) y1 = _bc.y;
        }
      const fx = x1 - x0, fz = z1 - z0;
      if (y1 - y0 < 2.5 || y0 < 0.45) continue;          // not building-sized / grounded
      // ONLY real near-ground structure gets a plinth. The Background category
      // "miniature city block" fillers (footprints 100-150 m, bases 30-40 m up,
      // stacked over the districts as skyline filler) used to spawn monstrous
      // 100 m concrete decks — the "steel plate" plateaus — which also blocked
      // mid-air flight paths ("stuck in the air while landing").
      if (fx > 60 || fz > 60) continue;                  // background blocks / districts
      if (y0 > 24) continue;                             // high-altitude filler, not a building base
      const ins = 0.12;
      const pts = [
        [x0 + fx * ins, z0 + fz * ins], [x1 - fx * ins, z0 + fz * ins],
        [x0 + fx * ins, z1 - fz * ins], [x1 - fx * ins, z1 - fz * ins],
        [(x0 + x1) / 2, (z0 + z1) / 2],
      ];
      let anyDeep = false, allDeep = true, groundMin = Infinity;
      for (const [px, pz] of pts) {
        const g = probe(px, y0 + 0.35, pz, y0 + 3) ?? SAFETY_FLOOR_Y;   // slab as last resort
        if (y0 - g > 1.2) anyDeep = true; else allDeep = false;
        if (g < groundMin) groundMin = g;
      }
      // big blocks: any hanging edge gets a plinth (flush behind street facades);
      // small props: only if fully airborne (roof-edge clutter must not grow 30 m piers)
      if (!(anyDeep && (Math.max(fx, fz) > 8 || allDeep))) continue;
      const depth = y0 - groundMin + 0.15;
      // keep plinths for REAL structure only — shallow gaps under small clutter
      // (fences, crates) read as random gray blocks, worse than the gap itself
      if (depth < 2.2 || depth > 80) continue;
      if (!(Math.max(fx, fz) > 8 || depth > 5 || (y1 - y0) > 8)) continue;
      pods.push({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, sx: Math.max(fx * 0.96, 0.4),
                  sz: Math.max(fz * 0.96, 0.4), top: y0 + 0.08, depth });
    }
  }
  if (pods.length) {
    // dress plinths in the pack's own concrete so they read as foundations,
    // not gray boxes (box UVs are 0..1 per face; repeat 2×2 keeps grain)
    const pt = texture('CP_Concrete_03_A.tga').clone();
    pt.needsUpdate = true;
    pt.repeat.set(2, 2);
    const nsrc = texture('CP_Concrete_03_N.tga', false);
    const pn = nsrc ? nsrc.clone() : null;
    if (pn) { pn.needsUpdate = true; pn.repeat.set(2, 2); }
    const mat = new THREE.MeshStandardMaterial({
      map: pt, normalMap: pn || null, color: 0x8f959c, roughness: 0.92, metalness: 0.03 });
    /* [a7o] 基座也要立体：混凝土的砖缝/颗粒由打包图接管，pn 不再单独采样。 */
    ensureRelief('__podium__', {
      tex: 'CP_Concrete_03_A.tga', normalTex: 'CP_Concrete_03_N.tga',
      texScale: [2, 2],
    }, mat);
    const podiumGeo = ensureColor(new THREE.BoxGeometry(1, 1, 1));
    const pim = new THREE.InstancedMesh(podiumGeo, mat, pods.length);
    pim.userData.prefab = '__podium';
    const q = new THREE.Quaternion();
    pods.forEach((p, i) => {
      _bm.compose(_bc.set(p.cx, p.top - p.depth / 2, p.cz), q,
                  new THREE.Vector3(p.sx, p.depth, p.sz));
      pim.setMatrixAt(i, _bm);
    });
    pim.instanceMatrix.needsUpdate = true;
    pim.computeBoundingSphere();
    world.add(pim);
  }
  console.log(`foundation podiums: ${pods.length}`);
}

const bw = buildCityBoxes(world);
console.log(`city boxes: ${bw.aabbs.length} (${bw.aabbs.filter(b => b.collide).length} collidable)`);

/* [全量接替] 真实 863,196 栋已覆盖全城，程序化合成建筑会与真实建筑叠放
   （实测 1,671 个合成建筑里 893 个压在真实足迹内）。碰撞盒已在上行建好，
   这里只隐藏视觉实例，保留 AABB 供玩家站立/遮挡，零穿模。 */
let __procHidden = 0;
const __hideProc = () => {
  world.traverse(o => {
    if (!o.isInstancedMesh || !o.visible) return;
    const n = (o.userData && o.userData.prefab) || '';
    if (/Combined_Building|Skyscraper|Slums/.test(n)) { o.visible = false; __procHidden += o.count; }
  });
  window.__procHidden = __procHidden;
};
__hideProc();
setTimeout(__hideProc, 3000);   // 合成城异步装配完再扫一遍
/* [迈阿密] 程序化城整体不渲染：CP_Slums_Pack 是 400×400/200×200 整块合成楼群，
   与真实建筑穿插重影，画面上的"青色描边楼"就是它。碰撞数据已在 buildCityBoxes
   里固化，隐藏渲染不影响玩家站立/遮挡。 */
world.visible = false;
if (__procHidden) console.log(`[全量接替] 隐藏合成建筑 ${__procHidden} 个（真实建筑已覆盖）`);

/* ---------- 虚空补地：按需探测 + 动态铺设（2026-11-16a2） ----------
   原版只铺了主街走廊与各地块自身地面，地块之间大片虚空（实测走廊 35%、
   全城过半采样点无地面）——玩家一出走廊就「地面塌陷/掉虚空/被拉回」。
   方案：以 12m 网格对全城做「街面 ±3.5m 内有无真实地面」的射线探测
   （静态 AABB 覆盖推断会被街区级合并包围盒骗过，弃用），无地面 → 补铺
   y=0 沥青块（与街道同材质同标高）。探测跟随玩家按需进行：
   · 脚下格子同步探测（零延迟，永不觉踩空）；
   · 周边半径 130m 由每帧队列铺开（弱机 8 格/帧不卡顿）；
   · 地铁深坑等超出 ±3.5m 窗口的区域一律封盖成街面（剥玩法后本就不可达）。 */
const PAVE = {
  cell: 12, x0: 0, z0: 0, w: 0, h: 0,
  state: null,            // Uint8Array  0 未探测 | 1 有真实地面 | 2 虚空已补
  list: [], mesh: null, cap: 0, dirty: 0,
  queue: [], lastCx: 1e9, lastCz: 1e9,
};
{
  const pad = 80, CELL = PAVE.cell;
  PAVE.x0 = bounds.min.x - pad; PAVE.z0 = bounds.min.z - pad;
  PAVE.w = Math.ceil((bounds.max.x + pad - PAVE.x0) / CELL);
  PAVE.h = Math.ceil((bounds.max.z + pad - PAVE.z0) / CELL);
  PAVE.state = new Uint8Array(PAVE.w * PAVE.h);
}
function paveCellAt(x, z) {
  const i = Math.floor((x - PAVE.x0) / PAVE.cell), j = Math.floor((z - PAVE.z0) / PAVE.cell);
  if (i < 0 || j < 0 || i >= PAVE.w || j >= PAVE.h) return -1;
  return j * PAVE.w + i;
}
function paveProbe(i, j) {
  const idx = j * PAVE.w + i, st = PAVE.state;
  if (st[idx]) return st[idx];
  const x = PAVE.x0 + (i + 0.5) * PAVE.cell, z = PAVE.z0 + (j + 0.5) * PAVE.cell;
  for (const r of matteRects)                    // 照片地毯区按已有地面处理
    if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) { st[idx] = 1; return 1; }
  const hit = groundRayHit(x, z, 3.2, 6.7);      // 只认 y∈[-3.5, 3.2] 的真实地面
                                                  //（窗口含 4~8m 悬浮甲板会把格子误判成
                                                  //   「有地面」→ 街面出现 1.4m 凹坑 →
                                                  //   玩家从坑底滑进街道网格底下坠穿世界）
  if (hit) { st[idx] = 1; return 1; }
  st[idx] = 2;
  PAVE.list.push([x, z]);
  PAVE.dirty = 1;
  return 2;
}
function paveState(x, z) {
  const c = paveCellAt(x, z);
  return c < 0 ? 1 : paveProbe(c % PAVE.w, Math.floor(c / PAVE.w));
}
function paveFlush() {
  PAVE.dirty = 0;
  const need = PAVE.list.length;
  if (!need) return;
  if (!PAVE.mesh || PAVE.cap < need) {
    PAVE.cap = Math.max(1024, need * 2);
    // PlaneGeometry 的 UV 是 0..1，repeat 必须是整数，否则 12m 格子之间纹理错位成接缝
    const rep = Math.max(1, Math.round(PAVE.cell / 12));   // 12m 一格 → 1 次平铺，与邻格连续
    // [2026-11-17a5] 补地同样挂回沥青：a4 用纯色 0x3c4046 修「变黑」，
    // 结果是脚下每 12m 一格、颜色完全一致的灰板，走过去时地面像在「刷灰漆」
    // —— 这也正是用户说的「刷新不合理」。挂贴图后新补的格子与老地面无缝。
    const pTex = texture('CP_Broken_Asphalt_A.png').clone();
    pTex.repeat.set(rep, rep);
    pTex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      color: pTex.image ? 0xffffff : 0x6e747c, metalness: 0, roughness: 0.94,
      map: pTex.image ? pTex : null, emissiveMap: pTex.image ? pTex : null,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.08,
    });
    mat.userData.__boost = 1.7;   // [F-41] 先设 boost 再挂等待，贴图到达后提亮不丢
    applyMapWhenReady(mat, pTex);
    mat.userData.isGroundMat = true;
    // [2026-11-17a6] 补地格子是运行时动态创建的，赶不上建场时的材质精简循环，
    // 所以在这里直接套同一套「地面提亮」，否则永远是 0.08 的桌面档 → 走到哪黑到哪。
    mat.emissive.setScalar(0.30);                         // [迈阿密] 降自发光
    mat.emissiveIntensity = 0.22;
    // [a7o] 运行期补地同样挂立体贴图，否则「走到哪、新格子就是一张平纸」。
    ensureRelief('__pavement__', {
      tex: 'CP_Broken_Asphalt_A.png', texScale: [rep, rep],
    }, mat);
    const geo = ensureColor(new THREE.PlaneGeometry(PAVE.cell, PAVE.cell).rotateX(-Math.PI / 2));
    const im = new THREE.InstancedMesh(geo, mat, PAVE.cap);
    im.receiveShadow = true;   // [a7f] 运行期补地也接收真实阴影（薄面片不投影）
    im.count = need;
    im.userData.prefab = '__pavement';
    im.userData.ground = true;   // [a5] 让移动端统一提亮认得它（否则底板亮、补地暗）
    im.userData.noCull = true;
    im.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    PAVE.list.forEach(([x, z], k) => { m4.makeTranslation(x, 0, z); im.setMatrixAt(k, m4); });
    im.instanceMatrix.needsUpdate = true;
    // 挂在 scene 而非 world：不进墙体射线/碰撞盒，地面由 groundAt 掩码判定
    if (PAVE.mesh) {
      unregisterTexUsers(PAVE.mesh);           // 旧网格退役，登记表同步摘掉
      scene.remove(PAVE.mesh); PAVE.mesh.geometry.dispose(); PAVE.mesh.dispose();
    }
    scene.add(im);
    // [2026-11-16a5] 动态网格补登记：贴图源与街道共用，若不登记，
    // 街道一侧被判定「远处」驱逐后，脚下这片补地会采到失效源 → 地面整片发黑。
    registerTexUsers(mat, im);
    PAVE.mesh = im;
    return;
  }
  const im = PAVE.mesh, m4 = new THREE.Matrix4();
  for (let k = im.count; k < need; k++) {
    const [x, z] = PAVE.list[k];
    m4.makeTranslation(x, 0, z); im.setMatrixAt(k, m4);
  }
  im.count = need;
  im.instanceMatrix.needsUpdate = true;
}
function paveTick() {
  const px = camera.position.x, pz = camera.position.z;
  if (Math.hypot(px - PAVE.lastCx, pz - PAVE.lastCz) > 40) {
    PAVE.lastCx = px; PAVE.lastCz = pz;
    const R = 130, CELL = PAVE.cell;
    const i0 = Math.max(0, Math.floor((px - R - PAVE.x0) / CELL)), i1 = Math.min(PAVE.w - 1, Math.floor((px + R - PAVE.x0) / CELL));
    const j0 = Math.max(0, Math.floor((pz - R - PAVE.z0) / CELL)), j1 = Math.min(PAVE.h - 1, Math.floor((pz + R - PAVE.z0) / CELL));
    const q = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      if (!PAVE.state[j * PAVE.w + i])
        q.push([Math.hypot(px - (PAVE.x0 + (i + .5) * CELL), pz - (PAVE.z0 + (j + .5) * CELL)), i, j]);
    q.sort((a, b) => a[0] - b[0]);
    PAVE.queue = q.map(e => [e[1], e[2]]);
  }
  // [2026-11-17a4] 8 → 2：每格一次射线，在手机上 8 格就是每帧多 4~8ms 的主线程，
  // 而补地是「走过去之前」完成的，不需要这么快。2 格/帧在 30fps 下仍是 60 格/秒。
  let n = 2;
  while (n-- > 0 && PAVE.queue.length) {
    const [i, j] = PAVE.queue.shift();
    paveProbe(i, j);
  }
  if (PAVE.dirty) paveFlush();
}

/* ---------- 实例分布包围球：距离判断的真实几何 ----------
   对场景里每个网格预计算世界系 {cx, cz, r}：
   · InstancedMesh：遍历实例平移求包围盒，半径 = 分布半径 + 几何包围球（含 1.3 缩放余量）
   · 普通网格：世界包围盒半对角
   距离语义：distToContent = 相机到球心距离 - 半径（<0 = 相机在内容包围球内 → 永近） */
const OBJ_DIST = new Map();
{
  const _im4 = new THREE.Matrix4();
  const _wb = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh) || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    let cx, cz, r;
    if (o.isInstancedMesh) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, far = 0;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _im4);
        const x = _im4.elements[12], z = _im4.elements[14];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      cx = (x0 + x1) / 2; cz = (z0 + z1) / 2;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _im4);
        const d = Math.hypot(_im4.elements[12] - cx, _im4.elements[14] - cz);
        if (d > far) far = d;
      }
      r = far + o.geometry.boundingSphere.radius * 1.3;
    } else {
      _wb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      cx = (_wb.min.x + _wb.max.x) / 2;
      cz = (_wb.min.z + _wb.max.z) / 2;
      r = _wb.getSize(new THREE.Vector3()).length() / 2;
    }
    OBJ_DIST.set(o, { cx, cz, r: r + 2 });   // +2m 裕量，宁多画不误杀
  });
  console.log(`instance-sphere dist map: ${OBJ_DIST.size} meshes`);
}
// [a7e] 启动期全量装配移至 buildTexRegistry() 之后（见下）：装配时机与旧版
// 「一次性建完全城」完全一致，之后区块流送器在 play 阶段渐进卸载远处区块。
/** 网格内容到 (x,z) 的真实距离（负值 = 在内容包围球内 → 永近）；未登记的网格退回物体自身位置 */
function distToContent(o, x, z) {
  const d = OBJ_DIST.get(o);
  if (d) return Math.sqrt((d.cx - x) * (d.cx - x) + (d.cz - z) * (d.cz - z)) - d.r;
  o.getWorldPosition(_cp);
  return Math.sqrt((_cp.x - x) * (_cp.x - x) + (_cp.z - z) * (_cp.z - z));
}

/** 建立贴图槽位登记表（模块加载末段调用一次；角色蒙皮网格不参与驱逐） */
function buildTexRegistry() {
  scene.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    registerTexUsers(o.material, o);
  });
  console.log(`texture registry: ${TEX_REG.size} sources, ` +
              `${[...TEX_REG.values()].reduce((a, e) => a + e.users.length, 0)} slots`);
}
/** 把某个网格的材质槽位登记进静态表（运行期新建的网格必须补登记，
    否则它共享的贴图源被驱逐后，槽位置空/源数据失效 → 该网格渲染成纯黑） */
const TEX_OWNER = new Map();      // owner -> [user 记录]，卸载时 O(k) 精确摘除
function registerTexUsers(material, owner) {
  const mats = Array.isArray(material) ? material : [material];
  let rec = TEX_OWNER.get(owner);
  for (let mi = 0; mi < mats.length; mi++) {
    const m = mats[mi];
    if (!m) continue;
    for (let ki = 0; ki < RESIDENCY_SLOTS.length; ki++) {
      const k = RESIDENCY_SLOTS[ki], t = m[k];
      if (!t || !t.source) continue;
      const id = t.source.uuid;
      let e = TEX_REG.get(id);
      if (!e) { e = { info: SRC_INFO.get(id) || null, users: [], minD: Infinity }; TEX_REG.set(id, e); }
      const u = { mat: m, slot: k, tex: t, owner, _e: e, _i: e.users.length, _dead: false };
      e.users.push(u);
      if (!rec) TEX_OWNER.set(owner, rec = []);
      rec.push(u);
    }
  }
}
/** swap-remove：不分配新数组、不扫描整张 TEX_REG。 */
function unregisterTexUsers(owner) {
  const rec = TEX_OWNER.get(owner);
  if (!rec) return;
  TEX_OWNER.delete(owner);
  for (let j = 0; j < rec.length; j++) {
    const u = rec[j];
    if (u._dead) continue;
    u._dead = true;
    const arr = u._e.users, i = u._i, last = arr[arr.length - 1];
    if (last !== u) { arr[i] = last; last._i = i; }
    arr.pop();
  }
}
// ---------- 移动端材质精简（2026-11-17a4） ----------
// 实测 JS 每帧只有 2~3ms，5fps 只可能来自 GPU。这个包是桌面级资产：每栋楼挂着
// baseColor + normal + roughness + metalness + ao 五张贴图，MeshStandardMaterial
// 每像素要做完整 PBR + 切线空间法线重建，手机上填充率直接崩。
// 移动端保留 map / emissiveMap / alphaMap（观感的主要来源），去掉法线、粗糙度、
// 金属度、AO 四个通道，并把材质常量化为「哑光」——贴图显存同时从 ~240MB 降到
// ~100MB（iOS 上少一半内存压力），像素着色成本约降 1/3。
if (PERF.isMobileUA && !/[?&]notrim/.test(location.search)) {
  let trimmed = 0, boosted = 0;
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) continue;
      if (m.userData.__trimmed) continue;
      m.userData.__trimmed = true;
      /* [a7o] 旧版在这里把 normalMap/roughnessMap/metalnessMap/aoMap 全部置 null，
         等于把刚做好的立体感又抹回「一张纸」。现在四通道已压进单张 256²
         打包图，手机每像素只多 1 次采样，不需要再砍。只保留两个常量兜底：
         修 a7i 的「metalness=1 无 envMap → 纯黑」与非法 roughness。        */
      if (m.metalness === 1 && !m.envMap) m.metalness = 0.04;
      if (!Number.isFinite(m.roughness)) m.roughness = 0.88;
      // 地面类（又扁又大）：实机与模拟里沥青都渲染成接近纯黑 ——
      // 手机屏幕在户外/暗环境下更看不出来。给地面单独提亮：抬基色 + 少量自发光
      // （用同一张贴图，只抬亮度不改构图），保证「路面是路面」而不是一条黑带。
      if (o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bs = o.geometry.boundingBox.getSize(new THREE.Vector3());
        const isGroundMat = m.userData && m.userData.isGroundMat;
        if (isGroundMat || (bs.y < 1.6 && Math.max(bs.x, bs.z) > 30)) {
          m.color.multiplyScalar(1.0);  // [迈阿密] 不再硬提亮基色，避免地面死白
          if (m.map) {
            m.emissiveMap = m.map;
            m.emissive.setScalar(0.30);  // [迈阿密] 降自发光
            /* [2026-11-17a6] 定标过程（用染绿实验确认底板确实覆盖整个脚下）：
               沥青源图本身很暗（夜间沥青照片，像素值 15~50/255），而场景只有
               环境光，光照项几乎贡献不到可视亮度 —— 于是路面在屏幕上就是纯黑。
               这里把地面改成「近距离路灯照亮」的观感：以贴图自身亮度为准做自发光，
               强度 1.35 相当于把albums亮度抬到能在夜景里读出颗粒与裂缝。 */
            m.emissiveIntensity = IS_MOBILE ? 0.22 : 0.6;   // [迈阿密] 真实沥青贴图不发白
          }
          boosted++;
        }
      }
      m.needsUpdate = true;
      trimmed++;
    }
  });
  console.log(`[mc] mobile material trim: ${trimmed} materials → map/emissive only, ${boosted} ground boosted`);
}
buildTexRegistry();
/* [a7o] vertexColors 安全兜底：材质开了就必须有 color attribute，否则 USE_COLOR
   会把未绑定 attribute 读成 (0,0,0,1) → 整片纯黑。扫全场景补中性全 1。 */
const RELIEF_COLOR_FIXED = ensureReliefColors(scene);
window.__mcReliefColorFixed = RELIEF_COLOR_FIXED;
console.log(`[relief] vertexColors 安全兜底补齐 ${RELIEF_COLOR_FIXED} 个几何`);
/* [a7m] 普通网格一次性收进剔除表：此后 cullPass 不再 traverse 整棵场景树。 */
scene.traverse(o => {
  if ((o.isMesh || o.isInstancedMesh) && !o.isInstancedMesh && !o.isSkinnedMesh) CULL_PLAIN.push(o);
});

// [a7e] 启动期全量装配：与旧版「一次性建完全城」等价（菜单鸟瞰/首屏完整不变），
// 且保证顺序 = 旧版顺序：建网格 → 材质精简 → OBJ_DIST/贴图登记表。
// assembleChunk 内部会 registerObjDist + registerTexUsers 补齐两张表的条目。
// 之后区块流送器（CHUNK_STREAM）在 play 阶段渐进卸载远处区块释放内存。
{
  const _t0 = performance.now();
  for (const rec of CHUNKS.values()) assembleChunk(rec);
  // [a7f 真实阴影] 非实例化的普通 Mesh（路面底板、霓虹面片等）补接收标记——
  // 只接收不投影：面片薄、无体积，投影反而出 acne / 彼得平移。
  let shadowMarked = 0;
  world.traverse(o => {
    if ((o.isMesh || o.isInstancedMesh) && !o.isInstancedMesh && !o.userData.__shadowInit) {
      o.receiveShadow = true;
      o.userData.__shadowInit = true;
      shadowMarked++;
    }
  });
  console.log(`[chunks] boot full assembly done in ${Math.round(performance.now() - _t0)}ms, ` +
              `${[...CHUNKS.values()].reduce((a, r) => a + r.built.length, 0)} instanced meshes / ${CHUNKS.size} chunks` +
              (shadowMarked ? `, ${shadowMarked} plain meshes marked receiveShadow` : ''));
}

// raycast ground on the real geometry (streets, cars, slums — AABBs can't cover those)
const _groundRay = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _gOrigin = new THREE.Vector3();
/* [a7m] 任意射线的候选网格：只取射线经过的 200m 格，不再遍历全城网格。
   启动早期（区块尚未装配、RAY_CELLS 为空）回退到 world.children，行为不变。 */
function rayCandidates(x, z, dx, dz, far) {
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  const nx = dx / dl, nz = dz / dl;
  const span = Math.min(6, Math.max(1, Math.ceil((far + 24) / CHUNK_SIZE)));
  const cix = Math.floor(x / CHUNK_SIZE), ciz = Math.floor(z / CHUNK_SIZE);
  const out = _rayCandsA;
  out.clear();
  for (const im of RAY_GLOBAL) out.add(im);
  for (let a = -span; a <= span; a++) for (let bb = -span; bb <= span; bb++) {
    if (dx || dz) {
      const ax = a * CHUNK_SIZE, bz = bb * CHUNK_SIZE;
      if (ax * nx + bz * nz < -CHUNK_SIZE * 1.5) continue;   // 只取射线前向半平面
    }
    const s = RAY_CELLS.get(packCell(cix + a, ciz + bb));
    if (s) for (const im of s) out.add(im);
  }
  if (!out.size && RAY_CELLS.size === 0) {
    for (let _i = 0; _i < world.children.length; _i++) {
      const im = world.children[_i];
      if (im.isInstancedMesh) out.add(im);
    }
  }
  return out;
}
function groundRayHit(x, z, yFrom, far) {
  _groundRay.set(_gOrigin.set(x, yFrom, z), _down);
  _groundRay.far = far;
  const s = RAY_CELLS.get(cellOf(x, z));
  const cands = _rayCandsB;
  cands.clear();
  for (const im of RAY_GLOBAL) cands.add(im);
  if (s) for (const im of s) cands.add(im);
  if (!cands.size) return null;
  let best = null;
  for (const im of cands) {
    const od = OBJ_DIST.get(im);
    if (od) {
      const dx = od.cx - x, dz = od.cz - z, rr = od.r + 3;
      if (dx * dx + dz * dz > rr * rr) continue;
    }
    const hits = _groundRay.intersectObject(im, false);
    if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
  }
  return best;
}
// the body is a 0.28 m disc, not a point: probe center + 4 offsets and stand
// on the HIGHEST surface near the feet — a single center ray drops the
// character into seams and buries the feet beside raised curbs/markings
// (street surfaces undulate 0–7 cm). Offset hits only count near the feet so
// a fall beside a roof edge can't get yanked up onto it.
// far is a fixed reach below the feet (NOT yFrom-relative: absolute-y far broke
// all ground support below y≈-11, i.e. the whole metro level).
const GROUND_PROBES = [[0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28]];
const _gcache = new Map();
function groundAt(x, z, yFrom, feetY = yFrom - 3) {
  // 同一帧内控制器会以几乎相同的参数查询多次（站立判定 + 落地判定 + 补地），
  // 每次都是最多 5 条射线。按 cm 级取整做单帧缓存，峰值帧省掉一半射线。
  const ck = (x * 100 | 0) + ',' + (z * 100 | 0) + ',' + (yFrom * 10 | 0) + ',' + (feetY * 10 | 0);
  const hit = _gcache.get(ck);
  if (hit !== undefined) return hit;
  const v = groundAtRaw(x, z, yFrom, feetY);
  if (_gcache.size > 512) _gcache.clear();
  _gcache.set(ck, v);
  return v;
}
function groundAtRaw(x, z, yFrom, feetY) {
  // 虚空补地优先：该 12m 格已判定为「街面 ±3.5m 窗口内无真实地面」→ 直接给街面。
  // 必须放在几何探针之前：否则下行阶梯/地铁坡道等深处的真实几何会把玩家
  // 一路拽进 -20m 以下的坑里反复触发救援（2026-11-16a2 剥玩法后深坑一律封盖）。
  // 只对贴近街面（-3.6 ~ 3.5m）的判定生效：站上 3.5m 以上的甲板/屋顶时走真实几何。
  if (feetY > SAFETY_FLOOR_Y - 3.6 && feetY <= 3.5 && paveState(x, z) === 2) return 0;
  const far = yFrom - feetY + 11;
  const center = groundRayHit(x, z, yFrom, far);
  // fast paths: flat ground right under the feet (the common walking frame),
  // or ground far below (mid-air) — no need for the 4-probe disc every frame
  if (center) {
    const cy = center.point.y;
    if (Math.abs(cy - feetY) < 0.04) return cy;
    if (cy < feetY - 1.5) return cy;
  }
  let best = center ? center.point.y : null;
  for (const [ox, oz] of GROUND_PROBES) {
    const h = groundRayHit(x + ox, z + oz, yFrom, far);
    if (h && Math.abs(h.point.y - feetY) < 1.2 && (best === null || h.point.y > best))
      best = h.point.y;
  }
  // safety floor at street level: the pack never paves block interiors (~21%
  // of in-bounds columns have NO geometry — walking off the wrong roof edge
  // fell through the world into the rescue-reset loop). Applies only inside
  // the city bounds and near/above street level — the threshold must exceed
  // one frame of terminal fall (68 m/s × 0.05 s = 3.4 m) or a fast fall can
  // cross it between frames; the metro (y≈−20) keeps its real floors and
  // off-map falls still trigger the rescue dive.
  const inAuthored = x > bounds.min.x - 20 && x < bounds.max.x + 20 &&
                     z > bounds.min.z - 20 && z < bounds.max.z + 20;
  const inUrban = x > URBAN_BOUNDS.x0 && x < URBAN_BOUNDS.x1 &&
                  z > URBAN_BOUNDS.z0 && z < URBAN_BOUNDS.z1;
  if (best === null && feetY > SAFETY_FLOOR_Y - 3.6 && (inAuthored || inUrban)) {
    // the pack's giant photo-carpet planes render ABOVE the slab; stand ON
    // the picture, not 24 cm inside it (they are plain Meshes — no raycast)
    for (const r of matteRects)
      if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return r.y;
    return inAuthored ? SAFETY_FLOOR_Y : 0;   // 迈阿密数据区街面 y=0（roadbed 0.02）
  }
  return best;
}

// generic geometry ray for the controller: verifies wall pushes (air walls),
// snaps web anchors onto facades, validates zip targets
const _castRC = new THREE.Raycaster();
const _instMat = new THREE.Matrix4();
const _normMat = new THREE.Matrix3();
function castRay(origin, dir, far) {
  _castRC.set(origin, dir);
  _castRC.near = 0;
  _castRC.far = far;
  let best = null;
  for (const im of rayCandidates(origin.x, origin.z, dir.x, dir.z, far)) {
    if (!im.isInstancedMesh) continue;
    const od = OBJ_DIST.get(im);
    if (od) {
      // 射线到包围球球心的水平垂距 > 半径 → 不可能相交，直接跳过。
      // 方向必须归一化：controller 传入的 dir 不保证是单位向量，否则垂距被放大 → 误剪。
      const dl = Math.hypot(dir.x, dir.z) || 1;
      const ndx = dir.x / dl, ndz = dir.z / dl;
      const ox = origin.x - od.cx, oz = origin.z - od.cz;
      const proj = ox * ndx + oz * ndz;
      const perp = Math.hypot(ox - proj * ndx, oz - proj * ndz);
      if (perp > od.r + 1) continue;
    }
    const hits = _castRC.intersectObject(im, false);
    if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
  }
  if (!best) return null;
  let normal = null;
  if (best.face) {
    normal = best.face.normal.clone();
    if (best.instanceId !== undefined) {
      best.object.getMatrixAt(best.instanceId, _instMat);
      normal.applyMatrix3(_normMat.getNormalMatrix(_instMat)).normalize();
    }
  }
  return { point: best.point, normal, distance: best.distance };
}

// ---------- characters ----------
loadMsg('loading characters…');
const startPos = convPos(SCENE.camera.t);
const players = {};
for (const g of ['man', 'girl']) {
  const p = new Player(scene);
  await p.load(g, charMatFor, loadMgr);
  /* [a7o] 角色 GLB 不带 color attribute，而 relief 材质开了 vertexColors。
     加载完成立即补齐，否则主角直接变纯黑剪影。 */
  const charFixed = ensureReliefColors(p.group);
  window.__mcReliefCharFixed = (window.__mcReliefCharFixed || 0) + charFixed;
  players[g] = p;
  p.group.position.set(startPos.x + (g === 'man' ? 2.4 : -2.4), 0, startPos.z + 5);
  p.group.rotation.y = p.yaw = Math.PI;
}
// 角色组：网格会跟着玩家满城跑，静态包围球必然失真 → 永不距离剔除
for (const g of Object.values(players)) g.group.traverse(o => { o.userData.noCull = true; });

const ctrl = new Controller(bw, groundAt, castRay, {
  onLand: impact => chosen?.onLand(impact),
});
const rig = new CameraRig(camera, bw);

// [MC-PERF] 场景几何就绪即可进入菜单，贴图在后台按队列补齐。
// 手机端不再出现「加载很久 → 白屏 → 被系统杀掉重载」的长等待。
requestAnimationFrame(() => requestAnimationFrame(() => {
  BUILD_DONE = true;
  if (window.__showMenu) { console.log('[mc] 几何就绪，提前进入菜单'); window.__showMenu(); }
  // 贴图在后台补齐；每 20 秒补释放一次新上传的贴图 CPU 副本
  setInterval(() => { if (!TEX_QUEUE.length && !TEX_ACTIVE) releaseTextureSources(); }, 20000);
}));
const input = new Input(renderer.domElement);

let phase = 'menu';          // menu | play | pause
let chosen = null;
let selGender = null;

// ---------- menu ----------
const menuEl = $('menu'), enterBtn = $('enterBtn');
// 预选第一个角色：让「开始游戏」按钮一开始就是可点的，
// 不再要求玩家先点角色卡（手机上那次点击经常没生效 → 按钮永远点不动）
selectGender('man');
function selectGender(g) {
  selGender = g;
  document.querySelectorAll('.m-card').forEach(c => c.classList.toggle('sel', c.dataset.g === g));
  enterBtn.disabled = false;
  enterBtn.classList.add('ready');
}
document.querySelectorAll('.m-card').forEach(c => {
  // 手机上用 touchend 更可靠；click 保留给桌面；用标记避免双触发
  c.addEventListener('touchend', (e) => { e.preventDefault(); selectGender(c.dataset.g); }, { passive: false });
  c.addEventListener('click', () => selectGender(c.dataset.g));
});
addEventListener('keydown', e => {
  if (phase === 'menu') {
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight')
      selectGender(selGender === 'man' ? 'girl' : 'man');
    if (e.code === 'ArrowUp') selectGender('man');
    if (e.code === 'ArrowDown') selectGender('girl');
    if (e.code === 'Enter' && selGender) startGame();
  } else if (phase === 'pause' && e.code === 'Enter') {
    renderer.domElement.requestPointerLock?.();
  }
  if (e.code === 'KeyT' && !e.repeat)
    applyPreset(PRESET_ORDER[(PRESET_ORDER.indexOf(presetName) + 1) % PRESET_ORDER.length]);
  // [a7e] 区块边框调试层（类 MC F3+G）：反引号键 ` 开关
  if (e.code === 'Backquote' && !e.repeat) CHUNK_STREAM.toggle();
});
// 开始按钮：touchend 与 click 双通道（手机端 click 可能被合成延迟），并做去重
let enterFired = 0;
const doEnter = () => {
  if (Date.now() - enterFired < 800) return;     // 800ms 内不重复触发
  enterFired = Date.now();
  if (!selGender) selectGender('man');           // 没选角色就用默认角色，不静默失败
  startGame();
};
enterBtn.addEventListener('touchend', (e) => { e.preventDefault(); doEnter(); }, { passive: false });
enterBtn.addEventListener('click', doEnter);

function startGame() {
  // Re-entry guard — THE "restarts from the sky every few seconds" bug:
  // starting via a mouse click leaves ENTER GAME focused even after the menu
  // fades (pointer-events:none doesn't drop focus), and the browser treats
  // Space/Enter on a focused <button> as a click — so the first web-swing
  // Space (or the pause screen's own "press Enter to resume") silently
  // re-ran startGame. Guard on phase and drop the focus.
  if (phase !== 'menu') {
    console.log(`[startGame] ignored re-entry (phase=${phase}, likely focused-button activation)`);
    return;
  }
  document.activeElement?.blur?.();
  enterBtn.disabled = true;
  chosen = players[selGender];
  const other = players[selGender === 'man' ? 'girl' : 'man'];
  scene.remove(other.group);
  window.__player = chosen;
  rig.avatar = chosen.group;      // 相机贴墙时会自动隐藏角色，避免整屏被后脑勺糊住
  enterCity();
  rig.blendFrom(camera, 1.5);   // carry the aerial menu shot straight into the street-level entrance
  menuEl.classList.add('gone');
  // （原 $('stats').classList.add('on') 已随玩法遥测剥离，2026-10-05）
  phase = 'play';   // game logic must not depend on pointer lock (headless can't lock)
  window.__phase = 'play';
  // [2026-11-17a6] 崩溃恢复降档（_autoDown）只在「真的跑不动」时保留：
  // 每次成功进入游戏 +1，连续 2 次成功就说明机器扛得住，自动恢复探测档，
  // 否则用户会永远停在当年为了防崩而选的 512。
  try {
    const st = JSON.parse(localStorage.getItem('megacity.settings.v1') || '{}') || {};
    if (st._autoDown) {
      st._autoDown.boots = (st._autoDown.boots || 0) + 1;
      if (st._autoDown.boots >= 2) {
        for (const k of ['textureMaxSize', 'renderScale', 'anisotropy', 'fpsCap',
                         'contentStreamRadius', 'fogDistance', 'maxPixelRatio']) delete st[k];
        delete st._autoDown;
        console.log('[mc] 连续两次成功启动 → 自动降档设置已恢复为探测档（下次刷新生效）');
      }
      localStorage.setItem('megacity.settings.v1', JSON.stringify(st));
    }
  } catch (e) {}
  window.dispatchEvent(new CustomEvent('mc:phase', { detail: 'play' }));
  renderer.domElement.requestPointerLock?.();
}

// 入场：主街站位落地（2026-10-05 剥玩法——原版 430m 高空俯冲开场属玩法动作
// 已剥。如需找回：shared/mirror 原件 doDive() 原样在档，一句话即可加回）
function enterCity(cause = 'start') {
  console.log(`[enterCity] cause=${cause} at=(${startPos.x.toFixed(0)},${startPos.z.toFixed(0)})`);
  // The main detailed street is the z≈0 band spanning x −140…+60 (probed via
  // castRay height map). Face −x down the street so held-W walks on pavement.
  /* [2026-11-26 观感修复] 原出生点在原点手工街(z≈0)，而全量数据的城区主体在
     十几公里外；原点周边全是 <10m 矮房 → 开局像"白平房小村落"。
     默认出生到真实高楼区 (-13,69 块附近, 邻域 150 栋 >30m 高楼)，一进游戏即见
     天际线。?home=origin 可切回原手工街。坐标取自 urban_manifest.json，非伪造。 */
  const _homeOrigin = /[?&]home=origin/.test(location.search);
  // [2026-11-27 出生点观感修复] 全量数据实测 (12300,18200) 80-500m内58栋>60m高楼
  // (最高234m)、且80m内无贴脸楼 —— 站在开阔街区被玻璃塔群环抱,第一印象即迈阿密天际线。
  let px = _homeOrigin ? startPos.x + 25 : 12300;
  let pz = _homeOrigin ? startPos.z - 2 : 18200;
  let py = groundAt(px, pz, 30, 0) ?? 0;   // probe real street height（必须 let：避让换点后要重探）
  // [2026-11-26 迈阿密高楼区朝向] 原点手工街朝西(−x)沿街走；高楼区楼群在出生点
  // 东侧(+x)，必须转身朝东，否则一进游戏背对整片城区、只见空地。
  /* [2026-11-26 出生朝向] 正东（-π/2）会把 199m 塔楼怼在鼻尖上，整屏一堵玻璃墙。
     改朝东南 45°（62,91 块 171m + 199m 两栋同时在 75° 视野里），抬头 7°：
     一进游戏看到的是「三栋塔楼夹出的街谷 + 天际线」，不是一面墙。 */
  // [2026-11-27 实测八朝向] (12300,18200) 处 yaw=0.79 能看到两栋带真实玻璃窗的楼+
  // 街谷纵深;yaw=0 是一整栋弧形玻璃楼。取0.79给"真实迈阿密建筑"第一印象。
  input.yaw = _homeOrigin ? Math.PI / 2 : 0.79;
  input.pitch = _homeOrigin ? -0.12 : 0.04;
  /* [全量接替] 出生点避让：真实建筑铺满街区，原主街站位可能正好落在楼体内。
     若当前 200m 块建筑数 > 40，就近换到最近的稀疏块中心（保距 <2km）。 */
  try {
    const mf = window.__miami && window.__miami.manifest;
    if (mf && mf.chunks) {
      const k0 = Math.floor(px / 200) + ',' + Math.floor(pz / 200);
      const cur = mf.chunks.find(c => c.key === k0);
      const avoidLimit = _homeOrigin ? 16 : 60;   // 高楼区锚点(24栋)不避让，仅极密块微调
      if (cur && cur.count > avoidLimit) {
        const has = new Set(mf.chunks.map(c => c.key));
        const inner = (c) => {
          const p2 = String(c.key).split(','), ix = +p2[0], iz = +p2[1];
          let k = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
            if (dx || dz) { if (has.has((ix + dx) + ',' + (iz + dz))) k++; }
          return k >= 5;   // 内陆：周围 8 格至少 5 格有建筑
        };
        /* [2026-11-26 出生点观感修复] 旧逻辑选「离原点最近的最稀疏块」，
           结果把玩家丢到城市边缘荒地（周围几乎没楼），开局像小村落。
           改为选「本块楼少(不卡墙) 且 周围 8 邻块楼多(有城市感)」的块：
           打分 = 邻块平均栋数 - 距离惩罚(每 km 扣 6 分)，保距 <3km。 */
        const cntOf = new Map(mf.chunks.map(c => [c.key, c.count || 0]));
        let best = null, bestScore = -Infinity;
        for (const c of mf.chunks) {
          if (c.count > 5 || !inner(c)) continue;
          const p2 = String(c.key).split(','), ix = +p2[0], iz = +p2[1];
          let ns = 0, nn = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
            if (dx || dz) { const v = cntOf.get((ix + dx) + ',' + (iz + dz)); if (v !== undefined) { ns += v; nn++; } }
          const density = nn ? ns / nn : 0;
          const distKm = Math.hypot(c.cx - px, c.cz - pz) / 1000;
          if (distKm > 3) continue;                 // 别跳太远丢失已加载区
          const score = density - distKm * 6;
          if (score > bestScore) { bestScore = score; best = c; }
        }
        // 兜底：3km 内没有「稀疏且周边密集」的块时，退回最近的稀疏块（保证不卡墙）
        if (!best) {
          let bd = Infinity;
          for (const c of mf.chunks) {
            if (c.count > 5 || !inner(c)) continue;
            const d = (c.cx - px) ** 2 + (c.cz - pz) ** 2;
            if (d < bd) { bd = d; best = c; }
          }
        }
        if (best) {
          px = best.cx; pz = best.cz;
          // [2026-11-26 手机端青蓝地面修复] 换点后必须重探地面高度：
          // 旧代码沿用旧点 py，新块地面更高/更低就把相机塞进地面以下或悬空，
          // 手机端避让几乎必然触发 → 画面只剩天空球 ground 青蓝半球+地平线一排房。
          py = groundAt(px, pz, 30, 0) ?? 0;
          console.log(`[全量接替] 出生点避让 ${k0}(${cur.count}栋) → ${best.key}(${best.count}栋) py=${py.toFixed(2)}`);
        }
      }
    }
  } catch (e) {}
  /* [2026-11-26 出生点站到街上] 避让只保证「本块楼少」，落在密集街区仍会贴着
     塔楼外墙（实拍：鼻尖离玻璃幕 0.5m，整屏一面墙）。增强层带着 1757 条真实
     道路折线，就地把出生点吸到最近的真实道路点上——站在迈阿密的街上，不是墙里。
     增强层是异步挂载的，这里同步试一次，没就绪就 4 秒后补一次（只在玩家没动时）。 */
  const _snapRoad = () => {
    const E = window.__novaUrban;
    if (!E || typeof E.nearestRoad !== 'function') return false;
    const r = E.nearestRoad(px, pz, 300);
    if (!r) return false;
    px = r.x; pz = r.z;
    py = groundAt(px, pz, 30, 0) ?? py;
    return true;
  };
  const _snappedNow = _snapRoad();
  if (!_snappedNow) {
    const _p0 = { x: px, z: pz };
    setTimeout(() => {
      if (Math.hypot(ctrl.pos.x - _p0.x, ctrl.pos.z - _p0.z) > 6) return;  // 玩家已经走了，不硬拽
      if (_snapRoad()) {
        ctrl.pos.set(px, py + 0.2, pz);
        ctrl.prevY = ctrl.pos.y; ctrl.vel.set(0, 0, 0);
        window.__spawnAnchor.set(px, 2, pz);
        rig.initialized = false;
        const S = window.__miami && window.__miami.stream;
        if (S) { S.setCamera(px, pz, 1, 0, 16); S.io.cancelAll(); S.tick(performance.now(), 16); }
        console.log('[出生点] 已吸附真实道路 (' + px.toFixed(0) + ',' + pz.toFixed(0) + ')');
      }
    }, 4000);
  }
  window.__spawnAnchor = new THREE.Vector3(px, 2, pz);   // rescue 兜底用最终出生点
  // [2026-11-26 出生即空城修复] 城市流送必须立刻对准出生点：入场时相机是从原点
  // 滑过来的，队列里全是沿途分片；不对准的话，出生点周围 900m 的 40+ 块要排在
  // 几十个失效请求之后，手机玩家进门先看到一片空地 + 旧 prefab 白房。
  try {
    const S = window.__miami && window.__miami.stream;
    if (S) {
      S.setCamera(px, pz, 1, 0, 16);
      S.io.cancelAll();
      S.tick(performance.now(), 16);
      if (window.__novaUrban) window.__novaUrban.update(new THREE.Vector3(px, py + 1.35, pz), 16.7);
    }
  } catch (e) {}
  ctrl.pos.set(px, py + 0.2, pz);
  ctrl.prevY = ctrl.pos.y;
  ctrl.vel.set(0, 0, 0);
  ctrl.mode = 'ground';
  ctrl.airTime = 0;
  rig.initialized = false;
  if (cause !== 'start') showMsg('已进入城市', 1.6);
}

// ---------- pause on pointer-unlock (their UX) ----------
let usedLock = false;
document.addEventListener('pointerlockchange', () => {
  usedLock = usedLock || document.pointerLockElement !== null;
  if (phase === 'menu' || !usedLock) return;
  if (document.pointerLockElement === renderer.domElement) {
    phase = 'play';
    window.__phase = 'play';
    $('pause').classList.remove('show');
  } else if (phase === 'play') {
    phase = 'pause';
    window.__phase = 'pause';
    $('pause').classList.add('show');
  }
});
$('pause').addEventListener('click', () => renderer.domElement.requestPointerLock?.());

// ---------- HUD ----------
let msgTimer = 0;
function showMsg(text, seconds = 2.2) {
  const el = $('msg');
  el.textContent = text;
  el.style.opacity = '1';
  msgTimer = seconds;
}
// ---------- debug hooks ----------
window.__world = world;
window.__camera = camera;
window.__rig = rig;                 // 自检/录屏脚本用：可直接步进相机吊臂
window.__ctrl = ctrl;
window.__input = input;
window.__startGame = g => { selectGender(g); startGame(); };
window.__tp = (x, y, z) => { window.__freeCam = true; window.__fcPos = new THREE.Vector3(x, y, z); };
window.__lookAt = (x, y, z) => { window.__freeCam = true; window.__fcLook = [x, y, z]; };
window.__groundAt = groundAt;
window.__pave = { state: paveState, stats: () => ({ paved: PAVE.list.length, probed: PAVE.state.reduce((a, v) => a + (v ? 1 : 0), 0) }) };
window.__charMatFor = charMatFor;   // 联机远程玩家复用本体质感材质（multiplayer_v2）
window.__probeGround = (x, z) => {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, 8, z), new THREE.Vector3(0, -1, 0), 0, 60);
  const hits = rc.intersectObjects(scene.children, true);
  if (!hits.length) return null;
  const h = hits[0], o = h.object;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return { y: +h.point.y.toFixed(2), prefab: o.userData.prefab || o.type,
           matName: m && m.name, color: m && m.color && m.color.getHexString(),
           matType: m && m.type, rough: m && m.roughness,
           mapSrc: m && m.map && m.map.image && m.map.image.src ? String(m.map.image.src).split('/').pop() : null };
};
window.__castRay = (ox, oy, oz, dx, dy, dz, far) =>
  castRay(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz).normalize(), far);

// ---------- post: bloom ----------
// [a7f] 移动端 composer RT 用 2x MSAA（DPR 2 本身就是超采样，4x 的多重采样
// 缓冲在手机上是白花显存）；桌面保持 4x。
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
  innerWidth, innerHeight, { samples: PERF.isMobileUA ? 2 : 4, type: THREE.HalfFloatType }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());
/* [深度修复 D1] 传入自定义 RT 时 EffectComposer 直接采用 RT.width/height（CSS 尺寸）
   当作 _width/_height，不会乘 renderer.getPixelRatio()；构造出的 renderTarget1/2
   只有 1280×720，而 DPR=1.5 的画布是 1920×1080 → 整条 bloom/OutputPass 链路
   以 2/3 分辨率渲染再拉伸（实测）。setPixelRatio 会按 _width×_dpr 重算 RT，
   并对所有 pass 调 setSize，一次把 RT 与 bloom 的 mip 链全部对齐。 */
composer.setPixelRatio(renderer.getPixelRatio());
applyPreset('day');    // [迈阿密] 日光为默认基调

/* [a7t] NOVA 自研光影管线：全档常开。旧 composer / UnrealBloomPass 实例保留为
   设置层挂点（__composer / __bloomPass），渲染统一交给 NOVA —— 手机上也有
   辉光 / 自适应曝光 / 接触遮蔽 / 深度边缘光 / FXAA，靠 1/4 分辨率与动态
   分辨率守帧。降级由 FrameGovernor 按实测帧时自动调 renderScale。 */
const NOVA = new NovaRenderer(renderer, {
  tier: novaTierFor(PERF.tier, PERF.isMobileUA),
  width: innerWidth, height: innerHeight, dpr: renderer.getPixelRatio(),
  /* [2026-11-26 手机端青蓝全屏修复] NovaRenderer 默认 fogColor=0x0a1830(深蓝黑)、
     rimColor=0x2ad4ff(亮青蓝)，而 setFogColor 从未被调用、预设切换也不同步 →
     全屏合成 pass 的 `col += uRimColor*rim` + 深蓝雾把整屏染成青蓝（关 Three 场景雾无效，
     因为是两套独立雾）。这里给中性灰褐雾 + 极弱中性边缘光。 */
  fogColor: 0xb9b4a8,
  rimColor: 0x8a8478,
});
// 中性边缘光压到极弱：亮描边是"全息蓝线框"观感的来源，白天真实城市不应有霓虹描边。
NOVA.mComposite.uniforms.uRimStrength.value = 0.035;
NOVA.mComposite.uniforms.uFogDensity.value = 0.35;
window.__nova = NOVA;
let POST_ON = true;

// ---------- loop ----------
const camDir = new THREE.Vector3();
let frames = 0, fpsT = performance.now(), fps = 0, lastFrameTs = performance.now();
let JS_MS = 0, _jsT = 0;
let menuT = 0;
const clock = new THREE.Clock();
// [2026-11-20 审查修复 F-09] fpsCap 实装：到点才渲染，未到点跳帧。
// 跳帧时 clock.getDelta() 不被调用 → 下一帧 dt 自动累积（上限 0.05s），物理速度不丢。
let _capAcc = 0;
// [运行时修复 R5] 切后台时 rAF 停摆，adaptTick 用墙钟间隔算瞬时帧率会读到
// 几十秒的间隔 → inst≈0 → EMA 被打到地板，回来后连续窗口判低帧一直降档
// （升档要 6 个窗口且 fps>45，锁 30 帧时几乎爬不回来）。恢复首帧整体重置。
let _bgReset = false;
addEventListener('visibilitychange', () => { if (document.hidden) _bgReset = true; }, { passive: true });
function animate() {
  requestAnimationFrame(animate);
  const _cap = +globalThis.__fpsCapLimit || 0;
  if (_cap > 0) {
    const _n = performance.now();
    if (_n - _capAcc < 1000 / _cap) return;
    _capAcc = _n;
  }
  /* [深度修复 D5] 跳帧时 clock.getDelta() 累积整段间隔，固定 0.05 上限会把
     低帧率 / 后台恢复后的游戏时间砍掉几十倍（实测 cap=2 时 rawDt=2.16s
     却只给物理 0.05s）。上限跟随帧率上限，正常 30/60 帧行为不变。 */
  const dtCap = _cap > 0 ? Math.max(0.05, 1.5 / _cap) : 0.1;
  const dt = Math.min(clock.getDelta(), dtCap);
  _jsT = performance.now();
  if (window.__urbanFull && _jsT - _ufAcc > 500) {
    _ufAcc = _jsT;
    _ufLast.copy(camera.position);
    window.__urbanFull.update(camera.position).catch(() => {});
  }
  globalThis.__phase = phase;   // [F-49] phase 探针全相位同步（menu/play/pause），game-shell 自动存档按它跳过菜单期

  if (phase === 'menu') {
    // aerial menu: slow orbit high above the dive drop point, sunset city
    // below — startGame spawns the diver right here, so the camera-rig blend
    // carries this exact shot straight into the plunge
    menuT += dt * 0.045;
    const cx = startPos.x + 25, cz = startPos.z - 2;    // == doDive drop point
    camera.position.set(cx + Math.sin(menuT) * 26, 398 + Math.sin(menuT * 0.6) * 7,
                        cz + Math.cos(menuT) * 26);
    camera.lookAt(cx - 130, 322, cz + 8);               // down the street, horizon high in frame
    for (const g in players) players[g].mixer?.update(dt);
  } else {
    rig.forward(camDir, input);
    if (phase === 'play') ctrl.update(dt, input, input.yaw, camDir);
    if (chosen) {
      chosen.update({
        dt,
        mode: ctrl.mode,
        pos: ctrl.pos,
        vel: ctrl.vel,
        anchor: ctrl.webOn ? ctrl.anchor : null,
        webOn: ctrl.webOn,
        webHand: ctrl.webHand,
        ropeSlack: ctrl.webOn
          ? Math.max(0, (ctrl.ropeLen - ctrl.pos.distanceTo(ctrl.anchor)) / Math.max(ctrl.ropeLen, 1))
          : 0,
      });
    }
    rig.update(dt, input, ctrl);
    // 夜间补光跟随玩家（略高于头顶，避免脚下出现刺眼光斑）
    if (fillLight.intensity > 0) fillLight.position.set(ctrl.pos.x, ctrl.pos.y + 2.4, ctrl.pos.z);
    if (window.__freeCam && window.__fcPos) {   // debug screenshots: let __tp/__lookAt own the camera
      camera.position.copy(window.__fcPos);
      if (window.__fcLook) camera.lookAt(...window.__fcLook);
    }
    // void rescue: only deep free-fall counts — the metro level sits at y≈-20…-26
    // and must stay walkable. Snap back to the last solid stand instead of a
    // forced restart (unpaved gaps exist at several levels).
    if (phase === 'play' && (ctrl.pos.y < -80 ||
        (ctrl.pos.y < -32 && ctrl.mode === 'air' && ctrl.vel.y < -18))) {
      if (ctrl.hasSafe) {
        console.log(`[rescue] from=(${ctrl.pos.x.toFixed(0)},${ctrl.pos.y.toFixed(0)},${ctrl.pos.z.toFixed(0)}) ` +
                    `to=(${ctrl.lastSafe.x.toFixed(0)},${ctrl.lastSafe.y.toFixed(1)},${ctrl.lastSafe.z.toFixed(0)})`);
        ctrl.rescueTo(ctrl.lastSafe);
        rig.initialized = false;
        const f = $('fade');
        f.style.opacity = '0.85';
        setTimeout(() => { f.style.opacity = '0'; }, 380);
        showMsg('已拉回附近的安全点', 1.6);
      } else { ctrl.rescueTo(window.__spawnAnchor || new THREE.Vector3(startPos.x + 25, 2, startPos.z - 2)); rig.initialized = false; showMsg('已拉回出生点', 1.6); }   // 无安全点兜底（2026-10-05 剥玩法：原 doDive 重跃已剥）
    }
    input.endFrame();

    // （速度/高度/状态 HUD 玩法遥测已随玩法层剥离，2026-10-05）
    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) $('msg').style.opacity = '0';
    }
  }

  skyDome.position.copy(camera.position);
  for (const c of cloudMeshes) c.quaternion.copy(camera.quaternion);   // clouds = billboards
  skyUniforms.uTime.value += dt;
  JS_MS = JS_MS * 0.8 + (performance.now() - _jsT) * 0.2;   // 纯逻辑耗时（不含绘制）
  // [LCR] 光追增强层每帧同步：相机/角色/光照 → 渲染到独立叠加 canvas。
  // 桥在降级时全部 no-op（零开销），既有光栅化渲染完全不受影响。
  if (window.__lcr && window.__lcr.active) {
    window.__lcr.syncCamera(camera);
    if (chosen && chosen.group) window.__lcr.syncPlayer(chosen.group);
    window.__lcr.render(dt);
  }
  NOVA.enabled = POST_ON;
  NOVA.render(scene, camera, performance.now() - lastFrameTs, dt);
  window.__drawStat = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  frames++;
  residencyPass();
  cullPass();
  CHUNK_STREAM.tick();   // [a7m] 增量窗口流送：跨格即触发 + 每帧毫秒预算时间切片
  globalThis.__mcSunFollow(camera.position);   // [a7f] 阴影相机跟随（零开销：castShadow 关时直接返回）
  paveTick();
  // 周期性回收「已上传到 GPU 的那份 CPU 副本」：原来只在全部加载完成后释放一次，
  // 手机上峰值就是 232 张 512² 画布 ≈ 230MB RAM 与 GPU 侧叠加 → 被系统杀掉。
  // [深度修复 D16] CULL_FRAME 只在 cullPass 的 400ms 节流里 +1，旧 mask=127
  // 意味着 128×400ms=51.2 秒才轮到一次回收；改为 16（≈6.4s）。
  if ((CULL_FRAME & 15) === 0) releaseTextureSources();
  if (_gcache.size) _gcache.clear();
  const now = performance.now();
  if (_bgReset) {
    _bgReset = false;
    lastFrameTs = now; ADAPT.last = now;
    ADAPT.lowWin = 0; ADAPT.highWin = 0; ADAPT.ema = 60;
    /* [深度修复 D4] fps 统计窗口同样必须重置。切后台期间 rAF 暂停、fpsT 不更新，
       恢复首帧会把整段后台时间算进分母而分子只有 1~2 帧 → fps 假 0，
       Q_WATCHDOG 把 fps=0 当最差状态，回来立刻误降画质。 */
    fpsT = now; frames = 0;
  }
  adaptTick(now - lastFrameTs);
  lastFrameTs = now;
  if (now - fpsT > 500) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
  $('fps').textContent = `${fps} fps · draw ${renderer.info.render.calls} · ${Math.round(JS_MS)}ms` +
    (RENDER_SCALE < 0.999 || CULL_SCALE < 0.999 ? ` · 自适应 ${RENDER_SCALE.toFixed(2)}×/${CULL_SCALE.toFixed(2)}×` : '') +
    ` · ${BUILD}`;
  renderer.info.reset();
}

// ---------- go ----------
// warm-up: upload every loaded texture to the GPU NOW — first-visibility
// uploads during the dive were a major source of fall judder
setTimeout(() => {
  for (const cache of [texCache, charTexCache, msCache]) {
    for (const k in cache) {
      const t = cache[k];
      if (t && t.image && t.image.width) renderer.initTexture(t);
    }
  }
}, 1200);

loadMsg('choose your runner');
const loaderEl = $('loader');
// show the menu only when the loading queue is REALLY drained (was a fixed 400 ms —
// on slow links users stared at "LOADING CHARACTERS…" with no idea of progress)
let menuShown = false;
function showMenu() {
  if (menuShown) return;
  menuShown = true;
  try { localStorage.setItem('megacity.boot.state', JSON.stringify({ t: Date.now(), ok: true, streak: 0 })); } catch (e) {}
  loadMsg('choose your runner');
  loaderEl.style.opacity = '0';
  setTimeout(() => { loaderEl.style.display = 'none'; }, 600);
  menuEl.classList.add('show');
  animate();
}
window.__showMenu = showMenu;
window.__phase = 'menu';   // 触摸层据此判断「已进入游戏」（菜单阶段不挂摇杆）

// 截帧钩子：渲染一帧后立刻把画布取成 dataURL（不留存缓冲也能取到）
window.__updateFov = () => { camera.aspect = camera.aspect; updateAdaptiveFov(camera); };
window.__mcCapture = (type = 'image/jpeg', q = 0.82) => {
  try {
    NOVA.enabled = POST_ON;
    // [2026-11-26 修复] 旧版引用外层不存在的 dt → 每次截图都抛 "dt is not defined"，
    // 探针/验收拿不到任何实拍帧。这里用帧时差兜底，并把异常细节带出来。
    const _now = performance.now();
    const _dt = 0.016;   // 定值帧时：截图走一次独立合成，不参与自适应调度
    NOVA.render(scene, camera, _now - lastFrameTs, _dt);
    return renderer.domElement.toDataURL(type, q);
  } catch (e) { return 'ERR:' + (e && e.message || e) + '|' + (e && e.stack || '').split('\n')[1]; }
};

// [a7f] 画质看门狗：a7f 给 mobile 档升了 Bloom/MSAA/阴影/DPR2（吃的是 a7e 区块
// 卸载省出来的显存）。真机性能千差万别，看门狗实测撑不住就逐级降档并记住，
// 流畅了再爬回来（滞回，同区块系统思路）：
//   stage 0 = 全开（bloom + 真实阴影 + DPR 2）
//   stage 1 = 关 bloom
//   stage 2 = 关阴影 + DPR 回 1.5（旧 mobile 画质）
//   stage 3 = 关后处理（= a7e 之前的旧 mobile 配置）
const Q_WATCHDOG = (() => {
  // [a7g] 手机档已回退成"无后处理"配置，没有可降的东西 → 看门狗只在真正开了
  // 后处理/阴影的档位上工作（目前仅当未来重新启用 mobile composer 时才有意义）。
  if (PERF.tier !== 'mobile' || !PERF.composer) return { stage: 0, apply: () => {} };
  const LS = 'megacity.qstage';
  let stage = Math.min(3, Math.max(0, parseInt(localStorage.getItem(LS) || '0', 10) || 0));
  let highWin = 0, booted = false;
  function applyStage(n) {
    stage = Math.min(3, Math.max(0, n));
    bloom.enabled = stage === 0;
    POST_ON = true; NOVA.enabled = true;
    if (stage >= 2 && NOVA.tier !== 2) NOVA.setTier(2);
    else if (stage === 0 && NOVA.tier === 2 && !PERF.isMobileUA) NOVA.setTier(0);
    const shOn = stage < 2 && REAL_SHADOWS;
    if (sun.castShadow !== shOn || renderer.shadowMap.enabled !== shOn) {
      sun.castShadow = shOn;
      renderer.shadowMap.enabled = shOn;
      scene.traverse(o => {                       // 阴影开关要重编译材质
        const ms = o.material;
        if (ms) (Array.isArray(ms) ? ms : [ms]).forEach(m => { m.needsUpdate = true; });
      });
    }
    PERF.dprCap = stage < 2 ? 2 : 1.5;
    applyRenderScale();
    try { localStorage.setItem(LS, String(stage)); } catch (e) {}
    window.__mcQStage = () => stage;
    console.log(`[quality] stage ${stage}（0=全开 1=无bloom 2=无阴影/DPR1.5 3=旧配置）`);
    return stage;
  }
  applyStage(stage);   // 启动即恢复上次的档位（不每次都从全开烧起）
  if (localStorage.getItem('megacity.qwatchdog') === 'off') {
    console.log('[quality] watchdog disabled（megacity.qwatchdog=off）');
    return { stage, apply: applyStage };
  }
  setInterval(() => {
    try {
      if (window.__phase !== 'play') return;            // 菜单鸟瞰很轻，不做依据
      if (!booted) { booted = true; return; }           // 首个窗口跳过（进场波动）
      // 注意：fps=0 不是"没数据"——帧间隔超过统计窗口时 fps 就记 0，
      // 这恰恰是最需要降档的状态，必须和 fps<23 一样处理。
      // [修复] 阈值跟随帧率上限：a7f 锁 30 帧后 fps 永远在 23~45 之间，
      // 旧写死的阈值会让看门狗既不降也不升（同 a7i 修 adaptTick 的坑）。
      const cap = Math.max(24, parseInt(globalThis.__fpsCapLimit, 10) || 60);
      const LOW = Math.min(23, cap * 0.78), HIGH = Math.min(45, cap * 0.90);
      if (fps < LOW) {
        highWin = 0;
        if (stage < 3) { applyStage(stage + 1); showMsg('自动调整画质以保证流畅', 1.8); }
      } else if (fps > HIGH) {
        if (++highWin >= 2 && stage > 0) { highWin = 0; applyStage(stage - 1); }
      } else highWin = 0;
    } catch (e) { console.error('[quality] watchdog 异常（已忽略，下轮继续）:', e); }
  }, 5000);
  return { stage, apply: applyStage };
})();
window.__mcQSetStage = n => Q_WATCHDOG.apply(n);    // 测试/调试：手动设档（同时持久化）
window.__mcPostOn = () => NOVA.enabled;
window.__novaTiers = NOVA_TIERS;
window.__novaAdr = ADR_STEPS;                  // 测试/调试：后处理运行时开关状态
window.__mcFpsProbe = () => fps;                    // 测试/调试：当前帧率采样值

/* [a7o] relief 独立看门狗 --------------------------------------------------
   Q_WATCHDOG 只在「mobile + composer 开着」时工作，而 mobile 档 composer
   恒为 false，等于永不生效；立体贴图不能把降级指望挂在一个死分支上。
   这里按实测 fps 做 0→1→2 逐级降级（L2 = 0 次额外采样），恢复后带滞回爬回。
   ?relief=0/1/2 手动锁定时不自动降，尊重用户口径。                     */
(() => {
  if (RELIEF.off || RELIEF.forced) return;
  let lowWin = 0, highWin = 0, booted = false;
  setInterval(() => {
    try {
      if (window.__phase !== 'play') return;         // 菜单鸟瞰不作依据
      if (!booted) { booted = true; return; }
      if (performance.now() < RELIEF.manualUntil) { lowWin = 0; highWin = 0; return; }
      const f = typeof window.__mcFpsProbe === 'function' ? window.__mcFpsProbe() : 60;
      const cap = Math.max(24, parseInt(globalThis.__fpsCapLimit, 10) || 60);
      const LOW = Math.min(22, cap * 0.72), HIGH = Math.min(44, cap * 0.90);
      if (f < LOW) {
        highWin = 0;
        if (++lowWin >= 2 && RELIEF.currentLevel < 2) {
          lowWin = 0;
          setGlobalReliefLevel(RELIEF.currentLevel + 1);
          console.log('[relief] 帧率不足 → 降级 L' + RELIEF.currentLevel);
        }
      } else if (f > HIGH) {
        lowWin = 0;
        if (++highWin >= 3 && RELIEF.currentLevel > RELIEF.baseLevel) {
          highWin = 0;
          setGlobalReliefLevel(RELIEF.currentLevel - 1);
          console.log('[relief] 帧率恢复 → 回升 L' + RELIEF.currentLevel);
        }
      } else { lowWin = 0; highWin = 0; }
    } catch (e) { /*  degrade 失败不该影响主循环 */ }
  }, 5000);
})();
if (loadDone) showMenu();   // the queue may have drained before showMenu existed
setTimeout(showMenu, 30000);   // fallback, never trap the user on the loader

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  updateAdaptiveFov(camera);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // [深度修复 D3] resize 时先把 composer 的缓存 DPR 对齐当前 renderer，
  // 再 setSize；否则自适应改过 DPR 后 resize 也修不错配。
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  NOVA.setSize(innerWidth, innerHeight, renderer.getPixelRatio());
});

// —— 执行位暴露点（清单 v1.2 B2/B5 · 预批口径）：纯窗口引用，不进任何业务逻辑 ——
// window.__input 已由源站原生 debug hooks 提供（L1275），不重复追加
window.__renderer = renderer;       // 设备适配层 DPR 降档挂点（renderer，L51 创建）
/* [2026-11-17a6b] 真机自证入口：地址后加 ?diag 就在左下角显示实时贴图档位统计。
   用户不用开控制台就能确认「1024/2048 到底有没有生效」，也方便我远程定位。 */
if (/[?&]diag?/.test(location.search)) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;padding:5px 8px;border-radius:6px;' +
    'background:rgba(0,0,0,.72);color:#8fe;font:10px/1.5 ui-monospace,monospace;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  setInterval(() => {
    const c = {};
    for (const [, v] of SRC_INFO) { const k = v.side || 0; c[k] = (c[k] || 0) + 1; }
    const keys = Object.keys(c).map(Number).sort((a, b) => b - a);
    el.textContent = `BUILD ${BUILD}\ncap ${TEX_MAX} · near ${TEX_NEAR_SIDE()} · mid ${TEX_MID_SIDE()}\n` +
      keys.map(k => `${k || '—'}px × ${c[k]}`).join('\n') +
      `\n驻留 ${Math.round(RESIDENT_BYTES / 1048576)}MB / ${VRAM_BUDGET_MB}MB`;
  }, 1000);
}
window.__texQ = () => ({
  active: TEX_ACTIVE, queue: TEX_QUEUE.length,
  next: TEX_QUEUE.slice(0, 6).map(j => ({ u: (j.url || '').split('/').pop(), side: j.maxSide })),
  ema: +ADAPT.ema.toFixed(1), lastStart: Math.round(performance.now() - LAST_TEX_START),
});
window.__texCfg = {                // 贴图分档实际取值（排查"改了没生效"用）
  budgetMB: VRAM_BUDGET_MB, texMax: TEX_MAX, safeMax: TEX_SAFE_MAX,
  near: TEX_NEAR_SIDE(), mid: TEX_MID_SIDE(), crashStreak: CRASH_STREAK,
  raw: (() => { try { return localStorage.getItem('megacity.settings.v1'); } catch { return null; } })(),
  probe: (() => { try { return localStorage.getItem('megacity.vrambudget'); } catch { return null; } })(),
};
window.__bloomPass = bloom;         // 设备适配层 bloom 开关挂点（UnrealBloomPass 实例，L1287）
window.__composer = composer;       // 设置层后处理开关挂点
window.__novaState = () => NOVA.state();   // 自研光影管线调试挂点

/* [a7t] 真实城市数据钩子：urban_intake.py 导出的 miami_buildings.json /
   miami_chunks.json 合并成 ./data/miami_urban.json 放进来即自动生效；
   文件缺失时静默跳过，零请求错误、零伪造城市。合成样例只服务 --selftest，
   绝不写进本目录。 */
tryMountUrban(scene, { radius: PERF.tier === 'mobileLow' ? 700 : 1300 })
  .then(async layer => {
    if (!layer) return;
    window.__miami = layer;
    // [LCR] 光追增强层：独立叠加 canvas + 桥接。无 WebGPU 时静默降级，
    // 光追 canvas 保持隐藏，现有光栅化画面 100% 不变。
    try {
      const rtCanvas = document.createElement('canvas');
      rtCanvas.id = 'lcrCanvas';
      rtCanvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;' +
        'pointer-events:none;z-index:1;display:none;';
      $('app').appendChild(rtCanvas);
      const bridge = new LCRBridge({
        scene, camera, canvas: rtCanvas,
        enabled: (new URLSearchParams(location.search).get('rt') !== '0'),
        onMode: (mode, reason) => {
          if (mode === 'webgpu-rt') rtCanvas.style.display = 'block';
          else rtCanvas.style.display = 'none';
          console.log('[LCR] mode =', mode, reason || '');
        },
      });
      layer.lcr = bridge;               // 区块 mount/unmount 自动同步到光追
      window.__lcr = bridge;            // 调试钩子
      await bridge.init();
      // 补挂：init 前可能已有驻留块，逐个补喂（降级时 no-op）
      if (bridge.active) {
        for (const [key, holder] of layer.meshByKey) {
          bridge.mount(key, holder, layer.byKey.get(key));
        }
        bridge.setLightingPreset(window.__presetName === 'night' ? 'night'
          : window.__presetName === 'dusk' ? 'dusk' : 'day');
      }
    } catch (e) {
      console.warn('[LCR] 增强层未挂载（已降级为纯光栅化）:', String(e && e.message || e).slice(0, 180));
    }
    // [a7t] 真实城市层光影 / 三级构建 / 街面距离场 / 规划信息层。
    // 规划数据缺失时模块内自降级为零补编，绝不生成合成城市。
    try {
      window.__novaUrban = await mountUrbanEnhancement(
        scene, camera, renderer, layer,
        { tier: novaTierFor(PERF.tier, PERF.isMobileUA), sun, fog: scene.fog,
          radius: PERF.tier === 'mobileLow' ? 900 : 1500,
          // [2026-11-26 街面被地形盖住修复] 主城自带地形是米色 CP_City_Ground，
          // 真实街面距离场平面放在 y=-0.04 会被地形整块遮掉（实拍：脚下全是
          // 米色空地、没有沥青/人行道）。这里把真实地形高度采样函数传给增强层，
          // 街面平面贴地形 + 6cm 抬升，既贴地又不打架。
          groundHeight: (x, z) => {
            const g = groundAt(x, z, 30, 0);
            return Number.isFinite(g) ? g : 0;
          } });
      // 真实贴图包到位后由外部显式绑定：工程 textures.json / relief 打包图
      // 走这一入口喂给真实城市立面；未绑定时纯 GLSL，零伪造材质归属。
      window.__novaUrbanBindFacade = (tex, opts) =>
        window.__novaUrban.setFacadeAtlas(tex, opts || { tiling: [0.25, 0.25] });
      window.__novaUrbanClearFacade = () => window.__novaUrban.clearFacadeAtlas();
      console.log('[novaUrban]', window.__novaUrban.state());
    } catch (e) {
      console.warn('[novaUrban] 强化层未挂载：', String(e && e.message || e).slice(0, 180));
    }
    console.log('[urban]', layer.state());
  })
  .catch(() => {});
/* [全量] 其余五层：地块/分区/水体轮廓、道路/运河、路口/许可、高程 */
let _ufAcc = 0; const _ufLast = new THREE.Vector3(1e9, 0, 1e9);
mountUrbanFull(scene, camera, { radius: PERF.tier === 'mobileLow' ? 900 : 1500 })
  .then(u => { window.__urbanFull = u; })
  .catch(e => console.warn('[urbanFull] 未挂载', String(e && e.message || e).slice(0, 120)));

window.__resTick = () => { RESIDENCY_FRAME = 0; residencyPass(); trimToBudget(true); return window.__mcResident; };
window.__texStat = () => {          // 显存占用自检：真实驻留字节与分辨率分布
  let bytes = 0, n = 0; const dims = {};
  for (const info of SRC_INFO.values()) {
    if (!info.resident) continue;
    n++; bytes += info.bytes;
    const w = info.side || (info.tex.image ? info.tex.image.width || 0 : 0);
    dims[w] = (dims[w] || 0) + 1;
  }
  return { residentTex: n, totalTex: SRC_INFO.size,
           mb: +(bytes / 1048576).toFixed(1),
           dims, budget: localStorage.getItem('megacity.vrambudget'),
           texMax: TEX_MAX, rc: window.__mcResident || null };
};
window.__scene = scene;
window.__THREE = THREE;   // 调试/自检：让外部脚本能做拾取与几何检查

/* [a7o] 立体贴图 / 三级 LOD 自检挂点（只读，不参与业务逻辑） ------------- */
window.__mcReliefSample = (n = 12) => {
  const out = [];
  for (const [name, m] of Object.entries(matCache)) {
    if (out.length >= n) break;
    out.push({
      name, level: m.userData.mcReliefLevel ?? null,
      attached: !!m.userData.mcReliefAttached,
      ready: !!m.userData.mcReliefReady,
      hasNormalMap: !!m.normalMap,
      reliefSide: m.normalMap?.image?.width || null,
      vertexColors: !!m.vertexColors,
      aoMap: !!m.aoMap, roughnessMap: !!m.roughnessMap, metalnessMap: !!m.metalnessMap,
      cacheKey: typeof m.customProgramCacheKey === 'function' ? m.customProgramCacheKey() : null,
    });
  }
  return out;
};
window.__mcLodStats = (n = 20) => {
  const out = [];
  for (const [name, b] of Object.entries(bakeCache)) {
    if (!b) continue;
    if (out.length >= n) break;
    out.push({ name, tiers: lodTierStats({ lods: b.lods }), stats: b.lodStats || null });
  }
  return out;
};
window.__mcShadingStats = () => ({
  relief: { ...RELIEF },
  level: RELIEF.currentLevel,
  extraSamples: RELIEF_LEVELS[RELIEF.currentLevel].extraSamples,
  maxSide: RELIEF_LEVELS[RELIEF.currentLevel].maxSide,
  pack: reliefStats(),
  lodUse: window.__mcLodUse || [0, 0, 0],
  programs: renderer.info.programs?.length ?? null,
  calls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  textures: renderer.info.memory.textures,
  geometries: renderer.info.memory.geometries,
});
window.__srcInfo = SRC_INFO;
window.__texDiag = () => {
  const s = window.__scene; let slab = null;
  s.traverse(o => { if (o.isMesh && o.position && Math.abs(o.position.y - (SAFETY_FLOOR_Y - 0.01)) < 1e-6) slab = o; });
  if (!slab) return { err: 'no slab' };
  const m = slab.material, t = m.map;
  const src = t && t.source;
  return {
    slabVisible: slab.visible,
    mapUuid: src ? src.uuid.slice(0,8) : '-',
    hasClones: src ? TEX_CLONES.has(src.uuid) : false,
    cloneCount: src ? (TEX_CLONES.get(src.uuid) || new Set()).size : 0,
    dataNull: !!(src && !src.data),
    url: src ? (SRC_INFO.get(src.uuid) || {}).url : '-',
    texVersion: t ? t.version : -1,
    sameSourceAsStreet: (() => {
      let n = 0;
      s.traverse(o => { if (o.isMesh && o.material && o.material.map && o.material.map.source === src) n++; });
      return n;
    })(),
  };
};             // 设置层雾效/环境挂点
window.__applyPreset = applyPreset; // 设置层昼夜预设挂点（night/day/dusk）

// —— 存档系统挂点（新增 · 只读/只写游戏状态，不改玩法逻辑）——
window.__mcSave = {
  capture() {
    return {
      pos: [+ctrl.pos.x.toFixed(2), +ctrl.pos.y.toFixed(2), +ctrl.pos.z.toFixed(2)],
      yaw: +input.yaw.toFixed(3),
      pitch: +input.pitch.toFixed(3),
      gender: selGender || 'man',
      mode: ctrl.mode,
      preset: presetName,
      score: 0,
    };
  },
  restore(st) {
    if (!st) return false;
    if (st.gender && st.gender !== selGender && players[st.gender]) {
      // 换角色：旧模型出场景，新模型入场景
      const old = players[selGender];
      const nw = players[st.gender];
      if (old) scene.remove(old.group);
      scene.add(nw.group);
      chosen = nw; selGender = st.gender;
      window.__player = chosen;
      selectGender(st.gender);
    }
    // [运行时修复 R7] 城市页已校验坐标，主城没有：导入 pos:[1,2] 这类残缺存档
    // 会把 z 写成 undefined，位置/相机行为不可预期。逐项校验有限数字。
    if (Array.isArray(st.pos) && st.pos.length >= 3 &&
        st.pos.slice(0, 3).every(n => typeof n === 'number' && Number.isFinite(n))) {
      ctrl.pos.set(st.pos[0], st.pos[1], st.pos[2]);
      ctrl.prevY = ctrl.pos.y;
      ctrl.vel.set(0, 0, 0);
      ctrl.mode = st.mode || 'ground';
      ctrl.airTime = 0;
    }
    if (typeof st.yaw === 'number' && Number.isFinite(st.yaw)) input.yaw = st.yaw;
    if (typeof st.pitch === 'number' && Number.isFinite(st.pitch)) input.pitch = st.pitch;
    rig.initialized = false;
    if (st.preset && typeof applyPreset === 'function') applyPreset(st.preset);
    return true;
  },
};


/* ---------- [2026-11-21a7d] RAM 水位监控（内存治本的最后防线） ----------
   iOS 的 performance.memory 不可用（确定性手段靠上面的「上传即置换」），
   Android Chrome 可以直接读堆：接近危险水位时主动压显存预算 + 全量置换
   CPU 副本，赶在系统杀进程 / 回收 WebGL 上下文之前自己降级。 */
const RAM_WARN_MB = 340;
setInterval(() => {
  try {
    const mem = performance.memory;
    if (!mem || mem.usedJSHeapSize < RAM_WARN_MB * 1048576) return;
    if (VRAM_BUDGET_MB) trimToBudget(true);
    for (const info of SRC_INFO.values()) swapOutCpuCopy(info);
    console.warn(`[mc] RAM 水位 ${Math.round(mem.usedJSHeapSize / 1048576)}MB → 已触发主动降级`);
  } catch (_) {}
}, 3000);
