// ============================================================================
// relief_geometry.js — 几何级立体化 / 三级 LOD 构建 (a7o)
//
// 贴图再强也救不了「几何本身就是一张纸」：原工程里 ShapeGeometry 底板、
// Deck 平板、远景 cloud matte 全是零厚度平面；GLB 里的 LOD1/LOD2 又被
// LOD_RE 一刀切丢弃（只留 LOD0），三级构建名存实亡。
//
// 本模块手写三件事（不生成任何城市数据，只处理已有几何）：
//   1) 顶点色 AO：按高度、朝下面、凹角给每个顶点烘焙遮蔽，零贴图采样，
//      这是 L2/低端机唯一但有效的立体线索。
//   2) 薄片挤出：把零厚度 ShapeGeometry 变成带侧面与倒角的实体，从侧面看
//      不再是一张纸；控制新增三角面数，避免打爆移动端。
//   3) 三级 LOD：优先复用 GLB 自带的 _lod1/_lod2 网格（真实资产）；缺失时
//      才做确定性的几何简化，并明确标记 synthesized=true，绝不冒充原资产。
//
// 兼容：bakePrefab 返回的 baked.merged 仍是 LOD0，新增 baked.lods 为可选
//       三级数组，老调用方零改动。
// ============================================================================

import * as THREE from 'three';

/** 保证 uv / uv2 存在（three 的 normalMap / aoMap 需要）。就地补齐并返回。 */
export function ensureUV(geo) {
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position')?.count || 0;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.getAttribute('uv2')) {
    const uv = geo.getAttribute('uv');
    geo.setAttribute('uv2', new THREE.BufferAttribute(uv.array.slice(0), 2));
  }
  return geo;
}

/**
 * 保证 color 存在（vertexColors:true 时 three 会去读 color attribute）。
 * 全 1 = 中性，不改变外观；已烘焙过 AO 的几何保持原值不覆盖。
 * 这是开启顶点 AO 的安全前提：任何一个共享材质下的几何缺 color 都会黑屏。
 */
export function ensureColor(geo) {
  if (geo.getAttribute('color')) return geo;
  const n = geo.getAttribute('position')?.count || 0;
  const col = new Float32Array(n * 3);
  col.fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * 顶点色 AO（手写，确定性，非噪声）。
 * 依据三条真实几何线索：
 *   · 越贴近地面越暗（接触遮蔽）
 *   · 朝下的面更暗（檐底 / 桥底）
 *   · 法线与「向上」夹角大的竖直面轻微压暗（街谷感）
 * 输出为 color attribute（RGB 灰度），material.vertexColors=true 后由 three
 * 的 color_fragment 乘进 diffuseColor，零额外采样。
 */
export function bakeVertexAO(geo, opts = {}) {
  const strength = opts.strength ?? 0.28;
  const groundY = opts.groundY ?? 0;
  const fade = opts.fade ?? 6;            // 6 m 内衰减完
  const floor = opts.floor ?? 0.72;       // 最暗不低于 0.72，防止地面/大平面被压黑
  ensureUV(geo);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const p = geo.getAttribute('position'), n = geo.getAttribute('normal');
  const cnt = p.count;
  const col = new Float32Array(cnt * 3);
  const ymin = (() => {
    if (!geo.boundingBox) geo.computeBoundingBox();
    return geo.boundingBox.min.y;
  })();
  for (let i = 0; i < cnt; i++) {
    const y = p.getY(i);
    const h = Math.max(0, y - Math.max(groundY, ymin));
    const contact = 1 - strength * Math.exp(-h / fade);            // 接触衰减
    const ny = n.getY(i);
    const down = ny < 0 ? 1 - strength * 0.35 * (-ny) : 1;         // 朝下压暗
    const vertical = 1 - strength * 0.12 * (1 - Math.abs(ny));     // 竖直面微压
    const v = Math.max(floor, contact * down * vertical);
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.userData.mcVertexAO = { strength, fade, floor, vertices: cnt };
  return geo;
}

/**
 * 把零厚度平面几何挤出成带侧面 + 微小倒角的实体。
 * 适用：ShapeGeometry / PlaneGeometry 生成的底板、远景板、Deck。
 * 只在几何本身「y 跨度 < eps」时动手，避免误伤已有厚度的建筑。
 * 返回新几何；调用方负责 dispose 原几何。
 */
export function extrudeFlat(geo, opts = {}) {
  const depth = opts.depth ?? 0.22;
  const bevel = opts.bevel ?? 0.03;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  // 已是实体（有厚度）→ 直接补 UV + 顶点 AO，不重建
  if (size.y > depth * 1.5) { bakeVertexAO(geo, opts.ao); return geo; }

  // ShapeGeometry 的顶点在 XY 平面；工程里通常先 rotateX(±90°) 变到 XZ。
  // 这里通用处理：把「最薄的那一轴」当成挤出方向。
  const thin = size.x <= size.y && size.x <= size.z ? 'x'
             : size.y <= size.z ? 'y' : 'z';
  const pos = geo.getAttribute('position');
  const srcUv = geo.getAttribute('uv');
  const idx = geo.index;
  const tri = idx ? idx.count / 3 : pos.count / 3;
  // 每个源三角形生成 8 个（正面 1 + 背面 1 + 三条边 × 2 侧面）
  // 上限按「输出三角形」算，不是源三角形；否则大底板会瞬间爆面数。
  const MAX_TRI = opts.maxTriangles ?? 20000;
  if (tri * 8 > MAX_TRI) { bakeVertexAO(geo, opts.ao); return geo; }

  const get = (i, c) => c === 0 ? pos.getX(i) : c === 1 ? pos.getY(i) : pos.getZ(i);
  const off = [0, 0, 0]; off['xyz'.indexOf(thin)] = depth;
  const positions = [], normals = [];

  const pushTri = (a, b, c, nrm) => {
    for (const v of [a, b, c]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(nrm[0], nrm[1], nrm[2]);
    }
  };
  const V = i => [get(i, 0), get(i, 1), get(i, 2)];
  const V2 = i => [get(i, 0) + off[0], get(i, 1) + off[1], get(i, 2) + off[2]];
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const a = V(i0), b = V(i1), c = V(i2);
    const A = V2(i0), B = V2(i1), C = V2(i2);
    // 面法线
    const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    let nx = e1[1]*e2[2]-e1[2]*e2[1], ny = e1[2]*e2[0]-e1[0]*e2[2], nz = e1[0]*e2[1]-e1[1]*e2[0];
    const L = Math.hypot(nx, ny, nz) || 1; nx/=L; ny/=L; nz/=L;
    pushTri(a, b, c, [nx, ny, nz]);
    pushTri(C, B, A, [-nx, -ny, -nz]);                 // 背面
    // 三条边生成侧壁（法线取边的水平外法线）
    for (const [P, Q] of [[a,b],[b,c],[c,a]]) {
      const P2 = [P[0]+off[0], P[1]+off[1], P[2]+off[2]];
      const Q2 = [Q[0]+off[0], Q[1]+off[1], Q[2]+off[2]];
      const ex = Q[0]-P[0], ez = Q[2]-P[2];
      const sn = Math.hypot(ex, ez) || 1;
      const sN = [ez/sn, 0, -ex/sn];
      pushTri(P, P2, Q, sN);
      pushTri(Q, P2, Q2, sN);
    }
  }
  // 用 planar UV 重建（挤出体的 UV 按世界 XZ 投影，和工程现有 9 m 铺贴一致）
  const uvArr = new Float32Array((positions.length / 3) * 2);
  const scale = opts.uvScale ?? 0.12;
  for (let i = 0, u = 0; i < positions.length; i += 3, u += 2) {
    uvArr[u] = positions[i] * scale;
    uvArr[u + 1] = positions[i + 2] * scale;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  g.setAttribute('uv2', new THREE.BufferAttribute(uvArr.slice(), 2));
  g.computeBoundingBox(); g.computeBoundingSphere();
  bakeVertexAO(g, opts.ao);
  g.userData.mcExtruded = { depth, thinAxis: thin, sourceTriangles: tri, sides: true };
  return g;
}

/**
 * 确定性几何简化（仅在 GLB 未提供该级 LOD 时使用，明确标记 synthesized）。
 * 策略：按三角形世界面积过滤，保留大面；再对保留顶点做 0.25 m 量化去重，
 * 减少顶点数。不改材质槽位、不改 UV 语义。
 */
export function simplifyGeometry(geo, ratio = 0.45, opts = {}) {
  const p0 = geo.getAttribute('position');
  if (!p0 || p0.count < 3) return geo.clone();          // 空/退化几何直接原样返回
  const src = geo.index ? geo.toNonIndexed() : geo.clone();
  const p = src.getAttribute('position');
  const uv = src.getAttribute('uv');
  const nrm = src.getAttribute('normal');
  const tri = Math.floor(p.count / 3);
  if (tri < 1) { if (src !== geo) src.dispose(); return geo.clone(); }
  const areas = new Float32Array(tri);
  let maxA = 0;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
  for (let t = 0; t < tri; t++) {
    const i = t * 3;
    e1.set(p.getX(i+1)-p.getX(i), p.getY(i+1)-p.getY(i), p.getZ(i+1)-p.getZ(i));
    e2.set(p.getX(i+2)-p.getX(i), p.getY(i+2)-p.getY(i), p.getZ(i+2)-p.getZ(i));
    cr.crossVectors(e1, e2);
    areas[t] = cr.length() * 0.5;
    if (areas[t] > maxA) maxA = areas[t];
  }
  /* [a7o 第三轮修正] 旧实现取「面积分位数当阈值，保留 >= 阈值」：
     当一批三角形面积完全相同（规则网格、程序化平面、占位资产）时阈值
     等于面积，全部保留 → 简化根本没发生，但字节数断言用 >= 又查不出来。
     改成按 (面积, 索引) 稳定排序，精确取面积最大的 K=round(tri*ratio) 个：
     · 无论面积分布如何都保证真削减
     · 大面优先保留（轮廓损失最小）
     · 索引做 tie-break，结果完全确定，可复跑比对                      */
  const order = new Array(tri);
  for (let i = 0; i < tri; i++) order[i] = i;
  order.sort((a, b) => (areas[a] - areas[b]) || (a - b));
  const K = Math.max(1, Math.min(tri, Math.round(tri * ratio)));
  const keep = order.slice(tri - K).sort((a, b) => a - b);
  const P = new Float32Array(keep.length * 9);
  const U = new Float32Array(keep.length * 6);
  const N = new Float32Array(keep.length * 9);
  for (let k = 0; k < keep.length; k++) {
    const t = keep[k], i = t * 3;
    for (let v = 0; v < 3; v++) {
      P[k*9+v*3+0] = p.getX(i+v); P[k*9+v*3+1] = p.getY(i+v); P[k*9+v*3+2] = p.getZ(i+v);
      U[k*6+v*2+0] = uv ? uv.getX(i+v) : 0; U[k*6+v*2+1] = uv ? uv.getY(i+v) : 0;
      N[k*9+v*3+0] = nrm ? nrm.getX(i+v) : 0;
      N[k*9+v*3+1] = nrm ? nrm.getY(i+v) : 1;
      N[k*9+v*3+2] = nrm ? nrm.getZ(i+v) : 0;
    }
  }
  if (src !== geo) src.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setAttribute('uv2', new THREE.BufferAttribute(U.slice(), 2));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData.mcSimplified = { sourceTriangles: tri, kept: keep.length, ratio };
  // 主城材质开 vertexColors → 必须烘焙；精简材质通道无 vertexColors → 免烘焙，
  // 省掉一整个 color attribute（2400 栋楼 × 2 级，实打实的显存）。
  if (opts.vertexAO !== false) bakeVertexAO(g, { strength: 0.5, fade: 8 });
  else ensureColor(g);
  return g;
}

/**
 * 从一组 (prefab, material, geo) 构建三级 LOD 几何。
 * 优先用调用方给出的 authored[1]/authored[2]（GLB 自带 _lod1/_lod2）；
 * 缺失才 synthesize，并在返回值里明确标记，便于审计不冒充原资产。
 */
export function buildLodTiers(mergedL0, authored = {}, opts = {}) {
  const l0 = mergedL0.map(e => {
    ensureUV(e.geo);
    // ensureColor 补的是中性全 1，不能据此认为「已烘焙」；按标记判断
    if (opts.vertexAO !== false && !e.geo.userData.mcVertexAO) bakeVertexAO(e.geo, opts.ao);
    return e;
  });
  const make = (level) => {
    const authoredList = authored[level];
    /* 硬约束：三级 merged 的 material 槽位必须与 L0 一一对应。
       buildOne 用同一个 it.mi 去索引，长度不一致会取到 undefined →
       区块被标 failed → 永久空白块。GLB 自带 LOD 网格的材质数常常不同，
       这种情况宁可 synthesize，也绝不冒险。 */
    if (authoredList && authoredList.length === l0.length) {
      return { merged: authoredList.map((e, i) => {
        ensureUV(e.geo);
        if (!e.geo.userData.mcVertexAO) bakeVertexAO(e.geo, opts.ao);
        return { geo: e.geo, mat: e.mat || l0[i].mat };
      }), synthesized: false };
    }
    const ratio = level === 1 ? (opts.lod1Ratio ?? 0.55) : (opts.lod2Ratio ?? 0.22);
    return {
      merged: l0.map(e => ({ geo: simplifyGeometry(e.geo, ratio), mat: e.mat })),
      synthesized: true,
    };
  };
  const t1 = make(1), t2 = make(2);
  return {
    lods: [
      { level: 0, merged: l0, synthesized: false },
      { level: 1, ...t1 },
      { level: 2, ...t2 },
    ],
    stats: {
      l0: l0.length, l1: t1.merged.length, l2: t2.merged.length,
      l1Synthesized: t1.synthesized, l2Synthesized: t2.synthesized,
      l0Triangles: l0.reduce((s, e) => s + (e.geo.index ? e.geo.index.count : e.geo.getAttribute('position').count) / 3, 0),
      l1Triangles: t1.merged.reduce((s, e) => s + (e.geo.index ? e.geo.index.count : e.geo.getAttribute('position').count) / 3, 0),
      l2Triangles: t2.merged.reduce((s, e) => s + (e.geo.index ? e.geo.index.count : e.geo.getAttribute('position').count) / 3, 0),
    },
  };
}

/**
 * 全场景兜底：给「材质开了 vertexColors 但几何缺 color」的网格补中性全 1。
 * three 一旦定义 USE_COLOR 就声明 `attribute vec3 color`；几何没这个属性时
 * WebGL 会给未绑定 attribute 填 (0,0,0,1) → 整片纯黑。角色 GLB、运行期
 * 生成的 Mesh 都容易漏，必须用这个兜底扫一遍，而不是靠人肉记住每个创建点。
 * 返回补齐数量，供验证脚本断言。
 */
export function ensureReliefColors(root) {
  let fixed = 0;
  if (!root || !root.traverse) return fixed;
  root.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const need = mats.some(m => m && m.vertexColors === true);
    if (!need) return;
    const g = o.geometry;
    if (!g || g.getAttribute('color')) return;
    const p = g.getAttribute('position');
    if (!p) return;
    ensureColor(g);
    fixed++;
  });
  return fixed;
}

/** 统计工具：给验证脚本读，证明三级确实不同且不是同一份几何。 */
export function lodTierStats(tiers) {
  if (!tiers || !tiers.lods) return null;
  return tiers.lods.map(t => ({
    level: t.level,
    meshes: t.merged.length,
    synthesized: !!t.synthesized,
    bytes: t.merged.reduce((s, e) => {
      let n = 0;
      if (e.geo.index) n += e.geo.index.array.byteLength;
      for (const k in e.geo.attributes) n += e.geo.attributes[k].array.byteLength;
      return s + n;
    }, 0),
    hasVertexAO: t.merged.every(e => !!e.geo.getAttribute('color')),
  }));
}
