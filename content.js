// content.js — slim version (v0.9.0)
// 跑在每一个 frame(顶层 + 所有 iframe,见 manifest.json all_frames: true)。
//
// 职责只有 3 件:
//   1. (顶层) 启动 Web Vitals 观察者
//   2. 监听 inject.js (MAIN world) 派发的 __PI_API_CAPTURE__ 事件,记下捕获的 fetch/XHR
//   3. 暴露 window.__JUDGE_DUMP_RAW__() 返回本 frame 的原始数据
//
// 所有"分析"(分类、归责、网络评分、生成报告等)都搬到了 analyzer.js,
// 由 popup / report 上下文里调用。这样 content.js 在 iframe 里也只跑必要逻辑,
// 由调度方(popup)用 chrome.scripting.executeScript({ allFrames: true })
// 把所有 frame 的原始数据收回来再合并分析。

(function () {
  if (window.__JUDGE_INSTALLED__) return;
  window.__JUDGE_INSTALLED__ = true;

  const isTop = window === window.top;

  // ---------- Web Vitals ----------
  const vitals = { LCP: null, FCP: null, CLS: 0, INP: null, longTasks: [] };

  function safeObserve(type, cb, opts) {
    try {
      const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) cb(e); });
      po.observe(opts || { type, buffered: true });
      return po;
    } catch (_) { return null; }
  }

  if (isTop) {
    safeObserve('largest-contentful-paint', (e) => {
      vitals.LCP = {
        value: e.startTime,
        element: e.element ? (e.element.tagName + (e.element.id ? '#' + e.element.id : '')) : null,
      };
    });
    safeObserve('paint', (e) => { if (e.name === 'first-contentful-paint') vitals.FCP = { value: e.startTime }; });
    safeObserve('layout-shift', (e) => { if (!e.hadRecentInput) vitals.CLS += e.value; });
    safeObserve('event', (e) => {
      if (e.interactionId) {
        const d = e.duration;
        if (!vitals.INP || d > vitals.INP.value) vitals.INP = { value: d, name: e.name };
      }
    }, { type: 'event', buffered: true, durationThreshold: 40 });
    safeObserve('longtask', (e) => { vitals.longTasks.push({ startTime: e.startTime, duration: e.duration }); });
  }

  // ---------- inject.js (MAIN world) 的 fetch/XHR 捕获事件 ----------
  const captured = [];
  window.addEventListener('__PI_API_CAPTURE__', (e) => {
    try {
      const data = JSON.parse(e.detail);
      captured.push(data);
      // 推送到 background 计数(B 档徽章):API 异常即时上报
      maybeReportAlert(data);
    } catch (_) { /* ignore */ }
  });

  // ---------- B 档:异常计数 + 徽章上报 ----------
  // 在 content.js 端只做"判断这是不是异常 + 发消息",维护计数和角标在 background。
  function isBizFailedFromCapture(c) {
    if (!c.biz || c.biz.status == null) return false;
    if (c.status && !(c.status >= 200 && c.status < 300)) return false; // 已经是 HTTP 异常,不重复算
    const SUCCESS = new Set([0, '0', 1, '1', 200, '200', true, 'ok', 'OK', 'success', 'SUCCESS', 'succ', 'true']);
    if (SUCCESS.has(c.biz.status)) return false;
    if (typeof c.biz.status === 'string' && /^(ok|success|true|succ)$/i.test(c.biz.status)) return false;
    return true;
  }
  function maybeReportAlert(c) {
    if (!c) return;
    const reasons = [];
    if (c.duration != null && c.duration >= 5000) reasons.push('slow-5s');
    if (c.status != null && c.status >= 500) reasons.push('http-5xx');
    if (c.status === 0) reasons.push('network-error');
    if (isBizFailedFromCapture(c)) reasons.push('biz-fail');
    if (reasons.length === 0) return;
    sendAlert({ kind: 'api', reasons, url: c.url, method: c.method, status: c.status, ts: Date.now() });
  }
  function sendAlert(payload) {
    try {
      chrome.runtime.sendMessage({ type: 'JUDGE_ALERT', payload }).catch(() => {});
    } catch (_) { /* extension reload mid-flight */ }
  }

  // ---------- #2 用户操作轨迹 ----------
  // 按 ring-buffer 留最近 30 个事件,推 chrome 报告时一起 dump。
  // 隐私:input 不抓 value,只抓 selector + 长度;不抓密码框
  const TRACE_LIMIT = 30;
  const trace = []; // { t, kind, ... }
  function pushTrace(ev) {
    ev.t = Date.now();
    trace.push(ev);
    if (trace.length > TRACE_LIMIT) trace.shift();
  }
  function selectorOf(el) {
    if (!el || !el.tagName) return null;
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const data = ['data-id', 'data-action', 'data-key'].reduce((acc, k) => {
      const v = el.getAttribute && el.getAttribute(k);
      return v ? acc + `[${k}="${v}"]` : acc;
    }, '');
    const text = (el.innerText || el.value || '').trim().slice(0, 30);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3) : [],
      data: data || null,
      text,
      selector: el.tagName.toLowerCase() + id + cls + data,
    };
  }

  // click — passive,绝对不阻塞用户交互
  document.addEventListener('click', (e) => {
    try {
      const target = e.target.closest('button,a,[role=button],[onclick],input,select,label') || e.target;
      pushTrace({
        kind: 'click',
        target: selectorOf(target),
        x: e.clientX, y: e.clientY,
      });
    } catch (_) {}
  }, true);

  // input — 仅记录"在 X 字段输入了 N 个字符",不抓 value;密码框完全跳过
  let lastInputAt = 0;
  document.addEventListener('input', (e) => {
    try {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return;
      if (el.type === 'password') return; // 密码框不进
      // 节流:1 秒内同字段连续输入只记一次,避免 30 个槽位被打字撑爆
      const now = Date.now();
      const sel = selectorOf(el);
      if (now - lastInputAt < 1000 && trace.length && trace[trace.length - 1].kind === 'input'
          && trace[trace.length - 1].target && trace[trace.length - 1].target.selector === sel.selector) {
        trace[trace.length - 1].t = now;
        trace[trace.length - 1].length = (el.value || '').length;
        return;
      }
      lastInputAt = now;
      pushTrace({
        kind: 'input',
        target: sel,
        length: (el.value || '').length,
      });
    } catch (_) {}
  }, true);

  // SPA 导航(history.pushState / replaceState / popstate)
  function patchHistory(method) {
    const orig = history[method];
    history[method] = function () {
      const ret = orig.apply(this, arguments);
      pushTrace({ kind: 'nav', via: method, url: location.href });
      return ret;
    };
  }
  try { patchHistory('pushState'); patchHistory('replaceState'); } catch (_) {}
  window.addEventListener('popstate', () => pushTrace({ kind: 'nav', via: 'popstate', url: location.href }));
  window.addEventListener('hashchange', () => pushTrace({ kind: 'nav', via: 'hashchange', url: location.href }));

  // 可见性切换(常见的"页面切走/切回")
  document.addEventListener('visibilitychange', () => {
    pushTrace({ kind: 'visibility', state: document.visibilityState });
  });

  // ---------- 顺手:JS 异常捕获(#1) ----------
  // 同事报"白屏"、"按钮没反应",一半以上是 JS 异常导致。我们抓最近 20 个。
  const ERR_LIMIT = 20;
  const errors = [];
  function pushError(e) {
    if (errors.length >= ERR_LIMIT) errors.shift();
    errors.push(Object.assign({ t: Date.now() }, e));
    sendAlert({ kind: 'js-error', message: e.message, ts: Date.now() });
  }
  window.addEventListener('error', (ev) => {
    if (ev.target && ev.target !== window && (ev.target.tagName === 'IMG' || ev.target.tagName === 'SCRIPT' || ev.target.tagName === 'LINK')) {
      pushError({
        type: 'resource',
        message: `${ev.target.tagName} 加载失败`,
        url: ev.target.src || ev.target.href || '',
      });
      return;
    }
    pushError({
      type: 'error',
      message: ev.message || (ev.error && ev.error.message) || 'Unknown error',
      filename: ev.filename || '',
      lineno: ev.lineno, colno: ev.colno,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 2000) : null,
    });
  }, true);
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    pushError({
      type: 'unhandledrejection',
      message: (reason && (reason.message || String(reason))) || 'Unhandled rejection',
      stack: reason && reason.stack ? String(reason.stack).slice(0, 2000) : null,
    });
  });

  // ---------- 资源条目转纯对象(跨 isolated/MAIN 边界要可序列化) ----------
  function plainResource(e) {
    return {
      name: e.name,
      initiatorType: e.initiatorType || '',
      nextHopProtocol: e.nextHopProtocol || '',
      startTime: e.startTime,
      domainLookupStart: e.domainLookupStart,
      domainLookupEnd: e.domainLookupEnd,
      connectStart: e.connectStart,
      connectEnd: e.connectEnd,
      secureConnectionStart: e.secureConnectionStart,
      requestStart: e.requestStart,
      responseStart: e.responseStart,
      responseEnd: e.responseEnd,
      duration: e.duration,
      transferSize: e.transferSize || 0,
      encodedBodySize: e.encodedBodySize || 0,
      decodedBodySize: e.decodedBodySize || 0,
    };
  }

  function navigationSummary() {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav) return null;
    return {
      type: nav.type,
      startTime: nav.startTime,
      duration: nav.duration,
      ttfb: Math.max(0, nav.responseStart - nav.requestStart),
      domContentLoaded: nav.domContentLoadedEventEnd,
      loadEvent: nav.loadEventEnd,
      transferSize: nav.transferSize || 0,
      protocol: nav.nextHopProtocol || '',
    };
  }

  function envInfo() {
    return {
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      connection: navigator.connection ? {
        effectiveType: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt,
        saveData: navigator.connection.saveData,
        type: navigator.connection.type || null,
      } : null,
      memory: performance.memory ? {
        usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
        totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
        jsHeapSizeLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
      } : null,
    };
  }

  // ---------- 主动探测(供编排方调用) ----------
  // 暴露在 window 上,让 popup/orchestrator 通过 executeScript 在指定 frame 执行
  async function activeRttProbe(target, sampleCount, timeoutMs) {
    sampleCount = Math.max(1, Math.min(20, sampleCount || 5));
    timeoutMs = Math.max(500, Math.min(15000, timeoutMs || 4000));
    const samples = [];
    const errors = [];
    const startT = performance.now();
    for (let i = 0; i < sampleCount; i++) {
      const t0 = performance.now();
      let timedOut = false;
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        const url = target + (target.includes('?') ? '&' : '?') + '__judgeProbe=' + Date.now() + '-' + i;
        const resp = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          mode: 'no-cors',
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        try { await resp.arrayBuffer(); } catch (_) { /* opaque/no-cors */ }
        samples.push(performance.now() - t0);
      } catch (err) {
        errors.push({ msg: String((err && err.message) || err), timedOut, elapsed: performance.now() - t0 });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return { samples, errors, totalMs: performance.now() - startT };
  }

  window.__JUDGE_PROBE__ = activeRttProbe;

  // ---------- 主入口:把本 frame 的原始数据吐出来 ----------
  window.__JUDGE_DUMP_RAW__ = function () {
    return {
      isTop,
      timeOrigin: performance.timeOrigin,
      frameUrl: location.href,
      frameOrigin: location.origin,
      env: isTop ? envInfo() : null,
      navigation: isTop ? navigationSummary() : null,
      vitals: isTop ? {
        LCP: vitals.LCP, FCP: vitals.FCP, CLS: vitals.CLS, INP: vitals.INP,
        longTasks: vitals.longTasks.slice(),
      } : null,
      resources: performance.getEntriesByType('resource').map(plainResource),
      captured: captured.slice(),
      // v0.10.0 新增:操作轨迹 + JS 异常
      trace: trace.slice(),
      errors: errors.slice(),
    };
  };
})();
