#!/usr/bin/env node
/**
 * DSH 桌面挂件「更换 API Key」入口自检（Windows / Linux 通用）
 *
 * 为什么需要它
 * ------------
 * 2026-10-09 用户反馈：在 DeepSeek 控制台换了新令牌后，**挂件里换不了**。
 * 根因不在桌面版，而在插件前端：挂件菜单里的「密钥 / 接口」面板，其「厂商模板」下拉
 * 把**内置项排除**掉了（`if (apiTemplates[ti].builtin) continue`），而保存时提交的
 * provider 取自那个下拉 —— 于是内置 DeepSeek 模型必然拿不到 `'deepseek'`，保存失败。
 * 插件是 vendored 上游原样副本（本仓库不改它），所以换 key 的入口补在桌面版自己的托盘里：
 *
 *   托盘 → 「改 API Key…」 → 小窗口（`/key`）→ `PUT /dsh-whale/apikey` → 写 ~/.dsh/.credentials.yaml
 *
 * 随后又加了「一键同步」（用户要求：不按不同步，按一下两边都同步）：`/key` 页上的
 * 「保存并同步到两个桌宠」把同一把 key 同时写进挂件的 ~/.dsh/.credentials.yaml 和
 * Coopanion 当前 provider 的 .env（`POST /dsh-whale/key-sync/push`）；Coopanion 控制台「开始」页
 * 也有同一个按钮（那边填了就推、留空就以自己为准拉过去）。
 *
 * 这个脚本只走 HTTP，**不会改动你的令牌**：
 *   · 拿当前 key 原值写回去（写路径真实跑一遍，但内容不变）
 *   · 只对空值做「应当被拒」的负向断言
 *
 * 用法：
 *   1) 先让挂件跑起来：dsh-whale-desktop\start-widget.ps1（或 ./start-linux.sh）
 *   2) node tools/desktop-apikey-window-test.mjs
 *      PORT=3091 换端口；DSH_HOME 换数据目录。
 *
 * 退出码：0 = 通过（或挂件没在跑，跳过）；1 = 有断言失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 3090);
const BASE = `http://127.0.0.1:${PORT}`;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');

let pass = 0;
const fails = [];
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fails.push(label + (extra ? ` — ${extra}` : '')); console.log('  \u2717 ' + label + (extra ? `  [${extra}]` : '')); }
};

const getJson = async (p) => (await fetch(BASE + p, { signal: AbortSignal.timeout(6000) })).json();
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** 直接读凭据文件里当前的 DEEPSEEK_API_KEY（仅用于「原值写回」，不外传、不打印）。 */
const readKeyOnDisk = () => {
  try {
    const m = fs.readFileSync(CRED_FILE, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*:\s*"?([^"\s#]+)"?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
};
/** 读 Coopanion 当前 provider 的 .env 里的 DEEPSEEK_API_KEY（同样只用于比对，不打印）。 */
const readEnvKey = (file) => {
  if (!file) return null;
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^\s*DEEPSEEK_API_KEY\s*=\s*"?([^"\s#]+)"?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
};

console.log('===== DSH 桌面挂件 · 更换 API Key 入口自检 =====\n');
let alive = false;
try { alive = (await fetch(`${BASE}/dsh-whale/apikey`, { signal: AbortSignal.timeout(2500) })).ok; } catch { alive = false; }
if (!alive) {
  console.log(`[跳过] 127.0.0.1:${PORT} 上没有挂件在跑。`);
  console.log('       先启动：dsh-whale-desktop\\start-widget.ps1（Windows）/ ./start-linux.sh（Linux）');
  process.exit(0);
}

/* ---------- 1. 换 key 页面 ---------- */
console.log('[1] 换 key 小窗口的页面');
{
  const r = await fetch(`${BASE}/key`, { signal: AbortSignal.timeout(6000) });
  const html = await r.text();
  ok('GET /key 返回 200', r.status === 200, String(r.status));
  ok('页面标题正确', html.includes('更换 DeepSeek API Key'));
  ok('页面有「保存并同步到两个桌宠」', html.includes('保存并同步到两个桌宠'));
  ok('页面会调一键同步接口', html.includes('/dsh-whale/key-sync/push') && html.includes('/dsh-whale/key-sync/pull'));
  ok('页面保留「只保存到挂件」这条路', html.includes('/dsh-whale/apikey') && html.includes('只保存到挂件'));
  ok('页面保存后自动关窗', html.includes('/dsh-whale/key-window-done'));
}

/* ---------- 2. 读接口 + 打码 ---------- */
console.log('\n[2] 读当前令牌（打码）');
let masked = '';
{
  const j = await getJson('/dsh-whale/apikey');
  ok('GET 返回 ok:true', j && j.ok === true);
  ok('configured 是布尔值', typeof j?.configured === 'boolean', String(j?.configured));
  masked = String(j?.masked ?? '');
  const onDisk = readKeyOnDisk();
  if (onDisk) {
    ok('masked 不是明文（不包含完整令牌）', !masked.includes(onDisk));
    ok('masked 长这样 sk-xxxx******yyyy', /^sk-.{3,}\*{6}.{2,4}$/.test(masked), masked);
    ok('masked 的首尾与真实令牌一致',
      masked.startsWith(onDisk.slice(0, 7)) && masked.endsWith(onDisk.slice(-4)), masked);
  } else {
    ok('凭据文件里没有 DEEPSEEK_API_KEY（只验证字段存在）', typeof j?.masked === 'string');
  }
}

/* ---------- 3. 写接口：原值写回（内容不变） ---------- */
console.log('\n[3] 保存接口（拿当前 key 原值写回，内容不变）');
{
  const before = readKeyOnDisk();
  const beforeMtime = (() => { try { return fs.statSync(CRED_FILE).mtimeMs; } catch { return 0; } })();
  if (!before) {
    console.log('  (跳过) 本机没读到 DEEPSEEK_API_KEY，无法安全地做写回测试');
  } else {
    const r = await put('/dsh-whale/apikey', { value: before });
    ok('PUT 接受合法令牌（ok:true）', r.body && r.body.ok === true, JSON.stringify(r.body));
    ok('落盘后内容未变（还是同一把）', readKeyOnDisk() === before);
    const afterMtime = (() => { try { return fs.statSync(CRED_FILE).mtimeMs; } catch { return 0; } })();
    ok('确实写了一次文件（不是空转）', afterMtime >= beforeMtime);
  }
}

/* ---------- 4. 负向：空值必须被拒 ---------- */
console.log('\n[4] 负向断言');
{
  const r = await put('/dsh-whale/apikey', { value: '' });
  ok('空令牌被拒（ok:false）', r.body && r.body.ok === false, JSON.stringify(r.body));
  ok('被拒后文件里的令牌没被清掉', !!readKeyOnDisk());
}

/* ---------- 5. 开窗 / 关窗（托盘入口背后的两个路由） ---------- */
console.log('\n[5] 开窗 / 关窗路由');
{
  const a = await post('/dsh-whale/open-key-window', {});
  ok('POST open-key-window 返回 ok:true', a.body && a.body.ok === true, JSON.stringify(a.body));
  await new Promise((r) => setTimeout(r, 1500));
  const b = await post('/dsh-whale/key-window-done', {});
  ok('POST key-window-done 返回 ok:true', b.body && b.body.ok === true, JSON.stringify(b.body));
  const c = await fetch(`${BASE}/dsh-whale/open-key-window`, { method: 'GET', signal: AbortSignal.timeout(5000) });
  ok('GET 这些写路由被拒（405）', c.status === 405, String(c.status));
}

/* ---------- 6. 一键同步两个桌宠的 key ---------- */
console.log('\n[6] 一键同步（两个桌宠用同一把 key）');
{
  const s = await getJson('/dsh-whale/key-sync');
  ok('GET key-sync 返回 ok:true', s && s.ok === true);
  ok('状态里说得出挂件那把（打码）', typeof s?.widget?.masked === 'string', typeof s?.widget?.masked);
  ok('状态里说得出 Coopanion 那把（打码）', typeof s?.copanion?.masked === 'string', typeof s?.copanion?.masked);
  ok('两边是否一致的标志是布尔值', typeof s?.inSync === 'boolean', String(s?.inSync));
  const envFile = typeof s?.copanion?.env === 'string' ? s.copanion.env : null;
  ok('状态里带 Coopanion 的 .env 路径', !!envFile, envFile ?? '(没有)');

  // Coopanion 控制台是自己的源（127.0.0.1:17788），所以这两个接口必须放行跨源预检
  const pre = await fetch(`${BASE}/dsh-whale/key-sync/push`, { method: 'OPTIONS', signal: AbortSignal.timeout(6000) });
  ok('OPTIONS 预检返回 204', pre.status === 204, String(pre.status));
  ok('预检放行任意来源（Coopanion 控制台要调它）', pre.headers.get('access-control-allow-origin') === '*',
    String(pre.headers.get('access-control-allow-origin')));
  const g = await fetch(`${BASE}/dsh-whale/key-sync/push`, { signal: AbortSignal.timeout(6000) });
  ok('GET 写路由被拒（405）', g.status === 405, String(g.status));

  const before = readKeyOnDisk();
  if (!before) {
    console.log('  (跳过) 本机没读到 DEEPSEEK_API_KEY，不做往返');
  } else if (s?.inSync !== true) {
    console.log(`  (跳过) 两边现在不是同一把（挂件 ${s?.widget?.masked} / Coopanion ${s?.copanion?.masked}），`);
    console.log('         往返会把其中一边改掉，所以只报告不动作。');
  } else {
    const r = await post('/dsh-whale/key-sync/push', { value: before });
    ok('push 原值：两边都是同一把', r.body?.ok === true && r.body?.inSync === true, JSON.stringify(r.body));
    ok('push 之后挂件令牌没变', readKeyOnDisk() === before);
    ok('push 之后 Coopanion 的 .env 是同一把', readEnvKey(envFile) === before, String(readEnvKey(envFile)?.slice(0, 9)));
    const p = await post('/dsh-whale/key-sync/pull', {});
    ok('pull 返回 ok:true', p.body?.ok === true, JSON.stringify(p.body));
    ok('pull 之后挂件令牌仍是同一把', readKeyOnDisk() === before);
    const s2 = await getJson('/dsh-whale/key-sync');
    ok('状态里记下了最后一次同步', typeof s2?.lastSyncAt === 'number' || typeof s2?.lastSyncAt === 'string', String(s2?.lastSyncAt));
  }
}

if (fails.length) {
  console.log(`\n\u2717 ${fails.length} 项没通过（共 ${pass + fails.length} 项）：`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\n\u2713 全部 ${pass} 项断言通过 —— 换 key 入口（页面 / 保存 / 一键同步 / 开窗关窗）都正常`);
