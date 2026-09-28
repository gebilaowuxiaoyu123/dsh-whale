// 端到端集成验证：桌面版 host-shim + 插件本体 + 本地 HTTP 服务
// 检验：23 条路由是否可用、关键路由响应是否正确、安全校验是否生效、
//       以及桌面版特有路由在插件接管后是否仍然可用。
// DSH_HOME 指向临时目录，避免污染真实配置。
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dshw-integ-'));
process.env.DSH_HOME = TMP_HOME;

const { startPlugin } = require(path.join(REPO, 'dsh-whale-desktop', 'host-shim.js'));

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

const plugin = await startPlugin({
  appDir: path.join(REPO, 'dsh-whale-desktop'),
  dshHome: TMP_HOME,
  credFile: path.join(TMP_HOME, '.credentials.yaml'),
  logger: { warn() {}, log() {}, error() {} },
});

console.log('插件加载: ' + (plugin.ok ? '成功' : '失败 ' + plugin.error));
console.log('入口: ' + plugin.entry + '\n');
if (!plugin.ok) process.exit(1);

const PORT = 3099;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const route = plugin.host.routes.get(u.pathname);
  if (route) {
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch(() => {
        try {
          res.writeHead(500);
          res.end();
        } catch (_e) {}
      });
    return;
  }
  // 桌面版特有路由（模拟 main.js 内置部分）
  if (u.pathname === '/dsh-whale/apikey') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"configured":false}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

function raw(pathname, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: o.method || 'GET', headers: o.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (o.body) req.write(o.body);
    req.end();
  });
}

console.log('[1] 路由注册数量');
ok(plugin.host.routes.size === 23, '插件注册 23 条路由', '实际 ' + plugin.host.routes.size);

console.log('\n[2] 静态资源类路由');
{
  const js = await raw('/dsh-whale/widget.js');
  ok(js.status === 200 && js.body.indexOf('dshwv-root') >= 0, 'GET /dsh-whale/widget.js 返回前端（含 dshwv-root）', 'status=' + js.status + ' len=' + js.body.length);

  const img = await raw('/dsh-whale/image.png');
  ok(img.status === 200 && String(img.headers['content-type']).indexOf('image/png') >= 0, 'GET /dsh-whale/image.png 返回 PNG', 'status=' + img.status);

  const gif = await raw('/dsh-whale/rua.gif');
  ok(gif.status === 200, 'GET /dsh-whale/rua.gif 返回动图', 'status=' + gif.status);

  const mp3 = await raw('/dsh-whale/sound/press.mp3?set=duck');
  ok(mp3.status === 200 && String(mp3.headers['content-type']).indexOf('audio') >= 0, 'GET /dsh-whale/sound/press.mp3 返回音频', 'status=' + mp3.status);
}

console.log('\n[3] 数据类路由（JSON）');
for (const p of [
  '/dsh-whale/size.json',
  '/dsh-whale/balance.json',
  '/dsh-whale/last-turn.json',
  '/dsh-whale/wait.json',
  '/dsh-whale/usage-settings.json',
  '/dsh-whale/usage-records.json',
  '/dsh-whale/api-models.json',
  '/dsh-whale/roles.json',
  '/dsh-whale/audio.json',
  '/dsh-whale/bubble.json',
  '/dsh-whale/bubble-imgs.json',
]) {
  const r = await raw(p);
  let parsed = null;
  try {
    parsed = JSON.parse(r.body);
  } catch (_e) {}
  ok(r.status === 200 && parsed !== null, 'GET ' + p + ' 返回合法 JSON', 'status=' + r.status);
}

console.log('\n[4] 安全校验（插件自带的回环/同源栅栏）');
{
  const spoof = await raw('/dsh-whale/size.json', { headers: { Host: 'evil.example.com' } });
  ok(spoof.status === 403, '伪造非回环 Host 被拒（403）', 'status=' + spoof.status);

  const cross = await raw('/dsh-whale/usage-settings.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: '{}',
  });
  ok(cross.status === 403, '跨站写请求被拒（403）', 'status=' + cross.status);

  const loopback = await raw('/dsh-whale/size.json', { headers: { Host: '127.0.0.1:' + PORT } });
  ok(loopback.status === 200, '回环 Host 正常放行（200）', 'status=' + loopback.status);
}

console.log('\n[5] 桌面版特有路由在插件接管后仍可用');
{
  const r = await raw('/dsh-whale/apikey');
  ok(r.status === 200 && r.body.indexOf('"ok":true') >= 0, 'GET /dsh-whale/apikey 仍走内置实现', 'status=' + r.status);

  const miss = await raw('/dsh-whale/definitely-not-a-route');
  ok(miss.status === 404, '未知路径回落到 404', 'status=' + miss.status);
}

console.log('\n[6] 凭据桥接（写 .credentials.yaml 后插件应能读到）');
{
  const credFile = path.join(TMP_HOME, '.credentials.yaml');
  fs.writeFileSync(credFile, 'version: 1\n\nrefs:\n  DEEPSEEK_API_KEY: sk-integration-test-key\n', 'utf8');
  const cred = await plugin.host.ctx.credentials.resolve('DEEPSEEK_API_KEY');
  ok(cred && cred.value === 'sk-integration-test-key', 'shim credentials.resolve 返回 { value }', JSON.stringify(cred));

  await plugin.host.ctx.credentials.set('DASHSCOPE_API_KEY', 'sk-dash-test');
  const txt = fs.readFileSync(credFile, 'utf8');
  ok(txt.indexOf('DASHSCOPE_API_KEY: sk-dash-test') >= 0 && txt.indexOf('DEEPSEEK_API_KEY') >= 0, 'credentials.set 写入后保留原键');
}

srv.close();
fs.rmSync(TMP_HOME, { recursive: true, force: true });

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
