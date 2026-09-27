/**
 * 高精度十进制基础：64 位有效数字 + 由泰勒级数实现的 sin/cos。
 * 所有几何判定都在该精度下进行，避免浮点误差导致的误判；
 * 输入为整数参数，判定过程为连续平面几何（非栅格、非采样）。
 */
import Decimal from 'decimal.js';

Decimal.set({ precision: 64, rounding: Decimal.ROUND_HALF_EVEN });

export default Decimal;

/** π，80 位十进制（超出 64 位精度所需，留有余量） */
export const PI = new Decimal(
  '3.14159265358979323846264338327950288419716939937510582097494459230781640628620899'
);
export const TWO_PI = PI.mul(2);
export const HALF_PI = PI.div(2);

const TAYLOR_STOP = new Decimal('1e-70');

/** sin(x)，要求 |x| ≤ π/2（调用方负责象限归约） */
function sinReduced(x) {
  if (x.isZero()) return new Decimal(0);
  const x2 = x.mul(x);
  let term = x; // x^(2k+1) / (2k+1)!
  let sum = term;
  for (let k = 1; k < 60; k++) {
    term = term.mul(x2).div(new Decimal(2 * k).mul(2 * k + 1)).neg();
    sum = sum.plus(term);
    if (term.abs().lt(TAYLOR_STOP)) break;
  }
  return sum;
}

/** cos(x)，要求 |x| ≤ π/2 */
function cosReduced(x) {
  const x2 = x.mul(x);
  let term = new Decimal(1);
  let sum = term;
  for (let k = 1; k < 60; k++) {
    term = term.mul(x2).div(new Decimal(2 * k - 1).mul(2 * k)).neg();
    sum = sum.plus(term);
    if (term.abs().lt(TAYLOR_STOP)) break;
  }
  return sum;
}

/**
 * 角度（度）归一化到 [0, 360)。
 * 整数角度在 JS 层精确归约；非整数走 Decimal 取模。
 */
export function normalizeDegrees(deg) {
  const d = deg instanceof Decimal ? deg : new Decimal(String(deg));
  let r = d.mod(360);
  if (r.isNegative()) r = r.plus(360);
  return r;
}

/**
 * 同时返回 { sin, cos }（角度制，高精度）。
 * 先归一化到 [0,360)，再按 90° 象限折叠到 [0, π/2] 后用泰勒级数。
 */
export function sinCosDegrees(degInput) {
  const deg = normalizeDegrees(degInput);
  // 象限 q ∈ {0,1,2,3}，r ∈ [0,90]
  const q = Math.floor(deg.div(90).toNumber());
  const rDeg = deg.minus(new Decimal(q).mul(90));
  const r = rDeg.mul(PI).div(180);
  const s = sinReduced(r);
  const c = cosReduced(r);
  switch (q % 4) {
    case 0: return { sin: s, cos: c };
    case 1: return { sin: c, cos: s.neg() };
    case 2: return { sin: s.neg(), cos: c.neg() };
    default: return { sin: c.neg(), cos: s };
  }
}
