// popup.js - pulls report from active tab's content script, renders overview,
// and generates a complete PDF report entirely inside the popup (no print dialog).

const $ = (sel) => document.querySelector(sel);

let currentReport = null;
let currentTabId = null;
let currentIp = null;   // public IP for watermark, best-effort

const VITAL_THRESHOLDS = {
  LCP: [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25],
  INP: [200, 500], TTFB: [800, 1800],
};

// 大白话 Web Vitals 映射
const VITAL_LABELS = {
  LCP:  { icon: '🎯', name: '首屏主内容出现',
          good: '很快', warn: '稍慢', bad: '太慢',
          explain: '用户从点开到看到主要内容的时间' },
  FCP:  { icon: '📷', name: '页面开始出内容',
          good: '很快', warn: '有点慢', bad: '明显慢',
          explain: '浏览器第一次画出任何东西的时间' },
  CLS:  { icon: '📏', name: '页面抖动',
          good: '稳定',   warn: '偶有跳动', bad: '频繁跳动',
          explain: '排版突然错位把用户点错按钮的程度' },
  INP:  { icon: '⚡', name: '点击反应速度',
          good: '灵敏', warn: '有延迟', bad: '卡顿',
          explain: '用户点按钮到界面真正响应的时间' },
  TTFB: { icon: '🚀', name: '服务器响应速度',
          good: '快', warn: '一般', bad: '慢',
          explain: '浏览器发请求到服务器返回第一个字节的时间' },
};

function rateVital(name, value) {
  if (value == null) return 'unknown';
  const t = VITAL_THRESHOLDS[name];
  if (!t) return 'unknown';
  if (value <= t[0]) return 'good';
  if (value <= t[1]) return 'warn';
  return 'bad';
}

function fmtMs(v) { return v == null ? '—' : `${Math.round(v)} ms`; }
function fmtSec(v) { return v == null ? '—' : `${(v / 1000).toFixed(1)} 秒`; }

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// v0.9.0:多 frame 架构。不再走 tabs.sendMessage,改用 chrome.scripting
//   1. 在所有 frame 注入 inject.js + content.js(idempotent)
//   2. executeScript({ allFrames: true }) 收集每个 frame 的 __JUDGE_DUMP_RAW__()
//   3. 可选:对顶层 origin 做 RTT 探测,或对所有 API 域名做 ping
//   4. 把所有 dump 交给 JudgeAnalyzer.buildReport 合并分析
async function fetchReport(opts) {
  opts = opts || {};
  const tab = await getActiveTab();
  currentTabId = tab.id;
  const tabId = tab.id;

  // 1. 兜底注入(刚装扩展或刷新前打开的页面会用到)
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inject.js'],
      world: 'MAIN',
    });
  } catch (_) { /* chrome:// 等会失败,忽略 */ }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (e) {
    renderError('无法注入脚本,请在普通网页上使用 (不支持 chrome:// 页面)。');
    return null;
  }

  // 2. 收集所有 frame 的原始数据
  let dumps;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (typeof window.__JUDGE_DUMP_RAW__ === 'function') ? window.__JUDGE_DUMP_RAW__() : null,
    });
    dumps = results
      .filter((r) => r && r.result)
      .map((r) => Object.assign({}, r.result, { frameId: r.frameId }));
  } catch (e) {
    renderError('采样失败:' + (e && e.message || e));
    return null;
  }
  if (!dumps.length) {
    renderError('当前页面无法采样(可能是受限页面)。');
    return null;
  }

  // 3. 可选探测
  let activeProbe = null;
  if (opts.withActiveProbe) {
    const top = dumps.find((d) => d.isTop) || dumps[0];
    const target = top.frameOrigin + '/favicon.ico';
    try {
      const probeRes = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: async (target, n, t) => (typeof window.__JUDGE_PROBE__ === 'function')
          ? await window.__JUDGE_PROBE__(target, n, t) : null,
        args: [target, opts.probeSampleCount || 6, 4000],
      });
      const out = probeRes[0] && probeRes[0].result;
      if (out) {
        const samples = out.samples || [];
        const sorted = samples.slice().sort((a, b) => a - b);
        const sample = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
        activeProbe = {
          target,
          requested: opts.probeSampleCount || 6,
          successCount: samples.length,
          failedCount: (out.errors || []).length,
          samples,
          min: sorted[0] || null,
          max: sorted[sorted.length - 1] || null,
          avg: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
          p50: sample(0.5),
          p95: sample(0.95),
          jitter: samples.length > 1 ? (Math.max(...samples) - Math.min(...samples)) : 0,
        };
      }
    } catch (_) { /* probe optional */ }
  }

  let domainPings = null;
  if (opts.probeAllDomains) {
    const origins = new Set();
    for (const d of dumps) {
      for (const r of d.resources || []) {
        try {
          const o = new URL(r.name).origin;
          if (o.startsWith('http')) origins.add(o);
        } catch (_) {}
      }
    }
    try {
      domainPings = await window.JudgeAnalyzer.probeOrigins(tabId, Array.from(origins), { sampleCount: 3, timeoutMs: 4000 });
    } catch (e) {
      console.warn('domain ping failed', e);
    }
  }

  // 4. 合并分析
  try {
    return window.JudgeAnalyzer.buildReport(dumps, { activeProbe, domainPings });
  } catch (e) {
    renderError('分析失败:' + (e && e.message || e));
    return null;
  }
}

function renderError(msg) {
  $('#slowList').innerHTML = `<li class="muted">${msg}</li>`;
}

// -------- 网络 0-100 评分 --------
function scoreNetwork(net) {
  if (!net) return { score: null, emoji: '❓', label: '未知', reasons: ['无网络数据'] };

  let score = 100;
  const reasons = [];

  const br = net.browserReported || {};
  // effectiveType 硬天花板
  const et = br.effectiveType;
  if (et === 'slow-2g' || et === '2g') { score = Math.min(score, 25); reasons.push(`浏览器判定 ${et}`); }
  else if (et === '3g') { score = Math.min(score, 60); reasons.push(`浏览器判定 ${et}`); }

  if (br.rttMs != null) {
    if (br.rttMs > 500) { score -= 25; reasons.push(`RTT ${br.rttMs}ms 偏高`); }
    else if (br.rttMs > 300) { score -= 15; reasons.push(`RTT ${br.rttMs}ms 稍高`); }
    else if (br.rttMs > 150) { score -= 6; }
  }
  if (br.downlinkMbps != null) {
    if (br.downlinkMbps < 0.5) { score -= 25; reasons.push(`下行仅 ${br.downlinkMbps} Mbps`); }
    else if (br.downlinkMbps < 1.5) { score -= 12; reasons.push(`下行 ${br.downlinkMbps} Mbps`); }
    else if (br.downlinkMbps < 4) { score -= 5; }
  }
  if (br.saveData) { score -= 5; reasons.push('开启省流量模式'); }

  const mDl = net.measured && net.measured.downloadThroughputMbps;
  if (mDl && mDl.p50 != null) {
    if (mDl.p50 < 1) { score -= 20; reasons.push(`实测下载中位 ${mDl.p50.toFixed(2)} Mbps`); }
    else if (mDl.p50 < 3) { score -= 8; reasons.push(`实测下载中位 ${mDl.p50.toFixed(2)} Mbps`); }
  }
  const mTtfb = net.measured && net.measured.ttfbStaticMs;
  if (mTtfb && mTtfb.p50 != null) {
    if (mTtfb.p50 > 800) { score -= 15; reasons.push(`静态 TTFB 中位 ${Math.round(mTtfb.p50)}ms`); }
    else if (mTtfb.p50 > 400) { score -= 6; reasons.push(`静态 TTFB 中位 ${Math.round(mTtfb.p50)}ms`); }
  }
  if (net.activeProbe) {
    if (net.activeProbe.p50 != null && net.activeProbe.p50 > 500) {
      score -= 12; reasons.push(`实测 RTT ${Math.round(net.activeProbe.p50)}ms`);
    }
    if (net.activeProbe.jitter != null && net.activeProbe.jitter > 200) {
      score -= 6; reasons.push(`RTT 抖动 ${Math.round(net.activeProbe.jitter)}ms`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let emoji, label;
  if (score >= 80)      { emoji = '💐'; label = '优秀'; }
  else if (score >= 65) { emoji = '👍'; label = '良好'; }
  else if (score >= 50) { emoji = '😐'; label = '一般'; }
  else                  { emoji = '💩'; label = '糟糕'; }

  return { score, emoji, label, reasons };
}

function renderFrameInfo(meta) {
  const fc = meta && meta.frameCount;
  if (!fc) { $('#frameInfo').textContent = ''; return; }
  if (fc === 1) {
    $('#frameInfo').textContent = '架构:单页面';
  } else {
    $('#frameInfo').textContent = `架构:顶层 + ${fc - 1} 个 iframe(数据已合并)`;
  }
}

function renderDomainPings(network) {
  const pings = network && network.domainPings;
  if (!pings) {
    // remove if previously rendered
    const ex = document.querySelector('#netSummary .domain-pings');
    if (ex) ex.remove();
    return;
  }
  const rows = Object.entries(pings).map(([origin, p]) => {
    if (!p) return null;
    const cls = p.rating || (p.successCount === 0 ? 'unreachable' : 'fair');
    const label = { good: 'GOOD', fair: 'FAIR', poor: 'POOR', unreachable: 'X' }[cls] || cls;
    const lat = p.successCount === 0 ? '超时'
              : p.p50 != null ? `${Math.round(p.p50)}/${Math.round(p.p95 || p.p50)}ms`
              : '—';
    return `<div class="row"><span class="origin" title="${origin}">${origin}</span><span class="lat">${lat}</span><span class="badge ${cls}">${label}</span></div>`;
  }).filter(Boolean).join('');
  let block = document.querySelector('#netSummary .domain-pings');
  if (!block) {
    block = document.createElement('div');
    block.className = 'domain-pings';
    $('#netSummary').appendChild(block);
  }
  block.innerHTML = '<div style="color:#57606a;font-weight:600;margin-bottom:2px">域名 ping (p50/p95)</div>' + rows;
}

function ringSvg(score, ratingClass) {
  const C = 2 * Math.PI * 30; // 188.5
  const offset = C * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `
    <div class="score-ring ${ratingClass}">
      <svg width="70" height="70" viewBox="0 0 70 70">
        <circle class="ring-bg" cx="35" cy="35" r="30" fill="none" stroke-width="6"/>
        <circle class="ring-fg" cx="35" cy="35" r="30" fill="none" stroke-width="6"
                stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" stroke-linecap="round"/>
      </svg>
      <div class="num">${score == null ? '—' : Math.round(score)}</div>
    </div>`;
}

function ratingClassOf(score) {
  if (score == null) return '';
  if (score >= 80) return 'good';
  if (score >= 65) return 'good';
  if (score >= 50) return 'fair';
  return 'poor';
}
function ratingLabelOf(score) {
  if (score == null) return '未知';
  if (score >= 80) return '优秀';
  if (score >= 65) return '良好';
  if (score >= 50) return '一般';
  return '较差';
}

function renderNetwork(n) {
  if (!n) {
    $('#netSummary').innerHTML = '<div class="muted">无网络数据</div>';
    return;
  }
  const s = scoreNetwork(n);
  currentReport && (currentReport._netScore = s);
  const br = n.browserReported || {};
  const m = n.measured || {};
  const probe = n.activeProbe;
  const ratingClass = ratingClassOf(s.score);
  const ratingLabel = ratingLabelOf(s.score);
  const headlineMap = {
    good: '网络环境良好',
    fair: '网络稍有波动',
    poor: '用户网络较差',
  };
  const headline = headlineMap[ratingClass] || '网络';
  const descMap = {
    good: '慢锅不在你这,可放心提工单。',
    fair: '部分慢可能是网络导致,不全是后端。',
    poor: '建议先排查 WiFi / 切有线 / 换网络环境。',
  };

  const kv = [
    ['估算下行', br.downlinkMbps != null ? `${br.downlinkMbps} Mbps` : '—'],
    ['估算 RTT', br.rttMs != null ? `${br.rttMs} ms` : '—'],
    ['实测下载 p50', m.downloadThroughputMbps && m.downloadThroughputMbps.p50 != null ? `${m.downloadThroughputMbps.p50.toFixed(2)} Mbps` : '—'],
    ['静态 TTFB p50', m.ttfbStaticMs && m.ttfbStaticMs.p50 != null ? `${Math.round(m.ttfbStaticMs.p50)} ms` : '—'],
  ];
  if (probe && probe.p50 != null) {
    kv.push(['探测 RTT p50', `${Math.round(probe.p50)} ms`]);
    kv.push(['RTT 抖动', `${Math.round(probe.jitter)} ms`]);
  }
  $('#netSummary').innerHTML = `
    <div class="score-flex">
      ${ringSvg(s.score, ratingClass)}
      <div class="score-info">
        <span class="rating-pill ${ratingClass}">${ratingLabel}</span>
        <h3>${escHtml(headline)}</h3>
        <div class="desc">${escHtml(descMap[ratingClass] || (s.reasons.slice(0, 2).join(' · ') || ''))}</div>
      </div>
    </div>
    <div class="kvs">
      ${kv.map(([k, v]) => `<div><span class="k">${escHtml(k)}</span><span class="v">${escHtml(v)}</span></div>`).join('')}
    </div>
  `;
}

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

// Web Vitals 白话版
function renderVitals(v, nav) {
  const ttfb = nav ? nav.ttfb : null;
  const items = [
    { key: 'LCP',  value: v.LCP ? v.LCP.value : null,  asSec: true  },
    { key: 'FCP',  value: v.FCP ? v.FCP.value : null,  asSec: true  },
    { key: 'CLS',  value: v.CLS, isCLS: true },
    { key: 'INP',  value: v.INP ? v.INP.value : null },
    { key: 'TTFB', value: ttfb },
  ];
  const ICON_LETTER = { LCP: 'L', FCP: 'F', CLS: 'C', INP: 'I', TTFB: 'T' };
  const html = items.map((it) => {
    const def = VITAL_LABELS[it.key];
    const rate = it.isCLS
      ? (it.value == null ? 'unknown' : it.value <= 0.1 ? 'good' : it.value <= 0.25 ? 'warn' : 'bad')
      : rateVital(it.key, it.value);
    const labelMap = { good: def.good, warn: def.warn, bad: def.bad, unknown: '—' };
    let display;
    if (it.value == null) display = '—';
    else if (it.isCLS) display = it.value.toFixed(2);
    else if (it.asSec && it.value >= 1000) display = fmtSec(it.value);
    else display = fmtMs(it.value);
    return `
      <div class="vital-row">
        <div class="icon ${rate}">${ICON_LETTER[it.key]}</div>
        <div>
          <div class="name">${def.name}</div>
          <div class="desc">${def.explain}</div>
        </div>
        <div class="right">
          <div class="value">${display}</div>
          <div class="verdict">${labelMap[rate]}</div>
        </div>
      </div>`;
  }).join('');
  const lt = v.longTasks.length;
  const ltRate = lt === 0 ? 'good' : lt > 5 ? 'bad' : 'warn';
  const ltLabel = { good: '流畅', warn: '偶尔卡顿', bad: '明显卡顿' }[ltRate];
  $('#vitalsGrid').innerHTML = html + `
    <div class="vital-row">
      <div class="icon ${ltRate}">M</div>
      <div>
        <div class="name">主线程卡顿</div>
        <div class="desc">JS 长任务阻塞主线程的次数</div>
      </div>
      <div class="right">
        <div class="value">${lt} 次</div>
        <div class="verdict">${ltLabel}</div>
      </div>
    </div>`;
}

function renderOverview(s, meta) {
  $('#overview').innerHTML = [
    ['请求总数', s.totalRequests],
    ['传输体积', `${s.totalTransferKB} KB`],
    ['慢接口 (>1s)', s.slowApis.length],
    ['HTTP 异常', s.failedApis.length],
    ['业务层失败', (s.bizFailedApis || []).length],
    ['浏览器排队', s.queued.length],
  ].map(([k, v]) => `<div><span>${escHtml(k)}</span><span>${escHtml(v)}</span></div>`).join('');
}

function renderSlowList(s) {
  const bizFailed = s.bizFailedApis || [];
  if (s.slowApis.length === 0 && s.failedApis.length === 0 && bizFailed.length === 0) {
    $('#slowList').innerHTML = '<li class="muted">没有慢接口,也没有异常状态 🎉</li>';
    return;
  }
  const items = [
    ...s.failedApis.slice(0, 2).map((r) => ({ r, badge: 'status-bad', label: `HTTP ${r.status}` })),
    ...bizFailed.slice(0, 2).map((r) => ({ r, badge: 'status-bad', label: `biz ${r.biz && r.biz.status}` })),
    ...s.slowApis.slice(0, 4).map((r) => ({ r, badge: r.slowReason || 'mixed', label: reasonLabel(r.slowReason) })),
  ].slice(0, 6);
  $('#slowList').innerHTML = items.map(({ r, badge, label }) => {
    const shortUrl = r.path && r.path.length <= 52 ? r.path : (r.path || r.url).slice(0, 52) + '…';
    const extra = [];
    if (r.serverReportedRuntimeMs != null) extra.push(`server ${Math.round(r.serverReportedRuntimeMs)}ms, Δ${Math.round(r.runtimeDelta)}ms`);
    if (r.biz && r.biz.message) extra.push(`msg: ${r.biz.message}`);
    const sub = extra.length ? `<span class="sub">${escHtml(extra.join(' · '))}</span>` : '';
    return `<li>
      <span class="url" title="${escHtml(r.url)}">${escHtml(shortUrl)}</span>
      <strong>${Math.round(r.duration)}ms</strong>
      <span class="tag ${escHtml(badge)}">${escHtml(label)}</span>
      ${sub}
    </li>`;
  }).join('');
}

function reasonLabel(r) {
  return ({
    // 新标签
    'backend-slow': '后端慢',
    'network-congestion': '网络拥塞',
    'cold-connection': '首次连接慢',
    'browser-queue': '被浏览器排队',
    'large-response': '响应过大',
    'mixed': '综合',
    // 旧标签兼容
    'download-heavy': '下载耗时',
    'frontend-overhead': '前端开销',
    'user-network': '用户网络慢',
  })[r] || r || '';
}

function renderWarnings(sugs) {
  if (!sugs || sugs.length === 0) {
    $('#warnings').innerHTML = '<h2>优化建议</h2><div class="muted">暂无明显问题 ✨</div>';
    return;
  }
  $('#warnings').innerHTML = '<h2>优化建议</h2>' + sugs.slice(0, 4).map((s) =>
    `<div class="warn-item ${escHtml(s.level)}">
      <div class="t">${escHtml(s.title)}</div>
      <div class="d">${escHtml(s.detail)}</div>
    </div>`).join('');
}

// IP 水印的公网 IP 查询统一由 pdf-report.js (JudgePdfBuilder.fetchPublicIp) 提供

// -------- 摘要 / JSON --------
function buildTextSummary(r) {
  const lines = [];
  const s = r._netScore || scoreNetwork(r.network);
  lines.push(`【Judge 页面性能体检报告】`);
  lines.push(`URL: ${r.meta.url}`);
  lines.push(`标题: ${r.meta.title}`);
  lines.push(`采样时间: ${r.meta.generatedAt}`);
  lines.push('');
  lines.push(`用户网络评分: ${s.score} / 100  ${s.emoji} ${s.label}`);
  if (s.reasons.length) lines.push(`理由: ${s.reasons.slice(0, 5).join(' / ')}`);
  lines.push('');
  lines.push(`--- 概览 ---`);
  lines.push(`总请求 ${r.summary.totalRequests} | 慢接口 ${r.summary.slowApis.length} | HTTP 异常 ${r.summary.failedApis.length} | 业务层失败 ${(r.summary.bizFailedApis || []).length} | 排队 ${r.summary.queued.length}`);
  lines.push('');
  if ((r.summary.bizFailedApis || []).length > 0) {
    lines.push(`--- 业务层失败接口 (HTTP 200 但 biz.status != 0) ---`);
    r.summary.bizFailedApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [biz.status=${x.biz && x.biz.status}] ${x.method || ''} ${x.url}`);
      lines.push(`   message: ${(x.biz && x.biz.message) || ''}`);
    });
    lines.push('');
  }
  if (r.summary.failedApis.length > 0) {
    lines.push(`--- HTTP 状态异常接口 ---`);
    r.summary.failedApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [HTTP ${x.status}] ${x.method || ''} ${x.url}`);
    });
    lines.push('');
  }
  if (r.summary.slowApis.length > 0) {
    lines.push(`--- 慢接口 Top 10 ---`);
    r.summary.slowApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [${Math.round(x.duration)}ms] ${x.method || ''} ${x.url}`);
    });
  }
  return lines.join('\n');
}

async function copySummary() {
  if (!currentReport) return;
  try {
    await navigator.clipboard.writeText(buildTextSummary(currentReport));
    flash('copySummary', '已复制');
  } catch (_) { flash('copySummary', '失败'); }
}

function flash(id, text) {
  const btn = document.getElementById(id);
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1200);
}

// -------- 打开完整报告(v0.4 的全量 HTML 展示界面) --------
async function openReport() {
  if (!currentReport) return;
  const btn = $('#openReport');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '打开中…';
  try {
    await chrome.runtime.sendMessage({ type: 'JUDGE_OPEN_REPORT', payload: currentReport });
    window.close();
  } catch (e) {
    btn.textContent = '失败';
    console.error('打开完整报告失败', e);
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1400);
  }
}

// -------- 生成并下载 PDF --------
async function downloadPdf() {
  if (!currentReport) return;
  const btn = $('#downloadPdf');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在生成 PDF…';

  try {
    // 走共享模块,保证和"完整报告"页的 PDF 完全一致
    const blob = await window.JudgePdfBuilder.renderPdf(currentReport);
    const url = URL.createObjectURL(blob);
    const tsSafe = currentReport.meta.generatedAt.replace(/[:.]/g, '-');
    await chrome.downloads.download({ url, filename: `judge-report-${tsSafe}.pdf`, saveAs: false });
    btn.textContent = '已下载 ✓';
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    console.error('PDF 生成失败', e);
    btn.textContent = '生成失败';
    alert('PDF 生成失败:' + (e && e.message || e));
  } finally {
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
  }
}

// buildFullPdf 已移到 pdf-report.js (JudgePdfBuilder),popup 和 report 共用

function vitalVerdict(name, value) {
  if (value == null) return '—';
  const rate = rateVital(name, value);
  return { good: '✅ 正常', warn: '⚠️ 稍慢', bad: '❌ 太慢' }[rate] || '—';
}
function clsVerdict(value) {
  if (value == null) return '—';
  if (value <= 0.1) return '✅ 稳定';
  if (value <= 0.25) return '⚠️ 偶有跳动';
  return '❌ 频繁跳动';
}

// -------- 流程 --------

function renderAlertPill(badge) {
  const pill = $('#alertPill');
  if (!badge || !badge.count) { pill.classList.remove('show', 'warn'); return; }
  const hasJsErr = (badge.kinds || []).includes('js-error');
  pill.classList.add('show');
  pill.classList.toggle('warn', !hasJsErr);
  $('#alertText').textContent = hasJsErr
    ? `自上次查看以来发现 ${badge.count} 次异常(含 JS 错误)`
    : `自上次查看以来发现 ${badge.count} 次接口异常`;
}

function renderTrace(trace) {
  if (!trace || !trace.length) {
    $('#traceCard').style.display = 'none';
    return;
  }
  $('#traceCard').style.display = '';
  // 取最近 10 条
  const recent = trace.slice(-10).reverse();
  const startTs = recent.length ? recent[recent.length - 1].t : Date.now();
  const KIND_LABEL = { click: 'CLK', input: 'INP', nav: 'NAV', visibility: 'VIS' };
  $('#traceList').innerHTML = recent.map((e) => {
    const dt = ((e.t - startTs) / 1000).toFixed(1);
    const kindCls = e.kind || 'visibility';
    let what = '';
    if (e.kind === 'click') {
      const t = e.target || {};
      what = `点 ${t.tag || '元素'}${t.id ? '#' + t.id : ''}${t.text ? ` "${t.text}"` : ''}`;
    } else if (e.kind === 'input') {
      const t = e.target || {};
      what = `在 ${t.tag || '字段'}${t.id ? '#' + t.id : ''} 输入了 ${e.length || 0} 字符`;
    } else if (e.kind === 'nav') {
      try { what = `跳转 → ${new URL(e.url).pathname}`; } catch (_) { what = `跳转 → ${e.url}`; }
    } else if (e.kind === 'visibility') {
      what = `页面 ${e.state === 'visible' ? '回到前台' : '切到后台'}`;
    }
    return `<div class="trace-row">
      <span class="ts">+${dt}s</span>
      <span class="kind ${kindCls}">${KIND_LABEL[kindCls] || kindCls.toUpperCase()}</span>
      <span class="what">${escHtml(what)}</span>
    </div>`;
  }).join('');
}

async function init(opts) {
  const r = await fetchReport(opts || {});
  if (!r) return;
  currentReport = r;

  // B 档:先拿一次徽章状态再 reset(展示给用户后归零)
  try {
    const badge = await chrome.runtime.sendMessage({ type: 'JUDGE_GET_BADGE' });
    renderAlertPill(badge);
  } catch (_) {}
  try { chrome.runtime.sendMessage({ type: 'JUDGE_RESET_BADGE' }); } catch (_) {}

  renderFrameInfo(r.meta);
  renderNetwork(r.network);
  renderDomainPings(r.network);
  renderVitals(r.vitals, r.navigation);
  renderOverview(r.summary, r.meta);
  renderSlowList(r.summary);
  renderTrace(r.trace);
  renderWarnings(r.suggestions);
}

async function runActiveProbe() {
  const btn = $('#probeBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '探测中…';
  try {
    await init({ withActiveProbe: true, probeSampleCount: 6 });
    btn.textContent = '已刷新';
  } catch (_) {
    btn.textContent = '失败';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1400);
}

async function runDomainProbes() {
  const btn = $('#probeDomainsBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '逐域探测中…';
  try {
    await init({ probeAllDomains: true });
    btn.textContent = '已刷新';
  } catch (_) {
    btn.textContent = '失败';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1400);
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  // 提前预热公网 IP 查询(走共享模块的缓存),点 PDF 按钮时不等
  window.JudgePdfBuilder.fetchPublicIp().catch(() => {});
  $('#refresh').addEventListener('click', () => init());
  $('#copySummary').addEventListener('click', copySummary);
  $('#downloadPdf').addEventListener('click', downloadPdf);
  $('#openReport').addEventListener('click', openReport);
  $('#probeBtn').addEventListener('click', runActiveProbe);
  $('#probeDomainsBtn').addEventListener('click', runDomainProbes);
});
