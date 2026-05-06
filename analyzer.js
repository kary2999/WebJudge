// analyzer.js (v0.9.0)
// 把多个 frame(顶层 + iframe)的原始 dump 合并成最终 report,负责所有"分析"逻辑。
//
// 新时序模型:
//   total       = duration                            (responseEnd - startTime)
//   queue       = max(0, requestStart - startTime - dns - tcp - ssl)
//   dns / tcp / ssl  = 来自 Resource Timing
//   serverWork  = extend.runtime  (服务端进程内,纯业务处理)
//   networkRT   = max(0, (responseStart - requestStart) - serverWork)   ← 上行+下行首字节,真实网络往返
//   download    = responseEnd - responseStart                            ← 下行尾字节
//
// 校验:queue + dns + tcp + ssl + networkRT + serverWork + download ≈ total (差几毫秒为正常)
// 当 networkRT < 0(说明 runtime 把响应写入也算了)→ 截到 0,差额并入 download。
// 没有 extend.runtime 时退化:serverWork=null,沿用旧的 serverTime/downloadTime 字段,但**不**给出归责。
//
// 5 类归责标签(替代旧的 5 类):
//   backend-slow         serverWork / total > 50%                                   后端慢
//   network-congestion   networkRT / total > 40% (且 ping p50 > 300ms 时强信号)     网络拥塞
//   cold-connection      dns + tcp + ssl > 300ms                                    首次连接慢
//   browser-queue        queue > 200ms 且 同源并发@start ≥ 6                          前端排队
//   large-response       download > 500ms 且 transferSize > 200KB                    响应过大
//   mixed                没有单一来源 ≥ 40%                                          混合
//
// 暴露:
//   window.JudgeAnalyzer = {
//     buildReport(frameDumps, options),
//     probeOrigins(tabId, origins, options),
//   }

(function (global) {
  'use strict';

  const BROWSER_PARALLEL_LIMIT = 6;
  const FRONTEND_STATIC = new Set(['script', 'link', 'css', 'img', 'image', 'font', 'media', 'video', 'audio']);
  const BACKEND_API = new Set(['xmlhttprequest', 'fetch']);
  const BIZ_SUCCESS_VALUES = new Set([0, '0', 1, '1', 200, '200', true, 'ok', 'OK', 'success', 'SUCCESS', 'succ', 'true']);

  function isBizSuccess(s) {
    if (s == null) return null;
    if (BIZ_SUCCESS_VALUES.has(s)) return true;
    if (typeof s === 'string' && /^(ok|success|true|succ)$/i.test(s)) return true;
    return false;
  }

  function safeUrl(u) { try { return new URL(u, location.href); } catch (_) { return null; } }
  function getOrigin(u) { const x = safeUrl(u); return x ? x.origin : 'unknown'; }
  function getPath(u) { const x = safeUrl(u); return x ? x.pathname : u; }

  function categorize(initiator) {
    if (BACKEND_API.has(initiator)) return 'backend-api';
    if (FRONTEND_STATIC.has(initiator)) return 'frontend-static';
    if (initiator === 'navigation') return 'navigation';
    if (initiator === 'iframe' || initiator === 'frame') return 'iframe';
    return 'other';
  }

  function classifyInitiator(t) {
    t = t || '';
    if (t === 'xmlhttprequest' || t === 'fetch') return t;
    if (t === 'link' || t === 'css') return 'css';
    if (t === 'img' || t === 'image') return 'img';
    return t || 'other';
  }

  // 算时序拆解(基于一条 resource entry 和它对应的捕获 cap)
  function timingBreakdown(e, cap) {
    const total = Math.max(0, e.duration);
    const dns = Math.max(0, (e.domainLookupEnd || 0) - (e.domainLookupStart || 0));
    const tcp = Math.max(0, (e.connectEnd || 0) - (e.connectStart || 0));
    const ssl = e.secureConnectionStart ? Math.max(0, (e.connectEnd || 0) - e.secureConnectionStart) : 0;
    // tcp 包含 ssl,这里要相减
    const tcpOnly = Math.max(0, tcp - ssl);
    const setup = dns + tcpOnly + ssl;
    const queue = Math.max(0, (e.requestStart || 0) - (e.startTime || 0) - setup);
    const download = Math.max(0, (e.responseEnd || 0) - (e.responseStart || 0));
    const responseStartGap = Math.max(0, (e.responseStart || 0) - (e.requestStart || 0));

    let serverWork = null;
    let networkRT = null;
    if (cap && cap.extend && cap.extend.runtimeMs != null) {
      serverWork = cap.extend.runtimeMs;
      // networkRT = (responseStart - requestStart) - serverWork
      // 若 < 0,说明 runtime 把响应写入也算了 → 截到 0,差额视为 download
      const raw = responseStartGap - serverWork;
      networkRT = raw >= 0 ? raw : 0;
      // 没法把溢出的部分准确并入 download 而不破坏校验,接受小误差
    }
    return {
      total, queue, dns, tcp: tcpOnly, ssl, setup,
      serverWork, networkRT, download,
      // 兼容旧字段
      queueTime: queue, dnsTime: dns, tcpTime: tcpOnly, sslTime: ssl,
      serverTime: responseStartGap, downloadTime: download,
    };
  }

  // 把一个 frame 的 captured 列表和 resource 列表做 1-to-1 贪心配对
  // 用 absolute time(timeOrigin + perf.now)统一,资源按 absStart 升序排,
  // 每条找最近的同 URL 未占用的 capture
  function pairResourcesWithCaptures(frameDumps) {
    // 全局所有 resource(打 absStart/absEnd)+ 全局所有 capture(打 absStart)
    const allRes = [];
    const allCaps = [];
    for (const d of frameDumps) {
      const base = d.timeOrigin || 0;
      for (const r of d.resources || []) {
        allRes.push({ ...r, _frameId: d.frameId, _frameUrl: d.frameUrl, _absStart: base + r.startTime, _absEnd: base + r.responseEnd });
      }
      for (const c of d.captured || []) {
        allCaps.push({ ...c, _frameId: d.frameId, _frameUrl: d.frameUrl, _absStart: base + (c.startTime || 0), _claimed: false });
      }
    }
    allRes.sort((a, b) => a._absStart - b._absStart);

    function claim(res) {
      let best = null, bestDiff = Infinity;
      for (const c of allCaps) {
        if (c._claimed) continue;
        if (c.url !== res.name) continue;
        const diff = Math.abs(c._absStart - res._absStart);
        if (diff < bestDiff && diff < 1500) { bestDiff = diff; best = c; }
      }
      if (best) best._claimed = true;
      return best;
    }

    // 给每条 resource 配 capture,产生 row
    const rows = allRes.map((r) => {
      const cap = claim(r);
      const t = timingBreakdown(r, cap);
      const initiator = classifyInitiator(r.initiatorType);
      const category = categorize(initiator);
      const transferSize = r.transferSize || 0;
      const decodedBodySize = r.decodedBodySize || 0;
      const fromCache = transferSize === 0 && decodedBodySize > 0;
      const row = {
        url: r.name,
        path: getPath(r.name),
        origin: getOrigin(r.name),
        initiator,
        category,
        nextHopProtocol: r.nextHopProtocol || '',
        startTime: r.startTime,
        responseEnd: r.responseEnd,
        absStartTime: r._absStart,
        absEndTime: r._absEnd,
        frameId: r._frameId,
        frameUrl: r._frameUrl,
        duration: t.total,
        queueTime: t.queue,
        dnsTime: t.dns,
        tcpTime: t.tcp,
        sslTime: t.ssl,
        setupTime: t.setup,
        serverTime: t.serverTime,
        downloadTime: t.download,
        // 新字段:三段式精确分解
        serverWork: t.serverWork,
        networkRT: t.networkRT,
        transferSize,
        encodedBodySize: r.encodedBodySize || 0,
        decodedBodySize,
        fromCache,
      };
      if (cap) {
        row.status = cap.status;
        row.statusText = cap.statusText;
        row.method = cap.method;
        row.ok = cap.ok;
        row.contentType = cap.contentType;
        row.extend = cap.extend || null;
        row.biz = cap.biz || null;
        row.bizStatus = cap.biz ? cap.biz.status : null;
        row.bizMessage = cap.biz ? cap.biz.message : null;
        row.isJson = !!cap.isJson;
        row.serverReportedRuntimeMs = cap.extend && cap.extend.runtimeMs != null ? cap.extend.runtimeMs : null;
        row.responseSnippet = cap.responseSnippet || '';
        row.bodyTruncated = !!cap.bodyTruncated;
        row.captureError = cap.error || null;
        if (row.serverReportedRuntimeMs != null) {
          row.runtimeDelta = row.duration - row.serverReportedRuntimeMs;
        }
      }
      return row;
    });

    // 把没匹配上的 capture 当独立行加入(SW 拦截、被 cache 等情况)
    for (const c of allCaps) {
      if (c._claimed) continue;
      const initiator = c.hookType === 'xhr' ? 'xmlhttprequest' : 'fetch';
      rows.push({
        url: c.url,
        path: getPath(c.url),
        origin: getOrigin(c.url),
        initiator,
        category: 'backend-api',
        nextHopProtocol: '',
        startTime: c.startTime || 0,
        responseEnd: c.endTime || 0,
        absStartTime: c._absStart,
        absEndTime: (c._absStart + (c.duration || 0)),
        frameId: c._frameId,
        frameUrl: c._frameUrl,
        duration: c.duration || 0,
        queueTime: 0, dnsTime: 0, tcpTime: 0, sslTime: 0, setupTime: 0,
        serverTime: 0, downloadTime: 0,
        serverWork: c.extend && c.extend.runtimeMs != null ? c.extend.runtimeMs : null,
        networkRT: null,
        transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, fromCache: false,
        status: c.status,
        statusText: c.statusText,
        method: c.method,
        ok: c.ok,
        contentType: c.contentType,
        extend: c.extend || null,
        biz: c.biz || null,
        bizStatus: c.biz ? c.biz.status : null,
        bizMessage: c.biz ? c.biz.message : null,
        isJson: !!c.isJson,
        serverReportedRuntimeMs: c.extend && c.extend.runtimeMs != null ? c.extend.runtimeMs : null,
        responseSnippet: c.responseSnippet || '',
        bodyTruncated: !!c.bodyTruncated,
        captureError: c.error || null,
        runtimeDelta: c.extend && c.extend.runtimeMs != null ? (c.duration - c.extend.runtimeMs) : undefined,
        noResourceTiming: true,
      });
    }
    return rows;
  }

  // 跨 frame 同源并发统计(浏览器是按 origin 全局限速 6,跨 frame 也共享)
  function annotateConcurrency(rows) {
    for (const row of rows) {
      const concurrent = rows.filter(
        (o) => o !== row &&
          o.origin === row.origin &&
          o.absStartTime <= row.absStartTime &&
          o.absEndTime > row.absStartTime
      ).length;
      row.concurrentAtStart = concurrent;
    }
  }

  // 5 类归责
  function classifyReason(row, originPings) {
    if (row.duration < 1000) return null;
    const total = Math.max(row.duration, 1);
    const sw = row.serverWork;
    const nrt = row.networkRT;
    const setup = row.setupTime || 0;
    const queue = row.queueTime || 0;
    const dl = row.downloadTime || 0;
    const transferKB = (row.transferSize || 0) / 1024;
    const ping = originPings && originPings[row.origin];

    // 按"占比 + 强信号"挑出主要原因
    const buckets = [];
    if (sw != null) buckets.push({ tag: 'backend-slow', share: sw / total });
    if (nrt != null) buckets.push({ tag: 'network-congestion', share: nrt / total });
    buckets.push({ tag: 'cold-connection', share: setup > 300 ? 1 : setup / total });
    buckets.push({ tag: 'browser-queue', share: (queue > 200 && row.concurrentAtStart >= BROWSER_PARALLEL_LIMIT) ? 1 : queue / total });
    buckets.push({ tag: 'large-response', share: (dl > 500 && transferKB > 200) ? 1 : dl / total });

    // 强阈值
    if (sw != null && sw / total > 0.5) return 'backend-slow';
    if (queue > 200 && row.concurrentAtStart >= BROWSER_PARALLEL_LIMIT) return 'browser-queue';
    if (setup > 300) return 'cold-connection';
    if (nrt != null && nrt / total > 0.4) return 'network-congestion';
    if (dl > 500 && transferKB > 200) return 'large-response';
    // ping 强信号:对应域名 p50 > 300ms 时,即使 networkRT 占比未到 40% 也归网络
    if (ping && ping.p50 != null && ping.p50 > 300 && nrt != null && nrt / total > 0.25) return 'network-congestion';
    // 取最大占比的桶
    const winner = buckets.sort((a, b) => b.share - a.share)[0];
    if (winner && winner.share >= 0.4) return winner.tag;
    return 'mixed';
  }

  // 网络评分(带可选的 domainPings)
  function buildNetworkProfile(rows, env, activeProbe, domainPings) {
    const conn = env && env.connection ? env.connection : null;
    const browserReported = conn ? {
      effectiveType: conn.effectiveType || null,
      downlinkMbps: conn.downlink != null ? conn.downlink : null,
      rttMs: conn.rtt != null ? conn.rtt : null,
      saveData: !!conn.saveData,
      type: conn.type || null,
    } : null;

    // 实测吞吐 / DNS / TCP / SSL / 静态 TTFB(全部跨 frame 取样)
    const throughputs = [];
    const dnsArr = [], tcpArr = [], sslArr = [], ttfbStaticArr = [];
    for (const r of rows) {
      if (r.transferSize > 2000 && r.downloadTime > 5 && !r.fromCache) {
        const mbps = (r.transferSize * 8) / (r.downloadTime / 1000) / 1_000_000;
        if (isFinite(mbps) && mbps > 0 && mbps < 10000) throughputs.push(mbps);
      }
      if (r.dnsTime > 0) dnsArr.push(r.dnsTime);
      if (r.tcpTime > 0) tcpArr.push(r.tcpTime);
      if (r.sslTime > 0) sslArr.push(r.sslTime);
      if (r.category === 'frontend-static' && r.serverTime > 0) ttfbStaticArr.push(r.serverTime);
    }
    const measured = {
      downloadThroughputMbps: stats(throughputs),
      dnsMs: stats(dnsArr),
      tcpMs: stats(tcpArr),
      sslMs: stats(sslArr),
      ttfbStaticMs: stats(ttfbStaticArr),
    };

    // 每域名分组(此处与 domainPings 整合)
    const buckets = new Map();
    for (const r of rows) {
      if (!buckets.has(r.origin)) buckets.set(r.origin, { dns: [], tcp: [], ssl: [], ttfb: [], throughput: [], count: 0 });
      const b = buckets.get(r.origin);
      b.count++;
      if (r.dnsTime > 0) b.dns.push(r.dnsTime);
      if (r.tcpTime > 0) b.tcp.push(r.tcpTime);
      if (r.sslTime > 0) b.ssl.push(r.sslTime);
      if (r.serverTime > 0) b.ttfb.push(r.serverTime);
      if (r.transferSize > 2000 && r.downloadTime > 5 && !r.fromCache) {
        const mbps = (r.transferSize * 8) / (r.downloadTime / 1000) / 1_000_000;
        if (isFinite(mbps) && mbps > 0) b.throughput.push(mbps);
      }
    }
    const byOrigin = Array.from(buckets.entries()).map(([origin, b]) => ({
      origin, count: b.count,
      dnsP50: percentile(sort(b.dns), 0.5),
      tcpP50: percentile(sort(b.tcp), 0.5),
      sslP50: percentile(sort(b.ssl), 0.5),
      ttfbP50: percentile(sort(b.ttfb), 0.5),
      throughputP50: percentile(sort(b.throughput), 0.5),
      ping: domainPings ? (domainPings[origin] || null) : null,
    })).sort((a, b) => b.count - a.count);

    // 评级
    let rating = 'excellent';
    const reasons = [];
    if (browserReported) {
      const et = browserReported.effectiveType;
      if (et === 'slow-2g' || et === '2g') { rating = rankWorse(rating, 'poor'); reasons.push(`浏览器判定 ${et}`); }
      else if (et === '3g') { rating = rankWorse(rating, 'fair'); reasons.push('浏览器判定 3g'); }
      if (browserReported.rttMs != null) {
        if (browserReported.rttMs > 500) { rating = rankWorse(rating, 'poor'); reasons.push(`估算 RTT ${browserReported.rttMs}ms`); }
        else if (browserReported.rttMs > 300) { rating = rankWorse(rating, 'fair'); reasons.push(`估算 RTT ${browserReported.rttMs}ms`); }
      }
      if (browserReported.downlinkMbps != null) {
        if (browserReported.downlinkMbps < 0.5) { rating = rankWorse(rating, 'poor'); reasons.push(`下行仅 ${browserReported.downlinkMbps} Mbps`); }
        else if (browserReported.downlinkMbps < 1.5) { rating = rankWorse(rating, 'fair'); reasons.push(`下行 ${browserReported.downlinkMbps} Mbps`); }
      }
      if (browserReported.saveData) { rating = rankWorse(rating, 'fair'); reasons.push('开启省流量模式'); }
    }
    if (measured.downloadThroughputMbps && measured.downloadThroughputMbps.p50 != null) {
      const p50 = measured.downloadThroughputMbps.p50;
      if (p50 < 1) { rating = rankWorse(rating, 'poor'); reasons.push(`实测下载中位 ${p50.toFixed(2)} Mbps`); }
      else if (p50 < 3) { rating = rankWorse(rating, 'fair'); reasons.push(`实测下载中位 ${p50.toFixed(2)} Mbps`); }
    }
    if (measured.ttfbStaticMs && measured.ttfbStaticMs.p50 != null) {
      const p50 = measured.ttfbStaticMs.p50;
      if (p50 > 800) { rating = rankWorse(rating, 'poor'); reasons.push(`静态 TTFB 中位 ${Math.round(p50)}ms`); }
      else if (p50 > 400) { rating = rankWorse(rating, 'fair'); reasons.push(`静态 TTFB 中位 ${Math.round(p50)}ms`); }
    }
    if (activeProbe && activeProbe.p50 != null) {
      if (activeProbe.p50 > 500) { rating = rankWorse(rating, 'poor'); reasons.push(`实测 RTT 中位 ${Math.round(activeProbe.p50)}ms`); }
      else if (activeProbe.p50 > 250) { rating = rankWorse(rating, 'fair'); reasons.push(`实测 RTT 中位 ${Math.round(activeProbe.p50)}ms`); }
    }
    // 域名 ping 中如果有 timeout / 高延迟,加权
    if (domainPings) {
      let badDomains = 0;
      for (const k of Object.keys(domainPings)) {
        const dp = domainPings[k];
        if (!dp) continue;
        if (dp.successCount === 0) badDomains++;
        else if (dp.p50 != null && dp.p50 > 500) badDomains++;
      }
      if (badDomains > 0) {
        rating = rankWorse(rating, badDomains >= 2 ? 'poor' : 'fair');
        reasons.push(`${badDomains} 个 API 域名响应慢/超时`);
      }
    }

    return { browserReported, measured, byOrigin, activeProbe: activeProbe || null, domainPings: domainPings || null, rating, ratingReasons: reasons };
  }

  // ---------- 工具 ----------
  function sort(arr) { return arr.slice().sort((a, b) => a - b); }
  function percentile(sortedNums, p) {
    if (!sortedNums.length) return null;
    const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
    return sortedNums[idx];
  }
  function stats(nums) {
    if (!nums.length) return null;
    const s = sort(nums);
    return {
      samples: s.length, min: s[0], max: s[s.length - 1],
      avg: s.reduce((a, b) => a + b, 0) / s.length,
      p50: percentile(s, 0.5), p95: percentile(s, 0.95),
    };
  }
  function rankWorse(a, b) {
    const order = { excellent: 0, good: 1, fair: 2, poor: 3 };
    return (order[a] ?? 0) > (order[b] ?? 0) ? a : b;
  }

  // ---------- 概览 / 慢接口 / 失败接口 / 不一致 等 ----------
  function summarize(rows) {
    const byOrigin = {};
    const byType = {};
    const byCategory = {
      'backend-api':    { count: 0, transfer: 0, totalDuration: 0 },
      'frontend-static':{ count: 0, transfer: 0, totalDuration: 0 },
      'navigation':     { count: 0, transfer: 0, totalDuration: 0 },
      'iframe':         { count: 0, transfer: 0, totalDuration: 0 },
      'other':          { count: 0, transfer: 0, totalDuration: 0 },
    };
    let totalTransfer = 0, totalDecoded = 0;
    for (const r of rows) {
      byOrigin[r.origin] = (byOrigin[r.origin] || 0) + 1;
      byType[r.initiator] = byType[r.initiator] || { count: 0, transfer: 0 };
      byType[r.initiator].count++;
      byType[r.initiator].transfer += r.transferSize;
      byCategory[r.category].count++;
      byCategory[r.category].transfer += r.transferSize;
      byCategory[r.category].totalDuration += r.duration;
      totalTransfer += r.transferSize;
      totalDecoded += r.decodedBodySize;
    }
    const apiRows = rows.filter((r) => r.category === 'backend-api');
    const slowApis = apiRows.filter((r) => r.duration >= 1000).sort((a, b) => b.duration - a.duration);
    const failedApis = apiRows.filter((r) => r.status != null && !(r.status >= 200 && r.status < 300))
      .sort((a, b) => (a.status || 0) - (b.status || 0));
    const bizFailedApis = apiRows.filter((r) => {
      if (!r.biz) return false;
      if (r.status && !(r.status >= 200 && r.status < 300)) return false;
      const ok = isBizSuccess(r.biz.status);
      return ok === false;
    });
    const apisWithExtend = apiRows.filter((r) => r.extend);
    const runtimeMismatches = apisWithExtend
      .filter((r) => r.runtimeDelta != null && r.runtimeDelta > 300)
      .sort((a, b) => b.runtimeDelta - a.runtimeDelta);
    const queued = rows.filter((r) => r.slowReason === 'browser-queue');
    const bigResources = rows.filter((r) => r.transferSize >= 300 * 1024).sort((a, b) => b.transferSize - a.transferSize);
    const urlCount = {};
    for (const r of rows) urlCount[r.url] = (urlCount[r.url] || 0) + 1;
    const duplicates = Object.entries(urlCount).filter(([_, n]) => n > 1).map(([url, n]) => ({ url, count: n }));

    // 同 URL 不一致
    const byUrl = new Map();
    for (const r of apiRows) {
      if (!byUrl.has(r.url)) byUrl.set(r.url, []);
      byUrl.get(r.url).push(r);
    }
    const inconsistentGroups = [];
    const inconsistentCalls = [];
    for (const [url, calls] of byUrl) {
      if (calls.length < 2) continue;
      const httpStatuses = new Set(calls.map((c) => c.status));
      const bizStatuses = new Set(calls.map((c) => c.biz ? c.biz.status : '__nobiz__'));
      if (httpStatuses.size > 1 || bizStatuses.size > 1) {
        const successCount = calls.filter((c) => {
          const httpOk = c.status >= 200 && c.status < 300;
          const bizOk = c.biz ? isBizSuccess(c.biz.status) !== false : true;
          return httpOk && bizOk;
        }).length;
        const failures = calls.filter((c) => {
          const httpOk = c.status >= 200 && c.status < 300;
          const bizOk = c.biz ? isBizSuccess(c.biz.status) !== false : true;
          return !(httpOk && bizOk);
        });
        inconsistentGroups.push({
          url, path: calls[0].path, totalCalls: calls.length,
          successCount, failureCount: failures.length,
          httpStatuses: Array.from(httpStatuses),
          bizStatuses: Array.from(bizStatuses).filter((s) => s !== '__nobiz__'),
          calls,
        });
        for (const f of failures) inconsistentCalls.push(f);
      }
    }

    return {
      totalRequests: rows.length,
      totalTransferKB: Math.round(totalTransfer / 1024),
      totalDecodedKB: Math.round(totalDecoded / 1024),
      byOrigin, byType, byCategory,
      slowApis, failedApis, bizFailedApis, apisWithExtend, runtimeMismatches,
      inconsistentGroups, inconsistentCalls,
      topSlowAll: rows.slice().sort((a, b) => b.duration - a.duration).slice(0, 20),
      queued, bigResources, duplicates,
    };
  }

  function buildSuggestions(summary, vitals, network, errors) {
    const s = [];
    // v0.10.0:JS 异常 / 资源加载失败 优先提到最前
    if (errors && errors.length > 0) {
      const jsErrs = errors.filter((e) => e.type === 'error' || e.type === 'unhandledrejection');
      const resErrs = errors.filter((e) => e.type === 'resource');
      if (jsErrs.length > 0) {
        const sample = jsErrs[0];
        s.push({
          level: 'error',
          title: `检测到 ${jsErrs.length} 个 JS 运行时异常`,
          detail: `首个异常:${(sample.message || '').slice(0, 120)}${sample.filename ? ` @ ${sample.filename}:${sample.lineno}` : ''}。这类问题最可能直接导致"页面白了/按钮没反应",请优先排查。`,
        });
      }
      if (resErrs.length > 0) {
        s.push({
          level: 'warn',
          title: `${resErrs.length} 个资源加载失败 (404/网络断)`,
          detail: '图标/脚本/样式表加载失败,会出现 broken icon、布局错乱、功能不工作。',
        });
      }
    }
    if (network) {
      const userNetCount = summary.slowApis.filter((r) => r.slowReason === 'network-congestion').length;
      if (network.rating === 'poor') {
        s.push({ level: 'error', title: `用户网络环境较差 (评级: POOR)`,
          detail: `${(network.ratingReasons || []).join('; ')}。慢可能不是系统问题 —— 建议用户:检查 WiFi 信号 / 切换有线网 / 换网络环境。` });
      } else if (network.rating === 'fair') {
        s.push({ level: 'warn', title: `用户网络环境一般 (评级: FAIR)`,
          detail: `${(network.ratingReasons || []).join('; ')}。部分慢可能是网络导致。` });
      }
      if (userNetCount > 0) {
        s.push({ level: 'warn', title: `${userNetCount} 个慢接口判定为"网络拥塞"`,
          detail: '后端 runtime 正常,但客户端实测慢 —— 网络往返时间过大。先确认用户网络再追后端。' });
      }
      // 域名级 ping 失败
      if (network.domainPings) {
        const fails = Object.entries(network.domainPings).filter(([_, p]) => p && p.successCount === 0);
        if (fails.length > 0) {
          s.push({ level: 'error', title: `${fails.length} 个 API 域名 ping 全部超时`,
            detail: '客户端访问不到这些域名:' + fails.map(([o]) => o).slice(0, 3).join('; ') + '。检查 DNS/代理/防火墙。' });
        }
      }
    }
    if (summary.totalRequests > 80) {
      s.push({ level: 'warn', title: `请求数过多 (${summary.totalRequests})`,
        detail: '建议合并请求、图片懒加载、裁剪首屏依赖。' });
    }
    const fs = summary.byCategory['frontend-static'];
    if (fs && fs.count > 60) {
      s.push({ level: 'warn', title: `前端静态资源 ${fs.count} 个 / ${Math.round(fs.transfer / 1024)} KB`,
        detail: '开启 HTTP 缓存、代码分割、图片 WebP、清除无用依赖。' });
    }
    for (const [origin, n] of Object.entries(summary.byOrigin)) {
      if (n >= 20) {
        s.push({ level: 'warn', title: `同源 ${origin} 请求 ${n} 个`,
          detail: '同域 HTTP/1.1 6 并发上限,后续排队。升级 HTTP/2 或拆 CDN 子域。' });
      }
    }
    if (summary.queued.length > 0) {
      s.push({ level: 'error', title: `检测到 ${summary.queued.length} 个请求被浏览器排队`,
        detail: '前端把连接占满,不是后端慢。减并发或升 HTTP/2。' });
    }
    if (summary.runtimeMismatches.length > 0) {
      const top = summary.runtimeMismatches[0];
      s.push({ level: 'error', title: `${summary.runtimeMismatches.length} 个接口 extend.runtime 与实测差距 > 300ms`,
        detail: `典型:${top.path} 后端 ${Math.round(top.serverReportedRuntimeMs)}ms,实测 ${Math.round(top.duration)}ms,差 ${Math.round(top.runtimeDelta)}ms。差值多半来自网络往返。` });
    }
    if (summary.failedApis.length > 0) {
      s.push({ level: 'error', title: `${summary.failedApis.length} 个接口 HTTP 状态异常`,
        detail: '存在失败 / 重定向 / 服务端错误,优先修。' });
    }
    if (summary.bizFailedApis.length > 0) {
      s.push({ level: 'error', title: `${summary.bizFailedApis.length} 个接口业务失败 (HTTP 200 但 biz.status 异常)`,
        detail: '最容易被 HTTP 监控漏掉,看响应体定位。' });
    }
    if (summary.inconsistentGroups && summary.inconsistentGroups.length > 0) {
      const w = summary.inconsistentGroups[0];
      s.push({ level: 'error', title: `${summary.inconsistentGroups.length} 个 URL 出现结果不一致`,
        detail: `典型:${w.path} 调用 ${w.totalCalls} 次,成功 ${w.successCount}/失败 ${w.failureCount}。可能是偶发错误或并发竞态。` });
    }
    if (summary.slowApis.length > 0) {
      const backend = summary.slowApis.filter((r) => r.slowReason === 'backend-slow').length;
      if (backend > 0) {
        s.push({ level: 'error', title: `${backend} 个接口判定为"后端慢" (server / total > 50%)`,
          detail: '真后端慢:优化 SQL / 缓存 / 索引。' });
      }
    }
    if (summary.bigResources.length > 0) {
      const total = summary.bigResources.reduce((a, r) => a + r.transferSize, 0);
      s.push({ level: 'warn', title: `${summary.bigResources.length} 个大资源 (共 ${Math.round(total / 1024)} KB)`,
        detail: '图片 WebP/AVIF,JS Tree Shaking,CSS 清理。' });
    }
    if (vitals && vitals.LCP && vitals.LCP.value > 2500) {
      s.push({ level: 'error', title: `LCP ${Math.round(vitals.LCP.value)}ms 偏高`,
        detail: '首屏内容渲染慢。preload 关键资源、SSR 或骨架屏。' });
    }
    if (vitals && vitals.CLS > 0.1) {
      s.push({ level: 'warn', title: `CLS ${vitals.CLS.toFixed(3)} 偏高`,
        detail: '布局抖动。给图片/广告/iframe 预留固定尺寸。' });
    }
    if (vitals && vitals.INP && vitals.INP.value > 200) {
      s.push({ level: 'warn', title: `INP ${Math.round(vitals.INP.value)}ms 偏高`,
        detail: '交互卡顿。拆长任务、减主线程阻塞。' });
    }
    if (vitals && vitals.longTasks && vitals.longTasks.length > 5) {
      s.push({ level: 'warn', title: `检测到 ${vitals.longTasks.length} 个主线程长任务 (>50ms)`,
        detail: '主线程阻塞。检查大型同步 JS、第三方脚本。' });
    }
    return s;
  }

  // ---------- 入口:合并多 frame dump 构建报告 ----------
  function buildReport(frameDumps, options) {
    options = options || {};
    const top = frameDumps.find((d) => d.isTop) || frameDumps[0];
    if (!top) {
      throw new Error('No frame dumps received');
    }

    // 合并配对
    const rows = pairResourcesWithCaptures(frameDumps);
    annotateConcurrency(rows);

    const env = top.env || {};
    const vitals = top.vitals || { LCP: null, FCP: null, CLS: 0, INP: null, longTasks: [] };
    const network = buildNetworkProfile(rows, env, options.activeProbe || null, options.domainPings || null);

    // 用 ping 信号回填 networkRT 缺失的 row(没 extend.runtime 的接口),不影响占比但能给标签
    const originPings = (options.domainPings) || (network.byOrigin || []).reduce((acc, b) => {
      if (b.ping) acc[b.origin] = b.ping;
      return acc;
    }, {});

    // 归责
    for (const row of rows) {
      row.slowReason = classifyReason(row, originPings);
    }

    // v0.10.0: 合并所有 frame 的事件轨迹和 JS 异常
    // 跨 frame 时间用绝对时间(timeOrigin + relative)对齐
    const trace = [];
    const errors = [];
    for (const d of frameDumps) {
      const isSubFrame = !d.isTop;
      for (const e of (d.trace || [])) {
        trace.push(Object.assign({}, e, { frameUrl: isSubFrame ? d.frameUrl : null }));
      }
      for (const e of (d.errors || [])) {
        errors.push(Object.assign({}, e, { frameUrl: isSubFrame ? d.frameUrl : null }));
      }
    }
    trace.sort((a, b) => (a.t || 0) - (b.t || 0));
    errors.sort((a, b) => (a.t || 0) - (b.t || 0));

    const summary = summarize(rows);
    const suggestions = buildSuggestions(summary, vitals, network, errors);

    return {
      meta: {
        generatedAt: new Date().toISOString(),
        url: env.url,
        title: env.title,
        userAgent: env.userAgent,
        viewport: env.viewport,
        connection: env.connection,
        memory: env.memory,
        capturedApiCount: frameDumps.reduce((a, d) => a + (d.captured ? d.captured.length : 0), 0),
        frameCount: frameDumps.length,
        frameUrls: frameDumps.map((d) => d.frameUrl),
      },
      vitals,
      navigation: top.navigation || null,
      network,
      trace,
      errors,
      summary,
      resources: rows,
      suggestions,
    };
  }

  // ---------- 域名 ping 编排(在 popup 上下文调用) ----------
  // 对每个 origin 在 tab 的顶层 frame 触发 __JUDGE_PROBE__,串行执行。
  async function probeOrigins(tabId, origins, options) {
    options = options || {};
    const sampleCount = options.sampleCount || 5;
    const timeoutMs = options.timeoutMs || 4000;
    const results = {};
    for (const origin of origins) {
      try {
        const target = origin + '/favicon.ico';
        const exec = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: async (target, sampleCount, timeoutMs) => {
            if (typeof window.__JUDGE_PROBE__ === 'function') {
              return await window.__JUDGE_PROBE__(target, sampleCount, timeoutMs);
            }
            return null;
          },
          args: [target, sampleCount, timeoutMs],
        });
        const out = exec[0] && exec[0].result;
        if (!out) { results[origin] = null; continue; }
        const samples = out.samples || [];
        const errors = out.errors || [];
        const st = stats(samples);
        const jitter = samples.length > 1 ? (Math.max(...samples) - Math.min(...samples)) : 0;
        const timeoutCount = errors.filter((e) => e.timedOut).length;
        results[origin] = {
          target,
          requested: sampleCount,
          successCount: samples.length,
          failedCount: errors.length,
          timeoutCount,
          samples,
          min: st ? st.min : null,
          max: st ? st.max : null,
          avg: st ? st.avg : null,
          p50: st ? st.p50 : null,
          p95: st ? st.p95 : null,
          jitter,
          rating: !samples.length ? 'unreachable'
                : st.p50 < 200 ? 'good'
                : st.p50 < 500 ? 'fair'
                : 'poor',
        };
      } catch (e) {
        results[origin] = { error: String(e && e.message || e), successCount: 0 };
      }
    }
    return results;
  }

  global.JudgeAnalyzer = {
    buildReport,
    probeOrigins,
    isBizSuccess,
  };
})(window);
