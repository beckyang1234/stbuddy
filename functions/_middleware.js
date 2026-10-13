/**
 * stbuddy · Pages 中间件（只做一件事：管好 /annotate.js 的缓存）
 *
 * 背景：Cloudflare Pages 给静态 JS 的默认 Cache-Control 是 `max-age=14400`（4 小时），
 *   浏览器在这 4 小时内**不会回源校验** → 改了 /annotate.js 线上不生效（实测踩过）。
 *   站点根的 `_headers` 在本项目上**不生效**（本项目 build_command/destination_dir 均为空、
 *   根目录即输出目录，`_headers` 仍被忽略；带 cache-buster 请求也照样返回 14400）。
 *   所以改用中间件直接改响应头。
 *
 * 效果：`/annotate.js` 变成 `max-age=0, must-revalidate` → 浏览器每次都回源校验（命中 304 极廉价）。
 *   **后续再改批注脚本，不必再 bump stbuddy.py 里的 ANNOT_VERSION、也不必重推 203 篇研报。**
 *
 * ★ 安全约定：中间件对**每个**请求都会执行，一旦抛错会波及全站 ——
 *   所以这里对非目标路径**直接透传**，且所有加工都包在 try/catch 内，
 *   出任何问题都退回原始响应，绝不改变站点可用性。
 */
export async function onRequest(context) {
  const res = await context.next();
  try {
    const path = new URL(context.request.url).pathname;
    const headers = new Headers(res.headers);
    headers.set('X-Sbn-Mw', '1');                     // 诊断用标记（确认中间件是否真的被调用）
    if (path === '/annotate.js' && res && res.ok) {
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    return res;                                        // 中间件自身出问题也不影响响应
  }
}
