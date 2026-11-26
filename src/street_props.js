// ============================================================
// street_props.js — V4 街道陈设扩量生成模块
// 为每个流式分块程序化填充街道层：路灯、护栏、行道树、消防栓、
// 公交站牌、垃圾桶、长椅。全部实例化（InstancedMesh），
// drawcalls 恒定 ~7/块，与 V3 的 76 drawcalls 预算兼容。
// ============================================================
import * as THREE from 'three';

// 各类陈设的低模几何与颜色（零外部素材、零授权风险）
const PROP_KINDS = [
  { key: 'lamp',    geo: () => new THREE.CylinderGeometry(0.08, 0.12, 6, 6),  color: 0x333844, per: 14, y: 3 },
  { key: 'tree',    geo: () => new THREE.ConeGeometry(1.6, 4.2, 7),           color: 0x2f6b34, per: 10, y: 2.1 },
  { key: 'bollard', geo: () => new THREE.CylinderGeometry(0.09, 0.09, 0.9, 6),color: 0x9aa0a6, per: 16, y: 0.45 },
  { key: 'hydrant', geo: () => new THREE.CylinderGeometry(0.16, 0.2, 0.7, 8), color: 0xb3392f, per: 4,  y: 0.35 },
  { key: 'bench',   geo: () => new THREE.BoxGeometry(1.6, 0.08, 0.45),        color: 0x6b4a2f, per: 5,  y: 0.45 },
  { key: 'bin',     geo: () => new THREE.CylinderGeometry(0.28, 0.24, 0.85, 8),color: 0x3c5148, per: 4,  y: 0.43 },
  { key: 'busstop', geo: () => new THREE.BoxGeometry(3.2, 2.2, 0.12),         color: 0x2b4c6f, per: 1,  y: 1.1 },
];

/** 确定性伪随机（同 chunk 每次生成一致，避免闪变） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 为一个 500m 分块生成街道陈设组。
 * @param {{id:string, cx:number, cz:number}} chunk
 * @returns {THREE.Group}
 */
export function populateStreetProps(chunk) {
  const group = new THREE.Group();
  group.name = `props_${chunk.id}`;
  const rand = rng(chunk.cx * 31 + chunk.cz * 17 + 7);
  const half = 250; // chunkSize/2

  for (const kind of PROP_KINDS) {
    const n = kind.per;
    const mesh = new THREE.InstancedMesh(kind.geo(), new THREE.MeshLambertMaterial({ color: kind.color }), n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      // 沿块内路缘带分布（边缘 12m 带内），避免落在路中
      const edge = rand() < 0.5;
      const x = edge ? (rand() < 0.5 ? -half + 6 + rand() * 12 : half - 18 + rand() * 12) : (rand() * 2 - 1) * half;
      const z = edge ? (rand() * 2 - 1) * half : (rand() < 0.5 ? -half + 6 + rand() * 12 : half - 18 + rand() * 12);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
      m.compose(new THREE.Vector3(chunk.cx + x, kind.y, chunk.cz + z), q, sc);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  return group;
}

/** 街道陈设总量估算（供 diff 报批单引用） */
export function propsBudget(gridSize = 4, perChunk = PROP_KINDS.reduce((a, k) => a + k.per, 0)) {
  return { chunks: gridSize * gridSize, instancesPerChunk: perChunk, total: gridSize * gridSize * perChunk };
}
