// ============================================================
// integration_boot.js — V4 集成引导
// 在主场景就绪后挂载 V4 扩展：分块流式器（16 块 + 三档 LOD）
// 与高保真双 Loader 管线。独立于 main.js，无侵入，可单独摘除。
// ============================================================
import { initHifiLoaders } from './hifi_loader.js';
import { attachCityStreamer } from './city_streamer_v3.js';
import { propsBudget } from './street_props.js';

function boot() {
  // [MC-PERF] 最省档：跳过 V4 扩展（分块流式 + 街道陈设 864 实例），
  // 弱机扛不住这部分开销；全配 / 精简档照常挂载。
  if (window.__mcPerf && window.__mcPerf.tier === 'min') {
    console.log('[v4boot] 最省档：跳过城区流式扩展');
    return;
  }
  // 找主渲染器：main.js 挂在 window.__renderer / document 上，逐一探测
  const renderer = window.__renderer
    || (window.THREE_PC && window.THREE_PC.renderer)
    || null;
  if (!renderer) {
    console.warn('[v4boot] renderer not found, retry in 1s');
    setTimeout(boot, 1000);
    return;
  }
  const scene = window.__scene || renderer.scene || null;
  const camera = window.__camera || null;
  if (!scene || !camera) {
    console.warn('[v4boot] scene/camera not ready, retry in 1s');
    setTimeout(boot, 1000);
    return;
  }
  const loadMgr = window.__loadMgr || undefined;
  initHifiLoaders(loadMgr, renderer);
  const streamer = attachCityStreamer(scene, camera, {
    lodRadii: { h0: 180, h1: 420 },
  });
  window.__V4_STREAMER = streamer;
  console.log('[v4boot] city_streamer_v3 attached, props budget:', propsBudget());
  // 主循环勾子：main.js 每帧调用 window.__onFrame 时同步升降档
  if (typeof window.__onFrame === 'function') {
    const prev = window.__onFrame;
    window.__onFrame = (dt) => { prev(dt); streamer.update(dt); };
  } else {
    window.__onFrame = (dt) => streamer.update(dt);
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(boot, 800);
} else {
  window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
}
