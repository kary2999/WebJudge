// pdf-report.js
// 共享的"把 Judge 报告 → PDF"业务逻辑。供 popup.js 和 report.js 复用,
// 这样两边点击"下载 PDF 报告"产出的 PDF 完全一致。
//
// 依赖:pdf.js (PdfRenderer class)
// 暴露:window.JudgePdfBuilder = {
//   scoreNetwork, buildFullPdf, fetchPublicIp, renderPdf,
//   VITAL_LABELS, VITAL_THRESHOLDS, rateVital, reasonLabel, fmtMs, fmtSec,
// }
//
// 核心:renderPdf(report) → Promise<Blob>  —— 一行搞定,调用方只管下载

(function (global) {
  'use strict';

  const VITAL_THRESHOLDS = {
    LCP:  [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25],
    INP:  [200, 500],   TTFB: [800, 1800],
  };

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

  // ---------- 网络评分 ----------
  function scoreNetwork(net) {
    if (!net) return { score: null, emoji: '❓', label: '未知', reasons: ['无网络数据'] };
    let score = 100;
    const reasons = [];
    const br = net.browserReported || {};
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

  // ---------- IP 水印(公网 IP) ----------
  let _cachedIp = null;
  async function fetchPublicIp() {
    if (_cachedIp) return _cachedIp;
    const sources = [
      { url: 'https://api.ipify.org?format=json', pick: (j) => j.ip },
      { url: 'https://ipinfo.io/json',             pick: (j) => j.ip },
      { url: 'https://ifconfig.co/json',           pick: (j) => j.ip },
    ];
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
    const promises = sources.map(async (s) => {
      const r = await Promise.race([fetch(s.url, { cache: 'no-store' }), timeout(2500)]);
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      const ip = s.pick(j);
      if (!ip) throw new Error('no ip');
      return ip;
    });
    try { _cachedIp = await Promise.any(promises); }
    catch (_) { _cachedIp = '—'; }
    return _cachedIp;
  }

  // ---------- 完整 PDF 组装 ----------
  async function buildFullPdf(pdf, r) {
    const s = r._netScore || scoreNetwork(r.network);

    // 封面
    pdf.h1('Judge 页面性能体检报告');
    pdf.p(r.meta.title || '(无标题)', { size: 11, color: '#57606a' });
    pdf.spacer(2);
    pdf.p(r.meta.url, { size: 9, mono: true, color: '#0550ae' });
    pdf.spacer(6);
    pdf.kv([
      ['采样时间', r.meta.generatedAt],
      ['UA', (r.meta.userAgent || '').slice(0, 90)],
      ['视口', r.meta.viewport ? `${r.meta.viewport.w}×${r.meta.viewport.h} @ ${r.meta.viewport.dpr}x` : '—'],
      ['捕获响应体', `${r.meta.capturedApiCount} 个`],
    ]);

    // 网络评分(去 emoji,改用文字等级 + 评分)
    pdf.spacer(8);
    pdf.h2(`用户网络环境  ${s.score} / 100  · ${s.label}`,
           { color: s.score >= 80 ? '#047857' : s.score < 50 ? '#B91C1C' : '#B45309' });
    if (s.reasons.length > 0) {
      pdf.p('评分依据:' + s.reasons.slice(0, 6).join(' · '), { size: 10, color: '#57606a' });
      pdf.spacer(2);
    } else {
      pdf.muted('未发现明显问题。');
    }
    const net = r.network || {};
    const br = net.browserReported || {};
    const m = net.measured || {};
    const probe = net.activeProbe || {};
    pdf.kv([
      ['浏览器类型判定', br.effectiveType || '—'],
      ['估算下行', br.downlinkMbps != null ? `${br.downlinkMbps} Mbps` : '—'],
      ['估算 RTT', br.rttMs != null ? `${br.rttMs} ms` : '—'],
      ['省流量模式', br.saveData ? '开' : '关'],
      ['实测下载 p50', m.downloadThroughputMbps && m.downloadThroughputMbps.p50 != null ? `${m.downloadThroughputMbps.p50.toFixed(2)} Mbps` : '—'],
      ['实测 DNS p50', m.dnsMs && m.dnsMs.p50 != null ? `${Math.round(m.dnsMs.p50)} ms` : '—'],
      ['静态 TTFB p50', m.ttfbStaticMs && m.ttfbStaticMs.p50 != null ? `${Math.round(m.ttfbStaticMs.p50)} ms` : '—'],
      ['探测 RTT p50', probe.p50 != null ? `${Math.round(probe.p50)} ms` : '—'],
    ]);

    // 体验指标(白话 Web Vitals)— 去 emoji,verdict 改纯文字
    pdf.spacer(4);
    pdf.h2('页面体验指标 (用户感知)');
    const v = r.vitals;
    const verdictPlain = (name, value) => {
      if (value == null) return '—';
      const r2 = (value <= 0 ? 'unknown' : require_safe_rate(name, value));
      return { good: '正常', warn: '稍慢', bad: '太慢' }[r2] || '—';
    };
    function require_safe_rate(name, value) {
      const t = { LCP: [2500, 4000], FCP: [1800, 3000], CLS: [0.1, 0.25], INP: [200, 500], TTFB: [800, 1800] }[name];
      if (!t) return 'unknown';
      if (value <= t[0]) return 'good';
      if (value <= t[1]) return 'warn';
      return 'bad';
    }
    const clsPlain = (v) => v == null ? '—' : v <= 0.1 ? '稳定' : v <= 0.25 ? '偶有跳动' : '频繁跳动';
    const vitalRows = [
      ['首屏主内容出现', v.LCP ? fmtSec(v.LCP.value) : '—', verdictPlain('LCP', v.LCP ? v.LCP.value : null), '用户从点开到看到主要内容'],
      ['页面开始出内容', v.FCP ? fmtSec(v.FCP.value) : '—', verdictPlain('FCP', v.FCP ? v.FCP.value : null), '浏览器第一次画出东西'],
      ['页面抖动',       v.CLS != null ? v.CLS.toFixed(2) : '—', clsPlain(v.CLS), '排版错位导致的用户体验代价'],
      ['点击响应速度',   v.INP ? fmtMs(v.INP.value) : '—', verdictPlain('INP', v.INP ? v.INP.value : null), '点按钮到界面真正响应'],
      ['服务器响应速度', r.navigation ? fmtMs(r.navigation.ttfb) : '—', verdictPlain('TTFB', r.navigation ? r.navigation.ttfb : null), '第一字节到达的时间'],
      ['主线程卡顿',    `${v.longTasks.length} 次`,
          v.longTasks.length === 0 ? '流畅' : v.longTasks.length > 5 ? '明显卡顿' : '偶有卡顿',
          '超过 50ms 的 JS 长任务次数'],
    ];
    pdf.table(['指标', '当前值', '评价', '说明'], vitalRows, [0.28, 0.16, 0.16, 0.40]);

    // 概览
    pdf.h2('请求概览');
    const sm = r.summary;
    const bc = sm.byCategory;
    pdf.kv([
      ['请求总数', sm.totalRequests],
      ['传输体积', `${sm.totalTransferKB} KB`],
      ['前端静态', `${bc['frontend-static'].count} 个 / ${Math.round(bc['frontend-static'].transfer / 1024)} KB`],
      ['后端接口', `${bc['backend-api'].count} 个 / ${Math.round(bc['backend-api'].transfer / 1024)} KB`],
      ['涉及域名', Object.keys(sm.byOrigin).length],
      ['重复请求', (sm.duplicates || []).length],
      ['慢接口 (>1s)', sm.slowApis.length],
      ['HTTP 异常', sm.failedApis.length],
      ['业务层失败', (sm.bizFailedApis || []).length],
      ['浏览器排队', sm.queued.length],
      ['runtime 失配', sm.runtimeMismatches.length],
      ['大资源 (≥300KB)', sm.bigResources.length],
    ]);

    // 优化建议
    if (r.suggestions && r.suggestions.length > 0) {
      pdf.h2('优化建议', { color: '#B45309' });
      for (const sg of r.suggestions) {
        pdf.p(`• ${sg.title}`, { size: 11, color: sg.level === 'error' ? '#cf222e' : '#1f2328' });
        pdf.p('  ' + sg.detail, { size: 9.5, color: '#57606a' });
        pdf.spacer(2);
      }
    }

    // v0.10.0: JS 异常区(优先于业务失败,因为白屏类问题更严重)
    if (r.errors && r.errors.length > 0) {
      pdf.h2(`JS 异常 (${r.errors.length})`, { color: '#B91C1C' });
      pdf.p('页面里抛出的未捕获 JS 异常。"页面白了"、"按钮没反应"通常源于此。', { size: 9.5, color: '#57606a' });
      pdf.spacer(4);
      const rows = r.errors.slice(0, 20).map((e) => {
        const type = ({ error: 'JS', unhandledrejection: 'Promise', resource: 'Resource' })[e.type] || (e.type || 'Error');
        const where = e.filename ? `${e.filename}:${e.lineno || 0}` : (e.url || '—');
        return [type, (e.message || '').slice(0, 80), where];
      });
      pdf.table(['类型', '错误信息', '来源'], rows, [0.1, 0.55, 0.35]);
    }

    // v0.10.0: 操作轨迹(同事忘了自己点了什么时,这里能找到)
    if (r.trace && r.trace.length > 0) {
      pdf.h2(`用户操作轨迹 (${r.trace.length})`);
      pdf.p('最近 30 个用户行为(点击 / 输入 / 跳转)。input 不抓 value,只记长度,密码框不记。', { size: 9.5, color: '#57606a' });
      pdf.spacer(4);
      const startTs = r.trace[0].t || 0;
      const rows = r.trace.slice(-30).map((e) => {
        const dt = ((e.t - startTs) / 1000).toFixed(2) + 's';
        const t = e.target || {};
        let what = '';
        if (e.kind === 'click') what = `点击 ${t.selector || t.tag || ''}${t.text ? ' "' + t.text + '"' : ''}`;
        else if (e.kind === 'input') what = `输入 → ${t.selector || t.tag || ''} (${e.length || 0} 字符)`;
        else if (e.kind === 'nav') what = `跳转 (${e.via || ''}) → ${e.url || ''}`;
        else if (e.kind === 'visibility') what = `页面 ${e.state === 'visible' ? '前台' : '后台'}`;
        return [dt, (e.kind || '').toUpperCase(), what.slice(0, 100)];
      });
      pdf.table(['时间', '类型', '操作'], rows, [0.12, 0.10, 0.78]);
    }

    // 业务层失败(展开完整详情 + JSON 响应体)
    const bizFailed = sm.bizFailedApis || [];
    pdf.h2(`业务层失败 (${bizFailed.length})  — HTTP 200 但 biz.status ≠ 0`, { color: '#B91C1C' });
    pdf.p('这类问题最容易漏报:HTTP 监控看起来一切正常,但业务逻辑其实挂了。下面逐个列出完整请求信息和响应体。',
          { size: 9.5, color: '#57606a' });
    pdf.spacer(6);
    if (bizFailed.length === 0) {
      pdf.muted('(没有业务层失败的接口)');
      pdf.spacer(6);
    } else {
      bizFailed.forEach((row, idx) => {
        pdf.p(`#${idx + 1}`, { size: 10, color: '#8c959f' });
        pdf.apiDetail(row);
      });
    }

    // HTTP 状态异常 — 展开完整详情(含响应体),和业务失败一致风格
    if (sm.failedApis.length > 0) {
      pdf.h2(`HTTP 状态异常 (${sm.failedApis.length})  — status ≠ 2xx`, { color: '#B91C1C' });
      pdf.p('HTTP 协议层失败的接口,通常是 4xx/5xx 服务端错误或网络中断。', { size: 9.5, color: '#57606a' });
      pdf.spacer(6);
      sm.failedApis.forEach((row, idx) => {
        pdf.p(`#${idx + 1}`, { size: 10, color: '#8c959f' });
        pdf.apiDetail(row);
      });
    }

    if (sm.slowApis.length > 0) {
      pdf.h2(`慢接口 (${sm.slowApis.length}) > 1s`, { color: '#B45309' });
      pdf.table(
        ['#', '方法', 'URL', '实测', '后端 runtime', 'Δ', 'TTFB', '下载', '并发', '原因'],
        sm.slowApis.map((r, i) => [
          i + 1, (r.method || '').toUpperCase(), r.path || r.url,
          Math.round(r.duration) + 'ms',
          r.serverReportedRuntimeMs != null ? Math.round(r.serverReportedRuntimeMs) + 'ms' : '—',
          r.runtimeDelta != null ? (r.runtimeDelta > 0 ? '+' : '') + Math.round(r.runtimeDelta) + 'ms' : '—',
          Math.round(r.serverTime) + 'ms',
          Math.round(r.downloadTime) + 'ms',
          r.concurrentAtStart, reasonLabel(r.slowReason),
        ]),
        [0.03, 0.06, 0.30, 0.08, 0.09, 0.07, 0.07, 0.07, 0.05, 0.18]
      );
    }

    // runtime 失配 — 展开完整详情,Δ 是关键证据
    if (sm.runtimeMismatches.length > 0) {
      pdf.h2(`runtime 失配接口 (${sm.runtimeMismatches.length})  — 后端自报快 / 前端实测慢`, { color: '#B45309' });
      pdf.p('后端 extend.runtime 标记很快,但浏览器实测慢。差值来自网络传输 / 前端处理 / 浏览器排队 — 不是后端的锅。',
            { size: 9.5, color: '#57606a' });
      pdf.spacer(6);
      sm.runtimeMismatches.forEach((row, idx) => {
        pdf.p(`#${idx + 1}`, { size: 10, color: '#8c959f' });
        pdf.apiDetail(row);
      });
    }

    if (sm.queued.length > 0) {
      pdf.h2(`被浏览器排队的请求 (${sm.queued.length})`);
      pdf.p('Chrome 对同域(HTTP/1.1)最多 6 个并发,超出自动排队。这不是后端慢。',
            { size: 9.5, color: '#57606a' });
      pdf.spacer(2);
      pdf.table(
        ['URL', '耗时', '队列等待', '同源并发@start'],
        sm.queued.map((r) => [
          r.path || r.url, Math.round(r.duration) + 'ms',
          Math.round(r.queueTime) + 'ms', r.concurrentAtStart,
        ]),
        [0.58, 0.14, 0.14, 0.14]
      );
    }

    if ((sm.duplicates || []).length > 0) {
      pdf.h2(`重复请求 URL (${sm.duplicates.length})`);
      pdf.table(
        ['URL', '次数'],
        sm.duplicates.slice().sort((a, b) => b.count - a.count).map((r) => [r.url, r.count]),
        [0.88, 0.12]
      );
    }

    if (sm.bigResources.length > 0) {
      pdf.h2(`大资源 (${sm.bigResources.length}) ≥ 300KB`);
      pdf.table(
        ['URL', '类型', '传输', '解码后'],
        sm.bigResources.map((r) => [
          r.url, r.initiator || '—',
          Math.round((r.transferSize || 0) / 1024) + ' KB',
          Math.round((r.decodedBodySize || 0) / 1024) + ' KB',
        ]),
        [0.58, 0.10, 0.16, 0.16]
      );
    }
  }

  // 顶层入口:renderPdf(report) → Promise<Blob>
  async function renderPdf(report) {
    const ip = await fetchPublicIp();
    const pdf = new global.PdfRenderer({ watermark: ip });
    await buildFullPdf(pdf, report);
    return pdf.finalize(0.82);
  }

  global.JudgePdfBuilder = {
    scoreNetwork, buildFullPdf, fetchPublicIp, renderPdf,
    VITAL_LABELS, VITAL_THRESHOLDS, rateVital, reasonLabel, fmtMs, fmtSec,
    vitalVerdict, clsVerdict,
  };
})(window);
