/**
 * 覆盖认证业务模块（纯本地、连续平面判定，无栅格化、无固定采样）。
 *
 * 方法：将工作区凸多边形用全部覆盖带边线做半平面剖分（线排列），
 * 得到有限个单元；同一单元内覆盖数恒定，用质心做精确包含计数：
 *   - 覆盖数 = 0  → 漏拍单元（gap）
 *   - 覆盖数 ≥ 3  → 三重曝光单元（triple）
 * 再用全部排列顶点（单元顶点 + 工作区顶点 + 覆盖带角点）做闭集计数，
 * 捕获零面积的三重接触（点/线段状三重曝光）。
 * 边界接触计入覆盖：所有包含判断均为闭集语义。
 */
import Decimal from './geometry/decimal.js';
import {
  EPS, D, pt,
  lineFromPoints, lineValue, signedArea,
  splitConvex, sanitizePolygon,
  buildRect, rectContains, convexContains,
} from './geometry/core.js';

export const LIMITS = { minStrips: 3, maxStrips: 12, maxVertices: 64 };

const SIDE_NAMES = ['底边', '右边', '顶边', '左边'];

/* ---------------- 输入校验 ---------------- */

export function validateInput(input) {
  const errors = [];
  const wa = input?.workarea;
  if (!Array.isArray(wa) || wa.length < 3) {
    errors.push('工作区至少需要 3 个顶点');
  } else {
    if (wa.length > LIMITS.maxVertices) errors.push(`工作区顶点数不能超过 ${LIMITS.maxVertices}`);
    let coordsOk = true;
    wa.forEach((v, i) => {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isFinite(n))) {
        errors.push(`工作区顶点 #${i + 1} 非法（应为有限数 [x, y]）`);
        coordsOk = false;
      }
    });
    if (coordsOk) {
      let scale = 1;
      for (const [x, y] of wa) scale = Math.max(scale, Math.abs(x), Math.abs(y));
      const tol = 1e-9 * scale * scale;
      let area2 = 0;
      let allLeft = true;
      let allRight = true;
      const n = wa.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = wa[i];
        const [bx, by] = wa[(i + 1) % n];
        const [cx, cy] = wa[(i + 2) % n];
        area2 += ax * by - bx * ay;
        const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
        if (cross <= tol) allLeft = false;
        if (cross >= -tol) allRight = false;
      }
      if (area2 <= tol && area2 >= -tol) {
        errors.push('工作区面积过小或顶点共线');
      } else if (area2 < 0 && allRight) {
        errors.push('工作区顶点必须按逆时针（CCW）顺序给出');
      } else if (area2 > 0 && !allLeft) {
        errors.push('工作区必须是严格凸多边形（每个内角均小于 180°）');
      } else if (area2 < 0 && !allRight) {
        errors.push('工作区既不是凸多边形，顶点顺序也可能不是逆时针');
      }
    }
  }
  const strips = input?.strips;
  if (!Array.isArray(strips) || strips.length < LIMITS.minStrips || strips.length > LIMITS.maxStrips) {
    errors.push(`覆盖带数量须为 ${LIMITS.minStrips}–${LIMITS.maxStrips} 条（当前 ${Array.isArray(strips) ? strips.length : 0} 条）`);
  } else {
    strips.forEach((s, i) => {
      const tag = `覆盖带 R${i + 1}`;
      if (!s || typeof s !== 'object') { errors.push(`${tag}：参数缺失`); return; }
      for (const k of ['cx', 'cy', 'w', 'h', 'angle']) {
        if (!Number.isInteger(s[k])) { errors.push(`${tag}：${k} 必须为整数（当前 ${s[k]}）`); return; }
      }
      if (s.w <= 0) errors.push(`${tag}：宽 w 必须为正整数`);
      if (s.h <= 0) errors.push(`${tag}：高 h 必须为正整数`);
    });
  }
  return errors;
}

/* ---------------- 直线工具 ---------------- */

function canonical(line) {
  let { a, b, c } = line;
  if (a.lt(EPS.neg()) || (a.abs().lte(EPS) && b.isNegative())) {
    a = a.neg(); b = b.neg(); c = c.neg();
  }
  return { a, b, c };
}

function sameLine(L1, L2, eps, cTol) {
  return (
    L1.a.minus(L2.a).abs().lte(eps) &&
    L1.b.minus(L2.b).abs().lte(eps) &&
    L1.c.minus(L2.c).abs().lte(cTol)
  );
}

/* ---------------- 连通区域合并 ---------------- */

/**
 * 半平面剖分得到的凸单元会把同一块连通漏拍区切碎（例如 L 形区域被
 * 覆盖带边线切成多个凸单元）。这里仅做拓扑合并，不改变任何连续判定结果：
 *  1. 收集全部候选单元的有向边（单元均为 CCW），按规范化支撑直线分组；
 *  2. 同一直线上的端点按投影参数聚类，将边细分为对齐的子段；
 *  3. 被两个单元以相反方向各经过一次的子段是内部边（抵消），
 *     并据此用并查集合并「共享正长度边界段」的单元；
 *  4. 仅被经过一次的子段构成外边界，首尾接合成环（允许凹多边形）。
 * 仅在点（零长度）处接触的单元不会被合并，彼此独立的漏拍风险保持分立。
 */
class DSU {
  constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function numPointKey(x, y, tol) {
  return `${Math.round(x / tol)},${Math.round(y / tol)}`;
}

/** 收集单元有向边，按规范化支撑直线分组（直线方向 u 与投影参数 t 一并记录）。 */
function collectEdgeGroups(cells, tol) {
  const groups = new Map();
  cells.forEach((cell, owner) => {
    const verts = cell.vertices;
    for (let k = 0; k < verts.length; k++) {
      const p = verts[k];
      const q = verts[(k + 1) % verts.length];
      const px = p.x.toNumber(), py = p.y.toNumber();
      const qx = q.x.toNumber(), qy = q.y.toNumber();
      const dx = qx - px, dy = qy - py;
      const len = Math.hypot(dx, dy);
      if (len <= tol) continue; // 零长度边：不参与
      let nx = -dy / len, ny = dx / len; // 左法向
      if (nx < -1e-11 || (Math.abs(nx) <= 1e-11 && ny < 0)) { nx = -nx; ny = -ny; }
      const c = nx * px + ny * py;
      const gkey = `${nx.toFixed(10)}|${ny.toFixed(10)}|${Math.round(c / tol)}`;
      let g = groups.get(gkey);
      if (!g) {
        g = { ux: ny, uy: -nx, ends: [], edges: [] }; // u=(ny,-nx) 为直线方向
        groups.set(gkey, g);
      }
      const tp = g.ux * px + g.uy * py;
      const tq = g.ux * qx + g.uy * qy;
      g.edges.push({ p, q, owner, tp, tq });
      g.ends.push({ t: tp, p }, { t: tq, p: q });
    }
  });
  return groups;
}

/** 将外边界有向子段接合成环（不含与首点重复的闭合点）；返回所有环。 */
function stitchLoops(segments, tol) {
  const keyOf = (p) => numPointKey(p.x.toNumber(), p.y.toNumber(), tol);
  const byStart = new Map();
  for (const s of segments) {
    const sk = keyOf(s.start);
    if (byStart.has(sk)) return []; // 起点分叉：非简单边界，放弃拓扑合并
    byStart.set(sk, s);
  }
  const remaining = new Set(segments);
  const loops = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    const startKey = keyOf(first.start);
    const ring = [first.start];
    let cur = first;
    let ok = true;
    for (let guard = 0; guard <= segments.length; guard++) {
      ring.push(cur.end);
      remaining.delete(cur);
      if (keyOf(cur.end) === startKey) break;
      cur = byStart.get(keyOf(cur.end));
      if (!cur) { ok = false; break; }
    }
    // 去掉与首点重复的闭合点；至少 3 个顶点方成环
    if (ok && ring.length > 3 && keyOf(ring[ring.length - 1]) === startKey) loops.push(ring.slice(0, -1));
    else break;
  }
  return loops;
}

/**
 * 把连通（正长度共边）的同类单元合并为区域记录：
 * @returns {{vertices: object[], holes: object[][], members: number[],
 *            area: Decimal, centroid: object}[]|null}
 *   vertices 为外边界环，holes 为内孔环（覆盖岛）；拓扑重建失败时返回 null，
 *   调用方应回退到逐单元报告，绝不静默产出错误轮廓。
 */
function mergeConnectedRegions(cells, tol) {
  if (cells.length <= 1) {
    return cells.map((c, i) => ({
      vertices: c.vertices, holes: [], members: [i],
      area: c.area, centroid: c.centroid,
    }));
  }
  const groups = collectEdgeGroups(cells, tol);
  const dsu = new DSU(cells.length);
  const outer = []; // {start, end, owner} 外边界有向子段
  for (const g of groups.values()) {
    // 端点按投影参数聚类
    g.ends.sort((a, b) => a.t - b.t);
    const clusters = [];
    for (const z of g.ends) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(z.t - last.t) <= tol) continue;
      clusters.push({ t: z.t, rep: z.p });
    }
    const clusterAt = (t) => {
      let lo = 0, hi = clusters.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (clusters[mid].t < t) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(clusters[lo - 1].t - t) < Math.abs(clusters[lo].t - t)) lo--;
      return lo;
    };
    // 子段 k→k+1：正/反方向各被哪些单元覆盖
    const cover = new Map();
    for (const e of g.edges) {
      const i0 = clusterAt(Math.min(e.tp, e.tq));
      const i1 = clusterAt(Math.max(e.tp, e.tq));
      const forward = e.tq >= e.tp;
      for (let k = i0; k < i1; k++) {
        let cov = cover.get(k);
        if (!cov) { cov = { plus: new Set(), minus: new Set() }; cover.set(k, cov); }
        (forward ? cov.plus : cov.minus).add(e.owner);
      }
    }
    for (const [k, cov] of cover) {
      const a = clusters[k];
      const b = clusters[k + 1];
      if (Math.abs(b.t - a.t) <= tol) continue;
      if (cov.plus.size && cov.minus.size) {
        // 内部共边：两侧单元连通
        for (const x of cov.plus) for (const y of cov.minus) dsu.union(x, y);
      } else if (cov.plus.size + cov.minus.size === 1) {
        const forward = cov.plus.size > 0;
        const owner = (forward ? cov.plus : cov.minus).values().next().value;
        outer.push({ start: forward ? a.rep : b.rep, end: forward ? b.rep : a.rep, owner });
      }
    }
  }

  // 按连通成分归集外边界并接合为环
  const byRoot = new Map();
  for (const seg of outer) {
    const root = dsu.find(seg.owner);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(seg);
  }
  const areaTol = new Decimal(tol).pow(2).mul(1e6);
  const regions = [];
  for (const [root, segments] of byRoot) {
    const loops = stitchLoops(segments, tol);
    if (!loops.length) return null; // 非流形接合：放弃合并
    // 面积最大的环为外边界，其余为内孔；外边界 CCW、内孔 CW
    let outerIdx = 0;
    for (let i = 1; i < loops.length; i++) {
      if (signedArea(loops[i]).abs().gt(signedArea(loops[outerIdx]).abs())) outerIdx = i;
    }
    const vertices = loops[outerIdx];
    const holes = loops.filter((_, i) => i !== outerIdx);
    const members = [];
    for (let i = 0; i < cells.length; i++) if (dsu.find(i) === root) members.push(i);
    // 面积取单元面积和（单元内部两两不重叠，不受接合误差影响）
    let area = new Decimal(0);
    for (const i of members) area = area.plus(cells[i].area);
    // 不变量校验：外环面积 − 内孔面积之和 必须等于单元面积和
    let loopArea = signedArea(vertices).abs();
    for (const h of holes) loopArea = loopArea.minus(signedArea(h).abs());
    if (loopArea.minus(area).abs().gt(areaTol)) return null;
    // 代表点取面积最大成员单元的质心，保证落在区域内部（不会落入内孔）
    let biggest = members[0];
    for (const i of members) if (cells[i].area.gt(cells[biggest].area)) biggest = i;
    regions.push({ vertices, holes, members, area, centroid: cells[biggest].centroid });
  }
  return regions;
}

/* ---------------- 主认证流程 ---------------- */

export function certify(input) {
  const errors = validateInput(input);
  if (errors.length) return { ok: false, errors };

  const workarea = input.workarea.map(([x, y]) => pt(x, y));
  const strips = input.strips.map((s, i) => ({ ...buildRect(s), params: s, index: i + 1 }));

  // 坐标量级 → 各级容差
  let scale = 1;
  for (const p of workarea) {
    scale = Math.max(scale, Math.abs(p.x.toNumber()), Math.abs(p.y.toNumber()));
  }
  for (const s of input.strips) {
    scale = Math.max(scale, Math.abs(s.cx) + s.w, Math.abs(s.cy) + s.h);
  }
  const S = D(scale);
  const eps = EPS;                            // 剖分/分类容差（1e-24）
  const sliverEps = D('1e-18').mul(S).mul(S); // 退化碎屑面积阈值
  const lineTol = D('1e-15').mul(S);          // 边界证据匹配容差
  const vtxTol = D('1e-9').mul(S);            // 顶点闭集判定容差

  // 1) 覆盖带边线（规范定向 + 共线合并，记录归属作为证据）
  const stripLines = [];
  strips.forEach((s, si) => {
    s.edges.forEach((e, k) => {
      const canon = canonical(e);
      const found = stripLines.find((L) => sameLine(L, canon, eps, lineTol));
      if (found) found.owners.push({ strip: si + 1, side: SIDE_NAMES[k] });
      else stripLines.push({ ...canon, owners: [{ strip: si + 1, side: SIDE_NAMES[k] }] });
    });
  });
  // 工作区边线（仅用于边界证据标注）
  const waLines = workarea.map((p, i) => ({
    ...canonical(lineFromPoints(p, workarea[(i + 1) % workarea.length])),
    owners: [{ workarea: true, edge: i }],
  }));

  // 2) 线排列剖分：工作区多边形被每条覆盖带边线切割
  let cells = [workarea];
  for (const line of stripLines) {
    const next = [];
    for (const cell of cells) {
      // 快速通道：整体位于某一侧
      let minV = null;
      let maxV = null;
      for (const p of cell) {
        const v = lineValue(line, p);
        if (minV === null || v.lt(minV)) minV = v;
        if (maxV === null || v.gt(maxV)) maxV = v;
      }
      if (minV.gt(eps) || maxV.lt(eps.neg())) { next.push(cell); continue; }
      const { pos, neg } = splitConvex(cell, line, eps);
      const pPos = sanitizePolygon(pos, eps, sliverEps);
      const pNeg = sanitizePolygon(neg, eps, sliverEps);
      if (pPos) next.push(pPos);
      if (pNeg) next.push(pNeg);
      if (!pPos && !pNeg) next.push(cell); // 单元整体贴线：保留原单元
    }
    cells = next;
  }

  // 3) 单元分类：质心包含计数（单元内覆盖数恒定）
  const cellRecs = cells.map((verts) => {
    let cx = new Decimal(0);
    let cy = new Decimal(0);
    for (const p of verts) { cx = cx.plus(p.x); cy = cy.plus(p.y); }
    const centroid = { x: cx.div(verts.length), y: cy.div(verts.length) };
    const covering = [];
    strips.forEach((s, i) => {
      if (rectContains(s.edges, centroid, eps)) covering.push(i + 1);
    });
    return {
      vertices: verts,
      centroid,
      count: covering.length,
      covering,
      area: signedArea(verts).abs(),
    };
  });

  const stats = {
    stripCount: strips.length,
    vertexCount: workarea.length,
    cellCount: cellRecs.length,
    workArea: signedArea(workarea).abs(),
    gapArea: new Decimal(0),
    tripleArea: new Decimal(0),
    singleArea: new Decimal(0),
    doubleArea: new Decimal(0),
    maxMultiplicity: 0,
  };
  const gapCells = [];
  const tripleCells = [];
  for (const c of cellRecs) {
    if (c.count > stats.maxMultiplicity) stats.maxMultiplicity = c.count;
    if (c.count === 0) { gapCells.push(c); stats.gapArea = stats.gapArea.plus(c.area); }
    else if (c.count === 1) stats.singleArea = stats.singleArea.plus(c.area);
    else if (c.count === 2) stats.doubleArea = stats.doubleArea.plus(c.area);
    else { tripleCells.push(c); stats.tripleArea = stats.tripleArea.plus(c.area); }
  }

  // 4) 顶点闭集检查：捕获零面积三重接触（点/线段状）
  const vtxKey = (p) => `${Math.round(p.x.toNumber() * 1e9)},${Math.round(p.y.toNumber() * 1e9)}`;
  const vertMap = new Map();
  const addVert = (p) => { const k = vtxKey(p); if (!vertMap.has(k)) vertMap.set(k, p); };
  for (const c of cellRecs) for (const p of c.vertices) addVert(p);
  for (const p of workarea) addVert(p);
  for (const s of strips) for (const p of s.corners) addVert(p);

  const contacts = [];
  let vertexMax = 0;
  for (const v of vertMap.values()) {
    if (!convexContains(workarea, v, vtxTol)) continue;
    const covering = [];
    strips.forEach((s, i) => {
      if (rectContains(s.edges, v, vtxTol)) covering.push(i + 1);
    });
    if (covering.length > vertexMax) vertexMax = covering.length;
    if (covering.length >= 3) {
      const inTripleCell = tripleCells.some((c) => convexContains(c.vertices, v, vtxTol));
      if (!inTripleCell) contacts.push({ point: v, covering });
    }
  }
  if (vertexMax > stats.maxMultiplicity) stats.maxMultiplicity = vertexMax;

  // 5) 边界证据：单元边 ↔ 边线归属匹配（rings 可含外环与内孔环）
  const allLines = [...stripLines, ...waLines];
  const ownerLabel = (o) => (o.workarea ? `工作区·边${o.edge + 1}` : `R${o.strip}·${o.side}`);
  function boundaryOf(rings) {
    const labels = new Set();
    for (const verts of rings) {
      for (let i = 0; i < verts.length; i++) {
        const p = verts[i];
        const q = verts[(i + 1) % verts.length];
        const len2 = p.x.minus(q.x).pow(2).plus(p.y.minus(q.y).pow(2));
        if (len2.lte(lineTol.mul(lineTol))) continue;
        for (const L of allLines) {
          if (lineValue(L, p).abs().lte(lineTol) && lineValue(L, q).abs().lte(lineTol)) {
            for (const o of L.owners) labels.add(ownerLabel(o));
          }
        }
      }
    }
    return [...labels];
  }
  function pointEvidence(p) {
    const labels = new Set();
    for (const L of allLines) {
      if (lineValue(L, p).abs().lte(lineTol)) for (const o of L.owners) labels.add(ownerLabel(o));
    }
    return [...labels];
  }

  // 6) 风险区域汇总
  const num = (d) => d.toNumber();
  const vertsOf = (c) => c.vertices.map((p) => [num(p.x), num(p.y)]);
  const ringOf = (ring) => ring.map((p) => [num(p.x), num(p.y)]);
  // 漏拍单元先做连通合并：同一连通漏拍区（如 L 形）作为一项完整风险呈现。
  // 拓扑重建失败时安全回退到逐单元报告（不改变任何判定结论，仅不做聚合）。
  let gapRegions = mergeConnectedRegions(gapCells, vtxTol.toNumber());
  if (gapRegions === null) {
    gapRegions = gapCells.map((c, i) => ({
      vertices: c.vertices, holes: [], members: [i], area: c.area, centroid: c.centroid,
    }));
  }
  const risks = [];
  gapRegions.forEach((g, i) => {
    risks.push({
      id: `G${i + 1}`,
      kind: 'gap',
      shape: 'region',
      multiplicity: 0,
      area: num(g.area),
      representative: [num(g.centroid.x), num(g.centroid.y)],
      vertices: vertsOf(g),
      holes: g.holes.map(ringOf),
      boundary: boundaryOf([g.vertices, ...g.holes]),
      strips: [],
    });
  });
  tripleCells.forEach((c, i) => {
    risks.push({
      id: `T${i + 1}`,
      kind: 'triple',
      shape: 'region',
      multiplicity: c.count,
      area: num(c.area),
      representative: [num(c.centroid.x), num(c.centroid.y)],
      vertices: vertsOf(c),
      holes: [],
      boundary: boundaryOf([c.vertices]),
      strips: c.covering,
    });
  });
  contacts.forEach((ct, i) => {
    const p = [num(ct.point.x), num(ct.point.y)];
    risks.push({
      id: `P${i + 1}`,
      kind: 'triple',
      shape: 'point',
      multiplicity: ct.covering.length,
      area: 0,
      representative: p,
      vertices: [p],
      holes: [],
      boundary: pointEvidence(ct.point),
      strips: ct.covering,
    });
  });

  // 首个风险区域：漏拍优先于三重曝光，再按最小顶点字典序（x 小者优先，再 y）
  const lexMin = (verts) => {
    let mx = Infinity;
    let my = Infinity;
    for (const [x, y] of verts) {
      if (x < mx - 1e-12 || (Math.abs(x - mx) <= 1e-12 && y < my)) { mx = x; my = y; }
    }
    return [mx, my];
  };
  const kindOrder = { gap: 0, triple: 1 };
  const sorted = [...risks].sort((a, b) => {
    if (kindOrder[a.kind] !== kindOrder[b.kind]) return kindOrder[a.kind] - kindOrder[b.kind];
    const ka = lexMin(a.vertices);
    const kb = lexMin(b.vertices);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  const firstRisk = sorted[0] ?? null;

  const coveredArea = stats.workArea.minus(stats.gapArea);
  const report = {
    ok: risks.length === 0,
    errors: [],
    stats: {
      stripCount: stats.stripCount,
      vertexCount: stats.vertexCount,
      cellCount: stats.cellCount,
      workArea: num(stats.workArea),
      coveredArea: num(coveredArea),
      coverageRatio: num(coveredArea.div(stats.workArea)),
      gapArea: num(stats.gapArea),
      tripleArea: stats.tripleArea.toNumber(),
      singleArea: stats.singleArea.toNumber(),
      doubleArea: stats.doubleArea.toNumber(),
      maxMultiplicity: stats.maxMultiplicity,
    },
    firstRisk,
    risks: sorted,
    gaps: sorted.filter((r) => r.kind === 'gap'),
    triples: sorted.filter((r) => r.kind === 'triple'),
    // 渲染与明细数据
    workarea: input.workarea.map(([x, y]) => [x, y]),
    strips: strips.map((s) => ({
      index: s.index,
      ...s.params,
      corners: s.corners.map((p) => [num(p.x), num(p.y)]),
      area: s.params.w * s.params.h,
    })),
    cells: cellRecs.map((c) => ({ vertices: vertsOf(c), count: c.count })),
  };
  return report;
}
