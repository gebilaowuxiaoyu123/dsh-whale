// 实测「置顶显示」开关的运行时行为：
//   通过页面预加载暴露的 petHost.setAlwaysOnTop() 拨开关 → 用 xprop 量窗口类型
//   开 = _NET_WM_WINDOW_TYPE_DOCK（浮在所有窗口之上）
//   关 = _NET_WM_WINDOW_TYPE_NORMAL（普通应用窗口能盖住它）
// 用法：node tools/aot-toggle-test.mjs [CDP端口] [窗口标题]
import { execFileSync } from 'node:child_process';
// Node 22 自带全局 WebSocket，不需要 ws 包（仓库根目录没装它）
const WS = globalThis.WebSocket;
if (!WS) {
  console.error('  当前 Node 没有全局 WebSocket（需要 Node 22+）');
  process.exit(2);
}

const PORT = Number(process.argv[2] || 9333);
const TITLE = process.argv[3] || 'Cortico 桌宠';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch { return ''; } };

function winIdOf(title) {
  const tree = sh('xwininfo', ['-root', '-tree']);
  const m = new RegExp(`(0x[0-9a-f]+) "${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(tree);
  return m ? m[1] : '';
}
const winType = (id) => (sh('xprop', ['-id', id, '_NET_WM_WINDOW_TYPE']) || '').trim();
const winState = (id) => (sh('xprop', ['-id', id, '_NET_WM_STATE']) || '').trim();

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /pet/.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!page) throw new Error(`端口 ${PORT} 上没找到可调试页面`);
  const ws = new WS(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { ws, evaluate };
}

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

const { ws, evaluate } = await connect();
console.log('  ── 置顶显示开关（运行时实测）──');

const has = await evaluate("typeof window.petHost?.setAlwaysOnTop");
check('页面暴露了 setAlwaysOnTop', has === 'function', String(has));

const winId = winIdOf(TITLE);
console.log(`  窗口 ${TITLE} = ${winId || '（未找到）'}`);

// ① 关掉置顶
await evaluate('window.petHost.setAlwaysOnTop(false)');
await sleep(1200);
const t1 = winType(winId), s1 = winState(winId);
check('关掉置顶 → 窗口类型变成 NORMAL', /_NET_WM_WINDOW_TYPE_NORMAL/.test(t1), t1 || '(空)');
check('关掉置顶 → 不再带 ABOVE（普通窗口能盖住）', !/_NET_WM_STATE_ABOVE/.test(s1), s1.slice(0, 80) || '(空)');

// ② 再打开
await evaluate('window.petHost.setAlwaysOnTop(true)');
await sleep(1200);
const t2 = winType(winId), s2 = winState(winId);
check('打开置顶 → 窗口类型回到 DOCK', /_NET_WM_WINDOW_TYPE_DOCK/.test(t2), t2 || '(空)');
check('打开置顶 → 带 ABOVE', /_NET_WM_STATE_ABOVE/.test(s2), s2.slice(0, 80) || '(空)');

// ③ 位置回归：开关一次后窗口底边必须仍贴在屏幕底。
//    不置顶时窗口是 NORMAL，mutter 会把它夹回 workArea（底边只到 Dock 上沿）；
//    切回置顶后如果不重新贴底，宠物就会一直停在高处（实测踩过）。
const xrandr = sh('xrandr', ['--current']);
const sizes = [...xrandr.matchAll(/(\d+)x(\d+)\+/g)].map((m) => Number(m[2]));
const screenBottom = sizes.length ? Math.max(...sizes) : 0;
const info = sh('xwininfo', ['-id', winId]);
const mY = /Absolute upper-left Y:\s+(\d+)/.exec(info);
const mH = /Height:\s+(\d+)/.exec(info);
if (mY && mH && screenBottom) {
  const bottom = Number(mY[1]) + Number(mH[1]);
  check('开关一次后窗口仍贴在屏幕底', Math.abs(bottom - screenBottom) <= 4,
    `窗口底 ${bottom} / 屏幕高 ${screenBottom}`);
} else {
  check('开关一次后窗口仍贴在屏幕底', false, '量不到窗口几何');
}

console.log(`\n  ===== 结果：通过 ${pass}，失败 ${fail} =====`);
ws.close();
process.exit(fail ? 1 : 0);
