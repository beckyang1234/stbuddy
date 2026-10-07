/**
 * stbuddy 行级批注 API —— Cloudflare Pages Function
 * 路由：/api/notes
 *
 *   GET    /api/notes?code=002109            列出该报告的批注
 *   POST   /api/notes                        {code,rowKey,rowText,text,user} 新增（code 在请求体里）
 *   DELETE /api/notes?code=002109&id=xxx     删除
 *
 * ★ 易错点（2026-10-07 实测踩过）：POST 的 code 在**请求体**，GET/DELETE 的在 **query**。
 *   若在方法分发前统一从 query 取 code，POST 必然被判 400。故 code 的解析放在各分支内。
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
const MAX_TEXT = 1000;   // 单条批注字数
const MAX_USER = 20;     // 署名长度
const MAX_PER_REPORT = 300;

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

  if (!/^[0-9a-f]{4,32}$/.test(rowKey)) return bad('bad rowKey');
  if (!text || text.length > MAX_TEXT) return bad('text length 1-' + MAX_TEXT);
  if (user) user = user.replace(/[\u0000-\u001f\u007f]/g, '');

  const count = (await kv.list({ prefix: `n:${code}:`, limit: 1000 })).keys.length;
  if (count >= MAX_PER_REPORT) return bad('too many notes on this report', 429);

  const ts = Date.now();
  const id = ts.toString(36) + Math.random().toString(36).slice(2, 8);
  const item = { id, rowKey, rowText, text, user, ts };
  await kv.put(`n:${code}:${id}`, JSON.stringify(item));
  return out({ ok: true, item });
}

async function delNote(kv, url, code) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[0-9a-z]{4,24}$/.test(id)) return bad('bad id');
  await kv.delete(`n:${code}:${id}`);
  return out({ ok: true });
}
