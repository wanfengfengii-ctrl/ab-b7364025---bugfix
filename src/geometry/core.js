/**
 * 连续平面几何内核（高精度十进制）：
 *  - 直线（单位法向 + 偏移，规范定向，可合并共线边）
 *  - 凸多边形被直线切割（线排列剖分的基本操作）
 *  - 旋转矩形（整数中心/宽高/角度 → 四角 + 四条内法向边线）
 *
 * 判定约定：边界接触计入覆盖（所有包含性判断均为闭集语义，容差 eps）。
 */
import Decimal, { sinCosDegrees } from './decimal.js';

/** 分类容差：坐标量级 ~1e3 时仍远低于任何可表达的几何特征 */
export const EPS = new Decimal('1e-24');

export const D = (v) => (v instanceof Decimal ? v : new Decimal(String(v)));

export const pt = (x, y) => ({ x: D(x), y: D(y) });

export function cmpDec(v, eps = EPS) {
  if (v.gt(eps)) return 1;
  if (v.lt(eps.neg())) return -1;
  return 0;
}

/* ---------------- 直线 ----------------
 * 直线：a*x + b*y = c，(a,b) 为单位法向。
 * 规范定向：a > 0，或 a≈0 时 b > 0（便于共线合并）。
 */
export function lineFromPoints(p1, p2) {
  const dx = p2.x.minus(p1.x);
  const dy = p2.y.minus(p1.y);
  const len = dx.mul(dx).plus(dy.mul(dy)).sqrt();
  if (len.isZero()) throw new Error('退化线段：无法构造直线');
  // 左法向（沿 p1→p2 方向的左手侧为正侧）
  let a = dy.neg().div(len);
  let b = dx.div(len);
  let c = a.mul(p1.x).plus(b.mul(p1.y));
  if (a.lt(EPS.neg()) || (a.abs().lte(EPS) && b.isNegative())) {
    a = a.neg(); b = b.neg(); c = c.neg();
  }
  return { a, b, c };
}

export function lineValue(line, p) {
  return line.a.mul(p.x).plus(line.b.mul(p.y)).minus(line.c);
}

/** 点到直线距离（带符号） */
export const lineDist = lineValue;

/* ---------------- 多边形 ---------------- */

/** 有向面积（CCW 为正） */
export function signedArea(poly) {
  let s = new Decimal(0);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s = s.plus(p.x.mul(q.y)).minus(q.x.mul(p.y));
  }
  return s.div(2);
}

/**
 * 凸多边形被直线切割，返回 { pos, neg } 两侧多边形（可能为空数组）。
 * pos 侧：lineValue > 0。边上点（|v|≤eps）同时进入两侧，保证闭集语义。
 */
export function splitConvex(poly, line, eps = EPS) {
  const n = poly.length;
  const vals = poly.map((p) => lineValue(line, p));
  const pos = [];
  const neg = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = cmpDec(vals[i], eps);
    const sj = cmpDec(vals[j], eps);
    if (si >= 0) pos.push(poly[i]);
    if (si <= 0) neg.push(poly[i]);
    if ((si > 0 && sj < 0) || (si < 0 && sj > 0)) {
      const t = vals[i].div(vals[i].minus(vals[j]));
      pos.push({
        x: poly[i].x.plus(poly[j].x.minus(poly[i].x).mul(t)),
        y: poly[i].y.plus(poly[j].y.minus(poly[i].y).mul(t)),
      });
      neg.push(pos[pos.length - 1]);
    }
  }
  return { pos, neg };
}

/** 去除相邻（含首尾）距离 ≤ eps 的重复点 */
export function dedupeVertices(poly, eps = EPS) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || p.x.minus(last.x).abs().gt(eps) || p.y.minus(last.y).abs().gt(eps)) {
      out.push(p);
    }
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (f.x.minus(l.x).abs().lte(eps) && f.y.minus(l.y).abs().lte(eps)) out.pop();
  }
  return out;
}

/**
 * 清理切割产物：去重点后，若顶点数 < 3 或 |面积| ≤ sliverEps 则视为退化（返回 null）。
 */
export function sanitizePolygon(poly, eps = EPS, sliverEps = new Decimal('1e-20')) {
  const clean = dedupeVertices(poly, eps);
  if (clean.length < 3) return null;
  if (signedArea(clean).abs().lte(sliverEps)) return null;
  return clean;
}

/* ---------------- 旋转矩形 ---------------- */

/**
 * 由整数参数构造旋转矩形。
 * @param {{cx:number, cy:number, w:number, h:number, angle:number}} p
 *   cx,cy 中心；w 沿角度方向的边长；h 垂直方向边长；angle 角度制（逆时针）。
 * @returns {{corners: Array, edges: Array}}
 *   corners：CCW 四角；edges：四条边线（法向朝内为正，即内部点 lineValue ≥ 0）。
 */
export function buildRect({ cx, cy, w, h, angle }) {
  const { sin, cos } = sinCosDegrees(angle);
  const C = pt(cx, cy);
  const hw = D(w).div(2);
  const hh = D(h).div(2);
  // 局部轴：u 沿宽（角度方向），v 沿高
  const u = { x: cos, y: sin };
  const v = { x: sin.neg(), y: cos };
  const corner = (su, sv) => ({
    x: C.x.plus(u.x.mul(su ? hw : hw.neg())).plus(v.x.mul(sv ? hh : hh.neg())),
    y: C.y.plus(u.y.mul(su ? hw : hw.neg())).plus(v.y.mul(sv ? hh : hh.neg())),
  });
  // CCW：(-u,-v) → (+u,-v) → (+u,+v) → (-u,+v)
  const corners = [corner(false, false), corner(true, false), corner(true, true), corner(false, true)];
  // 边线：沿 CCW 方向的左法向即朝内法向
  const edges = [];
  for (let k = 0; k < 4; k++) {
    const p1 = corners[k];
    const p2 = corners[(k + 1) % 4];
    const dx = p2.x.minus(p1.x);
    const dy = p2.y.minus(p1.y);
    const len = dx.mul(dx).plus(dy.mul(dy)).sqrt();
    const a = dy.neg().div(len);
    const b = dx.div(len);
    const c = a.mul(p1.x).plus(b.mul(p1.y));
    edges.push({ a, b, c });
  }
  return { corners, edges };
}

/** 点是否在旋转矩形内（闭集：边界计入），edges 为内法向边线 */
export function rectContains(edges, p, eps = EPS) {
  for (const e of edges) {
    if (lineValue(e, p).lt(eps.neg())) return false;
  }
  return true;
}

/** 点是否在凸多边形内（闭集），poly 为 CCW 顶点 */
export function convexContains(poly, p, eps = EPS) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    // 边 a→b 的左侧（内侧）：cross(b-a, p-a) ≥ -eps
    const cross = b.x.minus(a.x).mul(p.y.minus(a.y)).minus(b.y.minus(a.y).mul(p.x.minus(a.x)));
    if (cross.lt(eps.neg())) return false;
  }
  return true;
}
