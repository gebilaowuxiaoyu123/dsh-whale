#!/usr/bin/env node
/**
 * 桌面版增强层 端到端测试（CDP）
 * ============================================================================
 * 前置：以远程调试端口启动桌面版
 *   cd dsh-whale-desktop-linux
 *   DSHW_DEBUG=1 ./node_modules/electron/dist/electron --no-sandbox \
 *     --ozone-platform=x11 --remote-debugging-port=9222 .
 *   node ../tools/desktop-enhance-test.mjs
 *
 * 覆盖：
 *   1) 增强层已加载、各浮层元素存在
 *   2) 浮层几何：必须完整落在视口内，且没有被 CSS 截断
 *      —— 直接对应「泡泡窗口渲染有问题」这个 bug 的回归防线
 *   3) 三态主题 dark / light / glass 切换生效（dataset + 计算样式颜色变化）
 *   4) 多套气泡组 classic / night / sakura / mint 切换生效
 *   5) 账单图表能取到真实数据并渲染出柱条
 *   6) 提示（toast）能出现且不被裁切
 *
 * 截图落盘到 outDir（默认 /tmp/dshw-enhance-artifacts），便于人工复核。
 */

import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = process.env.OUT_DIR || '/tmp/dshw-enhance-artifacts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
    if (ok) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        failures.push(name + (detail ? ` — ${detail}` : ''));
        console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    }
}

// ---------------- 连接 CDP ----------------
async function connect() {
    let list;
    for (let i = 0; i < 30; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            list = await r.json();
            if (Array.isArray(list) && list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl))
                break;
        } catch (_e) { /* 还没起来 */ }
        await sleep(500);
    }
    const target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target)
        throw new Error(`找不到可调试页面（端口 ${PORT}）`);
    console.log(`已连接：${target.url || target.title}`);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch (_e) {
            return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
        else p.res(msg.result);
    });
    const send = (method, params) => {
        const myId = ++id;
        return new Promise((res, rej) => {
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
        });
    };
    return { send, ws };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const { send } = await connect();

    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails)
            throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails.exception || {}));
        return r.result.value;
    };
    const shot = async (name) => {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    };
    const clickAt = async (x, y, button = 'left') => {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
        await sleep(50);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    };

    console.log('\n[1] 增强层加载');
    const loaded = await evaluate('!!window.dshwEnhance');
    check('window.dshwEnhance 存在', loaded === true);

    if (!loaded) {
        console.log('\n增强层未加载，后续测试跳过');
        process.exit(1);
    }

    // 保证处于默认态并让浮层出现
    await evaluate("window.dshwEnhance.set({theme:'dark', bubbleSkin:'classic', chartOn:true})");
    // 插件自己的气泡/面板在显示时，增强层浮层会主动让位（避免两层叠在一起互盖）。
    // 这里先等它退场，否则几何检查拿到的是 display:none / visibility:hidden 的空盒子。
    let waited = 0;
    while (await evaluate('window.dshwEnhance.busy()') && waited < 20000) {
        await sleep(1000);
        waited += 1000;
    }
    if (waited)
        console.log(`  （等待插件 UI 退场 ${waited / 1000}s）`);
    await evaluate('window.dshwEnhance.chart(30)');
    await sleep(900);

    console.log('\n[2] 浮层几何（防裁切回归）');
    const GEO_EXPR = `(() => {
      const out = [];
      for (const s of ['.dshwe-badge', '.dshwe-fx', '.dshwe-chart.on']) {
        for (const el of document.querySelectorAll(s)) {
          const r = el.getBoundingClientRect();
          out.push({
            sel: s, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 48),
            left: +r.left.toFixed(1), top: +r.top.toFixed(1),
            right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
            w: +r.width.toFixed(1), h: +r.height.toFixed(1),
            vw: window.innerWidth, vh: window.innerHeight,
            truncated: el.scrollWidth > el.clientWidth + 1,
          });
        }
      }
      return out;
    })()`;
    const geo = await evaluate(GEO_EXPR);
    check('找到浮层元素', geo.length >= 2, `实际 ${geo.length} 个`);
    for (const g of geo) {
        const inside = g.left >= 0 && g.top >= 0 && g.right <= g.vw + 0.5 && g.bottom <= g.vh + 0.5;
        check(`${g.sel} 完整在视口内  [${g.text}]`, inside,
            `left=${g.left} top=${g.top} right=${g.right}/${g.vw} bottom=${g.bottom}/${g.vh}`);
        check(`${g.sel} 未被 CSS 截断`, !g.truncated,
            `scrollWidth>clientWidth`);
    }
    await shot('01-overlays.png');

    console.log('\n[3] 三态主题');
    const fxColor = async () => evaluate(
        "getComputedStyle(document.querySelector('.dshwe-fx')).backgroundColor");
    const seen = {};
    for (const t of ['dark', 'light', 'glass']) {
        await evaluate(`window.dshwEnhance.theme('${t}')`);
        await sleep(250);
        const got = await evaluate('document.documentElement.dataset.dshwTheme');
        seen[t] = await fxColor();
        check(`主题 ${t} 生效`, got === t, `dataset=${got}`);
        await shot(`02-theme-${t}.png`);
    }
    check('light 与 dark 配色确实不同', seen.light !== seen.dark,
        `${seen.dark} vs ${seen.light}`);
    check('glass 与 dark 配色确实不同', seen.glass !== seen.dark,
        `${seen.dark} vs ${seen.glass}`);

    console.log('\n[4] 多套气泡组');
    for (const s of ['night', 'sakura', 'mint', 'classic']) {
        await evaluate(`window.dshwEnhance.skin('${s}')`);
        await sleep(200);
        const got = await evaluate('document.documentElement.dataset.dshwBubble');
        check(`气泡皮肤 ${s} 生效`, got === s, `dataset=${got}`);
    }
    await evaluate("window.dshwEnhance.skin('sakura')");
    await evaluate("window.dshwEnhance.toast('🐳 气泡皮肤测试：樱花', 15000)");
    await sleep(400);
    await shot('03-skin-sakura-toast.png');
    await evaluate("window.dshwEnhance.skin('classic')");

    console.log('\n[5] 账单图表');
    const usage = await evaluate('window.dshwEnhance.usage()');
    check('取到用量数据 ok=true', !!(usage && usage.ok),
        usage ? JSON.stringify(usage).slice(0, 80) : 'null');
    check('days7 有 7 天', !!(usage && usage.days7 && usage.days7.length === 7),
        usage && usage.days7 ? String(usage.days7.length) : '-');
    await evaluate('window.dshwEnhance.chart(30)');
    await sleep(900);
    const bars = await evaluate("document.querySelectorAll('.dshwe-chart.on .dshwe-bar').length");
    check('柱状图渲染出 7 根柱', bars === 7, `实际 ${bars}`);
    const hot = await evaluate("document.querySelectorAll('.dshwe-chart.on .dshwe-bar.hot').length");
    check('今天那根柱被高亮', hot === 1, `实际 ${hot}`);
    await shot('04-chart.png');

    console.log('\n[6] 与插件自身 UI 避让（防叠成一团）');
    const vis = () => evaluate(`(() => {
      const g = (s) => { const e = document.querySelector(s);
        return e ? { vis: getComputedStyle(e).visibility, txt: (e.textContent||'').trim().slice(0,24) } : null; };
      return { badge: g('.dshwe-badge'), fx: g('.dshwe-fx') };
    })()`);
    await evaluate('window.dshwEnhance.toast(\'\', 10)');
    await sleep(400);
    let v = await vis();
    check('初始状态角标可见', !!v.fx && v.fx.vis === 'visible',
        v.fx ? `fx.visibility=${v.fx.vis}` : 'fx 不存在');

    // 插件菜单按钮平时是 opacity:0 / pointer-events:none，要把指针移到鲸鱼上才显形
    const whalePt = await evaluate(`(() => { const e = document.querySelector('.dshwv-img');
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (whalePt) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: whalePt.x, y: whalePt.y, button: 'none' });
        await sleep(500);
    }
    const mbtn = await evaluate(`(() => { const e = document.querySelector('.dshwv-menu-btn');
      if (!e) return null; const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check('找到插件菜单按钮', !!mbtn);
    const menuState = () => evaluate(`(() => { const e = document.querySelector('.dshwv-menu');
      if (!e) return null; const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return { op: cs.opacity, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    // 打开菜单：先试坐标点击（真实路径），不行就直接派发 click
    // （菜单按钮平时 opacity:0 / pointer-events:none，坐标点击不一定命中）
    const openMenu = async () => {
        if (mbtn) {
            await clickAt(mbtn.x, mbtn.y);
            await sleep(900);
        }
        let st = await menuState();
        if (!st || Number(st.op) <= 0.5) {
            await evaluate(`(() => { const b = document.querySelector('.dshwv-menu-btn');
              if (b) b.click(); })()`);
            await sleep(900);
            st = await menuState();
        }
        return st;
    };
    const opened = await openMenu();
    check('插件菜单已打开', !!opened && Number(opened.op) > 0.5 && opened.w > 60,
        JSON.stringify(opened));
    await sleep(700);
    v = await vis();
    check('菜单打开时角标已隐藏', !!v.fx && v.fx.vis === 'hidden',
        v.fx ? `fx.visibility=${v.fx.vis}` : 'fx 不存在');
    check('菜单打开时峰谷角标也隐藏', !v.badge || v.badge.vis === 'hidden',
        v.badge ? `badge.visibility=${v.badge.vis}` : 'badge 不存在');
    await shot('06-menu-open.png');

    // 关闭菜单
    await evaluate(`(() => { const b = document.querySelector('.dshwv-menu-btn');
      if (b) b.click(); })()`);
    await sleep(1300);
    const closed = await menuState();
    check('插件菜单已关闭', !!closed && Number(closed.op) <= 0.5, JSON.stringify(closed));
    v = await vis();
    check('菜单关闭后角标恢复', !!v.fx && v.fx.vis === 'visible',
        v.fx ? `fx.visibility=${v.fx.vis}` : 'fx 不存在');
    await shot('07-menu-closed.png');

    console.log('\n[7] 提示浮层');
    await evaluate("window.dshwEnhance.toast('🐳 提示渲染测试：谷价时段是跑量的好时候！', 15000)");
    await sleep(500);
    const t = await evaluate(`(() => {
      const el = document.querySelector('.dshwe-toast.on');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, left: r.left, right: r.right, vw: window.innerWidth };
    })()`);
    check('提示已出现', !!t, t ? t.text : 'null');
    if (t)
        check('提示未被右边缘裁切', t.right <= t.vw + 0.5, `right=${t.right}/${t.vw}`);
    await shot('05-toast.png');

    // 收尾：恢复默认主题
    await evaluate("window.dshwEnhance.set({theme:'dark', bubbleSkin:'classic'})");

    console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);

    if (failures.length) {
        console.log('失败项：');
        for (const f of failures) console.log('  - ' + f);
    }
    console.log(`截图目录：${OUT}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error('测试异常：', e.message);
    process.exit(2);
});
