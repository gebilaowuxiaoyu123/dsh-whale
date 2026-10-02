#!/usr/bin/env node
/**
 * 通用 CDP 求值工具 —— 对任意 Electron/Chromium 页面执行一段 JS 并打印结果。
 *
 * 为什么需要它：桌宠/挂件都是「全屏透明 + 无边框」的窗口，靠截图只能看到"长什么样"，
 * 看不到 DOM 状态与计算样式；而按钮是否真的可点、元素有没有被裁掉，
 * 恰恰只能从 DOM 侧断言。这个工具就是那只手。
 *
 * 用法：
 *   node tools/cdp-eval.mjs '<js 表达式>'                 # 直接传表达式
 *   node tools/cdp-eval.mjs --file /tmp/q.js              # 从文件读（含引号/感叹号时更省心）
 *   CDP_PORT=9333 node tools/cdp-eval.mjs 'document.title'  # 指定端口（默认 9222）
 *
 * 前提：目标必须以 --remote-debugging-port=<端口> 启动。
 *   DSH 桌面版： DSHW_DEBUG=1 ... --remote-debugging-port=9222
 *   Coopanion ： COOPANION_DEBUG_PORT=9333 ...（脚本会把端口透给桌宠子进程）
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const fs = await import('node:fs');

let expr = process.argv[2];
if (expr === '--file') {
    const p = process.argv[3];
    if (!p) { console.error('用法: cdp-eval.mjs --file <文件>'); process.exit(1); }
    expr = fs.readFileSync(p, 'utf8');
}
if (!expr) {
    console.error('用法: cdp-eval.mjs \'<表达式>\'  或  cdp-eval.mjs --file <文件>');
    process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!target) {
    console.error(`找不到可调试页面（端口 ${PORT}）。目标是否带 --remote-debugging-port 启动？`);
    process.exit(1);
}
if (process.env.CDP_VERBOSE)
    console.error(`[cdp] ${target.title} ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
});
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

const m = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
});
if (m.result && m.result.exceptionDetails) {
    console.error('页面执行异常:',
        JSON.stringify(m.result.exceptionDetails.exception || {}).slice(0, 500));
    process.exit(2);
}
const v = m.result && m.result.result && m.result.result.value;
console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
ws.close();
process.exit(0);
