/**
 * 几何内核与覆盖认证业务模块测试（node --test）。
 * 重点：连续平面判定的精确性——面积守恒、边界接触计入、
 * 零面积三重接触、旋转形成的窄缝、输入校验、性能上限。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from '../src/geometry/decimal.js';
import { certify } from '../src/certify.js';
import {
  buildRect, rectContains, splitConvex, lineFromPoints, lineValue,
  pt, signedArea, convexContains,
} from '../src/geometry/core.js';

const square = (n = 30) => [[0, 0], [n, 0], [n, n], [0, n]];

describe('旋转矩形构造', () => {
  test('轴对齐矩形四角与边线', () => {
    const r = buildRect({ cx: 10, cy: 15, w: 20, h: 30, angle: 0 });
    const cs = r.corners.map((p) => [p.x.toNumber(), p.y.toNumber()]);
    assert.deepEqual(cs, [[0, 0], [20, 0], [20, 30], [0, 30]]);
    // 内部点被全部四条内法向边包含
    assert.equal(rectContains(r.edges, pt(10, 15)), true);
    // 边界点计入
    assert.equal(rectContains(r.edges, pt(0, 15)), true);
    assert.equal(rectContains(r.edges, pt(20, 30)), true);
    // 外部点
    assert.equal(rectContains(r.edges, pt(-0.001, 15)), false);
  });

  test('90° 旋转交换宽高方向', () => {
    const r = buildRect({ cx: 0, cy: 0, w: 10, h: 4, angle: 90 });
    assert.equal(rectContains(r.edges, pt(0, 4)), true);  // 沿 y 半宽 5？(0,4) 应在内
    assert.equal(rectContains(r.edges, pt(0, 5)), true);
    assert.equal(rectContains(r.edges, pt(0, 5.001)), false);
    assert.equal(rectContains(r.edges, pt(2, 0)), true);
    assert.equal(rectContains(r.edges, pt(2.001, 0)), false);
  });

  test('矩形面积恒为 w*h（任意角度）', () => {
    for (const ang of [1, 7, 30, 45, 123, 270]) {
      const r = buildRect({ cx: 3, cy: -4, w: 12, h: 7, angle: ang });
      const a = signedArea(r.corners).toNumber();
      assert.ok(Math.abs(a - 84) < 1e-18, `angle ${ang}: area ${a}`);
    }
  });
});

describe('半平面切割', () => {
  test('中线切割得到两个面积相等的凸多边形，闭集共享边界', () => {
    const poly = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
    const line = lineFromPoints(pt(5, 0), pt(5, 10));
    const { pos, neg } = splitConvex(poly, line);
    assert.equal(pos.length, 4);
    assert.equal(neg.length, 4);
    assert.equal(signedArea(pos).toNumber(), 50);
    assert.equal(signedArea(neg).toNumber(), 50);
    // 线上点同时出现在两侧（闭集）
    for (const p of [...pos, ...neg]) {
      if (Math.abs(p.x.toNumber() - 5) < 1e-20) assert.equal(lineValue(line, p).toNumber() < 1e-20, true);
    }
  });
});

describe('输入校验', () => {
  const goodStrips = [
    { cx: 10, cy: 15, w: 20, h: 30, angle: 0 },
    { cx: 20, cy: 15, w: 20, h: 30, angle: 0 },
    { cx: 15, cy: 45, w: 10, h: 10, angle: 0 },
  ];
  test('接受合法输入', () => {
    assert.equal(certify({ workarea: square(), strips: goodStrips }).ok, true);
  });
  test('拒绝顺时针多边形', () => {
    const r = certify({ workarea: [[0, 0], [0, 30], [30, 30], [30, 0]], strips: goodStrips });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('逆时针')));
  });
  test('拒绝凹多边形', () => {
    const r = certify({
      workarea: [[0, 0], [30, 0], [30, 30], [15, 10], [0, 30]],
      strips: goodStrips,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('凸')));
  });
  test('拒绝非整数矩形参数', () => {
    const bad = [{ ...goodStrips[0], angle: 30.5 }, goodStrips[1], goodStrips[2]];
    const r = certify({ workarea: square(), strips: bad });
    assert.ok(r.errors.some((e) => e.includes('angle 必须为整数')));
  });
  test('拒绝 2 条或 13 条覆盖带', () => {
    assert.ok(certify({ workarea: square(), strips: goodStrips.slice(0, 2) }).errors.length > 0);
    const many = Array.from({ length: 13 }, (_, i) => ({ cx: i, cy: 0, w: 4, h: 100, angle: 0 }));
    assert.ok(certify({ workarea: square(100), strips: many }).errors.length > 0);
  });
  test('拒绝非正宽高', () => {
    const bad = [{ ...goodStrips[0], w: 0 }, goodStrips[1], goodStrips[2]];
    assert.ok(certify({ workarea: square(), strips: bad }).errors.some((e) => e.includes('w')));
  });
});

describe('合格认证', () => {
  test('轴对齐两条主带 + 区外冗余带：完全覆盖且至多两层', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 10, cy: 15, w: 20, h: 30, angle: 0 },
      { cx: 20, cy: 15, w: 20, h: 30, angle: 0 },
      { cx: 15, cy: 45, w: 10, h: 10, angle: 0 },
    ]});
    assert.equal(r.ok, true);
    assert.equal(r.stats.maxMultiplicity, 2);
    assert.equal(r.stats.gapArea, 0);
    assert.equal(r.stats.tripleArea, 0);
    assert.equal(round(r.stats.coverageRatio), 1);
  });

  test('旋转 30° 条带完整覆盖（连续判定，非采样）', () => {
    const r = certify({
      workarea: [[0, 0], [36, 0], [36, 24], [0, 24]],
      strips: [
        { cx: 9, cy: 12, w: 30, h: 34, angle: 30 },
        { cx: 27, cy: 12, w: 30, h: 34, angle: 30 },
        { cx: 18, cy: 40, w: 10, h: 6, angle: 0 },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.stats.gapArea, 0);
    assert.ok(r.stats.maxMultiplicity <= 2);
  });

  test('12 条带分区覆盖通过，且单元面积之和守恒', () => {
    const strips = Array.from({ length: 12 }, (_, i) => ({
      cx: 5 + i * 10, cy: 60, w: 12, h: 140, angle: 0,
    }));
    const t0 = Date.now();
    const r = certify({ workarea: square(120), strips });
    assert.ok(Date.now() - t0 < 5000, '12 条带判定应在 5s 内完成');
    assert.equal(r.ok, true);
    const sum = r.stats.gapArea + r.stats.singleArea + r.stats.doubleArea + r.stats.tripleArea;
    assert.ok(Math.abs(sum - r.stats.workArea) < 1e-6, `面积守恒 ${sum} vs ${r.stats.workArea}`);
  });
});

describe('漏拍风险', () => {
  test('竖直漏拍带（含 L 形细分）面积精确', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 6, cy: 15, w: 16, h: 34, angle: 0 },
      { cx: 26, cy: 15, w: 12, h: 34, angle: 0 },
      { cx: 15, cy: 28, w: 6, h: 4, angle: 0 },
    ]});
    assert.equal(r.ok, false);
    assert.ok(Math.abs(r.stats.gapArea - 164) < 1e-6); // 6*30 - 4*4
    assert.equal(r.firstRisk.kind, 'gap');
    assert.ok(Math.abs(r.firstRisk.area - 104) < 1e-6); // 首个（最大）漏拍单元
    assert.ok(r.firstRisk.boundary.includes('R1·右边'));
    assert.ok(r.firstRisk.vertices.length >= 3);
  });

  test('完全无覆盖：整个工作区即漏拍区', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 100, cy: 100, w: 2, h: 2, angle: 0 },
      { cx: -100, cy: 0, w: 2, h: 2, angle: 0 },
      { cx: 0, cy: -100, w: 2, h: 2, angle: 0 },
    ]});
    assert.equal(r.ok, false);
    assert.ok(Math.abs(r.stats.gapArea - 900) < 1e-6);
    assert.equal(r.firstRisk.kind, 'gap');
  });

  test('旋转 1° 整数参数造成的 ~0.02 窄缝必须被连续判定发现', () => {
    // u-v 坐标系下工作区为矩形 u∈[45,65], v∈[-5,5]；两条角度 1° 整数中心矩形
    // u 覆盖 [-50,50] 与 [50.0022,150.0022]，留下宽约 0.0022、面积约 0.022 的窄缝
    const c = Math.cos(Math.PI / 180);
    const s = Math.sin(Math.PI / 180);
    const uv2xy = (u, v) => [u * c - v * s, u * s + v * c];
    const workarea = [
      uv2xy(45, -5), uv2xy(65, -5), uv2xy(65, 5), uv2xy(45, 5),
    ];
    const r = certify({
      workarea,
      strips: [
        { cx: 0, cy: 0, w: 100, h: 20, angle: 1 },
        { cx: 100, cy: 1, w: 100, h: 20, angle: 1 },
        { cx: 55, cy: 100, w: 2, h: 2, angle: 0 },
      ],
    });
    assert.equal(r.ok, false);
    assert.equal(r.firstRisk.kind, 'gap');
    assert.ok(r.stats.gapArea > 0.005 && r.stats.gapArea < 0.05, `窄缝面积 ${r.stats.gapArea}`);
  });
});

describe('三重曝光风险', () => {
  test('三带重叠区域面积精确为 300（10×30）', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 10, cy: 15, w: 24, h: 34, angle: 0 },
      { cx: 20, cy: 15, w: 24, h: 34, angle: 0 },
      { cx: 15, cy: 15, w: 10, h: 40, angle: 0 },
    ]});
    assert.equal(r.ok, false);
    assert.ok(Math.abs(r.stats.tripleArea - 300) < 1e-6);
    assert.equal(r.firstRisk.kind, 'triple');
    assert.deepEqual([...r.firstRisk.strips].sort(), [1, 2, 3]);
    assert.ok(r.firstRisk.boundary.includes('R3·左边'));
  });

  test('零面积三重接触点（面积 0 也必须报告，边界接触计入）', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 8, cy: 15, w: 16, h: 30, angle: 0 },
      { cx: 24, cy: 15, w: 16, h: 30, angle: 0 },
      { cx: 16, cy: 22, w: 8, h: 14, angle: 0 },
    ]});
    assert.equal(r.ok, false);
    assert.equal(r.stats.tripleArea, 0);
    assert.equal(r.firstRisk.kind, 'triple');
    assert.equal(r.firstRisk.shape, 'point');
    assert.equal(r.firstRisk.area, 0);
    assert.deepEqual(r.firstRisk.representative, [16, 15]);
    assert.ok(r.firstRisk.boundary.includes('R1·右边'));
    assert.ok(r.firstRisk.boundary.includes('R2·左边'));
    assert.ok(r.firstRisk.boundary.includes('R3·底边'));
  });

  test('漏拍优先于三重曝光作为首个风险', () => {
    const r = certify({ workarea: square(), strips: [
      { cx: 25, cy: 25, w: 20, h: 20, angle: 0 }, // 右上块
      { cx: 25, cy: 25, w: 20, h: 20, angle: 0 },
      { cx: 25, cy: 25, w: 20, h: 20, angle: 0 },
    ]});
    assert.equal(r.ok, false);
    assert.ok(r.stats.tripleArea > 0);
    assert.ok(r.stats.gapArea > 0);
    assert.equal(r.firstRisk.kind, 'gap');
  });
});

describe('边界接触语义', () => {
  test('两条带仅边边相接时接触面为二重（合规），外部点不算覆盖', () => {
    // R1: x∈[0,10]，R2: x∈[10,20]，共边 x=10
    const r = certify({ workarea: [[0, 0], [20, 0], [20, 20], [0, 20]], strips: [
      { cx: 5, cy: 10, w: 10, h: 20, angle: 0 },
      { cx: 15, cy: 10, w: 10, h: 20, angle: 0 },
      { cx: -50, cy: 0, w: 1, h: 1, angle: 0 },
    ]});
    assert.equal(r.ok, true);
    assert.equal(r.stats.gapArea, 0);
    assert.equal(r.stats.maxMultiplicity, 2);
  });

  test('凸多边形闭集包含', () => {
    const tri = [pt(0, 0), pt(10, 0), pt(0, 10)];
    assert.equal(convexContains(tri, pt(5, 0)), true);   // 底边上
    assert.equal(convexContains(tri, pt(0, 0)), true);   // 顶点
    assert.equal(convexContains(tri, pt(-1e-30, -1e-30)), true); // 容差内
    assert.equal(convexContains(tri, pt(11, 0)), false); // 底边延长线外
    assert.equal(convexContains(tri, pt(6, 6)), false);  // 斜边外
  });
});

describe('面积守恒（无采样不变量）', () => {
  test('任意场景：单元面积按覆盖数加权汇总 = 工作区面积', () => {
    const scenarios = [
      { workarea: square(), strips: [
        { cx: 6, cy: 15, w: 16, h: 34, angle: 0 },
        { cx: 26, cy: 15, w: 12, h: 34, angle: 0 },
        { cx: 15, cy: 28, w: 6, h: 4, angle: 0 },
      ]},
      { workarea: [[0, 0], [36, 0], [36, 24], [0, 24]], strips: [
        { cx: 9, cy: 12, w: 30, h: 34, angle: 30 },
        { cx: 27, cy: 12, w: 30, h: 34, angle: 30 },
        { cx: 18, cy: 40, w: 10, h: 6, angle: 0 },
      ]},
    ];
    for (const sc of scenarios) {
      const r = certify(sc);
      const sum = r.stats.gapArea + r.stats.singleArea + r.stats.doubleArea + r.stats.tripleArea;
      assert.ok(Math.abs(sum - r.stats.workArea) < 1e-5);
      // 渲染用单元同样铺满
      let cellSum = 0;
      for (const c of r.cells) {
        cellSum += polygonArea(c.vertices);
      }
      assert.ok(Math.abs(cellSum - r.stats.workArea) < 1e-5);
    }
  });
});

function round(x, d = 9) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

function polygonArea(verts) {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % verts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

void Decimal;
