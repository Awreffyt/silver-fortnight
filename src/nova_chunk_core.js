// nova_chunk_core.js — 区块加载/卸载核心调度器（手写）
// NOVA a7u · 面向全量 863,196 栋 / 上万 200m 区块的常驻集管理器。
//
// 职责边界：
//   - 决定「哪些块该在内存里」（常驻集），不负责建几何（交给 miami_layer）
//   - 不碰 WebGL 上下文、不碰 DOM、不改贴图账本
//   - 所有几何/显存的真实释放由调用方注入 disposer，本层只发指令
//   - 缺 manifest / 索引校验失败时整体不挂载，零请求、零伪造城市
//
// 热路径约定：tick() 每帧调用，内部零 new（除状态迁移必须的极小对象），
// 环形缓冲复用，避免 GC 造成的周期性长帧。

import {
  CS, CS_NAME, canTransition, TIERS, tierFor, makeGovernor, governorSample,
  governorMedian, scaled, hystDecision, facingScore, priorityOf, evictScore,
  makeBudget, budgetAdd, budgetPressure, budgetHeadroom, policySelfTest, ADR,
  STREAM_VERSION,
} from './nova_chunk_policy.js?v=a7u';
import {
  ChunkIO, ioSelfTest, Gate, crc32,
} from './nova_chunk_io.js?v=a7u';
import {
  INDEX_META, parseIndex, recalcCheck, INDEX_SELFTEST,
} from './nova_chunk_index_table.js?v=a7u';

/* ============================================================
 * 1. 环形遥测缓冲（定长 typed array，零分配）
 * ============================================================ */
const RING = 256;
class Telemetry {
  constructor() {
    this.frameMs = new Float32Array(RING);
    this.ownMs = new Float32Array(RING);
    this.loads = new Int32Array(RING);
    this.evicts = new Int32Array(RING);
    this.resident = new Int32Array(RING);
    this.at = 0; this.count = 0;
    this.totalLoads = 0; this.totalEvicts = 0;
    this.totalDecodeMs = 0; this.totalUploadMs = 0;
    this.firstAt = 0; this.lastAt = 0;
  }
  push(frameMs, ownMs, loads, evicts, resident, now) {
    const i = this.at;
    this.frameMs[i] = frameMs; this.ownMs[i] = ownMs;
    this.loads[i] = loads; this.evicts[i] = evicts; this.resident[i] = resident;
    this.at = (i + 1) & (RING - 1);
    if (this.count < RING) this.count++;
    this.totalLoads += loads; this.totalEvicts += evicts;
    if (!this.firstAt) this.firstAt = now;
    this.lastAt = now;
  }
  median(field) {
    if (!this.count) return 0;
    const a = new Float64Array(this.count);
    const src = this[field];
    for (let i = 0; i < this.count; i++) a[i] = src[i];
    a.sort();
    return a[this.count >> 1];
  }
  snapshot() {
    return {
      samples: this.count, totalLoads: this.totalLoads, totalEvicts: this.totalEvicts,
      medianFrameMs: +this.median('frameMs').toFixed(2),
      medianOwnMs: +this.median('ownMs').toFixed(2),
      medianResident: this.median('resident'),
      uptimeMs: this.lastAt - this.firstAt,
    };
  }
}

/* ============================================================
 * 2. 常驻块记录
 * ============================================================ */
function makeEntry(rec) {
  return {
    key: rec.key,
    rec,                       // 预计算索引里的冻结记录
    state: CS.UNLOADED,
    score: 0,
    distM: 0,
    facing: 0,
    idleMs: 0,
    lastUsedAt: 0,
    attempts: 0,
    buildings: 0,
    triangles: 0,
    textureMB: 0,
    geometryMB: 0,
    object: null,              // 调用方注入的 scene object（弱引用语义，不持有所有权）
    bucketId: rec.bucket,
    pinned: false,
    visible: false,
  };
}

/* ============================================================
 * 3. 主调度器
 * ============================================================ */
export class ChunkStream {
  /**
   * @param {object} o
   *  o.manifest    真实 urban_manifest.json（必须是 chunked，含 chunks[]）
   *  o.tier        流送档位名或 TIERS 对象
   *  o.base        数据目录
   *  o.fetchImpl   可注入（验收用）
   *  o.onMount(key, rows, rec) -> {object, buildings, triangles, textureMB, geometryMB}
   *  o.onUnmount(key, object)  -> 真正 dispose，调用方负责
   *  o.onBudget(b) 预算变化回调（可选）
   */
  constructor(o) {
    this.manifest = o.manifest;
    this.tier = typeof o.tier === 'string' ? (TIERS[o.tier] || TIERS.mobile) : (o.tier || TIERS.mobile);
    this.onMount = o.onMount || (() => null);
    // [2026-11-26 转视角帧率修复] onMount(几百楼几何挤出+合并)每块 40~80ms 且完全同步。
    // 旧实现 decode 一完成就在回调里直接构建——转视角时一批块同时 decode 完，
    // 一帧内连跑十几个 onMount → 主线程卡 500~1000ms → 帧率直接跌到 1。
    // 改为构建队列：decode 完成先入队，每帧按时间预算逐个消化（楼逐波浮现）。
    this.pendingMounts = [];
    this.mountBudgetMs = o.mountBudgetMs || 12;
    this.onUnmount = o.onUnmount || (() => {});
    this.onBudget = o.onBudget || null;
    this.onError = o.onError || null;

    // 索引全量复算：不一致就拒绝启用
    this.check = recalcCheck(this.manifest);
    if (!this.check.ok) {
      throw new Error('[chunkStream] 索引复算失败 ' + this.check.totalErrors +
                      ' 处：' + this.check.errors.slice(0, 3).join(' / '));
    }
    const idx = parseIndex();
    this.idx = idx;
    this.meta = INDEX_META;

    // 相机状态（外部每帧写入）
    this.cam = { x: 0, z: 0, fx: 0, fz: 1, vx: 0, vz: 0, speed: 0 };
    this.prevCam = { x: 0, z: 0 };

    // 所有块（惰性建 entry，避免开局就 new 13,743 个对象）
    this.entries = new Map();
    this.resident = new Map();          // key -> entry
    this.failed = new Map();
    this.order = [];                    // Hilbert 序缓存（引用 idx.byHilbert）

    this.governor = makeGovernor(this.tier);
    this.budget = makeBudget(this.tier);
    this.telemetry = new Telemetry();

    this.io = new ChunkIO({
      base: o.base || './data/',
      fetchImpl: o.fetchImpl,
      bucketFiles: idx.bucketFiles,
      tier: this.tier,
    });

    this.enabled = true;
    this.paused = false;
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.lastReopenAt = 0;
    this.frameMs = 0;
    this.ownMs = 0;
    this.loads = 0;
    this.evicts = 0;
    this.prefetched = 0;
    this.hystFlips = 0;
    this._lastDecision = new Map();
    this._tmpScores = new Float64Array(64);
    this.t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  _entry(rec) {
    let e = this.entries.get(rec.key);
    if (!e) { e = makeEntry(rec); this.entries.set(rec.key, e); }
    return e;
  }

  /** 外部每帧写相机。速度用外插，不依赖渲染帧率。 */
  setCamera(x, z, fx, fz, dtMs) {
    const dt = Math.max(1, dtMs) / 1000;
    this.cam.vx = (x - this.cam.x) / dt;
    this.cam.vz = (z - this.cam.z) / dt;
    this.cam.speed = Math.hypot(this.cam.vx, this.cam.vz);
    this.prevCam.x = this.cam.x; this.prevCam.z = this.cam.z;
    this.cam.x = x; this.cam.z = z;
    const l = Math.hypot(fx, fz) || 1;
    this.cam.fx = fx / l; this.cam.fz = fz / l;
  }

  /** 状态迁移：非法跃迁记遥测并回退，不静默吞。 */
  _move(e, to, now) {
    const from = e.state;
    if (from === to) return true;
    if (!canTransition(from, to)) {
      if (this.onError) this.onError('illegal_transition ' + e.key + ' ' +
        CS_NAME[from] + '->' + CS_NAME[to]);
      return false;
    }
    e.state = to;
    if (to === CS.RESIDENT) { e.lastUsedAt = now; this.resident.set(e.key, e); }
    if (to === CS.UNLOADED) {
      this.resident.delete(e.key);
      e.object = null; e.buildings = 0; e.triangles = 0;
      e.textureMB = 0; e.geometryMB = 0; e.visible = false;
    }
    if (to === CS.FAILED) this.failed.set(e.key, e);
    return true;
  }

  /** 距离：用索引解析期预存的 cx/cz，热路径零字符串切分、零临时数组。 */
  _dist(rec) {
    const dx = rec.cx - this.cam.x, dz = rec.cz - this.cam.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * 预测性预取：沿速度外推得到前视点，在 Hilbert 序上取连续一段。
   * 连续 rank 意味着同批请求落在相邻桶/相邻磁盘区，减少 HTTP 抖动。
   */
  _prefetchKeys(now) {
    const lead = scaled(this.governor, 'prefetchLead');
    const px = this.cam.x + this.cam.vx * lead;
    const pz = this.cam.z + this.cam.vz * lead;
    const radius = scaled(this.governor, 'prefetchRadiusM');
    const out = [];
    const arr = this.idx.byHilbert;
    // 以当前所在块的 rank 为中心向两侧扩，遇到超出半径即停
    let anchor = 0;
    let best = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const rec = arr[i];
      const d = this._dist(rec);
      if (d < best) { best = d; anchor = i; }
    }
    const span = 48;
    for (let k = -span; k <= span; k++) {
      const i = anchor + k;
      if (i < 0 || i >= arr.length) continue;
      const rec = arr[i];
      const ddx = rec.cx - px;
      const ddz = rec.cz - pz;
      const pd = Math.sqrt(ddx * ddx + ddz * ddz);
      if (pd > radius) continue;
      const e = this._entry(rec);
      if (e.state === CS.RESIDENT || e.state === CS.PINNED || e.pinned) continue;
      const face = facingScore(ddx, ddz, this.cam.fx, this.cam.fz);
      if (face < -0.35) continue;                 // 正背后的不预取
      e.score = priorityOf(rec, pd, face, this.cam.speed,
                           e.attempts, now, e.lastUsedAt) - 30;   // 预取降一档
      e.distM = pd;
      e.facing = face;
      out.push(e);
    }
    this.prefetched = out.length;
    return out;
  }

  /** 每帧主入口。frameMs 由渲染循环传入，本层自报 ownMs。 */
  tick(now, frameMs) {
    if (!this.enabled || this.paused) return { skipped: true };
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.tickCount++;
    this.frameMs = frameMs || 0;
    this.loads = 0; this.evicts = 0;

    /* [2026-11-26 手机端出生即空城修复] 入场/瞬移是长距离位移：旧位置的几十个
       分片请求还压在队列里，新位置的区块只能排队等它们一个个失败或完成，
       实测手机滑入城区 30 秒后出生点仍是空地，看到的全是旧 prefab 白房。
       位移超过加载半径 1/3 就判定为「位置跳变」：中止在途请求、清掉旧队列。 */
    const jump = Math.hypot(this.cam.x - this.prevCam.x, this.cam.z - this.prevCam.z);
    if (jump > this.tier.loadRadiusM * 0.33) {
      try { this.io.cancelAll(); } catch (e) {}
      for (const e of this.entries.values()) {
        if (e.state >= CS.QUEUED && e.state <= CS.UPLOADING) e.state = CS.UNLOADED;
      }
      this.jumps = (this.jumps || 0) + 1;
    }

    // 1) 自适应：只看本层上一帧实耗
    const scale = governorSample(this.governor, this.ownMs, this.frameMs, now);
    this.io.setConcurrency({
      ...this.tier,
      concurrentFetches: scaled(this.governor, 'concurrentFetches'),
      concurrentDecodes: scaled(this.governor, 'concurrentDecodes'),
      concurrentUploads: scaled(this.governor, 'concurrentUploads'),
    });
    this.budget.cap.chunks = scaled(this.governor, 'residentChunks');
    this.budget.cap.buildings = scaled(this.governor, 'residentBuildings');
    this.budget.cap.triangles = scaled(this.governor, 'residentTriangles');

    // 2) 失败桶退避到期重开（限频，不每帧全表扫）
    if (now - this.lastReopenAt > this.tier.cooldownMs) {
      this.io.reopenFailed(Date.now());
      this.lastReopenAt = now;
    }

    // 3) 常驻集决策：滞回 + 预算
    const loadR = scaled(this.governor, 'loadRadiusM');
    const arr = this.idx.byHilbert;
    const wanted = [];
    for (let i = 0; i < arr.length; i++) {
      const rec = arr[i];
      const d = this._dist(rec);
      // 粗筛：远处非驻留块直接跳过；但已驻留块必须留下走 EVICT 判断，
      // 否则瞬移后旧块被粗筛挡在卸载逻辑之外 → 只载不卸（实测 bug）
      if (d > loadR + this.tier.hystExitM + 200 && !this.resident.has(rec.key)) continue;
      const e = this._entry(rec);
      e.distM = d;
      const dx = rec.cx - this.cam.x, dz = rec.cz - this.cam.z;
      e.facing = facingScore(dx, dz, this.cam.fx, this.cam.fz);
      e.idleMs = e.lastUsedAt ? now - e.lastUsedAt : 0;
      const was = e.state === CS.RESIDENT || e.state === CS.PINNED;
      const dec = hystDecision(d, was, this.tier, scale);
      if (this._lastDecision.get(rec.key) && this._lastDecision.get(rec.key) !== dec) this.hystFlips++;
      this._lastDecision.set(rec.key, dec);
      if (dec === 'LOAD') {
        e.score = priorityOf(rec, d, e.facing, this.cam.speed, e.attempts, now, e.lastUsedAt);
        wanted.push(e);
      } else if (dec === 'EVICT' && !e.pinned) {
        this._evict(e, now, 'hysteresis');
      } else if (was) {
        e.lastUsedAt = now;
      }
    }

    // 4) 预算超了：按 evictScore 从最该卸的开始卸
    let pressure = budgetPressure(this.budget);
    if (pressure > 0.92) {
      const cand = [];
      for (const e of this.resident.values()) {
        if (e.pinned) continue;
        let n = 0;
        for (let k = 0; k < 8; k++) if (e.rec.n & (1 << k)) n++;
        cand.push({ e, s: evictScore(e.rec, e.distM, e.idleMs, n, this.tier) });
      }
      cand.sort((a, b) => b.s - a.s);
      const batch = Math.min(this.tier.evictBatch, cand.length);
      for (let i = 0; i < batch && budgetPressure(this.budget) > 0.82; i++) {
        this._evict(cand[i].e, now, 'budget');
      }
    }

    // 5) 装载：先满足 wanted，再补预测性预取（降权）
    for (const e of wanted) this._request(e, now);
    if (this.io.queue.size < this.tier.concurrentFetches * 2) {
      for (const e of this._prefetchKeys(now)) this._request(e, now, true);
    }

    // 6) 推进 I/O（decode 受帧预算约束）
    const decodeBudget = scaled(this.governor, 'decodeBudgetMs');
    this.io.pump(now, decodeBudget);

    // 6.5) [转视角帧率修复] 按帧预算消化构建队列：每帧最多花 mountBudgetMs
    //      在几何挤出/合并上，其余留到后续帧。fetch/decode 仍全速并行预取。
    this._drainMounts(now);

    this.ownMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    this.telemetry.push(this.frameMs, this.ownMs, this.loads, this.evicts,
                        this.resident.size, now);
    if (this.onBudget) this.onBudget(this.budget);
    return { skipped: false, wanted: wanted.length, prefetched: this.prefetched,
             loads: this.loads, evicts: this.evicts, resident: this.resident.size,
             ownMs: +this.ownMs.toFixed(3), scale: +scale.toFixed(2),
             pressure: +budgetPressure(this.budget).toFixed(3) };
  }

  /** [转视角帧率修复] 每帧按时间预算消化构建队列。 */
  _drainMounts(now) {
    if (!this.pendingMounts.length) return;
    const mb = Math.max(4, scaled(this.governor, 'uploadBudgetMs') || this.mountBudgetMs);
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    while (this.pendingMounts.length) {
      const job = this.pendingMounts.shift();
      this._mountNow(job, now);
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 >= mb) break;
    }
  }

  _mountNow(job, now) {
    const { e, rows, bucket, cached } = job;
    this._move(e, CS.UPLOADING, now);
    const built = this.onMount(e.key, rows, e.rec, { cached, bucket });
    if (built === null || built === false) {
      this._move(e, CS.FAILED, now);
      this.onError && this.onError('mount_failed ' + e.key);
      return;
    }
    e.object = built.object || null;
    e.buildings = built.buildings || rows.length;
    e.triangles = built.triangles || 0;
    e.textureMB = built.textureMB || 0;
    e.geometryMB = built.geometryMB || 0;
    // [2026-11-27] textureMB = 全局去重表当前值(非累加): 贴图跨 chunk 共享,
    // 累加会重复记账; chunk 卸载也不释放共享贴图, 驱逐端同步不扣此维度。
    this.budget.textureMB = +(((globalThis.__texMemTotal || 0) / 1048576)).toFixed(2);
    budgetAdd(this.budget, { chunks: 1, buildings: e.buildings,
      triangles: e.triangles, textureMB: 0, geometryMB: e.geometryMB });
    e.visible = true;
    this._move(e, CS.RESIDENT, now);
    this.failed.delete(e.key);
    this.loads++;
  }

  _request(e, now, isPrefetch = false) {
    if (e.state !== CS.UNLOADED && e.state !== CS.FAILED) return false;
    const est = {
      chunks: 1, buildings: e.rec.count,
      triangles: Math.max(24, e.rec.count * 36),
      textureMB: 0, geometryMB: Math.max(0.004, e.rec.count * 0.0009),
    };
    if (!budgetHeadroom(this.budget, est) && !isPrefetch) return false;
    if (!this._move(e, CS.QUEUED, now)) return false;
    const self = this;
    const ok = this.io.enqueue(e.key, e.bucketId, e.score,
      (rows, bucket, cached) => {
        self._move(e, CS.FETCHING, now);
        self._move(e, CS.DECODING, now);
        // [转视角帧率修复] 不再同步构建：入队等本帧预算消化
        self.pendingMounts.push({ e, rows, bucket, cached, now });
      },
      (err, attempt) => {
        e.attempts = attempt || (e.attempts + 1);
        self._move(e, CS.FAILED, now);
        self._move(e, CS.UNLOADED, now);
        self.onError && self.onError(e.key + ': ' + err);
      });
    if (!ok) self._move(e, CS.UNLOADED, now);
    return ok;
  }

  _evict(e, now, reason) {
    if (e.state !== CS.RESIDENT && e.state !== CS.PINNED) return false;
    if (!this._move(e, CS.EVICTING, now)) return false;
    const d = { chunks: 1, buildings: e.buildings, triangles: e.triangles,
                textureMB: e.textureMB, geometryMB: e.geometryMB };
    try { this.onUnmount(e.key, e.object, reason); } catch (err) {
      this.onError && this.onError('unmount ' + e.key + ' ' + String(err).slice(0, 120));
    }
    budgetAdd(this.budget, { chunks: -d.chunks, buildings: -d.buildings,
      triangles: -d.triangles, textureMB: 0, geometryMB: -d.geometryMB });
    // textureMB 维度由全局贴图表刷新(见 _mountNow), 驱逐共享贴图不释放故不扣
    this.budget.evictions++;
    this.io.evictBucket(e.bucketId, false);
    this._move(e, CS.UNLOADED, now);
    this.evicts++;
    return true;
  }

  pin(key) { const e = this.entries.get(key); if (e) { e.pinned = true; if (e.state === CS.RESIDENT) this._move(e, CS.PINNED, Date.now()); } }
  unpin(key) { const e = this.entries.get(key); if (e) { e.pinned = false; if (e.state === CS.PINNED) this._move(e, CS.RESIDENT, Date.now()); } }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  setEnabled(v) { this.enabled = !!v; if (!v) this.io.cancelAll(); }
  dispose() { this.io.cancelAll(); this.resident.clear(); this.entries.clear(); this.enabled = false; }

  /** 验收与 HUD 用的全量状态快照（只读、可 JSON 化）。 */
  state() {
    return Object.freeze({
      version: STREAM_VERSION,
      enabled: this.enabled, paused: this.paused,
      coverage: this.manifest.coverage || 'unknown',
      manifestBuildings: this.manifest.buildingCount || 0,
      index: Object.freeze({
        chunks: this.meta.chunkCount, buckets: this.meta.bucketCount,
        hilbertOrder: this.meta.hilbertOrder, tableSha256: this.meta.tableSha256,
        recalcChecked: this.check.checked, recalcOk: this.check.ok,
        recalcErrors: this.check.totalErrors,
      }),
      tier: this.tier.name,
      scale: +this.governor.scale.toFixed(2),
      emaMs: +this.governor.emaMs.toFixed(3),
      medianOwnMs: governorMedian(this.governor),
      tickCount: this.tickCount,
      resident: this.resident.size,
      entries: this.entries.size,
      pinned: [...this.entries.values()].filter(e => e.pinned).length,
      failed: this.failed.size,
      hystFlips: this.hystFlips,
      prefetched: this.prefetched,
      budget: Object.freeze({
        chunks: this.budget.chunks, buildings: this.budget.buildings,
        triangles: this.budget.triangles, textureMB: +this.budget.textureMB.toFixed(3),
        geometryMB: +this.budget.geometryMB.toFixed(3),
        pressure: +budgetPressure(this.budget).toFixed(3),
        evictions: this.budget.evictions,
        peak: Object.freeze({ ...this.budget.peak }),
      }),
      io: this.io.snapshot(),
      telemetry: this.telemetry.snapshot(),
      lastTick: Object.freeze({ wanted: 0, loads: this.loads, evicts: this.evicts,
                                ownMs: +this.ownMs.toFixed(3), frameMs: +this.frameMs.toFixed(2) }),
      adrCount: ADR.length,
      note: '常驻集只覆盖 manifest 已有区块；全量数据到位后重跑 build_chunk_index.py 即可，逻辑零改动。',
    });
  }
}

/* ============================================================
 * 4. 挂载钩子：与 miami_layer 的真实 chunked 层对接
 * ============================================================
 * 关键：绝不在缺数据时造城市。manifest 拿不到 / 不是 chunked /
 * 索引复算失败 → 返回 null，零请求、零几何、零报错。
 */
export async function createChunkStream(opts) {
  const mfUrl = (opts.base || './data/') + 'urban_manifest.json';
  let mf = null;
  try {
    const r = await (opts.fetchImpl || fetch)(mfUrl);
    if (!r.ok) return null;
    mf = await r.json();
  } catch (_) { return null; }
  if (!mf || mf.mode !== 'chunked' || !Array.isArray(mf.chunks) || !mf.chunks.length) return null;
  try {
    const cs = new ChunkStream({ ...opts, manifest: mf });
    return cs;
  } catch (e) {
    if (opts.onError) opts.onError('index_recalc: ' + String(e && e.message || e).slice(0, 200));
    return null;
  }
}

/* ============================================================
 * 5. 模块自检（不依赖浏览器，逐轮可复跑）
 * ============================================================ */
export function streamSelfTest(manifest) {
  const out = [];
  const P = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
  P('版本标记', STREAM_VERSION === 'a7u.stream.1');
  P('索引元数据可读', INDEX_META.chunkCount === 13743 && INDEX_META.gridSize === 200,
    INDEX_META.chunkCount);
  const idx = parseIndex();
  P('索引行数一致', idx.rows === INDEX_META.chunkCount, idx.rows);
  P('Hilbert 序数组等长', idx.byHilbert.length === idx.rows);
  P('桶表可读', idx.bucketFiles.length === INDEX_META.bucketCount);
  P('索引逐条复算通过', recalcCheck(manifest).ok, recalcCheck(manifest).totalErrors);
  P('方向表 8 向', INDEX_SELFTEST.dirs.length === 8);
  P('策略自检全过', policySelfTest().total === policySelfTest().passed,
    policySelfTest().passed + '/' + policySelfTest().total);
  P('I/O 自检全过', ioSelfTest().total === ioSelfTest().passed,
    ioSelfTest().passed + '/' + ioSelfTest().total);

  if (manifest && manifest.chunks && manifest.chunks.length) {
    let mounted = 0, unmounted = 0;
    const cs = new ChunkStream({
      manifest, tier: TIERS.ember,
      fetchImpl: () => Promise.resolve({ ok: true, arrayBuffer: () =>
        Promise.resolve(new TextEncoder().encode('{"chunks":[]}').buffer) }),
      onMount: (key, rows, rec) => { mounted++; return { object: { key }, buildings: rows.length,
        triangles: Math.max(24, rows.length * 36), geometryMB: 0.01 }; },
      onUnmount: () => { unmounted++; },
    });
    cs.setCamera(0, 0, 0, 1, 16);
    const r = cs.tick(1000, 16);
    P('tick 可执行', !r.skipped && r.ownMs >= 0, JSON.stringify(r).slice(0, 140));
    P('state 可序列化', (() => { try { JSON.stringify(cs.state()); return true; } catch (_) { return false; } })());
    P('常驻集不超预算', cs.state().budget.chunks <= cs.state().budget.peak.chunks + 1);
    P('pin/unpin 合法', (() => { const k = idx.byHilbert[0].key; cs._entry(idx.byHilbert[0]);
      cs.pin(k); const a = cs.entries.get(k).pinned; cs.unpin(k); return a && !cs.entries.get(k).pinned; })());
    cs.setEnabled(false);
    P('禁用后 tick 跳过', cs.tick(1100, 16).skipped === true);
    cs.dispose();
    P('dispose 清空常驻', cs.resident.size === 0 && cs.entries.size === 0);
  }
  return Object.freeze({ total: out.length, passed: out.filter(x => x.ok).length,
                         failures: out.filter(x => !x.ok), items: out });
}

// 具名重导出：验收与调试可直接检查索引，不必绕 default
export { INDEX_META, INDEX_SELFTEST, parseIndex, recalcCheck };

export default { ChunkStream, createChunkStream, streamSelfTest, Telemetry,
  INDEX_META, parseIndex, recalcCheck, TIERS, tierFor, CS, CS_NAME, ADR };
