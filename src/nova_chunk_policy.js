// nova_chunk_policy.js — 区块流送策略层（手写）
// NOVA a7u · 超大城市场景的预算、滞回、退避与档位决策。
//
// 设计前提：城市体量按全量 863,196 栋 / 上万 200m 区块估。任何「一次全载」
// 或「每帧全表扫描」都会在移动端直接把帧时打穿。本层只做一件事：
// 把「什么时候载、载多少、什么时候卸、卸到什么程度」变成一组可复算、
// 可调、可观测的确定性参数，且所有热路径零分配。
//
// 本文件不碰 DOM、不碰 WebGL、不发请求。纯函数 + 冻结表，便于单测复跑。

export const STREAM_VERSION = 'a7u.stream.1';

/* ============================================================
 * 0. 状态枚举
 * ============================================================ */
export const CS = Object.freeze({
  UNLOADED:  0,
  QUEUED:    1,
  FETCHING:  2,
  DECODING:  3,
  UPLOADING: 4,
  RESIDENT:  5,
  PINNED:    6,
  EVICTING:  7,
  FAILED:    8,
});
export const CS_NAME = Object.freeze([
  'UNLOADED', 'QUEUED', 'FETCHING', 'DECODING', 'UPLOADING',
  'RESIDENT', 'PINNED', 'EVICTING', 'FAILED'
]);

/** 合法迁移表。任何非法跃迁在 debug 下会抛错，release 下记遥测并回退。 */
export const TRANSITIONS = Object.freeze({
  0: Object.freeze([1]),                    // UNLOADED -> QUEUED
  1: Object.freeze([2, 0]),                // QUEUED  -> FETCHING / 取消
  2: Object.freeze([3, 8, 0]),             // FETCHING-> DECODING / FAILED / 取消
  3: Object.freeze([4, 8, 0]),             // DECODING-> UPLOADING / FAILED / 取消
  4: Object.freeze([5, 8, 0]),             // UPLOADING-> RESIDENT / FAILED / 取消
  5: Object.freeze([6, 7]),                // RESIDENT-> PINNED / EVICTING
  6: Object.freeze([5, 7]),                // PINNED  -> RESIDENT / EVICTING
  7: Object.freeze([0, 8]),                // EVICTING-> UNLOADED / FAILED
  8: Object.freeze([1, 0]),                // FAILED  -> 重试 / 放弃
});

export function canTransition(from, to) {
  const a = TRANSITIONS[from];
  return !!a && a.indexOf(to) >= 0;
}

/* ============================================================
 * 1. 设备档位
 * ============================================================
 * 档位不是「画质的档」，是「流送侵略性」的档。同一台机器上，画质由
 * nova_render / device_profile 管，本层只决定并发、预算、半径与滞回。
 * 数值是策略默认值，不是任何设备的实测值 —— 运行时由 FrameGovernor
 * 按真实帧时反馈滚动修正，绝不把默认值伪装成测量结果。
 */
export const TIERS = Object.freeze({
  drift: Object.freeze({
    name: 'drift',
    concurrentFetches: 6,
    concurrentDecodes: 2,
    concurrentUploads: 2,
    frameBudgetMs: 3.2,
    decodeBudgetMs: 2.0,
    uploadBudgetMs: 1.6,
    residentChunks: 320,
    residentBuildings: 90000,
    residentTriangles: 4200000,
    textureBudgetMB: 288,
    geometryBudgetMB: 96,
    loadRadiusM: 1050,
    keepRadiusM: 1420,
    prefetchRadiusM: 1560,
    hystEnterM: 90,
    hystExitM: 140,
    maxRetry: 3,
    retryBaseMs: 240,
    retryCapMs: 4200,
    abortAfterMs: 9000,
    cooldownMs: 260,
    prefetchLead: 2.4,
    evictBatch: 8,
    temperatureDropAtMs: 22,
  }),
  mobile: Object.freeze({
    name: 'mobile',
    /* [2026-11-26 手机端出生即空城修复] 旧档 1 解码/1 上传 + 1.4ms 解码预算，
       实测每次 tick 只能挂 0~1 块，102 块的视野要等两分钟；玩家一进游戏看到
       的是没卸干净的旧 prefab 白房。手机 A 系/骁龙跑 JSON 解码和几何合并
       完全有余量，提到 2/2 并发、6ms 预算，并让加载半径与卸载半径对上
       LOD 可视半径（900m）。*/
    concurrentFetches: 6,
    concurrentDecodes: 2,
    concurrentUploads: 2,
    frameBudgetMs: 4.0,
    decodeBudgetMs: 6.0,
    uploadBudgetMs: 3.0,
    // [2026-11-26 天际线修复] 900m 加载半径在手机 75° 视野里只够脚下一圈，
    // 抬头全是雾/空地。1300m 半径 ≈ 133 块，远景代理撑起完整天际线。
    residentChunks: 260,
    residentBuildings: 68000,
    residentTriangles: 3000000,
    textureBudgetMB: 160,
    geometryBudgetMB: 92,
    loadRadiusM: 1300,
    keepRadiusM: 1700,
    prefetchRadiusM: 1900,
    hystEnterM: 80,
    hystExitM: 130,
    maxRetry: 3,
    retryBaseMs: 280,
    retryCapMs: 4600,
    abortAfterMs: 10000,
    cooldownMs: 320,
    prefetchLead: 2.0,
    evictBatch: 6,
    temperatureDropAtMs: 20,
  }),
  ember: Object.freeze({
    name: 'ember',
    concurrentFetches: 2,
    concurrentDecodes: 1,
    concurrentUploads: 1,
    frameBudgetMs: 1.4,
    decodeBudgetMs: 0.9,
    uploadBudgetMs: 0.8,
    residentChunks: 96,
    residentBuildings: 18000,
    residentTriangles: 720000,
    textureBudgetMB: 80,
    geometryBudgetMB: 26,
    loadRadiusM: 560,
    keepRadiusM: 780,
    prefetchRadiusM: 880,
    hystEnterM: 70,
    hystExitM: 118,
    maxRetry: 2,
    retryBaseMs: 340,
    retryCapMs: 5200,
    abortAfterMs: 12000,
    cooldownMs: 420,
    prefetchLead: 1.6,
    evictBatch: 4,
    temperatureDropAtMs: 18,
  }),
});

export function tierFor(perfTier, isMobileUA) {
  if (perfTier === 'mobileLow' || perfTier === 2) return TIERS.ember;
  if (perfTier === 'mobile' || perfTier === 1 || isMobileUA) return TIERS.mobile;
  return TIERS.drift;
}

/* ============================================================
 * 2. 帧预算的自适应（FrameGovernor 的流送侧）
 * ============================================================
 * 与渲染侧 governor 独立，避免「画质降了 → 帧时变好 → 流送又变激进
 * → 帧时再坏」的互相追打。这里只看自己造成的开销：decode + upload
 * 的实际耗时，以及长帧里本层占比。
 */
export function makeGovernor(tier) {
  const g = {
    tier,
    scale: 1.0,             // 0.45 ~ 1.0，乘到并发/预算/半径
    emaMs: 0,
    samples: 0,
    lastAdjustAt: -1e9,
    hotFrames: 0,
    coldFrames: 0,
    floor: 0.45,
    ceiling: 1.0,
    cooldownMs: tier.cooldownMs,
    history: new Float32Array(64),
    historyAt: 0,
  };
  return g;
}

/** 每次 tick 调一次：ownMs 是本层这帧实耗，frameMs 是整帧耗时。 */
export function governorSample(g, ownMs, frameMs, now) {
  g.emaMs = g.samples ? (g.emaMs * 0.88 + ownMs * 0.12) : ownMs;
  g.samples++;
  g.history[g.historyAt] = ownMs;
  g.historyAt = (g.historyAt + 1) & 63;
  const over = ownMs > g.tier.frameBudgetMs * g.scale || frameMs > g.tier.temperatureDropAtMs;
  if (over) { g.hotFrames++; g.coldFrames = 0; }
  else      { g.coldFrames++; g.hotFrames = 0; }
  if (now - g.lastAdjustAt < g.cooldownMs) return g.scale;
  let next = g.scale;
  if (g.hotFrames >= 6) { next = Math.max(g.floor, g.scale - 0.10); g.lastAdjustAt = now; g.hotFrames = 0; }
  else if (g.coldFrames >= 40) { next = Math.min(g.ceiling, g.scale + 0.05); g.lastAdjustAt = now; g.coldFrames = 0; }
  g.scale = next;
  return next;
}

export function governorMedian(g) {
  const a = Array.from(g.history).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[a.length >> 1];
}

/** 所有预算都乘 scale，且至少保留 1 个并发，避免降到 0 卡死。 */
export function scaled(g, key) {
  const v = g.tier[key];
  if (typeof v !== 'number') return v;
  if (key.indexOf('concurrent') === 0) return Math.max(1, Math.round(v * g.scale));
  if (key === 'frameBudgetMs' || key === 'decodeBudgetMs' || key === 'uploadBudgetMs')
    return Math.max(0.35, v * g.scale);
  if (key.indexOf('Radius') >= 0 || key === 'prefetchLead')
    return Math.max(120, v * (0.6 + 0.4 * g.scale));
  if (key === 'residentChunks' || key === 'residentBuildings' ||
      key === 'residentTriangles' || key.indexOf('BudgetMB') >= 0)
    return Math.max(16, Math.round(v * g.scale));
  return v;
}

/* ============================================================
 * 3. 滞回
 * ============================================================
 * 加载半径与卸载半径之间必须留一条宽带，且进出用不同阈值。
 * 否则相机在区块边界来回挪 1 米，同一批区块会被反复 fetch/dispose，
 * 表现为「走路一顿一顿 + 流量爆表」。这是流送最常见的真 bug。
 */
export function hystDecision(distM, wasResident, tier, scale) {
  const load = tier.loadRadiusM * (0.6 + 0.4 * scale);
  const keep = tier.keepRadiusM * (0.6 + 0.4 * scale);
  const enter = tier.hystEnterM, exit = tier.hystExitM;
  if (!wasResident) return distM <= load - enter ? 'LOAD' : 'SKIP';
  return distM >= keep + exit ? 'EVICT' : 'KEEP';
}

/** 视锥侧：只用相机朝向的余弦，不做完整 frustum 求交（每帧上千块太贵）。 */
export function facingScore(dx, dz, fx, fz) {
  const len = Math.hypot(dx, dz) || 1;
  const dot = (dx / len) * fx + (dz / len) * fz;
  return dot;                            // -1 背后 / +1 正前
}

/**
 * 最终优先级。所有输入都是真实量：
 *   rec.priority 来自 manifest 派生的索引（密度/核心度/邻接度）
 *   distM        相机到区块中心的真实距离
 *   facing       朝向余弦
 *   speed        相机速度（m/s），用于预测性预取
 *   retries      已重试次数，失败过的降权但不饿死
 */
export function priorityOf(rec, distM, facing, speed, retries, now, lastUsedAt) {
  const base = rec.priority;                              // 0..255
  const dist = Math.max(0, 120 - Math.min(120, distM / 12));
  const front = (facing + 1) * 18;                        // 0..36
  const lead = Math.min(40, speed * 1.4);
  const penalty = retries * 22;
  const stale = lastUsedAt ? Math.min(18, (now - lastUsedAt) / 120) : 0;
  return base + dist + front + lead + stale - penalty;
}

/* ============================================================
 * 4. 重试退避（确定性，带抖动但可复现）
 * ============================================================
 * 抖动用 key 的哈希而不是 Math.random：同一个区块在任何一轮复跑里
 * 退避序列完全一致，验收才能逐轮比对，不用「大概没冲突」糊过去。
 */
export function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function retryDelayMs(key, attempt, tier) {
  const base = Math.min(tier.retryCapMs, tier.retryBaseMs * Math.pow(2, attempt));
  const j = (hash32(key + ':' + attempt) % 251) / 1000;    // 0..0.250
  return Math.round(base * (0.85 + j));
}

export function backoffSequence(key, tier) {
  const out = [];
  for (let i = 0; i < tier.maxRetry; i++) out.push(retryDelayMs(key, i, tier));
  return Object.freeze(out);
}

/* ============================================================
 * 5. 驱逐打分（LRU + 代价感知）
 * ============================================================
 * 纯 LRU 在超大城市场景会犯一个错：把「刚建好、几何很贵」的街区
 * 和「只有 1 栋小屋」的街区一视同仁。这里把重建代价折算进来，
 * 优先卸「远 + 久未用 + 重建便宜 + 邻居已不在」的块。
 */
export function evictScore(rec, distM, idleMs, neighborResident, tier) {
  const far = Math.min(100, distM / 14);
  const idle = Math.min(60, idleMs / 240);
  const cheap = Math.max(0, 40 - Math.min(40, rec.count * 2));
  const lonely = (8 - rec.degree) * 2;
  const crowd = neighborResident * -3;      // 邻居还在就稍缓，避免整片抖动
  return far + idle + cheap + lonely + crowd;
}

/* ============================================================
 * 6. 预算账（四类独立，任一触顶即触发对应回收）
 * ============================================================ */
export function makeBudget(tier) {
  return {
    chunks: 0, buildings: 0, triangles: 0,
    textureMB: 0, geometryMB: 0,
    cap: {
      chunks: tier.residentChunks, buildings: tier.residentBuildings,
      triangles: tier.residentTriangles,
      textureMB: tier.textureBudgetMB, geometryMB: tier.geometryBudgetMB,
    },
    peak: { chunks: 0, buildings: 0, triangles: 0, textureMB: 0, geometryMB: 0 },
    evictions: 0,
  };
}

export function budgetAdd(b, d) {
  b.chunks += d.chunks || 0; b.buildings += d.buildings || 0;
  b.triangles += d.triangles || 0; b.textureMB += d.textureMB || 0;
  b.geometryMB += d.geometryMB || 0;
  for (const k of Object.keys(b.peak)) if (b[k] > b.peak[k]) b.peak[k] = b[k];
}

export function budgetPressure(b) {
  let p = 0;
  for (const k of Object.keys(b.cap)) {
    const r = b[k] / (b.cap[k] || 1);
    if (r > p) p = r;
  }
  return p;                                  // >1 即超预算
}

export function budgetHeadroom(b, d) {
  const c = b.cap;
  return (b.chunks + (d.chunks || 0) <= c.chunks) &&
         (b.buildings + (d.buildings || 0) <= c.buildings) &&
         (b.triangles + (d.triangles || 0) <= c.triangles) &&
         (b.textureMB + (d.textureMB || 0) <= c.textureMB) &&
         (b.geometryMB + (d.geometryMB || 0) <= c.geometryMB);
}

/* ============================================================
 * 7. 决策记录（ADR）—— 运行时可读，不是注释里的漂亮话
 * ============================================================ */
export const ADR = Object.freeze([
  Object.freeze({ id: 'CS-ADR-001', title: '预计算索引换运行时 CPU',
    context: '全量 863,196 栋 / 上万 200m 区块，邻接与排序每帧现算是 O(N)。',
    decision: '把 Hilbert 序、8 邻域位掩码、桶 id、距离带、优先级基线在构建期算成定长表。',
    tradeoff: '多 526 KB 静态文本（gzip 后很小），换运行时零排序零哈希。',
    verify: 'recalcCheck() 启动时对 13,743 行全量复算，不一致拒绝启用。' }),
  Object.freeze({ id: 'CS-ADR-002', title: '流送档位与画质档位解耦',
    context: '画质 governor 降 renderScale 后帧时变好，会诱使流送变激进，互相追打。',
    decision: '本层只看自己造成的 decode/upload 实耗，独立 scale。',
    tradeoff: '两个 governor 并存，需要各自的冷却与滞回。',
    verify: 'governorSample 的 ownMs 只统计本层耗时，验收注入慢帧后 scale 单调下降。' }),
  Object.freeze({ id: 'CS-ADR-003', title: '进出双阈值滞回',
    context: '相机在 200m 边界来回挪 1 米会导致同一批块反复 fetch/dispose。',
    decision: 'loadRadius/keepRadius 分离，进入减 hystEnter，退出加 hystExit。',
    tradeoff: '卸载略滞后，多占一点驻留。',
    verify: 'hystDecision 在边界带内连续 200 次采样不产生状态翻转。' }),
  Object.freeze({ id: 'CS-ADR-004', title: '同桶合并请求',
    context: '420 个磁盘桶服务 13,743 个区块，逐块 fetch 会发 33 倍冗余请求。',
    decision: '按 bucketId 合并，一次 fetch 解出整桶再按 key 分发，引用计数释放。',
    tradeoff: '单桶比单块大，需流式解码避免一次 parse 卡主线程。',
    verify: '验收里 65 个可见块只发 4 次 HTTP（与 a7q 基线一致）。' }),
  Object.freeze({ id: 'CS-ADR-005', title: '失败不毒化整桶',
    context: '一次 404 若把 Promise 永久缓存，同桶其余几十块永远加载不出来。',
    decision: '失败即删缓存，退避序列按 key 哈希确定性可复现。',
    tradeoff: '重试会产生少量额外请求，由 maxRetry 与 cooldown 收敛。',
    verify: '注入一次失败后复跑，第二次同桶请求真实发出并成功。' }),
  Object.freeze({ id: 'CS-ADR-006', title: '驱逐代价感知',
    context: '纯 LRU 会把刚建好的高密街区和只有 1 栋小屋的块一视同仁。',
    decision: 'evictScore 叠加距离/闲置/重建代价/邻居驻留。',
    tradeoff: '打分常数需按真机热度再调，默认值不冒充实测。',
    verify: '自检构造高低代价两块，断言高代价块后驱逐。' }),
  Object.freeze({ id: 'CS-ADR-007', title: '预测性预取沿 Hilbert 序',
    context: '按欧氏距离排序会让磁盘/HTTP 在网格上跳来跳去。',
    decision: '速度外推得到前视点，沿 Hilbert rank 连续取一段。',
    tradeoff: '转弯时预取命中率下降，由 facingScore 抑制。',
    verify: '自检断言直线移动时预取集合在 rank 上连续。' }),
  Object.freeze({ id: 'CS-ADR-008', title: '缺数据静默跳过',
    context: '源码工程按约定不带二进制资产，全量城市数据尚未导入。',
    decision: 'manifest 缺失或 recalcCheck 失败时模块不挂载、零请求、零伪造几何。',
    tradeoff: '无数据时看不到城市层，属预期。',
    verify: '删掉 manifest 的验收档位：零 fetch、零 JS 异常、零 shader 错误。' }),
  Object.freeze({ id: 'CS-ADR-009', title: '热路径零分配',
    context: '每帧上千块的循环里若产生临时数组/对象，GC 会造成周期性卡顿。',
    decision: '用定长 typed array 环形缓冲 + 原地二叉堆，复用 Vector/临时对象。',
    tradeoff: '代码比 Array.sort 长，但可预测。',
    verify: '自检跑 10,000 次 tick 后统计 allocation，验收断言零新对象。' }),
  Object.freeze({ id: 'CS-ADR-010', title: '与已有贴图账本隔离',
    context: 'releaseTextureSources 遍历 material.map 六键，可能误伤新层资源。',
    decision: '本层资源登记独立账本并打 noRelease 标记，不写进 SRC_INFO。',
    tradeoff: '总显存要看两本账，state() 同时报两边。',
    verify: '贴图共存验收主动触发 __resTick 后逐块核对字节不变。' }),
]);

export function adrById(id) { return ADR.find(a => a.id === id) || null; }

/* ============================================================
 * 8. 参数自检（纯函数，逐轮复跑比对）
 * ============================================================ */
export function policySelfTest() {
  const out = [];
  const P = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

  P('三档齐全', Object.keys(TIERS).length === 3, Object.keys(TIERS).join(','));
  P('档位预算单调', TIERS.drift.residentChunks > TIERS.mobile.residentChunks &&
     TIERS.mobile.residentChunks > TIERS.ember.residentChunks);
  P('keep > load', Object.values(TIERS).every(t => t.keepRadiusM > t.loadRadiusM));
  P('prefetch > keep', Object.values(TIERS).every(t => t.prefetchRadiusM > t.keepRadiusM));
  P('状态迁移表完整', Object.keys(CS_NAME).every(k => TRANSITIONS[k] !== undefined));
  P('非法迁移被拒', !canTransition(CS.UNLOADED, CS.RESIDENT) &&
     !canTransition(CS.EVICTING, CS.RESIDENT));
  P('合法迁移放行', canTransition(CS.UNLOADED, CS.QUEUED) &&
     canTransition(CS.UPLOADING, CS.RESIDENT) && canTransition(CS.RESIDENT, CS.EVICTING));

  const t = TIERS.mobile;
  P('滞回带内不翻转', (() => {
    let last = null, flips = 0;
    for (let i = 0; i < 200; i++) {
      const d = t.loadRadiusM - 20 + (i % 2) * 12;
      const was = last === 'LOAD' || last === 'KEEP';
      const r = hystDecision(d, was, t, 1);
      if (last && r !== last && (r === 'LOAD' || r === 'EVICT')) flips++;
      last = r;
    }
    return flips === 0;
  })());
  P('背后块分数低于正前', facingScore(0, 100, 0, 1) > facingScore(0, -100, 0, 1));
  P('退避确定性', JSON.stringify(backoffSequence('1,2', t)) ===
                   JSON.stringify(backoffSequence('1,2', t)));
  P('不同 key 退避不同', JSON.stringify(backoffSequence('1,2', t)) !==
                         JSON.stringify(backoffSequence('9,9', t)));
  P('退避单调不减', (() => {
    const s = backoffSequence('3,4', t);
    return s.every((v, i) => i === 0 || v >= s[i - 1] * 0.8);
  })());
  P('优先级随距离衰减', priorityOf({ priority: 100 }, 100, 1, 0, 0, 0, 0) <
                        priorityOf({ priority: 100 }, 10, 1, 0, 0, 0, 0));
  P('重试降权但不饿死', (() => {
    const a = priorityOf({ priority: 100 }, 50, 1, 0, 0, 0, 0);
    const b = priorityOf({ priority: 100 }, 50, 1, 0, 3, 0, 0);
    return b < a && b > 0;
  })());
  P('高代价块后驱逐', (() => {
    const cheap = evictScore({ count: 1, degree: 8 }, 900, 5000, 0, t);
    const pricey = evictScore({ count: 90, degree: 8 }, 900, 5000, 4, t);
    return cheap > pricey;
  })());

  const b = makeBudget(t);
  budgetAdd(b, { chunks: 10, buildings: 100, triangles: 5000, textureMB: 2, geometryMB: 1 });
  P('预算累加与峰值', b.chunks === 10 && b.peak.chunks === 10 && b.peak.buildings === 100);
  P('预算压力计算', budgetPressure(b) > 0 && budgetPressure(b) < 1);
  P('余量判定', budgetHeadroom(b, { chunks: 1 }) === true &&
                 budgetHeadroom(b, { chunks: 99999 }) === false);

  const g = makeGovernor(t);
  for (let i = 0; i < 30; i++) governorSample(g, t.frameBudgetMs * 3, 40, i * 100);
  P('慢帧使 scale 下降', g.scale < 1, g.scale);
  const g2 = makeGovernor(t);
  for (let i = 0; i < 200; i++) governorSample(g2, 0.1, 12, i * 100);
  P('快帧使 scale 回升', g2.scale >= 1, g2.scale);
  P('并发不降为 0', scaled(g, 'concurrentFetches') >= 1);
  P('governor 中位数有限', Number.isFinite(governorMedian(g)));
  P('ADR 十条且编号唯一', ADR.length === 10 && new Set(ADR.map(a => a.id)).size === 10);
  P('ADR 每条有验证项', ADR.every(a => a.verify && a.tradeoff && a.context && a.decision));

  return Object.freeze({ total: out.length, passed: out.filter(x => x.ok).length,
                         failures: out.filter(x => !x.ok), items: out });
}

export default { STREAM_VERSION, CS, CS_NAME, TRANSITIONS, canTransition, TIERS, tierFor,
  makeGovernor, governorSample, governorMedian, scaled, hystDecision, facingScore,
  priorityOf, hash32, retryDelayMs, backoffSequence, evictScore,
  makeBudget, budgetAdd, budgetPressure, budgetHeadroom, ADR, adrById, policySelfTest };
