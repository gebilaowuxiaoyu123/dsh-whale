#!/usr/bin/env node
/**
 * 桌面挂件 UI 冒烟测试（通过 Chrome DevTools Protocol）
 *
 * 为什么需要它
 * ------------
 * 路由层测试只能证明「接口可用」，不能证明「前端真的把挂件渲染出来了」。
 * 实测中曾出现：插件 23 条路由全部 200，但页面里一个挂件节点都没有 ——
 * 原因是插件前端有一段页面自检（只在能查到 composer 输入区的 DSH 主聊天界面才挂载），
 * 桌面版的空白页面通不过自检。这类问题只有查真实 DOM 才能发现。
 *
 * 用法
 * ----
 * 1) 先以调试模式启动挂件（多一个 --remote-debugging-port）：
 *      cd dsh-whale-desktop
 *      .\node_modules\electron\dist\electron.exe --remote-debugging-port=9222 .
 *    Linux：
 *      cd dsh-whale-desktop-linux
 *      ./node_modules/.bin/electron --remote-debugging-port=9222 .
 * 2) 另开一个终端运行本脚本：
 *      node tools/desktop-ui-smoke-test.mjs
 *    端口可用环境变量覆盖：CDP_PORT=9223 node tools/desktop-ui-smoke-test.mjs
 *
 * 退出码：0 = 全部通过；1 = 有断言失败（可接入 CI 的 Xvfb + Electron 冒烟流程）。
 */
const CDP_PORT = process.env.CDP_PORT || 9222;
const WAIT_MS = Number(process.env.WAIT_MS || 8000);

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    console.log('  \u2717 ' + label + (extra ? '  [' + extra + ']' : ''));
  }
}

async function findPageTarget() {
  const deadline = Date.now() + WAIT_MS;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    '未找到可调试的页面目标。请确认挂件是以 --remote-debugging-port=' +
      CDP_PORT +
      ' 启动的。' +
      (lastErr ? '（' + lastErr.message + '）' : '')
  );
}

const page = await findPageTarget();
console.log('调试目标: ' + page.url + '\n');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('WebSocket 连接失败'));
});

let msgId = 0;
const pending = new Map();
const consoleEvents = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails || {};
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || '';
    consoleEvents.push('[异常] ' + String(desc).split('\n').slice(0, 3).join(' | '));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const args = (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
    consoleEvents.push('[console.error] ' + args.slice(0, 200));
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

await send('Runtime.enable');

const expr = `JSON.stringify({
  readyState: document.readyState,
  hasRoot: !!document.querySelector('.dshwv-root'),
  rootClass: (document.querySelector('.dshwv-root') || {}).className || null,
  hasImg: !!document.querySelector('.dshwv-img'),
  imgComplete: (document.querySelector('.dshwv-img') || {}).complete || false,
  imgNaturalW: (document.querySelector('.dshwv-img') || {}).naturalWidth || 0,
  hasMenuBtn: !!document.querySelector('.dshwv-menu-btn'),
  hasMenu: !!document.querySelector('.dshwv-menu'),
  styleCount: document.querySelectorAll('style').length,
  rootRect: (function () {
    var e = document.querySelector('.dshwv-root');
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  })()
})`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
let info = null;
try {
  info = JSON.parse(r.result.value);
} catch (_e) {
  console.log('无法解析检查结果: ' + JSON.stringify(r).slice(0, 300));
}

if (info) {
  console.log('渲染进程实况:');
  console.log('  readyState      = ' + info.readyState);
  console.log('  .dshwv-root     = ' + info.hasRoot + (info.rootClass ? '  class="' + info.rootClass + '"' : ''));
  console.log('  .dshwv-img      = ' + info.hasImg + '  complete=' + info.imgComplete + '  naturalWidth=' + info.imgNaturalW);
  console.log('  .dshwv-menu-btn = ' + info.hasMenuBtn);
  console.log('  .dshwv-menu     = ' + info.hasMenu);
  console.log('  <style> 数量     = ' + info.styleCount);
  console.log('  root 位置尺寸    = ' + JSON.stringify(info.rootRect));
  console.log('');

  console.log('断言:');
  ok(info.readyState === 'complete' || info.readyState === 'interactive', '页面已加载（readyState=' + info.readyState + '）');
  ok(info.hasRoot === true, '挂件根节点 .dshwv-root 已渲染');
  ok(info.hasImg === true, '小鲸鱼图片元素 .dshwv-img 已渲染');
  ok(info.imgComplete === true && info.imgNaturalW > 0, '鲸鱼图片已加载（naturalWidth=' + info.imgNaturalW + '）');
  ok(info.hasMenuBtn === true, '汉堡菜单按钮已渲染');
  ok(info.styleCount >= 2, '样式已注入（<style> 数量=' + info.styleCount + '）');
  ok(!!info.rootRect && info.rootRect.w > 0 && info.rootRect.h > 0, '挂件有实际尺寸 ' + JSON.stringify(info.rootRect));
}

if (consoleEvents.length) {
  console.log('\n渲染进程错误输出:');
  for (const e of consoleEvents.slice(0, 10)) console.log('  ' + e);
  if (consoleEvents.some((e) => e.indexOf('[异常]') === 0)) {
    fail++;
    console.log('  \u2717 渲染进程存在未捕获异常');
  }
}

ws.close();
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
