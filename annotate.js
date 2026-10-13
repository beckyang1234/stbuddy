/* stbuddy 批注（v3）—— 注入到每篇研报页。
   三种落点：
     · 表格「单个单元格」 → 点单元格即可批注（锚点 = 单元格文本指纹；同文本重复时按出现次序加 -N）
       ★ v2 是"整行"锚点：行内多列被拼成一条，徽章只挂第一列 → 点第二列看到徽章却读不到内容（Andy 报障）。
         v3 改为严格单格：一次点击只作用于所点的那个单元格，不再跨列、跨格。
     · 任意一句话 → 点正文任意位置，自动落到「光标所在的那句话」（锚点 = 该段文本指纹 + 句序）
     · 右侧笔记栏 → 逐篇自由笔记（200–5000 字），与批注同源共享
   批注/笔记存 Cloudflare KV（经 /api/notes），所有持密码者共享可见。
   约束：不改研报正文（高亮用绝对定位覆盖层画，不动 DOM）；不依赖外部资源；后端不可用时静默降级。

   ★ 维护提醒：本文件是**外链单文件**（站点根 /annotate.js），改完跑 stbuddy.py inject/sync
     （内部会 sync_annot_asset() 把新版拷到站点根）再推送 annotate.js 一个文件即可。
*/
(function () {
  'use strict';

  var TOKEN = '9aa2978b32c1ffa6d0bc3b359720fb32bb45bfb677d704c7eacf714b9e82aab5';
  var API = '/api/notes';
  var MINEKEY = 'sb_mine';     // 本机刚写的批注：KV 是最终一致（list 有几十秒延迟），
                               // 靠它保证"作者自己刚写完刷新也看得见"
  var PAGE_ANCHOR = 'page';    // 右侧笔记栏的锚点（一篇一条，kind='page'）
  var NOTE_MAX = 5000;         // 笔记上限字数
  var NOTE_MIN_HINT = 200;     // 只做提示，不强制

  var m = /\/(\d{6})(?:\.html)?\/?$/.exec(location.pathname);
  if (!m) return;
  var CODE = m[1];
  var DRAFTKEY = 'sb_draft_' + CODE;

  // ================================================================ 工具
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(ts) {
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  // ---- 样式
  var CSS = '' +
    // ---------- 版面：正文左移、右侧让出笔记栏 ----------
    //    报告模板是 .wrap{max-width:1080px;margin:0 auto}（居中）→ 两侧大片留白。
    //    ★ 只在 ≥1500px 才"停靠"笔记栏（正文左靠 + 右侧 380px 常驻）；
    //      1500px 以下一律**不动正文**（保持模板原样居中），笔记栏改为浮层，避免小屏正文被压窄。
    //      手机上打开报告跟以前完全一样，要写笔记时点「笔记」按钮弹出全宽面板。
    '.wrap{max-width:1080px;margin:0 0 0 28px}' +
    '@media(max-width:1499px){.wrap{max-width:1080px;margin:0 auto}}' +
    '#sbn-note{position:fixed;right:0;top:0;bottom:0;width:380px;z-index:9002;background:#fff;' +
      'border-left:1px solid #e3e7ee;display:none;flex-direction:column;color:#1c2733;' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;font-size:13px}' +
      '@media(max-width:1499px){#sbn-note{box-shadow:-8px 0 32px rgba(16,32,48,.2)}}' +
      // 手机：全宽面板（「保存」按钮的显隐切换见样式表末尾 —— 必须排在基础规则之后才生效）
      '@media(max-width:600px){#sbn-note{left:0;right:0;width:auto}}' +
    'body.sbn-note-open #sbn-note{display:flex}' +
    '@media(min-width:1500px){' +
      'body.sbn-note-open{padding-right:404px}' +
      'body.sbn-note-open .wrap{max-width:1160px}' +
    '}' +
    // 右下角悬浮轨道（回到顶部 / 返回首页 / 批注）随笔记栏一起左移，别被压住
    'body.sbn-note-open .sbn-bar{right:404px}' +
    'body.sbn-note-open #totop{right:404px}' +
    'body.sbn-note-open a[href$="index.html"]{right:404px!important}' +
    // ★ 浮层模式（<1500px）：笔记栏会压住右下角那条悬浮轨道 —— 展开时直接把轨道收起，
    //   否则手机上会出现「返回首页/批注 按钮画在笔记面板上」的怪象。收起笔记栏即自动恢复。
    '@media(max-width:1499px){' +
      'body.sbn-note-open .sbn-bar,body.sbn-note-open #totop,' +
      'body.sbn-note-open a[href$="index.html"]{display:none!important}' +
    '}' +
    '#sbn-note-head{padding:10px 14px;border-bottom:1px solid #e9edf2;background:#f6f8fa;' +
      'display:flex;align-items:center;gap:8px}' +
    '#sbn-note-head b{font-size:13px;white-space:nowrap}' +
    '#sbn-note-head .cnt{margin-left:auto;font-size:11px;color:#98a2ae;white-space:nowrap}' +
    '#sbn-note-head .x{cursor:pointer;color:#8b96a3;font-size:16px;line-height:1;padding:0 2px}' +
    '#sbn-note-save-top{display:none;border:none;border-radius:7px;background:#e67e22;color:#fff;' +
      'padding:5px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '#sbn-note-save-top[disabled]{background:#c9d2dc;cursor:default}' +
    '#sbn-note-text{flex:1 1 auto;width:100%;box-sizing:border-box;border:none;outline:none;' +
      'resize:none;padding:12px 14px;font-size:13px;line-height:1.75;font-family:inherit;color:#1c2733}' +
    '#sbn-note-text::placeholder{color:#b3bcc7}' +
    '#sbn-note-foot{padding:8px 14px;border-top:1px solid #e9edf2;background:#fbfcfd;' +
      'display:flex;align-items:center;gap:8px}' +
    '#sbn-note-foot .sbn-msg{flex:1}' +
    '#sbn-note[data-warn="1"] #sbn-note-head{background:#fff6ec}' +
    // ---------- 单元格批注 ----------
    '.sbn-cell{cursor:cell}' +
    '.sbn-cell:hover{background:rgba(230,126,34,.08)!important}' +
    '.sbn-cell.sbn-on{background:rgba(230,126,34,.13)!important;box-shadow:inset 0 0 0 1px rgba(230,126,34,.45)}' +
    '.sbn-badge{display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;' +
      'font-size:10px;font-weight:700;color:#fff;background:#e67e22;border-radius:8px;padding:0 4px;' +
      'margin-left:5px;vertical-align:middle;font-family:-apple-system,"Microsoft YaHei",sans-serif}' +
    // ---------- 句子高亮 ----------
    '.sbn-hl{position:absolute;pointer-events:none;z-index:1;border-radius:3px;' +
      'background:rgba(230,126,34,.17);border-bottom:1.5px solid rgba(230,126,34,.55)}' +
    '.sbn-hl-sel{background:rgba(230,126,34,.3);border-bottom-color:#e67e22}' +
    '.sbn-hl-tag{position:absolute;pointer-events:none;z-index:2;font-size:9px;line-height:13px;' +
      'min-width:13px;height:13px;text-align:center;color:#fff;background:#e67e22;border-radius:7px;' +
      'font-weight:700;font-family:-apple-system,"Microsoft YaHei",sans-serif}' +
    // ★ 右下角是一条「悬浮控件竖排轨道」：回到顶部 #totop（26–72，模板自带，未滚动时隐藏）
    //   → 返回首页（84–126，模板用 !important 钉在右下）→ 本条「批注 N」（140 起）。
    '.sbn-bar{position:fixed;right:20px;bottom:140px;z-index:9998;display:flex;gap:8px}' +
    '.sbn-btn{border:none;border-radius:20px;padding:9px 15px;font-size:13px;cursor:pointer;' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.2)}' +
    '.sbn-btn.ghost{background:#1a5276;color:#fff}' +
    '.sbn-btn.ghost.on{background:#e67e22}' +
    '.sbn-panel{position:absolute;z-index:9999;width:330px;max-width:92vw;background:#fff;' +
      'border:1px solid #d9dee5;border-radius:12px;box-shadow:0 10px 34px rgba(20,40,60,.22);' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;color:#1c2733;font-size:13px;' +
      'line-height:1.55;overflow:hidden}' +
    '.sbn-head{padding:9px 12px;background:#f6f8fa;border-bottom:1px solid #e9edf2;font-weight:700;' +
      'font-size:12.5px;display:flex;justify-content:space-between;align-items:center}' +
    '.sbn-head .x{cursor:pointer;color:#8b96a3;font-size:16px;line-height:1;padding:0 2px}' +
    '.sbn-anchor{padding:7px 12px;background:#fffdf8;border-bottom:1px solid #f0e6d8;color:#7a6a55;' +
      'font-size:11.5px;max-height:58px;overflow:auto}' +
    '.sbn-list{max-height:220px;overflow:auto;padding:4px 0}' +
    '.sbn-item{padding:7px 12px;border-bottom:1px dashed #eef1f5}' +
    '.sbn-item:last-child{border-bottom:none}' +
    '.sbn-meta{font-size:11px;color:#98a2ae;display:flex;justify-content:space-between;gap:8px}' +
    '.sbn-del{cursor:pointer;color:#c0392b;font-size:11px}' +
    '.sbn-body{margin-top:3px;white-space:pre-wrap;word-break:break-word}' +
    '.sbn-empty{padding:10px 12px;color:#98a2ae;font-size:12px}' +
    '.sbn-form{padding:9px 12px;background:#fbfcfd;border-top:1px solid #e9edf2}' +
    '.sbn-form textarea{width:100%;box-sizing:border-box;border:1px solid #dfe4ea;' +
      'border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;outline:none;color:#1c2733;' +
      'min-height:54px;resize:vertical}' +
    '.sbn-form textarea:focus{border-color:#e67e22}' +
    '.sbn-foot{display:flex;justify-content:space-between;align-items:center;margin-top:7px;gap:8px}' +
    '.sbn-msg{font-size:11.5px;color:#98a2ae;flex:1}' +
    '.sbn-msg.err{color:#c0392b}' +
    '.sbn-msg.ok{color:#2f855a}' +
    '.sbn-save{border:none;border-radius:7px;background:#e67e22;color:#fff;padding:6px 14px;' +
      'font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '.sbn-save[disabled]{background:#c9d2dc;cursor:default}' +
    // ★ 必须放在最后：手机端把「保存」移到标题栏。
    //   同特异性(id)下**后写者胜**，若写在 #sbn-note-save-top{display:none} 之前就会被它盖掉。
    '@media(max-width:600px){#sbn-note-save-top{display:inline-block}#sbn-note-save{display:none}}';
  var style = document.createElement('style');
  style.id = 'sbn-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---- 文本节点收集（只跳过本插件自己注入的节点，避免指纹被自己的徽章/面板污染）
  // ★ 必须用 data-sbn 精确标记，**不能用 class 前缀**：`.sbn-cell`（我加在单元格上的可点标记）
  //   同样以 sbn- 开头，用前缀判断会把单元格里的正文一起吃掉 →
  //   行指纹算错（v2 老批注永远无法迁移）、且重扫时纯文本单元格的锚点会凭空消失（踩过）。
  function textNodes(el) {
    var out = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = walker.nextNode())) {
      var p = n.parentNode;
      if (!p || !p.closest || !p.closest('[data-sbn]')) out.push(n);
    }
    return out;
  }
  function blockText(el) {
    return textNodes(el).map(function (t) { return t.data; }).join('');
  }
  // 锚点文本：必须走 blockText（textNodes 会跳过 .sbn-badge），
  // 否则「先挂徽章 → 再算指纹」会把徽章数字算进去，锚点每次刷新都变。
  function anchorText(el) { return norm(blockText(el)); }

  // 断句：只按中文句末标点与换行切；**不按半角句点**（研报里 9.3.12 / 3.92 元 会被切碎）
  function sentences(txt) {
    var out = [], start = 0, re = /[。！？；!?;]+|\n/g, mm;
    while ((mm = re.exec(txt))) {
      var end = mm.index + mm[0].length;
      if (txt.slice(start, end).trim()) out.push([start, end]);
      start = end;
    }
    if (start < txt.length && txt.slice(start).trim()) out.push([start, txt.length]);
    return out;
  }
  function rangeFor(nodes, s, e) {
    var pos = 0, started = false, r = document.createRange();
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], len = node.data.length, ns = pos, ne = pos + len;
      if (!started && ne > s) { r.setStart(node, Math.max(0, s - ns)); started = true; }
      if (started && ne >= e) { r.setEnd(node, Math.min(len, e - ns)); break; }
      pos = ne;
    }
    return started ? r : null;
  }

  // ================================================================ 落点识别
  var BLOCK = { P: 1, LI: 1, DIV: 1, TD: 1, TH: 1, DD: 1, DT: 1, CAPTION: 1, FIGCAPTION: 1,
                BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
  var SKIP_SEL = 'nav, header, footer, #sbgate, #sbn-note, .sbn-bar, .sbn-panel, aside, .toc, #toc, script, style, pre, code';

  function isTextBlock(el) {          // 自身不含块级子元素（＝可直接断句的最小文本容器）
    if (!el.textContent || !el.textContent.trim()) return false;
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var d = getComputedStyle(kids[i]).display;
      if (d && d !== 'inline' && d !== 'inline-block' && d !== 'none' && d !== 'contents') return false;
    }
    return true;
  }
  function pickBlock(el) {
    while (el && el !== document.body) {
      if (el.matches && el.matches(SKIP_SEL)) return null;
      if (el.tagName === 'SUMMARY') return null;      // 摘要点击要留给「折叠/展开」
      if (BLOCK[el.tagName] && isTextBlock(el)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function offsetAtPoint(x, y, block) {   // 点击位置 → 该块内的字符偏移
    var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y)
                                         : (document.caretPositionFromPoint
                                            ? document.caretPositionFromPoint(x, y) : null);
    if (!r) return -1;
    var node = r.startContainer, off = r.startOffset || 0;
    if (!node) return -1;
    if (node.nodeType !== 3) return 0;
    var nodes = textNodes(block), pos = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return pos + off;
      pos += nodes[i].data.length;
    }
    return -1;
  }

  // ================================================================ 状态
  var notes = [];        // 批注（不含笔记）
  var pageNote = null;   // 右侧笔记（kind='page'）
  var byKey = {};        // 锚点 → [note]
  var cellMap = {};      // 单元格锚点 → td/th
  var sentMap = {};      // 句锚点 → {el, s, e, text}
  var alias = {};        // 旧「整行」锚点 → 该行首个单元格的锚点（v2 老批注迁移，不让它脱锚）
  var rowTexts = [];     // 现行各行的「前 24 字 → 首格锚点」，applyFallback 用
  var panel = null, cur = null;
  var online = false;
  var offline = '';        // '' | 'not-configured'（后端没绑定）| 'network'（连不上/抖动）

  // 连接批注服务：带退避重试。★ 不要"一次失败就整个会话锁死"——
  // 移动网络下首屏那一次请求很容易抖掉，实测本机也会偶发（HTTP 000）。
  function connect(tries) {
    var n = 0, max = tries || 3;
    function attempt() {
      n++;
      return fetch(API + '?code=' + CODE, { headers: { 'x-stb-token': TOKEN } })
        .then(function (r) {
          if (r.status === 503) { offline = 'not-configured'; return null; }   // 后端未绑 KV，重试没用
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (j) { online = true; offline = ''; ingest(j.items); }
          else { ingest([]); }      // 503（后端没绑）也要露出本机自己写的
          return online;
        })
        .catch(function () {
          if (n < max) return new Promise(function (res) { setTimeout(res, 700 * n); }).then(attempt);
          online = false; offline = 'network';
          ingest([]);               // ★ 连不上时也别让"自己刚写的"凭空消失
          return false;
        });
    }
    return attempt();
  }
  function errText() {
    return offline === 'network' ? '连不上批注服务，请重试' : '批注服务未启用';
  }
  // 服务端返回 → 拆成「批注」与「笔记」两部分，再落到锚点
  function ingest(items) {
    var all = mergeServer(items || []);
    pageNote = null; notes = [];
    all.forEach(function (n) {
      if (n.kind === 'page' || n.rowKey === PAGE_ANCHOR) {
        if (!pageNote || n.ts > pageNote.ts) pageNote = n;
      } else { notes.push(n); }
    });
    applyFallback();               // ★ 批注到手后才做"改版重锚"（首屏 scan 时 notes 为空）
    group(); paint(); syncNote();
  }

  // ---- 本机缓存（对抗 KV 最终一致性：自己刚写的必须马上看得见）
  function mineAll() { try { return JSON.parse(localStorage.getItem(MINEKEY) || '{}'); } catch (e) { return {}; } }
  function mineGet() { return mineAll()[CODE] || []; }
  function mineSet(l) { var a = mineAll(); a[CODE] = l; try { localStorage.setItem(MINEKEY, JSON.stringify(a)); } catch (e) {} }
  function mineAdd(n) { var l = mineGet(); if (!l.some(function (x) { return x.id === n.id; })) l.push(n); mineSet(l); }
  function mineDrop(id) { mineSet(mineGet().filter(function (x) { return x.id !== id; })); }
  function mergeServer(items) {
    var now = Date.now(), srv = items || [];
    // 服务端已经能看到 → 出缓存；超过 10 分钟的也清掉（避免长期保留已被他人删除的）
    var keep = mineGet().filter(function (m) {
      if (srv.some(function (s) { return s.id === m.id; })) return false;
      return now - m.ts < 600000;
    });
    mineSet(keep);
    return srv.concat(keep);
  }

  // v2 老批注用的是「整行」锚点；v3 改单元格后它会脱锚。
  // 这里把 老行锚点 → 该行第一个单元格锚点 做一次别名映射，老批注照旧看得见。
  function effKey(n) { return alias[n.rowKey] || n.rowKey; }
  /* ★ 报告改版兜底：行内容变了 → 老行指纹（hash32）必然匹配不上，批注就成了"未锚定"。
     用批注自带的「写入时的整行原文 rowText」按**前 24 字相同**再匹配一次
     （改版时行首标签通常不变，动的多是数值/日期）。
     ⚠️ 必须在批注拉回来之后调用 —— 首屏 scan() 时 notes 还是空的，放那里等于没跑。 */
  function applyFallback() {
    if (!notes.length || !rowTexts.length) return;
    notes.forEach(function (n) {
      if (alias[n.rowKey]) return;
      if (n.kind !== 'row' || !n.rowText) return;
      var head = norm(n.rowText).slice(0, 24);
      if (head.length < 8) return;                       // 太短不敢猜，宁可显示"未锚定"
      for (var i = 0; i < rowTexts.length; i++) {
        if (rowTexts[i][0] === head) { alias[n.rowKey] = rowTexts[i][1]; return; }
      }
    });
  }
  // 脱锚批注（报告改写后行/句都没了对不上）——必须能被看到，绝不允许"看不到内容"
  function orphanOf() {
    return notes.filter(function (n) {
      var k = effKey(n);
      return !cellMap[k] && !sentMap[k];
    });
  }
  function group() {
    byKey = {};
    notes.forEach(function (n) { (byKey[effKey(n)] = byKey[effKey(n)] || []).push(n); });
  }

  // ================================================================ 扫描落点 + 画高亮
  function scan() {
    cellMap = {}; sentMap = {}; alias = {};
    // 先把旧徽章全摘掉：徽章会改 textContent，不摘就会污染指纹
    Array.prototype.forEach.call(document.querySelectorAll('.sbn-badge'), function (b) {
      b.parentNode.removeChild(b);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sbn-on'), function (b) {
      b.classList.remove('sbn-on');
    });

    // 1) 表格单元格（严格单格，不再按行）
    var cells = document.querySelectorAll('table td, table th');
    var seen = {};
    for (var i = 0; i < cells.length; i++) {
      var td = cells[i];
      if (td.closest('.sbn-panel,.sbn-bar,#sbn-note,nav,header,footer,#sbgate')) continue;
      var txt = anchorText(td);
      if (!txt) continue;
      var base = hash32(txt);
      var n2 = seen[base] = (seen[base] || 0) + 1;
      var key = n2 === 1 ? base : base + '-' + n2;      // 同文本重复：按出现次序区分
      cellMap[key] = td;
      td.classList.add('sbn-cell');
      td.setAttribute('data-sbn-key', key);
    }
    // 1b) v2 老「整行」锚点 → 首格锚点（迁移用；行锚点不再参与新交互）
    var trs = document.querySelectorAll('table tr');
    // ★ 取「该行第一个有锚点的单元格」——不能死认 children[0]：有些行的首格是空的
    //   （标签在别的格里），那样会整行被跳过，兜底就永远匹配不到。
    function firstKeyOf(tr) {
      for (var c = 0; c < tr.children.length; c++) {
        var k = tr.children[c].getAttribute && tr.children[c].getAttribute('data-sbn-key');
        if (k) return k;
      }
      return '';
    }
    for (var t = 0; t < trs.length; t++) {
      var tr = trs[t];
      if (!tr.children.length) continue;
      var fk = firstKeyOf(tr);
      if (!fk) continue;
      alias[hash32(anchorText(tr))] = fk;
    }
    // 1c) 兜底用的现行整行文本表（真正执行见 applyFallback()，必须在批注拉回来之后调用）
    rowTexts = [];
    for (var t2 = 0; t2 < trs.length; t2++) {
      var tr2 = trs[t2];
      if (!tr2.children.length) continue;
      var fk2 = firstKeyOf(tr2);
      if (!fk2) continue;
      rowTexts.push([anchorText(tr2).slice(0, 24), fk2]);
    }
    applyFallback();
    // 2) 句子（只扫文本块；表格内的 td/th 一律走单元格锚点，不再参与断句）
    var all = document.querySelectorAll('p,li,div,dd,dt,blockquote,caption,figcaption,h1,h2,h3,h4,h5,h6');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.closest(SKIP_SEL) || el.closest('td,th') || el.tagName === 'SUMMARY') continue;
      if (!isTextBlock(el)) continue;
      var txt2 = blockText(el);
      if (txt2.length < 4) continue;
      var bh = hash32(norm(txt2)), ss = sentences(txt2);
      if (ss.length > 200) continue;                     // 异常长块跳过，避免爆炸
      for (var s = 0; s < ss.length; s++) {
        var seg = txt2.slice(ss[s][0], ss[s][1]).trim();
        if (seg.length < 2) continue;
        sentMap[bh + '-' + s] = { el: el, s: ss[s][0], e: ss[s][1], text: seg };
      }
    }
    paint();
  }

  function paint() {
    // 单元格徽章
    Object.keys(cellMap).forEach(function (k) {
      var td = cellMap[k], list = byKey[k], old = td.querySelector('.sbn-badge');
      if (old) old.parentNode.removeChild(old);
      td.classList.remove('sbn-on');
      if (!list || !list.length) return;
      td.classList.add('sbn-on');
      var sp = document.createElement('span');
      sp.className = 'sbn-badge';
      sp.setAttribute('data-sbn', '1');
      sp.textContent = list.length;
      td.appendChild(sp);
    });
    // 句子高亮（绝对定位覆盖层，不动 DOM）
    Array.prototype.forEach.call(document.querySelectorAll('.sbn-hl'), function (n) {
      n.parentNode.removeChild(n);
    });
    Object.keys(byKey).forEach(function (k) {
      var info = sentMap[k];
      if (!info) return;
      var cnt = byKey[k].length;
      var nodes = textNodes(info.el);
      var r = rangeFor(nodes, info.s, info.e);
      if (!r) return;
      var rects = r.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var rc = rects[i];
        if (rc.width < 1 || rc.height < 1) continue;
        var d = document.createElement('div');
        d.className = 'sbn-hl' + (cur && cur.key === k ? ' sbn-hl-sel' : '');
        d.style.left = (rc.left + window.scrollX - 2) + 'px';
        d.style.top = (rc.top + window.scrollY - 1) + 'px';
        d.style.width = (rc.width + 4) + 'px';
        d.style.height = (rc.height + 2) + 'px';
        document.body.appendChild(d);
        if (i === 0 && cnt) {
          var t = document.createElement('div');
          t.className = 'sbn-hl-tag';
          t.setAttribute('data-sbn', '1');
          t.textContent = cnt;
          t.style.left = (rc.left + window.scrollX - 15) + 'px';
          t.style.top = (rc.top + window.scrollY - 1) + 'px';
          document.body.appendChild(t);
        }
      }
    });
    var btn = document.getElementById('sbn-count');
    if (btn) {
      var orphan = orphanOf().length;
      btn.textContent = '批注 ' + notes.length + (orphan ? '（' + orphan + ' 未锚定）' : '');
      btn.title = orphan ? '有 ' + orphan + ' 条批注失去了锚点 —— 点击查看内容' : '点击跳到本页第一条批注';
      btn.style.background = orphan ? '#b3261e' : '';
    }
  }

  // ================================================================ 批注面板
  function close() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null; cur = null;
    Array.prototype.forEach.call(document.querySelectorAll('.sbn-hl-sel'), function (n) {
      n.classList.remove('sbn-hl-sel');
    });
  }
  function open(anchor, rect) {
    close();
    cur = anchor;
    panel = document.createElement('div');
    panel.className = 'sbn-panel';
    panel.setAttribute('data-sbn', '1');
    panel.innerHTML =
      '<div class="sbn-head"><span>' + (anchor.kind === 'sent' ? '句子批注' : '单元格批注') +
      '</span><span class="x" id="sbn-x">×</span></div>' +
      '<div class="sbn-anchor" id="sbn-anchor"></div>' +
      '<div class="sbn-list" id="sbn-list"></div>' +
      '<div class="sbn-form">' +
        '<textarea id="sbn-text" maxlength="1000" placeholder="写点什么…（Ctrl+Enter 提交）"></textarea>' +
        '<div class="sbn-foot"><span class="sbn-msg" id="sbn-msg"></span>' +
        '<button class="sbn-save" id="sbn-save">提交</button></div>' +
      '</div>';
    document.body.appendChild(panel);
    var top = rect ? rect.bottom + window.scrollY + 6 : window.scrollY + 120;
    var left = rect ? rect.left + window.scrollX : window.scrollX + 60;
    if (top + 300 > window.scrollY + document.documentElement.clientHeight) {
      top = Math.max(window.scrollY + 8, (rect ? rect.top + window.scrollY : top) - panel.offsetHeight - 6);
    }
    panel.style.top = top + 'px';
    panel.style.left = Math.max(8, Math.min(left,
      window.scrollX + document.documentElement.clientWidth - panel.offsetWidth - 14)) + 'px';
    document.getElementById('sbn-anchor').textContent = anchor.anchorText;
    document.getElementById('sbn-x').addEventListener('click', close);
    document.getElementById('sbn-save').addEventListener('click', save);
    document.getElementById('sbn-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    });
    if (anchor.kind === 'orphan') {          // 未锚定列表：只读/可删，没有"写在哪"这回事
      var f = panel.querySelector('.sbn-form');
      if (f) f.style.display = 'none';
    }
    renderList();
    paint();
    if (online && anchor.kind !== 'orphan') document.getElementById('sbn-text').focus();
  }
  var ORPHAN_KEY = '__orphan__';       // 「未锚定批注」列表用的伪锚点
  function renderList() {
    var box = document.getElementById('sbn-list');
    var list = (cur.key === ORPHAN_KEY ? orphanOf() : (byKey[cur.key] || [])).slice()
      .sort(function (a, b) { return a.ts - b.ts; });
    if (!list.length) {
      box.innerHTML = '<div class="sbn-empty">这里还没有批注' +
        (online ? '，写下第一条。' : '。' + errText() + '。') + '</div>';
      return;
    }
    box.innerHTML = list.map(function (n) {
      return '<div class="sbn-item"><div class="sbn-meta"><span>' + fmt(n.ts) + '</span>' +
        (n.rowText && cur.key === ORPHAN_KEY ?
          '<span style="color:#b9c1cb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
          'max-width:170px">原文：' + esc(String(n.rowText).slice(0, 24)) + '…</span>' : '') +
        (n.kind === 'row' ? '<span style="color:#b9c1cb">整行批注（旧）</span>' : '') +
        (online ? '<span class="sbn-del" data-id="' + esc(n.id) + '">删除</span>' : '') +
        '</div><div class="sbn-body">' + esc(n.text) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.sbn-del'), function (d) {
      d.addEventListener('click', function () { del(d.getAttribute('data-id')); });
    });
  }
  function msg(t, kind) {
    var el = document.getElementById('sbn-msg');
    if (!el) return;
    el.className = 'sbn-msg' + (kind ? ' ' + kind : '');
    el.textContent = t;
    if (kind === 'ok') setTimeout(function () { if (el.textContent === t) el.textContent = ''; }, 2200);
  }
  function save() {
    var t = document.getElementById('sbn-text').value.trim();
    if (!t) { msg('内容不能为空', 'err'); return; }
    var btn = document.getElementById('sbn-save');
    btn.disabled = true; msg('提交中…');
    // 之前若没连上（或首屏那次请求抖掉了），提交前先重连一次，别让一次抖动锁死整个会话
    var pre = online ? Promise.resolve(true) : connect(2);
    pre.then(function (okNow) {
      if (!okNow) { btn.disabled = false; msg(errText(), 'err'); return; }
      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stb-token': TOKEN },
        body: JSON.stringify({ code: CODE, rowKey: cur.key, kind: cur.kind,
          rowText: String(cur.anchorText).slice(0, 200), text: t })
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (!res.j || !res.j.ok) {
            var e2 = res.j && res.j.error;
            msg(e2 === 'notes storage not configured' ? '批注服务未启用' : ('提交失败：' + (e2 || res.s)), 'err');
            return;
          }
          notes.push(res.j.item);
          mineAdd(res.j.item);          // 落本机缓存：KV 的 list 有延迟，作者自己要立刻看得见
          // ★ 重新 scan 再 paint：保证"刚提交的那条"立刻锚定并画出高亮。
          group(); scan(); renderList();
          document.getElementById('sbn-text').value = '';
          msg('已提交', 'ok');
        })
        .catch(function () { btn.disabled = false; msg('连不上批注服务，请重试', 'err'); });
    });
  }
  function del(id) {
    if (!id || !online) return;
    if (!confirm('删除这条批注？')) return;
    fetch(API + '?code=' + CODE + '&id=' + encodeURIComponent(id),
          { method: 'DELETE', headers: { 'x-stb-token': TOKEN } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          notes = notes.filter(function (n) { return n.id !== id; });
          mineDrop(id);
          group(); paint(); renderList();
        } else { msg((j && j.error) || '删除失败', 'err'); }
      })
      .catch(function () { msg('网络不可用', 'err'); });
  }

  // ================================================================ 右侧笔记栏
  var noteBox = null, noteDirty = false, noteTimer = null;
  function noteMsg(t, kind) {
    var el = document.getElementById('sbn-note-msg');
    if (!el) return;
    el.className = 'sbn-msg' + (kind ? ' ' + kind : '');
    el.textContent = t;
  }
  function readDraft() { try { return localStorage.getItem(DRAFTKEY) || ''; } catch (e) { return ''; } }
  function writeDraft(v) {
    try { if (v) localStorage.setItem(DRAFTKEY, v); else localStorage.removeItem(DRAFTKEY); } catch (e) {}
  }
  function noteCount() {
    var v = (noteBox && noteBox.value) || '';
    var el = document.getElementById('sbn-note-cnt');
    if (el) el.textContent = v.length + ' / ' + NOTE_MAX + (v.length && v.length < NOTE_MIN_HINT ?
      '（建议 200 字以上）' : '');
  }
  // 服务端/本机内容 → 文本框（没在编辑时才覆盖，别抢用户正在敲的字）
  function syncNote() {
    if (!noteBox) return;
    var draft = readDraft(), srv = (pageNote && pageNote.text) || '';
    if (noteDirty) { noteCount(); return; }
    if (draft && draft !== srv) {                 // 有未保存草稿：以草稿为准，并提示
      noteBox.value = draft; noteDirty = true;
      noteMsg('有未保存的草稿', 'err');
      document.getElementById('sbn-note').setAttribute('data-warn', '1');
    } else {
      noteBox.value = srv;
      noteMsg(pageNote ? ('已存 · ' + fmt(pageNote.ts)) : '　');
      document.getElementById('sbn-note').removeAttribute('data-warn');
    }
    noteCount();
  }
  function noteBtns() {
    return [document.getElementById('sbn-note-save'), document.getElementById('sbn-note-save-top')]
      .filter(function (b) { return !!b; });
  }
  function saveNote() {
    if (!noteBox) return;
    var t = noteBox.value;
    if (t.length > NOTE_MAX) { noteMsg('超出 ' + NOTE_MAX + ' 字上限', 'err'); return; }
    if (!t.trim()) { noteMsg('笔记为空，无需保存', 'err'); return; }
    noteBtns().forEach(function (b) { b.disabled = true; });
    noteMsg('保存中…');
    var pre = online ? Promise.resolve(true) : connect(2);
    pre.then(function (okNow) {
      if (!okNow) { noteBtns().forEach(function (b) { b.disabled = false; }); noteMsg(errText(), 'err'); return; }
      return fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stb-token': TOKEN },
        body: JSON.stringify({ code: CODE, rowKey: PAGE_ANCHOR, kind: 'page', text: t,
          baseTs: pageNote ? pageNote.ts : 0 })
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          noteBtns().forEach(function (b) { b.disabled = false; });
          if (!res.j || !res.j.ok) {
            if (res.s === 409) { noteMsg('已被他人更新，请刷新后再改', 'err'); return; }
            noteMsg((res.j && res.j.error) === 'notes storage not configured'
              ? '笔记服务未启用' : ('保存失败：' + ((res.j && res.j.error) || res.s)), 'err');
            return;
          }
          pageNote = res.j.item; noteDirty = false; writeDraft('');
          document.getElementById('sbn-note').removeAttribute('data-warn');
          noteMsg('已保存 · ' + fmt(pageNote.ts), 'ok');
        })
        .catch(function () {
          noteBtns().forEach(function (b) { b.disabled = false; });
          noteMsg('连不上服务，请重试', 'err');
        });
    });
  }
  function setNoteOpen(on) {
    var open = !!on;
    document.body.classList[open ? 'add' : 'remove']('sbn-note-open');
    var tg = document.getElementById('sbn-note-toggle');
    if (tg) tg.classList[open ? 'add' : 'remove']('on');
    try { localStorage.setItem('sb_note_open', open ? '1' : ''); } catch (e) {}
    setTimeout(paint, 260);          // 版面变化后重画句子高亮
  }
  function buildNote() {
    var d = document.createElement('div');
    d.id = 'sbn-note';
    d.setAttribute('data-sbn', '1');
    d.innerHTML =
      '<div id="sbn-note-head"><b>我的笔记</b><span class="cnt" id="sbn-note-cnt">0 / ' + NOTE_MAX + '</span>' +
        // 手机端「保存」放标题栏：锚在顶部，软键盘弹出时不会被顶掉（footer 那枚在窄屏被隐藏）
        '<button id="sbn-note-save-top">保存</button>' +
        '<span class="x" id="sbn-note-close" title="收起">×</span></div>' +
      '<textarea id="sbn-note-text" maxlength="' + NOTE_MAX + '" ' +
        'placeholder="在这里记录你对这份研报的想法 —— 只写结论、疑点、待验证项都行（建议 200 字以上，上限 ' +
        NOTE_MAX + ' 字）。"></textarea>' +
      '<div id="sbn-note-foot"><span class="sbn-msg" id="sbn-note-msg">　</span>' +
        '<button class="sbn-save" id="sbn-note-save">保存</button></div>';
    document.body.appendChild(d);
    noteBox = document.getElementById('sbn-note-text');
    document.getElementById('sbn-note-close').addEventListener('click', function () { setNoteOpen(false); });
    document.getElementById('sbn-note-save').addEventListener('click', saveNote);
    document.getElementById('sbn-note-save-top').addEventListener('click', saveNote);
    noteBox.addEventListener('input', function () {
      noteDirty = true; noteCount();
      document.getElementById('sbn-note').setAttribute('data-warn', '1');
      noteMsg('未保存…', 'err');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { writeDraft(noteBox.value); }, 400);   // 草稿防空转
    });
    noteBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote();
    });
    // ★ 默认展开只在真正宽屏（≥1500px）——小屏一进来就糊一层面板会挡住报告
    var want = null;
    try { want = localStorage.getItem('sb_note_open'); } catch (e) {}
    setNoteOpen(want === null ? window.innerWidth >= 1500 : want === '1');
  }

  // ================================================================ 交互
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.sbn-panel,#sbn-note')) return;   // 面板内部自理
    // 1) 表格单元格（严格单格）
    var td = e.target.closest && e.target.closest('td,th');
    if (td && td.getAttribute && td.getAttribute('data-sbn-key')) {
      if (e.target.closest('a')) return;                              // 单元格里的链接照常点
      e.preventDefault();
      var k = td.getAttribute('data-sbn-key');
      if (panel && cur && cur.key === k) { close(); return; }
      var r = td.getBoundingClientRect();
      open({ key: k, kind: 'cell', anchorText: anchorText(td).slice(0, 160) }, r);
      return;
    }
    // 2) 正文句子
    if (e.target.closest && e.target.closest('a,button,input,textarea,select,summary,label,.sbn-bar')) {
      if (e.isTrusted) close();          // 只有真人点击才算"点到了别处"；页面脚本的合成点击不关面板
      return;
    }
    if (window.getSelection && String(window.getSelection()).length) return;  // 用户在选词，别抢
    var block = pickBlock(e.target);
    if (!block) { if (e.isTrusted) close(); return; }
    var off = offsetAtPoint(e.clientX, e.clientY, block);
    if (off < 0) { close(); return; }
    var txt = blockText(block), ss = sentences(txt), bh = hash32(norm(txt)), idx = -1;
    for (var i = 0; i < ss.length; i++) {
      if (off >= ss[i][0] && off < ss[i][1]) { idx = i; break; }
    }
    if (idx < 0) for (var j = ss.length - 1; j >= 0; j--) { if (off >= ss[j][0]) { idx = j; break; } }
    if (idx < 0) idx = 0;
    var info = sentMap[bh + '-' + idx];
    if (!info) { close(); return; }
    var key = bh + '-' + idx;
    if (panel && cur && cur.key === key) { close(); return; }
    open({ key: key, kind: 'sent', anchorText: info.text.slice(0, 200) },
         rangeFor(textNodes(block), ss[idx][0], ss[idx][1]).getBoundingClientRect());
  }, true);

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  // resize 只重画高亮覆盖层，**不要关面板**（布局变化时把用户正在写的面板关掉是纯伤害）
  window.addEventListener('resize', function () { paint(); });
  document.addEventListener('toggle', function () { setTimeout(paint, 30); }, true);

  // ================================================================ 启动
  function findFirstAnchored() {          // 返回 [key, kind]
    var ks = Object.keys(byKey);
    for (var i = 0; i < ks.length; i++) {
      if (cellMap[ks[i]]) return [ks[i], 'cell'];
      if (sentMap[ks[i]]) return [ks[i], 'sent'];
    }
    return null;
  }
  function openAt(key, kind) {
    if (kind === 'cell') {
      var td = cellMap[key];
      td.scrollIntoView({ block: 'center' });
      setTimeout(function () {
        open({ key: key, kind: 'cell', anchorText: anchorText(td).slice(0, 160) },
             td.getBoundingClientRect());
      }, 260);
    } else {
      var s = sentMap[key];
      s.el.scrollIntoView({ block: 'center' });
      setTimeout(function () {
        open({ key: key, kind: 'sent', anchorText: s.text.slice(0, 200) },
             rangeFor(textNodes(s.el), s.s, s.e).getBoundingClientRect());
      }, 260);
    }
  }
  function boot() {
    scan();
    buildNote();
    var bar = document.createElement('div');
    bar.className = 'sbn-bar';
    bar.setAttribute('data-sbn', '1');
    bar.innerHTML = '<button class="sbn-btn ghost" id="sbn-count">批注 0</button>' +
                    '<button class="sbn-btn ghost" id="sbn-note-toggle">笔记</button>';
    document.body.appendChild(bar);
    document.getElementById('sbn-note-toggle').addEventListener('click', function () {
      setNoteOpen(!document.body.classList.contains('sbn-note-open'));
    });
    document.getElementById('sbn-count').addEventListener('click', function () {
      // 有「未锚定」批注时优先打开它 —— 那些批注没有任何落点可点，不在这里列出就永远读不到
      var orph = orphanOf();
      if (orph.length) {
        var b = document.getElementById('sbn-count').getBoundingClientRect();
        open({ key: ORPHAN_KEY, kind: 'orphan',
               anchorText: '本页有 ' + orph.length + ' 条批注因报告改版失去了锚点（内容仍在，可查看或删除）。' },
             { top: b.top - 44, bottom: b.top - 44, left: b.left - 250 });
        return;
      }
      var hit = findFirstAnchored();
      if (hit) { openAt(hit[0], hit[1]); return; }
      alert(notes.length ? '本页 ' + notes.length + ' 条批注均未锚定（正文已改写），可在批注面板里查看。'
                         : '本页暂无批注。');
    });
    connect(3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供测试/排查用
  window.__sbn = { get online() { return online; }, get notes() { return notes; },
                   get pageNote() { return pageNote; },
                   get cells() { return Object.keys(cellMap).length; },
                   get rows() { return Object.keys(cellMap).length; },
                   get sents() { return Object.keys(sentMap).length; },
                   get alias() { return alias; },
                   get rowTexts() { return rowTexts; } };
})();
