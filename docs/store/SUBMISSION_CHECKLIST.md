# Chrome Web Store 上架 — 完整 Checklist

按顺序做。打 ✓ 表示已完成。

---

## 阶段 1:账号 + 付费(15 分钟,**唯一花钱的步骤**)

- [ ] 用 Google 账号(建议 Gmail,不要用国内 Workspace 公司账号 — 经常被风控)登录:
      https://chrome.google.com/webstore/devconsole/
- [ ] 同意开发者协议
- [ ] **支付 USD $5 一次性注册费**
      - 必须海外信用卡(Visa / MasterCard / Amex 都行)
      - 不接受 PayPal、不接受国内双币卡的部分卡 BIN
      - 不通过的话:借同事的、或注册一张零佣金海外卡(WildCard / Nobepay 等)
- [ ] 通过身份核验(Google 可能要求电话短信验证)

> 💡 这一步是**最容易卡 1-2 周**的环节,如果你公司没人有海外卡。提前办。

---

## 阶段 2:发布物准备(2 小时)

### 2.1 ZIP 包(直接用现有的)

- [x] `dist/judge-v0.10.1.zip` 已经是合规的 MV3 包
- [ ] **重要**:上传前再检查一次 manifest.json 里:
  - `name` 不要带"Chrome"、"Google" 等品牌词(会被自动拒)
  - `description` 132 字以内
  - `version` 必须语义化版本(0.10.1 ✓)

### 2.2 隐私政策托管

- [ ] 把 `docs/store/PRIVACY_POLICY.md` 转成 HTML 或直接 MD 渲染成网页
- [ ] **托管到一个公开 URL**(三个最简单的选项):

  **选项 A:GitHub Pages**(免费,推荐)
  ```
  1. 创建 GitHub 公开仓库 judge-extension-docs
  2. 仓库根目录建 index.html(粘贴 PRIVACY_POLICY.md 渲染后的 HTML)
  3. Settings → Pages → 启用,会得到形如:
     https://你的用户名.github.io/judge-extension-docs/
  ```

  **选项 B:公司官网或现有网站子目录**
  ```
  你们公司有个静态网站?在 /privacy/judge.html 挂一份就行
  ```

  **选项 C:第三方静态托管**(Cloudflare Pages / Netlify / Vercel,5 分钟搞定)

- [ ] 隐私政策 URL 必须满足:
  - HTTPS(必须 SSL)
  - 匿名访问(审核员不会登录)
  - 持续可达(挂掉 = 你扩展会被下架)
- [ ] 把 URL 填到 `docs/store/PRIVACY_POLICY_URL.txt` 备查

### 2.3 商店素材

| 素材 | 尺寸 | 必须? | 备注 |
|---|---|---|---|
| 应用图标 | 128×128 PNG | ✅ | 已有 `icons/icon128.png` |
| 商店截图 | 1280×800 或 640×400 | ✅ 至少 1 张,最多 5 张 | 见下文 |
| 小宣传图 | 440×280 PNG | 可选 | 强烈建议做,不做的话商店列表里图标显得很小气 |
| 大宣传图 | 920×680 PNG | 可选 | 出现在搜索结果"精选位",建议做 |
| 候选图 | 1400×560 PNG | 可选 | 仅 Google 编辑精选时才用,可不做 |
| YouTube 演示 | URL | 可选 | 录一个 30 秒"装上 → 点 → 看报告"的 GIF/视频 |

### 2.4 截图怎么做(5 张推荐)

每张 1280×800,带说明文字 overlay:

1. **弹窗主界面截图** — 显示评分环 / Vital / 慢接口
   - 在一个真实繁忙的页面上跑 Judge,截弹窗
   - 标题:"一键诊断网页性能"

2. **完整报告页截图** — 显示业务失败、慢接口表
   - 标题:"开发同学需要的全部数据"

3. **PDF 报告截图** — 第一页 + 业务失败详情那页
   - 标题:"可发邮件 / 工单的 PDF"

4. **慢因分类标签** — 显示 5 类标签的不同接口
   - 标题:"自动判断:后端慢 / 网络拥塞 / 前端排队"

5. **隐私承诺图** — 一张文字海报
   - 标题:"零数据上传 · 完全本地分析"

详细生成办法见 `SCREENSHOTS.md`。

---

## 阶段 3:填写表单(30 分钟,真正提交)

去 https://chrome.google.com/webstore/devconsole/ → "+ New Item" → 上传 zip

### Store listing(商店列表)

- [ ] **Description**:粘贴 `LISTING.zh.md` 里的"详细说明"
- [ ] **Category**:选 `Developer Tools`
- [ ] **Language**:加 `Chinese (Simplified)` + `English`
- [ ] **Store icon**:上传 128×128
- [ ] **Screenshots**:上传 1-5 张
- [ ] **Promotional images**:可选,上传你做的小/大宣传图

### Privacy

- [ ] **Privacy policy URL**:填 2.2 拿到的公开 URL
- [ ] **Single purpose**:粘贴 `PERMISSIONS.md` 第一段
- [ ] **Permission justifications**:每个权限粘对应段落
- [ ] **Data usage**:按 `PERMISSIONS.md` 里的 ✅/❌ 表勾选
- [ ] **Confirm 三条声明**:全部勾

### Distribution(分发)

- [ ] **Visibility**:
  - `Public` — 任何人都能搜到
  - `Unlisted` — 只能通过链接访问(**推荐先选这个,审核压力小**)
  - `Private` — 仅限你 Google Group 内成员
- [ ] **Regions**:全部国家(默认),或选定中国大陆 + 美国
- [ ] **Pricing**:Free

---

## 阶段 4:提交 + 等审核

- [ ] 点 "Submit for review"
- [ ] **审核期**:3-7 个工作日(权限广的扩展通常 5-10 天)
- [ ] 审核结果:
  - ✅ Approved → 几小时内出现在商店
  - ❌ Rejected → 邮件附拒绝原因。**90% 的拒绝可修复**:
    - 最常见:权限说明不够具体 → 改 `PERMISSIONS.md` 重提
    - 第二常见:隐私政策 URL 失效 / 内容不全 → 修网页
    - 第三常见:截图模糊或不真实 → 重做

---

## 阶段 5:发布后维护

- [ ] 收藏后台 dashboard,每周看一次评论 / 评分
- [ ] 用户报 bug → 你的 manifest.json 里**邮箱字段**(可选填)是入口
- [ ] 提交新版本前在 `version` 字段 bump(0.10.1 → 0.10.2 → ...)

---

## 风险 / 万一被拒怎么办

| 拒绝原因 | 怎么改 |
|---|---|
| "Excessive permissions" | 把 host_permissions 改成 `optional_host_permissions`,运行时让用户点"Allow on this site" 才请求权限 — 这会破坏现在的零摩擦体验,慎重 |
| "Privacy policy missing" | URL 挂了 / 内容不全 |
| "Code injects into page" | 在 `PERMISSIONS.md` 的 scripting justification 里加更详细的"为什么必须 MAIN world" |
| "Spam keywords" | 检查描述里是不是堆了太多关键词 |
| "Single purpose" | 缩小 description 里的功能列表,集中讲一件事(性能诊断) |

---

## 完整文件清单(所有审核要的材料都在这)

```
docs/store/
├── LISTING.zh.md             ← 中文商店描述
├── LISTING.en.md             ← 英文商店描述
├── PRIVACY_POLICY.md         ← 隐私政策(必须挂公网 URL)
├── PERMISSIONS.md            ← 给审核员看的权限说明
├── SUBMISSION_CHECKLIST.md   ← 本文件
└── SCREENSHOTS.md            ← 截图生成指南
```

提交前,`PRIVACY_POLICY_URL.txt` 也建一下,记上你挂出来的真实 URL。
