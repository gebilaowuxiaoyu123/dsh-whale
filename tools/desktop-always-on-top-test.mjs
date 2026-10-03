#!/usr/bin/env node
/**
 * DSH 桌面挂件「置顶显示」开关自检（Windows / Linux 通用）
 *
 * 为什么需要它
 * ------------
 * 2026-10-04 用户反馈：两个桌宠不管打开什么软件都浮在最前面（看视频时很烦）。
 * 期望层级是「应用窗口 > 桌宠 > 桌面图标」，并且给一个「置顶显示」开关。
 * 桌面版的做法是：默认 `setAlwaysOnTop(false)`（普通窗口 —— 应用窗口盖住它，
 * 它仍在桌面图标之上），托盘里可以打开「置顶显示」回到旧行为。
 *
 * 这个脚本只走 HTTP（不碰 GUI）：
 *   GET  /dsh-whale/always-on-top        读当前值
 *   PUT  /dsh-whale/always-on-top {value} 写并立即生效
 * 并核对落盘文件 ~/.dsh/.dshw-window.json。
 *
 * 用法：
 *   1) 先让挂件跑起来（普通启动即可，不需要调试端口）：dsh-whale-desktop\start-widget.ps1
 *   2) node tools/desktop-always-on-top-test.mjs
 *      PORT=3091 可换端口；DSH_HOME 可换数据目录。
 *
 * 退出码：0 = 通过（或挂件没在跑，跳过）；1 = 有断言失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3090);
const BASE = `http://127.0.0.1:${PORT}`;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const WINDOW_FILE = path.join(DSH_HOME, '.dshw-window.json');

let pass = 0;
const fails = [];
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  \u2717 ' + label + (extra ? `  [${extra}]` : '')); }
};

async function reachable() {
  try {
    const r = await fetch(`${BASE}/dsh-whale/always-on-top`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}
const get = async () => (await fetch(`${BASE}/dsh-whale/always-on-top`)).json();
const put = async (value) =>
  (await fetch(`${BASE}/dsh-whale/always-on-top`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
  })).json();
const fileValue = () => {
  try { return JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8')).alwaysOnTop; } catch { return undefined; }
};

console.log('===== DSH 桌面挂件 · 置顶显示 自检 =====\n');
if (!(await reachable())) {
  console.log(`[跳过] 127.0.0.1:${PORT} 上没有挂件在跑。`);
  console.log('       先启动：dsh-whale-desktop\\start-widget.ps1（Windows）/ ./start-linux.sh（Linux）');
  process.exit(0);
}

const before = await get();
ok('GET 返回 ok:true', before && before.ok === true, JSON.stringify(before));
ok('GET 的 value 是布尔值', typeof before?.value === 'boolean', String(before?.value));
const original = before.value === true;

try {
  const on = await put(true);
  ok('PUT true 生效', on?.value === true, JSON.stringify(on));
  ok('读回来是 true', (await get()).value === true);
  ok('落盘文件也是 true（.dshw-window.json）', fileValue() === true, String(fileValue()));

  const off = await put(false);
  ok('PUT false 生效', off?.value === false, JSON.stringify(off));
  ok('读回来是 false', (await get()).value === false);
  ok('落盘文件也是 false', fileValue() === false, String(fileValue()));
} finally {
  // 无论成败都恢复原值，别把用户的设置改掉
  await put(original).catch(() => {});
  ok('已恢复原值', (await get()).value === original, String(original));
}

if (fails.length) {
  console.log(`\n\u2717 ${fails.length} 项没通过（共 ${pass + fails.length} 项）`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\n\u2713 全部 ${pass} 项断言通过 —— 「置顶显示」读写与落盘都正常`);
