#!/usr/bin/env node
// 只强制打开插件气泡本体，抓「页面真实渲染」用于与窗口实际像素对拍
const PORT = Number(process.env.CDP_PORT || 9222);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
if (!t) { console.error('无调试目标'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  const p = pend.get(m.id);
  if (p) { pend.delete(m.id); p(m); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { __err: String(m.result.exceptionDetails.exception?.description || '').slice(0, 160) };
  return m.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只打开气泡本体（不碰菜单/面板，避免污染）
console.log('打开气泡:', await ev(`(() => {
  const pop = document.querySelector('.dshwv-pop');
  if (!pop) return 'no-pop';
  pop.classList.add('dshwv-pop-open');
  return 'ok';
})()`));
await sleep(1500);

console.log('避让状态 busy =', await ev('window.dshwEnhance ? window.dshwEnhance.busy() : "n/a"'));

// 可见元素清单（页面视角）
const vis = await ev(`(() => {
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    let cs; try { cs = getComputedStyle(el); } catch(e) { continue; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const tag = el.tagName.toLowerCase();
    const cls = (el.className && el.className.toString ? el.className.toString() : '').slice(0, 46);
    out.push({ tag, cls, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out.slice(0, 40);
})()`);
console.log('可见元素(前40):');
for (const v of vis) console.log('   ', JSON.stringify(v));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.result?.data) {
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/page.png', Buffer.from(shot.result.data, 'base64'));
  console.log('已保存 /tmp/page.png (页面真实渲染)');
} else {
  console.log('抓图失败:', JSON.stringify(shot).slice(0, 200));
}
ws.close();
process.exit(0);
