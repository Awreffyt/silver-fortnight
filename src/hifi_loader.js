// ============================================================
// hifi_loader.js — V4 高保真资产双 Loader 管线
// 作用：统一接入 assets_hifi/ 下的 Draco GLB（batch-01/03）
//       与外链 KTX2 的 GLB（batch-02），并按 manifest.json 索引
//       供 city_streamer_v3 / street_props 按需流式加载。
// 依赖：three r169（GLTFLoader / DRACOLoader / KTX2Loader）
// 注意（B线交接）：KTX2Loader 必须 setTranscoderPath + detectSupport，
//                Draco 必须 setDecoderPath，漏配会静默黑贴图。
// ============================================================
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const MANIFEST_URL = './assets_hifi/manifest.json';

let _loaders = null;
let _manifest = null;
const _cache = new Map(); // path -> Promise<GLTF>

/**
 * 初始化双管线。renderer 用于 KTX2 纹理格式探测（ASTC/ETC/BC 自动分档）。
 * @param {THREE.LoadingManager} loadMgr
 * @param {THREE.WebGLRenderer} renderer
 */
export function initHifiLoaders(loadMgr, renderer) {
  if (_loaders) return _loaders;
  const draco = new DRACOLoader(loadMgr).setDecoderPath('../../vendor/draco/');
  let ktx2 = null;
  try {
    ktx2 = new KTX2Loader(loadMgr)
      .setTranscoderPath('../../vendor/basis/')
      .detectSupport(renderer);
  } catch (e) {
    console.warn('[hifi_loader] KTX2 transcoder init failed, batch-02 disabled:', e);
  }
  const gltfDraco = new GLTFLoader(loadMgr).setDRACOLoader(draco);
  const gltfKtx2 = ktx2
    ? new GLTFLoader(loadMgr).setKTX2Loader(ktx2)
    : null;
  _loaders = { draco, ktx2, gltfDraco, gltfKtx2 };
  return _loaders;
}

/**
 * 拉取资产索引（assets_hifi/manifest.json）。
 * 返回 { batches: { 'batch-01': {count, files:[{path,bytes}]}, ... }, total_bytes }
 */
export async function loadHifiManifest() {
  if (_manifest) return _manifest;
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
  _manifest = await res.json();
  return _manifest;
}

/** 按 batch 名列出该批全部资产路径（可选按扩展名过滤） */
export async function listBatch(batch, ext) {
  const m = await loadHifiManifest();
  const b = m.batches[batch];
  if (!b) return [];
  return b.files
    .map(f => f.path)
    .filter(p => (ext ? p.endsWith(ext) : true));
}

/**
 * 按需加载单个 GLB。根据 manifest 中的批次归属自动选择 loader：
 *   batch-02（外链 KTX2）→ gltfKtx2，其余 → gltfDraco。
 * @returns {Promise<{scene:THREE.Group, animations:Array}>}
 */
export function loadHifiGLB(relPath) {
  if (_cache.has(relPath)) return _cache.get(relPath);
  if (!_loaders) throw new Error('hifi_loader: call initHifiLoaders() first');
  const isKtx2 = relPath.includes('batch-02');
  const loader = isKtx2 ? _loaders.gltfKtx2 : _loaders.gltfDraco;
  if (!loader) throw new Error(`hifi_loader: KTX2 pipeline unavailable for ${relPath}`);
  const p = new Promise((resolve, reject) => {
    loader.load(relPath, g => resolve(g), undefined, err => reject(err));
  });
  _cache.set(relPath, p);
  return p;
}

/** 预热一批（用于空闲时段后台拉取，不阻塞主线程渲染） */
export function preloadBatch(batch, limit = Infinity) {
  return listBatch(batch, '.glb').then(paths => {
    const slice = paths.slice(0, limit);
    return Promise.allSettled(slice.map(p => loadHifiGLB(p)));
  });
}

export function hifiStats() {
  return { cached: _cache.size, manifestLoaded: !!_manifest };
}
