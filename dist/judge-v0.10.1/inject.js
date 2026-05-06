// inject.js - runs in MAIN world. Hooks fetch and XMLHttpRequest so we can
// read response bodies and extract extend.runtime / extend.date / extend.unique.
// Captured data is dispatched as CustomEvent back to the isolated-world content.js.

(function () {
  if (window.__PI_HOOKED__) return;
  window.__PI_HOOKED__ = true;

  const EVT = '__PI_API_CAPTURE__';
  const BODY_LIMIT = 64 * 1024;      // keep at most 64KB of raw text
  const SNIPPET_LIMIT = 32 * 1024;    // 32KB kept in report (for detail view)

  function send(data) {
    try {
      // JSON stringify to avoid cross-world structured-clone issues with weird types
      window.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(data) }));
    } catch (_) { /* noop */ }
  }

  function parseRuntimeMs(v) {
    if (v == null) return null;
    const s = String(v);
    let m = s.match(/([\d.]+)\s*ms/i);
    if (m) return parseFloat(m[1]);
    m = s.match(/([\d.]+)\s*s/i);
    if (m) return parseFloat(m[1]) * 1000;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function tryParseBody(text, contentType) {
    const result = { extend: null, biz: null, parsed: false };
    if (!text) return result;
    const ct = (contentType || '').toLowerCase();
    if (!ct.includes('json') && text[0] !== '{' && text[0] !== '[') return result;
    try {
      const j = JSON.parse(text);
      result.parsed = true;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        // extend block
        const ext = j.extend;
        if (ext && typeof ext === 'object') {
          result.extend = {
            date: ext.date || null,
            unique: ext.unique || null,
            runtime: ext.runtime || null,
            runtimeMs: parseRuntimeMs(ext.runtime),
          };
        }
        // business-level status (common field names across backends)
        const statusVal = (j.status !== undefined) ? j.status
          : (j.code !== undefined) ? j.code
          : (j.errcode !== undefined) ? j.errcode
          : undefined;
        const msgVal = j.message || j.msg || j.errmsg || null;
        const hasData = ('data' in j) || ('result' in j) || ('rows' in j);
        result.biz = {
          status: statusVal,            // may be 0, "success", "fail", etc.
          message: msgVal,
          hasData,
          rootKeys: Object.keys(j).slice(0, 20),
        };
      }
    } catch (_) { /* not JSON */ }
    return result;
  }

  function truncate(text, limit) {
    if (!text) return '';
    return text.length > limit ? text.slice(0, limit) + '...[truncated]' : text;
  }

  // -------- fetch --------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = (typeof input === 'string' || input instanceof URL)
        ? String(input)
        : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const startTime = performance.now();
      const startTimestamp = Date.now();
      return origFetch.apply(this, arguments).then(async (response) => {
        const endTime = performance.now();
        const contentType = response.headers.get('content-type') || '';
        let text = '';
        let bodyTruncated = false;
        try {
          const clone = response.clone();
          const buf = await clone.arrayBuffer();
          const size = buf.byteLength;
          const slice = size > BODY_LIMIT ? buf.slice(0, BODY_LIMIT) : buf;
          text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
          bodyTruncated = size > BODY_LIMIT;
        } catch (_) { /* opaque / cors / binary */ }
        const parsed = tryParseBody(text, contentType);
        send({
          hookType: 'fetch',
          url,
          method: method.toUpperCase(),
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          startTime,
          endTime,
          duration: endTime - startTime,
          startTimestamp,
          contentType,
          extend: parsed.extend,
          biz: parsed.biz,
          isJson: parsed.parsed,
          responseSnippet: truncate(text, SNIPPET_LIMIT),
          bodyTruncated,
        });
        return response;
      }).catch((err) => {
        const endTime = performance.now();
        send({
          hookType: 'fetch',
          url,
          method: method.toUpperCase(),
          status: 0,
          statusText: 'network-error',
          ok: false,
          startTime,
          endTime,
          duration: endTime - startTime,
          startTimestamp,
          error: String((err && err.message) || err),
        });
        throw err;
      });
    };
  }

  // -------- XMLHttpRequest --------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__pi = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const xhr = this;
      const meta = xhr.__pi || {};
      const startTime = performance.now();
      const startTimestamp = Date.now();
      xhr.addEventListener('loadend', function () {
        const endTime = performance.now();
        let contentType = '';
        try { contentType = xhr.getResponseHeader('content-type') || ''; } catch (_) {}
        let text = '';
        let bodyTruncated = false;
        try {
          if (xhr.responseType === '' || xhr.responseType === 'text') {
            text = xhr.responseText || '';
          } else if (xhr.responseType === 'json') {
            text = JSON.stringify(xhr.response);
          }
          if (text && text.length > BODY_LIMIT) {
            text = text.slice(0, BODY_LIMIT);
            bodyTruncated = true;
          }
        } catch (_) {}
        const parsed = tryParseBody(text, contentType);
        send({
          hookType: 'xhr',
          url: meta.url,
          method: meta.method,
          status: xhr.status,
          statusText: xhr.statusText,
          ok: xhr.status >= 200 && xhr.status < 300,
          startTime,
          endTime,
          duration: endTime - startTime,
          startTimestamp,
          contentType,
          extend: parsed.extend,
          biz: parsed.biz,
          isJson: parsed.parsed,
          responseSnippet: truncate(text, SNIPPET_LIMIT),
          bodyTruncated,
        });
      });
      return origSend.apply(this, arguments);
    };
  }
})();
