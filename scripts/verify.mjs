/**
 * 一次性验证编排（compose 中 verify 服务的入口）：
 *   1) 代码测试  node --test
 *   2) 前端构建  vite build
 *   3) 冒烟      向认证业务模块提交合格与风险场景
 * 全部成功 → 退出码 0；任一失败 → 退出码 1（服务随之自行退出）。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  ['代码测试', ['--test']],
  ['前端构建', ['run', 'build']],
  ['冒烟（合格+风险场景）', ['scripts/smoke.mjs']],
];

const results = [];
for (const [name, args] of steps) {
  console.log(`\n========== ${name} ==========`);
  const cmd = name === '前端构建' ? 'npm' : 'node';
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });
  const ok = r.status === 0;
  results.push([name, ok]);
  console.log(`---------- ${name}：${ok ? '通过' : `失败（退出码 ${r.status}）`} ----------`);
}

console.log('\n========== verify 汇总 ==========');
for (const [name, ok] of results) console.log(`${ok ? '✅' : '❌'} ${name}`);
const failed = results.filter(([, ok]) => !ok).length;
if (failed) {
  console.log(`verify 失败：${failed} 个步骤未通过`);
  process.exit(1);
}
console.log('verify 全部通过');
process.exit(0);
