/**
 * 冒烟测试：向覆盖认证业务模块提交「合格」与「风险」场景，
 * 校验认证结论、首个风险区域的类型/面积/边界证据。
 * 全部通过 → 退出码 0；任一失败 → 退出码 1。
 */
import { certify } from '../src/certify.js';
import {
  qualifiedBoundary, qualifiedRotated, riskGap, riskTriple, riskTriplePoint,
} from '../src/samples.js';

let failures = 0;

function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
}

function approx(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

function scenario(title, input, expect) {
  console.log(`\n[场景] ${title}`);
  const t0 = Date.now();
  const report = certify(input);
  const ms = Date.now() - t0;
  console.log(`  判定耗时 ${ms}ms，剖分单元 ${report.stats?.cellCount ?? '—'}`);
  check('无输入错误', !report.errors?.length, JSON.stringify(report.errors));
  check(`认证结论 ok=${expect.ok}`, report.ok === expect.ok, `实际 ok=${report.ok}`);
  if (expect.ok) {
    check('无漏拍', report.stats.gapArea === 0, `gapArea=${report.stats.gapArea}`);
    check('无三重曝光', report.stats.tripleArea === 0 && !report.triples.length);
    check('覆盖率 100%', approx(report.stats.coverageRatio, 1), `实际 ${report.stats.coverageRatio}`);
    check('最大层数 ≤ 2', report.stats.maxMultiplicity <= 2, `实际 ${report.stats.maxMultiplicity}`);
  }
  if (expect.firstKind) {
    const f = report.firstRisk;
    check('存在首个风险区域', !!f);
    if (f) {
      check(`首个风险类型=${expect.firstKind}`, f.kind === expect.firstKind, `实际 ${f.kind}`);
      check('首个风险含面积字段', Number.isFinite(f.area) && f.area >= 0, `area=${f.area}`);
      check('首个风险含边界证据', Array.isArray(f.boundary) && f.boundary.length > 0,
        `boundary=${JSON.stringify(f.boundary)}`);
    }
  }
  if (expect.firstShape) {
    check(`首个风险形态=${expect.firstShape}`, report.firstRisk?.shape === expect.firstShape,
      `实际 ${report.firstRisk?.shape}`);
  }
  if (expect.gapArea !== undefined) {
    check(`漏拍面积≈${expect.gapArea}`, approx(report.stats.gapArea, expect.gapArea),
      `实际 ${report.stats.gapArea}`);
  }
  if (expect.tripleArea !== undefined) {
    check(`三重曝光面积≈${expect.tripleArea}`, approx(report.stats.tripleArea, expect.tripleArea),
      `实际 ${report.stats.tripleArea}`);
  }
}

console.log('== 覆盖认证业务模块 · 冒烟测试 ==');

scenario('合格 · 边界接触（轴对齐）', qualifiedBoundary, { ok: true });
scenario('合格 · 旋转 30° 条带', qualifiedRotated, { ok: true });
scenario('风险 · 漏拍（L 形缺口）', riskGap, { ok: false, firstKind: 'gap', gapArea: 164 });
scenario('风险 · 三重曝光区域', riskTriple, { ok: false, firstKind: 'triple', tripleArea: 300 });
scenario('风险 · 零面积三重接触点', riskTriplePoint, {
  ok: false, firstKind: 'triple', firstShape: 'point', tripleArea: 0,
});

console.log(failures ? `\n冒烟失败：${failures} 项未通过` : '\n冒烟通过：全部场景符合预期');
process.exit(failures ? 1 : 0);
