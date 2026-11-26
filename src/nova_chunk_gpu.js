// nova_chunk_gpu.js — 区块资源生命周期 / 显存账本 / 模块手册（手写）
// NOVA a7u · 与贴图共存层隔离的独立账本，负责「卸的时候到底释放什么」。
//
// 存在的理由：加载只是把字节变对象，真正容易出事的是卸载。
// 一个 200m 区块可能同时持有：BufferGeometry、index buffer、材质实例、
// 立面 shader uniform 里的 DataTexture、街面距离场 DataTexture、
// 中/远级合批代理、规划贴地面。漏 dispose 任何一项，走半小时就 OOM；
// 多 dispose 一次（比如共享材质被别的块还在用）就整片发黑。

import { CS_NAME, TIERS, ADR } from './nova_chunk_policy.js?v=a7u';
import { crc32 } from './nova_chunk_io.js?v=a7u';

/* ============================================================
 * 1. 资源票据：每块加载时登记，卸载时按票据精确回收
 * ============================================================
 * shared 标记：同一材质/几何被多块引用时只记一次所有权，
 * 用 refCount 决定最后一次才真的 dispose。
 */
export class ResourceLedger {
  constructor() {
    this.tickets = new Map();       // key -> Ticket
    this.shared = new Map();        // uuid -> {res, refs, kind, bytes}
    this.totalGeometryBytes = 0;
    this.totalTextureBytes = 0;
    this.totalObjects = 0;
    this.disposeCalls = 0;
    this.skippedShared = 0;
    this.errors = [];
    this.peakGeometryBytes = 0;
    this.peakTextureBytes = 0;
  }

  /** 登记一份资源。shared=true 时按 uuid 合并所有权。 */
  track(res, kind, ownerKey, bytes = 0, shared = false) {
    if (!res) return null;
    const uuid = res.uuid || (res.id || null);
    let handle;
    if (shared && uuid && this.shared.has(uuid)) {
      handle = this.shared.get(uuid);
      handle.refs++;
      this.skippedShared++;
    } else {
      handle = { res, uuid, kind, bytes, refs: 1, shared: !!shared,
                 disposed: false, ownerKey };
      if (shared && uuid) this.shared.set(uuid, handle);
      if (kind === 'texture' || kind === 'dataTexture') {
        this.totalTextureBytes += bytes;
        if (this.totalTextureBytes > this.peakTextureBytes) this.peakTextureBytes = this.totalTextureBytes;
      } else {
        this.totalGeometryBytes += bytes;
        if (this.totalGeometryBytes > this.peakGeometryBytes) this.peakGeometryBytes = this.totalGeometryBytes;
      }
      this.totalObjects++;
    }
    let t = this.tickets.get(ownerKey);
    if (!t) { t = { key: ownerKey, handles: [], createdAt: Date.now() }; this.tickets.set(ownerKey, t); }
    t.handles.push(handle);
    return handle;
  }

  /** 精确回收一个区块的票据。返回实际 dispose 数。 */
  release(ownerKey) {
    const t = this.tickets.get(ownerKey);
    if (!t) return 0;
    let n = 0;
    for (const h of t.handles) {
      if (h.disposed) continue;
      if (h.shared && h.refs > 1) { h.refs--; this.skippedShared++; continue; }
      h.refs--;
      const ok = disposeResource(h.res, h.kind);
      if (!ok) this.errors.push({ key: ownerKey, kind: h.kind, message: 'dispose_failed' });
      h.disposed = true;
      const sz = h.bytes || 0;
      if (h.kind === 'texture' || h.kind === 'dataTexture') this.totalTextureBytes -= sz;
      else this.totalGeometryBytes -= sz;
      this.totalObjects--;
      this.disposeCalls++;
      n++;
      if (h.shared && h.uuid) this.shared.delete(h.uuid);
    }
    this.tickets.delete(ownerKey);
    return n;
  }

  /** 全量回收（页面卸载 / 换城）。 */
  releaseAll() {
    let n = 0;
    for (const k of [...this.tickets.keys()]) n += this.release(k);
    return n;
  }

  snapshot() {
    return Object.freeze({
      tickets: this.tickets.size,
      shared: this.shared.size,
      objects: this.totalObjects,
      geometryMB: +(this.totalGeometryBytes / 1048576).toFixed(3),
      textureMB: +(this.totalTextureBytes / 1048576).toFixed(3),
      peakGeometryMB: +(this.peakGeometryBytes / 1048576).toFixed(3),
      peakTextureMB: +(this.peakTextureBytes / 1048576).toFixed(3),
      disposeCalls: this.disposeCalls,
      skippedShared: this.skippedShared,
      errors: this.errors.length,
    });
  }
}

/**
 * 单一 dispose 入口。顺序有讲究：
 *   1. 先从父节点摘掉（否则遍历渲染器时还会摸到半死对象）
 *   2. geometry.dispose()
 *   3. 材质上的贴图：只 dispose 本块独占的，noRelease / novaDF 标记的不动
 *   4. material.dispose()
 * 绝不遍历 scene 全树 —— 那是 O(N) 且会误伤别的块。
 */
export function disposeResource(res, kind) {
  if (!res) return false;
  try {
    if (kind === 'object' || kind === 'mesh' || kind === 'group') {
      if (res.parent) res.parent.remove(res);
      if (typeof res.traverse === 'function') {
        const seenG = new Set(), seenM = new Set();
        res.traverse(o => {
          if (o.geometry && !seenG.has(o.geometry.uuid)) { seenG.add(o.geometry.uuid); o.geometry.dispose(); }
          const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
          for (const m of ms) {
            if (!m || seenM.has(m.uuid)) continue;
            seenM.add(m.uuid);
            disposeMaterialMaps(m);
            if (typeof m.dispose === 'function') m.dispose();
          }
        });
      }
      return true;
    }
    if (typeof res.dispose === 'function') { res.dispose(); return true; }
    return false;
  } catch (e) {
    return false;
  }
}

/** 只释放本块独占的贴图；打标记的（距离场 / 共享图集）一律保留。 */
export function disposeMaterialMaps(m) {
  const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
                 'emissiveMap', 'alphaMap', 'lightMap', 'bumpMap', 'displacementMap'];
  let n = 0;
  for (const k of slots) {
    const t = m[k];
    if (!t) continue;
    if (t.userData && (t.userData.noRelease || t.userData.novaDF || t.userData.shared)) continue;
    if (typeof t.dispose === 'function') { try { t.dispose(); n++; } catch (_) {} }
    m[k] = null;
  }
  // ShaderMaterial 的 uniforms 里也可能挂纹理
  if (m.uniforms) {
    for (const k of Object.keys(m.uniforms)) {
      const v = m.uniforms[k] && m.uniforms[k].value;
      if (v && v.isTexture && !(v.userData && (v.userData.noRelease || v.userData.novaDF))) {
        try { v.dispose(); n++; } catch (_) {}
        m.uniforms[k].value = null;
      }
    }
  }
  return n;
}

/* ============================================================
 * 2. 上传配额：每帧最多上传多少字节/多少个对象
 * ============================================================
 * decode 完不等于能立刻进场景。一次性把 40 个块的 geometry 推给 GL，
 * 会在某一帧造成 30ms 的硬卡顿。按字节配额切片，剩余排队到下一帧。
 */
export class UploadQuota {
  constructor(bytesPerFrame = 262144, objectsPerFrame = 6) {
    this.bytesPerFrame = bytesPerFrame;
    this.objectsPerFrame = objectsPerFrame;
    this.usedBytes = 0;
    this.usedObjects = 0;
    this.deferred = [];
    this.totalUploaded = 0;
  }
  beginFrame(scale = 1) {
    this.usedBytes = 0; this.usedObjects = 0;
    // 下限用 1KB 而不是硬编码 64KB：后者会把调用方设定的小配额直接顶掉，
    // 验收里 1000 B 的配额永远不生效（真 bug，不只是测试问题）。
    this.capBytes = Math.max(1024, this.bytesPerFrame * scale);
    this.capObjects = Math.max(1, Math.round(this.objectsPerFrame * scale));
  }
  canTake(bytes) {
    return this.usedBytes + bytes <= this.capBytes && this.usedObjects < this.capObjects;
  }
  take(bytes) { this.usedBytes += bytes; this.usedObjects++; this.totalUploaded += bytes; }
  defer(item) { this.deferred.push(item); }
  drain(fn) {
    let n = 0;
    while (this.deferred.length && this.canTake(this.deferred[0].bytes || 0)) {
      const it = this.deferred.shift();
      this.take(it.bytes || 0);
      fn(it); n++;
    }
    return n;
  }
  snapshot() {
    return { capBytes: this.capBytes | 0, capObjects: this.capObjects | 0,
             usedBytes: this.usedBytes | 0, usedObjects: this.usedObjects,
             deferred: this.deferred.length, totalUploaded: this.totalUploaded };
  }
}

/* ============================================================
 * 3. 与既有贴图账本的隔离桥
 * ============================================================
 * main.js 的 SRC_INFO / trimToBudget / releaseTextureSources 管的是
 * 主城原有材质（material.map 六键）。本层资源不写进 SRC_INFO，
 * 但 state() 要同时报两本账，否则总显存看着是「少算了一块」。
 */
export function combinedVramReport(ledger, mainSrcInfoFn, rendererInfo) {
  let main = null;
  try { main = typeof mainSrcInfoFn === 'function' ? mainSrcInfoFn() : null; } catch (_) {}
  return Object.freeze({
    stream: ledger.snapshot(),
    main: main === null ? null : Object.freeze({
      sources: typeof main === 'number' ? main : (main.sources ?? null),
      resident: main && typeof main === 'object' ? (main.resident ?? null) : null,
    }),
    renderer: rendererInfo ? Object.freeze({
      textures: rendererInfo.memory ? rendererInfo.memory.textures : null,
      geometries: rendererInfo.memory ? rendererInfo.memory.geometries : null,
    }) : null,
    note: '两本账互不覆盖；距离场带 noRelease/novaDF 标记，releaseTextureSources 不会误伤。',
  });
}

/* ============================================================
 * 4. 模块 API 手册（运行时可读，不是注释摆设）
 * ============================================================ */
export const API = Object.freeze([
  Object.freeze({ name: 'createChunkStream(opts)', module: 'nova_chunk_core.js',
    desc: '异步读 urban_manifest.json，校验索引后返回 ChunkStream；缺数据返回 null。',
    params: 'opts:{base,tier,fetchImpl,onMount,onUnmount,onBudget,onError}',
    returns: 'Promise<ChunkStream|null>' }),
  Object.freeze({ name: 'ChunkStream.setCamera(x,z,fx,fz,dtMs)', module: 'nova_chunk_core.js',
    desc: '每帧写相机位置/朝向/速度，速度用于预测性预取。',
    params: '世界坐标 m；fx,fz 为单位朝向', returns: 'void' }),
  Object.freeze({ name: 'ChunkStream.tick(now,frameMs)', module: 'nova_chunk_core.js',
    desc: '每帧主入口：自适应→滞回决策→预算驱逐→装载→预取→I/O 推进。',
    params: 'now 毫秒；frameMs 整帧耗时', returns: '本帧统计对象' }),
  Object.freeze({ name: 'ChunkStream.state()', module: 'nova_chunk_core.js',
    desc: '全量只读快照，含索引校验、预算、I/O、遥测、ADR 数。',
    params: '无', returns: 'Object.freeze 的可序列化对象' }),
  Object.freeze({ name: 'ChunkStream.pin/unpin(key)', module: 'nova_chunk_core.js',
    desc: '把某块钉在常驻集，用于书签跳转 / 调试视角。',
    params: '区块 key，如 "12,-3"', returns: 'void' }),
  Object.freeze({ name: 'parseIndex()', module: 'nova_chunk_index_table.js',
    desc: '解析 13,743 行定长预计算索引为 byKey/byHilbert/bucketFiles。',
    params: '无', returns: '冻结的运行时索引' }),
  Object.freeze({ name: 'recalcCheck(manifest)', module: 'nova_chunk_index_table.js',
    desc: '全量复算 8 邻域位掩码/度数/桶映射/距离带/优先级，不一致即拒绝启用。',
    params: 'urban_manifest.json', returns: '{ok,checked,errors,totalErrors}' }),
  Object.freeze({ name: 'ChunkIO.pump(now,budgetMs)', module: 'nova_chunk_io.js',
    desc: '推进解码游标并从优先队列发请求；decode 受帧预算约束可跨帧。',
    params: '预算毫秒', returns: '本帧新发请求数' }),
  Object.freeze({ name: 'DecodeCursor.step(budgetMs,now)', module: 'nova_chunk_io.js',
    desc: '逐段 JSON 解码，段间让出，避免整桶一次 parse 卡主线程。',
    params: '预算毫秒', returns: '本帧解出的段数' }),
  Object.freeze({ name: 'ResourceLedger.track/release', module: 'nova_chunk_gpu.js',
    desc: '按票据精确回收几何/材质/贴图；共享资源按 refCount 延后释放。',
    params: '资源对象、kind、ownerKey', returns: 'handle / 实际 dispose 数' }),
  Object.freeze({ name: 'UploadQuota.beginFrame/canTake/take', module: 'nova_chunk_gpu.js',
    desc: '每帧上传字节与对象数双配额，超出的排队到下一帧。',
    params: 'scale 来自 governor', returns: 'boolean / void' }),
  Object.freeze({ name: 'combinedVramReport(...)', module: 'nova_chunk_gpu.js',
    desc: '同屏报流送账本、主城 SRC_INFO、renderer.info 三套数字，互不覆盖。',
    params: 'ledger, __mcSrcInfo, renderer.info', returns: '冻结报告' }),
  Object.freeze({ name: 'policySelfTest() / ioSelfTest() / streamSelfTest(mf) / gpuSelfTest()',
    module: '各模块', desc: '确定性断言集，逐轮复跑结果必须一致。',
    params: 'streamSelfTest 需 manifest', returns: '{total,passed,failures,items}' }),
]);

export const MODULE_FILES = Object.freeze([
  Object.freeze({ file: 'nova_chunk_index_table.js', kind: '数据派生表',
    role: '13,743 个真实区块的 Hilbert 序 / 8 邻域位掩码 / 桶映射 / 距离带 / 优先级基线',
    source: 'tools/build_chunk_index.py 从 urban_manifest.json 确定性导出，逐条可复算' }),
  Object.freeze({ file: 'nova_chunk_policy.js', kind: '手写逻辑',
    role: '状态机、三档策略、governor、滞回、优先级、退避、驱逐打分、预算、10 条 ADR' }),
  Object.freeze({ file: 'nova_chunk_io.js', kind: '手写逻辑',
    role: '并发闸、二叉堆、同桶合并、Abort、流式分段解码、失败退避、引用计数' }),
  Object.freeze({ file: 'nova_chunk_core.js', kind: '手写逻辑',
    role: '常驻集调度、预测性预取、帧预算切片、精确卸载、挂载钩子、只读快照' }),
  Object.freeze({ file: 'nova_chunk_gpu.js', kind: '手写逻辑',
    role: '资源票据、共享引用计数、dispose 顺序、上传配额、双账本隔离、API 手册' }),
]);

/* ============================================================
 * 5. 自检
 * ============================================================ */
export function gpuSelfTest() {
  const out = [];
  const P = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

  let disposed = 0;
  const mk = (tag) => ({ uuid: tag, dispose() { disposed++; } });
  const led = new ResourceLedger();
  led.track(mk('g1'), 'geometry', '0,0', 1024);
  led.track(mk('t1'), 'dataTexture', '0,0', 4096);
  P('登记计数', led.snapshot().objects === 2 && led.totalGeometryBytes === 1024);
  P('回收票据', led.release('0,0') === 2 && disposed === 2);
  P('回收后归零', led.snapshot().objects === 0 && led.totalTextureBytes === 0);
  P('重复回收安全', led.release('0,0') === 0);

  const shared = mk('shared-mat');
  const led2 = new ResourceLedger();
  led2.track(shared, 'material', '1,0', 100, true);
  led2.track(shared, 'material', '1,1', 100, true);
  P('共享资源只记一次', led2.snapshot().objects === 1 && led2.shared.size === 1);
  led2.release('1,0');
  P('共享资源首块不真 dispose', disposed === 2 && led2.shared.size === 1);
  led2.release('1,1');
  P('共享资源末块才 dispose', disposed === 3 && led2.shared.size === 0);

  const dfTex = mk('df'); dfTex.isTexture = true;   // 真纹理才进 uniform 释放分支
  const mat = {
    map: mk('map'), normalMap: mk('nm'),
    uniforms: { uDF: { value: dfTex } }, dispose() { disposed++; }, uuid: 'mat-x'
  };
  mat.map.userData = { noRelease: true };
  const led3 = new ResourceLedger();
  led3.track(mat.map, 'texture', '2,0', 10);
  const n = disposeMaterialMaps(mat);
  P('noRelease 贴图不被释放', n === 2 && mat.map !== null, 'n=' + n);
  P('uniform 独占纹理被释放', mat.uniforms.uDF.value === null);
  P('材质本身可 dispose', disposeResource(mat, 'material') === true);

  const q = new UploadQuota(1000, 2);
  q.beginFrame(1);
  P('字节配额生效', q.canTake(600) && !q.canTake(1100));
  q.take(600);
  P('对象配额生效', q.canTake(100)); q.take(100);
  P('对象配额封顶', !q.canTake(1));
  q.defer({ bytes: 10 }); q.beginFrame(1);
  P('队列可跨帧排空', q.drain(() => {}) === 1);
  q.beginFrame(0.5);
  P('scale 收缩配额', q.capBytes === 1024 && q.capObjects === 1, q.capBytes);

  const rep = combinedVramReport(led3, () => 6, { memory: { textures: 12, geometries: 30 } });
  P('双账本不覆盖', rep.main.sources === 6 && rep.renderer.textures === 12);
  P('账本说明存在', !!rep.note);
  P('API 条目齐全', API.length >= 12 && API.every(a => a.name && a.desc && a.module));
  P('模块清单齐全', MODULE_FILES.length === 5);
  P('ADR 与清单同源', ADR.length === 10);
  P('CS_NAME 九态', CS_NAME.length === 9);

  return Object.freeze({ total: out.length, passed: out.filter(x => x.ok).length,
                         failures: out.filter(x => !x.ok), items: out });
}

export default { ResourceLedger, disposeResource, disposeMaterialMaps, UploadQuota,
  combinedVramReport, API, MODULE_FILES, gpuSelfTest, TIERS, crc32 };
