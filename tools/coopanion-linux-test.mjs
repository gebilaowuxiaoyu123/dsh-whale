#!/usr/bin/env node
/**
 * Coopanion Linux 端到端自检 + 逐按钮测试 + 截图存档
 * ============================================================================
 * 为什么要有这个脚本：
 *   Coopanion 上游主要按 Windows 开发，Linux 版"能装"不等于"能用"。
 *   实测过的两个致命问题（都已在这套自检里做成回归项）：
 *     1) 桌宠窗口跑在**子进程**里，而 --ozone-platform=x11 只作用于主进程 →
 *        子进程退回原生 Wayland：窗口不能自定位/置顶 → 屏幕上看不到桌宠，
 *        而且 xwininfo 里**根本没有这个窗口**。
 *     2) Electron 的 setIgnoreMouseEvents(…, { forward: true }) 在 Linux 是空操作 →
 *        铺满工作区的透明窗把**整个桌面的点击**全吞掉（桌宠看得见、桌面点不动）。
 *        解法是 win.setShape(rects)（见 preload.cjs / electron-main.cjs）。
 *
 * 用法：
 *   cd third-party/Coopanion
 *   COOPANION_DEBUG_PORT=9333 ./node_modules/electron/dist/electron . &
 *   node ../../tools/coopanion-linux-test.mjs
 *
 * 环境变量：
 *   CDP_PORT   桌宠页面的远程调试端口（默认 9333）
 *   OUT_DIR    截图目录（默认 /tmp/coopanion-artifacts）
 *   WIN_ID     指定窗口 id（默认按标题自动找）
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const OUT = process.env.OUT_DIR || '/tmp/coopanion-artifacts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

function sh(cmd, args) {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim();
    } catch (e) {
        return '';
    }
}

/**
 * 当前的「置顶显示」：优先环境变量 PET_ALWAYS_ON_TOP（1/0），否则读 Coopanion 的配置文件。
 * 用法要求 cwd = third-party/Coopanion（见文件头）。
 */
function petAlwaysOnTop() {
    if (process.env.PET_ALWAYS_ON_TOP != null) return process.env.PET_ALWAYS_ON_TOP === '1';
    try {
        const f = path.join(process.cwd(), 'build', 'data', 'home', 'companion', 'config.json');
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        return cfg?.worlds?.['desktop-pet']?.window?.alwaysOnTop === true;
    } catch {
        return false;
    }
}

/** 用 xwd + ffmpeg 取窗口像素，返回 { w, h, ink: Uint8Array, bbox } */
function windowInk(winId) {
    try {
        const xwd = `/tmp/coopanion-shot-${process.pid}.xwd`;
        execFileSync('xwd', ['-id', winId, '-silent', '-out', xwd], { timeout: 30000 });
        const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', xwd, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
            { maxBuffer: 1 << 30, timeout: 60000 });
        const w = 3120, h = 1874;
        const n = Math.min(raw.length, w * h * 3);
        const ink = new Uint8Array(w * h);
        let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
        for (let i = 0; i + 2 < n; i += 3) {
            if (raw[i] > 12 || raw[i + 1] > 12 || raw[i + 2] > 12) {
                const p = i / 3;
                const x = p % w;
                const y = (p - x) / w;
                ink[p] = 1;
                count++;
                if (x < x0) x0 = x;
                if (y < y0) y0 = y;
                if (x > x1) x1 = x;
                if (y > y1) y1 = y;
            }
        }
        return { w, h, ink, count, bbox: x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1] };
    } catch (e) {
        return { error: String(e.message || e).slice(0, 120) };
    }
}

/** xwininfo 的窗口形状（返回 {x,y,w,h} 或 null） */
function shapeExtents(winId) {
    const out = sh('xwininfo', ['-id', winId, '-all']);
    const m = /Window shape extents:\s+(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(out);
    if (!m) return null;
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
}

async function cdpConnect() {
    let list;
    for (let i = 0; i < 20; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
            list = await r.json();
            if (Array.isArray(list) && list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
        } catch (_e) { /* 还没起来 */ }
        await sleep(500);
    }
    const target = (list || [])
        .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        .sort((a, b) => (/\/pet/.test(b.url || '') ? 1 : 0) - (/\/pet/.test(a.url || '') ? 1 : 0))[0];
    if (!target) throw new Error(`找不到桌宠页面（端口 ${CDP_PORT}）：启动时请加 COOPANION_DEBUG_PORT=${CDP_PORT}`);
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
    const evaluate = async (expr) => {
        const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (m.result?.exceptionDetails)
            throw new Error(String(m.result.exceptionDetails.exception?.description || '').slice(0, 200));
        return m.result?.result?.value;
    };
    const shot = async (name) => {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        if (r.result?.data) {
            fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
            return true;
        }
        return false;
    };
    return { evaluate, shot, send, ws };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('===== Coopanion Linux 自检 =====\n');

    console.log('[1] 进程与窗口');
    const procs = sh('pgrep', ['-fa', 'electron .']).split('\n').filter(Boolean);
    check('主进程在跑', procs.length > 0, `${procs.length} 个`);
    const petHost = sh('bash', ['-lc', "pgrep -af -- '--pet-host' | head -1"]);
    check('桌宠子进程在跑', !!petHost, petHost.slice(0, 60));
    check('桌宠子进程带 --ozone-platform=x11（否则跑原生 Wayland，窗口会消失）',
        /--ozone-platform=x11/.test(petHost), petHost.slice(0, 120));

    let winId = process.env.WIN_ID || '';
    if (!winId) {
        const tree = sh('xwininfo', ['-root', '-tree']);
        const m = /(0x[0-9a-f]+) "Cortico 桌宠"/.exec(tree);
        winId = m ? m[1] : '';
    }
    check('X11 窗口存在（"Cortico 桌宠"）', !!winId, winId || '没找到');

    if (!winId) {
        console.log('\n没有窗口，后续检查跳过');
        process.exit(1);
    }

    console.log('\n[2] 窗口属性');
    const onTop = petAlwaysOnTop();
    console.log(`  （当前「置顶显示」= ${onTop ? '开' : '关'}）`);
    const wtype = sh('xprop', ['-id', winId, '_NET_WM_WINDOW_TYPE']);
    check(onTop ? '窗口类型 = DOCK（置顶：避免顶掉桌面 dock）' : '窗口类型 = NORMAL（不置顶：应用窗口能盖住桌宠）',
        onTop ? /_NET_WM_WINDOW_TYPE_DOCK/.test(wtype) : /_NET_WM_WINDOW_TYPE_NORMAL/.test(wtype), wtype);
    const wstate = sh('xprop', ['-id', winId, '_NET_WM_STATE']);
    check(onTop ? '置顶 + 不进任务栏' : '不置顶（无 ABOVE）+ 不进任务栏',
        /SKIP_TASKBAR/.test(wstate) && (onTop ? /_NET_WM_STATE_ABOVE/.test(wstate) : !/_NET_WM_STATE_ABOVE/.test(wstate)),
        wstate.slice(0, 90));

    console.log('\n[3] 点击穿透（形状）');
    const shape = shapeExtents(winId);
    check('窗口有形状（没形状 = 全屏窗口会吞掉整个桌面的点击）', !!shape, JSON.stringify(shape));
    if (shape) {
        const win = 3120 * 1874;
        const ratio = (shape.w * shape.h) / win;
        check('形状远小于整窗（穿透生效）', ratio < 0.25,
            `${shape.w}x${shape.h} = 整窗的 ${(ratio * 100).toFixed(1)}%`);
    }

    console.log('\n[4] 渲染（内容有没有被形状裁掉）');
    const ink = windowInk(winId);
    check('窗口内容非空（桌宠真的画出来了）', !!ink.bbox && ink.count > 2000,
        ink.error || `非透明像素 ${ink.count}`);
    if (ink.bbox && shape) {
        const [x0, y0, x1, y1] = ink.bbox;
        // 形状是设备像素、内容也是设备像素：形状必须完整包住内容
        const covered = x0 >= shape.x && y0 >= shape.y &&
            x1 <= shape.x + shape.w && y1 <= shape.y + shape.h;
        check('形状完整覆盖内容（没有裁切）', covered,
            `内容 ${JSON.stringify(ink.bbox)} vs 形状 ${JSON.stringify(shape)}`);
    }

    console.log('\n[5] 托盘图标');
    const items = sh('busctl', ['--user', 'get-property', 'org.kde.StatusNotifierWatcher',
        '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems']);
    const mainPid = (procs[0] || '').split(/\s+/)[0] || '';
    check('状态栏里有 Coopanion 的托盘项', !!mainPid && items.includes(mainPid),
        `pid=${mainPid}；当前托盘项 ${items.split(' ').length} 个`);

    console.log('\n[6] 页面与 preload');
    const { evaluate, shot, send } = await cdpConnect();
    // 页面刚起来时 preload 可能还没跑完（petHost 未暴露）——等它一会儿，别报假失败
    let hostKeys = [];
    for (let i = 0; i < 30; i++) {
        hostKeys = await evaluate('Object.keys(window.petHost || {})').catch(() => []);
        if (Array.isArray(hostKeys) && hostKeys.length >= 5) break;
        await sleep(600);
    }
    const title = await evaluate('document.title');
    check('页面标题正确', /桌宠|Cortico/.test(String(title)), String(title));
    check('preload 暴露了 petHost', Array.isArray(hostKeys) && hostKeys.length >= 5,
        JSON.stringify(hostKeys));
    check('preload 暴露了 setAlwaysOnTop（「置顶显示」开关的落地通道）',
        Array.isArray(hostKeys) && hostKeys.includes('setAlwaysOnTop'), JSON.stringify(hostKeys));
    const shapeErr = await evaluate('(window.petHost && window.petHost.shapeError) || ""');
    check('形状上报无初始化错误', !shapeErr, String(shapeErr));

    console.log('\n[7] 形象');
    // 大肥鱼不是 canvas，而是分件 SVG/rig 合成的（canvas 只在某些过渡帧出现），
    // 所以看「有多少几何元素」而不是「有没有 canvas」。
    const fig = await evaluate(`(() => {
      const geo = document.querySelectorAll('svg path, svg ellipse, svg circle, svg rect, svg g, svg polygon');
      const svgs = document.querySelectorAll('svg');
      return { geoCount: geo.length, svgCount: svgs.length, canvas: !!document.querySelector('canvas') };
    })()`);
    check('形象渲染容器存在（SVG 几何部件）', !!fig && fig.geoCount >= 3, JSON.stringify(fig));
    await shot('01-pet-avatar.png');

    console.log('\n[8] 逐按钮：引导气泡');
    const guide = await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.filter((b) => (b.textContent || '').trim())
        .map((b) => (b.textContent || '').trim().slice(0, 16));
    })()`);
    // 引导是**首次运行**才有的：第二次跑自检时它已经结束，属于正常状态。
    check('引导气泡状态可判定（存在可点按钮 / 已完成）', Array.isArray(guide),
        Array.isArray(guide) && guide.length ? `待点按钮 ${JSON.stringify(guide)}` : '引导已完成（非首次运行）');
    if (Array.isArray(guide) && guide.length) {
        // 优先点「关闭（×）」把引导收掉：引导期间桌宠的右键菜单是被抑制的，
        // 不收掉的话下一步测菜单会假失败。
        const clicked = await evaluate(`(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const close = btns.find((b) => /^[×✕xX]$/.test((b.textContent || '').trim()));
          const any = btns.find((b) => (b.textContent || '').trim());
          const target = close || any;
          if (!target) return null;
          const label = (target.textContent || '').trim().slice(0, 16) || '×';
          target.click();
          return label;
        })()`);
        check('点击引导按钮有响应', !!clicked, String(clicked));
        await sleep(1500);
        await shot('02-after-guide-click.png');
    }

    console.log('\n[9] 逐按钮：右键菜单');
    // 用**真实右键**（CDP 输入事件）点桌宠本体：测试里 dispatchEvent 派发的合成事件
    // 在应用做命中判定时会被丢掉（DSH 那边踩过同一个坑），真实输入才作准。
    // 桌宠本体位置取第 [4] 步量到的内容包围盒中心（设备像素 → 页面像素）。
    let menu = { ok: false, why: 'no-ink-bbox' };
    // 重要：桌宠会**走动**，第 [4] 步量的位置到这时已经过期了 —— 重新量一次。
    const inkNow = windowInk(winId);
    if (inkNow.bbox) {
        const px = ((inkNow.bbox[0] + inkNow.bbox[2]) / 2) / 2;
        // 取内容的**偏下**位置：气泡在上、桌宠本体在下，点上半部分容易点到气泡上
        const py = (inkNow.bbox[3] - 40 - 64) / 2;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
        await sleep(200);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'right', buttons: 2, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'right', buttons: 0, clickCount: 1 });
        await sleep(900);
        // 读菜单项 + 真的点一下「行为模式」必须在**同一次求值**里做完：
        // 菜单会自己关，而且第二次真实右键其实是在"把菜单关掉"（踩过两次）。
        menu = await evaluate(`(async () => {
          const pick = () => {
            let el = null, best = 0;
            for (const m of document.querySelectorAll('.menu')) {
              const r = m.getBoundingClientRect();
              const a = r.width * r.height;
              if (a > best) { best = a; el = m; }
            }
            return el;
          };
          // 注意：菜单项的可见文字其实在 aria-label/title 里（innerText 是空的），
          // 拼起来一起匹配，否则「找得到项、找不到名字」。
          const text = (b) => b ? ((b.innerText || b.textContent || '') + ' ' +
            (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')) : '';
          const label = (b) => text(b).trim().replace(/\\s+/g, ' ').slice(0, 44);
          const itemsIn = (el) => el ? Array.from(el.querySelectorAll('button,[role=menuitem],li')) : [];
          const el = pick();
          if (!el) return { ok: false, why: 'no-menu' };
          const r = el.getBoundingClientRect();
          if (r.width * r.height <= 0) return { ok: false, why: 'menu-invisible' };
          const items = itemsIn(el).map((b) => label(b) || '【图标】');
          // 顺便真的点一下「行为模式」，看标签是否变化
          const item = itemsIn(el).find((b) => /行为模式/.test(text(b)));
          let before = '', after = '';
          if (item) {
            before = label(item);
            item.click();
            await new Promise((res) => setTimeout(res, 600));
            after = label(itemsIn(pick()).find((b) => /行为模式/.test(text(b))));
          }
          return { ok: true, items, rect: [Math.round(r.width), Math.round(r.height)],
                   cycle: { before, after } };
        })()`);
    }
    check('右键能弹出菜单', !!menu?.ok, JSON.stringify(menu).slice(0, 160));
    if (menu?.ok) {
        check('菜单里有可点项（≥6）', Array.isArray(menu.items) && menu.items.length >= 6,
            JSON.stringify(menu.items).slice(0, 220));
        const joined = (menu.items || []).join('|');
        check('菜单含 设置/退出/行为模式/音效 等关键项',
            /设置/.test(joined) && /退出/.test(joined) && /行为模式/.test(joined) && /音效/.test(joined),
            joined.slice(0, 180));
        check('菜单尺寸合理', Array.isArray(menu.rect) && menu.rect[0] > 80 && menu.rect[1] > 100,
            JSON.stringify(menu.rect));
        const cyc = menu.cycle || {};
        check('点「行为模式」有响应', !!cyc.before, JSON.stringify(cyc).slice(0, 120));
        check('行为模式标签真的变了（设置生效）',
            !!cyc.after && cyc.after !== cyc.before, `${cyc.before} → ${cyc.after}`);
        await shot('03-context-menu.png');
        // 关掉菜单：点一下别处
        const ex = Math.max(10, (inkNow.bbox ? inkNow.bbox[0] / 4 : 20));
        const ey = Math.max(10, (inkNow.bbox ? inkNow.bbox[1] / 2 : 20));
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ex, y: ey, button: 'left', buttons: 1, clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(400);
    }

    console.log('\n[10] 逐按钮：装扮页');
    const opened = await evaluate(`(() => { try { window.petHost.openDress(); return true; } catch (e) { return String(e); } })()`);
    check('能请求打开装扮页', opened === true, String(opened));
    await sleep(2500);
    const dressWin = sh('bash', ['-lc', "xwininfo -root -tree | grep -c '桌宠装扮'"]);
    check('装扮窗口已出现', Number(dressWin || 0) > 0, `匹配 ${dressWin} 个`);

    console.log('\n[11] 截图存档');
    await shot('04-final.png');
    check('截图已存档', fs.readdirSync(OUT).some((f) => f.endsWith('.png')),
        OUT);

    console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
    if (failures.length) {
        console.log('失败项：');
        for (const f of failures) console.log('  - ' + f);
    }
    console.log(`截图目录：${OUT}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error('自检异常：', e.message);
    process.exit(2);
});
