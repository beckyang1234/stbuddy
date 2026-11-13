/* stbuddy 站点脚本（v5）—— 注入到每篇研报页。功能三块：
     1. 编辑模式：正文可人工编辑（点击元素改文字 / 双击段落编辑整段 HTML / 图片插入），
        改动存 Cloudflare KV（经 /api/content），刷新即生效；「最终报告以人工编辑的为准」。
     2. 笔记栏（右侧）：与正文并列、永不遮挡。**笔记 = 报告的「结论与理由」章**，
        可整章编辑（像改文档一样），不再有"额外多出的笔记页面"。
     3. 图片：插入后默认折叠成一个「图 N」占位条，点开才显示在正文里，保持条理清晰。
   存储与鉴权同批注：/api/*，x-stb-token = 密码哈希，所有持密码者共享。
   ★ 2026-11-13 起：单元格/句子批注已按 Andy 指示下线（"可以把评论这个功能去掉"）。
*/
(function () {
  'use strict';

  var TOKEN = '9aa2978b32c1ffa6d0bc3b359720fb32bb45bfb677d704c7eacf714b9e82aab5';
  var API_NOTE = '/api/notes';      // 笔记（沿用旧接口，kind='page'）
  var API_CONTENT = '/api/content'; // 正文编辑（新接口）
  var PAGE_ANCHOR = 'page';
  var NOTE_MAX = 20000;             // 笔记章上限（原 5000，改整章后放宽）

  var m = /\/(\d{6})(?:\.html)?\/?$/.exec(location.pathname);
  if (!m) return;
  var CODE = m[1];
  var DRAFTKEY = 'sb_note_draft_' + CODE;
  var EDITSKEY = 'sb_edits_' + CODE;

  // ================================================================ 工具
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escA(s) { return esc(s).replace(/\n/g, ' '); }
  function fmt(ts) {
    var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function sha256hex(s) {
    // 异步：crypto.subtle 在 http(s) 可用；file:// 下降级（demo 用）
    if (location.protocol === 'https:' && window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
        .then(function (b) {
          return Array.prototype.map.call(new Uint8Array(b), function (x) {
            return ('0' + x.toString(16)).slice(-2);
          }).join('');
        });
    }
    return Promise.resolve(null);
  }

  // ================================================================ 样式
  var CSS = '' +
    // ---------- 版面：三区并行 = 目录 │ 正文 │ 笔记，永不互相遮挡 ----------
    //  ★ Mac Retina 上 24px 间隔看起来偏大（实际是 .wrap 内容没占满 max-width，
    //    居中布局的对称留白被误认为"笔记栏与正文间隔大"）—— 间隔收紧为 12px，
    //    并让 .wrap 吃满剩余宽度，紧贴笔记栏。
    'body{--sbn-nw:380px;--sbn-nh:46vh}' +
    '@media(max-width:1399px){body{--sbn-nw:340px}}' +
    '@media(max-width:1099px){body{--sbn-nw:300px}}' +
    '.wrap{max-width:1080px;margin:0 0 0 28px}' +
    '@media(max-width:767px){.wrap{margin:0 auto}}' +
    '#sbn-note{position:fixed;right:0;top:0;bottom:0;width:var(--sbn-nw);z-index:9002;background:#fff;' +
      'border-left:1px solid #e3e7ee;display:none;flex-direction:column;color:#1c2733;' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;font-size:13px}' +
    'body.sbn-note-open #sbn-note{display:flex}' +
    // ★ 并行核心：正文让位；间隔 12px（原 24，Mac 上显松）—— 紧贴但不粘连
    'body.sbn-note-open{padding-right:calc(var(--sbn-nw) + 12px)}' +
    // ★ 宽屏下 .wrap 默认 max-width 1080，右边到笔记栏之间会有大块空白 → 让正文吃满
    '@media(min-width:768px){body.sbn-note-open .wrap{max-width:none;margin-right:0}}' +
    // 右下角悬浮轨道随笔记栏左移
    'body.sbn-note-open .sbn-bar{right:calc(var(--sbn-nw) + 20px)}' +
    'body.sbn-note-open #totop{right:calc(var(--sbn-nw) + 20px)}' +
    'body.sbn-note-open a[href$="index.html"]{right:calc(var(--sbn-nw) + 20px)!important}' +
    // <768：上下分屏
    '@media(max-width:767px){' +
      'body.sbn-note-open{padding-right:24px}' +
      'body.sbn-note-open .wrap{max-height:calc(100vh - var(--sbn-nh) - 52px);overflow-y:auto;' +
        'overscroll-behavior:contain;-webkit-overflow-scrolling:touch}' +
      '#sbn-note{left:0;right:0;width:auto;top:auto;bottom:0;height:var(--sbn-nh);' +
        'border-left:none;border-top:1px solid #e3e7ee;box-shadow:0 -8px 28px rgba(16,32,48,.16)}' +
      'body.sbn-note-open .sbn-bar{display:none!important}' +
      'body.sbn-note-open a[href$="index.html"]{display:none!important}' +
      'body.sbn-note-open #totop{display:none!important}' +
    '}' +
    '@media(max-width:767px) and (max-height:520px){' +
      'body{--sbn-nw:260px}' +
      '#sbn-note{left:auto;right:0;top:0;bottom:0;width:var(--sbn-nw);height:auto;' +
        'border-top:none;border-left:1px solid #e3e7ee;box-shadow:-8px 0 28px rgba(16,32,48,.16)}' +
      'body.sbn-note-open{padding-right:calc(var(--sbn-nw) + 24px)}' +
      'body.sbn-note-open .wrap{max-height:none;overflow:visible}' +
    '}' +
    // ---------- 笔记栏内部 ----------
    '#sbn-note-head{padding:10px 14px;border-bottom:1px solid #e9edf2;background:#f6f8fa;' +
      'display:flex;align-items:center;gap:8px}' +
    '#sbn-note-head b{font-size:13px;white-space:nowrap}' +
    '#sbn-note-home{display:none;text-decoration:none;color:#5b6472;font-size:12px;' +
      'padding:2px 7px;border-radius:6px;border-bottom:none;white-space:nowrap}' +
    '#sbn-note-head .cnt{margin-left:auto;font-size:11px;color:#98a2ae;white-space:nowrap}' +
    '#sbn-note-save-top{display:none;border:none;border-radius:7px;background:#e67e22;color:#fff;' +
      'padding:5px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '#sbn-note-save-top[disabled]{background:#c9d2dc;cursor:default}' +
    '#sbn-note-head .x{cursor:pointer;color:#8b96a3;font-size:16px;line-height:1;padding:0 2px}' +
    // 笔记栏内容区：像正文一样渲染富文本（结论/理由链/触发/失效条件）
    '#sbn-note-body{flex:1 1 auto;overflow-y:auto;padding:14px 16px 24px;font-size:13.5px;' +
      'line-height:1.8;color:#1c2733}' +
    '#sbn-note-body:empty::after{content:"这一章还没有内容。点右下「编辑」写下结论与理由。";color:#98a2ae}' +
    '#sbn-note-body h4{margin:14px 0 6px;font-size:13px;color:#1f3a5f;border-bottom:1px dashed #dbe3ee;' +
      'padding-bottom:4px}' +
    '#sbn-note-body h3{margin:16px 0 8px;font-size:14.5px;color:#1f3a5f}' +
    '#sbn-note-body ol,#sbn-note-body ul{margin:4px 0;padding-left:22px}' +
    '#sbn-note-body li{margin:6px 0}' +
    '#sbn-note-body p{margin:8px 0}' +
    '#sbn-note-body .lead{padding:10px 12px;border-left:3px solid #b3261e;background:#fdf3f2;' +
      'border-radius:0 8px 8px 0;font-weight:600;margin:0 0 12px}' +
    '#sbn-note-body .buy{border-left-color:#2f855a;background:#e8f5ee}' +
    '#sbn-note-edit{display:none;flex:1 1 auto;flex-direction:column;overflow:hidden}' +
    '#sbn-note-text{flex:1 1 auto;width:100%;box-sizing:border-box;border:none;outline:none;' +
      'resize:none;padding:12px 14px;font-size:13px;line-height:1.75;font-family:inherit;color:#1c2733;' +
      'background:#fffdf8}' +
    '#sbn-note-foot{padding:8px 14px;border-top:1px solid #e9edf2;background:#fbfcfd;' +
      'display:flex;align-items:center;gap:8px}' +
    '#sbn-note-foot .sbn-msg{flex:1}' +
    '.sbn-save{border:none;border-radius:7px;background:#e67e22;color:#fff;padding:6px 14px;' +
      'font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '.sbn-save[disabled]{background:#c9d2dc;cursor:default}' +
    '#sbn-note[data-warn="1"] #sbn-note-head{background:#fff6ec}' +
    // ---------- 编辑模式 ----------
    'body.sb-editing [data-sbe]{outline:1.5px dashed rgba(230,126,34,.55);outline-offset:2px;cursor:text}' +
    'body.sb-editing [data-sbe]:hover{background:rgba(230,126,34,.06)}' +
    '#sbe-hint{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:10000;' +
      'background:#1f3a5f;color:#fff;padding:8px 16px;border-radius:18px;font-size:12.5px;' +
      'box-shadow:0 6px 18px rgba(15,23,42,.3);display:none}' +
    'body.sb-editing #sbe-hint{display:block}' +
    '.sbe-imgbtn{position:absolute;left:0;top:-22px;z-index:9;display:none;gap:4px}' +
    'body.sb-editing .sbe-imgbtn{display:flex}' +
    '.sbe-imgbtn button{border:1px solid #cfd8e3;background:#fff;border-radius:6px;font-size:11px;' +
      'padding:2px 7px;cursor:pointer;color:#33506b}' +
    // ---------- 图片（可折叠） ----------
    '.sbe-fig{margin:14px 0}' +
    '.sbe-fig-toggle{display:inline-flex;align-items:center;gap:6px;border:1px solid #cfd8e3;' +
      'background:#f6f8fa;border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;color:#33506b}' +
    '.sbe-fig-toggle:hover{background:#eef2f7}' +
    '.sbe-fig-toggle .tri{display:inline-block;transition:transform .15s;font-size:10px;color:#98a2ae}' +
    '.sbe-fig.open .sbe-fig-toggle .tri{transform:rotate(90deg)}' +
    '.sbe-fig-body{display:none;margin-top:8px}' +
    '.sbe-fig.open .sbe-fig-body{display:block!important}' +
    '.sbe-fig img{max-width:100%;border-radius:8px;border:1px solid #e3e7ee}' +
    '.sbe-fig figcaption{font-size:11.5px;color:#98a2ae;margin-top:5px}' +
    // ---------- 悬浮条 ----------
    '.sbn-bar{position:fixed;right:20px;bottom:140px;z-index:9998;display:flex;gap:8px;flex-direction:column;align-items:flex-end}' +
    '.sbn-btn{border:none;border-radius:20px;padding:9px 15px;font-size:13px;cursor:pointer;' +
      'font-family:-apple-system,"Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.2)}' +
    '.sbn-btn.ghost{background:#1a5276;color:#fff}' +
    '.sbn-btn.ghost.on{background:#e67e22}' +
    '.sbn-btn.danger{background:#8e2b2b;color:#fff;font-size:12px;padding:7px 12px}' +
    '@media(max-width:767px){#sbn-note-save-top{display:inline-block}#sbn-note-save{display:none}' +
      'body.sbn-note-open #sbn-note-home{display:inline-block}}';
  var style = document.createElement('style');
  style.id = 'sbn-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  // ================================================================ 数据层
  var online = false, offline = '';
  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) { return { s: r.status, j: j }; });
    });
  }
  function connect(tries) {
    var max = tries || 2, n = 0;
    function attempt() {
      n++;
      return fetchJSON(API_NOTE + '?code=' + CODE, { headers: { 'x-stb-token': TOKEN } })
        .then(function (res) {
          if (res.s === 200 && res.j && res.j.ok) { online = true; offline = ''; ingestNote(res.j.items); return true; }
          offline = (res.s === 503) ? 'config' : 'config';
          return false;
        })
        .catch(function () {
          if (n < max) return new Promise(function (res) { setTimeout(res, 700 * n); }).then(attempt);
          online = false; offline = 'network';
          return false;
        });
    }
    return attempt();
  }

  // ---- 笔记（结论与理由章）
  var pageNote = null;
  function ingestNote(items) {
    pageNote = null;
    (items || []).forEach(function (n) {
      if (n.kind === 'page' || n.rowKey === PAGE_ANCHOR) {
        if (!pageNote || n.ts > pageNote.ts) pageNote = n;
      }
    });
    syncNote();
  }
  var noteBox = null, noteDirty = false, noteTimer = null, noteEdit = false;
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
    var v = noteBox ? noteBox.value : '';
    var el = document.getElementById('sbn-note-cnt');
    if (el) el.textContent = v.length + ' / ' + NOTE_MAX;
  }
  function renderNoteBody(mdLike) {
    // 渲染"类 Markdown"为 HTML：## 标题 / - 列表 / 1. 列表 / **加粗** / 首段 lead
    var box = document.getElementById('sbn-note-body');
    if (!box) return;
    var src = mdLike || (pageNote && pageNote.text) || '';
    if (!src.trim()) { box.innerHTML = ''; return; }
    var lines = src.split(/\r?\n/), out = [], inOl = false, inUl = false, first = true;
    function inline(s) {
      return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    }
    function closeLists() {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (inUl) { out.push('</ul>'); inUl = false; }
    }
    lines.forEach(function (raw) {
      var l = raw.trim();
      if (!l) { closeLists(); return; }
      var h = /^#{2,4}\s+(.*)$/.exec(l);
      if (h) { closeLists(); out.push('<h4>' + inline(h[1]) + '</h4>'); return; }
      var ol = /^(\d+)[.、]\s+(.*)$/.exec(l);
      if (ol) {
        if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
        out.push('<li>' + inline(ol[2]) + '</li>'); return;
      }
      var ul = /^[-•]\s+(.*)$/.exec(l);
      if (ul) {
        if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
        out.push('<li>' + inline(ul[2]) + '</li>'); return;
      }
      closeLists();
      if (first) { out.push('<p class="lead">' + inline(l) + '</p>'); first = false; return; }
      out.push('<p>' + inline(l) + '</p>');
    });
    closeLists();
    box.innerHTML = out.join('');
    // 结论是买入时 lead 变绿
    if (/^\*\*?结论[：:]*\*?\*?.{0,6}买/.test(src.trim())) {
      var lead = box.querySelector('.lead');
      if (lead) lead.classList.add('buy');
    }
  }
  function syncNote() {
    if (!noteBox) return;
    var draft = readDraft(), srv = (pageNote && pageNote.text) || '';
    if (noteDirty) { noteCount(); return; }
    renderNoteBody(draft && draft !== srv ? draft : srv);
    if (draft && draft !== srv) {
      noteDirty = true;
      noteMsg('有未保存的草稿', 'err');
      var d = document.getElementById('sbn-note');
      if (d) d.setAttribute('data-warn', '1');
    } else {
      noteMsg(pageNote ? ('已存 · ' + fmt(pageNote.ts)) : '　');
      var d2 = document.getElementById('sbn-note');
      if (d2) d2.removeAttribute('data-warn');
    }
    noteCount();
  }
  function saveNote() {
    if (!noteBox) return;
    var t = noteBox.value;
    if (t.length > NOTE_MAX) { noteMsg('超出 ' + NOTE_MAX + ' 字上限', 'err'); return; }
    if (!t.trim()) { noteMsg('笔记为空，无需保存', 'err'); return; }
    var btns = [document.getElementById('sbn-note-save'), document.getElementById('sbn-note-save-top')]
      .filter(function (b) { return !!b; });
    btns.forEach(function (b) { b.disabled = true; });
    noteMsg('保存中…');
    var pre = online ? Promise.resolve(true) : connect(2);
    pre.then(function (okNow) {
      if (!okNow) { btns.forEach(function (b) { b.disabled = false; }); noteMsg('笔记服务未启用', 'err'); return; }
      return fetchJSON(API_NOTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stb-token': TOKEN },
        body: JSON.stringify({ code: CODE, rowKey: PAGE_ANCHOR, kind: 'page', text: t,
          baseTs: pageNote ? pageNote.ts : 0 })
      }).then(function (res) {
        btns.forEach(function (b) { b.disabled = false; });
        if (!res.j || !res.j.ok) {
          if (res.s === 409) { noteMsg('已被他人更新，请刷新后再改', 'err'); return; }
          noteMsg('保存失败：' + ((res.j && res.j.error) || res.s), 'err');
          return;
        }
        pageNote = res.j.item; noteDirty = false; writeDraft('');
        renderNoteBody(t);
        var d = document.getElementById('sbn-note');
        if (d) d.removeAttribute('data-warn');
        noteMsg('已保存 · ' + fmt(pageNote.ts), 'ok');
      }).catch(function () {
        btns.forEach(function (b) { b.disabled = false; });
        noteMsg('连不上服务，请重试', 'err');
      });
    });
  }

  // ---- 正文编辑（覆盖层：selector → 新 HTML）
  var edits = {};          // { selector: {html, ts} }
  function loadEdits() {
    try { edits = JSON.parse(localStorage.getItem(EDITSKEY) || '{}'); } catch (e) { edits = {}; }
    return fetchJSON(API_CONTENT + '?code=' + CODE, { headers: { 'x-stb-token': TOKEN } })
      .then(function (res) {
        if (res.s === 200 && res.j && res.j.ok) {
          var srv = {};
          (res.j.items || []).forEach(function (it) { srv[it.sel] = it; });
          // 合并：服务端优先，本机草稿其次
          Object.keys(srv).forEach(function (k) { edits[k] = srv[k]; });
        }
        return true;
      }).catch(function () { return false; });
  }
  function persistEdits() {
    try { localStorage.setItem(EDITSKEY, JSON.stringify(edits)); } catch (e) {}
  }
  // 把编辑应用到正文（页面加载 & 保存后）
  function applyEdits() {
    var wrap = document.querySelector('.wrap');
    if (!wrap) return;
    Object.keys(edits).forEach(function (sel) {
      try {
        var el = wrap.querySelector(sel);
        if (el) el.innerHTML = edits[sel].html;
      } catch (e) { /* selector 失效（报告改版）→ 忽略该条 */ }
    });
  }
  function selOf(el) {
    // 生成元素在 .wrap 内的稳定 selector：tag + nth + id（有 id 用 id）
    if (el.id) return '#' + el.id;
    var path = [], cur = el, wrap = document.querySelector('.wrap');
    while (cur && cur !== wrap) {
      var tag = cur.tagName.toLowerCase(), idx = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === cur.tagName) idx++;
      }
      path.unshift(tag + ':nth-of-type(' + idx + ')');
      cur = cur.parentElement;
    }
    return path.join('>');
  }
  function saveEdit(el, html) {
    var sel = selOf(el);
    edits[sel] = { html: html, ts: Date.now() };
    persistEdits();
    applyEdits();
    var msgEl = document.getElementById('sbe-hint');
    if (msgEl) {
      msgEl.textContent = '⏳ 正在上传改动…';
      return fetchJSON(API_CONTENT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-stb-token': TOKEN },
        body: JSON.stringify({ code: CODE, sel: sel, html: html, ts: edits[sel].ts })
      }).then(function (res) {
        if (res.j && res.j.ok) { msgEl.textContent = '✓ 已保存（' + fmt(edits[sel].ts) + '）'; }
        else { msgEl.textContent = '⚠ 存本机但上传失败（' + ((res.j && res.j.error) || res.s) + '）'; }
        setTimeout(function () { msgEl.textContent = HINT_TEXT; }, 2600);
      }).catch(function () {
        msgEl.textContent = '⚠ 存本机但连不上服务';
        setTimeout(function () { msgEl.textContent = HINT_TEXT; }, 2600);
      });
    }
  }

  // ---- 编辑模式开关
  var editing = false;
  var HINT_TEXT = '编辑模式：点击正文元素改文字；双击段落编辑整段；拖图片文件进正文插入。';
  function setEditing(on) {
    editing = !!on;
    document.body.classList[on ? 'add' : 'remove']('sb-editing');
    var btn = document.getElementById('sbe-toggle');
    if (btn) { btn.classList[on ? 'add' : 'remove']('on'); btn.textContent = on ? '完成编辑' : '编辑'; }
    var hint = document.getElementById('sbe-hint');
    if (hint) hint.textContent = HINT_TEXT;
    if (!on) { closeInline(); }
  }

  // ---- 行内编辑（点击元素 → 弹小输入框改文字）
  var inlineBox = null, inlineTarget = null;
  function closeInline() {
    if (inlineBox) { inlineBox.parentNode.removeChild(inlineBox); inlineBox = null; inlineTarget = null; }
  }
  function openInline(el) {
    closeInline();
    inlineTarget = el;
    inlineBox = document.createElement('textarea');
    inlineBox.className = 'sbe-inline';
    inlineBox.style.cssText = 'display:block;width:calc(100% - 24px);min-height:60px;margin:6px 0;' +
      'border:1.5px solid #e67e22;border-radius:8px;padding:8px 10px;font:inherit;color:inherit;z-index:9;position:relative;' +
      'box-sizing:border-box;background:#fffdf8';
    inlineBox.value = el.innerText;
    el.parentNode.insertBefore(inlineBox, el.nextSibling);
    inlineBox.focus();
    // Ctrl+Enter 或失焦保存
    inlineBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commitInline(); }
      if (e.key === 'Escape') { closeInline(); }
    });
    inlineBox.addEventListener('blur', function () { setTimeout(commitInline, 120); });
  }
  function commitInline() {
    if (!inlineBox || !inlineTarget) return;
    var v = inlineBox.value;
    var el = inlineTarget;
    closeInline();
    if (v !== el.innerText) {
      // 只改第一个文本节点，保留元素内的 <a>/<b> 等结构（有链接时提示用双击）
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      var first = walker.nextNode();
      if (first && el.querySelectorAll('a,img,table').length === 0) {
        first.nodeValue = v;
        saveEdit(el, el.innerHTML);
      } else {
        // 结构复杂 → 整段替换为纯文本
        saveEdit(el, esc(v).replace(/\n/g, '<br>'));
      }
    }
  }

  // ---- 整段 HTML 编辑（双击）
  var htmlBox = null;
  function openHtmlEdit(el) {
    closeHtmlEdit();
    htmlBox = document.createElement('textarea');
    htmlBox.style.cssText = 'display:block;width:100%;min-height:200px;margin:6px 0;' +
      'border:1.5px solid #1a5276;border-radius:8px;padding:10px;font:12px/1.6 Consolas,monospace;' +
      'z-index:9;box-sizing:border-box;background:#f6f8fc;color:#1c2733';
    htmlBox.value = el.innerHTML;
    el.parentNode.insertBefore(htmlBox, el.nextSibling);
    el.style.display = 'none';
    htmlBox.focus();
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin:4px 0 10px';
    bar.innerHTML = '<button class="sbn-save" style="background:#2f855a">保存整段</button>' +
                    '<button class="sbn-save" style="background:#8e2b2b">取消</button>';
    htmlBox.parentNode.insertBefore(bar, htmlBox.nextSibling);
    bar.children[0].addEventListener('click', function () {
      saveEdit(el, htmlBox.value);
      closeHtmlEdit();
    });
    bar.children[1].addEventListener('click', closeHtmlEdit);
  }
  function closeHtmlEdit() {
    if (htmlBox) {
      var el = htmlBox.previousSibling;
      if (el && el.style) el.style.display = '';
      var bar = htmlBox.nextSibling;
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      htmlBox.parentNode.removeChild(htmlBox);
      htmlBox = null;
    }
  }

  // ---- 图片：拖拽/粘贴插入；默认折叠
  function makeFig(src, caption) {
    var fig = document.createElement('figure');
    fig.className = 'sbe-fig';
    var tg = document.createElement('button');
    tg.className = 'sbe-fig-toggle';
    tg.type = 'button';
    tg.innerHTML = '<span class="tri">▶</span> 🖼 ' + escA(caption || '图片');
    var body = document.createElement('div');
    body.className = 'sbe-fig-body';
    var img = document.createElement('img');
    img.src = src;
    img.alt = caption || '';
    body.appendChild(img);
    if (caption) {
      var cap = document.createElement('figcaption');
      cap.textContent = caption;
      body.appendChild(cap);
    }
    fig.appendChild(tg); fig.appendChild(body);
    return fig;
  }
  function insertImgAt(el, dataUrl, caption) {
    var fig = makeFig(dataUrl, caption);
    // 插到目标元素后面（或内部末尾）
    if (el.tagName === 'TD' || el.tagName === 'TH') el.appendChild(fig);
    else el.parentNode.insertBefore(fig, el.nextSibling);
    saveEdit(el.tagName === 'TD' || el.tagName === 'TH' ? el : el.parentNode, (el.tagName === 'TD' || el.tagName === 'TH' ? el : el.parentNode).innerHTML);
  }
  // 图片上传到 KV（dataURL 存 KV，上限 ~380KB 过 base64 后）
  function uploadImg(file, cb) {
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) { alert('只支持 png/jpg/gif/webp'); return; }
    if (file.size > 280 * 1024) { alert('图片请压缩到 280KB 以内（截图可用 TinyPNG 或画图另存）'); return; }
    var fr = new FileReader();
    fr.onload = function () { cb(fr.result); };
    fr.readAsDataURL(file);
  }
  document.addEventListener('dragover', function (e) {
    if (editing && e.dataTransfer && e.dataTransfer.types.indexOf('Files') >= 0) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    }
  });
  document.addEventListener('drop', function (e) {
    if (!editing || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    var f = e.dataTransfer.files[0];
    var block = pickBlock(e.target);
    if (!block) { alert('请拖到正文某个段落上'); return; }
    uploadImg(f, function (dataUrl) {
      var cap = (prompt('图片说明（可留空）') || '').trim();
      insertImgAt(block, dataUrl, cap || ('图 ' + new Date().toISOString().slice(5, 10).replace('-', '/')));
    });
  });
  document.addEventListener('paste', function (e) {
    if (!editing) return;
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var f = items[i].getAsFile();
        if (!f) continue;
        e.preventDefault();
        var sel = window.getSelection();
        var node = sel && sel.anchorNode;
        var block = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
        block = block ? pickBlock(block) : null;
        if (!block) { alert('请先把光标点在正文某个段落里'); return; }
        uploadImg(f, function (dataUrl) {
          var cap = (prompt('图片说明（可留空）') || '').trim();
          insertImgAt(block, dataUrl, cap || ('截图 ' + new Date().toISOString().slice(5, 10).replace('-', '/')));
        });
        return;
      }
    }
  });

  // 图片占位条的开合：全局事件委托（一次注册，任何 .sbe-fig-toggle 都有效，
  // 包括编辑保存后 innerHTML 还原出来的 —— 元素级监听会丢，委托不会）
  document.addEventListener('click', function (e) {
    var tg = e.target.closest && e.target.closest('.sbe-fig-toggle');
    if (!tg) return;
    e.preventDefault();
    var fig = tg.closest('.sbe-fig');
    if (fig) fig.classList.toggle('open');
  });

  // ---- 编辑模式的点击分发
  function pickBlock(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.closest && cur.closest('#sbn-note,.sbn-bar,#sbgate,nav,aside,script,style')) return null;
      var tag = cur.tagName;
      if (/^(P|H[1-6]|LI|TD|TH|BLOCKQUOTE|PRE|FIGCAPTION)$/.test(tag)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  document.addEventListener('click', function (e) {
    if (!editing) return;
    if (e.target.closest && e.target.closest('.sbn-bar,#sbn-note,#sbe-hint,.sbe-fig-toggle,button,a,input,textarea,summary')) return;
    // 点击图片占位条的编辑按钮在别处处理
    var block = pickBlock(e.target);
    if (!block) return;
    e.preventDefault();
    if (inlineTarget === block) return;   // 已在编辑
    openInline(block);
  });
  document.addEventListener('dblclick', function (e) {
    if (!editing) return;
    if (e.target.closest && e.target.closest('.sbn-bar,#sbn-note,#sbe-hint,button,textarea,input,summary')) return;
    var block = pickBlock(e.target);
    if (!block) return;
    e.preventDefault();
    closeInline();
    openHtmlEdit(block);
  });

  // ================================================================ 笔记栏 UI
  var tocSavedByNote = false;
  function syncTocForNote() {
    var b = document.body;
    if (!b) return;
    var need = b.classList.contains('sbn-note-open') && window.innerWidth < 1100;
    if (need) {
      if (b.classList.contains('toc-open')) {
        tocSavedByNote = true;
        b.classList.remove('toc-open');
        b.classList.add('toc-closed');
      }
    } else if (tocSavedByNote) {
      tocSavedByNote = false;
      b.classList.add('toc-open');
      b.classList.remove('toc-closed');
    }
  }
  function setNoteOpen(on) {
    var open = !!on;
    document.body.classList[open ? 'add' : 'remove']('sbn-note-open');
    var tg = document.getElementById('sbn-note-toggle');
    if (tg) tg.classList[open ? 'add' : 'remove']('on');
    try { localStorage.setItem('sb_note_open', open ? '1' : ''); } catch (e) {}
    syncTocForNote();
  }
  function buildNote() {
    var d = document.createElement('div');
    d.id = 'sbn-note';
    d.setAttribute('data-sbn', '1');
    d.innerHTML =
      '<div id="sbn-note-head"><b>结论与理由</b>' +
        '<a id="sbn-note-home" href="../" title="返回首页">← 首页</a>' +
        '<span class="cnt" id="sbn-note-cnt"></span>' +
        '<button id="sbn-note-edit-btn" title="编辑这一章">✎</button>' +
        '<button id="sbn-note-save-top">保存</button>' +
        '<span class="x" id="sbn-note-close" title="收起">×</span></div>' +
      '<div id="sbn-note-body"></div>' +
      '<div id="sbn-note-edit">' +
        '<textarea id="sbn-note-text" maxlength="' + NOTE_MAX + '" ' +
          'placeholder="写下这一篇的结论与理由 —— 支持简单格式：&#10;## 小节标题&#10;1. 理由一&#10;- 要点&#10;**加粗**"></textarea>' +
      '</div>' +
      '<div id="sbn-note-foot"><span class="sbn-msg" id="sbn-note-msg">　</span>' +
        '<button class="sbn-save" id="sbn-note-save">保存</button></div>';
    document.body.appendChild(d);
    noteBox = document.getElementById('sbn-note-text');
    document.getElementById('sbn-note-close').addEventListener('click', function () { setNoteOpen(false); });
    document.getElementById('sbn-note-save').addEventListener('click', saveNote);
    document.getElementById('sbn-note-save-top').addEventListener('click', saveNote);
    document.getElementById('sbn-note-edit-btn').addEventListener('click', function () {
      noteEdit = !noteEdit;
      var body = document.getElementById('sbn-note-body'), ed = document.getElementById('sbn-note-edit');
      var btn = document.getElementById('sbn-note-edit-btn');
      if (noteEdit) {
        noteBox.value = (pageNote && pageNote.text) || readDraft() || '';
        body.style.display = 'none'; ed.style.display = 'flex';
        btn.textContent = '👁'; btn.title = '预览';
        noteDirty = true; noteCount(); noteBox.focus();
      } else {
        body.style.display = ''; ed.style.display = 'none';
        btn.textContent = '✎'; btn.title = '编辑这一章';
        noteDirty = false; renderNoteBody(noteBox.value);
      }
    });
    noteBox.addEventListener('input', function () {
      noteDirty = true; noteCount();
      var dd = document.getElementById('sbn-note');
      if (dd) dd.setAttribute('data-warn', '1');
      noteMsg('未保存…', 'err');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { writeDraft(noteBox.value); }, 400);
    });
    noteBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote();
    });
    var want = null;
    try { want = localStorage.getItem('sb_note_open'); } catch (e) {}
    setNoteOpen(want === null ? window.innerWidth >= 1200 : want === '1');
  }

  // ================================================================ 启动
  function boot() {
    buildNote();
    var bar = document.createElement('div');
    bar.className = 'sbn-bar';
    bar.setAttribute('data-sbn', '1');
    bar.innerHTML = '<button class="sbn-btn ghost" id="sbn-note-toggle">结论</button>' +
                    '<button class="sbn-btn ghost" id="sbe-toggle">编辑</button>';
    document.body.appendChild(bar);
    document.getElementById('sbn-note-toggle').addEventListener('click', function () {
      setNoteOpen(!document.body.classList.contains('sbn-note-open'));
    });
    document.getElementById('sbe-toggle').addEventListener('click', function () { setEditing(!editing); });

    var hint = document.createElement('div');
    hint.id = 'sbe-hint';
    hint.textContent = HINT_TEXT;
    document.body.appendChild(hint);

    loadEdits().then(function () { applyEdits(); });
    connect(3);
    window.addEventListener('resize', syncTocForNote);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供测试/排查用
  window.__sbn = { get online() { return online; }, get pageNote() { return pageNote; },
                   get edits() { return edits; }, get editing() { return editing; },
                   get noteOpen() { return document.body.classList.contains('sbn-note-open'); } };
})();
