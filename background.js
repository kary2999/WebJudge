// background.js (v0.10.0)
// 两件事:
//   1) JUDGE_OPEN_REPORT — 打开完整报告页(payload 先写 storage 再开标签,避免竞态)
//   2) JUDGE_ALERT — content.js 上报异常,这里维护 tab 级累计计数,更新扩展角标(B 档)
//
// 角标设计:
//   - 数字 = 自上次 popup 打开以来的累计异常数
//   - 颜色:有 js-error 红色,纯 api 异常黄色
//   - 用户打开 popup 时清零(收到 JUDGE_RESET_BADGE 消息)
//   - 关闭 tab 时自动清(chrome.tabs.onRemoved)
//   - 切换到该 tab 时角标已经是当前 tab 的(用 chrome.action.setBadgeText 带 tabId)

const ALERT_KIND_PRIORITY = { 'js-error': 2, 'api': 1 };
// 内存里维护 tab 累计:{ tabId -> { count, worst, kinds: Set } }
// service worker 会被休眠,但 popup 打开会唤醒,数据短暂丢失可接受 — 这是被动提示不是审计日志
const tabCounters = new Map();

function paintBadge(tabId) {
  const c = tabCounters.get(tabId);
  if (!c || c.count === 0) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  const text = c.count > 99 ? '99+' : String(c.count);
  const color = c.kinds && c.kinds.has('js-error') ? '#B91C1C' : '#B45309'; // 红 vs 琥珀
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  // 设置 title,鼠标悬停看详情
  const tip = c.kinds && c.kinds.has('js-error')
    ? `检测到 ${c.count} 次异常(含 JS 错误),点开看详情`
    : `检测到 ${c.count} 次接口异常,点开看详情`;
  chrome.action.setTitle({ tabId, title: tip }).catch(() => {});
}

function bumpCount(tabId, alert) {
  if (tabId == null) return;
  if (!tabCounters.has(tabId)) tabCounters.set(tabId, { count: 0, kinds: new Set() });
  const c = tabCounters.get(tabId);
  c.count += 1;
  c.kinds.add(alert.kind);
  paintBadge(tabId);
}

function resetCount(tabId) {
  if (tabId == null) return;
  tabCounters.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: 'Judge 页面性能体检' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // ---------- 打开报告页(0.8.1 修过的竞态版) ----------
  if (msg.type === 'JUDGE_OPEN_REPORT') {
    (async () => {
      try {
        const key = 'judge_report_' + Date.now().toString(36) +
                    '_' + Math.random().toString(36).slice(2, 10);
        await chrome.storage.local.set({ [key]: msg.payload });
        const url = chrome.runtime.getURL('report.html') + '#' + key;
        const tab = await chrome.tabs.create({ url });
        sendResponse({ ok: true, tabId: tab.id, key });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // ---------- B 档:content.js 上报异常事件 ----------
  if (msg.type === 'JUDGE_ALERT') {
    const tabId = sender && sender.tab && sender.tab.id;
    const enabled = true; // 后续做开关时从 storage 读
    if (enabled) bumpCount(tabId, msg.payload || {});
    return; // 不回复
  }

  // ---------- popup 打开时清零 ----------
  if (msg.type === 'JUDGE_RESET_BADGE') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) resetCount(tab.id);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ---------- 查询当前 tab 的徽章状态(popup 想知道刚才有多少异常) ----------
  if (msg.type === 'JUDGE_GET_BADGE') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const c = tab ? tabCounters.get(tab.id) : null;
      sendResponse({
        ok: true,
        count: c ? c.count : 0,
        kinds: c ? Array.from(c.kinds) : [],
      });
    })();
    return true;
  }
});

// tab 关掉就清状态
chrome.tabs.onRemoved.addListener((tabId) => {
  tabCounters.delete(tabId);
});

// tab 切换时不需要做什么 — chrome 自动按 tabId 显示对应 badge

// 1 小时清理过期的 storage payload(沿用 0.8.1)
chrome.runtime.onStartup.addListener(cleanupStaleReports);
chrome.runtime.onInstalled.addListener(cleanupStaleReports);
async function cleanupStaleReports() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const CUTOFF = 60 * 60 * 1000;
    const toDelete = [];
    for (const k of Object.keys(all)) {
      if (!k.startsWith('judge_report_')) continue;
      const m = /^judge_report_([0-9a-z]+)_/.exec(k);
      if (!m) continue;
      const createdAt = parseInt(m[1], 36);
      if (!isFinite(createdAt)) continue;
      if (now - createdAt > CUTOFF) toDelete.push(k);
    }
    if (toDelete.length) await chrome.storage.local.remove(toDelete);
  } catch (_) { /* best-effort */ }
}
