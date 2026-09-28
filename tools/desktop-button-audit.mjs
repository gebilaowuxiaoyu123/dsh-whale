// 挂件按钮全覆盖检查（修正版）
// 判据：
//   ① 真可见：el.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true })
//      —— 会正确考虑**祖先**的 opacity/visibility/display（getComputedStyle(el).opacity 不会）
//   ② 可命中：中心点 elementFromPoint 返回它自己或其后代
//   ③ 判定可交互：按 preload.js 的 pointer-events 语义
// 例外（不算问题）：命中者是一个「遮罩层」（*mask），说明当前有模态对话框正盖着它 ——
//   模态拦截底层点击是正确行为，不是 bug。
const CDP_PORT = 9222;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
function send(method, params) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return 'ERR:' + r.exceptionDetails.text;
  return r && r.result ? r.result.value : undefined;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable');

await evalJs(`window.__scan2 = function () {
  function reallyVisible(e) {
    try {
      if (typeof e.checkVisibility === 'function') {
        if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, checkDivOTB: true })) return false;
      } else {
        var s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= 0.01) return false;
      }
    } catch (err) { return false; }
    var r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    return true;
  }
  function judge(x, y) {
    var el = null; try { el = document.elementFromPoint(x, y); } catch (err) {}
    if (!el) return false;
    var d = 0;
    for (var n = el; n && n !== document.body && n !== document.documentElement && d < 24; n = n.parentElement, d++) {
      var pe = ''; try { pe = getComputedStyle(n).pointerEvents; } catch (err) { pe = ''; }
      if (pe === 'auto') return true;
    }
    return false;
  }
  var out = [];
  var els = document.querySelectorAll('button, input, select, textarea, [role="button"]');
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    if (!reallyVisible(e)) continue;
    var r = e.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    var hit = null; try { hit = document.elementFromPoint(cx, cy); } catch (err) {}
    var hitCls = hit ? String(hit.className || hit.tagName) : '';
    var selfHit = !!(hit && (hit === e || e.contains(hit)));
    var byMask = /mask/i.test(hitCls);
    out.push({
      tag: e.tagName.toLowerCase(),
      type: e.type || '',
      text: (e.textContent || '').trim().slice(0, 20) || (e.title || '').slice(0, 20),
      cls: String(e.className || '').slice(0, 32),
      xy: cx + ',' + cy,
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      selfHit: selfHit,
      byMask: byMask,
      hitCls: hitCls.slice(0, 30),
      judgeOk: judge(cx, cy)
    });
  }
  return JSON.stringify(out);
}; 'ready'`);

const scan = async () => {
  const raw = await evalJs('window.__scan2()');
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return [];
  }
};
async function clearAll() {
  await evalJs(`(function(){
    var ms = document.querySelectorAll('.dshwv-bubmask,.dshwv-snapmask');
    for (var i = 0; i < ms.length; i++) { if (ms[i].parentElement) ms[i].parentElement.removeChild(ms[i]); }
    var mn = document.querySelector('.dshwv-menu'); if (mn) mn.classList.remove('dshwv-menu-open');
    return 1;
  })()`);
  await wait(260);
}
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await wait(90);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await wait(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await wait(430);
}
async function openMenu() {
  const raw = await evalJs(`(function(){var e=document.querySelector('.dshwv-menu-btn');if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  const p = raw && raw !== 'null' ? JSON.parse(raw) : null;
  if (!p) return false;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
  await wait(320);
  await realClick(p.x, p.y);
  return evalJs(`!!document.querySelector('.dshwv-menu.dshwv-menu-open')`);
}

let total = 0;
const problems = [];
function report(phase, items) {
  total += items.length;
  const bad = items.filter((i) => !i.selfHit && !i.byMask);
  const masked = items.filter((i) => !i.selfHit && i.byMask).length;
  console.log('\n=== ' + phase + ' ===');
  console.log('  可见交互元素 ' + items.length + ' 个' + (masked ? '（其中 ' + masked + ' 个被模态遮罩正常拦截）' : ''));
  if (!items.length) {
    console.log('  （无）');
    return;
  }
  for (const i of items) {
    if (i.selfHit && i.judgeOk) continue; // 正常的不逐条打印
    const flag = i.byMask ? '\u25cb' : '\u2717';
    const name = i.tag + (i.type ? '[' + i.type + ']' : '') + ' "' + i.text + '"';
    console.log('  ' + flag + ' ' + name.padEnd(44) + ' @' + i.xy.padEnd(9) + ' 命中=' + i.hitCls);
    if (!i.byMask) problems.push(phase + ' / ' + name + ' @' + i.xy + ' 命中=' + i.hitCls + ' judge=' + i.judgeOk);
  }
  const okCount = items.filter((i) => i.selfHit && i.judgeOk).length;
  console.log('  → 正常可点 ' + okCount + ' / ' + items.length);
}

console.log('=== 挂件按钮全覆盖检查（修正版）===');
console.log('（只列出异常项；"○"=被模态遮罩正常拦截，不算问题）');

await clearAll();
report('阶段 1：初始状态（菜单关闭）', await scan());

await openMenu();
await wait(300);
report('阶段 2：主菜单展开', await scan());

// 依次打开主菜单里的各面板入口
const entries = JSON.parse(
  (await evalJs(`(function(){
    function rv(e){try{return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}catch(err){return true;}}
    var out=[],els=document.querySelectorAll('button[class*="roleimport"],button[class*="usage-more"]');
    for(var i=0;i<els.length;i++){var e=els[i];if(!rv(e))continue;var r=e.getBoundingClientRect();if(r.width<=0)continue;
      out.push(((e.textContent||'').trim().slice(0,16))||((e.title||'').slice(0,16)));}
    return JSON.stringify(out);
  })()`)) || '[]'
);
console.log('\n主菜单面板入口: ' + JSON.stringify(entries));

let n = 0;
for (const label of entries) {
  n++;
  if (n > 8) break;
  if (!(await evalJs(`!!document.querySelector('.dshwv-menu.dshwv-menu-open')`))) await openMenu();
  await wait(200);
  const clicked = await evalJs(`(function(){
    function rv(e){try{return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}catch(err){return true;}}
    var els=document.querySelectorAll('button[class*="roleimport"],button[class*="usage-more"]');
    for(var i=0;i<els.length;i++){var e=els[i];if(!rv(e))continue;
      var t=((e.textContent||'').trim().slice(0,16))||((e.title||'').slice(0,16));
      if(t!==${JSON.stringify(label)})continue;e.click();return 'ok';}
    return 'nf';
  })()`);
  await wait(520);
  report('阶段 ' + (n + 2) + '：面板「' + label + '」（点击=' + clicked + '）', await scan());
  // 关闭：优先点可见的取消/关闭/确认
  for (const t of ['取消', '关闭', '确认']) {
    const done = await evalJs(`(function(){
      function rv(e){try{return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}catch(err){return true;}}
      var els=document.querySelectorAll('button,[role="button"]');
      for(var i=0;i<els.length;i++){var e=els[i];
        if((e.textContent||'').trim()!==${JSON.stringify(t)})continue;if(!rv(e))continue;
        var r=e.getBoundingClientRect();var cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);
        var hit=null;try{hit=document.elementFromPoint(cx,cy);}catch(err){}
        if(hit&&(hit===e||e.contains(hit))){return JSON.stringify({x:cx,y:cy});}}
      return null;
    })()`);
    if (done && done !== 'null') {
      const p = JSON.parse(done);
      await realClick(p.x, p.y);
      break;
    }
  }
  await wait(260);
  await clearAll();
}

await clearAll();

console.log('\n========================================');
console.log('共检查 ' + total + ' 个可见交互元素');
if (problems.length) {
  console.log('真正的问题（' + problems.length + ' 个）:');
  for (const p of problems) console.log('  ✗ ' + p);
} else {
  console.log('结论：所有可见按钮均可命中且判定可交互 ✓（被模态遮罩拦截的底层元素属正常）');
}
ws.close();
process.exit(problems.length === 0 ? 0 : 1);
