/* stbuddy 批注（v2）—— 注入到每篇研报页。
   两种落点：
     · 表格数据行  → 点行即可批注（锚点 = 行文本指纹）
     · 任意一句话  → 点正文任意位置，自动落到「光标所在的那句话」上（锚点 = 该段文本指纹 + 句序）
   批注存 Cloudflare KV（经 /api/notes），所有持密码者共享可见。
   约束：不改研报正文（高亮用绝对定位覆盖层画，不动 DOM）；不依赖外部资源；后端不可用时静默降级。

   ★ 维护提醒：本文件被 stbuddy.py 内联进每篇研报（sbanotscript）。改完必须重跑 inject + verify
     （inject 会自动用新版覆盖旧版，别再指望"只插一次"）。
*/
(function () {
  'use strict';

  var TOKEN = '9aa2978b32c1ffa6d0bc3b359720fb32bb45bfb677d704c7eacf714b9e82aab5';
  var API = '/api/notes';
  var NICKEY = 'sb_nick';

  var m = /\/(\d{6})(?:\.html)?\/?$/.exec(location.pathname);
  if (!m) return;
  var CODE = m[1];

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
    '.sbn-row{cursor:pointer}' +
    '.sbn-row:hover>td{background:rgba(230,126,34,.07)!important}' +
    '.sbn-row.sbn-on>td{background:rgba(230,126,34,.12)!important}' +
    '.sbn-badge{display:inline-block;min-width:15px;height:15px;line-height:15px;text-align:center;' +
      'font-size:10px;font-weight:700;color:#fff;background:#e67e22;border-radius:8px;padding:0 4px;' +
      'margin-left:5px;vertical-align:middle;font-family:-apple-system,"Microsoft YaHei",sans-serif}' +
    '.sbn-hl{position:absolute;pointer-events:none;z-index:1;border-radius:3px;' +
      'background:rgba(230,126,34,.17);border-bottom:1.5px solid rgba(230,126,34,.55)}' +
    '.sbn-hl-sel{background:rgba(230,126,34,.3);border-bottom-color:#e67e22}' +
    '.sbn-hl-tag{position:absolute;pointer-events:none;z-index:2;font-size:9px;line-height:13px;' +
      'min-width:13px;height:13px;text-align:center;color:#fff;background:#e67e22;border-radius:7px;' +
      'font-weight:700;font-family:-apple-system,"Microsoft YaHei",sans-serif}' +
    '.sbn-bar{position:fixed;right:20px;bottom:70px;z-index:9998;display:flex;gap:8px}' +
    '.sbn-btn{border:none;border-radius:20px;padding:9px 15px;font-size:13px;cursor:pointer;' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.2)}' +
    '.sbn-btn.ghost{background:#1a5276;color:#fff}' +
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
    '.sbn-who{font-weight:700;color:#1a5276}' +
    '.sbn-del{cursor:pointer;color:#c0392b;font-size:11px}' +
    '.sbn-body{margin-top:3px;white-space:pre-wrap;word-break:break-word}' +
    '.sbn-empty{padding:10px 12px;color:#98a2ae;font-size:12px}' +
    '.sbn-form{padding:9px 12px;background:#fbfcfd;border-top:1px solid #e9edf2}' +
    '.sbn-form input,.sbn-form textarea{width:100%;box-sizing:border-box;border:1px solid #dfe4ea;' +
      'border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit;outline:none;color:#1c2733}' +
    '.sbn-form textarea{min-height:54px;resize:vertical;margin-top:6px}' +
    '.sbn-form input:focus,.sbn-form textarea:focus{border-color:#e67e22}' +
    '.sbn-foot{display:flex;justify-content:space-between;align-items:center;margin-top:7px;gap:8px}' +
    '.sbn-msg{font-size:11.5px;color:#98a2ae;flex:1}' +
    '.sbn-msg.err{color:#c0392b}' +
    '.sbn-msg.ok{color:#2f855a}' +
    '.sbn-save{border:none;border-radius:7px;background:#e67e22;color:#fff;padding:6px 14px;' +
      'font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '.sbn-save[disabled]{background:#c9d2dc;cursor:default}';
  var style = document.createElement('style');
  style.id = 'sbn-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---- 文本节点收集（跳过本插件自己的节点，避免指纹被自己的徽章污染）
  function textNodes(el) {
    var out = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = walker.nextNode())) {
      var p = n.parentNode;
      if (!p || !p.className || typeof p.className !== 'string' ||
          p.className.indexOf('sbn-') !== 0) out.push(n);
    }
    return out;
  }
  function blockText(el) {
    return textNodes(el).map(function (t) { return t.data; }).join('');
  }
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
  var SKIP_SEL = 'nav, header, footer, #sbgate, .sbn-bar, .sbn-panel, aside, .toc, #toc, script, style, pre, code';

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
  var notes = [];        // 全部批注 {id,rowKey,kind,rowText,text,user,ts}
  var byKey = {};        // 锚点 → [note]
  var rowMap = {};       // 行锚点 → tr
  var sentMap = {};      // 句锚点 → {el, s, e, text}
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
          if (j) { notes = j.items || []; online = true; offline = ''; }
          group(); paint();
          return online;
        })
        .catch(function () {
          if (n < max) return new Promise(function (res) { setTimeout(res, 700 * n); }).then(attempt);
          online = false; offline = 'network'; paint();
          return false;
        });
    }
    return attempt();
  }
  function errText() {
    return offline === 'network' ? '连不上批注服务，请重试' : '批注服务未启用';
  }

  function group() {
    byKey = {};
    notes.forEach(function (n) { (byKey[n.rowKey] = byKey[n.rowKey] || []).push(n); });
  }

  // ================================================================ 扫描落点 + 画高亮
  function scan() {
    rowMap = {}; sentMap = {};
    // 1) 表格数据行
    var trs = document.querySelectorAll('table tr');
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      if (!tr.closest('.sbn-panel,.sbn-bar,nav,header,footer,#sbgate') &&
          tr.children.length && /^TD$/.test(tr.children[0].tagName)) {
        var b = tr.querySelector('.sbn-badge');
        if (b) b.parentNode.removeChild(b);
        var k = hash32(norm(tr.textContent));
        rowMap[k] = tr;
        tr.classList.add('sbn-row');
      }
    }
    // 2) 句子（只扫文本块，跳过表格内的块——表格整行走的是行锚点）
    var all = document.querySelectorAll('p,li,div,dd,dt,blockquote,caption,figcaption,h1,h2,h3,h4,h5,h6,td,th');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.closest(SKIP_SEL) || el.tagName === 'SUMMARY') continue;
      if (!isTextBlock(el)) continue;
      var txt = blockText(el);
      if (txt.length < 4) continue;
      var bh = hash32(norm(txt)), ss = sentences(txt);
      if (ss.length > 200) continue;                     // 异常长块跳过，避免爆炸
      for (var s = 0; s < ss.length; s++) {
        var seg = txt.slice(ss[s][0], ss[s][1]).trim();
        if (seg.length < 2) continue;
        sentMap[bh + '-' + s] = { el: el, s: ss[s][0], e: ss[s][1], text: seg };
      }
    }
    paint();
  }

  function paint() {
    // 行徽章
    Object.keys(rowMap).forEach(function (k) {
      var tr = rowMap[k], list = byKey[k], old = tr.querySelector('.sbn-badge');
      if (old) old.parentNode.removeChild(old);
      tr.classList.remove('sbn-on');
      if (!list || !list.length) return;
      tr.classList.add('sbn-on');
      var cell = tr.children[0];
      if (cell) {
        var sp = document.createElement('span');
        sp.className = 'sbn-badge';
        sp.textContent = list.length;
        cell.appendChild(sp);
      }
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
          t.textContent = cnt;
          t.style.left = (rc.left + window.scrollX - 15) + 'px';
          t.style.top = (rc.top + window.scrollY - 1) + 'px';
          document.body.appendChild(t);
        }
      }
    });
    var btn = document.getElementById('sbn-count');
    if (btn) {
      var orphan = notes.filter(function (n) { return !rowMap[n.rowKey] && !sentMap[n.rowKey]; }).length;
      btn.textContent = '批注 ' + notes.length + (orphan ? '（' + orphan + ' 未锚定）' : '');
    }
  }

  // ================================================================ 面板
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
    panel.innerHTML =
      '<div class="sbn-head"><span>' + (anchor.kind === 'row' ? '行批注' : '句子批注') +
      '</span><span class="x" id="sbn-x">×</span></div>' +
      '<div class="sbn-anchor" id="sbn-anchor"></div>' +
      '<div class="sbn-list" id="sbn-list"></div>' +
      '<div class="sbn-form">' +
        '<input id="sbn-nick" maxlength="20" placeholder="你的名字（留空为「匿名」）">' +
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
    var a = document.getElementById('sbn-anchor');
    a.textContent = anchor.anchorText;
    try { document.getElementById('sbn-nick').value = localStorage.getItem(NICKEY) || ''; } catch (e) {}
    document.getElementById('sbn-x').addEventListener('click', close);
    document.getElementById('sbn-save').addEventListener('click', save);
    document.getElementById('sbn-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    });
    renderList();
    paint();
    if (online) document.getElementById('sbn-text').focus();
  }
  function renderList() {
    var box = document.getElementById('sbn-list');
    var list = (byKey[cur.key] || []).slice().sort(function (a, b) { return a.ts - b.ts; });
    if (!list.length) {
      box.innerHTML = '<div class="sbn-empty">这里还没有批注' +
        (online ? '，写下第一条。' : '。' + errText() + '。') + '</div>';
      return;
    }
    box.innerHTML = list.map(function (n) {
      return '<div class="sbn-item"><div class="sbn-meta"><span class="sbn-who">' + esc(n.user || '匿名') +
        '</span><span>' + fmt(n.ts) +
        (online ? ' · <span class="sbn-del" data-id="' + esc(n.id) + '">删除</span>' : '') +
        '</span></div><div class="sbn-body">' + esc(n.text) + '</div></div>';
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
    var u = document.getElementById('sbn-nick').value.trim();
    if (!t) { msg('内容不能为空', 'err'); return; }
    try { localStorage.setItem(NICKEY, u); } catch (e) {}
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
          rowText: String(cur.anchorText).slice(0, 200), text: t, user: u })
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (!res.j || !res.j.ok) {
            var e2 = res.j && res.j.error;
            msg(e2 === 'notes storage not configured' ? '批注服务未启用' : ('提交失败：' + (e2 || res.s)), 'err');
            return;
          }
          notes.push(res.j.item);
          group(); paint(); renderList();
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
          group(); paint(); renderList();
        } else { msg((j && j.error) || '删除失败', 'err'); }
      })
      .catch(function () { msg('网络不可用', 'err'); });
  }

  // ================================================================ 交互
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.sbn-panel')) return;   // 面板内部自理
    // 1) 表格数据行
    var tr = e.target.closest && e.target.closest('tr');
    if (tr && rowMap[hash32(norm(tr.textContent))] !== undefined) {
      if (e.target.closest('a')) return;                              // 单元格里的链接照常点
      e.preventDefault();
      var k = hash32(norm(tr.textContent));
      if (panel && cur && cur.key === k) { close(); return; }
      var r = tr.getBoundingClientRect();
      open({ key: k, kind: 'row', anchorText: norm(tr.textContent).slice(0, 160) }, r);
      return;
    }
    // 2) 正文句子
    if (e.target.closest && e.target.closest('a,button,input,textarea,select,summary,label,.sbn-bar')) {
      close(); return;
    }
    if (window.getSelection && String(window.getSelection()).length) return;  // 用户在选词，别抢
    var block = pickBlock(e.target);
    if (!block) { close(); return; }
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
  window.addEventListener('resize', function () { close(); paint(); });
  document.addEventListener('toggle', function () { setTimeout(paint, 30); }, true);

  // ================================================================ 启动
  function boot() {
    scan();
    var bar = document.createElement('div');
    bar.className = 'sbn-bar';
    bar.innerHTML = '<button class="sbn-btn ghost" id="sbn-count">批注 0</button>';
    document.body.appendChild(bar);
    document.getElementById('sbn-count').addEventListener('click', function () {
      var first = null;
      Object.keys(byKey).forEach(function (k) {
        if (first) return;
        if (rowMap[k]) first = rowMap[k];
        else if (sentMap[k]) first = sentMap[k].el;
      });
      if (first) {
        first.scrollIntoView({ block: 'center' });
        setTimeout(function () {
          var k = Object.keys(byKey).filter(function (x) { return rowMap[x] || sentMap[x]; })[0];
          if (rowMap[k]) { var r = rowMap[k].getBoundingClientRect(); open({ key: k, kind: 'row', anchorText: norm(rowMap[k].textContent).slice(0, 160) }, r); }
          else if (sentMap[k]) { var s = sentMap[k]; open({ key: k, kind: 'sent', anchorText: s.text.slice(0, 200) }, rangeFor(textNodes(s.el), s.s, s.e).getBoundingClientRect()); }
        }, 260);
      } else {
        alert(notes.length ? '本页 ' + notes.length + ' 条批注均未锚定（正文已改写），可在批注面板里查看。' : '本页暂无批注。');
      }
    });
    connect(3);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供测试/排查用
  window.__sbn = { get online() { return online; }, get notes() { return notes; },
                   get rows() { return Object.keys(rowMap).length; },
                   get sents() { return Object.keys(sentMap).length; } };
})();
