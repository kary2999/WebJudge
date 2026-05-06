# Judge — 页面性能体检 Chrome 扩展

给同事装上,**打开慢页面 → 点一下扩展图标 → 复制摘要到工单**。

## 核心能力

### 1. 前端静态 / 后端接口 分开统计
- 前端静态:`script` / `css` / `img` / `font` / `media`
- 后端接口:`fetch` / `xhr`
- 分别显示数量、传输体积、总耗时

### 2. 慢接口排名(>1s,耗时倒序)
每条接口标明慢的原因:

| 标签 | 含义 |
|---|---|
| `后端慢` | server time / duration > 70% — 后端 SQL/缓存问题 |
| `被浏览器排队` | 同域 ≥6 个并发 + queue 时间大 — 前端问题 |
| `前端开销` | 后端 `extend.runtime` 快但实测慢 — 浏览器网络/JS 问题 |
| `下载耗时` | 传输占 duration > 50% — 资源太大 |
| `综合` | 都沾一点 |

### 3. 捕获后端响应 & extend.runtime 对账
在主世界 hook 了 `fetch` 和 `XMLHttpRequest`,对每个接口都解析响应体:

```json
{
  "extend": {
    "date": "2026-04-18 01:38:10",
    "unique": "69e27002b031d120218672",
    "runtime": "171.62 ms"
  }
}
```

计算 `Δ = 前端实测 - 后端 runtime`:
- `Δ > 300ms` → 进"runtime 失配"表 — 后端自报快、前端慢、差距来自**网络 + 浏览器队列 + 前端 JS**
- 可根据 `extend.unique` 直接到后端日志里对应链路

### 4. 状态异常接口(status ≠ 2xx)
独立一张表,**优先修**。包含:
- HTTP method / status / statusText
- `extend.runtime` / `extend.unique`
- 响应体片段(前 400 字符)

### 5. Web Vitals
LCP / FCP / CLS / INP / TTFB / Long Tasks — 遵循 Google 门槛着色

### 6. 导出
- **复制摘要** → 粘贴到工单 / 群聊(纯文本)
- **下载 JSON** → 完整报告含所有慢接口/失败接口的响应体、extend、时序数据
- **导出 PDF** → 报告页调浏览器打印,在弹窗里选"另存为 PDF"

## 安装

1. `chrome://extensions/`
2. 右上角开启"开发者模式"
3. 点"加载已解压的扩展程序"
4. 选目录 `/Users/admin/Desktop/work/Code/Tool/Judge`

## 使用流程

1. 打开要分析的页面(**刷新一次**让扩展能采集完整时序)
2. 页面做你觉得慢的操作(点按钮、切 tab 等)
3. 点工具栏上 Judge 图标
4. popup 里看概览;点"生成完整报告"打开详情页
5. 详情页有 3 个导出按钮

## 目录结构

```
Judge/
  manifest.json      # MV3 清单,双 content script
  inject.js          # MAIN world:hook fetch/XHR,捕获响应体和 extend
  content.js         # 隔离 world:Vitals + 关联分析 + 生成报告
  background.js      # 打开报告页时做 payload 中转
  popup.html/css/js  # 弹窗 UI
  report.html/css/js # 完整报告页 (含 @media print 样式支持导出 PDF)
  icons/
  README.md
```

## 数据流

```
页面 JS 发请求
      ↓
inject.js (MAIN)  ← hook fetch/XHR,读响应体
      ↓  CustomEvent
content.js (isolated)  ← 收集 + 和 Resource Timing 关联
      ↓
Performance API (Vitals / Resource Timing)
      ↓
popup.js / report.js  → JSON / PDF / 剪贴板
```

## 核心算法:区分"真慢" vs "被前端排队" vs "前端开销"

```
if 后端 runtime 已知 and Δ > 300ms and Δ > 后端 runtime:
    同源并发 ≥ 6 且 queue 大 → browser-queue
    否则                      → frontend-overhead
elif 同源并发 ≥ 6 且 queue - (DNS+TCP+SSL) > 100ms:
    → browser-queue
elif server time / duration > 70%:
    → backend-slow
elif download time / duration > 50%:
    → download-heavy
else:
    → mixed
```

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` | 读当前标签页的 Performance API |
| `scripting` | 兜底注入 content.js |
| `storage` | 弹窗 → 报告页传递 payload |
| `clipboardWrite` | "复制摘要" |
| `downloads` | "下载 JSON" |
| `host_permissions: <all_urls>` | content_script 匹配所有站点 |

**不使用** `webRequest`,不做任何外部上报,所有分析在本地完成。

## 限制

- 跨域无 `Timing-Allow-Origin` 头的资源:`duration` 为 0(忽略)
- 响应体捕获上限 64KB,超出截断;报告里只保留前 4000 字符
- `INP` 需真实交互过才有值
- 纯 `<script>`/`<img>` 初始化的资源不经过 fetch/XHR,不会有 `extend` 解析
- Service Worker 拦截的请求:`transferSize=0` 正常;inject.js 仍能拿响应体

## 版本

- v0.2.0 (2026-04-18)
  - 新增:前后端分类
  - 新增:fetch/XHR hook 捕获响应体与 `extend` 字段
  - 新增:runtime 失配检测(后端报时 vs 前端实测)
  - 新增:状态异常接口独立表
  - 新增:PDF 导出 + 打印友好样式
  - 重命名:Perf Inspector → Judge
- v0.1.0 - 基础 Web Vitals + 慢接口排名 + 浏览器排队检测
