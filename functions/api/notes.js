/**
 * stbuddy 批注 API —— Cloudflare Pages Function
 * 路由：/api/notes
 *
 *   GET    /api/notes?code=002109            列出该报告的批注（含右侧笔记）
 *   POST   /api/notes                        {code,kind,rowKey,rowText,text} 新增（code 在请求体里）
 *   DELETE /api/notes?code=002109&id=xxx     删除
 *
 * 三类内容同库：
 *   · 单元格批注  kind='cell'  rowKey=<8位hex>[-序号]      ← v3（v2 的整行 kind='row' 仍可读）
 *   · 句子批注    kind='sent'  rowKey=<8位hex>-<句序>
 *   · 右侧笔记    kind='page'  rowKey='page'（**一篇一条，固定 KV key n:<code>:page**，可覆盖更新）
 *
 * ★ 易错点（2026-10-07 实测踩过）：POST 的 code 在**请求体**，GET/DELETE 的在 **query**。
 *   若在方法分发前统一从 query 取 code，POST 必然被判 400。故 code 的解析放在各分支内。
 * ★ 笔记用固定 key + baseTs 乐观并发：避免"两人同编一篇笔记，后保存的把先保存的静默覆盖"。
 *   冲突时返回 409，前端提示「已被他人更新，请刷新后再改」。
 *
 * 鉴权：请求头 x-stb-token 必须等于站点密码的 SHA-256（= 页面密码门里的同一个哈希，
 *       它本来就公开在每篇研报的源码里）→ 门槛与现有密码门完全一致：
 *       挡普通访客，不挡懂技术的人。需要更强鉴权时，在 Pages 项目里设环境变量
 *       STB_NOTES_TOKEN 覆盖即可，前端无需改动。
 *
 * KV 绑定：变量名 STBUDDY_NOTES（Pages → Settings → Functions → KV namespace bindings）
 * 未绑定 KV 时本函数返回 503，前端会静默降级为「批注服务未启用」。
 */

const DEFAULT_TOKEN = '9aa2978b32c1ffa6d0bc3b359720fb32bb45bfb677d704c7eacf714b9e82aab5';
const MAX_TEXT = 1000;         // 单条批注字数
const MAX_PAGE_TEXT = 5000;    // 右侧笔记字数（Andy 指定 200–5000）
const MAX_USER = 20;           // 署名长度（v3 起前端不再收集，仅为兼容旧数据保留）
const MAX_PER_REPORT = 300;
const PAGE_KEY = 'page';

const H = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const out = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: H });
const bad = (error, status = 400) => out({ ok: false, error }, status);
const isCode = (c) => /^\d{6}$/.test(c);

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

  // ---- 鉴权（与密码门同一强度）
  const want = env.STB_NOTES_TOKEN || DEFAULT_TOKEN;
  if ((request.headers.get('x-stb-token') || '') !== want) return bad('unauthorized', 401);

  // ---- 存储可用性
  const kv = env.STBUDDY_NOTES;
  if (!kv) return bad('notes storage not configured', 503);

  const url = new URL(request.url);

  try {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return bad('bad json'); }
      const code = String(body.code || url.searchParams.get('code') || '').trim();
      if (!isCode(code)) return bad('bad code');
      return await addNote(body, kv, code);
    }

    const code = (url.searchParams.get('code') || '').trim();
    if (!isCode(code)) return bad('bad code');

    if (request.method === 'GET') return await listNotes(kv, code);
    if (request.method === 'DELETE') return await delNote(kv, url, code);
    return bad('method not allowed', 405);
  } catch (e) {
    return bad('server error: ' + (e && e.message ? e.message : 'unknown'), 500);
  }
}

async function listNotes(kv, code) {
  // 一条批注一个 key（n:<code>:<id>），避免读改写竞态；用 list + 并发 get 汇总。
  const { keys } = await kv.list({ prefix: `n:${code}:`, limit: 1000 });
  const items = (await Promise.all(
    keys.map((k) => kv.get(k.name, 'json').catch(() => null))
  )).filter(Boolean);
  items.sort((a, b) => a.ts - b.ts);
  return out({ ok: true, items });
}

async function addNote(body, kv, code) {
  const rowKey = String(body.rowKey || '').trim();
  const text = String(body.text || '').trim();
  const rowText = String(body.rowText || '').trim().slice(0, 200);
  let user = String(body.user || '').trim().slice(0, MAX_USER);
  const kind = body.kind === 'sent' ? 'sent'
             : body.kind === 'page' ? 'page'
             : body.kind === 'cell' ? 'cell' : 'row';

  // ---- 右侧笔记：固定 key，一篇一条，可覆盖；baseTs 做乐观并发
  if (kind === 'page') {
    if (rowKey !== PAGE_KEY) return bad('bad anchor');
    if (!text || text.length > MAX_PAGE_TEXT) return bad('text length 1-' + MAX_PAGE_TEXT);
    const key = `n:${code}:${PAGE_KEY}`;
    const prev = await kv.get(key, 'json').catch(() => null);
    const baseTs = Number(body.baseTs) || 0;
    if (prev && prev.ts > baseTs) return bad('conflict: note changed', 409);
    const ts = Date.now();
    const item = { id: PAGE_KEY, rowKey: PAGE_KEY, kind: 'page', rowText: '', text, ts };
    await kv.put(key, JSON.stringify(item));
    return out({ ok: true, item });
  }

  // ---- 批注：锚点两种形态（单元格 = <8位hex>[-序号]；句子 = <8位hex>-<句序>）
  if (!/^[0-9a-f]{4,32}(?:-\d{1,3})?$/.test(rowKey)) return bad('bad anchor');
  if (!text || text.length > MAX_TEXT) return bad('text length 1-' + MAX_TEXT);
  if (user) user = user.replace(/[\u0000-\u001f\u007f]/g, '');

  const count = (await kv.list({ prefix: `n:${code}:`, limit: 1000 })).keys.length;
  if (count >= MAX_PER_REPORT) return bad('too many notes on this report', 429);

  const ts = Date.now();
  const id = ts.toString(36) + Math.random().toString(36).slice(2, 8);
  const item = { id, rowKey, kind, rowText, text, user, ts };
  await kv.put(`n:${code}:${id}`, JSON.stringify(item));
  return out({ ok: true, item });
}

async function delNote(kv, url, code) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[0-9a-z]{4,24}$/.test(id)) return bad('bad id');
  await kv.delete(`n:${code}:${id}`);
  return out({ ok: true });
}
