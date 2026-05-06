// pdf.js — 自包含的 PDF 生成器。
// 不依赖 jsPDF / html2canvas:每一页在 Canvas 上手绘(支持中文,走浏览器字体栈),
// 导出 JPEG,直接塞进一个最小合规的 PDF 1.4 字节流。
// 体积 < 20KB,CSP 友好。
//
// 用法:
//   const r = new PdfRenderer({ watermark: '1.2.3.4' });
//   r.h1('页面性能体检报告');
//   r.kv([['URL', '...'], ['时间', '...']]);
//   r.h2('业务层失败');
//   r.apiDetail(row);
//   r.h2('慢接口列表');
//   r.table(['#','URL','耗时'], rows);
//   const blob = await r.finalize();   // → application/pdf Blob
//
// 设计:
//   - 页面 A4 (595×842 pt, 72 DPI)
//   - 2× HiDPI canvas,所有坐标用 pt(ctx.scale 处理)
//   - 自动分页:任何绘制前检查剩余高度,不够就 newPage()
//   - 水印:每页右上角,固定 30% 透明度,红色粗体
//   - PDF 结构:Catalog + Pages + 每页 {Page, Image(JPEG), ContentStream}
//
// 中文换行:CJK 无空格,按字符切;ASCII 段按单词切。

(function (global) {
  'use strict';

  const A4 = { w: 595, h: 842 };

  // -------- Canvas 渲染器 --------

  class PdfRenderer {
    constructor(opts) {
      opts = opts || {};
      this.pageW = opts.pageW || A4.w;
      this.pageH = opts.pageH || A4.h;
      this.marginX = opts.marginX || 40;
      this.marginTop = opts.marginTop || 56;    // 顶部留出水印位置
      this.marginBottom = opts.marginBottom || 48;
      this.scale = opts.scale || 2;             // HiDPI
      this.watermark = opts.watermark || '';
      this.pageNumber = 0;
      this.pages = [];                          // Canvas[]
      this.canvas = null;
      this.ctx = null;
      this.y = 0;
      this.usableW = this.pageW - this.marginX * 2;
      this.baseFontFamily = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';
      this.monoFamily = '"SF Mono", "Menlo", "Consolas", "Courier New", monospace';
      this._newPage();
    }

    // ----- 页面管理 -----
    _newPage() {
      this.pageNumber += 1;
      const c = document.createElement('canvas');
      c.width = Math.round(this.pageW * this.scale);
      c.height = Math.round(this.pageH * this.scale);
      const ctx = c.getContext('2d');
      ctx.scale(this.scale, this.scale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.pageW, this.pageH);
      this.canvas = c;
      this.ctx = ctx;
      this.pages.push(c);
      this.y = this.marginTop;
      this._drawWatermark();
      this._drawPageHeader();
    }

    _drawWatermark() {
      if (!this.watermark) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#cf222e';
      ctx.font = `bold 11px ${this.monoFamily}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`IP  ${this.watermark}`, this.pageW - this.marginX, 18);
      ctx.restore();
    }

    _drawPageHeader() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#8c959f';
      ctx.font = `9px ${this.baseFontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`Judge 性能体检`, this.marginX, 18);
      // 页码放在页脚
      ctx.textAlign = 'center';
      ctx.fillText(`— ${this.pageNumber} —`, this.pageW / 2, this.pageH - 24);
      ctx.restore();
    }

    _ensure(need) {
      if (this.y + need > this.pageH - this.marginBottom) this._newPage();
    }

    // ----- 底层文字工具 -----
    _measure(text, font) {
      this.ctx.font = font;
      return this.ctx.measureText(text).width;
    }

    // 对 CJK 混排友好的换行:超过 maxW 就强制切字符
    _wrap(text, maxW, font) {
      const ctx = this.ctx;
      ctx.font = font;
      const out = [];
      const paragraphs = String(text == null ? '' : text).split('\n');
      for (const para of paragraphs) {
        if (ctx.measureText(para).width <= maxW) { out.push(para); continue; }
        let cur = '';
        // 用 Array.from 把字符串拆成 code point 数组(正确处理 emoji / CJK)
        for (const ch of Array.from(para)) {
          const test = cur + ch;
          if (ctx.measureText(test).width > maxW && cur) {
            out.push(cur);
            cur = ch;
          } else {
            cur = test;
          }
        }
        if (cur) out.push(cur);
      }
      return out;
    }

    _drawLines(lines, opts) {
      const { x, font, color, lineH } = opts;
      for (const line of lines) {
        this._ensure(lineH);
        // 每次 fillText 前重设状态:防止 _ensure 触发 _newPage 切换 ctx 后
        // 新 canvas 的 font / fillStyle / textBaseline 还是默认值,导致文字错位
        this.ctx.font = font;
        this.ctx.fillStyle = color;
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(line, x, this.y);
        this.y += lineH;
      }
    }

    // ----- 公共 API -----
    spacer(h) { this._ensure(h || 6); this.y += (h || 6); }

    h1(text) {
      this._ensure(34);
      const font = `bold 20px ${this.baseFontFamily}`;
      this._drawLines(this._wrap(text, this.usableW, font),
        { x: this.marginX, font, color: '#1f2328', lineH: 26 });
      this.spacer(6);
      // 分隔线
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = '#d0d7de';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(this.marginX, this.y);
      ctx.lineTo(this.pageW - this.marginX, this.y);
      ctx.stroke();
      ctx.restore();
      this.spacer(10);
    }

    h2(text, opts) {
      opts = opts || {};
      const font = `bold 14px ${this.baseFontFamily}`;
      // 先预估整块高度(色条 + 可能两行标题),保证不被切半
      const lines = (() => {
        this.ctx.font = font;
        return this._wrap(text, this.usableW - 10, font);
      })();
      const needed = lines.length * 20 + 10;
      this._ensure(needed);
      // 色条(画在 _ensure 之后,确保 ctx 是当前页的)
      const ctx = this.ctx;
      const barColor = opts.color || '#0969da';
      ctx.save();
      ctx.fillStyle = barColor;
      ctx.fillRect(this.marginX, this.y + 2, 3, 16);
      ctx.restore();
      this._drawLines(lines, { x: this.marginX + 10, font, color: '#1f2328', lineH: 20 });
      this.spacer(4);
    }

    h3(text) {
      this._ensure(20);
      const font = `bold 12px ${this.baseFontFamily}`;
      this._drawLines(this._wrap(text, this.usableW, font),
        { x: this.marginX, font, color: '#57606a', lineH: 16 });
      this.spacer(2);
    }

    // 普通段落
    p(text, opts) {
      opts = opts || {};
      const font = `${opts.size || 10}px ${opts.mono ? this.monoFamily : this.baseFontFamily}`;
      this._drawLines(this._wrap(text, this.usableW, font),
        { x: this.marginX, font, color: opts.color || '#1f2328', lineH: (opts.size || 10) + 4 });
    }

    muted(text) { this.p(text, { color: '#8c959f', size: 9 }); }

    // 标签色块
    badge(text, color, bgColor, x, y) {
      const ctx = this.ctx;
      const font = `bold 9px ${this.baseFontFamily}`;
      ctx.font = font;
      const w = ctx.measureText(text).width + 10;
      const h = 14;
      ctx.save();
      ctx.fillStyle = bgColor;
      this._roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
      ctx.restore();
      return w;
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    // key-value 列表(两列)
    kv(pairs) {
      const colGap = 14;
      const colW = (this.usableW - colGap) / 2;
      const font = `10px ${this.baseFontFamily}`;
      const lineH = 16;
      const rowH = 20;
      const rows = Math.ceil(pairs.length / 2);
      for (let r = 0; r < rows; r++) {
        this._ensure(rowH);
        const a = pairs[r * 2];
        const b = pairs[r * 2 + 1];
        // 关键:_ensure 后 this.ctx 可能已换(分页),传入 this.ctx 每次现拿
        this._drawKvOne(a, this.marginX, this.y, colW, font);
        if (b) this._drawKvOne(b, this.marginX + colW + colGap, this.y, colW, font);
        this.y += rowH;
      }
    }

    _drawKvOne(pair, x, y, w, font) {
      if (!pair) return;
      const [k, v] = pair;
      const ctx = this.ctx; // 始终现拿,不缓存
      ctx.save();
      ctx.font = font;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#57606a';
      ctx.fillText(String(k), x, y + 2);
      ctx.fillStyle = '#1f2328';
      ctx.textAlign = 'right';
      const valStr = String(v == null ? '—' : v);
      const keyW = ctx.measureText(String(k)).width;
      const maxValW = w - keyW - 10;
      if (ctx.measureText(valStr).width <= maxValW) {
        ctx.fillText(valStr, x + w, y + 2);
      } else {
        ctx.textAlign = 'left';
        let s = valStr;
        while (s && ctx.measureText(s + '…').width > maxValW - 2) s = s.slice(0, -1);
        ctx.fillText(s + '…', x + w - ctx.measureText(s + '…').width, y + 2);
      }
      ctx.restore();
    }

    // 表格
    table(headers, rows, columnRatios) {
      const totalW = this.usableW;
      const ratios = columnRatios || headers.map(() => 1);
      const ratioSum = ratios.reduce((a, b) => a + b, 0);
      const widths = ratios.map((r) => (r / ratioSum) * totalW);
      const cellPadX = 4;
      const cellPadY = 5;
      const headerH = 22;
      const rowFont = `9.5px ${this.baseFontFamily}`;
      const headerFont = `bold 9.5px ${this.baseFontFamily}`;
      // !!!! 关键修复 !!!! drawHeader 是闭包,会在分页后再次被调用。
      // 之前在这里缓存了 const ctx = this.ctx,导致分页后 drawHeader 画在旧页 canvas 上
      // (旧页已 push 进 this.pages,会被后面序列化为 JPEG),于是"幽灵表头"
      // 出现在其他 section 的内容上方,把文字挤叠。绝不缓存 ctx !!

      const drawHeader = () => {
        this._ensure(headerH);
        const c = this.ctx; // 每次调用时现取
        c.save();
        c.fillStyle = '#f6f8fa';
        c.fillRect(this.marginX, this.y, totalW, headerH);
        c.strokeStyle = '#d0d7de';
        c.lineWidth = 0.5;
        c.strokeRect(this.marginX, this.y, totalW, headerH);
        c.font = headerFont;
        c.fillStyle = '#57606a';
        c.textBaseline = 'middle';
        c.textAlign = 'left';
        let cx = this.marginX;
        for (let i = 0; i < headers.length; i++) {
          c.fillText(String(headers[i]), cx + cellPadX, this.y + headerH / 2);
          cx += widths[i];
        }
        c.restore();
        this.y += headerH;
      };

      drawHeader();

      if (!rows || rows.length === 0) {
        const h = 24;
        this._ensure(h);
        const c = this.ctx;
        c.save();
        c.strokeStyle = '#d0d7de'; c.lineWidth = 0.5;
        c.strokeRect(this.marginX, this.y, totalW, h);
        c.font = rowFont;
        c.fillStyle = '#8c959f';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('(无)', this.marginX + totalW / 2, this.y + h / 2);
        c.restore();
        this.y += h;
        this.spacer(8);
        return;
      }

      for (const r of rows) {
        // Measure cell heights using the CURRENT ctx (measurements are ctx-local)
        this.ctx.font = rowFont;
        const cellLines = r.map((cell, i) => this._wrap(String(cell == null ? '' : cell), widths[i] - cellPadX * 2, rowFont));
        const maxLines = cellLines.reduce((m, L) => Math.max(m, L.length), 1);
        const rowH = Math.max(18, maxLines * 12 + cellPadY * 2);

        // 分页前先画表头以便续接
        if (this.y + rowH > this.pageH - this.marginBottom) {
          this._newPage();
          drawHeader();
        }

        // !!! 关键:每行开始时重新拿 ctx,因为上面 _newPage 已经把 ctx 换了 !!!
        const c = this.ctx;
        c.save();
        c.strokeStyle = '#eaecef';
        c.lineWidth = 0.4;
        c.strokeRect(this.marginX, this.y, totalW, rowH);
        let cx = this.marginX;
        for (let i = 0; i < headers.length; i++) {
          c.fillStyle = '#1f2328';
          c.font = rowFont;
          c.textBaseline = 'top';
          c.textAlign = 'left';
          const lines = cellLines[i] || [''];
          let ty = this.y + cellPadY;
          for (const line of lines) {
            c.fillText(line, cx + cellPadX, ty);
            ty += 12;
          }
          cx += widths[i];
        }
        c.restore();
        this.y += rowH;
      }
      this.spacer(10);
    }

    // biz 失败接口的详细块 —— 不再渲染 JSON 响应体,完整响应体请参考
    // 下载的 JSON 报告。这里只保留关键排查信息:状态/时序/extend/业务 message。
    apiDetail(row) {
      this._ensure(70);
      const ctx = this.ctx;
      const method = String(row.method || row.initiator || '—').toUpperCase();
      const httpText = row.status != null ? `HTTP ${row.status}` : 'HTTP —';
      const bizText = (row.biz && row.biz.status != null) ? `biz.status=${row.biz.status}` : 'biz.status=—';

      let x = this.marginX + 10;
      const startY = this.y;
      ctx.save();
      ctx.fillStyle = '#cf222e';
      ctx.fillRect(this.marginX, startY, 3, 18);
      ctx.restore();
      x += this.badge(method, '#ffffff', '#57606a', x, startY + 2);
      x += 4;
      const httpBg = (row.status >= 200 && row.status < 300) ? '#dafbe1'
                    : (row.status >= 300 && row.status < 400) ? '#fff8c5'
                    : '#ffebe9';
      const httpFg = (row.status >= 200 && row.status < 300) ? '#1a7f37'
                    : (row.status >= 300 && row.status < 400) ? '#9a6700'
                    : '#cf222e';
      x += this.badge(httpText, httpFg, httpBg, x, startY + 2);
      x += 4;
      x += this.badge(bizText, '#cf222e', '#ffebe9', x, startY + 2);
      this.y += 22;

      this.p(row.url || '', { size: 9, mono: true, color: '#0550ae' });
      this.spacer(3);

      // 核心时序 + extend 标识
      const timing = [
        ['实测耗时', (row.duration != null ? Math.round(row.duration) + ' ms' : '—')],
        ['后端 runtime', (row.serverReportedRuntimeMs != null ? Math.round(row.serverReportedRuntimeMs) + ' ms' : '—')],
        ['Δ 差值', (row.runtimeDelta != null ? (row.runtimeDelta > 0 ? '+' : '') + Math.round(row.runtimeDelta) + ' ms' : '—')],
        ['TTFB', (row.serverTime != null ? Math.round(row.serverTime) + ' ms' : '—')],
        ['队列等待', (row.queueTime != null ? Math.round(row.queueTime) + ' ms' : '—')],
        ['下载耗时', (row.downloadTime != null ? Math.round(row.downloadTime) + ' ms' : '—')],
        ['extend.date', (row.extend && row.extend.date) || '—'],
        ['extend.unique', (row.extend && row.extend.unique) || '—'],
      ];
      this.kv(timing);

      if (row.biz) {
        this.h3('业务层信息');
        const msg = row.biz.message || '—';
        this.kv([
          ['biz.status', row.biz.status != null ? String(row.biz.status) : '—'],
          ['has data', row.biz.hasData ? '是' : '否'],
          ['root keys', row.biz.rootKeys ? row.biz.rootKeys.slice(0, 6).join(', ') : '—'],
        ]);
        this.spacer(2);
        // message 可能是长文本,单独成段不做单行截断
        this.p('message: ' + msg, { size: 10, color: '#1f2328' });
        this.spacer(4);
      }

      // 响应体 (JSON 格式化,过长自动截断并分页)
      this.h3('响应体' + (row.bodyTruncated ? ' (超过 64KB 已截断)' : ''));
      const body = (row.responseSnippet || '').trim();
      if (!body) {
        this.muted('(无响应体)');
      } else {
        let pretty = body;
        try {
          // 去掉末尾的 ...[truncated] 标记再 parse
          pretty = JSON.stringify(
            JSON.parse(body.replace(/\.\.\.\[truncated\]$/, '').trim()),
            null, 2
          );
        } catch (_) {
          // 非 JSON 就保留原文本
        }
        // 限制最多 120 行,避免单个接口的超长响应占用过多 PDF 页面
        const MAX_LINES = 120;
        const raw = pretty.split('\n');
        if (raw.length > MAX_LINES) {
          pretty = raw.slice(0, MAX_LINES).join('\n') + `\n... (省略 ${raw.length - MAX_LINES} 行,完整内容请看 JSON 报告)`;
        }
        this._drawCodeBlock(pretty);
      }
      this.spacer(6);
    }

    // 代码块 / JSON 渲染:灰底 + 等宽字体,支持自动分页
    // 关键:每次 fillText 前都重新从 this.ctx 取,并重设 font / fillStyle /
    // textBaseline / textAlign —— 分页后新 canvas 的 ctx 默认状态必须重来
    _drawCodeBlock(text) {
      const font = `8.5px ${this.monoFamily}`;
      const lineH = 11;
      // 先把 ctx.font 设置好,measureText 才能准
      this.ctx.font = font;
      const lines = this._wrap(text, this.usableW - 12, font);
      let idx = 0;
      while (idx < lines.length) {
        // 每轮开始前重新拿当前 ctx(可能刚分过页)
        let ctx = this.ctx;
        const remain = this.pageH - this.marginBottom - this.y - 8;
        if (remain < lineH + 10) {
          this._newPage();
          continue; // 重新进入循环,拿新 ctx
        }
        const cap = Math.max(1, Math.floor((remain - 8) / lineH));
        const chunk = lines.slice(idx, idx + cap);
        const chunkH = chunk.length * lineH + 6;

        ctx = this.ctx;   // 再次确认(防御,_newPage 可能已调过)
        ctx.save();
        // 背景
        ctx.fillStyle = '#f6f8fa';
        ctx.fillRect(this.marginX, this.y, this.usableW, chunkH);
        // 边框
        ctx.strokeStyle = '#eaecef';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(this.marginX, this.y, this.usableW, chunkH);
        // 每行文字:fillText 前重设 font/color/align,避免被 save 外的默认值覆盖
        let ty = this.y + 3;
        for (const L of chunk) {
          ctx.font = font;
          ctx.fillStyle = '#1f2328';
          ctx.textBaseline = 'top';
          ctx.textAlign = 'left';
          ctx.fillText(L, this.marginX + 6, ty);
          ty += lineH;
        }
        ctx.restore();

        this.y += chunkH + 3;
        idx += cap;
      }
      this.spacer(4);
    }

    // ---------------- 生成 PDF ----------------
    async finalize(jpegQuality) {
      jpegQuality = jpegQuality || 0.85;
      const pageBlobs = [];
      for (const c of this.pages) {
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', jpegQuality));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        pageBlobs.push({ bytes, width: c.width, height: c.height });
      }
      return buildPdfBytes(pageBlobs, this.pageW, this.pageH);
    }
  }

  // -------- PDF 字节流构造 --------
  async function buildPdfBytes(pages, pageW, pageH) {
    const enc = new TextEncoder();
    const parts = [];
    let offset = 0;
    const xref = [];
    const push = (x) => {
      const bytes = typeof x === 'string' ? enc.encode(x) : x;
      parts.push(bytes);
      offset += bytes.byteLength;
    };

    // PDF 头(加二进制标记,有的阅读器会识别)
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    const N = pages.length;
    const pageObjNums = [];
    for (let i = 0; i < N; i++) pageObjNums.push(3 + i * 3);

    // Catalog
    xref[1] = offset;
    push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

    // Pages
    xref[2] = offset;
    const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
    push(`2 0 obj\n<< /Type /Pages /Count ${N} /Kids [${kids}] >>\nendobj\n`);

    for (let i = 0; i < N; i++) {
      const p = pages[i];
      const pageNum = 3 + i * 3;
      const imgNum = pageNum + 1;
      const contNum = pageNum + 2;

      xref[pageNum] = offset;
      push(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] `
        + `/Resources << /XObject << /Im0 ${imgNum} 0 R >> /ProcSet [/PDF /ImageC] >> `
        + `/Contents ${contNum} 0 R >>\nendobj\n`);

      xref[imgNum] = offset;
      push(`${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.byteLength} >>\nstream\n`);
      push(p.bytes);
      push('\nendstream\nendobj\n');

      const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q\n`;
      const contentBytes = enc.encode(content);
      xref[contNum] = offset;
      push(`${contNum} 0 obj\n<< /Length ${contentBytes.byteLength} >>\nstream\n`);
      push(contentBytes);
      push('endstream\nendobj\n');
    }

    // xref
    const xrefStart = offset;
    const totalObjs = 2 + N * 3;
    push(`xref\n0 ${totalObjs + 1}\n`);
    push('0000000000 65535 f \n');
    for (let i = 1; i <= totalObjs; i++) {
      const o = xref[i] || 0;
      push(String(o).padStart(10, '0') + ' 00000 n \n');
    }

    push(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
    return new Blob([out], { type: 'application/pdf' });
  }

  global.PdfRenderer = PdfRenderer;
})(window);
