// report.js - renders the full report. Loads payload stashed by background.js.

const $ = (s) => document.querySelector(s);

const VITAL_THRESHOLDS = {
  LCP: [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25],
  INP: [200, 500], TTFB: [800, 1800],
};

// Keep global reference to the rendered report so modal can look up rows.
let REPORT = null;
/** @type {Map<string, object>} key -> api row */
const ROW_BY_KEY = new Map();

function rateVital(name, value) {
  if (value == null) return 'unknown';
  const t = VITAL_THRESHOLDS[name];
  if (!t) return 'unknown';
  if (value <= t[0]) return 'good';
  if (value <= t[1]) return 'warn';
  return 'bad';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtMs(v) { return v == null ? '—' : `${Math.round(v)} ms`; }
function fmtKB(v) { return `${Math.round(v / 1024)} KB`; }

function reasonLabel(r) {
  return ({
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

function statusClass(s) {
  if (s == null) return '';
  if (s >= 200 && s < 300) return 'status-ok';
  if (s >= 300 && s < 400) return 'status-redir';
  return 'status-bad';
}

const BIZ_SUCCESS_VALUES = new Set([0, '0', 1, '1', 200, '200', true, 'ok', 'OK', 'success', 'SUCCESS', 'succ', 'true']);
function isBizOk(biz) {
  if (!biz) return null;
  const s = biz.status;
  if (s == null) return null;
  if (BIZ_SUCCESS_VALUES.has(s)) return true;
  if (typeof s === 'string' && /^(ok|success|true|succ)$/i.test(s)) return true;
  return false;
}

function rowKey(row) {
  // Stable key combining URL + startTime (ms rounded)
  return `${row.url}#${Math.round(row.startTime)}`;
}

function indexRow(row) {
  const k = rowKey(row);
  ROW_BY_KEY.set(k, row);
  return k;
}

// loadReport —— 从 chrome.storage.local 取 payload。
// v0.8.1 修复 "点 4-5 次才成功" 的竞态:
//   新 background 先写 storage 再开 tab,并把 key 塞进 URL hash。
//   这里优先走 hash 路径,确保一到就能读到。
//   保留旧的 tab-id 兜底 + 重试循环,应对极端慢存储 / 旧版 background。
async function readByKey(key) {
  const data = await chrome.storage.local.get(key);
  if (data && data[key]) {
    chrome.storage.local.remove(key).catch(() => {});
    return data[key];
  }
  return null;
}

async function loadReport() {
  const hashKey = (location.hash || '').replace(/^#/, '').trim();

  // Primary path: key from URL hash (v0.8.1+ background)
  if (hashKey) {
    const r = await readByKey(hashKey);
    if (r) return r;
  }

  // Fallback path: tab-id based key (legacy background)
  const tabId = await getOwnTabId();
  if (tabId != null) {
    const r = await readByKey(`report_${tabId}`);
    if (r) return r;
  }

  // Belt-and-suspenders: storage may be committing — retry hash key a few times.
  if (hashKey) {
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 150));
      const r = await readByKey(hashKey);
      if (r) return r;
    }
  }

  return null;
}

function getOwnTabId() {
  return new Promise((resolve) => {
    chrome.tabs.getCurrent((tab) => resolve(tab ? tab.id : null));
  });
}

function renderMeta(m) {
  const html = `
    <div>URL: <code>${esc(m.url)}</code></div>
    <div>标题: ${esc(m.title)}</div>
    <div>采样时间: ${esc(m.generatedAt)} · 捕获响应体: ${m.capturedApiCount} 个</div>
  `;
  $('#metaLine').innerHTML = html;
  $('#printMetaLine').innerHTML = html;

  const conn = m.connection, mem = m.memory;
  const rows = [
    ['User-Agent', m.userAgent],
    ['视口', `${m.viewport.w}×${m.viewport.h} @ ${m.viewport.dpr}x`],
    ['网络类型', conn ? conn.effectiveType : '—'],
    ['RTT', conn ? `${conn.rtt} ms` : '—'],
    ['下行带宽', conn ? `${conn.downlink} Mbps` : '—'],
    ['Save Data', conn ? (conn.saveData ? '开' : '关') : '—'],
    ['JS 堆使用', mem ? `${mem.usedJSHeapMB} / ${mem.totalJSHeapMB} MB` : '—'],
    ['JS 堆上限', mem ? `${mem.jsHeapSizeLimitMB} MB` : '—'],
  ];
  $('#env').innerHTML = rows.map(([k, v]) =>
    `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
}

function renderNetwork(n) {
  if (!n) {
    $('#networkSection').style.display = 'none';
    return;
  }
  const rating = n.rating || 'good';
  const ratingLabel = { excellent: 'EXCELLENT', good: 'GOOD', fair: 'FAIR', poor: 'POOR' }[rating] || rating.toUpperCase();
  $('#netRating').innerHTML = `<span class="net-rating ${rating}">${ratingLabel}</span>`;
  $('#netReasons').textContent = (n.ratingReasons || []).join(' · ') || '无明显问题';

  const br = n.browserReported;
  if (br) {
    $('#netBrowser').innerHTML = [
      ['Effective Type', br.effectiveType || '—'],
      ['估算下行', br.downlinkMbps != null ? `${br.downlinkMbps} Mbps` : '—'],
      ['估算 RTT', br.rttMs != null ? `${br.rttMs} ms` : '—'],
      ['连接类型', br.type || '未知'],
      ['省流量模式', br.saveData ? '开' : '关'],
    ].map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  } else {
    $('#netBrowser').innerHTML = '<div class="muted">navigator.connection 不可用</div>';
  }

  const m = n.measured || {};
  const fmtStat = (s, unit, fn) => {
    if (!s || s.p50 == null) return '—';
    fn = fn || ((v) => Math.round(v));
    return `p50: ${fn(s.p50)}${unit} · p95: ${fn(s.p95)}${unit} · avg: ${fn(s.avg)}${unit} (n=${s.samples})`;
  };
  $('#netMeasured').innerHTML = [
    ['下载速率', m.downloadThroughputMbps ? fmtStat(m.downloadThroughputMbps, ' Mbps', (v) => v.toFixed(2)) : '—'],
    ['DNS 解析', fmtStat(m.dnsMs, ' ms')],
    ['TCP 连接', fmtStat(m.tcpMs, ' ms')],
    ['SSL 握手', fmtStat(m.sslMs, ' ms')],
    ['静态资源 TTFB', fmtStat(m.ttfbStaticMs, ' ms')],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');

  if (n.activeProbe && n.activeProbe.p50 != null) {
    $('#netProbeTitle').style.display = '';
    const p = n.activeProbe;
    $('#netProbe').innerHTML = [
      ['探测目标', p.target],
      ['成功/请求', `${p.successCount} / ${p.requested}`],
      ['p50', `${Math.round(p.p50)} ms`],
      ['p95', `${Math.round(p.p95)} ms`],
      ['最小', `${Math.round(p.min)} ms`],
      ['最大', `${Math.round(p.max)} ms`],
      ['平均', `${Math.round(p.avg)} ms`],
      ['抖动 (max-min)', `${Math.round(p.jitter)} ms`],
    ].map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  } else {
    $('#netProbeTitle').style.display = 'none';
    $('#netProbe').innerHTML = '';
  }

  const rows = (n.byOrigin || []).map((o) => `<tr>
    <td>${esc(o.origin)}</td>
    <td class="num">${o.count}</td>
    <td class="num">${o.dnsP50 != null ? Math.round(o.dnsP50) : '—'}</td>
    <td class="num">${o.tcpP50 != null ? Math.round(o.tcpP50) : '—'}</td>
    <td class="num">${o.sslP50 != null ? Math.round(o.sslP50) : '—'}</td>
    <td class="num">${o.ttfbP50 != null ? Math.round(o.ttfbP50) : '—'}</td>
    <td class="num">${o.throughputP50 != null ? o.throughputP50.toFixed(2) + ' Mbps' : '—'}</td>
  </tr>`).join('');
  $('#netOriginTable tbody').innerHTML = rows || '<tr><td colspan="7" class="muted">—</td></tr>';
}

function renderVitals(v, nav) {
  const ttfb = nav ? nav.ttfb : null;
  const items = [
    { name: 'LCP', value: v.LCP ? v.LCP.value : null },
    { name: 'FCP', value: v.FCP ? v.FCP.value : null },
    { name: 'CLS', value: v.CLS },
    { name: 'INP', value: v.INP ? v.INP.value : null },
    { name: 'TTFB', value: ttfb },
    { name: 'LongTasks', value: v.longTasks.length, unit: '个' },
  ];
  $('#vitals').innerHTML = items.map((it) => {
    const rate = it.name === 'LongTasks'
      ? (it.value === 0 ? 'good' : it.value > 5 ? 'bad' : 'warn')
      : rateVital(it.name, it.value);
    let display;
    if (it.value == null) display = '—';
    else if (it.name === 'CLS') display = it.value.toFixed(3);
    else if (it.unit) display = `${it.value} ${it.unit}`;
    else display = fmtMs(it.value);
    return `<div class="vital ${rate}"><div class="label">${it.name}</div><div class="value">${display}</div></div>`;
  }).join('');

  $('#ltCount').textContent = v.longTasks.length;
  $('#longTasks').innerHTML = v.longTasks.length === 0
    ? '<div class="muted">无</div>'
    : v.longTasks.map((t, i) =>
        `<div>#${i + 1} @ ${Math.round(t.startTime)}ms  持续 ${Math.round(t.duration)}ms</div>`).join('');
}

function renderSuggestions(list) {
  if (!list || list.length === 0) {
    $('#suggestions').innerHTML = '<div class="muted">暂无明显问题 ✨</div>';
    return;
  }
  $('#suggestions').innerHTML = list.map((s) =>
    `<div class="sug ${esc(s.level)}"><div class="t">${esc(s.title)}</div><div class="d">${esc(s.detail)}</div></div>`).join('');
}

function renderOverview(s) {
  const originCount = Object.keys(s.byOrigin).length;
  $('#overview').innerHTML = [
    ['请求总数', s.totalRequests],
    ['传输体积', `${s.totalTransferKB} KB`],
    ['解码后体积', `${s.totalDecodedKB} KB`],
    ['涉及域名', originCount],
    ['慢接口 (>1s)', s.slowApis.length],
    ['HTTP 异常', s.failedApis.length],
    ['业务层失败', (s.bizFailedApis || []).length],
    ['URL 不一致', (s.inconsistentGroups || []).length],
    ['浏览器排队', s.queued.length],
    ['runtime 失配', s.runtimeMismatches.length],
    ['大资源 (≥300KB)', s.bigResources.length],
  ].map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');

  const catLabels = {
    'frontend-static': '前端静态 (JS/CSS/图片/字体)',
    'backend-api': '后端接口 (fetch/XHR)',
    'navigation': '主文档',
    'iframe': 'iframe',
    'other': '其他',
  };
  const catRows = Object.entries(s.byCategory)
    .filter(([_, v]) => v.count > 0)
    .sort((a, b) => b[1].totalDuration - a[1].totalDuration)
    .map(([k, v]) =>
      `<tr><td>${esc(catLabels[k] || k)}</td><td class="num">${v.count}</td><td class="num">${fmtKB(v.transfer)}</td><td class="num">${Math.round(v.totalDuration)} ms</td></tr>`)
    .join('');
  $('#catTable tbody').innerHTML = catRows;

  const typeRows = Object.entries(s.byType)
    .sort((a, b) => b[1].transfer - a[1].transfer)
    .map(([t, v]) => `<tr><td>${esc(t)}</td><td class="num">${v.count}</td><td class="num">${fmtKB(v.transfer)}</td></tr>`)
    .join('');
  $('#typeTable tbody').innerHTML = typeRows || '<tr><td colspan="3" class="muted">无</td></tr>';

  const originRows = Object.entries(s.byOrigin)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([o, n]) => `<tr><td>${esc(o)}</td><td class="num">${n}</td></tr>`).join('');
  $('#originTable tbody').innerHTML = originRows;
}

function renderApiTable(tbodySel, rows, emptyColspan) {
  if (rows.length === 0) {
    $(tbodySel + ' tbody').innerHTML = `<tr><td colspan="${emptyColspan}" class="muted">无</td></tr>`;
    return;
  }
  $(tbodySel + ' tbody').innerHTML = rows.map((r) => {
    const key = indexRow(r);
    const ext = r.extend || {};
    const bizStatus = r.biz && r.biz.status != null ? r.biz.status : '—';
    const bizOk = isBizOk(r.biz);
    const bizCls = bizOk === false ? 'status-bad' : bizOk === true ? 'status-ok' : 'mixed';
    return `<tr class="clickable" data-key="${esc(key)}">
      <td>${esc(r.method || '')}</td>
      <td><span class="tag ${statusClass(r.status)}">${r.status ?? '—'}</span></td>
      <td><span class="tag ${bizCls}">${esc(String(bizStatus))}</span></td>
      <td>${esc(r.bizMessage || '')}</td>
      <td class="url" title="${esc(r.url)}">${esc(r.path || r.url)}</td>
      <td class="num">${Math.round(r.duration)} ms</td>
      <td>${esc(ext.runtime || '—')}</td>
      <td><code>${esc(ext.unique || '—')}</code></td>
      <td><button class="detail-btn" data-key="${esc(key)}">详情</button></td>
    </tr>`;
  }).join('');
}

function renderFailed(rows) {
  if (rows.length === 0) {
    $('#failedSection').style.display = 'none';
    return;
  }
  renderApiTable('#failedTable', rows, 9);
}

function renderInconsistent(groups) {
  if (!groups || groups.length === 0) {
    $('#inconsistentSection').style.display = 'none';
    return;
  }
  $('#inconsistentTable tbody').innerHTML = groups.map((g) => {
    // Pick the worst failure as the jump target (any failed call)
    const worstFail = g.calls.find((c) => {
      const httpOk = c.status >= 200 && c.status < 300;
      const bizOk = c.biz ? isBizOk(c.biz) !== false : true;
      return !(httpOk && bizOk);
    });
    const jumpKey = worstFail ? indexRow(worstFail) : '';
    // Also index all calls so they're clickable from print detail pages
    g.calls.forEach(indexRow);

    const httpChips = g.httpStatuses.map((s) => `<span class="tag ${statusClass(s)}">${s}</span>`).join(' ');
    const bizChips = g.bizStatuses.length
      ? g.bizStatuses.map((s) => {
          const ok = isBizOk({ status: s });
          const cls = ok === false ? 'status-bad' : ok === true ? 'status-ok' : 'mixed';
          return `<span class="tag ${cls}">${esc(String(s))}</span>`;
        }).join(' ')
      : '<span class="muted">—</span>';

    return `<tr class="clickable" data-key="${esc(jumpKey)}">
      <td class="url" title="${esc(g.url)}">${esc(g.path || g.url)}</td>
      <td class="num">${g.totalCalls}</td>
      <td class="num">${g.successCount}</td>
      <td class="num delta-bad">${g.failureCount}</td>
      <td>${httpChips}</td>
      <td>${bizChips}</td>
      <td>${worstFail ? `<button class="detail-btn" data-key="${esc(jumpKey)}">查看失败的那一次</button>` : '—'}</td>
    </tr>`;
  }).join('');
}

function renderBizFailed(rows) {
  if (!rows || rows.length === 0) {
    $('#bizFailedSection').style.display = 'none';
    return;
  }
  renderApiTable('#bizFailedTable', rows, 9);
}

function renderSlowTable(rows) {
  if (rows.length === 0) {
    $('#slowTable tbody').innerHTML = '<tr><td colspan="14" class="muted">没有超过 1 秒的接口 🎉</td></tr>';
    return;
  }
  $('#slowTable tbody').innerHTML = rows.map((r, i) => {
    const key = indexRow(r);
    const reason = r.slowReason || 'mixed';
    const serverRt = r.serverReportedRuntimeMs != null ? Math.round(r.serverReportedRuntimeMs) + 'ms' : '—';
    const delta = r.runtimeDelta != null
      ? `<span class="${r.runtimeDelta > 300 ? 'delta-bad' : 'delta-ok'}">${r.runtimeDelta > 0 ? '+' : ''}${Math.round(r.runtimeDelta)}ms</span>`
      : '—';
    const statusCell = r.status != null
      ? `<span class="tag ${statusClass(r.status)}">${r.status}</span>`
      : '—';
    const bizStatus = r.biz && r.biz.status != null ? r.biz.status : '—';
    const bizOk = isBizOk(r.biz);
    const bizCls = bizOk === false ? 'status-bad' : bizOk === true ? 'status-ok' : 'mixed';
    return `<tr class="clickable" data-key="${esc(key)}">
      <td class="num">${i + 1}</td>
      <td>${esc(r.method || r.initiator)}</td>
      <td class="url" title="${esc(r.url)}">${esc(r.path || r.url)}</td>
      <td class="num"><strong>${Math.round(r.duration)} ms</strong></td>
      <td class="num">${serverRt}</td>
      <td class="num">${delta}</td>
      <td class="num">${Math.round(r.queueTime)}</td>
      <td class="num">${Math.round(r.serverTime)}</td>
      <td class="num">${Math.round(r.downloadTime)}</td>
      <td class="num">${r.concurrentAtStart}</td>
      <td>${statusCell}</td>
      <td><span class="tag ${bizCls}">${esc(String(bizStatus))}</span></td>
      <td><span class="tag ${reason}">${esc(reasonLabel(reason))}</span></td>
      <td><button class="detail-btn" data-key="${esc(key)}">详情</button></td>
    </tr>`;
  }).join('');
}

function renderMismatches(rows) {
  if (rows.length === 0) {
    $('#mismatchTable tbody').innerHTML = '<tr><td colspan="6" class="muted">无失配接口</td></tr>';
    return;
  }
  $('#mismatchTable tbody').innerHTML = rows.map((r) => {
    const key = indexRow(r);
    return `<tr class="clickable" data-key="${esc(key)}">
      <td class="url" title="${esc(r.url)}">${esc(r.path || r.url)}</td>
      <td class="num">${Math.round(r.serverReportedRuntimeMs)} ms</td>
      <td class="num">${Math.round(r.duration)} ms</td>
      <td class="num delta-bad">+${Math.round(r.runtimeDelta)} ms</td>
      <td><code>${esc((r.extend && r.extend.unique) || '—')}</code></td>
      <td><button class="detail-btn" data-key="${esc(key)}">详情</button></td>
    </tr>`;
  }).join('');
}

function renderQueued(rows) {
  if (rows.length === 0) {
    $('#queuedTable tbody').innerHTML = '<tr><td colspan="4" class="muted">无排队请求 ✨</td></tr>';
    return;
  }
  $('#queuedTable tbody').innerHTML = rows.map((r) => `<tr>
    <td class="url" title="${esc(r.url)}">${esc(r.url)}</td>
    <td class="num">${Math.round(r.duration)} ms</td>
    <td class="num">${Math.round(r.queueTime)} ms</td>
    <td class="num">${r.concurrentAtStart}</td>
  </tr>`).join('');
}

function renderBig(rows) {
  if (rows.length === 0) {
    $('#bigTable tbody').innerHTML = '<tr><td colspan="4" class="muted">没有超过 300KB 的资源</td></tr>';
    return;
  }
  $('#bigTable tbody').innerHTML = rows.map((r) => `<tr>
    <td class="url" title="${esc(r.url)}">${esc(r.url)}</td>
    <td>${esc(r.initiator)}</td>
    <td class="num">${fmtKB(r.transferSize)}</td>
    <td class="num">${fmtKB(r.decodedBodySize)}</td>
  </tr>`).join('');
}

function renderDup(rows) {
  if (rows.length === 0) {
    $('#dupTable tbody').innerHTML = '<tr><td colspan="2" class="muted">无重复 URL</td></tr>';
    return;
  }
  $('#dupTable tbody').innerHTML = rows.sort((a, b) => b.count - a.count).map((r) => `<tr>
    <td class="url" title="${esc(r.url)}">${esc(r.url)}</td>
    <td class="num">${r.count}</td>
  </tr>`).join('');
}

// -------- Detail modal --------

function tryFormatJson(text) {
  if (!text) return { formatted: '', isJson: false };
  try {
    const trimmed = text.replace(/\.\.\.\[truncated\]$/, '');
    const parsed = JSON.parse(trimmed);
    return { formatted: JSON.stringify(parsed, null, 2), isJson: true, parsed };
  } catch (_) {
    return { formatted: text, isJson: false };
  }
}

function syntaxHighlightJson(json) {
  return esc(json).replace(
    /(&quot;[^&]*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, num) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (bool) return `<span class="${bool === 'null' ? 'j-null' : 'j-bool'}">${bool}</span>`;
      if (num) return `<span class="j-num">${num}</span>`;
      return match;
    }
  );
}

function renderKv(tableSel, rows) {
  $(tableSel).innerHTML = rows
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v == null || v === '' ? '—' : esc(v)}</td></tr>`)
    .join('');
}

function openDetail(key) {
  const row = ROW_BY_KEY.get(key);
  if (!row) return;

  // Header chips
  $('#mMethod').textContent = row.method || row.initiator || '—';
  const statusEl = $('#mStatus');
  if (row.status != null) {
    const sc = statusClass(row.status);
    statusEl.className = 'modal-status' + (sc === 'status-bad' ? ' bad' : sc === 'status-redir' ? ' redir' : '');
    statusEl.textContent = `HTTP ${row.status}${row.statusText ? ' ' + row.statusText : ''}`;
  } else {
    statusEl.className = 'modal-status';
    statusEl.textContent = 'HTTP —';
  }
  const bizEl = $('#mBiz');
  if (row.biz && row.biz.status != null) {
    const ok = isBizOk(row.biz);
    bizEl.className = 'modal-biz' + (ok === false ? ' bad' : ok === true ? ' ok' : '');
    bizEl.textContent = `biz.status=${row.biz.status}${row.bizMessage ? ' · ' + row.bizMessage : ''}`;
  } else {
    bizEl.className = 'modal-biz';
    bizEl.textContent = 'biz.status=—';
  }

  $('#mUrl').textContent = row.url;

  // Timing
  renderKv('#mTiming', [
    ['实测 duration', `${Math.round(row.duration)} ms`],
    ['后端 extend.runtime', row.serverReportedRuntimeMs != null ? `${Math.round(row.serverReportedRuntimeMs)} ms` : '—'],
    ['Δ (前端 - 后端)', row.runtimeDelta != null ? `${row.runtimeDelta > 0 ? '+' : ''}${Math.round(row.runtimeDelta)} ms` : '—'],
    ['浏览器队列 queueTime', `${Math.round(row.queueTime)} ms`],
    ['DNS', `${Math.round(row.dnsTime)} ms`],
    ['TCP', `${Math.round(row.tcpTime)} ms`],
    ['SSL', `${Math.round(row.sslTime)} ms`],
    ['TTFB (serverTime)', `${Math.round(row.serverTime)} ms`],
    ['Download', `${Math.round(row.downloadTime)} ms`],
    ['同源并发@start', row.concurrentAtStart],
  ]);

  // Extend
  renderKv('#mExtend', [
    ['date', (row.extend && row.extend.date) || '—'],
    ['unique', (row.extend && row.extend.unique) || '—'],
    ['runtime', (row.extend && row.extend.runtime) || '—'],
    ['runtime (ms)', (row.extend && row.extend.runtimeMs != null) ? row.extend.runtimeMs : '—'],
  ]);

  // Meta
  renderKv('#mMeta', [
    ['Method', row.method || '—'],
    ['Origin', row.origin || '—'],
    ['Path', row.path || '—'],
    ['Protocol', row.nextHopProtocol || '—'],
    ['Content-Type', row.contentType || '—'],
    ['From Cache', row.fromCache ? '是' : '否'],
    ['Transfer Size', row.transferSize ? fmtKB(row.transferSize) : '—'],
    ['Initiator Type', row.initiator || '—'],
    ['Slow Reason', reasonLabel(row.slowReason) || '—'],
  ]);

  // Biz
  const bizRows = [];
  if (row.biz) {
    bizRows.push(['status (业务)', row.biz.status != null ? String(row.biz.status) : '—']);
    bizRows.push(['message', row.biz.message || '—']);
    bizRows.push(['has data', row.biz.hasData ? '是' : '否']);
    if (row.biz.rootKeys) bizRows.push(['root keys', row.biz.rootKeys.join(', ')]);
  } else {
    bizRows.push(['业务数据', '未识别为 JSON / 无响应体']);
  }
  renderKv('#mBizTable', bizRows);

  // Body
  const { formatted, isJson } = tryFormatJson(row.responseSnippet || '');
  const note = row.bodyTruncated ? ' (超过 64KB 已截断)' : (isJson ? '' : ' (非 JSON 或无法解析)');
  $('#mBodyNote').textContent = note;
  if (isJson) {
    $('#mBody').innerHTML = syntaxHighlightJson(formatted);
  } else {
    $('#mBody').textContent = formatted || '(无响应体)';
  }
  $('#mBody').dataset.raw = row.responseSnippet || '';

  $('#detailMask').hidden = false;
}

function closeDetail() { $('#detailMask').hidden = true; }

async function copyBodyToClipboard() {
  const raw = $('#mBody').dataset.raw || $('#mBody').textContent;
  try {
    await navigator.clipboard.writeText(raw);
    const btn = $('#mCopyBody');
    const orig = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = orig), 1200);
  } catch (_) {
    alert('复制失败');
  }
}

function hookRowClicks() {
  document.body.addEventListener('click', (ev) => {
    // detail button
    const btn = ev.target.closest('.detail-btn');
    if (btn) {
      ev.stopPropagation();
      openDetail(btn.dataset.key);
      return;
    }
    // clickable row
    const tr = ev.target.closest('tr.clickable');
    if (tr && tr.dataset.key) {
      openDetail(tr.dataset.key);
    }
  });
  $('#mClose').addEventListener('click', closeDetail);
  $('#mCopyBody').addEventListener('click', copyBodyToClipboard);
  $('#detailMask').addEventListener('click', (ev) => {
    if (ev.target.id === 'detailMask') closeDetail();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#detailMask').hidden) closeDetail();
  });
}

// -------- Text summary & downloads --------

function buildTextSummary(r) {
  const lines = [];
  lines.push(`【页面性能体检报告 Judge】`);
  lines.push(`URL: ${r.meta.url}`);
  lines.push(`标题: ${r.meta.title}`);
  lines.push(`采样时间: ${r.meta.generatedAt}`);
  lines.push(`UA: ${r.meta.userAgent}`);
  if (r.meta.connection) {
    lines.push(`网络: ${r.meta.connection.effectiveType}, RTT=${r.meta.connection.rtt}ms, 下行=${r.meta.connection.downlink}Mbps`);
  }
  if (r.network) {
    lines.push(`用户网络评级: ${String(r.network.rating || '').toUpperCase()}`);
    if ((r.network.ratingReasons || []).length) {
      lines.push(`原因: ${r.network.ratingReasons.join(' / ')}`);
    }
    const m = r.network.measured;
    if (m) {
      if (m.downloadThroughputMbps && m.downloadThroughputMbps.p50 != null) {
        lines.push(`实测下载中位: ${m.downloadThroughputMbps.p50.toFixed(2)} Mbps (p95: ${m.downloadThroughputMbps.p95.toFixed(2)})`);
      }
      if (m.ttfbStaticMs && m.ttfbStaticMs.p50 != null) {
        lines.push(`静态资源 TTFB 中位: ${Math.round(m.ttfbStaticMs.p50)}ms`);
      }
      if (m.dnsMs && m.dnsMs.p50 != null) {
        lines.push(`DNS 中位: ${Math.round(m.dnsMs.p50)}ms  TCP 中位: ${m.tcpMs && m.tcpMs.p50 != null ? Math.round(m.tcpMs.p50) + 'ms' : '—'}`);
      }
    }
    if (r.network.activeProbe && r.network.activeProbe.p50 != null) {
      const p = r.network.activeProbe;
      lines.push(`主动探测 RTT: p50=${Math.round(p.p50)}ms p95=${Math.round(p.p95)}ms 抖动=${Math.round(p.jitter)}ms`);
    }
  }
  lines.push('');
  lines.push(`--- Web Vitals ---`);
  lines.push(`LCP=${r.vitals.LCP ? Math.round(r.vitals.LCP.value) + 'ms' : '—'}  FCP=${r.vitals.FCP ? Math.round(r.vitals.FCP.value) + 'ms' : '—'}  CLS=${r.vitals.CLS.toFixed(3)}  INP=${r.vitals.INP ? Math.round(r.vitals.INP.value) + 'ms' : '—'}`);
  lines.push(`主线程长任务: ${r.vitals.longTasks.length} 个`);
  lines.push('');
  lines.push(`--- 概览 ---`);
  const bc = r.summary.byCategory;
  lines.push(`总请求 ${r.summary.totalRequests} | 前端静态 ${bc['frontend-static'].count}/${Math.round(bc['frontend-static'].transfer/1024)}KB | 后端接口 ${bc['backend-api'].count}/${Math.round(bc['backend-api'].transfer/1024)}KB`);
  lines.push(`慢 ${r.summary.slowApis.length}, HTTP异常 ${r.summary.failedApis.length}, 业务失败 ${(r.summary.bizFailedApis || []).length}, 排队 ${r.summary.queued.length}, runtime 失配 ${r.summary.runtimeMismatches.length}`);
  lines.push('');
  if (r.summary.failedApis.length > 0) {
    lines.push(`--- HTTP 状态异常接口 ---`);
    r.summary.failedApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [HTTP ${x.status} ${x.statusText || ''}] ${x.method || ''} ${x.url}`);
      if (x.biz) lines.push(`   biz.status=${x.biz.status}  message=${x.biz.message || ''}`);
      if (x.extend) lines.push(`   extend: date=${x.extend.date} unique=${x.extend.unique} runtime=${x.extend.runtime}`);
    });
    lines.push('');
  }
  if ((r.summary.bizFailedApis || []).length > 0) {
    lines.push(`--- 业务层失败接口 (HTTP 200 但 biz.status != 0) ---`);
    r.summary.bizFailedApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [biz.status=${x.biz && x.biz.status}] ${x.method || ''} ${x.url}`);
      lines.push(`   message: ${x.biz && x.biz.message || ''}`);
      if (x.extend) lines.push(`   extend: date=${x.extend.date} unique=${x.extend.unique} runtime=${x.extend.runtime}`);
    });
    lines.push('');
  }
  if (r.summary.slowApis.length > 0) {
    lines.push(`--- Top 10 慢接口 ---`);
    r.summary.slowApis.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. [${Math.round(x.duration)}ms][${reasonLabel(x.slowReason)}] ${x.method || ''} ${x.url}`);
      lines.push(`   queue=${Math.round(x.queueTime)}ms server=${Math.round(x.serverTime)}ms download=${Math.round(x.downloadTime)}ms 同源并发@start=${x.concurrentAtStart}`);
      if (x.biz) lines.push(`   HTTP=${x.status}  biz.status=${x.biz.status}  message=${x.biz.message || ''}`);
      if (x.extend) {
        lines.push(`   extend: date=${x.extend.date} unique=${x.extend.unique} runtime=${x.extend.runtime} (Δ ${Math.round(x.runtimeDelta)}ms)`);
      }
    });
    lines.push('');
  }
  if (r.summary.runtimeMismatches.length > 0) {
    lines.push(`--- runtime 失配 Top 10 ---`);
    r.summary.runtimeMismatches.slice(0, 10).forEach((x, i) => {
      lines.push(`${i + 1}. ${x.path} — 后端 ${Math.round(x.serverReportedRuntimeMs)}ms, 实测 ${Math.round(x.duration)}ms, 差 ${Math.round(x.runtimeDelta)}ms`);
    });
    lines.push('');
  }
  if (r.suggestions.length > 0) {
    lines.push(`--- 建议 ---`);
    r.suggestions.forEach((s, i) => {
      lines.push(`${i + 1}. [${s.level}] ${s.title}`);
      lines.push(`   ${s.detail}`);
    });
  }
  return lines.join('\n');
}

async function copySummary(report) {
  const text = buildTextSummary(report);
  try {
    await navigator.clipboard.writeText(text);
    flash('copyBtn', '已复制');
  } catch (_) { flash('copyBtn', '复制失败'); }
}

function flash(id, text) {
  const btn = document.getElementById(id);
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = orig), 1200);
}

// downloadJson 已移除:统一用 PDF 报告。如需原始 JSON,可从扩展的 manifest 读出。

function buildPrintDetailsHtml(report) {
  const s = report.summary;
  // Include EVERY call from inconsistent groups (so the failed-among-siblings case is covered)
  const inconsistentAllCalls = [];
  for (const g of (s.inconsistentGroups || [])) {
    for (const c of g.calls) inconsistentAllCalls.push(c);
  }
  const sections = [
    { title: 'HTTP 状态异常接口 — 完整详情', rows: s.failedApis },
    { title: '业务层失败接口 — 完整详情', rows: s.bizFailedApis || [] },
    { title: '同 URL 不一致调用 — 每一次调用', rows: inconsistentAllCalls },
    { title: '慢接口 (>1s) — 完整详情', rows: s.slowApis },
    { title: 'runtime 失配接口 — 完整详情', rows: s.runtimeMismatches },
  ].filter((sec) => sec.rows && sec.rows.length > 0);

  if (sections.length === 0) return '';

  const seen = new Set();
  const renderOne = (r) => {
    const key = rowKey(r);
    if (seen.has(key)) return ''; // dedupe across sections
    seen.add(key);
    // Register row so click-to-jump works from tables
    ROW_BY_KEY.set(key, r);

    const httpCls = statusClass(r.status);
    const httpHtml = r.status != null
      ? `<span class="http ${httpCls === 'status-bad' ? 'bad' : httpCls === 'status-redir' ? 'redir' : ''}">HTTP ${r.status}${r.statusText ? ' ' + esc(r.statusText) : ''}</span>`
      : `<span class="http">HTTP —</span>`;

    const bizVal = r.biz && r.biz.status != null ? String(r.biz.status) : '—';
    const bizOk = isBizOk(r.biz);
    const bizCls = bizOk === false ? 'bad' : bizOk === true ? 'ok' : '';
    const bizHtml = `<span class="biz ${bizCls}">biz.status=${esc(bizVal)}</span>`;

    const ext = r.extend || {};
    const extendLine = (ext.date || ext.unique || ext.runtime)
      ? `<div class="extend">extend.date=${esc(ext.date || '—')} · extend.unique=${esc(ext.unique || '—')} · extend.runtime=${esc(ext.runtime || '—')}</div>`
      : '';

    const timing = [
      `<span>总耗时 <b>${Math.round(r.duration)}ms</b></span>`,
      r.serverReportedRuntimeMs != null ? `<span>后端 runtime <b>${Math.round(r.serverReportedRuntimeMs)}ms</b></span>` : '',
      r.runtimeDelta != null ? `<span>Δ <b>${r.runtimeDelta > 0 ? '+' : ''}${Math.round(r.runtimeDelta)}ms</b></span>` : '',
      `<span>队列 ${Math.round(r.queueTime)}ms</span>`,
      `<span>TTFB ${Math.round(r.serverTime)}ms</span>`,
      `<span>下载 ${Math.round(r.downloadTime)}ms</span>`,
      `<span>同源并发@start ${r.concurrentAtStart}</span>`,
      r.slowReason ? `<span>原因: <b>${esc(reasonLabel(r.slowReason))}</b></span>` : '',
      r.bizMessage ? `<span>message: <b>${esc(r.bizMessage)}</b></span>` : '',
    ].filter(Boolean).join('');

    const { formatted, isJson } = tryFormatJson(r.responseSnippet || '');
    const bodyText = isJson ? formatted : (r.responseSnippet || '(无响应体)');
    const bodyNote = r.bodyTruncated ? ' (超过 64KB 已截断)' : (isJson ? '' : ' (非 JSON)');

    const anchorId = 'detail-' + key.replace(/[^a-zA-Z0-9]/g, '_');
    return `<div class="print-api-detail" id="${esc(anchorId)}">
      <div class="head">
        <span class="method">${esc(r.method || r.initiator || '—')}</span>
        ${httpHtml}
        ${bizHtml}
        <span class="title">${esc(r.path || r.url)}</span>
      </div>
      <div class="url">${esc(r.url)}</div>
      <div class="timing">${timing}</div>
      ${extendLine}
      <div class="body-title">响应体${bodyNote}</div>
      <pre class="body">${esc(bodyText)}</pre>
    </div>`;
  };

  return sections.map((sec) => {
    const html = sec.rows.map(renderOne).filter(Boolean).join('');
    if (!html) return '';
    return `<h2 class="print-section">${esc(sec.title)} (${sec.rows.length})</h2>${html}`;
  }).join('');
}

// 直接生成 PDF 并下载(走共享的 JudgePdfBuilder,和弹窗产物完全一致)
async function exportPdf(report) {
  const btn = document.getElementById('pdfBtn');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在生成 PDF…';
  try {
    const blob = await window.JudgePdfBuilder.renderPdf(report);
    const url = URL.createObjectURL(blob);
    const tsSafe = report.meta.generatedAt.replace(/[:.]/g, '-');
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

// v0.10.0: 渲染 JS 异常区
function renderErrors(errors) {
  const sec = $('#errorsSection');
  if (!sec) return;
  if (!errors || errors.length === 0) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  $('#errorsCount').textContent = errors.length;
  $('#errorsList').innerHTML = errors.map((e) => {
    const typeMap = {
      'error': 'JS Error',
      'unhandledrejection': 'Promise',
      'resource': 'Resource',
    };
    const type = typeMap[e.type] || e.type || 'Error';
    const msg = e.message || '';
    const sourceParts = [];
    if (e.filename) sourceParts.push(`${e.filename}:${e.lineno || 0}:${e.colno || 0}`);
    if (e.url && !e.filename) sourceParts.push(e.url);
    if (e.frameUrl) sourceParts.push(`@iframe: ${e.frameUrl}`);
    const stack = e.stack ? `<div class="stack">${esc(e.stack)}</div>` : '';
    return `<div class="error-row">
      <div class="err-head">
        <span class="type">${esc(type)}</span>
        <span class="msg">${esc(msg)}</span>
      </div>
      ${sourceParts.length ? `<div class="source">${esc(sourceParts.join(' · '))}</div>` : ''}
      ${stack}
    </div>`;
  }).join('');
}

// v0.10.0: 渲染操作轨迹时间线
function renderTrace(trace) {
  const sec = $('#traceSection');
  if (!sec) return;
  if (!trace || trace.length === 0) { sec.style.display = 'none'; return; }
  sec.style.display = '';
  $('#traceCount').textContent = trace.length;
  // 最早时刻为 0,后续相对显示
  const startTs = trace[0].t || 0;
  const KIND_LABEL = { click: 'CLK', input: 'INP', nav: 'NAV', visibility: 'VIS' };
  $('#traceTimeline').innerHTML = trace.map((e) => {
    const dt = ((e.t - startTs) / 1000).toFixed(2);
    let what = '';
    if (e.kind === 'click') {
      const t = e.target || {};
      const sel = t.selector || (t.tag || '元素');
      what = `点击 <code>${esc(sel)}</code>${t.text ? ` "${esc(t.text)}"` : ''}`;
    } else if (e.kind === 'input') {
      const t = e.target || {};
      const sel = t.selector || (t.tag || '字段');
      what = `输入 → <code>${esc(sel)}</code> (${e.length || 0} 字符)`;
    } else if (e.kind === 'nav') {
      what = `跳转 (${esc(e.via || '')}) → <code>${esc(e.url || '')}</code>`;
    } else if (e.kind === 'visibility') {
      what = `页面 ${e.state === 'visible' ? '前台' : '后台'}`;
    }
    return `<div class="trace-event">
      <span class="ts">+${dt}s</span>
      <span class="kind ${e.kind || 'visibility'}">${KIND_LABEL[e.kind] || (e.kind || '').toUpperCase()}</span>
      <span class="what">${what}${e.frameUrl ? ` <small style="color:var(--ink-500)">@iframe</small>` : ''}</span>
    </div>`;
  }).join('');
}

(async function main() {
  const report = await loadReport();
  if (!report) {
    document.body.innerHTML =
      '<div style="padding:40px;max-width:640px;margin:40px auto;font-family:-apple-system,sans-serif">' +
      '<h2 style="color:#cf222e;margin:0 0 12px">未能获取报告数据</h2>' +
      '<p style="color:#57606a;line-height:1.6">' +
      '这个页面需要从扩展弹窗里点击 <b>查看完整报告</b> 才能进入。' +
      '直接打开或收藏的 URL 不会带上报告数据(会话一次性,安全考虑)。' +
      '</p>' +
      '<p style="color:#8c959f;font-size:12px">刷新本页 / 重新点击扩展图标 → 查看完整报告 即可。</p>' +
      '</div>';
    return;
  }
  REPORT = report;

  renderMeta(report.meta);
  renderNetwork(report.network);
  renderVitals(report.vitals, report.navigation);
  renderSuggestions(report.suggestions);
  renderOverview(report.summary);
  renderErrors(report.errors || []);
  renderTrace(report.trace || []);
  renderFailed(report.summary.failedApis);
  renderInconsistent(report.summary.inconsistentGroups || []);
  renderBizFailed(report.summary.bizFailedApis || []);
  renderSlowTable(report.summary.slowApis);
  renderMismatches(report.summary.runtimeMismatches);
  renderQueued(report.summary.queued);
  renderBig(report.summary.bigResources);
  renderDup(report.summary.duplicates);

  hookRowClicks();

  // Pre-render the print-only detail section so every PDF export
  // reliably contains the full API details. This runs once at load.
  $('#printDetails').innerHTML = buildPrintDetailsHtml(report);

  $('#copyBtn').addEventListener('click', () => copySummary(report));
  $('#pdfBtn').addEventListener('click', () => exportPdf(report));
})();
