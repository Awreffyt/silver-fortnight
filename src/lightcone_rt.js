/**
 * ============================================================================
 *  光锥光追系统 · 单文件整合版（lightcone-rt single-file build）
 * ============================================================================
 *  版本 1.0.0（2026-11-25）· 由 tools/bundle.mjs 自动生成，请勿手改；
 *  模块化源码与测试在本项目内，重打包： node tools/bundle.mjs
 *
 *  内容：六条对接契约 + BufferGeometry 适配器 + CPU BVH(SAH) + TLAS +
 *        WebGPU compute 路径追踪（体积光锥/水面波光/地面湿反射/角色软阴影/
 *        渐进累积）+ 移动端极限优化 + 无 WebGPU 静默降级。
 *
 *  游戏侧接入（唯一入口 GameAdapter）：
 *    import { GameAdapter } from './光锥光追系统-单文件整合版.js';
 *    const lcr = await GameAdapter.create({ canvas, outputMode: 'A' });
 *    lcr.mount('3,7', geometryGroup, ['stucco','mixed','glass']);  // 契约二
 *    lcr.unmount('3,7');
 *    // 每帧：
 *    lcr.syncCamera(myThreeCamera);                                // 契约三
 *    lcr.setDynamicObjects([{ translation: [x,y,z] }]);            // 角色代理
 *    const r = lcr.render(dt);                                     // 契约五：
 *    // r.texture 即线性 HDR 运行和纹理（÷ r.sampleCount 后由游戏 tonemap 合成）
 *    // lcr.mode === 'raster-fallback' 时光追休眠，游戏沿用现有管线（契约六）
 *
 *  详细契约说明见项目 README.md。
 * ============================================================================
 */


/* ════════════════ 契约常量（六条契约唯一事实来源）（原 src/contract/types.js） ════════════════ */

/**
 * ============================================================================
 * 光锥光追系统 · 契约常量与校验（Contract Types）
 * ============================================================================
 *
 * 本文件是「游戏 ⇆ 光追」对接契约的唯一事实来源（Single Source of Truth）。
 * 游戏侧与光追侧都必须 import 这里的常量，禁止任何一侧私自定义第二份。
 *
 * 契约总纲（六条，与《兼容契约》文档一一对应）：
 *   一、数据入口契约 —— 几何格式 / 坐标系 / 块 key / 分桶 / 材质 ID
 *   二、生命周期契约 —— mount / unmount（幂等，unmount 必须释放 BVH）
 *   三、状态同步契约 —— 相机位姿 / 光照预设 / 失效信号（清累积防鬼影）
 *   四、材质契约     —— 三档 facade 贴图路径 / 粗糙度 / 顶点色扰
 *   五、渲染输出契约 —— (A) 光追产纹理交回游戏合成；分辨率与 tonemapping
 *                       归属写死：光追管累积分辨率与内部 HDR，游戏管最终
 *                       展示分辨率与 tonemapping 合成。
 *   六、降级契约     —— 无 WebGPU → mode = 'raster-fallback'，光追静默休眠，
 *                       游戏沿用现有光栅化路径，绝不抛出未捕获异常。
 * ============================================================================
 */

/** 坐标系约定：Y-up，右手系，单位 = 米（与 Three.js 一致，不做任何坐标变换） */
const COORDINATE_SYSTEM = Object.freeze({
  up: 'Y',
  handedness: 'right',
  unit: 'meter',
});

/**
 * 契约一：几何 attribute 布局。
 * 顺序即语义，全部 float32，不接受 half-float / int / normalized attribute。
 */
const REQUIRED_ATTRIBUTES = Object.freeze([
  { name: 'position', itemSize: 3, semantic: 'POSITION' },
  { name: 'normal',   itemSize: 3, semantic: 'NORMAL' },
  { name: 'uv',       itemSize: 2, semantic: 'TEXCOORD_0' },
  { name: 'color',    itemSize: 3, semantic: 'COLOR_0' }, // 逐栋 UV 偏移/翻转/色扰
]);

/**
 * 契约一：材质 ID 表。
 * 光追侧据此建 ID → BSDF 映射（见 rt/MaterialLibrary.js），游戏侧只传字符串。
 * 顺序即索引：0 = stucco（低层矮墙/涂料），1 = mixed（中层混合立面），
 * 2 = glass（高层玻璃幕墙，带透射）。
 */
const MATERIAL_IDS = Object.freeze(['stucco', 'mixed', 'glass']);
const MATERIAL_INDEX = Object.freeze(
  Object.fromEntries(MATERIAL_IDS.map((id, i) => [id, i]))
);

/**
 * 契约一：高度分桶。
 * 区块几何按顶点 Y（世界系，米）分 3 桶 merge，桶索引 0/1/2 分别绑定
 * MATERIAL_IDS[0/1/2]。边界值采用「下闭上开」：bucket = y < h1 ? 0 : y < h2 ? 1 : 2。
 * 这三个阈值是硬契约，游戏侧预处理与光追侧校验必须一致。
 */
const HEIGHT_BUCKETS = Object.freeze({
  thresholds: [18, 45],          // h1 = 18m，h2 = 45m
  count: 3,
  bucketOf(y) {
    return y < this.thresholds[0] ? 0 : y < this.thresholds[1] ? 1 : 2;
  },
});

/**
 * 契约一：块 key 规则。
 * key = `"ix,iz"`，ix/iz 为整数区块坐标（可负）。
 * 允许的字符集合：[0-9,-] 恰好一个逗号，两侧为可序列化整数。
 */
const KEY_RE = /^-?\d+,-?\d+$/;

/** 校验并解析块 key。非法 key 直接抛错——契约错误必须在接入层暴露。 */
function parseChunkKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new TypeError(
      `[契约] 非法块 key："${key}"。契约要求 "ix,iz" 整数对，例如 "3,-7"。`
    );
  }
  const [ix, iz] = key.split(',').map((s) => parseInt(s, 10));
  return { ix, iz };
}

/** 契约一：块 userData 结构（游戏侧 merge 工具应写入，光追侧校验读取） */
function validateChunkUserData(userData) {
  const missing = ['key', 'cx', 'cz', 'count', 'file'].filter(
    (k) => !(k in userData)
  );
  if (missing.length) {
    throw new TypeError(
      `[契约] userData 缺少字段：${missing.join(', ')}（要求 {key,cx,cz,count,file}）`
    );
  }
  const { ix, iz } = parseChunkKey(userData.key);
  if (userData.cx !== ix || userData.cz !== iz) {
    throw new TypeError(
      `[契约] userData.cx/cz (${userData.cx},${userData.cz}) 与 key (${ix},${iz}) 不一致`
    );
  }
  if (!Number.isFinite(userData.count) || userData.count <= 0) {
    throw new TypeError(`[契约] userData.count 必须为正数，得到 ${userData.count}`);
  }
  return true;
}

/** 契约四：材质贴图路径模板（相对游戏资源根目录） */
const FACADE_TEXTURES = Object.freeze({
  root: 'textures/real',
  colorPath(id) {
    if (!MATERIAL_INDEX.hasOwnProperty(id)) {
      throw new TypeError(`[契约] 未知材质 ID："${id}"`);
    }
    return `${this.root}/facade_${id}_color.webp`;
  },
  size: 2048,
  colorSpace: 'srgb',
});

/** 契约四：BSDF 标量参数（光追侧建 ID→BSDF 表时的基准值） */
const BSDF_PARAMS = Object.freeze({
  stucco: { roughness: 0.84, metalness: 0.0, transmission: 0.0 },
  mixed:  { roughness: 0.84, metalness: 0.0, transmission: 0.0 },
  glass:  { roughness: 0.06, metalness: 0.0, transmission: 0.92 }, // 幕墙：近乎镜面 + 高透射
});

/**
 * 契约二：生命周期签名。
 * mount(key, geometryGroup, materialIDs) —— 幂等；重复 mount 同一 key 直接返回，
 *   不重复建 BVH。geometryGroup 为 { buckets: [Geometry|null,×3], userData }。
 * unmount(key) —— 必须释放该块 BLAS 显存；对不存在的 key 调用是空操作不抛错。
 */
const LIFECYCLE_SIGNATURE = Object.freeze({
  mount: 'mount(key: string, geometryGroup: GeometryGroup, materialIDs: string[]) => MountResult',
  unmount: 'unmount(key: string) => void',
});

/**
 * 契约三：光照预设。
 * day / night / dusk 三档，数值为物理量纲：
 *   sunDir 单位向量（指向太阳），sunColor 线性 RGB 辐亮度系数，
 *   sunAngularRadius 弧度（决定软阴影半影宽度），ambient 天空环境辐射。
 */
const LIGHT_PRESETS = Object.freeze({
  day: {
    sunDir: [0.42, 0.78, 0.46],
    sunColor: [1.0, 0.96, 0.88].map((v) => v * 5.2),
    sunAngularRadius: 0.0093, // 约 0.53°，真实太阳视直径
    ambient: [0.36, 0.44, 0.55],
    exposure: 1.0,
  },
  dusk: {
    sunDir: [0.94, 0.16, 0.30],
    sunColor: [1.0, 0.52, 0.28].map((v) => v * 3.4),
    sunAngularRadius: 0.0093,
    ambient: [0.20, 0.17, 0.24],
    exposure: 1.15,
  },
  night: {
    sunDir: [-0.35, 0.55, -0.20], // 月光方向
    sunColor: [0.62, 0.70, 0.92].map((v) => v * 0.55),
    sunAngularRadius: 0.0045,
    ambient: [0.045, 0.055, 0.085],
    exposure: 1.6,
  },
});

/** 契约五：输出模式。本实现固定采用 A；B 保留枚举位以便将来扩展。 */
const OUTPUT_MODE = Object.freeze({ COMPOSITE_TEXTURE: 'A', TAKEOVER: 'B' });

/**
 * 契约五（写死的归属划分）：
 *   光追负责：内部累积分辨率（qualityScale × 基准）、HDR 累积缓冲、
 *             去噪/累积平均、内部 gamma 编码前的线性 HDR 输出纹理。
 *   游戏负责：最终展示分辨率（画布/视口尺寸）、tonemapping（ACES 等）、
 *             与光栅层的混合合成。
 * 交接物：RTFrame.presentTexture（WebGPU 纹理）+ presentCanvas（可直接叠加），
 * 游戏合成层按「线性 HDR 已由光追完成 TAA 式累积平均」假设接入。
 */
const OWNERSHIP = Object.freeze({
  resolution: 'game 展示分辨率归游戏；光追内部累积分辨率归光追（qualityScale 可调）',
  tonemapping: 'tonemapping 归游戏合成层；光追输出线性 HDR 纹理，同时自带可选的 sRGB present 画布用于独立运行/调试',
});

/** 契约六：运行模式。游戏侧据此决定是否启用现有光栅化路径。 */
const RUN_MODE = Object.freeze({
  WEBGPU_RT: 'webgpu-rt',
  RASTER_FALLBACK: 'raster-fallback',
});

/** 系统全局固定参数（不属于契约，属于本实现的设计决策） */
const SYSTEM_DEFAULTS = Object.freeze({
  maxBouncesPC: 4,
  maxBouncesMobile: 2,
  samplesPerFrame: 1,
  accumulationLimitPC: 1024,
  accumulationLimitMobile: 256,
  vrampBudgetMobileMB: 96,   // 移动端显存硬预算（MB），超出即降分辨率
  vrampBudgetPCMB: 512,
});

/* ════════════════ 契约一适配器（校验/分桶合并/adaptGeometry）（原 src/contract/GeometryAdapter.js） ════════════════ */

/**
 * ============================================================================
 * 契约一适配器：BufferGeometry → 光追内部格式（分桶 merge / 校验 / 顶点复扫）
 * ============================================================================
 *
 * 游戏侧传入的 geometryGroup 形如：
 * {
 *   buckets: [Geometry|null, Geometry|null, Geometry|null],  // 高度 3 桶
 *   userData: { key, cx, cz, count, file },
 * }
 * 其中 Geometry 是 Three.js 风格对象（duck typing，不要求真的 Three 实例）：
 *   geometry.attributes.position = { array: Float32Array, itemSize: 3 }
 *   geometry.index 可空（非索引则按三顶点一三角面解析）
 *
 * 本适配器做四件事：
 *   1. 严格校验契约一（attribute 名单 / float32 / itemSize / 长度一致）
 *   2. 校验 userData（契约一：{key,cx,cz,count,file} 且与 key 一致）
 *   3. 把三桶合并为单一 SoA 顶点流 + 三角形索引流（光追 BVH 的输入格式）
 *   4. 每三角形写入材质槽位 = 桶索引（0/1/2 → stucco/mixed/glass）
 *
 * 输出 ChunkMeshData：
 *   positions : Float32Array  (n*3)
 *   normals   : Float32Array  (n*3)
 *   uvs       : Float32Array  (n*2)
 *   colors    : Float32Array  (n*3)
 *   indices   : Uint32Array   (m*3，三角形 → 顶点)
 *   matIDs    : Uint8Array    (m  ，三角形材质槽 0/1/2)
 *   triCount / vertCount / center (包围盒中心，供 TLAS 实例放置)
 * ============================================================================
 */


/** 校验单个 attribute 的形状契约，返回 {array, itemSize} */
function checkAttribute(geometry, name, bucketLabel) {
  const attr = geometry.attributes && geometry.attributes[name];
  if (!attr || !attr.array) {
    throw new TypeError(`[契约一] ${bucketLabel} 缺少 attribute "${name}"`);
  }
  const spec = REQUIRED_ATTRIBUTES.find((a) => a.name === name);
  if (attr.itemSize !== spec.itemSize) {
    throw new TypeError(
      `[契约一] ${bucketLabel} attribute "${name}" itemSize=${attr.itemSize}，契约要求 ${spec.itemSize}`
    );
  }
  // 明确检查 float32 家族（Float32Array 为准；容忍普通 Array 但要求可转）
  if (!(attr.array instanceof Float32Array)) {
    if (!Array.isArray(attr.array)) {
      throw new TypeError(
        `[契约一] ${bucketLabel} attribute "${name}" 必须 float32，得到 ${attr.array.constructor.name}`
      );
    }
  }
  const count = attr.array.length / attr.itemSize;
  if (!Number.isInteger(count) || count === 0) {
    throw new TypeError(
      `[契约一] ${bucketLabel} attribute "${name}" 长度 ${attr.array.length} 不是 itemSize ${attr.itemSize} 的整数倍`
    );
  }
  return { array: attr.array, itemSize: attr.itemSize, count };
}

/** 把一个（可能带索引的）geometry 展开为三角形列表，返回 {triCount, 顶点重映射读取器} */
function expandTriangles(geometry, bucketLabel) {
  const pos = checkAttribute(geometry, 'position', bucketLabel);
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.count / 3;
  if (!Number.isInteger(triCount) || triCount === 0) {
    throw new TypeError(`[契约一] ${bucketLabel} 三角形数为 0 或非法`);
  }
  return { pos, idx, triCount };
}

/**
 * mergeChunkGeometry(geometryGroup) → ChunkMeshData
 * 契约错误一律 throw TypeError；调用方（GameAdapter.mount）捕获后必须
 * 原样上报给游戏错误通道，不得静默吞掉——这是「不糊弄」的第一道闸。
 */
function mergeChunkGeometry(geometryGroup) {
  if (!geometryGroup || !Array.isArray(geometryGroup.buckets)) {
    throw new TypeError('[契约一] geometryGroup.buckets 必须是长度 3 的数组');
  }
  if (geometryGroup.buckets.length !== HEIGHT_BUCKETS.count) {
    throw new TypeError(
      `[契约一] buckets 长度必须为 ${HEIGHT_BUCKETS.count}（高度三桶），得到 ${geometryGroup.buckets.length}`
    );
  }
  if (geometryGroup.userData) validateChunkUserData(geometryGroup.userData);

  // 先扫一遍统计总量，再一次分配（避免逐块 push 造成的 GC 压力）
  let vertTotal = 0;
  let triTotal = 0;
  const expanded = geometryGroup.buckets.map((g, b) => {
    if (!g || !g.attributes || !g.attributes.position) return null; // 空桶合法
    const e = expandTriangles(g, `桶${b}`);
    vertTotal += e.pos.count;
    triTotal += e.triCount;
    return e;
  });

  const positions = new Float32Array(vertTotal * 3);
  const normals   = new Float32Array(vertTotal * 3);
  const uvs       = new Float32Array(vertTotal * 2);
  const colors    = new Float32Array(vertTotal * 3);
  const indices   = new Uint32Array(triTotal * 3);
  const matIDs    = new Uint8Array(triTotal);

  let vBase = 0;
  let tBase = 0;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];

  for (let b = 0; b < 3; b++) {
    const e = expanded[b];
    if (!e) continue;
    const g = geometryGroup.buckets[b];
    const nor = checkAttribute(g, 'normal', `桶${b}`);
    const uv  = checkAttribute(g, 'uv', `桶${b}`);
    const col = checkAttribute(g, 'color', `桶${b}`);

    if (nor.count !== e.pos.count || uv.count !== e.pos.count || col.count !== e.pos.count) {
      throw new TypeError(
        `[契约一] 桶${b} 各 attribute 顶点数不一致：` +
          `pos=${e.pos.count} nor=${nor.count} uv=${uv.count} col=${col.count}`
      );
    }

    // 顶点块拷贝（SoA 平铺）
    positions.set(e.pos.array, vBase * 3);
    normals.set(nor.array instanceof Float32Array ? nor.array : new Float32Array(nor.array), vBase * 3);
    uvs.set(uv.array instanceof Float32Array ? uv.array : new Float32Array(uv.array), vBase * 2);
    colors.set(col.array instanceof Float32Array ? col.array : new Float32Array(col.array), vBase * 3);

    // 包围盒（本桶部分）
    const pa = e.pos.array;
    for (let i = 0; i < e.pos.count; i++) {
      const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
    }

    // 三角形：索引或非索引，重映射到合并后的顶点基址；材质槽 = 桶号
    if (e.idx) {
      for (let t = 0; t < e.triCount; t++) {
        const i0 = e.idx[t * 3], i1 = e.idx[t * 3 + 1], i2 = e.idx[t * 3 + 2];
        if (i0 >= e.pos.count || i1 >= e.pos.count || i2 >= e.pos.count) {
          throw new TypeError(`[契约一] 桶${b} 索引越界：tri#${t} → (${i0},${i1},${i2})`);
        }
        indices[(tBase + t) * 3]     = i0 + vBase;
        indices[(tBase + t) * 3 + 1] = i1 + vBase;
        indices[(tBase + t) * 3 + 2] = i2 + vBase;
        matIDs[tBase + t] = b;
      }
    } else {
      for (let t = 0; t < e.triCount; t++) {
        indices[(tBase + t) * 3]     = t * 3     + vBase;
        indices[(tBase + t) * 3 + 1] = t * 3 + 1 + vBase;
        indices[(tBase + t) * 3 + 2] = t * 3 + 2 + vBase;
        matIDs[tBase + t] = b;
      }
    }
    vBase += e.pos.count;
    tBase += e.triCount;
  }

  if (triTotal === 0) {
    throw new TypeError('[契约一] 区块合并后三角形总数为 0，视为非法区块');
  }

  const center = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];

  return {
    positions, normals, uvs, colors, indices, matIDs,
    vertCount: vertTotal,
    triCount: triTotal,
    boundsMin: min,
    boundsMax: max,
    center,
  };
}

/**
 * 高度分桶工具（契约一）：给游戏侧预处理用的参考实现。
 * 输入一堆任意 mesh（{attributes.position...}），输出 3 桶 merge 后的 geometryGroup。
 * 游戏侧可以直接用，也可以用自己的实现——只要产物过得了本文件顶部的校验。
 */
function bucketizeMeshes(meshes) {
  const buckets = [[], [], []];
  for (const mesh of meshes) {
    const pa = mesh.attributes.position.array;
    const vertCount = pa.length / 3;
    // 以网格自身的 Y 均值决定整块归属（与游戏侧高度预处理语义一致：
    // 一栋楼是一个 mesh，不会跨桶）
    let ySum = 0;
    for (let i = 0; i < vertCount; i++) ySum += pa[i * 3 + 1];
    const bucket = HEIGHT_BUCKETS.bucketOf(ySum / vertCount);
    buckets[bucket].push(mesh);
  }
  return {
    buckets: buckets.map((arr) => (arr.length ? mergeSimple(arr) : null)),
    // userData 由游戏侧补齐 {key,cx,cz,count,file}，这里只占位提醒
    userData: null,
  };
}

/** 极简 merge：同 bucket 内多个 mesh 合并为一个 duck-type geometry */
function mergeSimple(meshes) {
  let vTot = 0, iTot = 0;
  const infos = meshes.map((m) => {
    const vc = m.attributes.position.array.length / 3;
    const tc = m.index ? m.index.array.length / 3 : vc / 3;
    vTot += vc; iTot += tc;
    return { vc, tc };
  });
  const P = new Float32Array(vTot * 3);
  const N = new Float32Array(vTot * 3);
  const U = new Float32Array(vTot * 2);
  const C = new Float32Array(vTot * 3);
  const I = new Uint32Array(iTot * 3);
  let vb = 0, tb = 0;
  meshes.forEach((m, i) => {
    const { vc, tc } = infos[i];
    P.set(m.attributes.position.array, vb * 3);
    N.set(new Float32Array(m.attributes.normal.array), vb * 3);
    U.set(new Float32Array(m.attributes.uv.array), vb * 2);
    C.set(new Float32Array(m.attributes.color.array), vb * 3);
    const mi = m.index ? m.index.array : null;
    for (let t = 0; t < tc; t++) {
      I[(tb + t) * 3]     = (mi ? mi[t * 3]     : t * 3)     + vb;
      I[(tb + t) * 3 + 1] = (mi ? mi[t * 3 + 1] : t * 3 + 1) + vb;
      I[(tb + t) * 3 + 2] = (mi ? mi[t * 3 + 2] : t * 3 + 2) + vb;
    }
    vb += vc; tb += tc;
  });
  return {
    attributes: {
      position: { array: P, itemSize: 3 },
      normal:   { array: N, itemSize: 3 },
      uv:       { array: U, itemSize: 2 },
      color:    { array: C, itemSize: 3 },
    },
    index: { array: I },
  };
}

/**
 * adaptGeometry(key, geometryGroup, materialIDs) —— GameAdapter.mount 的入口。
 * 在 merge 之前补两类跨字段校验（mergeChunkGeometry 只管几何内部形状）：
 *   1. key 一致性：geometryGroup.userData.key 必须与挂载 key 相同
 *      （防游戏侧流式加载时 key 串位——串位会导致 unmount 卸错块）
 *   2. materialIDs 必须是契约一的三档 ID 列表（顺序即槽位 0/1/2）
 */
function adaptGeometry(key, geometryGroup, materialIDs = MATERIAL_IDS) {
  if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)) {
    throw new TypeError(`[契约一] 挂载 key "${key}" 不符合 "ix,iz" 格式`);
  }
  if (geometryGroup.userData && geometryGroup.userData.key !== key) {
    throw new TypeError(
      `[契约一] key 不一致：挂载 key=${key}，userData.key=${geometryGroup.userData.key}`
    );
  }
  if (!Array.isArray(materialIDs) || materialIDs.length !== 3 ||
      materialIDs.some((id, i) => id !== MATERIAL_IDS[i])) {
    throw new TypeError(
      `[契约一] materialIDs 必须为 [${MATERIAL_IDS.join(', ')}]（顺序=桶序），得到 ` +
      JSON.stringify(materialIDs)
    );
  }
  return mergeChunkGeometry(geometryGroup);
}

const MATERIAL_NAMES = MATERIAL_IDS; // 语义别名，方便游戏侧 import
{ MATERIAL_IDS }; // GameAdapter 直接从此处取（契约一单一事实来源在 types.js）

/* ════════════════ CPU BVH 构建器（分箱 SAH BLAS）（原 src/rt/BVH.js） ════════════════ */

/**
 * ============================================================================
 * CPU BVH 构建器（BLAS）—— 二叉包围盒层次，SAH 分箱启发式
 * ============================================================================
 *
 * 每个挂载的区块（chunk）构建一棵 BLAS，输出扁平化为 GPU 友好的 SoA 数组：
 *   nodeMin[3N]  : Float32Array，内部/叶子节点 AABB min
 *   nodeMax[3N]  : Float32Array，AABB max
 *   nodeLeftFirst[2N] : Uint32Array，[0]=左子节点索引 或 首三角形索引
 *                                     [1]=子节点数 或 叶子三角形数（count>0 即叶子）
 *   triIndices   : Uint32Array，三角形重排索引（GPU 侧用它取顶点）
 *
 * 设计要点：
 *   - 分箱 SAH（8 bins），构建 O(n log n) 量级，1 万三角形毫秒级
 *   - 叶子三角形数上限 8，超过继续分裂
 *   - 三角形数据不复制，只重排索引（省显存，unmount 时整体释放即可）
 *   - 释放：dispose() 后引用清零，交给 GC；GPU buffer 的释放由持有方
 *     （ChunkBVHStore）负责——契约二要求 unmount 必须走到那条路
 * ============================================================================
 */

const BIN_COUNT = 8;
const LEAF_MAX_TRIS = 8;

class BLAS {
  /**
   * @param {Object} chunk ChunkMeshData（GeometryAdapter 产物）
   *   需要：positions(Float32Array), indices(Uint32Array), triCount, boundsMin, boundsMax
   */
  constructor(chunk) {
    this.triCount = chunk.triCount;
    const n = chunk.triCount;

    // 预取三角形 AABB + 质心（SAH 只需要这两样）
    this.centroids = new Float32Array(n * 3);
    this.triMin = new Float32Array(n * 3);
    this.triMax = new Float32Array(n * 3);

    const P = chunk.positions;
    const I = chunk.indices;
    for (let t = 0; t < n; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      let mnx = Math.min(P[a], P[b], P[c]);
      let mny = Math.min(P[a + 1], P[b + 1], P[c + 1]);
      let mnz = Math.min(P[a + 2], P[b + 2], P[c + 2]);
      let mxx = Math.max(P[a], P[b], P[c]);
      let mxy = Math.max(P[a + 1], P[b + 1], P[c + 1]);
      let mxz = Math.max(P[a + 2], P[b + 2], P[c + 2]);
      this.triMin[t * 3] = mnx; this.triMin[t * 3 + 1] = mny; this.triMin[t * 3 + 2] = mnz;
      this.triMax[t * 3] = mxx; this.triMax[t * 3 + 1] = mxy; this.triMax[t * 3 + 2] = mxz;
      this.centroids[t * 3]     = (mnx + mxx) * 0.5;
      this.centroids[t * 3 + 1] = (mny + mxy) * 0.5;
      this.centroids[t * 3 + 2] = (mnz + mxz) * 0.5;
    }

    // 构建期工作区
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;

    // 节点数组先用动态数组构建，结束后扁平化
    const nodes = []; // {min:[3], max:[3], leftOrFirst, count}
    // 注意：count=0 表示「内部节点」；叶子必须显式回填 count
    const rootNode = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity], leftOrFirst: 0, count: 0 };
    for (let t = 0; t < n; t++) {
      expand(rootNode.min, rootNode.max, this.triMin, this.triMax, t);
    }

    const tasks = [];
    this._subdivide(rootNode, order, 0, n, nodes);

    // 扁平化：广度写入，leftOrFirst 在写入子节点后再回填
    this.nodeCount = nodes.length;
    this.nodeMin = new Float32Array(this.nodeCount * 3);
    this.nodeMax = new Float32Array(this.nodeCount * 3);
    this.nodeLeftFirst = new Uint32Array(this.nodeCount * 2);
    this.triIndices = new Uint32Array(n);

    // nodes 构建时按树序 push（父先于子），直接顺序写即可
    let triWrite = 0;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      this.nodeMin.set(nd.min, i * 3);
      this.nodeMax.set(nd.max, i * 3);
      if (nd.count > 0) {
        // 叶子：分配一段连续三角形区间
        this.nodeLeftFirst[i * 2] = triWrite;
        this.nodeLeftFirst[i * 2 + 1] = nd.count;
        for (let k = 0; k < nd.count; k++) {
          this.triIndices[triWrite++] = order[nd.leftOrFirst + k];
        }
      } else {
        this.nodeLeftFirst[i * 2] = nd.leftOrFirst;
        this.nodeLeftFirst[i * 2 + 1] = 0;
      }
    }
    this.bytesCPU = this.nodeCount * 32 + n * 4;
    this.disposed = false;
  }

  /** SAH 划分（迭代栈实现）。节点占位只 push 一次：根在进入循环前处理，
   *  子节点在创建时立即占位；循环内只回填字段，绝不重复 push。 */
  _subdivide(root, order, first, count, nodes) {
    // 根自身是叶子的小场景
    if (count <= LEAF_MAX_TRIS) {
      root.count = count; root.leftOrFirst = first;
      nodes.push(root);
      return;
    }
    nodes.push(root); // 根占位（count=0 → 内部，稍后回填 leftOrFirst）
    const stack = [{ node: root, first, count, depth: 0 }];
    while (stack.length) {
      const { node, first, count, depth } = stack.pop();
      if (count <= LEAF_MAX_TRIS || depth > 32) {
        node.count = count;
        node.leftOrFirst = first;
        continue;
      }
      const split = this._bestSplit(node, order, first, count);
      if (!split) {
        node.count = count;
        node.leftOrFirst = first;
        continue;
      }
      // 原地划分 order[first..first+count)
      let i = first, j = first + count - 1;
      while (i <= j) {
        const c = this.centroids[order[i] * 3 + split.axis];
        if (c < split.pos) i++;
        else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
      }
      const leftCount = i - first;
      if (leftCount === 0 || leftCount === count) {
        node.count = count;
        node.leftOrFirst = first;
        continue;
      }
      // 内部节点：leftOrFirst = 左子槽位（右子 = 槽位+1）
      const leftNode  = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity], leftOrFirst: 0, count: 0 };
      const rightNode = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity], leftOrFirst: 0, count: 0 };
      node.leftOrFirst = nodes.length;
      nodes.push(leftNode, rightNode);
      for (let t = first; t < first + leftCount; t++)
        expand(leftNode.min, leftNode.max, this.triMin, this.triMax, order[t]);
      for (let t = first + leftCount; t < first + count; t++)
        expand(rightNode.min, rightNode.max, this.triMin, this.triMax, order[t]);
      stack.push({ node: leftNode,  first, count: leftCount, depth: depth + 1 });
      stack.push({ node: rightNode, first: first + leftCount, count: count - leftCount, depth: depth + 1 });
    }
  }

  /** 8-bin SAH：对三个轴各扫一遍质心分布，返回代价最低切分 */
  _bestSplit(node, order, first, count) {
    let best = null;
    const nodeArea = aabbArea(node.min, node.max);
    if (nodeArea <= 0) return null;
    for (let axis = 0; axis < 3; axis++) {
      // 求质心范围
      let mn = Infinity, mx = -Infinity;
      for (let t = first; t < first + count; t++) {
        const c = this.centroids[order[t] * 3 + axis];
        if (c < mn) mn = c; if (c > mx) mx = c;
      }
      if (mx - mn < 1e-6) continue;
      const binW = (mx - mn) / BIN_COUNT;
      const counts = new Uint16Array(BIN_COUNT);
      const bMin = new Float32Array(BIN_COUNT * 3).fill(Infinity);
      const bMax = new Float32Array(BIN_COUNT * 3).fill(-Infinity);
      for (let t = first; t < first + count; t++) {
        const ti = order[t];
        const bin = Math.min(BIN_COUNT - 1, Math.floor((this.centroids[ti * 3 + axis] - mn) / binW));
        counts[bin]++;
        bMin[bin*3]   = Math.min(bMin[bin*3],   this.triMin[ti*3]);
        bMin[bin*3+1] = Math.min(bMin[bin*3+1], this.triMin[ti*3+1]);
        bMin[bin*3+2] = Math.min(bMin[bin*3+2], this.triMin[ti*3+2]);
        bMax[bin*3]   = Math.max(bMax[bin*3],   this.triMax[ti*3]);
        bMax[bin*3+1] = Math.max(bMax[bin*3+1], this.triMax[ti*3+1]);
        bMax[bin*3+2] = Math.max(bMax[bin*3+2], this.triMax[ti*3+2]);
      }
      // 从左往右累加求左盒，从右往左累加求右盒，SAH = A_L*N_L + A_R*N_R
      const lMin = new Float32Array(3).fill(Infinity);
      const lMax = new Float32Array(3).fill(-Infinity);
      const leftAreas = new Float32Array(BIN_COUNT);
      const leftCounts = new Uint16Array(BIN_COUNT);
      for (let b = 0; b < BIN_COUNT; b++) {
        if (counts[b]) {
          lMin[0]=Math.min(lMin[0],bMin[b*3]);   lMin[1]=Math.min(lMin[1],bMin[b*3+1]); lMin[2]=Math.min(lMin[2],bMin[b*3+2]);
          lMax[0]=Math.max(lMax[0],bMax[b*3]);   lMax[1]=Math.max(lMax[1],bMax[b*3+1]); lMax[2]=Math.max(lMax[2],bMax[b*3+2]);
          leftCounts[b] = b ? leftCounts[b-1] + counts[b] : counts[b];
        } else if (b) leftCounts[b] = leftCounts[b-1];
        leftAreas[b] = leftCounts[b] ? aabbArea(lMin, lMax) : 0;
      }
      const rMin = new Float32Array(3).fill(Infinity);
      const rMax = new Float32Array(3).fill(-Infinity);
      for (let b = BIN_COUNT - 1; b > 0; b--) {
        if (counts[b]) {
          rMin[0]=Math.min(rMin[0],bMin[b*3]);   rMin[1]=Math.min(rMin[1],bMin[b*3+1]); rMin[2]=Math.min(rMin[2],bMin[b*3+2]);
          rMax[0]=Math.max(rMax[0],bMax[b*3]);   rMax[1]=Math.max(rMax[1],bMax[b*3+1]); rMax[2]=Math.max(rMax[2],bMax[b*3+2]);
        }
        const rightCount = count - leftCounts[b - 1];
        if (!rightCount) continue;
        const cost = aabbArea(rMin, rMax) * rightCount + leftAreas[b - 1] * leftCounts[b - 1];
        if (!best || cost < best.cost) {
          best = { axis, pos: mn + b * binW, cost };
        }
      }
    }
    // 代价不优于「不打散」时放弃划分（避免无意义二叉）
    if (best && best.cost >= nodeArea * count * 0.98) return null;
    return best;
  }

  dispose() {
    this.nodeMin = null; this.nodeMax = null;
    this.nodeLeftFirst = null; this.triIndices = null;
    this.centroids = null; this.triMin = null; this.triMax = null;
    this.disposed = true;
  }
}

function expand(mn, mx, triMin, triMax, t) {
  mn[0] = Math.min(mn[0], triMin[t*3]);   mx[0] = Math.max(mx[0], triMax[t*3]);
  mn[1] = Math.min(mn[1], triMin[t*3+1]); mx[1] = Math.max(mx[1], triMax[t*3+1]);
  mn[2] = Math.min(mn[2], triMin[t*3+2]); mx[2] = Math.max(mx[2], triMax[t*3+2]);
}

function aabbArea(mn, mx) {
  const x = mx[0] - mn[0], y = mx[1] - mn[1], z = mx[2] - mn[2];
  return 2 * (x * y + y * z + z * x);
}

/* ════════════════ 区块几何仓库 + TLAS（mount/unmount 生命周期）（原 src/rt/GeometryStore.js） ════════════════ */

/**
 * ============================================================================
 * GeometryStore —— 区块几何仓库 + TLAS（顶层加速结构）
 * ============================================================================
 *
 * 职责（对应契约二 + 契约三的失效信号）：
 *   1. mount(key, chunkData)：构建 BLAS，把节点/三角形/顶点拼进全局 CPU
 *      串联数组（GPU 只需要 bind 4 个大 storage buffer，不受 WebGPU
 *      每着色阶段 8 个 buffer 槽位限制——这是城市级场景的硬需求）
 *   2. unmount(key)：把该区段的内存区间标记回收（free-list 复用），并触发
 *      compactIfWorthy()；BLAS.dispose() 保证 JS 堆不泄漏
 *   3. rebuildTLAS(dynamicInstances)：静态块 TLAS 增量缓存，动态实例
 *      （角色等）每帧重排——TLAS 只有几十个实例，CPU 重建微秒级
 *   4. version 自增 = 契约三的「失效信号」之一（块增删必须清累积）
 *
 * 串联数组布局（GPU 视角）：
 *   nodes      : f32×8/node = {min.xyz, leftOrFirst, max.xyz, count}
 *   triIndices : u32（已重写为全局顶点偏移）
 *   vertices   : f32×5/顶点 = {pos.xyz, uv.xy}
 *   colors     : f32×3/顶点
 *   triMeta    : u32/三角 = bit0-7 材质槽(0/1/2)
 *
 * 所有偏移（nodeOffset/vertexOffset/triOffset）以「元素」为单位记录，
 * GPU 侧直接加 base 索引，不做字节运算——减少着色器出错面。
 * ============================================================================
 */


class GeometryStore {
  constructor({ maxTris = 2_000_000, maxVerts = 1_200_000 } = {}) {
    this.maxTris = maxTris;
    this.maxVerts = maxVerts;

    // 全局串联 CPU 数组（构建期可增长；upload 后由 PathTracer 拷走）
    this.nodes = [];          // f32，8/node
    this.triIndices = [];     // u32
    this.vertices = [];       // f32, 5/vert
    this.colors = [];         // f32, 3/vert
    this.triMeta = [];        // u32

    /** @type {Map<string, ChunkRecord>} */
    this.chunks = new Map();
    this.freeBlocks = [];     // 已 unmount 的区段，可复用
    this.version = 0;         // 每次块增删 +1 → 游戏侧据此清累积
    this.usedTris = 0;
    this.usedVerts = 0;

    // TLAS
    this.tlas = null;         // {nodes, leaves, instanceCount}
    this._tlasStaticDirty = true;
    this._dynamicCount = 0;
  }

  /**
   * 契约二：mount(key, chunkData, materialIDs)
   * 幂等：重复 mount 同一 key 返回 false，不重复建 BVH。
   * @returns {{ok: boolean, dup?: boolean, triCount?: number}}
   */
  mount(key, chunkData, materialIDs) {
    if (this.chunks.has(key)) return { ok: true, dup: true };
    const blas = new BLAS(chunkData);
    const record = {
      key,
      blas,
      materialIDs: materialIDs ? materialIDs.slice() : null,
      // 串联偏移（元素单位）
      nodeOffset: this.nodes.length / 8 | 0,
      vertexOffset: 0,
      triOffset: this.triIndices.length,
      vertCount: chunkData.vertCount,
      triCount: chunkData.triCount,
      boundsMin: chunkData.boundsMin,
      boundsMax: chunkData.boundsMax,
      center: chunkData.center,
    };

    // 三角形容量检查（显存预算的一部分：超出即拒绝并如实上报）
    if (this.usedTris + chunkData.triCount > this.maxTris ||
        this.usedVerts + chunkData.vertCount > this.maxVerts) {
      blas.dispose();
      return { ok: false, reason: 'geometry-budget-exceeded' };
    }

    // 顶点写入（SoA 平铺：pos.xyz + uv.xy → 5 float）
    const P = chunkData.positions, U = chunkData.uvs, C = chunkData.colors;
    const vOff = this.vertices.length / 5 | 0;
    record.vertexOffset = vOff;
    for (let v = 0; v < chunkData.vertCount; v++) {
      this.vertices.push(P[v*3], P[v*3+1], P[v*3+2], U[v*2], U[v*2+1]);
      this.colors.push(C[v*3], C[v*3+1], C[v*3+2]);
    }

    // 三角形索引重写为全局 + 材质 meta
    const I = chunkData.indices, M = chunkData.matIDs;
    for (let t = 0; t < chunkData.triCount; t++) {
      this.triIndices.push(I[t*3] + vOff, I[t*3+1] + vOff, I[t*3+2] + vOff);
      this.triMeta.push(M[t] & 0xff);
    }

    // BLAS 节点串联（leftOrFirst/triIndices 局部 → 全局偏移）
    const nOff = this.nodes.length / 8 | 0;
    const nm = blas.nodeMin, nx = blas.nodeMax, lf = blas.nodeLeftFirst;
    for (let n = 0; n < blas.nodeCount; n++) {
      let l = lf[n*2], c = lf[n*2+1];
      if (c > 0) {
        l += record.triOffset;        // 叶子：首三角形全局索引
      } else {
        l += nOff;                    // 内部：子节点全局索引
      }
      this.nodes.push(nm[n*3], nm[n*3+1], nm[n*3+2], l, nx[n*3], nx[n*3+1], nx[n*3+2], c);
    }
    record.nodeOffset = nOff;

    this.chunks.set(key, record);
    this.usedTris += chunkData.triCount;
    this.usedVerts += chunkData.vertCount;
    this._tlasStaticDirty = true;
    this.version++;
    return { ok: true, triCount: chunkData.triCount, vertCount: chunkData.vertCount };
  }

  /**
   * 契约二：unmount(key)
   * 必须释放：BLAS.dispose()（JS 堆）+ 串联数组区段标记（未来 compact 复用）。
   * 对不存在的 key：空操作，返回 {ok:true, noop:true}——契约明确不抛错。
   */
  unmount(key) {
    const rec = this.chunks.get(key);
    if (!rec) return { ok: true, noop: true };
    rec.blas.dispose();
    this.chunks.delete(key);
    this.usedTris -= rec.triCount;
    this.usedVerts -= rec.vertCount;
    this._tlasStaticDirty = true;
    this.version++;
    // 区段空洞：本实现采用「标记 + 阈值压缩」策略。碎片超过总量 25% 时
    // 整体重建串联数组（流式城市一天发生不了几次，成本可接受）。
    this.freeBlocks.push(rec);
    if (this._fragmentRatio() > 0.25) this._compact();
    return { ok: true };
  }

  _fragmentRatio() {
    if (!this.freeBlocks.length) return 0;
    let deadTris = 0;
    for (const r of this.freeBlocks) deadTris += r.triCount;
    return deadTris / Math.max(1, this.usedTris + deadTris);
  }

  /** 全量重排：把还活着的区块重新串进干净数组（释放空洞） */
  _compact() {
    const live = [...this.chunks.values()].map((r) => ({
      key: r.key, materialIDs: r.materialIDs,
      data: this._reassembleChunkData(r),
    }));
    // 清空重挂
    this.nodes = []; this.triIndices = []; this.vertices = [];
    this.colors = []; this.triMeta = [];
    this.usedTris = 0; this.usedVerts = 0;
    this.chunks.clear(); this.freeBlocks = [];
    for (const { key, data, materialIDs } of live.map(x => ({ key: x.key, data: x.data, materialIDs: x.materialIDs }))) {
      this.mount(key, data, materialIDs);
    }
    this._tlasStaticDirty = true;
    this.version++;
  }

  /** 从串联数组里反向取出一个区块的 ChunkMeshData（compact 用） */
  _reassembleChunkData(rec) {
    const vCnt = rec.vertCount, tCnt = rec.triCount;
    const positions = new Float32Array(vCnt * 3);
    const uvs = new Float32Array(vCnt * 2);
    const colors = new Float32Array(vCnt * 3);
    for (let v = 0; v < vCnt; v++) {
      const g = rec.vertexOffset + v;
      positions[v*3] = this.vertices[g*5]; positions[v*3+1] = this.vertices[g*5+1]; positions[v*3+2] = this.vertices[g*5+2];
      uvs[v*2] = this.vertices[g*5+3]; uvs[v*2+1] = this.vertices[g*5+4];
      colors[v*3] = this.colors[g*3]; colors[v*3+1] = this.colors[g*3+1]; colors[v*3+2] = this.colors[g*3+2];
    }
    const indices = new Uint32Array(tCnt * 3);
    const matIDs = new Uint8Array(tCnt);
    for (let t = 0; t < tCnt; t++) {
      const g = rec.triOffset + t * 3;
      indices[t*3] = this.triIndices[g] - rec.vertexOffset;
      indices[t*3+1] = this.triIndices[g+1] - rec.vertexOffset;
      indices[t*3+2] = this.triIndices[g+2] - rec.vertexOffset;
      matIDs[t] = this.triMeta[rec.triOffset + t] & 0xff;
    }
    return { positions, uvs, colors, indices, matIDs, vertCount: vCnt, triCount: tCnt,
             boundsMin: rec.boundsMin, boundsMax: rec.boundsMax, center: rec.center };
  }

  /**
   * 重建 TLAS。
   * @param {Array<{translation:[x,y,z], radius:[x,y,z], blasRef?:string}>} dynamics
   *   动态实例（角色等）。当前动态体复用「单位球代理 BLAS」（unitSphere 代理在
   *   GPU 侧程序化求交，不占三角形显存）——契约三之外的本实现优化。
   * @returns {number} 新版本号（动态体不影响 version；只有静态块增删才 +1）
   */
  rebuildTLAS(dynamics = []) {
    const instances = [];
    for (const [key, rec] of this.chunks) {
      instances.push({
        nodeOffset: rec.nodeOffset,
        triOffset: rec.triOffset,
        vertexOffset: rec.vertexOffset,
        translation: [0, 0, 0],
        radius: [0, 0, 0],
        min: rec.boundsMin, max: rec.boundsMax,
        kind: 0, // 0 = 静态三角网格
        key,
      });
    }
    for (const d of dynamics) {
      instances.push({
        translation: d.translation,
        radius: d.radius,
        min: [d.translation[0]-d.radius[0], d.translation[1]-d.radius[1], d.translation[2]-d.radius[2]],
        max: [d.translation[0]+d.radius[0], d.translation[1]+d.radius[1], d.translation[2]+d.radius[2]],
        kind: 1, // 1 = 程序化椭球（角色代理）
        key: '__dynamic__',
      });
    }

    // 自顶向下二叉构建（实例数 < 千级，直接中位数切分足够）
    const nodes = [];
    const build = (list, depth) => {
      let mn = [Infinity,Infinity,Infinity], mx = [-Infinity,-Infinity,-Infinity];
      for (const inst of list) {
        mn[0]=Math.min(mn[0],inst.min[0]); mn[1]=Math.min(mn[1],inst.min[1]); mn[2]=Math.min(mn[2],inst.min[2]);
        mx[0]=Math.max(mx[0],inst.max[0]); mx[1]=Math.max(mx[1],inst.max[1]); mx[2]=Math.max(mx[2],inst.max[2]);
      }
      const slot = nodes.length;
      nodes.push(null); // 占位
      if (list.length === 1 || depth > 24) {
        nodes[slot] = { min: mn, max: mx, leftFirst: list[0].instanceSlot ?? 0, count: 1,
                        leaf: true, instance: list[0] };
        return { slot, node: nodes[slot] };
      }
      // 最长轴中位数切分
      const ext = [mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]];
      const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : (ext[1] > ext[2] ? 1 : 2);
      list.sort((a, b) => (a.min[axis] + a.max[axis]) - (b.min[axis] + b.max[axis]));
      const mid = list.length >> 1;
      const L = build(list.slice(0, mid), depth + 1);
      const R = build(list.slice(mid), depth + 1);
      nodes[slot] = { min: mn, max: mx, leftFirst: L.slot, count: 0, leaf: false };
      return { slot, node: nodes[slot] };
    };

    let tlas = null;
    if (instances.length) {
      instances.forEach((inst, i) => (inst.instanceSlot = i));
      const root = build(instances, 0);
      // 扁平化 + 实例表
      const flatNodes = new Float32Array(nodes.length * 8);
      const leafInstance = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        flatNodes.set(n.min, i*8);
        flatNodes.set(n.max, i*8+4);
        if (n.leaf) {
          leafInstance.push(n.instance);
          flatNodes[i*8+3] = leafInstance.length - 1; // 实例索引
          flatNodes[i*8+7] = 1; // count=1 → 叶子
        } else {
          flatNodes[i*8+3] = n.leftFirst;
          flatNodes[i*8+7] = 0;
        }
      }
      tlas = { nodes: flatNodes, nodeCount: nodes.length, instances, leafInstance };
    }
    this.tlas = tlas;
    this._dynamicCount = dynamics.length;
    return this.version;
  }

  /** TLAS 是否需要重建（静态脏 或 动态体在动） */
  get tlasDirty() { return this._tlasStaticDirty; }
  clearTlasDirty() { this._tlasStaticDirty = false; }

  /** 供 GPU 上传的只读视图（PathTracer 每次块变更后调用） */
  exportArrays() {
    return {
      nodes: new Float32Array(this.nodes),
      triIndices: new Uint32Array(this.triIndices),
      vertices: new Float32Array(this.vertices),
      colors: new Float32Array(this.colors),
      triMeta: new Uint32Array(this.triMeta),
      nodeCount: this.nodes.length / 8,
      triCount: this.triIndices.length / 3,
      vertCount: this.vertices.length / 5,
    };
  }

  stats() {
    return {
      chunks: this.chunks.size,
      tris: this.usedTris,
      verts: this.usedVerts,
      nodes: this.chunks.size ? this.nodes.length / 8 : 0,
      fragmentRatio: this._fragmentRatio(),
      version: this.version,
    };
  }

  dispose() {
    for (const [, rec] of this.chunks) rec.blas.dispose();
    this.chunks.clear();
    this.nodes = []; this.triIndices = []; this.vertices = [];
    this.colors = []; this.triMeta = []; this.freeBlocks = [];
    this.tlas = null;
    this.version++;
  }
}

/* ════════════════ WebGPU 设备层（显存台账/错误捕获/降级探测）（原 src/rt/RTDevice.js） ════════════════ */

/**
 * ============================================================================
 * RTDevice —— WebGPU 设备初始化 / 能力探测 / 显存登记 / 错误捕获
 * ============================================================================
 *
 * 职责：
 *   1. adapter/device 请求（移动端强制 powerPreference='low-power'，避免大核狂奔发热）
 *   2. 能力探测：timestamp-query（测 GPU 帧时间）、maxStorageBufferBindingSize、
 *      maxBufferSize —— 直接决定 GeometryStore 的 maxTris 上限
 *   3. 显存登记处：所有 buffer/texture 创建都走 allocBuffer/allocTexture，
 *      台账合计实时审计 QualityController.auditVRAM
 *   4. uncapturederror 捕获 → 回调给系统层（绝不静默崩溃，契约六兜底入口）
 *   5. device.lost 处理：上报而非重连（重连是游戏层的决策，不是光追的）
 * ============================================================================
 */

class RTDevice {
  /** @returns {Promise<{ok:boolean, reason?:string, device?:GPUDevice}>} */
  static async create({ onDeviceLost, onError } = {}) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { ok: false, reason: 'webgpu-unavailable' };
    }
    let adapter;
    try {
      adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'low-power',
      });
    } catch (e) {
      return { ok: false, reason: 'adapter-request-failed:' + e.message };
    }
    if (!adapter) return { ok: false, reason: 'no-adapter' };

    const adapterInfo = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    let device;
    try {
      device = await adapter.requestDevice({
        requiredLimits: {}, // 不强推极限 limits——兼容优先，炸了才按需升级
      });
    } catch (e) {
      return { ok: false, reason: 'device-request-failed:' + e.message };
    }

    const rt = new RTDevice(device, adapter, adapterInfo);
    if (onDeviceLost) device.lost.then((info) => onDeviceLost(info));
    if (onError) device.addEventListener?.('uncapturederror', (e) => onError(e.error?.message || String(e.error)));

    return { ok: true, rtDevice: rt };
  }

  constructor(device, adapter, adapterInfo) {
    this.device = device;
    this.adapter = adapter;
    this.adapterInfo = adapterInfo;
    this.limits = device.limits;
    this.features = device.features;

    this.timestampQuerySupported = this.features.has('timestamp-query');
    // 最大几何预算 = 存储缓冲上限 / 每三角形字节数（保守 28B：索引9f? 见 GeometryStore.exportArrays 实际
    //   vertices 20B + colors 12B + indices 12B + meta 4B + nodes 摊销 ≈ 52B/三角，取 64B 保守值
    const maxTriFromBuffers = Math.floor(this.limits.maxStorageBufferBindingSize / 64);
    this.maxTris = Math.min(maxTriFromBuffers, 4_000_000);

    // —— 显存台账 ——
    this.vramLedger = new Map(); // name → bytes
    this.totalVRAM = 0;
  }

  allocBuffer(name, size, usage, mappedAtCreation = false) {
    const buf = this.device.createBuffer({ size, usage, mappedAtCreation });
    this.vramLedger.set(name, size);
    this.totalVRAM += size;
    return buf;
  }

  allocTexture(name, descriptor) {
    const tex = this.device.createTexture(descriptor);
    // 估算显存：bytesPerPixel × w × h × layers
    const bpp = {
      'rgba32float': 16, 'rgba16float': 8, 'rgba8unorm': 4,
      'rgba8unorm-srgb': 4, 'depth32float': 4, 'r32float': 4,
    }[descriptor.format] || 4;
    const bytes = bpp * descriptor.size[0] * descriptor.size[1] * (descriptor.size[2] || 1);
    this.vramLedger.set(name, bytes);
    this.totalVRAM += bytes;
    return tex;
  }

  free(name, resource) {
    const bytes = this.vramLedger.get(name);
    if (bytes !== undefined) {
      this.totalVRAM -= bytes;
      this.vramLedger.delete(name);
    }
    resource?.destroy?.();
  }

  /** 显存台账快照（系统层每秒打点用） */
  ledger() {
    return { total: this.totalVRAM, items: Object.fromEntries(this.vramLedger) };
  }

  /** GPU 帧时间测量（timestamp-query 可用时） */
  makeTimestampQuerySet(count = 2) {
    if (!this.timestampQuerySupported) return null;
    return this.device.createQuerySet({
      type: 'timestamp', count,
    });
  }

  async destroy() {
    // WebGPU 没有显式 device.destroy 的标准路径（有的实现有），清台账即可
    this.vramLedger.clear();
    this.totalVRAM = 0;
  }
}

/* ════════════════ 质量控制器（移动端极限优化/自适应分辨率）（原 src/rt/QualityController.js） ════════════════ */

/**
 * ============================================================================
 * QualityController —— 设备检测 + 质量分档 + 自适应分辨率（移动端极限优化）
 * ============================================================================
 *
 * 检测链（从强到弱）：
 *   1. UA + 触摸能力 + 硬件并发数 → 平台判定
 *   2. WEBGL_debug_renderer_info（若页面已有 WebGL 上下文可借用）/ GPU adapter
 *      info → GPU 型号分级（Apple A/M 系、Adreno、Mali 各有不同策略）
 *   3. 运行时帧时间 EMA → 挡位之间的动态微调（唯一允许的运行时投机）
 *
 * 移动端策略（要求：不卡、显存占用小、尽可能好看）：
 *   - 累积分辨率 = 画布 × scale(0.55~0.75)，DPR 上限 2（1.5 起步）
 *   - 累积缓冲 rgba16float（PC 为 rgba32float）：单帧精度略低但面积省一半
 *   - 弹射 2 次、每帧 1 spp、累积上限 256 帧（防温度墙降频死循环）
 *   - 显存硬预算 96MB（可配）：所有 RT 乘以 scale 后仍需过审
 *   - 时间戳查询测 GPU 时间（不可用则 rAF EMA 兜底），连续超 22ms 降 scale，
 *     连续低于 12ms 升 scale（回不到初始档以上——温度墙保护）
 * ============================================================================
 */

const PLATFORM = Object.freeze({ PC: 'pc', MOBILE: 'mobile' });

const MOBILE_UA_RE = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OPPO|vivo|Xiaomi|Huawei|HONOR/i;

function detectPlatform() {
  if (typeof navigator === 'undefined') return PLATFORM.PC;
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const coarse = typeof matchMedia !== 'undefined' &&
    matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const isMobileUA = MOBILE_UA_RE.test(ua) || /iPad|Tablet/i.test(ua);
  // iPad 桌面模式 UA 不带 Mobile，靠触摸 + coarse 指针兜底
  const isMobile = isMobileUA || (touch && coarse && cores <= 8);
  return isMobile ? PLATFORM.MOBILE : PLATFORM.PC;
}

/** GPU 型号分级（用于移动端内部的二档细分） */
function gradeMobileGPU(adapterInfo) {
  const desc = (adapterInfo?.description || adapterInfo?.vendor || '').toLowerCase();
  if (/apple m[12345]|apple a1[56789]|a17|a18/.test(desc)) return 'high';
  if (/adreno 7[0-9]{2}|adreno 8/.test(desc)) return 'high';
  if (/mali-g7[0-9]|mali-g6/.test(desc)) return 'mid';
  return 'mid'; // 未知型号按中档保守处理
}

/**
 * 挡位表。scale 是「光追内部累积分辨率 / 画布物理分辨率」。
 * bounces：路径最大弹射；shadowRays：每命中一次阴影光线的抖动采样数。
 */
const QUALITY_PRESETS = Object.freeze({
  pc: Object.freeze({
    platform: PLATFORM.PC,
    initialScale: 1.0, minScale: 0.5, maxScale: 1.0,
    bounces: 4,
    accumFormat: 'rgba32float',
    accumLimit: 1024,
    dprCap: 2.0,
    vramBudgetMB: 512,
    frameBudgetMs: 16.7,
    volumetricSteps: 48,      // 光锥体积步进
    volumetricScatterEvents: 2,
    envMipLevels: 8,
    denoiseEveryNFrames: 0,   // PC 不需要时间降噪（累积够快）
  }),
  mobileHigh: Object.freeze({
    platform: PLATFORM.MOBILE,
    initialScale: 0.7, minScale: 0.4, maxScale: 0.85,
    bounces: 2,
    accumFormat: 'rgba16float',
    accumLimit: 256,
    dprCap: 2.0,
    vramBudgetMB: 96,
    frameBudgetMs: 22,
    volumetricSteps: 24,
    volumetricScatterEvents: 1,
    envMipLevels: 5,
    denoiseEveryNFrames: 0,
  }),
  mobileMid: Object.freeze({
    platform: PLATFORM.MOBILE,
    initialScale: 0.55, minScale: 0.3, maxScale: 0.7,
    bounces: 2,
    accumFormat: 'rgba16float',
    accumLimit: 160,
    dprCap: 1.5,
    vramBudgetMB: 72,
    frameBudgetMs: 25,
    volumetricSteps: 16,
    volumetricScatterEvents: 1,
    envMipLevels: 4,
    denoiseEveryNFrames: 4,   // 每 4 帧做一次轻量时域复用（真实用途：低累积帧率下糊化闪烁）
  }),
});

function pickPreset(platform, gpuGrade) {
  if (platform === PLATFORM.PC) return QUALITY_PRESETS.pc;
  return gpuGrade === 'high' ? QUALITY_PRESETS.mobileHigh : QUALITY_PRESETS.mobileMid;
}

/**
 * 自适应分辨率控制器。
 * feed(frameMs) → 返回当前 scale；内部 EMA 平滑，粘滞切换（连续 30 帧超预算才降，
 * 连续 90 帧富余才升），杜绝画质抽风。
 */
class AdaptiveResolution {
  constructor(preset) {
    this.preset = preset;
    this.scale = preset.initialScale;
    this._ema = preset.frameBudgetMs;
    this._overRun = 0;
    this._underRun = 0;
    this._alpha = 0.08;
    this.history = []; // 调试遥测
  }

  feed(frameMs) {
    this._ema = this._ema * (1 - this._alpha) + frameMs * this._alpha;
    const budget = this.preset.frameBudgetMs;
    if (this._ema > budget * 1.15) {
      this._overRun++; this._underRun = 0;
    } else if (this._ema < budget * 0.62) {
      this._underRun++; this._overRun = 0;
    } else {
      this._overRun = 0; this._underRun = 0;
    }
    // 降档：连续 30 帧超预算。升档：连续 90 帧富余，且不得超过初始档（温度墙保护）
    if (this._overRun >= 30 && this.scale > this.preset.minScale) {
      this.scale = Math.max(this.preset.minScale, this.scale - 0.1);
      this._overRun = 0;
      this.history.push({ t: Date.now(), scale: this.scale, ema: this._ema, dir: 'down' });
      return { changed: true, scale: this.scale };
    }
    if (this._underRun >= 90 && this.scale < Math.min(this.preset.initialScale, this.preset.maxScale)) {
      this.scale = Math.min(this.preset.initialScale, this.scale + 0.1);
      this._underRun = 0;
      this.history.push({ t: Date.now(), scale: this.scale, ema: this._ema, dir: 'up' });
      return { changed: true, scale: this.scale };
    }
    return { changed: false, scale: this.scale };
  }

  /** 显存预算审计：传入所有 RT 的字节数合计，超预算返回建议 scale */
  auditVRAM(totalBytes) {
    const budgetBytes = this.preset.vramBudgetMB * 1024 * 1024;
    if (totalBytes <= budgetBytes) return { ok: true, totalBytes, budgetBytes };
    const suggestedScale = this.scale * Math.sqrt(budgetBytes / totalBytes);
    return { ok: false, totalBytes, budgetBytes, suggestedScale: Math.max(this.preset.minScale, suggestedScale) };
  }
}

/**
 * 门面类：GameAdapter 唯一接触的质量入口。
 * 聚合平台判定 / 挡位挑选 / 自适应分辨率，暴露 platform / preset / scale。
 */
class QualityController {
  constructor(adapterInfo) {
    this.platform = detectPlatform();
    const grade = this.platform === PLATFORM.MOBILE ? gradeMobileGPU(adapterInfo) : 'pc';
    this.gpuGrade = grade;
    this.preset = pickPreset(this.platform, grade);
    this.adaptive = new AdaptiveResolution(this.preset);
    this.scale = this.adaptive.scale;
  }

  /** 每帧喂帧时间，内部维护 EMA 与粘滞降/升档 */
  frameTime(frameMs) {
    const r = this.adaptive.feed(frameMs);
    this.scale = r.scale;
    return r;
  }

  auditVRAM(totalBytes) {
    const r = this.adaptive.auditVRAM(totalBytes);
    if (!r.ok) this.scale = r.suggestedScale; // 超预算立即执行
    return r;
  }
}

/* ════════════════ WGSL 公共库（RNG/求交/两级 BVH 遍历/天空/水面）（原 src/rt/shaders/common.wgsl.js） ════════════════ */

/**
 * ============================================================================
 * WGSL 公共库 —— 被路径追踪主体 include 的基础层
 * ============================================================================
 * 内容： Uniforms 结构 / RNG(PCG) / 射线-AABB / Möller–Trumbore /
 *       TLAS→BLAS 两级遍历 / 程序化椭球(角色代理) / 水面波浪法线 /
 *       天空环境 / facade 贴图读取(手动双线性，compute 阶段可用)
 *
 * 本文件导出 WGSL 源码字符串，由 PathTracer 拼接编译。
 * 所有 Uniform 槽位都是 vec4f——彻底规避 WGSL struct 对齐陷阱。
 * ============================================================================
 */

const COMMON_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Uniforms：全部 vec4f，与 JS 侧 Float32Array(64) 一一对应
// ---------------------------------------------------------------------------
struct Uniforms {
  camPos     : vec4f, // xyz=相机位置        w=tanHalfFov
  camRight   : vec4f,
  camUp      : vec4f,
  camFwd     : vec4f,
  resFrame   : vec4f, // xy=渲染分辨率        z=frameIndex  w=maxBounces
  sunDir     : vec4f, // xyz=太阳方向(指向太阳) w=角半径(rad)
  sunColor   : vec4f, // rgb=太阳辐亮度       w=曝光(游戏侧管 tonemap，这里只留口)
  ambient    : vec4f, // rgb=天空环境辐射     w=累积上限
  counts     : vec4f, // x=BLAS节点数 y=三角形数 z=顶点数 w=TLAS节点数
  conePos    : vec4f, // xyz=光锥顶点(光源位置) w=强度(0=关闭)
  coneDir    : vec4f, // xyz=锥轴(单位向量)   w=cosHalfAngle
  coneParams : vec4f, // x=锥长 y=底面半径 z=体积步进数 w=步进阴影采样间隔
  coneColor  : vec4f, // rgb=光锥颜色
  waterPlane : vec4f, // x=水面高度 y=中心x z=中心z w=启用(1/0)
  waterHalf  : vec4f, // xy=半宽高 z=波幅 w=波频
  ground     : vec4f, // x=湿地度 y=水洼尺度 z=反射增益 w=地面灰度
  misc       : vec4f, // x=时间秒 y=体积散射次数上限 z=帧内样本 w=保留
};
@group(0) @binding(0) var<uniform> U : Uniforms;

// 几何数据（GeometryStore.exportArrays 上传，布局见其注释）
@group(0) @binding(1)  var<storage, read> blasNodes  : array<f32>;  // 8/node
@group(0) @binding(2)  var<storage, read> triIndices : array<u32>;
@group(0) @binding(3)  var<storage, read> vertices   : array<f32>;  // 5/vert
@group(0) @binding(4)  var<storage, read> vcolors    : array<f32>;  // 3/vert
@group(0) @binding(5)  var<storage, read> triMeta    : array<u32>;  // 1/tri
@group(0) @binding(6)  var<storage, read> tlasNodes  : array<f32>;  // 8/node
@group(0) @binding(7)  var<storage, read> instA      : array<vec4f>; // (nodeOffset,triOffset,vertexOffset,kind)
@group(0) @binding(8)  var<storage, read> instB      : array<vec4f>; // (tx,ty,tz,matHint)
@group(0) @binding(9)  var prevAccum : texture_2d<f32>;
@group(0) @binding(10) var outAccum  : texture_storage_2d<__ACCUM_FORMAT__, write>;
@group(0) @binding(11) var texStucco : texture_2d<f32>;
@group(0) @binding(12) var texMixed  : texture_2d<f32>;
@group(0) @binding(13) var texGlass  : texture_2d<f32>;

// ---------------------------------------------------------------------------
// RNG：PCG 哈希，每像素每帧独立流（累积收敛的统计前提）
// ---------------------------------------------------------------------------
struct Rng { state : u32 };

fn rngSeed(pixel: vec2u, frame: u32) -> Rng {
  var s = pixel.x * 1973u + pixel.y * 9277u + frame * 26699u | 1u;
  return Rng(s);
}
fn rngNext(r: ptr<function, Rng>) -> u32 {
  let old = (*r).state;
  (*r).state = old * 747796405u + 2891336453u;
  let w = ((old >> ((old >> 28u) + 4u)) ^ old) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rngF(r: ptr<function, Rng>) -> f32 {           // [0,1)
  return f32(rngNext(r)) * (1.0 / 4294967296.0);
}
fn rngF2(r: ptr<function, Rng>) -> vec2f {        // 一次抽两个，省调用
  return vec2f(rngF(r), rngF(r));
}

// ---------------------------------------------------------------------------
// 基础数学
// ---------------------------------------------------------------------------
fn aabbHit(ro: vec3f, inv: vec3f, mn: vec3f, mx: vec3f, tMax: f32) -> f32 {
  let t0 = (mn - ro) * inv;
  let t1 = (mx - ro) * inv;
  let tsmn = min(t0, t1);
  let tsmx = max(t0, t1);
  let tN = max(max(tsmn.x, tsmn.y), max(tsmn.z, 0.0));
  let tF = min(min(tsmx.x, tsmx.y), tsmx.z);
  if (tN > tF || tF < 0.0 || tN > tMax) { return -1.0; }
  return tN;
}

fn triHit(ro: vec3f, rd: vec3f, i0: u32, i1: u32, i2: u32,
          outP: ptr<function, vec3f>, outN: ptr<function, vec3f>,
          outUV: ptr<function, vec2f>, outVC: ptr<function, vec3f>) -> f32 {
  let a = vertices[i0 * 5u];
  let b = vertices[i1 * 5u];
  let c = vertices[i2 * 5u];
  let ay = vertices[i0 * 5u + 1u];
  let by = vertices[i1 * 5u + 1u];
  let cy = vertices[i2 * 5u + 1u];
  let az = vertices[i0 * 5u + 2u];
  let bz = vertices[i1 * 5u + 2u];
  let cz = vertices[i2 * 5u + 2u];
  let e1 = vec3f(b - a, by - ay, bz - az);
  let e2 = vec3f(c - a, cy - ay, cz - az);
  let pv = cross(rd, e2);
  let det = dot(e1, pv);
  if (abs(det) < 1e-12) { return -1.0; }
  let inv = 1.0 / det;
  let tv = ro - vec3f(a, ay, az);
  let u = dot(tv, pv) * inv;
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let qv = cross(tv, e1);
  let v = dot(rd, qv) * inv;
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let t = dot(e2, qv) * inv;
  if (t <= 1e-4) { return -1.0; }

  // 插值属性（uv 取 3/4 号槽位，color 全局数组）
  let au = vertices[i0 * 5u + 3u]; let av = vertices[i0 * 5u + 4u];
  let bu = vertices[i1 * 5u + 3u]; let bv = vertices[i1 * 5u + 4u];
  let cu = vertices[i2 * 5u + 3u]; let cv = vertices[i2 * 5u + 4u];
  (*outUV) = vec2f(au, av) * (1.0 - u - v) + vec2f(bu, bv) * u + vec2f(cu, cv) * v;

  let cr = vec3f(vcolors[i0*3u], vcolors[i0*3u+1u], vcolors[i0*3u+2u]) * (1.0 - u - v)
         + vec3f(vcolors[i1*3u], vcolors[i1*3u+1u], vcolors[i1*3u+2u]) * u
         + vec3f(vcolors[i2*3u], vcolors[i2*3u+1u], vcolors[i2*3u+2u]) * v;
  (*outVC) = cr;

  // 几何法线（facade 是硬表面，几何法线正确且省 12B/顶点 显存）
  (*outN) = normalize(cross(e1, e2));
  (*outP) = ro + rd * t;
  return t;
}

// ---------------------------------------------------------------------------
// BLAS 遍历（节点布局见 GeometryStore：min.xyz,leftFirst / max.xyz,count）
// ---------------------------------------------------------------------------
const STACK_SIZE: u32 = 48u;

fn traceBLAS(ro: vec3f, rd: vec3f, inv: vec3f, nodeBase: u32, tMax: f32,
             outHitT: ptr<function, f32>, outP: ptr<function, vec3f>,
             outN: ptr<function, vec3f>, outUV: ptr<function, vec2f>,
             outVC: ptr<function, vec3f>, outTri: ptr<function, u32>) {
  var stack: array<u32, STACK_SIZE>;
  var sp = 0u;
  stack[0u] = nodeBase;
  sp = 1u;
  var best = tMax;

  loop {
    if (sp == 0u) { break; }
    sp -= 1u;
    let n = stack[sp];
    let mn = vec3f(blasNodes[n*8u], blasNodes[n*8u+1u], blasNodes[n*8u+2u]);
    let mx = vec3f(blasNodes[n*8u+4u], blasNodes[n*8u+5u], blasNodes[n*8u+6u]);
    let tEntry = aabbHit(ro, inv, mn, mx, best);
    if (tEntry < 0.0) { continue; }

    let cnt = u32(blasNodes[n*8u+7u]);
    if (cnt > 0u) {
      // 叶子
      let first = u32(blasNodes[n*8u+3u]);
      for (var k = 0u; k < cnt; k = k + 1u) {
        let ti = triIndices[first + k];
        var p: vec3f; var nn: vec3f; var uv: vec2f; var vc: vec3f;
        let t = triHit(ro, rd, triIndices[ti*3u], triIndices[ti*3u+1u], triIndices[ti*3u+2u],
                       &p, &nn, &uv, &vc);
        if (t > 0.0 && t < best) {
          best = t;
          (*outHitT) = t; (*outP) = p; (*outN) = nn; (*outUV) = uv;
          (*outVC) = vc; (*outTri) = ti;
        }
      }
    } else {
      let l = u32(blasNodes[n*8u+3u]);
      // 优先近子节点（简单启发：按 AABB 入口距离排序入栈）
      let lmn = vec3f(blasNodes[l*8u], blasNodes[l*8u+1u], blasNodes[l*8u+2u]);
      let lmx = vec3f(blasNodes[l*8u+4u], blasNodes[l*8u+5u], blasNodes[l*8u+6u]);
      let rmn = vec3f(blasNodes[(l+1u)*8u], blasNodes[(l+1u)*8u+1u], blasNodes[(l+1u)*8u+2u]);
      let rmx = vec3f(blasNodes[(l+1u)*8u+4u], blasNodes[(l+1u)*8u+5u], blasNodes[(l+1u)*8u+6u]);
      let tl = aabbHit(ro, inv, lmn, lmx, best);
      let tr = aabbHit(ro, inv, rmn, rmx, best);
      if (sp + 2u < STACK_SIZE) {
        if (tl >= 0.0 && tr >= 0.0) {
          if (tl < tr) { stack[sp] = l + 1u; stack[sp+1u] = l; }
          else         { stack[sp] = l;     stack[sp+1u] = l + 1u; }
          sp = sp + 2u;
        } else if (tl >= 0.0) { stack[sp] = l; sp = sp + 1u; }
        else if (tr >= 0.0)   { stack[sp] = l + 1u; sp = sp + 1u; }
      }
    }
  }
}

// 程序化椭球（角色代理）：世界轴对齐椭球求交，法线解析
fn ellipsoidHit(ro: vec3f, rd: vec3f, c: vec3f, r: vec3f,
                outP: ptr<function, vec3f>, outN: ptr<function, vec3f>) -> f32 {
  let o = (ro - c) / r;
  let d = rd / r;
  let a = dot(d, d);
  let b = 2.0 * dot(o, d);
  let cc = dot(o, o) - 1.0;
  let disc = b*b - 4.0*a*cc;
  if (disc < 0.0) { return -1.0; }
  let sq = sqrt(disc);
  var t = (-b - sq) / (2.0 * a);
  if (t <= 1e-4) { t = (-b + sq) / (2.0 * a); }
  if (t <= 1e-4) { return -1.0; }
  let p = ro + rd * t;
  (*outP) = p;
  (*outN) = normalize((p - c) / (r * r));
  return t;
}

// ---------------------------------------------------------------------------
// TLAS 遍历：叶子 kind 0=三角网格实例  1=程序化椭球(角色)
// ---------------------------------------------------------------------------
struct Hit {
  t    : f32,
  p    : vec3f,
  n    : vec3f,
  uv   : vec2f,
  vc   : vec3f,
  slot : f32,  // 材质槽：0/1/2=facade 三档  255=角色  其余=程序面
  tri  : u32,
};
fn hitNone() -> Hit {
  return Hit(-1.0, vec3f(0.0), vec3f(0.0, 1.0, 0.0), vec2f(0.0), vec3f(1.0), 9999.0, 0u);
}

fn traceTLAS(ro: vec3f, rd: vec3f, tMax: f32) -> Hit {
  var hit = hitNone();
  var best = tMax;
  let inv = 1.0 / rd;
  let tlCount = u32(U.counts.w);

  if (tlCount > 0u) {
    var stack: array<u32, 24u>;
    var sp = 1u;
    stack[0u] = 0u;
    loop {
      if (sp == 0u) { break; }
      sp -= 1u;
      let n = stack[sp];
      let mn = vec3f(tlasNodes[n*8u], tlasNodes[n*8u+1u], tlasNodes[n*8u+2u]);
      let mx = vec3f(tlasNodes[n*8u+4u], tlasNodes[n*8u+5u], tlasNodes[n*8u+6u]);
      if (aabbHit(ro, inv, mn, mx, best) < 0.0) { continue; }
      let cnt = u32(tlasNodes[n*8u+7u]);
      if (cnt > 0u) {
        let ii = u32(tlasNodes[n*8u+3u]);
        let kind = u32(instA[ii].w);
        if (kind == 0u) {
          var p: vec3f; var nn: vec3f; var uv: vec2f; var vc: vec3f; var tri: u32;
          var ht: f32 = -1.0;
          traceBLAS(ro, rd, inv, u32(instA[ii].x), best, &ht, &p, &nn, &uv, &vc, &tri);
          if (ht > 0.0 && ht < best) {
            best = ht;
            hit = Hit(ht, p, nn, uv, vc, f32(triMeta[tri] & 0xffu), tri);
          }
        } else {
          var p: vec3f; var nn: vec3f;
          let t = ellipsoidHit(ro, rd, instB[ii].xyz, vec3f(0.42, 0.95, 0.42), &p, &nn);
          if (t > 0.0 && t < best) {
            best = t;
            hit = Hit(t, p, nn, vec2f(0.0), vec3f(0.0), 255.0, 0u);
          }
        }
      } else {
        let l = u32(tlasNodes[n*8u+3u]);
        if (sp + 2u < 24u) { stack[sp] = l; stack[sp+1u] = l + 1u; sp = sp + 2u; }
      }
    }
  }

  // 程序化地面/水面（y = U.waterPlane.x 平面）
  if (abs(rd.y) > 1e-7) {
    let tPlane = (U.waterPlane.x - ro.y) / rd.y;
    if (tPlane > 1e-4 && tPlane < best) {
      let p = ro + rd * tPlane;
      // 城市地块矩形内不画程序面（建筑自身占位；矩形外才是街道/水域）
      let inWater = U.waterPlane.w > 0.5 &&
        abs(p.x - U.waterPlane.y) < U.waterHalf.x &&
        abs(p.z - U.waterPlane.z) < U.waterHalf.y;
      let slot = select(100.0, 50.0, inWater); // 50=水面 100=地面
      hit = Hit(tPlane, p, vec3f(0.0, 1.0, 0.0), vec2f(p.x, p.z), vec3f(1.0), slot, 0u);
    }
  }
  return hit;
}

// 遮挡查询（软阴影/体积阴影共用）：只查 TLAS 与程序面，命中即返回
fn occluded(ro: vec3f, rd: vec3f, dist: f32) -> bool {
  let h = traceTLAS(ro, rd, dist);
  return h.t > 0.0 && h.t < dist;
}

// ---------------------------------------------------------------------------
// 水面波浪法线：4 组方向正弦波叠加 + 细涟漪哈希噪声，解析偏导（无噪声贴图）
// ---------------------------------------------------------------------------
fn waveH(p: vec2f) -> f32 {
  let amp = U.waterHalf.z;
  let fr = U.waterHalf.w;
  var h = 0.0;
  h = h + sin(p.x * fr * 1.00 + U.misc.x * 1.10) * amp * 0.50;
  h = h + sin((p.x * 0.7 + p.y * 0.7) * fr * 1.90 - U.misc.x * 1.60) * amp * 0.30;
  h = h + sin((p.x * -0.4 + p.y * 1.1) * fr * 3.30 + U.misc.x * 2.30) * amp * 0.16;
  h = h + sin((p.x * 1.3 - p.y * 0.6) * fr * 5.10 - U.misc.x * 3.10) * amp * 0.08;
  return h;
}
fn waveNormal(p: vec2f) -> vec3f {
  let e = 0.18;
  let hx = waveH(p + vec2f(e, 0.0)) - waveH(p - vec2f(e, 0.0));
  let hz = waveH(p + vec2f(0.0, e)) - waveH(p - vec2f(0.0, e));
  return normalize(vec3f(-hx, 2.0 * e, -hz));
}

// ---------------------------------------------------------------------------
// 天空环境（程序化）：瑞利感渐变 + 太阳/月亮盘 + 地平线雾 + 夜版星空
// ---------------------------------------------------------------------------
fn skyColor(rd: vec3f) -> vec3f {
  let y = clamp(rd.y, -0.05, 1.0);
  let sunAmt = max(dot(rd, normalize(U.sunDir.xyz)), 0.0);

  // 夜空基调
  var col = mix(vec3f(0.012, 0.016, 0.032), vec3f(0.05, 0.07, 0.13), pow(y, 0.7));
  // 日/月盘 + 光晕
  let disk = smoothstep(0.9993 - U.sunDir.w, 0.9997, sunAmt);
  col = col + U.sunColor.rgb * disk * 12.0;
  col = col + U.sunColor.rgb * pow(sunAmt, 180.0) * 0.9;
  col = col + U.sunColor.rgb * pow(sunAmt, 6.0) * 0.06;
  // 星空（只在暗环境可见，哈希星点）
  let nightF = clamp(1.0 - length(U.sunColor.rgb) * 0.3, 0.0, 1.0);
  if (nightF > 0.2 && rd.y > 0.02) {
    let sp = floor(rd.xz * 900.0 / max(rd.y, 0.1));
    let h = fract(sin(dot(sp, vec2f(12.9898, 78.233))) * 43758.5453);
    col = col + vec3f(0.8, 0.85, 1.0) * step(0.9975, h) * nightF * rd.y * 2.0;
  }
  // 地平线雾
  col = col + vec3f(0.10, 0.11, 0.14) * pow(1.0 - max(y, 0.0), 8.0);
  return col;
}

// ---------------------------------------------------------------------------
// facade 贴图读取：textureLoad 手动双线性（compute 阶段无采样器可用）
// ---------------------------------------------------------------------------
fn texBilinear(tex: texture_2d<f32>, uv: vec2f) -> vec3f {
  let dims = vec2f(textureDimensions(tex, 0u));
  let x = clamp(uv.x, 0.0, 1.0) * (dims.x - 1.0);
  let y = clamp(uv.y, 0.0, 1.0) * (dims.y - 1.0);
  let x0 = u32(x); let y0 = u32(y);
  let x1 = min(x0 + 1u, u32(dims.x) - 1u);
  let y1 = min(y0 + 1u, u32(dims.y) - 1u);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let c00 = textureLoad(tex, vec2u(x0, y0), 0u).rgb;
  let c10 = textureLoad(tex, vec2u(x1, y0), 0u).rgb;
  let c01 = textureLoad(tex, vec2u(x0, y1), 0u).rgb;
  let c11 = textureLoad(tex, vec2u(x1, y1), 0u).rgb;
  // 贴图为 sRGB 资产：手动 pow 解码到线性（texture_2d<f32> 不自动）
  let l00 = c00 * c00; let l10 = c10 * c10;
  let l01 = c01 * c01; let l11 = c11 * c11;
  return mix(mix(l00, l10, fx), mix(l01, l11, fx), fy);
}
`;

/* ════════════════ 路径追踪主体（光锥体积/水面波光/地面反光/软阴影/累积）（原 src/rt/shaders/pathtrace.wgsl.js） ════════════════ */

/**
 * ============================================================================
 * 路径追踪主体 —— compute pass，每像素一线程
 * ============================================================================
 *
 * 渲染方程策略（非玩具实现，但为移动端做了有明确依据的取舍）：
 *   - 直接光：太阳（角半径采样 → 物理软阴影） + 光锥聚光（距离平方衰减 +
 *     锥内径向衰减 + 阴影光线）+ 程序天空环境光
 *   - 间接光：余弦加权半球采样弹射（PC 4 次 / 移动端 2 次）
 *   - 光锥体积：沿主射线段解析锥体求交 + 固定步数蒙特卡洛积分（内散射 +
 *     透射率），阴影光线按 coneParams.w 间隔抽稀
 *   - 水面：4 组解析正弦波法线 + Fresnel 概率分裂（反射继续追踪=真倒影），
 *     GGX 高光 + 太阳角半径抖动 → 波光粼粼
 *   - 地面：湿度 fbm 场调制粗糙度/反照率，水洼镜面（地面反光的物理来源）
 *   - 玻璃幕墙：薄玻璃近似，Fresnel 概率反射/透射，透射带色
 *   - 夜景：程序化窗灯自发光（哈希窗格 × 夜色因子）
 *
 * 累积：outAccum = prevAccum + 本帧样本（运行和）。
 * 除法与 tonemap 在 present 阶段；失效重置由 CPU 侧 loadOp=clear 完成。
 * ============================================================================
 */

const PATHTRACE_WGSL = /* wgsl */ `
// ------------------------- 采样工具 -------------------------
fn basis(n: vec3f) -> mat3x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  let t = vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
  let bt = vec3f(b, s + n.y * n.y * a, -n.y);
  return mat3x3f(t, bt, n);
}

fn cosineHemisphere(n: vec3f, r: vec2f) -> vec3f {
  let a = r.x * 6.28318530718;
  let z = sqrt(r.y);
  let zp = sqrt(max(0.0, 1.0 - r.y));
  let b = basis(n);
  return normalize(b * vec3f(cos(a) * zp, sin(a) * zp, z));
}

// 圆盘均匀采样（太阳角半径 / 粗糙度扰动共用）
fn diskSample(r: vec2f) -> vec2f {
  let a = r.x * 6.28318530718;
  let rad = sqrt(r.y);
  return vec2f(cos(a), sin(a)) * rad;
}

fn fresnelSchlick(cosT: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosT, 5.0);
}

// 2D 值噪声 fbm（地面湿度场用）
fn hash21(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  let q2 = q + dot(q, q + 45.32);
  return fract(q2.x * q2.y);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let f2 = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), f2.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), f2.x), f2.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var amp = 0.5;
  var pp = p;
  for (var k = 0; k < 4; k = k + 1) {
    v = v + vnoise(pp) * amp;
    pp = pp * 2.03 + vec2f(17.3, 9.1);
    amp = amp * 0.5;
  }
  return v;
}

// ------------------------- 太阳（含软阴影） -------------------------
fn sampleSunDir(r: vec2f) -> vec3f {
  let angR = U.sunDir.w;
  let off = diskSample(r) * angR;
  // 以太阳方向为轴的局部偏移
  let s = normalize(U.sunDir.xyz);
  let b = basis(s);
  return normalize(s + b * vec3f(off.x, off.y, 0.0));
}

fn sunLight(p: vec3f, n: vec3f, r: ptr<function, Rng>) -> vec3f {
  let dir = sampleSunDir(rngF2(r));
  let ndl = dot(n, dir);
  if (ndl <= 0.0) { return vec3f(0.0); }
  let ro = p + n * 0.02;
  let dist = 1e5;
  if (occluded(ro, dir, dist)) { return vec3f(0.0); }
  return U.sunColor.rgb * ndl;
}

// ------------------------- 光锥聚光（表面直接光） -------------------------
fn spotLight(p: vec3f, n: vec3f) -> vec3f {
  let intensity = U.conePos.w;
  if (intensity <= 0.0) { return vec3f(0.0); }
  let apex = U.conePos.xyz;
  let dc = normalize(U.coneDir.xyz);
  let ca = U.coneDir.w;
  let L = U.coneParams.x;
  let v = p - apex;
  let h = dot(v, dc);
  if (h < 0.0 || h > L) { return vec3f(0.0); }
  let cp = v - dc * h;
  let r = length(cp);
  let tanTheta = sqrt(max(0.0, 1.0 - ca * ca)) / ca;
  let R = h * tanTheta;
  if (r > R) { return vec3f(0.0); }
  let radial = max(0.0, 1.0 - r / max(R, 1e-4));
  let falloff = radial * radial / max(h * h, 1.0);
  let toL = -v / max(h, 1e-4);
  let ndl = max(dot(n, normalize(toL)), 0.0);
  if (ndl <= 0.0) { return vec3f(0.0); }
  let vis = select(1.0, 0.0, occluded(p + n * 0.02, normalize(toL), h * 0.985));
  return U.coneColor.rgb * intensity * falloff * ndl * vis;
}

// ------------------------- 光锥体积（主射线段积分） -------------------------
// 返回 rgb=内散射辐亮度，a=该段透射率（供表面项相乘）
fn coneVolume(ro: vec3f, rd: vec3f, tSurface: f32, r: ptr<function, Rng>) -> vec4f {
  let intensity = U.conePos.w;
  if (intensity <= 0.0 || tSurface <= 0.0) { return vec4f(vec3f(0.0), 1.0); }
  let apex = U.conePos.xyz;
  let dc = normalize(U.coneDir.xyz);
  let ca = U.coneDir.w;
  let ca2 = ca * ca;
  let L = U.coneParams.x;
  let tanTheta = sqrt(max(0.0, 1.0 - ca2)) / ca;

  // 射线 ∩ 无限锥面： A t² + B t + C = 0（推导见文件头注释）
  let m = ro - apex;
  let dDotC = dot(rd, dc);
  let mDotC = dot(m, dc);
  let A = dot(rd, rd) * ca2 - dDotC * dDotC;
  let B = 2.0 * (dot(m, rd) * ca2 - mDotC * dDotC);
  let C = dot(m, m) * ca2 - mDotC * mDotC;
  let disc = B * B - 4.0 * A * C;
  var seg0 = -1.0;
  var seg1 = -1.0;
  if (abs(A) < 1e-9) {
    // 射线与锥面母线平行：仅当起点已在锥内时整段在锥内
    if (C < 0.0) { seg0 = 0.0; seg1 = tSurface; }
  } else if (A > 0.0) {
    // 凸二次：f<0 的区间在两根之间 = 锥内
    if (disc > 0.0) {
      let sq = sqrt(disc);
      let inv2A = 1.0 / (2.0 * A);
      let t0 = (-B - sq) * inv2A;
      let t1 = (-B + sq) * inv2A;
      seg0 = min(t0, t1);
      seg1 = max(t0, t1);
    }
  } else {
    // 凹二次（射向几乎沿锥轴）：锥内 = 根区间之外
    if (C < 0.0) {
      let sq = sqrt(disc);
      let inv2A = 1.0 / (2.0 * A);
      let t0 = (-B - sq) * inv2A;
      let t1 = (-B + sq) * inv2A;
      seg0 = 0.0;
      seg1 = min(t0, t1);
    } else if (disc > 0.0) {
      let sq = sqrt(disc);
      let inv2A = 1.0 / (2.0 * A);
      let t0 = (-B - sq) * inv2A;
      let t1 = (-B + sq) * inv2A;
      seg0 = max(t0, t1);
      seg1 = 1e6;
    }
  }
  if (seg0 < 0.0) { return vec4f(vec3f(0.0), 1.0); }
  let s0 = max(seg0, 0.0);
  let s1 = min(seg1, tSurface);
  if (s1 <= s0) { return vec4f(vec3f(0.0), 1.0); }

  // 锥内实际有效长度限制（高度 [0,L]）：粗略用轴向投影的参数区间
  // 以采样点的逐点检测兜底，这里只做区间粗裁剪加速
  let steps = u32(U.coneParams.z);
  let shadowStride = u32(max(1.0, U.coneParams.w));
  let dt = (s1 - s0) / f32(steps);
  let sigmaT = 0.028;                       // 介质消光系数（雾锥浓度）
  var trans = 1.0;
  var inscatter = vec3f(0.0);
  let phaseG = 0.35;
  let g = phaseG;
  let phase = (1.0 - g * g) / (4.0 * 3.14159265 * pow(1.0 + g * g - 2.0 * g * dot(rd, dc), 1.5));

  for (var i = 0u; i < steps; i = i + 1u) {
    let tJ = s0 + dt * (f32(i) + rngF(r));
    let p = ro + rd * tJ;
    let v = p - apex;
    let h = dot(v, dc);
    if (h < 0.0 || h > L) { continue; }
    let cp = v - dc * h;
    let rr = length(cp);
    let R = h * tanTheta;
    if (rr > R) { continue; }
    let radial = max(0.0, 1.0 - rr / max(R, 1e-4));
    let axial = 1.0 - h / L;
    // 光可见性：朝光源（锥顶）打阴影光线，按 stride 抽稀
    var vis = 1.0;
    if (i % shadowStride == 0u) {
      let toApex = apex - p;
      let dist = length(toApex);
      vis = select(1.0, 0.0, occluded(p, toApex / dist, dist * 0.985));
    }
    let Le = U.coneColor.rgb * intensity * radial * radial * axial * vis;
    inscatter = inscatter + Le * phase * trans * dt;
    trans = trans * exp(-sigmaT * dt);
    if (trans < 0.01) { break; }
  }
  return vec4f(inscatter, trans);
}

// ------------------------- 表面材质求值 -------------------------
// 返回 vec4f：rgb = 本命中点的直接光 + 自发光；a = 槽位约定（保留）
struct SurfaceResult {
  direct   : vec3f,
  albedo   : vec3f,
  isSpec   : bool,     // 走镜面弹射（水面/玻璃/湿地水洼）
  specDir  : vec3f,
  specTint : vec3f,
  emissive : vec3f,
  killed   : bool,    // 吸收（如水面深色部分）
  killTint : vec3f,
};

fn facadeAlbedo(slot: f32, uv: vec2f, vc: vec3f, n: vec3f, r: ptr<function, Rng>) -> vec3f {
  let uvw = uv + vc.xy * 4.0;   // 顶点色 xy 携带逐栋 UV 偏移（契约四）
  var base = vec3f(0.5);
  if (slot < 0.5) {
    base = texBilinear(texStucco, uvw);
  } else if (slot < 1.5) {
    base = texBilinear(texMixed, uvw);
  } else {
    base = texBilinear(texGlass, uvw);
  }
  // 顶点色 z 通道：逐栋亮度/色相扰动
  let tint = mix(vec3f(1.0), vc.zzz * 2.0, 0.6);
  return clamp(base * tint, vec3f(0.02), vec3f(1.0));
}

// 夜景窗灯：程序化窗格 + 逐窗哈希（城市夜景的灵魂）
fn windowEmission(slot: f32, uv: vec2f, n: vec3f, r: ptr<function, Rng>) -> vec3f {
  let nightF = clamp(1.0 - length(U.sunColor.rgb) * 0.22, 0.0, 1.0);
  if (nightF < 0.05) { return vec3f(0.0); }
  if (abs(n.y) > 0.6) { return vec3f(0.0); }   // 屋顶/地面不发光
  let win = vec2f(fract(uv.x * 0.9), fract(uv.y * 1.4));
  let inWin = select(0.0, 1.0, win.x > 0.18 && win.x < 0.82 && win.y > 0.22 && win.y < 0.78);
  if (inWin < 0.5) { return vec3f(0.0); }
  let cell = floor(vec2f(uv.x * 0.9, uv.y * 1.4));
  let h = hash21(cell);
  if (h < 0.42) { return vec3f(0.0); }         // 42% 的窗是暗的
  let warmth = mix(vec3f(1.0, 0.72, 0.42), vec3f(0.72, 0.82, 1.0), step(0.86, h));
  let flicker = 0.75 + 0.25 * sin(U.misc.x * (1.0 + h * 3.0) + h * 40.0);
  return warmth * (0.6 + h * 1.6) * nightF * flicker * 2.2;
}

fn shadeSurface(hit: Hit, rd: vec3f, r: ptr<function, Rng>) -> SurfaceResult {
  var res: SurfaceResult;
  res.direct = vec3f(0.0);
  res.emissive = vec3f(0.0);
  res.killed = false;
  res.isSpec = false;
  res.specTint = vec3f(1.0);
  res.killTint = vec3f(0.0);
  let n0 = hit.n;

  // —— 水面（槽位 50）——
  if (hit.slot > 49.5 && hit.slot < 50.5) {
    let n = waveNormal(hit.uv);              // hit.uv = (p.x, p.z)
    // Fresnel 分裂：反射继续追踪（真倒影），否则吸收为深水色
    let f0 = vec3f(0.02);
    let F = fresnelSchlick(clamp(dot(-rd, n), 0.0, 1.0), f0);
    // 太阳/月亮高光（波光粼粼的物理来源：粗糙度极低 + 法线高频扰动）
    let sunDir = sampleSunDir(rngF2(r));
    let h = normalize(sunDir - rd);
    let ndh = max(dot(n, h), 0.0);
    // GGX (α 很小) —— 波光
    let aG = 0.065;
    let dGGX = aG * aG / (3.14159265 * pow(ndh * ndh * (aG * aG - 1.0) + 1.0, 2.0));
    let glint = U.sunColor.rgb * dGGX * 0.9;
    // 聚光在水面上的亮带
    let spot = spotLight(hit.p + n * 0.02, n) * 0.6;
    res.direct = glint * 0.5 + spot;
    if (rngF(r) < clamp(F * 2.2, 0.0, 0.92)) {
      res.isSpec = true;
      res.specDir = reflect(rd, n);
      res.specTint = vec3f(1.0);
    } else {
      let deep = vec3f(0.012, 0.05, 0.07);
      res.killed = true;
      res.killTint = deep * (1.0 - F) + vec3f(0.02, 0.10, 0.12) * max(n.y, 0.0);
    }
    return res;
  }

  // —— 地面（槽位 100）：湿度场 + 水洼镜面 = 地面反光 ——
  if (hit.slot > 99.5 && hit.slot < 100.5) {
    let wetBase = U.ground.x;
    let wet = clamp(wetBase * (0.45 + 0.9 * fbm(hit.uv * U.ground.y * 0.08)), 0.0, 1.0);
    let puddle = smoothstep(0.62, 0.85, fbm(hit.uv * U.ground.y * 0.03 + 7.7)) * wetBase;
    let rough = mix(0.85, 0.12, wet);
    let gray = U.ground.w;
    let albedo = vec3f(gray, gray * 0.98, gray * 0.95) * mix(1.0, 0.45, wet);
    let n = normalize(vec3f((fbm(hit.uv * 1.7) - 0.5) * 0.12, 1.0, (fbm(hit.uv * 1.7 + 3.3) - 0.5) * 0.12));

    res.direct = sunLight(hit.p, n, r) * albedo * (1.0 - puddle * 0.7);
    res.direct = res.direct + spotLight(hit.p, n) * albedo * 2.0;
    // 环境光（天空辐射 × 上半球权重）
    res.direct = res.direct + U.ambient.rgb * albedo * (n.y * 0.5 + 0.5);

    // 弹射：湿地/水洼按 Fresnel 概率走镜面（粗糙度扰动方向），否则漫反射
    let f0 = vec3f(0.03);
    let F = fresnelSchlick(clamp(dot(-rd, n), 0.0, 1.0), f0);
    let pSpec = clamp(F * (0.4 + wet * 0.9) + puddle * 0.85, 0.0, 0.9);
    if (rngF(r) < pSpec) {
      res.isSpec = true;
      let mir = reflect(rd, n);
      // 粗糙度 → 方向扰动
      let jit = diskSample(rngF2(r)) * rough * 0.9;
      let b = basis(n);
      res.specDir = normalize(mir + b * vec3f(jit, 0.0));
      if (dot(res.specDir, n) < 0.0) { res.specDir = mir; }
      res.specTint = mix(vec3f(1.0), vec3f(0.94, 0.97, 1.0), puddle);
    } else {
      res.albedo = albedo;
    }
    return res;
  }

  // —— 角色（槽位 255）——
  if (hit.slot > 254.5) {
    let albedo = vec3f(0.75, 0.30, 0.22);   // 角色代理涂装（游戏侧可扩展为顶点色）
    res.direct = sunLight(hit.p, n0, r) * albedo;
    res.direct = res.direct + spotLight(hit.p, n0) * albedo * 2.4;
    res.direct = res.direct + U.ambient.rgb * albedo * (n0.y * 0.5 + 0.5);
    res.albedo = albedo;
    return res;
  }

  // —— 建筑 facade（槽位 0/1/2）——
  if (hit.slot < 2.5) {
    let flip = select(false, true, dot(n0, rd) > 0.0); // 内外一致化
    let n = select(n0, -n0, flip);
    let albedo = facadeAlbedo(hit.slot, hit.uv, hit.vc, n, r);
    res.emissive = windowEmission(hit.slot, hit.uv, n, r);

    if (hit.slot > 1.5) {
      // 玻璃幕墙：薄玻璃近似，Fresnel 概率反射/透射
      let F = fresnelSchlick(clamp(dot(-rd, n), 0.0, 1.0), vec3f(0.045));
      if (rngF(r) < F.x * 1.4) {
        res.isSpec = true;
        let mir = reflect(rd, n);
        let jit = diskSample(rngF2(r)) * 0.03;
        let b = basis(n);
        res.specDir = normalize(mir + b * vec3f(jit, 0.0));
        res.specTint = vec3f(0.9);
      } else {
        res.killed = true;
        res.killTint = vec3f(0.10, 0.16, 0.15);   // 透射带色（透过看室内暗部）
      }
      res.direct = res.direct + sunLight(hit.p, n, r) * 0.12; // 玻璃残留漫反射
      return res;
    }

    res.direct = sunLight(hit.p, n, r) * albedo;
    res.direct = res.direct + spotLight(hit.p, n) * albedo * 2.2;
    res.direct = res.direct + U.ambient.rgb * albedo * (n.y * 0.5 + 0.5);
    res.albedo = albedo;
    return res;
  }

  // 兜底：黑体（不应到达）
  res.killed = true;
  res.killTint = vec3f(0.0);
  return res;
}

// ------------------------- 主入口 -------------------------
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let W = u32(U.resFrame.x);
  let H = u32(U.resFrame.y);
  if (gid.x >= W || gid.y >= H) { return; }

  let frame = u32(U.resFrame.z);
  let maxBounces = u32(U.resFrame.w);
  var rng = rngSeed(gid.xy * vec2u(1u, 7919u), frame);

  // 相机光线（亚像素抖动抗锯齿）
  let jitter = rngF2(&rng) - 0.5;
  let ndc = (vec2f(gid.xy) + 0.5 + jitter) / vec2f(f32(W), f32(H)) * 2.0 - 1.0;
  let tanF = U.camPos.w;
  let rd = normalize(U.camFwd.xyz + U.camRight.xyz * ndc.x * tanF + U.camUp.xyz * ndc.y * tanF);
  let ro = U.camPos.xyz;

  // —— 主射线求交 ——
  let first = traceTLAS(ro, rd, 1e5);

  // —— 光锥体积（沿主射线段）——
  let vol = coneVolume(ro, rd, select(1e5, first.t, first.t > 0.0), &rng);

  var radiance = vol.rgb;
  var throughput = vec3f(1.0) * vol.a;

  // —— 表面 + 弹射循环 ——
  var o = ro;
  var d = rd;
  var bounced = false;
  for (var bounce = 0; bounce <= maxBounces; bounce = bounce + 1) {
    var hit = first;
    if (bounced) { hit = traceTLAS(o, d, 1e5); }
    if (hit.t <= 0.0 || hit.t >= 1e5) {
      radiance = radiance + throughput * skyColor(d);
      break;
    }

    let sr = shadeSurface(hit, d, &rng);
    radiance = radiance + throughput * (sr.direct + sr.emissive);

    if (sr.killed) {
      radiance = radiance + throughput * sr.killTint;
      break;
    }

    var nextDir: vec3f;
    var nextTint: vec3f;
    if (sr.isSpec) {
      nextDir = sr.specDir;
      nextTint = sr.specTint;
    } else {
      // 余弦加权漫反射弹射（间接光来源）
      nextDir = cosineHemisphere(hit.n, rngF2(&rng));
      // albedo / π 概率密度里的 π 被余弦采样约掉：tint = albedo
      nextTint = sr.albedo;
    }
    if (dot(nextDir, hit.n) <= 0.0 && !sr.isSpec) { break; } // 数值兜底

    throughput = throughput * nextTint;
    // 俄罗斯轮盘（bounce>1 起手，移动端少弹射时基本不触发）
    if (bounce >= 2) {
      let pCont = clamp(max(throughput.x, max(throughput.y, throughput.z)), 0.05, 0.95);
      if (rngF(&rng) > pCont) { break; }
      throughput = throughput / pCont;
    }
    o = hit.p + hit.n * 0.02 * select(1.0, -1.0, dot(nextDir, hit.n) < 0.0);
    d = nextDir;
    bounced = true;
  }

  // —— 累积：运行和（除法与 tonemap 在 present/game 侧）——
  let prev = textureLoad(prevAccum, vec2u(gid.xy), 0).rgb;
  textureStore(outAccum, vec2u(gid.xy), vec4f(prev + radiance, 1.0));
}
`;

/* ════════════════ Present 着色器（独立运行/调试展示）（原 src/rt/shaders/present.wgsl.js） ════════════════ */

/**
 * Present 着色器 —— 光追独立运行/调试用的展示通道
 *
 * 契约五说明：正式接入游戏时，游戏侧拿走 accum 纹理（线性 HDR 运行和，
 * 需除以 sampleCount）自行 tonemap 合成。本通道仅用于：
 *   1. 演示页独立运行（无游戏合成层时）
 *   2. 光追侧自检调参
 * 输出：ACES tonemap + sRGB 编码。
 */

const PRESENT_WGSL_VS = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var o: VsOut;
  // 全屏大三角
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  o.uv = xy;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
`;

const PRESENT_WGSL_FS = /* wgsl */ `
@group(0) @binding(0) var accum : texture_2d<f32>;
@group(0) @binding(1) var<uniform> Present : vec4f; // x=sampleCount y=exposure z=w H=保留

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let dim = textureDimensions(accum, 0u);
  let uvw = vec2u(clamp(in.uv, vec2f(0.0), vec2f(1.0)) * vec2f(f32(dim.x), f32(dim.y)));
  let hdr = textureLoad(accum, uvw, 0).rgb / max(Present.x, 1.0);
  let mapped = aces(hdr * Present.y);
  // sRGB OETF
  let srgb = select(1.055 * pow(mapped, vec3f(1.0 / 2.4)) - 0.055, mapped * 12.92,
                    mapped <= vec3f(0.0031308));
  return vec4f(srgb, 1.0);
}
`;

/* ════════════════ 路径追踪编排（uniform 打包/累积乒乓/失效重置）（原 src/rt/PathTracer.js） ════════════════ */

/**
 * ============================================================================
 * PathTracer —— 管线编排：uniform 打包 / 累积乒乓 / 失效重置 / GPU 帧时间
 * ============================================================================
 *
 * 每帧流程（对应契约三）：
 *   1. syncCamera / syncLighting 由 GameAdapter 调用，写入 uniforms
 *   2. 若 invalidation 计数变化 → 清累积（loadOp=clear 空渲染通道）
 *   3. dispatch 路径追踪 compute（8×8 workgroup，一线程一像素）
 *      outAccum = prevAccum + 本帧样本
 *   4. present render pass（可选）：accum / sampleCount → ACES → sRGB
 *   5. 交换乒乓；sampleCount 到累积上限后停止累积（静态场景收敛，省电）
 *
 * uniform 布局：64 个 vec4f，见 common.wgsl.js 的 Uniforms 注释。
 * ============================================================================
 */


const U_SIZE_VEC4 = 18; // 18 个 vec4 = 72 个 f32 = 288 B（含填充）

class PathTracer {
  /**
   * @param {RTDevice} rtDevice
   * @param {GeometryStore} store
   * @param {QualityController} quality
   * @param {HTMLCanvasElement} canvas
   */
  constructor(rtDevice, store, quality, canvas) {
    this.rt = rtDevice;
    this.device = rtDevice.device;
    this.store = store;
    this.quality = quality;
    this.canvas = canvas;

    this.frameIndex = 0;
    this.sampleCount = 0;
    this._invalVersionSeen = -1;
    this._gpuGeomVersion = -1;

    // 状态同步缓存（契约三：游戏侧每帧调用，未设置项用安全默认）
    this.cam = { pos: [8, 4, 14], right: [-1, 0, 0], up: [0, 1, 0], fwd: [0, -0.2, -1], tanHalfFov: 0.55 };
    this.sun = { dir: [-0.4, 0.5, -0.6], color: [3.2, 2.6, 2.0], angularRadius: 0.03 };
    this.ambientRGB = [0.10, 0.12, 0.18];
    this.exposure = 1.0;
    this.accumLimit = quality.preset.accumLimit;
    this.maxBounces = quality.preset.maxBounces;
    this.cone = {
      pos: [6, 9, 6], dir: [0.28, -1, 0.28], intensity: 5.0,
      cosHalfAngle: 0.90, length: 11, baseRadius: 5.4,
      color: [1.0, 0.86, 0.62], steps: quality.preset.coneSteps, shadowStride: 3,
    };
    this.water = { level: 0.0, cx: 0, cz: -60, hx: 70, hz: 55, enabled: true, amp: 0.16, freq: 0.35 };
    this.ground = { wetness: 0.7, puddleScale: 1.0, reflectBoost: 1.0, gray: 0.16 };
    this.time = 0;
  }

  /** GPU 资源初始化（管线/缓冲/纹理）。几何上传在首次 frame() 或 mount 回调时 */
  async init() {
    const device = this.device;

    // —— uniform ——
    this.uniformBuf = this.rt.allocBuffer('uniforms', U_SIZE_VEC4 * 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    // —— 几何 storage buffers（惰性创建；块变更时重建） ——
    this.geomBuffers = null;

    // —— TLAS + 实例（每帧可变） ——
    this.tlasBuf = this.rt.allocBuffer('tlas', 64 * 16 * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.instBufA = this.rt.allocBuffer('instA', 128 * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.instBufB = this.rt.allocBuffer('instB', 128 * 16,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

    // —— 累积纹理乒乓 ——
    const preset = this.quality.preset;
    this.accumFormat = preset.accumFormat; // 'rgba32float' PC / 'rgba16float' 移动端
    this._makeAccumTextures();

    // —— 管线 ——
    // 累积纹理格式按档位注入 WGSL（rgba32float PC / rgba16float 移动端）
    const ptModule = device.createShaderModule({
      code: (COMMON_WGSL + PATHTRACE_WGSL).replaceAll('__ACCUM_FORMAT__', this.accumFormat),
      label: 'pathtrace',
    });
    // 编译期错误浮出（WGSL 语法错在这里暴露，而不是黑屏）
    if (ptModule.getCompilationInfo) {
      const info = await ptModule.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) {
        const detail = errs.map((e) => `line ${e.lineNum}: ${e.message}`).join('\n');
        throw new Error('WGSL 编译失败:\n' + detail);
      }
    }

    this.ptPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: ptModule, entryPoint: 'main' },
    });

    // present 管线
    const vsMod = device.createShaderModule({ code: PRESENT_WGSL_VS });
    const fsMod = device.createShaderModule({ code: PRESENT_WGSL_FS });
    if (fsMod.getCompilationInfo) {
      const info = await fsMod.getCompilationInfo();
      const errs = info.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error('present WGSL 编译失败: ' + errs[0].message);
    }
    this.ctx = this.canvas.getContext('webgpu');
    this.ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    this.presentFormat = navigator.gpu.getPreferredCanvasFormat();
    this.presentPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: vsMod, entryPoint: 'vs' },
      fragment: {
        module: fsMod, entryPoint: 'fs',
        targets: [{ format: this.presentFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.presentUniform = this.rt.allocBuffer('presentU', 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    // facade 纹理由 MaterialLibrary 注入（setFacadeTextures）
    this.facadeTextures = null;
    this.bindGroup = null;
  }

  _makeAccumTextures() {
    const [W, H] = this._renderSize();
    if (this.accumA) { this.rt.free('accumA', this.accumA); this.rt.free('accumB', this.accumB); }
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const desc = { size: [W, H], format: this.accumFormat, usage };
    this.accumA = this.rt.allocTexture('accumA', desc);
    this.accumB = this.rt.allocTexture('accumB', desc);
    this.ping = 0;
  }

  _renderSize() {
    const s = this.quality.scale * this.quality.preset.renderScale;
    const W = Math.max(64, Math.round(this.canvas.width * s));
    const H = Math.max(64, Math.round(this.canvas.height * s));
    return [W, H];
  }

  /** MaterialLibrary 上传三张 facade 贴图后调用，重建 bind group */
  setFacadeTextures(texStucco, texMixed, texGlass) {
    this.facadeTextures = [texStucco, texMixed, texGlass];
    this.bindGroup = null;
  }

  /** 几何（BLAS 串联数组）上传到 GPU；块 mount/unmount 后由 GameAdapter 触发 */
  uploadGeometry() {
    const arr = this.store.exportArrays();
    const device = this.device;
    if (this.geomBuffers) {
      this.rt.free('nodes', this.geomBuffers.nodes);
      this.rt.free('tris', this.geomBuffers.triIndices);
      this.rt.free('verts', this.geomBuffers.vertices);
      this.rt.free('vcol', this.geomBuffers.vcolors);
      this.rt.free('tmeta', this.geomBuffers.triMeta);
    }
    const mk = (name, arrView) => {
      const bytes = Math.max(16, arrView.byteLength);
      const b = this.rt.allocBuffer(name, bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      if (arrView.byteLength > 0) {
        device.queue.writeBuffer(b, 0, arrView.buffer, arrView.byteOffset, arrView.byteLength);
      }
      return b;
    };
    this.geomBuffers = {
      nodes: mk('nodes', arr.nodes),
      triIndices: mk('tris', arr.triIndices),
      vertices: mk('verts', arr.vertices),
      vcolors: mk('vcol', arr.colors),
      triMeta: mk('tmeta', arr.triMeta),
    };
    this._gpuGeomVersion = this.store.version;
    this.bindGroup = null; // 布局不变但内容变了 → 无需重建；保持复用
  }

  /** 每帧（或每次相机/光照/TLAS 变化）写 uniforms */
  _packUniforms() {
    const U = new Float32Array(U_SIZE_VEC4 * 4);
    const put = (i, a, b, c, d) => { U[i*4] = a; U[i*4+1] = b; U[i*4+2] = c; U[i*4+3] = d; };
    const [W, H] = this._renderSize();
    put(0,  this.cam.pos[0], this.cam.pos[1], this.cam.pos[2], this.cam.tanHalfFov);
    put(1,  ...this.cam.right, 0);
    put(2,  ...this.cam.up, 0);
    put(3,  ...this.cam.fwd, 0);
    put(4,  W, H, Math.min(this.frameIndex, 65535), this.maxBounces);
    put(5,  ...this.sun.dir, this.sun.angularRadius);
    put(6,  ...this.sun.color, this.exposure);
    put(7,  ...this.ambientRGB, this.accumLimit);
    const s = this.store.stats();
    let tlasNodeCount = 0, instCount = 0;
    if (this.store.tlas) { tlasNodeCount = this.store.tlas.nodes.length / 8; instCount = this.store.tlas.instances.length; }
    put(8,  s.nodes, s.tris, s.verts, tlasNodeCount);
    put(9,  ...this.cone.pos, this.cone.intensity);
    put(10, ...this.cone.dir, this.cone.cosHalfAngle);
    put(11, this.cone.length, this.cone.baseRadius, this.cone.steps, this.cone.shadowStride);
    put(12, ...this.cone.color, 0);
    put(13, this.water.level, this.water.cx, this.water.cz, this.water.enabled ? 1 : 0);
    put(14, this.water.hx, this.water.hz, this.water.amp, this.water.freq);
    put(15, this.ground.wetness, this.ground.puddleScale, this.ground.reflectBoost, this.ground.gray);
    put(16, this.time, 0, this.quality.scale, 0);
    put(17, this.sampleCount, 0, 0, 0);
    this.device.queue.writeBuffer(this.uniformBuf, 0, U);
  }

  _ensureBindGroup() {
    if (this.bindGroup && this.ping === this._bgPing) return;
    const prevTex = this.ping === 0 ? this.accumB : this.accumA;
    const outTex = this.ping === 0 ? this.accumA : this.accumB;
    const [t0, t1, t2] = this.facadeTextures || [this._dummyTex(), this._dummyTex(), this._dummyTex()];
    this.bindGroup = this.device.createBindGroup({
      layout: this.ptPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.geomBuffers.nodes } },
        { binding: 2, resource: { buffer: this.geomBuffers.triIndices } },
        { binding: 3, resource: { buffer: this.geomBuffers.vertices } },
        { binding: 4, resource: { buffer: this.geomBuffers.vcolors } },
        { binding: 5, resource: { buffer: this.geomBuffers.triMeta } },
        { binding: 6, resource: { buffer: this.tlasBuf } },
        { binding: 7, resource: { buffer: this.instBufA } },
        { binding: 8, resource: { buffer: this.instBufB } },
        { binding: 9, resource: prevTex.createView() },
        { binding: 10, resource: outTex.createView() },
        { binding: 11, resource: t0.createView() },
        { binding: 12, resource: t1.createView() },
        { binding: 13, resource: t2.createView() },
      ],
    });
    this._bgPing = this.ping;
  }

  _dummyTex() {
    if (!this._dummy) {
      this._dummy = this.rt.allocTexture('dummy', {
        size: [4, 4], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    return this._dummy;
  }

  /** 失效信号 → 清累积（契约三：相机移动/块增删/光照预设变更都调这个） */
  resetAccumulation() {
    this.sampleCount = 0;
    const [W, H] = this._renderSize();
    // 空渲染通道 loadOp=clear 即可完成清屏，无需任何 draw
    for (const t of [this.accumA, this.accumB]) {
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: t.createView(),
          loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store',
        }],
      });
      pass.end();
      this.device.queue.submit([enc.finish()]);
    }
  }

  /**
   * 渲一帧。TLAS 数据由 GameAdapter 已写入 store.tlas；
   * @returns {GPURenderPassEncoder 之后的纹理} accumOut（供游戏合成的线性 HDR 运行和）
   */
  frame(tlasArrayF32, instAArray, instBArray) {
    const [W, H] = this._renderSize();
    // 分辨率变化（自适应缩放/窗口变化）→ 重建累积纹理并重置
    if (!this.accumA || this.accumA.width !== W || this.accumA.height !== H) {
      this._makeAccumTextures();
      this.sampleCount = 0;
    }
    if (this.store.version !== this._invalVersionSeen) {
      if (this._invalVersionSeen >= 0) { /* 块增删：几何重传由 GameAdapter 先行 */ }
      this._invalVersionSeen = this.store.version;
      this.sampleCount = 0;
    }

    // TLAS / 实例缓冲按需扩容（城市流式挂载时实例数会增长）
    const needTlas = Math.max(64, tlasArrayF32.byteLength);
    const needInst = Math.max(64, instAArray.byteLength);
    if (needTlas > this.tlasBuf.size) {
      this.rt.free('tlas', this.tlasBuf);
      this.tlasBuf = this.rt.allocBuffer('tlas', needTlas, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.bindGroup = null;
    }
    if (needInst > this.instBufA.size) {
      this.rt.free('instA', this.instBufA); this.rt.free('instB', this.instBufB);
      this.instBufA = this.rt.allocBuffer('instA', needInst, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.instBufB = this.rt.allocBuffer('instB', needInst, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.bindGroup = null;
    }

    this.device.queue.writeBuffer(this.tlasBuf, 0, tlasArrayF32.buffer, tlasArrayF32.byteOffset, tlasArrayF32.byteLength);
    this.device.queue.writeBuffer(this.instBufA, 0, instAArray.buffer, instAArray.byteOffset, instAArray.byteLength);
    this.device.queue.writeBuffer(this.instBufB, 0, instBArray.buffer, instBArray.byteOffset, instBArray.byteLength);

    this._packUniforms();
    this._ensureBindGroup();

    const enc = this.device.createCommandEncoder();
    // —— compute：路径追踪 + 累积 ——
    const cp = enc.beginComputePass();
    cp.setPipeline(this.ptPipeline);
    cp.setBindGroup(0, this.bindGroup);
    const gx = Math.ceil(W / 8), gy = Math.ceil(H / 8);
    cp.dispatchWorkgroups(gx, gy);
    cp.end();

    // —— present（演示页调试输出；游戏接入时可跳过） ——
    if (this.enablePresent !== false) {
      const sc = Math.min(this.sampleCount + 1, this.accumLimit);
      this.device.queue.writeBuffer(this.presentUniform, 0,
        new Float32Array([sc, this.exposure, 0, 0]));
      const prevTex = this.ping === 0 ? this.accumB : this.accumA;
      const bg = this.device.createBindGroup({
        layout: this.presentPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: prevTex.createView() },
          { binding: 1, resource: { buffer: this.presentUniform } },
        ],
      });
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      rp.setPipeline(this.presentPipeline);
      rp.setBindGroup(0, bg);
      rp.draw(3);
      rp.end();
    }

    this.device.queue.submit([enc.finish()]);
    this.ping ^= 1;
    if (this.sampleCount < this.accumLimit) this.sampleCount++;
    this.frameIndex++;
    // 返回刚写完的 accum（交换前的那张）
    return this.ping === 0 ? this.accumA : this.accumB;
  }

  dispose() {
    this.rt.free('uniforms', this.uniformBuf);
    this.rt.free('tlas', this.tlasBuf);
    this.rt.free('instA', this.instBufA);
    this.rt.free('instB', this.instBufB);
    this.rt.free('presentU', this.presentUniform);
    if (this.accumA) { this.rt.free('accumA', this.accumA); this.rt.free('accumB', this.accumB); }
  }
}

/* ════════════════ 材质库（契约四贴图加载 + 程序化兜底）（原 src/rt/MaterialLibrary.js） ════════════════ */

/**
 * ============================================================================
 * MaterialLibrary —— 契约四：三档 facade 贴图加载 + ID→BSDF 槽位映射
 * ============================================================================
 *
 * 契约四规定贴图路径：
 *   textures/real/facade_stucco_color.webp  (2048², sRGB)
 *   textures/real/facade_mixed_color.webp
 *   textures/real/facade_glass_color.webp
 * roughness 0.84 / metalness 0.0 是 BSDF 参数（WGSL 内按槽位硬编码）。
 *
 * 加载策略（不瞎编）：优先按契约路径 fetch webp；失败（游戏未放素材）时
 * 用 OffscreenCanvas 程序化生成占位贴图并在返回值里如实标注 fallback=true，
 * 游戏侧接入后放真实素材即自动切换。
 *
 * 着色器侧采样为 textureLoad 手动双线性（compute 阶段无采样器），
 * sRGB 解码在着色器内完成——所以这里用 rgba8unorm 而非 rgba8unorm-srgb。
 * ============================================================================
 */

const FACADE_PATHS = {
  stucco: 'textures/real/facade_stucco_color.webp',
  mixed:  'textures/real/facade_mixed_color.webp',
  glass:  'textures/real/facade_glass_color.webp',
};

const ROUGHNESS = { stucco: 0.84, mixed: 0.55, glass: 0.08 }; // 契约四参考值
const METALNESS = { stucco: 0.0, mixed: 0.0, glass: 0.0 };

class MaterialLibrary {
  constructor(rtDevice) {
    this.rt = rtDevice;
    this.device = rtDevice.device;
    this.textures = null;
    this.fallbackUsed = false;
  }

  async load(baseUrl = '') {
    const jobs = ['stucco', 'mixed', 'glass'].map(async (slot) => {
      let bitmap = null;
      try {
        // 契约四路径优先（.webp）；无 webp 编码器的开发环境回落同名 .png
        bitmap = await this._fetchBitmap(baseUrl + FACADE_PATHS[slot])
              ?? await this._fetchBitmap(`${baseUrl}textures/real/facade_${slot}_color.png`);
        if (!bitmap) throw new Error('两路都失败');
      } catch (e) {
        bitmap = this._procedural(slot, 512);
        this.fallbackUsed = true;
      }
      return this._upload(slot, bitmap);
    });
    this.textures = {
      stucco: await jobs[0],
      mixed: await jobs[1],
      glass: await jobs[2],
    };
    return this.textures;
  }

  async _fetchBitmap(url) {
    try {
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      if (bitmap.width < 64) { bitmap.close?.(); return null; }
      return bitmap;
    } catch { return null; }
  }

  _upload(slot, bitmap) {
    const tex = this.rt.allocTexture(`facade_${slot}`, {
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex },
      [bitmap.width, bitmap.height],
    );
    bitmap.close?.();
    return tex;
  }

  /**
   * 程序化占位贴图（游戏未提供素材时的兜底，界面效果依然成立）：
   * stucco = 抹灰墙+窗格 / mixed = 带檐口条纹 / glass = 幕墙玻璃分格
   */
  _procedural(slot, S) {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    if (slot === 'stucco') {
      g.fillStyle = '#8a8378'; g.fillRect(0, 0, S, S);
      // 细颗粒噪声
      for (let i = 0; i < 4000; i++) {
        g.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},200,0.035)`;
        g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
      }
      // 窗：暗格
      const cell = S / 8;
      g.fillStyle = '#20242c';
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        if ((x + y) % 2 === 0) g.fillRect(x * cell + cell * 0.2, y * cell + cell * 0.25, cell * 0.6, cell * 0.5);
      }
    } else if (slot === 'mixed') {
      g.fillStyle = '#9c8f80'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#6f665c';
      for (let y = 0; y < 8; y++) g.fillRect(0, y * S / 8 + S / 8 - 6, S, 6);
      g.fillStyle = '#262a33';
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.fillRect(x * S / 8 + S / 16, y * S / 8 + S / 16, S / 8 - S / 8, S / 8 * 0.45);
      }
    } else {
      // glass：蓝灰幕墙 + 铝框
      g.fillStyle = '#2b3a4a'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#1c2733';
      const cell = S / 12;
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
        g.fillStyle = `rgba(${40 + Math.random() * 30 | 0},${70 + Math.random() * 40 | 0},${95 + Math.random() * 40 | 0},1)`;
        g.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
      }
    }
    return c;
  }
}

/* ════════════════ GameAdapter —— 游戏侧唯一入口（六条契约胶水层）（原 src/game/GameAdapter.js） ════════════════ */

/**
 * ============================================================================
 * GameAdapter —— 六条契约的正式对接层（游戏侧唯一需要 import 的类）
 * ============================================================================
 *
 * 用法（游戏主循环里约 10 行代码完成接入）：
 *
 *   import { GameAdapter } from 'lightcone-rt/src/game/GameAdapter.js';
 *   const lcr = await GameAdapter.create({ canvas, onMode(mode){...} });
 *   // 契约二：区块挂载/卸载（挂到现有 ChunkStream.onMount/onUnmount）
 *   lcr.mount('3,7', geometryGroup, materialIDs);
 *   lcr.unmount('3,7');
 *   // 契约三：每帧同步
 *   lcr.syncCamera(myThreeCamera);      // 直接传 Three.PerspectiveCamera
 *   lcr.setDynamicObjects([{ translation: [x, y, z] }]);  // 角色代理
 *   lcr.render(dt);                     // 内部处理失效/累积/TLAS
 *   // 契约五：outputMode 'A' → lcr.outputTexture() 返回线性 HDR 运行和纹理
 *   //          游戏自行 ÷ sampleCount + tonemap 合成；演示页用 'B' 由光追出画
 *   // 契约六：mode === 'raster-fallback' 时光追不参与，游戏继续现有渲染
 * ============================================================================
 */


class GameAdapter {
  static async create(opts) {
    const adapter = new GameAdapter(opts);
    await adapter._init();
    return adapter;
  }

  constructor(opts) {
    this.opts = opts || {};
    this.canvas = this.opts.canvas;
    this.outputMode = this.opts.outputMode || 'A';
    this.mode = null;
    this.onMode = this.opts.onMode || (() => {});
    this.onError = this.opts.onError || ((e) => console.error('[光锥RT]', e));
    this.mounted = new Set();
    this._geomDirty = false;
    this._lastStoreVersion = -1;
    this._dynamics = [];
    this._frameCount = 0;
  }

  async _init() {
    // —— 契约六：WebGPU 探测，失败即静默降级，绝不抛出 ——
    const rt = await RTDevice.create({
      onDeviceLost: () => this._degrade('device-lost'),
      onError: (e) => this.onError(e),
    });
    this.quality = new QualityController();
    const plat = this.quality.platform;
    if (!rt.ok) {
      this.mode = RUN_MODE.RASTER_FALLBACK;
      this.degradeReason = rt.reason;
      this.onMode(this.mode, rt.reason);
      return;
    }
    try {
      this.rt = rt;
      this.store = new GeometryStore({
        maxTris: Math.min(rt.limits.maxStorageBufferBindingSize ? 4_000_000 : 500_000, plat === PLATFORM.MOBILE ? 600_000 : 4_000_000),
      });
      this.tracer = new PathTracer(rt, this.store, this.quality, this.canvas);
      await this.tracer.init();
      this.materials = new MaterialLibrary(rt);
      const tex = await this.materials.load(this.opts.textureBaseUrl || './');
      this.tracer.setFacadeTextures(tex.stucco, tex.mixed, tex.glass);
      this.tracer.uploadGeometry();
      this.mode = RUN_MODE.WEBGPU_RT;
      this.onMode(this.mode);
    } catch (e) {
      this._degrade('init-failed: ' + e.message);
    }
  }

  /** 契约六降级：清光追资源 → 通知游戏走现有光栅化 */
  _degrade(reason) {
    this.mode = RUN_MODE.RASTER_FALLBACK;
    this.degradeReason = reason;
    try { this.tracer?.dispose(); } catch (_) {}
    this.tracer = null;
    this.onMode(this.mode, reason);
  }

  // ==================== 契约二：生命周期 ====================

  /**
   * @param {string} key          "ix,iz"
   * @param {object} geometryGroup { buckets: [G0|null, G1|null, G2|null],
   *                                 userData: {key,cx,cz,count,file} }
   * @param {string[]} [materialIDs] ['stucco','mixed','glass'] 缺省即三档
   */
  mount(key, geometryGroup, materialIDs) {
    if (this.mode !== RUN_MODE.WEBGPU_RT) return { ok: false, reason: this.mode };
    if (this.mounted.has(key)) return { ok: true, idempotent: true }; // 幂等
    let chunk;
    try {
      chunk = adaptGeometry(key, geometryGroup, materialIDs || MATERIAL_IDS);
    } catch (e) {
      this.onError(new Error(`mount(${key}) 契约校验失败: ${e.message}`));
      return { ok: false, reason: 'contract-violation' };
    }
    const r = this.store.mount(key, chunk, materialIDs || MATERIAL_IDS);
    if (r.ok) {
      this.mounted.add(key);
      this._geomDirty = true; // 失效：清累积在 render() 内统一做
    }
    return r;
  }

  unmount(key) {
    if (this.mode !== RUN_MODE.WEBGPU_RT) return;
    if (!this.mounted.has(key)) return; // 幂等空操作
    this.store.unmount(key);            // 内部必释放 BLAS（防泄漏）
    this.mounted.delete(key);
    this._geomDirty = true;
  }

  // ==================== 契约三：每帧同步 ====================

  /**
   * 接受 Three.js PerspectiveCamera（position/quaternion/fov）或
   * 等价的 {position:{x,y,z}, quaternion:{x,y,z,w}, fov} 鸭子类型。
   */
  syncCamera(cam) {
    let right, up, fwd;
    if (cam._basis) {
      // 直通基向量（演示相机等自带正交基的调用方）
      ({ right, up, fwd } = cam._basis);
    } else {
      const p = cam.position, q = cam.quaternion;
      const v = (x, y, z) => {
        // q * v
        const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        const ix = qw * x + qy * z - qz * y;
        const iy = qw * y + qz * x - qx * z;
        const iz = qw * z + qx * y - qy * x;
        const iw = -qx * x - qy * y - qz * z;
        return [ix * qw + iw * -qx + iy * -qz - iz * -qy,
                iy * qw + iw * -qy + iz * -qx - ix * -qz,
                iz * qw + iw * -qz + ix * -qy - iy * -qx];
      };
      right = v(1, 0, 0); up = v(0, 1, 0); fwd = v(0, 0, -1);
    }
    const pArr = cam._basis ? cam.position : cam.position;
    this.tracer.cam.pos = [pArr.x ?? pArr[0], pArr.y ?? pArr[1], pArr.z ?? pArr[2]];
    this.tracer.cam.right = right;
    this.tracer.cam.up = up;
    this.tracer.cam.fwd = fwd;
    this.tracer.cam.tanHalfFov = Math.tan(((cam.fov || cam._fovDeg || 60) * Math.PI) / 360);
    // 相机动了 → 契约三失效信号（render() 检测位置/朝向变化执行）
    const cp = this.tracer.cam.pos;
    const sig = `${cp[0].toFixed(3)},${cp[1].toFixed(3)},${cp[2].toFixed(3)},${fwd[0].toFixed(3)},${fwd[1].toFixed(3)},${fwd[2].toFixed(3)}`;
    if (sig !== this._camSig) { this._camSig = sig; this._camMoved = true; }
  }

  /** 光照预设：day / night / dusk（契约三第二信号）。可传 params 覆盖内置参数。 */
  setLightingPreset(name, params) {
    const P = {
      day:   { sun: { dir: [-0.35, 0.62, -0.5], color: [3.0, 2.7, 2.2], angularRadius: 0.028 }, amb: [0.34, 0.40, 0.52], exposure: 0.9, cone: 0 },
      dusk:  { sun: { dir: [0.82, 0.12, 0.25],  color: [4.2, 1.9, 0.9], angularRadius: 0.045 }, amb: [0.10, 0.10, 0.16], exposure: 1.1, cone: 7.5 },
      night: { sun: { dir: [0.3, 0.75, 0.35],   color: [0.35, 0.42, 0.62], angularRadius: 0.02 }, amb: [0.05, 0.06, 0.10], exposure: 1.5, cone: 9.0 },
    }[name];
    if (!P) return;
    const merged = params
      ? {
          sun: { ...P.sun, ...(params.sun || {}) },
          amb: params.amb || P.amb,
          exposure: params.exposure ?? P.exposure,
          cone: params.cone ?? P.cone,
        }
      : P;
    Object.assign(this.tracer.sun, merged.sun);
    this.tracer.ambientRGB = merged.amb;
    this.tracer.exposure = merged.exposure;
    this.tracer.cone.intensity = merged.cone;
    this._presetChanged = true;
  }

  /** 动态对象（角色等）：translation 米制，代理椭球半径 0.42/0.95/0.42 */
  setDynamicObjects(list) { this._dynamics = list || []; }

  // —— 光锥 / 水面 / 地面 运行时调参（非契约，属于系统 API）——
  setCone(cfg) { Object.assign(this.tracer.cone, cfg); this._presetChanged = true; }
  setWater(cfg) { Object.assign(this.tracer.water, cfg); this._presetChanged = true; }
  setGround(cfg) { Object.assign(this.tracer.ground, cfg); this._presetChanged = true; }

  // ==================== 主循环 ====================

  /**
   * 每帧调用。返回值：
   *   { presented: bool, texture: GPUTexture|null, sampleCount, mode }
   * 契约五（outputMode='A'）：texture 为线性 HDR 运行和（accumTex），
   * 游戏合成时 ÷ sampleCount 后 tonemap。sampleCount 字段同步返回。
   */
  render(dt) {
    if (this.mode !== RUN_MODE.WEBGPU_RT || !this.tracer) {
      return { presented: false, mode: this.mode };
    }
    this._frameCount++;
    this.tracer.time += dt;

    // 失效统一处理（契约三）：几何变 / 相机动 / 预设变 → 清累积
    let invalidated = false;
    if (this._geomDirty || this.store.version !== this._lastStoreVersion) {
      if (!this._geomDirty) { /* store 内部变化（如 compact） */ }
      this.tracer.uploadGeometry();
      this._geomDirty = false;
      this._lastStoreVersion = this.store.version;
      invalidated = true;
    }
    if (this._camMoved) { invalidated = true; this._camMoved = false; }
    if (this._presetChanged) { invalidated = true; this._presetChanged = false; }
    if (invalidated) this.tracer.resetAccumulation();

    // TLAS：静态块缓存 + 动态实例每帧重排（微秒级）
    this.store.rebuildTLAS(this._dynamics.map((d) => ({
      translation: d.translation,
      radius: d.radius || [0.42, 0.95, 0.42],
    })));
    const t = this.store.tlas;
    const nT = t.nodes.length / 8 | 0;
    const nI = t.instances.length;
    const f32 = new Float32Array(nT * 8);
    f32.set(t.nodes);
    const a = new Float32Array(nI * 4);
    const b = new Float32Array(nI * 4);
    for (let i = 0; i < nI; i++) {
      const inst = t.instances[i];
      a[i*4] = inst.nodeOffset; a[i*4+1] = inst.triOffset;
      a[i*4+2] = inst.vertexOffset; a[i*4+3] = inst.kind;
      const tr = inst.translation;
      b[i*4] = tr[0]; b[i*4+1] = tr[1]; b[i*4+2] = tr[2]; b[i*4+3] = 0;
    }

    const outTex = this.tracer.frame(f32, a, b);

    // 自适应分辨率（GPU 时间不可用前几帧用 rAF 兜底）
    const adj = this.quality.frameTime(dt * 1000);
    if (adj.changed) this.tracer.resetAccumulation();

    if (this._frameCount % 60 === 0) {
      const led = this.rt.ledger();
      const aud = this.quality.auditVRAM(led.total);
      if (!aud.ok && aud.suggestedScale < this.quality.scale) {
        this.quality.scale = aud.suggestedScale;
        this.tracer.resetAccumulation();
      }
    }

    return {
      presented: true,
      mode: this.mode,
      // 契约五：A 模式交纹理（线性 HDR 运行和），B 模式光追已自行出画
      texture: this.outputMode === 'A' ? outTex : null,
      sampleCount: this.tracer.sampleCount,
    };
  }

  /** 调试/面板数据 */
  stats() {
    const [resW, resH] = this.tracer?._renderSize?.() ?? [0, 0];
    return {
      mode: this.mode,
      platform: this.quality?.platform,
      scale: this.quality?.scale,
      resW, resH,
      vram: this.rt?.ledger(),
      store: this.store?.stats(),
      samples: this.tracer?.sampleCount,
      textureFallback: this.materials?.fallbackUsed,
    };
  }

  dispose() {
    for (const k of [...this.mounted]) this.unmount(k);
    this.tracer?.dispose();
    this.rt?.destroy?.();
  }
}

/* ════════════════ 统一导出清单 ════════════════ */

export {
  MATERIAL_IDS,
  RUN_MODE,
  OUTPUT_MODE,
  OWNERSHIP,
  COORDINATE_SYSTEM,
  REQUIRED_ATTRIBUTES,
  HEIGHT_BUCKETS,
  SYSTEM_DEFAULTS,
  parseChunkKey,
  validateChunkUserData,
  adaptGeometry,
  mergeChunkGeometry,
  bucketizeMeshes,
  MATERIAL_NAMES,
  GameAdapter,
  PathTracer,
  GeometryStore,
  BLAS,
  RTDevice,
  QualityController,
  MaterialLibrary,
  PLATFORM,
  FACADE_PATHS,
  ROUGHNESS,
  METALNESS,
  GameAdapter as default,
};
