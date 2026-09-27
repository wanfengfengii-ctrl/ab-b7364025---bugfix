/**
 * 样例场景：UI「载入示例」与冒烟测试共用。
 * 每个场景附带期望结论，便于冒烟断言。
 */

/** 合格：轴对齐 + 边界接触（R1/R2 边与工作区边重合，接触计入覆盖） */
export const qualifiedBoundary = {
  name: '合格·边界接触',
  workarea: [[0, 0], [30, 0], [30, 30], [0, 30]],
  strips: [
    { cx: 10, cy: 15, w: 20, h: 30, angle: 0 },  // x∈[0,20]，边与工作区左边重合
    { cx: 20, cy: 15, w: 20, h: 30, angle: 0 },  // x∈[10,30]，与 R1 重叠 [10,20]（2 层）
    { cx: 15, cy: 45, w: 10, h: 10, angle: 0 },  // 区外冗余带
  ],
  expect: { ok: true },
};

/** 合格：旋转覆盖带（30°），区外一条冗余带 */
export const qualifiedRotated = {
  name: '合格·旋转条带',
  workarea: [[0, 0], [36, 0], [36, 24], [0, 24]],
  strips: [
    { cx: 9, cy: 12, w: 30, h: 34, angle: 30 },
    { cx: 27, cy: 12, w: 30, h: 34, angle: 30 },
    { cx: 18, cy: 40, w: 10, h: 6, angle: 0 },
  ],
  expect: { ok: true },
};

/** 风险：中央竖直漏拍带（顶部被 R3 部分遮挡，形成 L 形漏拍区） */
export const riskGap = {
  name: '风险·漏拍',
  workarea: [[0, 0], [30, 0], [30, 30], [0, 30]],
  strips: [
    { cx: 6, cy: 15, w: 16, h: 34, angle: 0 },   // x∈[-2,14]
    { cx: 26, cy: 15, w: 12, h: 34, angle: 0 },  // x∈[20,32]
    { cx: 15, cy: 28, w: 6, h: 4, angle: 0 },    // 遮住漏拍带顶部一小角
  ],
  expect: { ok: false, firstKind: 'gap' },
};

/** 风险：三条带共同覆盖中央区域 → 三重曝光区域 */
export const riskTriple = {
  name: '风险·三重曝光',
  workarea: [[0, 0], [30, 0], [30, 30], [0, 30]],
  strips: [
    { cx: 10, cy: 15, w: 24, h: 34, angle: 0 },  // x∈[-2,22]
    { cx: 20, cy: 15, w: 24, h: 34, angle: 0 },  // x∈[8,32]
    { cx: 15, cy: 15, w: 10, h: 40, angle: 0 },  // x∈[10,20] → 三重区
  ],
  expect: { ok: false, firstKind: 'triple' },
};

/** 风险：零面积三重接触（三条带仅在 (16,15) 一点共同接触） */
export const riskTriplePoint = {
  name: '风险·三重接触点',
  workarea: [[0, 0], [30, 0], [30, 30], [0, 30]],
  strips: [
    { cx: 8, cy: 15, w: 16, h: 30, angle: 0 },   // x∈[0,16]
    { cx: 24, cy: 15, w: 16, h: 30, angle: 0 },  // x∈[16,32]
    { cx: 16, cy: 22, w: 8, h: 14, angle: 0 },   // 底边 y=15 过点 (16,15)
  ],
  expect: { ok: false, firstKind: 'triple', firstShape: 'point' },
};

export const samples = [qualifiedBoundary, qualifiedRotated, riskGap, riskTriple, riskTriplePoint];
