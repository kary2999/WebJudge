<div align="center">

# Judge — 页面性能体检

**让"系统好慢啊"变成一份开发同学能立刻定位的诊断报告**

Chrome 扩展 · 完全免费 · 零数据上传 · [安装指南](#安装) · [隐私政策](https://kary2999.github.io/WebJudge/docs/store/privacy-policy.html)

</div>

---

## 解决什么问题

> 同事说"后台好卡"，开发问"哪个接口慢？网络还是后端？" 同事说"不知道"。
> 
> 工单挂了三天没人领。

**Judge 就是为了干掉这种低效沟通。**

装上扩展 → 打开慢页面 → 点一下图标 → 自动生成带数据的诊断报告 → 发给开发。

---

## 你一定遇到过这些场景

| 痛点 | 现状 | 装了 Judge 之后 |
|---|---|---|
| **"系统好慢啊"** | 开发无法复现，不知道慢在哪 | 报告直接列出慢接口 Top N + 耗时 |
| **前端后端互相甩锅** | "接口 2 秒" / "我日志才 50ms" | 自动归因：后端慢 / 网络差 / 浏览器排队 |
| **HTTP 200 但页面白屏** | 监控没告警，状态码都是 200 | 自动检测 JSON 业务状态码异常 |
| **"我也不知道点了什么就卡了"** | 来回沟通 5 轮才定位操作路径 | 自动记录最近 30 次操作轨迹 |
| **用户网差却说系统有问题** | 排查半天发现是 VPN 只有 0.5Mbps | 网络环境 0-100 评分，客观判定 |
| **让非技术人员开 F12？** | "什么是 F12？" | 点一下图标就行，不用 DevTools |

---

## 核心功能

### 诊断分析
- **慢接口 Top N 排名** — 按耗时倒序，每条标注原因
- **5 类归因标签** — `后端慢` / `网络拥塞` / `首次连接` / `浏览器排队` / `响应过大`
- **前后端责任判定** — Resource Timing + 服务端 extend.runtime 交叉验证

### 异常检测
- **业务层失败** — HTTP 200 但 JSON biz.status 异常，自动识别
- **HTTP 状态异常** — 4xx / 5xx / 超时，含响应体片段
- **JS 运行时异常** — window.onerror + unhandledrejection + 资源加载失败

### 环境评估
- **网络评分 0-100** — 综合带宽 / RTT / 丢包的客观分数
- **Web Vitals** — LCP / FCP / CLS / INP / TTFB，好 / 中 / 差三档
- **域名 Ping 实测** — 对每个 API 域名发探测请求，测实际 RTT

### 行为追踪
- **用户操作轨迹** — 最近 30 次点击 / 输入 / 路由跳转（不记录密码）
- **iframe 支持** — 后台管理系统多框架数据自动合并

### 报告导出
- **一键 PDF** — 带 IP 水印的完整诊断报告，直接粘到工单
- **复制摘要** — 纯文本摘要，粘到群聊或 IM
- **完整网页报告** — 可交互的详情页，支持点击展开响应体
- **被动 Badge** — 页面出现异常时图标自动亮红 / 琥珀角标

---

## 安装

### 方式一：Chrome Web Store（审核中）

上架后直接搜索 **"Judge 页面性能体检"** 安装。

### 方式二：本地加载（开发者模式）

1. [下载最新 ZIP](https://github.com/kary2999/WebJudge/raw/main/dist/judge-latest.zip) 并解压
2. 打开 Chrome → 地址栏输入 `chrome://extensions/`
3. 右上角开启 **开发者模式**
4. 点 **加载已解压的扩展程序** → 选解压后的文件夹
5. 完成！工具栏出现 Judge 图标

---

## 使用方法

```
3 步出报告：

  1. 打开慢页面，F5 刷新一次
  2. 正常操作，复现卡顿
  3. 点工具栏 Judge 图标 → 看诊断 / 下载 PDF
```

---

## 技术架构

```
页面 JS 发请求
      ↓
inject.js (MAIN world)    ← hook fetch/XHR，捕获响应体 + extend 字段
      ↓ CustomEvent
content.js (isolated)     ← 收集 Vitals + 操作轨迹 + JS 异常
      ↓
analyzer.js               ← 多 frame 合并 + 时序分析 + 5 类归因
      ↓
popup.js / report.js      → PDF / 摘要 / 完整报告
```

### 慢接口归因算法

```
if 后端 runtime 已知 and Δ > 300ms:
    同源并发 ≥ 6 且 queue 大 → 浏览器排队
    否则                      → 前端开销
elif 同源并发 ≥ 6 且 queue > 100ms:
    → 浏览器排队
elif server time / duration > 70%:
    → 后端慢
elif download time / duration > 50%:
    → 响应过大
else:
    → 综合因素
```

---

## 权限说明

| 权限 | 用途 |
|---|---|
| `activeTab` | 点击图标时读当前页 Performance API |
| `scripting` | 注入分析脚本到所有 frame |
| `storage` | 弹窗 → 报告页传递数据（1 小时自动清理） |
| `clipboardWrite` | "复制摘要"按钮 |
| `downloads` | "下载 PDF/JSON"按钮 |
| `<all_urls>` | 用户可能在任意网站使用 |

**不使用的权限**：❌ webRequest · ❌ cookies · ❌ history · ❌ tabs

---

## 隐私承诺

- 所有分析在浏览器本地完成
- **不向任何服务器发送数据**
- 不读 cookie / localStorage / 密码框
- 关闭标签页数据立即释放
- 没有任何埋点或遥测
- 代码完全开源可审查
- Manifest V3 沙箱化运行

唯一外部请求：生成 PDF 时可选查询公网 IP（用于水印），失败则跳过。

[查看完整隐私政策 →](https://kary2999.github.io/WebJudge/docs/store/privacy-policy.html)

---

## 项目结构

```
Judge/
├── manifest.json        # MV3 清单
├── inject.js            # MAIN world：hook fetch/XHR
├── content.js           # 隔离 world：Vitals + 轨迹 + 异常
├── analyzer.js          # 核心分析引擎
├── background.js        # Badge 计数 + 报告页中转
├── popup.html/css/js    # 弹窗 UI
├── report.html/css/js   # 完整报告页
├── pdf.js               # Canvas → PDF 渲染器
├── pdf-report.js        # PDF 报告内容构建
├── tokens.css           # Indigo 设计令牌
├── icons/               # 扩展图标
├── dist/                # 历史构建包
└── docs/                # 文档 + 商店素材
```

---

## 版本历史

| 版本 | 更新内容 |
|---|---|
| **v0.10.1** | HTTP 异常 + runtime 失配展开为完整详情（含响应体） |
| **v0.10.0** | Indigo 视觉重构 + Badge 被动告警 + 域名 Ping 实测 |
| **v0.9.0** | 用户操作轨迹 + JS 异常捕获 + iframe 多框架支持 |
| **v0.8.1** | 5 类慢接口归因 + 网络评分 0-100 + 一键 PDF 导出 |

---

## 联系

- **邮箱**：kary372022@gmail.com
- **Issues**：[GitHub Issues](https://github.com/kary2999/WebJudge/issues)

---

<div align="center">
<sub>Judge 是个独立维护的小项目，不收集你任何数据，只是想让"系统好慢啊"这种工单变得可定位。</sub>
</div>
