# 权限说明 — 给 Chrome Web Store 审核员看的 Justifications

> 提交时,Web Store 表单会针对**每个敏感权限**让你写一段 "justification"。
> 把下面对应字段直接复制进去,中英都给了。
>
> 这是**审核能不能过的关键** — 写得越具体,通过率越高。

---

## Single-purpose description (扩展唯一目的)

**字段**:Single purpose

```
Diagnose web page performance issues (slow APIs, network problems,
JS errors, user trace) and generate a downloadable PDF report for
sharing with developers — entirely on the user's own device.
```

中文版(留作参考,Web Store 通常要英文):

```
诊断网页性能问题(慢接口、网络问题、JS 异常、用户操作轨迹)
并生成可下载的 PDF 报告,完全在用户本地设备上完成。
```

---

## activeTab justification

```
Used to read Performance API data (Resource Timing, Navigation Timing,
PerformanceObserver entries) of the current tab when the user explicitly
clicks the extension icon. activeTab is only granted at the moment of
that click and revoked when the user navigates away. No background or
cross-tab access.
```

---

## scripting justification

```
Used to inject our analysis scripts (content.js + inject.js) into all
frames of the active tab. Required because:
1) Many target pages are admin shells with iframes; without injecting
   into all frames, request data inside iframes would be invisible.
2) The MAIN-world inject.js hooks fetch() and XMLHttpRequest to capture
   response bodies for business-layer failure detection (responses where
   HTTP=200 but the JSON body indicates an error). This data never leaves
   the user's browser unless they explicitly export the report.
Scripts only run on the active tab and only after the user clicks our icon.
```

---

## storage justification

```
Used to pass diagnostic data from the popup (which has a 5MB limit on
runtime.sendMessage size) to the full-report tab opened on user demand.
Storage entries are keyed by a random UUID, written before the tab opens,
read by the report page, then immediately deleted. Stale entries
(> 1 hour) are auto-cleaned at extension startup. No long-term data
storage.
```

---

## clipboardWrite justification

```
Powers the "Copy summary" button. Writes a plain-text diagnostic
summary into the user's clipboard so they can paste it into a ticket
system or chat. No clipboard reading.
```

---

## downloads justification

```
Powers the "Download PDF report" and "Download JSON" buttons. Triggers
a one-time download of the locally-generated report file to the user's
default download folder. No upload, no listing of existing downloads.
```

---

## host_permissions: <all_urls> justification (最重要,要写细)

```
The extension is a generic page-performance inspector. Users may run it
on any internal admin system, any public website, or any web app where
they are diagnosing slowness. We cannot enumerate target domains in
advance because the use case is "user encounters slow page X, runs Judge
on X". Restricting to specific domains would make the extension useless
for its core purpose.

Critically, we do NOT use webRequest, do NOT modify network traffic,
and do NOT continuously monitor pages in the background. Content scripts
collect Performance API data passively, and our fetch/XHR hook only
records (does not modify) requests. All data stays in the user's browser
unless they explicitly export.

We acknowledge <all_urls> is a broad permission. We mitigate the risk by:
1) Single-purpose, narrowly-scoped feature set (performance diagnosis only)
2) No external data transmission (verifiable from the open .js source)
3) Privacy policy explicitly listing every data category collected
4) Active-only operation: heavy work only happens when user clicks our icon
```

---

## Remote code use

**字段**:"Are you using remote code?" → 选 **No**

如果系统追问理由:

```
The extension does not load any remote JavaScript. All scripts are
bundled in the .crx package. Manifest V3 forbids `eval()` and dynamic
code, and we comply.

The only outbound HTTP requests are:
1) Optional public-IP query (api.ipify.org / ipinfo.io / ifconfig.co)
   for adding the user's public IP as a watermark to the PDF report.
2) Optional ping requests to API origins on the inspected page,
   triggered ONLY when the user clicks "Probe domains" button.

Neither of these loads or executes remote code.
```

---

## Data usage disclosure (新版表单要求逐项打钩)

提交时会有一系列勾选框,**正确的勾法**:

| 类别 | 勾选 |
|---|---|
| Personally identifiable information | ❌ 不勾 |
| Health information | ❌ |
| Financial and payment information | ❌ |
| Authentication information | ❌ |
| Personal communications | ❌ |
| Location | ❌ |
| Web history | ❌ |
| User activity (clicks, keystrokes) | ✅ **勾**(因为我们记录最近 30 个操作轨迹) |
| Website content | ✅ **勾**(因为我们读响应体) |

对应说明:

**User activity**(为什么收集):
```
We record the last 30 user actions (clicks, inputs, navigation events)
locally in the browser to help users explain "what they just did" when
reporting an issue. Input values are NOT collected — we only record the
element selector and the character length. Password fields are entirely
skipped. Data is never transmitted; it only appears in reports the user
explicitly exports.
```

**Website content**(为什么收集):
```
We capture HTTP request/response metadata (URL, method, status, timing)
and response bodies (truncated to 64KB) to detect business-layer
failures (HTTP 200 but error in JSON body) and to provide the
developer with enough context to reproduce reported issues. All
data is held in browser memory and only leaves the device if the user
clicks "Copy" or "Download".
```

---

## 三个必勾的承诺(must check)

提交时表单底部有三个 confirmation:

✅ "I do not sell or transfer user data to third parties"
✅ "I do not use or transfer user data for purposes unrelated to my item's single purpose"
✅ "I do not use or transfer user data to determine creditworthiness or for lending purposes"

全部勾,因为我们就是不做。
