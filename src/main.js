/**
 * 前端主逻辑：草稿录入 / 立即撤销旧报告 / 发起认证 / 平面图与明细渲染。
 * 认证直接调用本地业务模块 src/certify.js（纯连续平面判定，无栅格、无采样）。
 */
import { certify } from './certify.js';
import { samples } from './samples.js';
import { buildRect } from './geometry/core.js';

const $ = (id) => document.getElementById(id);
const STRIP_FIELDS = ['cx', 'cy', 'w', 'h', 'angle'];

const state = { report: null };

/* ---------------- 草稿读取 ---------------- */

function readWorkarea() {
  const verts = [];
  const badLines = [];
  $('workareaInput').value.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(/[,\s，]+/).filter(Boolean);
    if (parts.length !== 2 || parts.some((p) => !Number.isFinite(Number(p)))) {
      badLines.push(i + 1);
      return;
    }
    verts.push([Number(parts[0]), Number(parts[1])]);
  });
  return { verts, badLines };
}

function readStrips() {
  return [...$('stripRows').querySelectorAll('tr')].map((tr) => {
    const rec = {};
    STRIP_FIELDS.forEach((f) => {
      const v = tr.querySelector(`[data-field="${f}"]`).value.trim();
      rec[f] = v === '' ? NaN : Number(v);
    });
    return rec;
  });
}

/** 从当前草稿构造平面图场景（不做判定，仅几何预览） */
function draftScene() {
  const { verts, badLines } = readWorkarea();
  const strips = [];
  for (const s of readStrips()) {
    if (STRIP_FIELDS.every((f) => Number.isFinite(s[f])) && s.w > 0 && s.h > 0) {
      strips.push({ corners: buildRect(s).corners.map((p) => [p.x.toNumber(), p.y.toNumber()]) });
    } else {
      strips.push({ corners: [] });
    }
  }
  return { workarea: badLines.length ? [] : verts, strips };
}

/* ---------------- 报告失效：草稿改变立即撤销 ---------------- */

function invalidateReport() {
  if (!state.report) return;
  state.report = null;
  setBadge('stale', '草稿已修改 · 旧报告已撤销');
  $('reportView').innerHTML =
    '<p class="msg info">草稿已改变，上一份认证报告已立即撤销。修改完成后请重新发起认证。</p>';
  renderStripDetail(null);
}

/* ---------------- 覆盖带表格 ---------------- */

function addStripRow(vals = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="muted"></td>
    ${STRIP_FIELDS.map((f) => `<td><input data-field="${f}" inputmode="numeric" value="${vals[f] ?? ''}"></td>`).join('')}
    <td><button type="button" class="btn-small del">删</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => {
    tr.remove();
    reindexStrips();
    invalidateReport();
    schedulePreview();
  });
  $('stripRows').appendChild(tr);
  reindexStrips();
}

function reindexStrips() {
  [...$('stripRows').children].forEach((tr, i) => {
    tr.firstElementChild.textContent = `R${i + 1}`;
  });
}

function setStrips(strips) {
  $('stripRows').innerHTML = '';
  strips.forEach((s) => addStripRow(s));
}

/* ---------------- 认证 ---------------- */

function setMsg(text, kind) {
  const el = $('formMsg');
  el.textContent = text;
  el.className = `msg ${kind || ''}`;
}

function setBadge(kind, text) {
  const el = $('statusBadge');
  el.className = `badge badge-${kind}`;
  el.textContent = text;
}

function runCertify() {
  const { verts, badLines } = readWorkarea();
  if (badLines.length) {
    setMsg(`工作区第 ${badLines.join('、')} 行无法解析，应为 "x, y"。`, 'error');
    return;
  }
  const report = certify({ workarea: verts, strips: readStrips() });
  if (report.errors?.length) {
    setMsg(report.errors.join('\n'), 'error');
    setBadge('stale', '输入不合规');
    return;
  }
  setMsg('', '');
  state.report = report;
  if (report.ok) {
    setBadge('ok', '认证通过');
  } else if (report.gaps.length) {
    setBadge('bad', `认证未通过 · ${report.gaps.length} 处漏拍`);
  } else {
    setBadge('bad', `认证未通过 · ${report.triples.length} 处三重曝光`);
  }
  renderReport(report);
  renderPlan(reportScene(report), report);
  renderStripDetail(report);
}

function reportScene(report) {
  return { workarea: report.workarea, strips: report.strips };
}

/* ---------------- 平面图 ---------------- */

const stripColor = (i) => `hsl(${(i * 53) % 360} 80% 60%)`;
const stripFill = (i) => `hsla(${(i * 53) % 360}, 80%, 60%, 0.10)`;

function renderPlan(scene, report = null) {
  const canvas = $('planCanvas');
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 640;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // 视野范围
  const pts = [];
  (scene.workarea || []).forEach((p) => pts.push(p));
  (scene.strips || []).forEach((s) => (s.corners || []).forEach((p) => pts.push(p)));
  if (!pts.length) {
    ctx.fillStyle = '#8fa0b3';
    ctx.font = '13px sans-serif';
    ctx.fillText('（录入工作区顶点与覆盖带后显示平面图）', 24, size / 2);
    renderLegend(report);
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08 + 1e-9;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const scale = Math.min((size - 30) / (maxX - minX), (size - 30) / (maxY - minY));
  const ox = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (size - (maxY - minY) * scale) / 2 + maxY * scale;
  const X = (x) => x * scale + ox;
  const Y = (y) => -y * scale + oy;

  // 网格
  ctx.strokeStyle = '#172230';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.ceil(minX / 10) * 10; gx <= maxX; gx += 10) {
    ctx.moveTo(X(gx), Y(minY)); ctx.lineTo(X(gx), Y(maxY));
  }
  for (let gy = Math.ceil(minY / 10) * 10; gy <= maxY; gy += 10) {
    ctx.moveTo(X(minX), Y(gy)); ctx.lineTo(X(maxX), Y(gy));
  }
  ctx.stroke();

  const drawPoly = (verts) => {
    ctx.beginPath();
    verts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
  };

  // 工作区填充
  if (scene.workarea?.length >= 3) {
    drawPoly(scene.workarea);
    ctx.fillStyle = 'rgba(120, 160, 210, 0.08)';
    ctx.fill();
  }

  // 覆盖带
  (scene.strips || []).forEach((s, i) => {
    if (!s.corners || s.corners.length < 3) return;
    drawPoly(s.corners);
    ctx.fillStyle = stripFill(i);
    ctx.fill();
    ctx.strokeStyle = stripColor(i);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    const cx = s.corners.reduce((a, p) => a + p[0], 0) / s.corners.length;
    const cy = s.corners.reduce((a, p) => a + p[1], 0) / s.corners.length;
    ctx.fillStyle = stripColor(i);
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.fillText(`R${i + 1}`, X(cx) - 8, Y(cy) + 4);
  });

  // 风险区域（认证后）
  if (report) {
    for (const r of report.risks) {
      if (r.shape !== 'region') continue;
      drawPoly(r.vertices);
      if (r.kind === 'gap') {
        ctx.fillStyle = 'rgba(239, 95, 107, 0.30)';
        ctx.strokeStyle = '#ef5f6b';
      } else {
        ctx.fillStyle = 'rgba(240, 163, 48, 0.32)';
        ctx.strokeStyle = '#f0a330';
      }
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const r of report.risks) {
      if (r.shape !== 'point') continue;
      const [x, y] = r.representative;
      ctx.strokeStyle = '#f0a330';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(x), Y(y), 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(x) - 10, Y(y)); ctx.lineTo(X(x) + 10, Y(y));
      ctx.moveTo(X(x), Y(y) - 10); ctx.lineTo(X(x), Y(y) + 10);
      ctx.stroke();
    }
    // 首个风险区域强调：粗虚线框
    const f = report.firstRisk;
    if (f && f.shape === 'region') {
      drawPoly(f.vertices);
      ctx.strokeStyle = '#ff2d55';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 工作区边界置顶
  if (scene.workarea?.length >= 3) {
    drawPoly(scene.workarea);
    ctx.strokeStyle = report ? '#cfe0f2' : '#9fb4cc';
    ctx.lineWidth = report ? 2 : 1.6;
    ctx.stroke();
  }

  renderLegend(report);
}

function renderLegend(report) {
  const items = [
    `<span><i class="swatch" style="background:rgba(120,160,210,.25);border:1px solid #cfe0f2"></i>工作区</span>`,
  ];
  const n = report ? report.strips.length : 0;
  for (let i = 0; i < n; i++) {
    items.push(`<span><i class="swatch" style="background:${stripColor(i)}"></i>R${i + 1}</span>`);
  }
  if (report?.gaps.length) {
    items.push(`<span><i class="swatch" style="background:rgba(239,95,107,.5)"></i>漏拍区</span>`);
  }
  if (report?.triples.length) {
    items.push(`<span><i class="swatch" style="background:rgba(240,163,48,.55)"></i>三重曝光</span>`);
  }
  $('legend').innerHTML = items.join('');
}

/* ---------------- 明细 ---------------- */

const fmt = (x, d = 3) => {
  if (!Number.isFinite(x)) return '—';
  if (Math.abs(x) >= 10000 || (x !== 0 && Math.abs(x) < 0.001)) return x.toExponential(3);
  return Number(x.toFixed(d)).toString();
};

function renderReport(report) {
  const s = report.stats;
  const verdict = report.ok
    ? `<div class="verdict ok">✓ 认证通过：工作区每一点至少被 1 条覆盖带覆盖，且任一点至多被 2 条覆盖带覆盖（边界接触计入）。</div>`
    : `<div class="verdict bad">✗ 认证未通过：检出 ${report.risks.length} 个风险区域。</div>`;

  const first = report.firstRisk;
  let firstCard = '';
  if (first) {
    const typeText = first.kind === 'gap'
      ? '漏拍（0 条带覆盖）'
      : first.shape === 'point'
        ? `三重曝光接触点（${first.multiplicity} 条带，零面积）`
        : `三重曝光区域（${first.multiplicity} 条带）`;
    firstCard = `
      <div class="risk-card ${first.kind === 'triple' ? 'triple' : ''}">
        <div class="title">首个风险区域（${first.id}）</div>
        <dl>
          <dt>类型</dt><dd>${typeText}</dd>
          <dt>面积</dt><dd>${fmt(first.area, 6)}</dd>
          <dt>代表点</dt><dd>(${fmt(first.representative[0], 3)}, ${fmt(first.representative[1], 3)})</dd>
          <dt>涉及覆盖带</dt><dd>${first.strips.length ? first.strips.map((n) => `R${n}`).join('、') : '—'}</dd>
          <dt>边界证据</dt><dd class="evidence">${first.boundary.join('　') || '（工作区内部）'}</dd>
        </dl>
      </div>`;
  }

  const rows = report.risks
    .map(
      (r) => `<tr>
        <td>${r.id}</td>
        <td><span class="tag ${r.kind}">${r.kind === 'gap' ? '漏拍' : '三重'}</span></td>
        <td>${r.shape === 'point' ? '点' : '区域'}</td>
        <td>${r.multiplicity}</td>
        <td>${fmt(r.area, 4)}</td>
        <td>${r.strips.map((n) => `R${n}`).join('、') || '—'}</td>
      </tr>`,
    )
    .join('');

  const riskTable = report.risks.length
    ? `<div class="risk-list"><table>
        <thead><tr><th>编号</th><th>类型</th><th>形态</th><th>层数</th><th>面积</th><th>覆盖带</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : '<p class="muted">无风险区域。</p>';

  $('reportView').innerHTML = `
    ${verdict}
    <div class="stat-grid">
      <div><span class="k">工作区面积</span><span class="v">${fmt(s.workArea, 4)}</span></div>
      <div><span class="k">覆盖率</span><span class="v">${(s.coverageRatio * 100).toFixed(2)}%</span></div>
      <div><span class="k">单层面积</span><span class="v">${fmt(s.singleArea, 4)}</span></div>
      <div><span class="k">双层重叠面积</span><span class="v">${fmt(s.doubleArea, 4)}</span></div>
      <div><span class="k">漏拍面积</span><span class="v" style="color:var(--bad)">${fmt(s.gapArea, 6)}</span></div>
      <div><span class="k">三重曝光面积</span><span class="v" style="color:var(--warn)">${fmt(s.tripleArea, 6)}</span></div>
      <div><span class="k">最大覆盖层数</span><span class="v">${s.maxMultiplicity}</span></div>
      <div><span class="k">剖分单元数</span><span class="v">${s.cellCount}</span></div>
    </div>
    ${firstCard}
    <h3>全部风险区域（${report.risks.length}）</h3>
    ${riskTable}`;
}

function renderStripDetail(report) {
  if (!report) {
    $('stripDetail').innerHTML = '<p class="muted">认证后显示各带几何参数。</p>';
    return;
  }
  const rows = report.strips
    .map(
      (s, i) => `<tr>
        <td><span class="dot" style="background:${stripColor(i)}"></span>R${s.index}</td>
        <td>${s.cx}</td><td>${s.cy}</td><td>${s.w}</td><td>${s.h}</td><td>${s.angle}°</td>
        <td>${s.area}</td>
      </tr>`,
    )
    .join('');
  $('stripDetail').innerHTML = `<table class="strip-detail-table">
    <thead><tr><th>编号</th><th>cx</th><th>cy</th><th>w</th><th>h</th><th>角度</th><th>面积</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/* ---------------- 初始化 ---------------- */

function loadSample(sample) {
  $('workareaInput').value = sample.workarea.map(([x, y]) => `${x}, ${y}`).join('\n');
  setStrips(sample.strips);
  invalidateReport();
  renderPlan(draftScene());
  setMsg(`已载入示例「${sample.name}」，请发起认证。`, 'info');
}

let previewRaf = 0;
function schedulePreview() {
  cancelAnimationFrame(previewRaf);
  previewRaf = requestAnimationFrame(() => {
    if (!state.report) renderPlan(draftScene());
  });
}

function init() {
  loadSample(samples[0]);

  $('addStripBtn').addEventListener('click', () => {
    addStripRow();
    invalidateReport();
    schedulePreview();
  });
  $('certifyBtn').addEventListener('click', runCertify);

  // 任何草稿修改 → 立即撤销旧报告（事件委托，含动态行）
  $('inputPanel').addEventListener('input', () => {
    invalidateReport();
    schedulePreview();
  });

  samples.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = s.name;
    btn.addEventListener('click', () => loadSample(s));
    $('sampleButtons').appendChild(btn);
  });

  window.addEventListener('resize', () => {
    if (state.report) renderPlan(reportScene(state.report), state.report);
    else renderPlan(draftScene());
  });

  renderPlan(draftScene());
  renderStripDetail(null);
}

init();
