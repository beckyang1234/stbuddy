/**
 * stbuddy 正文编辑 API —— Cloudflare Pages Function
 * 路由：/api/content
 *
 *   GET    /api/content?code=002109          列出该报告的正文编辑（selector → html）
 *   POST   /api/content                      {code, sel, html, ts} 保存一处编辑（sel 是正文内 selector）
 *   DELETE /api/content?code=002109&sel=...  删除一处编辑（还原原文）
 *
 * 存储：KV key = c:<code>:<sha1(sel) 的前 16 位>（一处编辑一个 key，selector 做哈希避免特殊字符）。
 *      同时维护一个索引 key c:<code>:__index 记录 sel → hashKey 的映射（GET 时按索引取）。
 *      简化实现：值里带 sel，GET 时用 list 前缀 + 过滤，够用（每篇编辑数不会大）。
 *
 * ★ 与 /api/notes 同一鉴权（x-stb-token = 密码哈希）→ 所有持密码者可编辑。
 * ★ 「最终报告以人工编辑的为准」：前端在页面加载时把编辑覆盖到正文上。
 * ★ 图片以 dataURL 存在 html 里（上限 280KB/图，KV 单值上限 25MB，一篇 30 张图也在范围内）。
 *
 * KV 绑定：与 /api/notes 共用 STBUDDY_NOTES。
 */

const DEFAULT_TOKEN = '9aa2978b32c1ffa6d0bc3b359720fb32bb45bfb677d704c7eacf714b9e82aab5';
const MAX_HTML = 400000;       // 单处编辑的 HTML 上限（含 dataURL 图片）
const MAX_PER_REPORT = 200;    // 每篇最多编辑处数

const H = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: H });
const bad = (error, status = 400) => out({ ok: false, error }, status);
const isCode = (c) => /^\d{6}$/.test(c);

function hashKey(sel) {
  // FNV-1a 32 位（与前端 selector 哈希无关，只做 key 去特殊字符）
  let h = 0x811c9dc5;
  for (let i = 0; i < sel.length; i++) {
    h ^= sel.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

  const want = env.STB_NOTES_TOKEN || DEFAULT_TOKEN;
  if ((request.headers.get('x-stb-token') || '') !== want) return bad('unauthorized', 401);

  const kv = env.STBUDDY_NOTES;
  if (!kv) return bad('content storage not configured', 503);

  const url = new URL(request.url);

  try {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return bad('bad json'); }
      const code = String(body.code || url.searchParams.get('code') || '').trim();
      if (!isCode(code)) return bad('bad code');
      return await saveEdit(body, kv, code);
    }

    const code = (url.searchParams.get('code') || '').trim();
    if (!isCode(code)) return bad('bad code');

    if (request.method === 'GET') return await listEdits(kv, code);
    if (request.method === 'DELETE') return await delEdit(kv, url, code);
    return bad('method not allowed', 405);
  } catch (e) {
    return bad('server error: ' + (e && e.message ? e.message : 'unknown'), 500);
  }
}

async function listEdits(kv, code) {
  const { keys } = await kv.list({ prefix: `c:${code}:`, limit: 1000 });
  const items = (await Promise.all(
    keys.filter((k) => !k.name.endsWith(':__index'))
        .map((k) => kv.get(k.name, 'json').catch(() => null))
  )).filter(Boolean);
  items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out({ ok: true, items });
}

async function saveEdit(body, kv, code) {
  const sel = String(body.sel || '').trim();
  const html = String(body.html || '');
  const ts = Number(body.ts) || Date.now();

  if (!sel || sel.length > 300) return bad('bad sel');
  if (!html || html.length > MAX_HTML) return bad('html length 1-' + MAX_HTML);
  // sel 只允许合法 selector 字符（防注入 KV key 语义）
  if (!/^[.#>\w\s:\(\)\[\]=\*'"\-]+$/.test(sel)) return bad('bad sel chars');

  const count = (await kv.list({ prefix: `c:${code}:`, limit: 1000 })).keys.length;
  const key = `c:${code}:${hashKey(sel)}`;
  const exists = await kv.get(key).catch(() => null);
  if (!exists && count >= MAX_PER_REPORT) return bad('too many edits on this report', 429);

  const item = { sel, html, ts };
  await kv.put(key, JSON.stringify(item));
  return out({ ok: true, item });
}

async function delEdit(kv, url, code) {
  const sel = (url.searchParams.get('sel') || '').trim();
  if (!sel) return bad('bad sel');
  await kv.delete(`c:${code}:${hashKey(sel)}`);
  return out({ ok: true });
}
