// ============================================================
// city_streamer_v3.js — V4 分块流式加载（高模档位 + 扩展地块）
// ============================================================
// ⚠️⚠️⚠️ DEAD CODE —— [2026-11-20 审查修复 F-30] ⚠️⚠️⚠️
// 经全量审查确认：本文件**没有在任何页面接线**（index.html 已摘除
// integration_boot/city_streamer 引用，main.js 也从未调用 __onFrame），
// V4 流式链路从未上线运行。保留仅作设计备查。
// 如果将来要启用：需在 index.html 接回脚本、在主循环调用 __onFrame，
// 并先修掉审查发现的内部缺陷（覆盖 2km 注释 5km / 首帧全建 / LOD 不隐藏 /
// H0 不卸载 / dispose 不释放资源 / loadHifiGLB 未 init 同步抛错）。
// 误把本文件当作已上线逻辑会得出错误结论。
// ============================================================
// 在 V3 的 9 块 superChunk(M500) 基础上扩展：
//   · 地块网格从 9 块扩到 16 块（4x4 覆盖 5km x 5km 全域）
//   · 每块三档 LOD：H0 高模（assets_hifi） / H1 中模（程序化） / H2 远景盒
//   · 按相机距离动态升降档，配合 config.streaming.lodRadii
//   · 挂接 street_props 街道陈设扩量生成
// 无侵入：不改动 main.js 既有管线，导出 attachCityStreamer(scene, camera)。
// ============================================================
import { preloadBatch, loadHifiGLB, loadHifiManifest } from './hifi_loader.js';
import { populateStreetProps } from './street_props.js';

const CHUNK = 500; // 米
const GRID = 4;     // 4x4 = 16 块

const DEFAULT_LOD_RADII = { h0: 180, h1: 420 }; // 超出 h1 距离降为远景盒

export function makeStreamConfig(override = {}) {
  return {
    chunkSize: CHUNK,
    grid: GRID,
    lodRadii: { ...DEFAULT_LOD_RADII, ...(override.lodRadii || {}) },
    maxConcurrent: override.maxConcurrent || 6,
    preloadBatches: override.preloadBatches || ['batch-01'],
  };
}

/** 生成分块索引：返回 16 块的 {id, cx, cz, priority}（按距原点近先） */
export function buildChunkIndex(cfg = makeStreamConfig()) {
  const half = (cfg.grid * cfg.chunkSize) / 2;
  const chunks = [];
  for (let ix = 0; ix < cfg.grid; ix++) {
    for (let iz = 0; iz < cfg.grid; iz++) {
      const cx = -half + (ix + 0.5) * cfg.chunkSize;
      const cz = -half + (iz + 0.5) * cfg.chunkSize;
      chunks.push({
        id: `sc_${ix}_${iz}`,
        cx, cz,
        priority: Math.round(Math.hypot(cx, cz)),
      });
    }
  }
  chunks.sort((a, b) => a.priority - b.priority);
  return chunks;
}

/**
 * 把流式器挂到场景上。
 * @returns {{update(dt), stats(), dispose()}}
 */
export function attachCityStreamer(scene, camera, opts = {}) {
  const cfg = makeStreamConfig(opts);
  const chunks = buildChunkIndex(cfg);
  const state = new Map(); // id -> {lod: 0|1|2, group: THREE.Group|null}
  const inflight = new Set();

  // 空闲预热高模弹药（不阻塞首屏）
  const warmup = (async () => {
    try {
      await loadHifiManifest();
      for (const b of cfg.preloadBatches) preloadBatch(b, 12).catch(() => {});
    } catch (e) { console.warn('[streamer] warmup skipped:', e); }
  })();

  function ensureGroup(ch) {
    let s = state.get(ch.id);
    if (!s) { s = { lod: 2, group: null }; state.set(ch.id, s); }
    if (!s.group) {
      s.group = populateStreetProps(ch);
      scene.add(s.group);
    }
    return s;
  }

  function setLod(ch, lod) {
    const s = ensureGroup(ch);
    s.lod = lod;
    // H0/H1 内容由 populateStreetProps 的 visible 开关控制；
    // 高模 GLB 按 key 懒挂（挂过即缓存于 hifi_loader 内部 Map）。
    if (lod === 0 && !s.hifiKey && !inflight.has(ch.id)) {
      inflight.add(ch.id);
      const key = `assets_hifi/batch-01/kaykit_citybuilder/${(Math.abs(ch.cx * 7 + ch.cz * 13) % 12) + 1}.glb`;
      loadHifiGLB(key).then(g => {
        g.scene.position.set(ch.cx, 0, ch.cz);
        s.group.add(g.scene);
        s.hifiKey = key;
      }).catch(() => {}).finally(() => inflight.delete(ch.id));
    }
  }

  function update() {
    const cam = camera.position;
    for (const ch of chunks) {
      const d = Math.hypot(cam.x - ch.cx, cam.z - ch.cz);
      const lod = d < cfg.lodRadii.h0 ? 0 : d < cfg.lodRadii.h1 ? 1 : 2;
      const s = state.get(ch.id);
      if (!s || s.lod !== lod) setLod(ch, lod);
    }
  }

  function stats() {
    let h0 = 0, h1 = 0, h2 = 0;
    for (const s of state.values()) {
      if (s.lod === 0) h0++; else if (s.lod === 1) h1++; else h2++;
    }
    return { chunks: chunks.length, h0, h1, h2, inflight: inflight.size };
  }

  function dispose() {
    for (const s of state.values()) if (s.group) scene.remove(s.group);
    state.clear();
  }

  return { update, stats, dispose, warmup };
}
