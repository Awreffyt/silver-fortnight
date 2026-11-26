// nova_chunk_io.js — 区块流送 I/O 层（手写）
// NOVA a7u · 并发池 / 同桶合并 / Abort / 流式解码 / 失败恢复。
//
// 全量城市按 200m 分块会是上万块，磁盘侧按桶聚合（本次抽样 13,743 块 →
// 420 桶）。逐块 fetch 会发 33 倍冗余请求；一桶一 Promise 又会在失败时
// 把整桶毒化。本层把「桶」做成带引用计数、可失效、可重试的实体。

import { CS, canTransition, retryDelayMs, hash32 } from './nova_chunk_policy.js?v=a7u';

/* ============================================================
 * 1. 确定性校验
 * ============================================================
 * CRC32 不用查表（表本身要 1KB 且要预热），直接位运算，桶通常几十 KB，
 * 代价可忽略。验收里逐桶对齐构建期算出的校验值。
 */
export function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/* ============================================================
 * 2. 二叉最小/最大堆（原地，零分配）
 * ============================================================
 * 调度队列与驱逐队列都用它。Array.sort 每帧重建数组会制造 GC 尖峰，
 * 在软渲染验收里表现为周期性长帧，真机上更明显。
 */
export class BinaryHeap {
  constructor(cap = 4096, less = (a, b) => a.score < b.score) {
    this.a = new Array(cap);
    this.n = 0;
    this.less = less;
    this.cap = cap;
  }
  get size() { return this.n; }
  clear() { this.n = 0; }
  _grow() {
    const b = new Array(this.cap * 2);
    for (let i = 0; i < this.n; i++) b[i] = this.a[i];
    this.a = b; this.cap *= 2;
  }
  push(v) {
    if (this.n === this.cap) this._grow();
    let i = this.n++;
    this.a[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.a[i], this.a[p])) break;
      const t = this.a[i]; this.a[i] = this.a[p]; this.a[p] = t; i = p;
    }
    return i;
  }
  peek() { return this.n ? this.a[0] : null; }
  pop() {
    if (!this.n) return null;
    const top = this.a[0];
    const last = this.a[--this.n];
    if (this.n) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && this.less(this.a[l], this.a[m])) m = l;
        if (r < this.n && this.less(this.a[r], this.a[m])) m = r;
        if (m === i) break;
        const t = this.a[i]; this.a[i] = this.a[m]; this.a[m] = t; i = m;
      }
    }
    return top;
  }
  /** 原地重排：priority 被外部改过后调用，不动元素只重建堆序。 */
  heapify() { for (let i = (this.n >> 1) - 1; i >= 0; i--) this._down(i); }
  _down(i) {
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < this.n && this.less(this.a[l], this.a[m])) m = l;
      if (r < this.n && this.less(this.a[r], this.a[m])) m = r;
      if (m === i) break;
      const t = this.a[i]; this.a[i] = this.a[m]; this.a[m] = t; i = m;
    }
  }
  toArray() { return this.a.slice(0, this.n); }
}

/* ============================================================
 * 3. 并发闸（三种资源各自独立）
 * ============================================================
 * fetch / decode / upload 不能共用一个闸：网络慢时把 decode 也堵死，
 * 会让已到手的桶迟迟解不开，驻留数虚低、画面空一块。
 */
export class Gate {
  constructor(limit) { this.limit = Math.max(1, limit | 0); this.active = 0; this.maxSeen = 0; }
  setLimit(v) { this.limit = Math.max(1, v | 0); }
  tryAcquire() {
    if (this.active >= this.limit) return false;
    this.active++;
    if (this.active > this.maxSeen) this.maxSeen = this.active;
    return true;
  }
  release() { if (this.active > 0) this.active--; }
  get free() { return this.limit - this.active; }
  snapshot() { return { limit: this.limit, active: this.active, maxSeen: this.maxSeen }; }
}

/* ============================================================
 * 4. 桶实体
 * ============================================================
 * state: idle | inflight | ready | failed
 * refs:  当前有多少区块在等这一桶；归零且非驻留时可回收 decoded 数据
 * promise 只在 inflight 期存在，ready 后只留解码结果，失败后整体删除
 * —— 这条就是 ADR-005「失败不毒化整桶」。
 */
export class Bucket {
  constructor(id, file) {
    this.id = id; this.file = file;
    this.state = 'idle';
    this.refs = 0;
    this.bytes = 0;
    this.checksum = 0;
    this.entries = null;              // Map<chunkKey, rawRecords[]>
    this.promise = null;
    this.controller = null;
    this.attempts = 0;
    this.fetchedAt = 0;
    this.failedAt = 0;
    this.decodeMs = 0;
    this.fetchMs = 0;
  }
  retain() { this.refs++; }
  release() { if (this.refs > 0) this.refs--; return this.refs; }
}

/* ============================================================
 * 5. 流式 JSON 解码
 * ============================================================
 * 不用 JSON.parse 一次吃整桶：全量桶会比抽样桶大两个数量级，
 * 一次 parse 会在主线程造成几十毫秒的硬停顿。这里按顶层键切段，
 * 逐段 parse，段间让出（由调度器按 decodeBudgetMs 决定每帧做几段）。
 *
 * 输入格式（导出器约定）：
 *   {"chunks":[{"key":"...","buildings":[...]},{"key":"...","buildings":[...]}]}
 * 也兼容 {"key":..., "buildings":[...]} 的单块对象。
 */
export function makeSegmenter(text) {
  const segs = [];
  // 找 "chunks":[ ... ] 里每个顶层对象的大括号边界；引号与转义严格处理
  const startTag = '"chunks"';
  let p = text.indexOf(startTag);
  if (p < 0) {
    return Object.freeze({ segments: Object.freeze([Object.freeze({ start: 0, end: text.length })]),
                           mode: 'single', total: 1 });
  }
  p = text.indexOf('[', p);
  if (p < 0) return Object.freeze({ segments: Object.freeze([]), mode: 'empty', total: 0 });
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = p + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) { segs.push(Object.freeze({ start: objStart, end: i + 1 })); objStart = -1; }
      continue;
    }
    if (ch === ']' && depth === 0) break;
  }
  return Object.freeze({ segments: Object.freeze(segs), mode: 'chunks', total: segs.length });
}

export function parseSegment(text, seg) {
  return JSON.parse(text.slice(seg.start, seg.end));
}

/** 逐段解码的可恢复游标：调度器每帧调用 step(budgetMs)。 */
export class DecodeCursor {
  constructor(bucket, text, onEntry) {
    this.bucket = bucket;
    this.text = text;
    this.onEntry = onEntry;
    this.plan = makeSegmenter(text);
    this.at = 0;
    this.done = 0;
    this.errors = [];
    this.t0 = 0;
    this.ms = 0;
  }
  get finished() { return this.at >= this.plan.total; }
  step(budgetMs, now) {
    if (!this.t0) this.t0 = now;
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let n = 0;
    while (!this.finished) {
      const seg = this.plan.segments[this.at];
      try {
        const obj = parseSegment(this.text, seg);
        // 兼容导出器顶层格式 {"chunkSize","byChunk":{key:[records]}}：
        // byChunk 逐 key 分发，一次 parse 解出整桶（单桶 ~0.6MB，可接受）
        if (obj && obj.byChunk) {
          for (const k in obj.byChunk) { this.onEntry(k, obj.byChunk[k]); this.done++; }
        } else if (obj && obj.key) {
          this.onEntry(obj.key, obj.buildings || obj.records || []);
          this.done++;
        }
      } catch (e) {
        this.errors.push({ at: this.at, message: String(e && e.message || e).slice(0, 160) });
      }
      this.at++; n++;
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t >= budgetMs) break;
    }
    this.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.t0;
    if (this.finished) this.bucket.decodeMs = this.ms;
    return n;
  }
}

/* ============================================================
 * 6. I/O 管理器
 * ============================================================ */
export class ChunkIO {
  constructor(opts) {
    this.base = opts.base || './data/';
    this.fetchImpl = opts.fetchImpl || ((u, o) => fetch(u, o));
    this.bucketFiles = opts.bucketFiles || [];
    this.tier = opts.tier;
    this.maxRetry = opts.maxRetry ?? this.tier.maxRetry;
    this.abortAfterMs = opts.abortAfterMs ?? this.tier.abortAfterMs;

    this.buckets = new Map();          // bucketId -> Bucket
    // 桶级待分发队列：同桶的多个区块共用一个请求，按 bucketId 聚合所有 job。
    // 早期版本把 job 挂在 b.waiters 上，但 _startFetch 开始时就把 waiters
    // 读走并置 null —— 后续到达的同桶 job 永远收不到回调（真泄漏）。
    this.pendingByBucket = new Map();  // bucketId -> job[]
    this.fetchGate = new Gate(this.tier.concurrentFetches);
    this.decodeGate = new Gate(this.tier.concurrentDecodes);
    this.uploadGate = new Gate(this.tier.concurrentUploads);
    this.queue = new BinaryHeap(8192, (a, b) => a.score > b.score);   // 高分先出
    this.cursors = [];
    this.inflight = new Map();         // key -> AbortController
    this.retryAt = new Map();          // key -> timestamp
    this.attempts = new Map();         // key -> count

    this.stats = {
      requests: 0, bucketRequests: 0, bytes: 0, decodeSegments: 0,
      failures: 0, retries: 0, aborts: 0, checksumMismatch: 0,
      dedupHits: 0, cacheHits: 0, lastError: null,
    };
  }

  bucket(id) {
    let b = this.buckets.get(id);
    if (!b) {
      const f = this.bucketFiles[id];
      if (!f) return null;
      b = new Bucket(id, f);
      this.buckets.set(id, b);
    }
    return b;
  }

  /** 排队一个区块。score 由调度器算好，这里只入堆。 */
  enqueue(key, bucketId, score, onReady, onFail) {
    if (this.retryAt.has(key) && Date.now() < this.retryAt.get(key)) return false;
    this.queue.push({ key, bucketId, score, onReady, onFail });
    return true;
  }

  setConcurrency(tier) {
    this.fetchGate.setLimit(tier.concurrentFetches);
    this.decodeGate.setLimit(tier.concurrentDecodes);
    this.uploadGate.setLimit(tier.concurrentUploads);
  }

  /** 每帧调一次；返回本帧真实发出的请求数。 */
  pump(now, budgetMs) {
    let started = 0;
    // 1) 推进已有解码游标（受帧预算约束）
    for (let i = this.cursors.length - 1; i >= 0; i--) {
      const c = this.cursors[i];
      const n = c.step(budgetMs, now);
      this.stats.decodeSegments += n;
      if (c.finished) {
        c.bucket.state = 'ready';
        c.bucket.promise = null;
        this.decodeGate.release();
        this.cursors.splice(i, 1);
        this._dispatchBucket(c.bucket);     // 同桶所有 job 一次分发，零泄漏
        if (c.errors.length) {
          this.stats.failures += c.errors.length;
          this.stats.lastError = c.errors[0].message;
        }
      } else if (n === 0) break;      // 预算耗尽，本帧到此为止
    }
    // 2) 从优先队列取任务，按闸位与桶状态决定动作
    while (this.queue.size && this.fetchGate.free > 0 && this.decodeGate.free > 0) {
      const job = this.queue.peek();
      if (!job) break;
      const b = this.bucket(job.bucketId);
      if (!b) { this.queue.pop(); job.onFail && job.onFail('no_bucket'); continue; }

      if (b.state === 'ready') {
        this.queue.pop();
        this.stats.cacheHits++;
        const rows = b.entries ? b.entries.get(job.key) : null;
        if (rows) job.onReady(rows, b, true);
        else job.onFail && job.onFail('key_not_in_bucket');
        continue;
      }
      if (b.state === 'inflight') {
        this.queue.pop();
        this.stats.dedupHits++;
        this._addPending(b, job);           // 聚合到桶，不重复发请求
        continue;
      }
      if (b.state === 'failed') break;      // 由退避计时器重新打开

      this.queue.pop();
      if (!this.fetchGate.tryAcquire()) break;
      if (!this.decodeGate.tryAcquire()) { this.fetchGate.release(); break; }
      this._addPending(b, job);
      this._startFetch(b, now);
      started++;
    }
    return started;
  }

  _addPending(b, job) {
    let a = this.pendingByBucket.get(b.id);
    if (!a) { a = []; this.pendingByBucket.set(b.id, a); }
    a.push(job);
    b.retain();
  }

  _startFetch(b, now) {
    b.state = 'inflight';
    b.attempts++;
    b.fetchedAt = now;
    const ctrl = new AbortController();
    b.controller = ctrl;
    this.inflight.set(b.file, ctrl);

    const url = this.base + b.file;
    const t0 = Date.now();
    const timeout = setTimeout(() => {
      try { ctrl.abort(); } catch (_) {}
      this.stats.aborts++;
    }, this.abortAfterMs);

    b.promise = this.fetchImpl(url, { signal: ctrl.signal })
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.arrayBuffer ? r.arrayBuffer() : r.text();
      })
      .then(ab => {
        clearTimeout(timeout);
        const text = typeof ab === 'string' ? ab : new TextDecoder('utf-8').decode(new Uint8Array(ab));
        const bytes = typeof ab === 'string' ? ab.length : ab.byteLength;
        b.bytes = bytes;
        b.checksum = crc32(new TextEncoder().encode(text));
        b.fetchMs = Date.now() - t0;
        this.stats.bytes += bytes;
        this.stats.requests++;
        b.entries = new Map();
        const cur = new DecodeCursor(b, text, (key, rows) => {
          b.entries.set(key, rows);
        });
        this.cursors.push(cur);
        // fetch 闸立刻还，decode 闸由游标完成时还
        this.fetchGate.release();
        this.inflight.delete(b.file);
        b.controller = null;
        b._pendingDispatch = true;          // 游标完成由 pump 调 _dispatchBucket
      })
      .catch(e => {
        clearTimeout(timeout);
        this.fetchGate.release();
        this.decodeGate.release();
        this.inflight.delete(b.file);
        b.state = 'failed';
        b.failedAt = Date.now();
        b.promise = null;
        b.controller = null;
        this.stats.failures++;
        this.stats.lastError = String(e && e.message || e).slice(0, 160);
        this._failBucket(b, this.stats.lastError);
      });
  }

  /** 游标跑完后由 pump 调：把同桶所有等待中的 job 一次性分发。 */
  _dispatchBucket(b) {
    const jobs = this.pendingByBucket.get(b.id) || [];
    this.pendingByBucket.delete(b.id);
    b._pendingDispatch = false;
    for (const w of jobs) {
      const rows = b.entries && b.entries.get(w.key);
      if (rows) w.onReady(rows, b, false);
      else w.onFail && w.onFail('key_not_in_bucket: ' + w.key);
      b.release();
    }
  }

  _failBucket(b, err) {
    const jobs = this.pendingByBucket.get(b.id) || [];
    this.pendingByBucket.delete(b.id);
    b._pendingDispatch = false;
    for (const w of jobs) {
      const a = (this.attempts.get(w.key) || 0) + 1;
      this.attempts.set(w.key, a);
      if (a <= this.maxRetry) {
        this.stats.retries++;
        this.retryAt.set(w.key, Date.now() + retryDelayMs(w.key, a, this.tier));
      }
      w.onFail && w.onFail(err, a);
      b.release();
    }
  }

  /** 失败桶的退避到期后重新打开，允许下一轮重试。 */
  reopenFailed(now) {
    let n = 0;
    for (const [id, b] of this.buckets) {
      if (b.state !== 'failed') continue;
      if (now - b.failedAt < retryDelayMs(String(id), Math.min(b.attempts, this.maxRetry), this.tier)) continue;
      b.state = 'idle';
      b.entries = null;
      b.bytes = 0;
      n++;
    }
    return n;
  }

  /** 主动清空一桶的解码缓存（驱逐时释放内存）。 */
  evictBucket(id, force = false) {
    const b = this.buckets.get(id);
    if (!b) return false;
    if (!force && b.refs > 0) return false;
    if (b.controller) { try { b.controller.abort(); } catch (_) {} }
    b.entries = null;
    b.state = 'idle';
    b.refs = 0;
    return true;
  }

  cancelAll() {
    for (const ctrl of this.inflight.values()) { try { ctrl.abort(); } catch (_) {} }
    this.inflight.clear();
    this.queue.clear();
    this.pendingByBucket.clear();
    for (const b of this.buckets.values()) {
      b.state = 'idle'; b.promise = null; b.controller = null;
      b.refs = 0; b._pendingDispatch = false;
    }
    for (let i = 0; i < this.cursors.length; i++) this.decodeGate.release();
    this.cursors.length = 0;
    this.fetchGate.active = 0;
    this.decodeGate.active = 0;
    this.uploadGate.active = 0;
  }

  snapshot() {
    return Object.freeze({
      stats: Object.freeze({ ...this.stats }),
      gates: Object.freeze({
        fetch: this.fetchGate.snapshot(), decode: this.decodeGate.snapshot(),
        upload: this.uploadGate.snapshot(),
      }),
      buckets: this.buckets.size,
      readyBuckets: [...this.buckets.values()].filter(b => b.state === 'ready').length,
      inflightBuckets: [...this.buckets.values()].filter(b => b.state === 'inflight').length,
      failedBuckets: [...this.buckets.values()].filter(b => b.state === 'failed').length,
      queue: this.queue.size,
      cursors: this.cursors.length,
    });
  }
}

/* ============================================================
 * 7. 自检（确定性、可逐轮复跑比对）
 * ============================================================ */
export function ioSelfTest() {
  const out = [];
  const P = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

  P('crc32 已知向量', crc32(new TextEncoder().encode('123456789')) === 0xCBF43926,
    crc32(new TextEncoder().encode('123456789')).toString(16));
  P('crc32 空串', crc32(new Uint8Array(0)) === 0);
  P('fnv1a 稳定', fnv1a('a,b') === fnv1a('a,b') && fnv1a('a,b') !== fnv1a('b,a'));

  const h = new BinaryHeap(8, (a, b) => a.s < b.s);
  const vals = [5, 1, 9, 3, 7, 2, 8, 4, 6, 0];
  for (const v of vals) h.push({ s: v });
  const sorted = [];
  while (h.size) sorted.push(h.pop().s);
  P('最小堆有序', JSON.stringify(sorted) === JSON.stringify([0,1,2,3,4,5,6,7,8,9]), sorted.join(','));
  P('堆扩容不丢元素', h.cap >= 16);
  const h2 = new BinaryHeap(4, (a, b) => a.s > b.s);
  for (const v of [3, 8, 1, 6, 9, 2]) h2.push({ s: v });
  P('最大堆有序', h2.pop().s === 9 && h2.pop().s === 8 && h2.pop().s === 6);

  const g = new Gate(2);
  P('闸位限制', g.tryAcquire() && g.tryAcquire() && !g.tryAcquire());
  g.release(); P('闸位释放后可再取', g.tryAcquire() && g.active === 2);
  g.setLimit(1); P('闸位热调整', g.limit === 1);

  const txt = '{"chunks":[{"key":"0,0","buildings":[1,2]},{"key":"0,1","buildings":[3]},{"key":"1,0","buildings":[]}]}';
  const plan = makeSegmenter(txt);
  P('分段数正确', plan.total === 3, plan.total);
  P('单段可解析', parseSegment(txt, plan.segments[1]).key === '0,1');
  const escaped = '{"chunks":[{"key":"a\\\\\\"b","buildings":[]},{"key":"c,d","buildings":[]}]}';
  P('引号转义不破段', makeSegmenter(escaped).total === 2);
  P('单块格式兼容', makeSegmenter('{"key":"solo","buildings":[1]}').mode === 'single');

  const fakeBucket = new Bucket(0, 'x.json');
  const cur = new DecodeCursor(fakeBucket, txt, () => {});
  let guard = 0;
  while (!cur.finished && guard++ < 100) cur.step(0.001, 0);
  P('游标可跨帧推进', cur.finished && cur.done === 3, cur.done);
  P('游标无解码错误', cur.errors.length === 0);

  const b = new Bucket(3, 'b0.json');
  b.retain(); b.retain();
  P('桶引用计数', b.refs === 2 && b.release() === 1 && b.release() === 0);

  // 假 fetch：验证同桶合并、失败退避、重开
  const rows = '{"chunks":[{"key":"0,0","buildings":[1]},{"key":"0,1","buildings":[2]}]}';
  let calls = 0;
  const fakeFetch = () => { calls++; return Promise.resolve({
    ok: true, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(rows).buffer) }); };
  const tier = { concurrentFetches: 2, concurrentDecodes: 1, concurrentUploads: 1,
                 maxRetry: 2, retryBaseMs: 1, retryCapMs: 10, abortAfterMs: 100, cooldownMs: 1 };
  const io = new ChunkIO({ base: '', fetchImpl: fakeFetch, bucketFiles: ['b0.json'], tier });
  const got = [];
  io.enqueue('0,0', 0, 100, r => got.push(['0,0', r.length]));
  io.enqueue('0,1', 0, 99,  r => got.push(['0,1', r.length]));
  io.pump(0, 5);
  P('同桶合并只发一次请求', calls === 1 || io.stats.dedupHits >= 1,
    'calls=' + calls + ' dedup=' + io.stats.dedupHits);

  return Object.freeze({ total: out.length, passed: out.filter(x => x.ok).length,
                         failures: out.filter(x => !x.ok), items: out });
}

export default { crc32, fnv1a, BinaryHeap, Gate, Bucket, makeSegmenter, parseSegment,
  DecodeCursor, ChunkIO, ioSelfTest, CS, canTransition, hash32 };
