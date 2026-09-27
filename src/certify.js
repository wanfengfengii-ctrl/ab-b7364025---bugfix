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

  // 5) 连通风险区域归并
  // 半平面剖分会把一块几何上连通的同类区域（如被第三条带切去一角的 L 形
  // 漏拍区域）切成多个凸单元；逐单元报告会把同一块连续未拍地带拆成多个风险，
  // 且内部切分线会被误当作边界证据。这里把「类别相同、覆盖情形相同，且沿
  // 正长度公共边相接」的单元并为一个连通区域：仅以顶点相接（点接触）的区域
  // 不合并，彼此独立的漏拍/三重区域仍分别报告。
  const ownerLabel = (o) => (o.workarea ? `工作区·边${o.edge + 1}` : `R${o.strip}·${o.side}`);

  // 边界证据按「实际边段」而非无限直线匹配：只有与风险外边界存在正长度重合
  // 的工作区边/覆盖带边才计入，避免共线延长线（如仅端点相接）混入证据。
  const ownerSegments = [];
  waLines.forEach((L) => {
    const i = L.owners[0].edge;
    ownerSegments.push({ a: workarea[i], b: workarea[(i + 1) % workarea.length], label: ownerLabel(L.owners[0]) });
  });
  strips.forEach((s, si) => {
    s.edges.forEach((_, k) => {
      ownerSegments.push({ a: s.corners[k], b: s.corners[(k + 1) % 4], label: ownerLabel({ strip: si + 1, side: SIDE_NAMES[k] }) });
    });
  });

  const segTol = D('1e-12').mul(S).mul(S); // 共线判定容差（叉积量级）
  /** 点 m 是否落在线段 a→b 上（含端点，闭集） */
  function pointOnSegment(m, a, b) {
    const abx = b.x.minus(a.x);
    const aby = b.y.minus(a.y);
    const amx = m.x.minus(a.x);
    const amy = m.y.minus(a.y);
    const cross = abx.mul(amy).minus(aby.mul(amx));
    if (cross.abs().gt(segTol)) return false;
    const len2 = abx.mul(abx).plus(aby.mul(aby));
    if (len2.lte(EPS.mul(EPS))) return false;
    const t = abx.mul(amx).plus(aby.mul(amy)).div(len2);
    return t.gte(0) && t.lte(1);
  }
  /** 两条共线线段是否存在正长度重合（重合长度 > lineTol） */
  function segmentsOverlap(a, b, c, d) {
    const abx = b.x.minus(a.x);
    const aby = b.y.minus(a.y);
    const cross = abx.mul(d.y.minus(c.y)).minus(aby.mul(d.x.minus(c.x)));
    if (cross.abs().gt(segTol)) return false;
    // 平行之外还须共线：c 到直线 ab 的距离（叉积）须近似为 0
    const dist = abx.mul(c.y.minus(a.y)).minus(aby.mul(c.x.minus(a.x)));
    if (dist.abs().gt(segTol)) return false;
    const len2 = abx.mul(abx).plus(aby.mul(aby));
    const along = (p) => abx.mul(p.x.minus(a.x)).plus(aby.mul(p.y.minus(a.y)));
    const t1 = along(c);
    const t2 = along(d);
    // [0,len2] ∩ [min(t1,t2),max(t1,t2)] 的有向长度
    const overlap = Decimal.min(len2, Decimal.max(t1, t2)).minus(Decimal.max(0, Decimal.min(t1, t2)));
    return overlap.gt(lineTol);
  }
  function pointEvidence(p) {
    const labels = new Set();
    for (const seg of ownerSegments) {
      if (pointOnSegment(p, seg.a, seg.b)) labels.add(seg.label);
    }
    return [...labels];
  }
  const regionItems = [];
  for (const c of gapCells) regionItems.push({ cell: c, kind: 'gap', sig: '' });
  for (const c of tripleCells) regionItems.push({ cell: c, kind: 'triple', sig: c.covering.join('>') });

  // 并查集：沿公共边合并同类同覆盖情形的单元
  const parent = regionItems.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { parent[find(i)] = find(j); };

  // 顶点键 → 落在该顶点上的风险单元下标（空间索引，把候选限制为相邻单元）
  const vtxCells = new Map();
  const cellEdges = regionItems.map((it, i) => {
    const verts = it.cell.vertices;
    const edges = [];
    for (let k = 0; k < verts.length; k++) {
      const a = verts[k];
      const b = verts[(k + 1) % verts.length];
      if (a.x.minus(b.x).pow(2).plus(a.y.minus(b.y).pow(2)).lte(lineTol.mul(lineTol))) continue;
      const e = { a, b, ak: vtxKey(a), bk: vtxKey(b) };
      edges.push(e);
      if (!vtxCells.has(e.ak)) vtxCells.set(e.ak, []);
      if (!vtxCells.has(e.bk)) vtxCells.set(e.bk, []);
      vtxCells.get(e.ak).push(i);
      vtxCells.get(e.bk).push(i);
    }
    return edges;
  });

  /** 两同类风险单元是否沿正长度公共边相接（候选对来自共享顶点索引） */
  function shareEdge(i, j) {
    const ai = regionItems[i];
    const bi = regionItems[j];
    if (ai.kind !== bi.kind || ai.sig !== bi.sig) return false;
    for (const ea of cellEdges[i]) {
      const mid = { x: ea.a.x.plus(ea.b.x).div(2), y: ea.a.y.plus(ea.b.y).div(2) };
      for (const eb of cellEdges[j]) {
        // 完整共享边：端点键相同（正反向均可）
        if ((ea.ak === eb.ak && ea.bk === eb.bk) || (ea.ak === eb.bk && ea.bk === eb.ak)) return true;
        // T 形相接：一条边中点落在另一条边上（非端点的正长度重合）
        if (pointOnSegment(mid, eb.a, eb.b)) return true;
      }
    }
    return false;
  }

  // 共享顶点的同类候选对若沿正长度公共边相接则合并（仅点相接不会通过）
  const seen = new Set();
  for (const [, cellIdxs] of vtxCells) {
    for (let x = 0; x < cellIdxs.length; x++) {
      for (let y = x + 1; y < cellIdxs.length; y++) {
        const i = Math.min(cellIdxs[x], cellIdxs[y]);
        const j = Math.max(cellIdxs[x], cellIdxs[y]);
        const key = i * regionItems.length + j;
        if (seen.has(key)) continue;
        seen.add(key);
        if (shareEdge(i, j)) union(i, j);
      }
    }
  }

  const groupsMap = new Map();
  regionItems.forEach((it, i) => {
    const root = find(i);
    if (!groupsMap.has(root)) groupsMap.set(root, []);
    groupsMap.get(root).push(it);
  });

  /**
   * 提取连通区域的外边界环（CCW 点环，可能为凹多边形）：
   * 溶解所有组内两单元共享（正反向出现两次）或被 T 形分割的内部公共边，
   * 剩余有向外边逐段首尾相接成环，并返回保留下来的外部边供边界证据标注。
   */
  function regionOutline(items) {
    const cells = items.map((it) => it.cell);
    const pointMap = new Map();
    const cacheP = (p) => { const k = vtxKey(p); if (!pointMap.has(k)) pointMap.set(k, p); return k; };
    const edges = []; // {ak,bk,a,b,ci}
    cells.forEach((c, ci) => {
      let verts = c.vertices;
      if (signedArea(verts).isNegative()) verts = [...verts].reverse();
      for (let k = 0; k < verts.length; k++) {
        const a = verts[k];
        const b = verts[(k + 1) % verts.length];
        if (a.x.minus(b.x).pow(2).plus(a.y.minus(b.y).pow(2)).lte(lineTol.mul(lineTol))) continue;
        edges.push({ ak: cacheP(a), bk: cacheP(b), a, b, ci });
      }
    });
    // 无向边键 → 出现次数：两单元沿同一正反向边相接时出现两次 ⇒ 内部边
    const undir = (ak, bk) => (ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`);
    const keyCount = new Map();
    const vtxEdge = new Map(); // 顶点键 → 边下标（T 形相接的局部候选）
    edges.forEach((e, idx) => {
      const uk = undir(e.ak, e.bk);
      keyCount.set(uk, (keyCount.get(uk) ?? 0) + 1);
      for (const vk of [e.ak, e.bk]) {
        if (!vtxEdge.has(vk)) vtxEdge.set(vk, []);
        vtxEdge.get(vk).push(idx);
      }
    });
    const kept = [];
    for (const e of edges) {
      if ((keyCount.get(undir(e.ak, e.bk)) ?? 0) >= 2) continue; // 完整共享边：内部
      // T 形相接回退：边中点落在同组另一条边（端点键不同但正长度重合）上
      const mid = { x: e.a.x.plus(e.b.x).div(2), y: e.a.y.plus(e.b.y).div(2) };
      let internal = false;
      const cand = new Set();
      for (const vk of [e.ak, e.bk]) for (const idx of vtxEdge.get(vk) ?? []) cand.add(idx);
      for (const idx of cand) {
        const f = edges[idx];
        if (f.ci === e.ci) continue;
        if (pointOnSegment(mid, f.a, f.b)) { internal = true; break; }
      }
      if (!internal) kept.push(e);
    }
    // 有向外边首尾相接成环
    const outgoing = new Map();
    for (const idx of kept.keys()) {
      const e = kept[idx];
      if (!outgoing.has(e.ak)) outgoing.set(e.ak, []);
      outgoing.get(e.ak).push(idx);
    }
    const used = new Set();
    const rings = [];
    for (const start of kept.keys()) {
      if (used.has(start)) continue;
      let e = kept[start];
      const keys = [e.ak, e.bk];
      used.add(start);
      for (;;) {
        const nexts = outgoing.get(e.bk)?.filter((idx) => !used.has(idx)) ?? [];
        if (!nexts.length) break;
        const idx = nexts[0];
        used.add(idx);
        e = kept[idx];
        if (e.bk === keys[0]) break;
        keys.push(e.bk);
        if (keys.length > edges.length + 1) break; // 防御性上限
      }
      const ring = keys.map((k) => pointMap.get(k));
      if (ring.length >= 3) rings.push(ring);
    }
    // 面积最大者作为代表外边界环（孔洞环等仅参与证据与字典序）
    rings.sort((r1, r2) => signedArea(r2).abs().cmp(signedArea(r1).abs()));
    return { rings, kept };
  }

  // 归属边段按「法向方向 + 偏移量化」两级分桶：单元边必落在某条覆盖带边线/
  // 工作区边线上。方向键取 float64 量化单位法向；偏移 c 按 1e-8 分桶，查询时
  // 兼查相邻三桶以吸收不同来源端点的舍入差；最终仍由 Decimal 段重合精确判定。
  // 桶键：单位法向整数对 (qn(nx),qn(ny)) → 偏移整数 cq → 归属边段
  const dirBuckets = new Map();
  const QN = 1e8;
  const QC = 1e8;
  const lineKeys = (a, b) => {
    const dx = b.x.toNumber() - a.x.toNumber();
    const dy = b.y.toNumber() - a.y.toNumber();
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    let c = nx * a.x.toNumber() + ny * a.y.toNumber();
    if (nx < -1e-9 || (Math.abs(nx) <= 1e-9 && ny < 0)) { nx = -nx; ny = -ny; c = -c; }
    return { qx: Math.round(nx * QN), qy: Math.round(ny * QN), cq: Math.round(c * QC) };
  };
  for (const seg of ownerSegments) {
    const { qx, qy, cq } = lineKeys(seg.a, seg.b);
    const dir = `${qx},${qy}`;
    if (!dirBuckets.has(dir)) dirBuckets.set(dir, new Map());
    const cmap = dirBuckets.get(dir);
    if (!cmap.has(cq)) cmap.set(cq, []);
    cmap.get(cq).push(seg);
  }

  /** 外边界边 ↔ 实际边段归属匹配：只标注与连通区域外边存在正长度重合的边 */
  function boundaryEvidence(kept) {
    const labels = new Set();
    for (const e of kept) {
      const { qx, qy, cq } = lineKeys(e.a, e.b);
      // 兼查方向/偏移相邻桶（3×3），量化边界绝不漏候选；误候选由 Decimal 精确排除
      for (let dxk = -1; dxk <= 1; dxk++) {
        for (let dyk = -1; dyk <= 1; dyk++) {
          const cmap = dirBuckets.get(`${qx + dxk},${qy + dyk}`);
          if (!cmap) continue;
          for (const dq of [-1, 0, 1]) {
            for (const seg of cmap.get(cq + dq) ?? []) {
              if (segmentsOverlap(e.a, e.b, seg.a, seg.b)) labels.add(seg.label);
            }
          }
        }
      }
    }
    return [...labels];
  }

  const num = (d) => d.toNumber();
  const numPts = (ring) => ring.map((p) => [num(p.x), num(p.y)]);
  const lexMinOfRings = (rings) => {
    let mx = Infinity, my = Infinity;
    for (const ring of rings) for (const p of ring) {
      const x = num(p.x), y = num(p.y);
      if (x < mx - 1e-12 || (Math.abs(x - mx) <= 1e-12 && y < my)) { mx = x; my = y; }
    }
    return [mx, my];
  };

  // 6) 风险区域汇总（连通区域 → 一项风险；零面积接触点独立报告）
  const buildRegionRisk = (items) => {
    const kind = items[0].kind;
    let area = new Decimal(0);
    for (const it of items) area = area.plus(it.cell.area);
    const { rings, kept } = regionOutline(items);
    // 代表点取面积最大组成单元的质心：保证落在区域内部（加权质心在有孔洞时可能落入孔洞）
    let repCell = items[0].cell;
    for (const it of items) if (it.cell.area.gt(repCell.area)) repCell = it.cell;
    const rep = [num(repCell.centroid.x), num(repCell.centroid.y)];
    return {
      kind,
      shape: 'region',
      multiplicity: kind === 'gap' ? 0 : items[0].cell.count,
      area: num(area),
      representative: rep,
      // vertices：连通区域外边界环（凹多边形；含孔洞时仅外环，孔洞靠 parts 渲染）
      vertices: rings.length ? numPts(rings[0]) : numPts(items[0].cell.vertices),
      // parts：组成该连通区域的全部凸单元（铺满实际区域，孔洞自然不填充）
      parts: items.map((it) => numPts(it.cell.vertices)),
      boundary: boundaryEvidence(kept),
      strips: kind === 'gap' ? [] : items[0].cell.covering,
      lex: lexMinOfRings(rings.length ? rings : [items[0].cell.vertices]),
    };
  };

  const groups = [...groupsMap.values()];
  const gapRisks = groups
    .filter((items) => items[0].kind === 'gap')
    .map((items) => buildRegionRisk(items))
    .sort((a, b) => a.lex[0] - b.lex[0] || a.lex[1] - b.lex[1])
    .map((r, i) => ({ ...r, id: `G${i + 1}` }));
  const tripleRegionRisks = groups
    .filter((items) => items[0].kind === 'triple')
    .map((items) => buildRegionRisk(items))
    .sort((a, b) => a.lex[0] - b.lex[0] || a.lex[1] - b.lex[1])
    .map((r, i) => ({ ...r, id: `T${i + 1}` }));
  const pointRisks = contacts.map((ct, i) => {
    const p = [num(ct.point.x), num(ct.point.y)];
    return {
      id: `P${i + 1}`,
      kind: 'triple',
      shape: 'point',
      multiplicity: ct.covering.length,
      area: 0,
      representative: p,
      vertices: [p],
      boundary: pointEvidence(ct.point),
      strips: ct.covering,
      lex: p,
    };
  });
  const tripleRisks = [...tripleRegionRisks, ...pointRisks]
    .sort((a, b) => a.lex[0] - b.lex[0] || a.lex[1] - b.lex[1]);

  // 首个风险区域：漏拍优先于三重曝光，同类按最小顶点字典序（x 小者优先，再 y）
  const sorted = [...gapRisks, ...tripleRisks];
  const firstRisk = sorted[0] ?? null;

  const coveredArea = stats.workArea.minus(stats.gapArea);
  const report = {
    ok: sorted.length === 0,
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
    gaps: gapRisks,
    triples: tripleRisks,
    // 渲染与明细数据
    workarea: input.workarea.map(([x, y]) => [x, y]),
    strips: strips.map((s) => ({
      index: s.index,
      ...s.params,
      corners: s.corners.map((p) => [num(p.x), num(p.y)]),
      area: s.params.w * s.params.h,
    })),
    cells: cellRecs.map((c) => ({
      vertices: c.vertices.map((p) => [num(p.x), num(p.y)]),
      count: c.count,
    })),
  };
  for (const r of report.risks) delete r.lex;
  return report;
}
