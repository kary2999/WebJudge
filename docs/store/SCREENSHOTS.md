# 商店截图制作指南

Chrome Web Store 要求 **1-5 张截图**,**1280×800** 或 **640×400**(都用 1280×800,清晰度更高)。

下面给你两条路 — 选一条:

---

## 路径 A:用真实数据截图(推荐,审核通过率高)

### 准备(15 分钟)

1. 装 v0.10.1 扩展到本地 Chrome
2. 打开任一**真实繁忙**的网页(你公司后台、你常逛的网站、新浪首页)
3. 按 F5 刷新,等加载完
4. 点扩展图标 → 看到 popup
5. 点"完整报告"打开报告页
6. 点"下载 PDF 报告"得到 PDF

### 5 张截图怎么截

#### 截图 1:popup 主界面
- 在浏览器右上角,扩展图标弹出的小窗
- 用 macOS 的 `Cmd+Shift+4` 框选,或 Windows 的 `Snipping Tool`
- 截下来后用 Preview / Photos 把图**居中放到 1280×800 的白底画布上**
- 顶部加大字标题:**「一键诊断网页性能」**

#### 截图 2:完整报告页 — 顶部 hero 评分区
- 截"性能体检报告"标题 + 评分环 + 三个统计卡
- 加标题:**「网络评分 + 关键统计一屏看懂」**

#### 截图 3:慢接口 + 业务失败
- 滚到"慢接口"和"业务层失败"两个 section
- 标题:**「自动判定:后端慢 / 网络拥塞 / 业务失败」**

#### 截图 4:操作轨迹 + JS 异常
- 滚到这两个 section
- 标题:**「同事忘了点过什么?这里能找到」**

#### 截图 5:PDF 报告预览
- 用 PDF 阅读器打开你下载的 PDF
- 截首页 + 业务失败那页(可以拼接两页)
- 标题:**「可发邮件 / 工单的完整 PDF」**

### 加 overlay 的工具

Mac:Preview 自带的"显示标记工具栏" → 文字工具
跨平台免费:**Figma**(画 1280×800 画布,贴截图,加文字,导出 PNG)

---

## 路径 B:全用 mockup(不真实数据,稍微"造")

如果你不方便找真实数据,我已经帮你生成过一份高保真 mockup 在 `docs/ui-mockup.html`。
直接 Chrome 打开,框选 popup / report 等区域截图,加 overlay 文字。

```bash
open -a "Google Chrome" /Users/admin/Desktop/work/Code/Tool/Judge/docs/ui-mockup.html
```

也可用 headless 自动出图:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1280,800 \
  --screenshot=screenshot1.png \
  file:///Users/admin/Desktop/work/Code/Tool/Judge/docs/ui-mockup.html
```

---

## 截图常见错误(审核会被拒)

❌ 用了"Chrome"、"Google" 字样,或带 Google logo
❌ 文字模糊,小于 1280×800 后强行拉大
❌ 边角带其他扩展、个人信息(地址栏 URL 暴露隐私)
❌ 截图里有"这是个 mock 不是真实"字样(显得不专业)
❌ 加了夸张红字"WOW! AMAZING!" 之类(被认为是 spam)

✅ 1280×800,白底或浅灰底
✅ 顶部 1 行简洁标题(中文 ≤ 20 字)
✅ 主体是真实的 popup / 报告截图,清晰
✅ 风格统一(同一字体、同一颜色)
