#!/usr/bin/env node
/**
 * Coopanion 桌宠 —— 触屏专项验证（真实 CDP 触摸事件）
 * ============================================================================
 * 为什么单独做这个：
 *   桌面宠物的一切交互都是为鼠标设计的。触屏上有三个真实缺口，上游完全没有考虑：
 *     1) 触屏**没有悬停** → 靠 cursor.at 才显现的 .tools 悬停按钮永远不出现，
 *        等于"看得见点不到"；
 *     2) 触屏**没有右键** → 靠 contextmenu 弹的菜单彻底不可达；
 *     3) 触屏**不合成 dblclick** → "双击打字聊天"用不了。
 *   本脚本用 Input.dispatchTouchEvent 派发**真触摸事件**（不是页内合成
 *   dispatchEvent —— 那种会被应用的命中测试丢掉），逐条验证补齐是否真的生效，
 *   并确认鼠标路径没有被改坏。
 *
 * 用法：
 *   cd third-party/Coopanion
 *   COOPANION_DEBUG_PORT=9333 ./node_modules/electron/dist/electron . &
 *   node ../../tools/coopanion-touch-test.mjs
 *
 * 环境变量：CDP_PORT(9333) OUT_DIR(/tmp/coopanion-artifacts)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const OUT = process.env.OUT_DIR || '/tmp/coopanion-artifacts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function sh(cmd, args) {
    try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim(); } catch { return ''; }
}

/* ------------------------------------------------------------------ 窗口尺寸 */
function winGeom() {
    const tree = sh('xwininfo', ['-root', '-tree']);
    const m = /(0x[0-9a-f]+) "Cortico 桌宠"/.exec(tree);
    if (!m) return null;
    const info = sh('xwininfo', ['-id', m[1]]);
    const g = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(info)?.[1] || 0);
    return { id: m[1], w: g('Width'), h: g('Height'), x: g('Absolute upper-left X'), y: g('Absolute upper-left Y') };
}

/**
 * 取窗口像素求「墨迹包围盒」（物理像素）。
 * 不能用 capturePage()：本机对透明窗口恒返回全透明帧（实测）。只能上 X11 抓屏。
 */
function inkBBox(geom) {
    try {
        const xwd = `/tmp/coop-touch-${process.pid}.xwd`;
        execFileSync('xwd', ['-id', geom.id, '-silent', '-out', xwd], { timeout: 30000 });
        const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', xwd, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
            { maxBuffer: 1 << 30, timeout: 60000 });
        const { w, h } = geom;
        let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
        for (let p = 0; p < w * h; p++) {
            const i = p * 3;
            if (i + 2 >= raw.length) break;
            if (raw[i] > 12 || raw[i + 1] > 12 || raw[i + 2] > 12) {
                const x = p % w, y = (p - x) / w;
                count++;
                if (x < x0) x0 = x; if (y < y0) y0 = y;
                if (x > x1) x1 = x; if (y > y1) y1 = y;
            }
        }
        return x1 < 0 ? { count: 0, bbox: null } : { count, bbox: [x0, y0, x1 + 1, y1 + 1] };
    } catch (e) { return { error: String(e.message || e).slice(0, 120) }; }
}

/* ------------------------------------------------------------------ CDP */
async function connect() {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const target = list
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
        const i = ++id; pend.set(i, res);
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
        if (r.result?.data) { fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64')); return true; }
        return false;
    };
    return { evaluate, shot, send, ws };
}

/* ------------------------------------------------------------------ 触摸手势 */
const mk = (x, y) => [{ x, y, id: 1, radiusX: 14, radiusY: 14, force: 1, rotationAngle: 0 }];
const touchDown = (send, x, y) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: mk(x, y) });
const touchMove = (send, x, y) => send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: mk(x, y) });
const touchUp = (send) => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

/** 触摸长按：按下 → 保持 ms → 抬起 */
async function longPress(send, x, y, hold = 750) {
    await touchDown(send, x, y);
    await sleep(hold);
    await touchUp(send);
    await sleep(160);
}

/** 触摸轻点 */
async function tap(send, x, y, gap = 90) {
    await touchDown(send, x, y);
    await sleep(gap);
    await touchUp(send);
    await sleep(150);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('===== Coopanion 触屏专项验证 =====\n');

    const geom0 = winGeom();
    if (!geom0) { console.error('找不到 "Cortico 桌宠" 窗口，先启动 Coopanion'); process.exit(2); }
    const { evaluate, send, shot } = await connect();

    const dpr = await evaluate('window.devicePixelRatio') || 1;
    console.log(`[0] 窗口 ${geom0.w}x${geom0.h}   devicePixelRatio=${dpr}`);
    console.log(`    CSS 视口 ${await evaluate('innerWidth')}x${await evaluate('innerHeight')}`);

    /* 物理像素 → CSS 像素。窗口铺满屏幕，故窗口坐标 == 页面坐标（除以缩放比） */
    const toCss = (px, py) => ({ x: Math.round(px / dpr), y: Math.round(py / dpr) });

    /* ---------------------------------------------------------------- [1] 前置 */
    console.log('\n[1] 触屏前置条件');
    const ta = await evaluate(`(() => { const s = document.querySelector('.stage'); return s ? getComputedStyle(s).touchAction : 'no-stage'; })()`);
    check('.stage 设置了 touch-action:none（否则浏览器手势会抢走拖拽）', ta === 'none', String(ta));
    const styleHasTouch = await evaluate(`(() => {
        for (const ss of document.styleSheets) {
            let rules; try { rules = ss.cssRules; } catch (e) { continue; }
            for (const r of rules) if (r.selectorText === '.stage' && /touch-action/.test(r.cssText)) return true;
        }
        return false;
    })()`);
    check('CSS 规则里确实写了 touch-action（不只是计算值）', styleHasTouch === true, String(styleHasTouch));

    /* 让 CDP 的触摸事件能被渲染器接受 */
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    /* ---------------------------------------------------------------- [2] 事件探针 */
    console.log('\n[2] 触摸事件穿透到页面（探针）');
    await evaluate(`(() => {
        window.__touchProbe = { types: [], ptr: [], touch: 0, cancel: 0 };
        const rec = (e) => { window.__touchProbe.types.push(e.type); window.__touchProbe.ptr.push(e.pointerType || ''); };
        window.__tp = rec;
        for (const t of ['pointerdown','pointerup','touchstart','touchend','pointercancel'])
            document.addEventListener(t, (e) => { if (e.type.startsWith('touch') || t.startsWith('touch')) window.__touchProbe.touch++; if (e.type === 'pointercancel') window.__touchProbe.cancel++; rec(e); }, { capture: true, passive: true });
        return true;
    })()`);
    await tap(send, Math.round(await evaluate('innerWidth') / 2), 30);
    const probe = await evaluate('window.__touchProbe');
    check('CDP 触摸事件被页面收到', (probe?.types || []).length > 0, JSON.stringify(probe).slice(0, 160));
    check('事件带 pointerType=touch（真触摸，不是被当成鼠标）',
        (probe?.ptr || []).includes('touch'), JSON.stringify(probe?.ptr));
    await evaluate('(() => { for (const t of ["pointerdown","pointerup","touchstart","touchend","pointercancel"]) {} return true; })()');

    /* ---------------------------------------------------------------- [3] 找宠物 */
    console.log('\n[3] 定位鲸鱼（触屏无 hover，必须真的按在身体上）');
    /** 候选点：墨迹包围盒的偏下中部（Q 版身体重心在下），再退化为网格 */
    function candidates(bbox) {
        const [x0, y0, x1, y1] = bbox;
        const w = x1 - x0, h = y1 - y0;
        const pts = [
            [x0 + w * 0.5, y0 + h * 0.72], [x0 + w * 0.5, y0 + h * 0.6], [x0 + w * 0.5, y0 + h * 0.85],
            [x0 + w * 0.35, y0 + h * 0.7], [x0 + w * 0.65, y0 + h * 0.7], [x0 + w * 0.5, y0 + h * 0.45],
        ];
        return pts.map(([px, py]) => toCss(px, py));
    }
    const menuVisible = () => evaluate(`(() => {
        const es = Array.from(document.querySelectorAll('.menu'));
        const el = es.map((e) => ({ e, r: e.getBoundingClientRect() }))
            .filter((o) => o.r.width > 40 && o.r.height > 60)
            .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
        if (!el) return null;
        const items = Array.from(el.e.querySelectorAll('button,[role=menuitem],li'))
            .map((b) => ((b.innerText || b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).trim().replace(/\\s+/g, ' ').slice(0, 30));
        return { w: Math.round(el.r.width), h: Math.round(el.r.height), items };
    })()`);

    /** 窗口 Map State（IsViewable 才算正常） */
    const mapState = () => {
        const g = winGeom();
        if (!g) return 'no-window';
        const info = sh('xwininfo', ['-id', g.id, '-stats']);
        return (/Map State: (\S+)/.exec(info) || [, 'unknown'])[1];
    };
    /** 菜单只认 stage 的 pointerdown，所以光 dispatch 一个 click 关不掉它 */
    const closeMenus = async () => {
        await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        // 气泡也要关：它会被算进“墨迹包围盒”，把盒子撑大后按比例推出来的
        // 坐标就落到气泡上而不是身体上（右键弹不出菜单就是这么来的）
        await evaluate(`(() => { const c = document.querySelector('.bubble .b-close'); if (c) c.click(); return true; })()`);
        await tap(send, 10, 10, 40);   // 远处轻点 → 触发 stage.pointerdown → closeMenu()
        await sleep(160);
    };

    let petPoint = null, firstMenu = null;
    // 宠物可能正处在「走出去 / 走回来」的瞬间，同一个位置多测几次再下结论。
    // （踩过：上一轮测试把它拖到屏幕右边缘外，形状塔缩成 1x1 → 一点墨迹都没有）
    let ink0 = inkBBox(geom0);
    for (let i = 0; i < 5 && !ink0.bbox; i++) { await sleep(1200); ink0 = inkBBox(winGeom() || geom0); }
    check('能取到画面墨迹（说明宠物已渲染）', !!ink0.bbox, ink0.error || JSON.stringify(ink0).slice(0, 80));
    if (ink0.bbox) {
        for (const p of candidates(ink0.bbox)) {
            await longPress(send, p.x, p.y);
            const m = await menuVisible();
            if (m) { petPoint = p; firstMenu = m; break; }
            // 关键：没弹出菜单也要把可能已经开着的菜单关掉，
            // 否则下一次候选点可能正好点在菜单最后一项「隐藏桌宠」上，
            // 窗口会被 unmap，后续所有 xwd 抓屏都报 X_GetImage BadMatch（踩过）
            await closeMenus();
        }
    }
    check('触屏长按成功弹出菜单（上游：触屏没有右键，菜单完全不可达）', !!petPoint,
        petPoint ? `命中点 (${petPoint.x},${petPoint.y})` : '所有候选点都未弹出菜单');

    /* ---------------------------------------------------------------- [4] 菜单内容 */
    console.log('\n[4] 长按菜单可用性');
    if (firstMenu) {
        check('菜单尺寸合理', firstMenu.w > 80 && firstMenu.h > 100, `${firstMenu.w}x${firstMenu.h}`);
        check('菜单项 ≥6', firstMenu.items.length >= 6, JSON.stringify(firstMenu.items).slice(0, 200));
        const joined = firstMenu.items.join('|');
        check('含关键项（设置/退出/行为模式/音效）',
            /设置/.test(joined) && /退出/.test(joined) && /行为模式/.test(joined) && /音效/.test(joined), joined.slice(0, 160));
        await shot('T1-touch-longpress-menu.png');
        /* 触屏点菜单项：验证菜单是"可操作"的，不只是"能弹出来" */
        const clicked = await evaluate(`(() => {
            const es = Array.from(document.querySelectorAll('.menu'))
                .map((e) => ({ e, r: e.getBoundingClientRect() }))
                .filter((o) => o.r.width > 40 && o.r.height > 60)
                .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
            if (!es) return { ok: false, why: 'no-menu' };
            const bs = Array.from(es.e.querySelectorAll('button,[role=menuitem],li'));
            const hit = bs.find((b) => /行为模式/.test((b.innerText || '') + (b.getAttribute('aria-label') || '')));
            if (!hit) return { ok: false, why: 'no-item', n: bs.length };
            const before = (hit.innerText || '') + (hit.getAttribute('aria-label') || '');
            hit.click();
            return { ok: true, before: before.slice(0, 40) };
        })()`);
        check('菜单项可被触发', clicked?.ok === true, JSON.stringify(clicked).slice(0, 140));
        await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        await sleep(200);
    } else {
        check('菜单尺寸合理', false, '未弹出菜单');
        check('菜单项 ≥6', false, '未弹出菜单');
        check('含关键项（设置/退出/行为模式/音效）', false, '未弹出菜单');
        check('菜单项可被触发', false, '未弹出菜单');
    }

    /* ---------------------------------------------------------------- [5] 轻点露出悬停按钮 */
    console.log('\n[5] 轻点 → 露出 .tools 悬停按钮（触屏无 hover）');
    /** 读 .tools 的真实可见性 */
    const toolsProbe = () => evaluate(`(() => {
        const t = document.querySelector('.tools');
        if (!t) return { exists: false };
        const cs = getComputedStyle(t), r = t.getBoundingClientRect();
        return { exists: true, hidden: t.hidden, display: cs.display, opacity: cs.opacity,
                 visibility: cs.visibility, w: Math.round(r.width), h: Math.round(r.height),
                 buttons: t.querySelectorAll('button').length,
                 clickable: r.width > 10 && r.height > 10 && cs.display !== 'none'
                            && cs.visibility !== 'hidden' && Number(cs.opacity) > .05 };
    })()`);
    /** 重新定位宠物：鲸鱼会走动，[3] 量到的点到这里已经不准了（这就是本项第一次失败的原因） */
    const freshPetPoint = () => {
        const ink = inkBBox(winGeom());
        if (!ink.bbox) return null;
        const [x0, y0, x1, y1] = ink.bbox;
        return toCss(x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * 0.72);
    };
    let tools = null, toolsPoint = null;
    // 先清掉可能挡住宠物的气泡/菜单。
    // 首次运行会有引导气泡，它会被算进"墨迹包围盒"里把盒子撑大，于是按包围盒
    // 推算出来的点就落不到身体上 —— 这就是本项第一次失败的真因（跑 [3] 时气泡
    // 还在，所以那里用多候选点能命中，而这里只用了一个点）。
    await evaluate(`(() => {
        const b = document.querySelector('.bubble');
        if (b && getComputedStyle(b).display !== 'none') b.querySelector('.b-close') && b.querySelector('.b-close').click();
        return true;
    })()`);
    await sleep(320);
    // 宠物会走动、气泡会撑大包围盒：所以像 [3] 一样按多个候选点试，而不是只试一个
    for (let round = 0; round < 2 && !tools?.clickable; round++) {
        const ink = inkBBox(winGeom());
        const pts = ink.bbox ? candidates(ink.bbox) : (petPoint ? [petPoint] : []);
        for (const p of pts) {
            await tap(send, p.x, p.y);
            await sleep(320);
            tools = await toolsProbe();
            if (tools?.clickable) { toolsPoint = p; break; }
            await closeMenus();
        }
    }
    check('.tools 元素存在', tools?.exists === true, JSON.stringify(tools).slice(0, 160));
    check('轻点后悬停按钮变为可见/可点（否则触屏永远按不到它们）',
        tools?.clickable === true, JSON.stringify(tools).slice(0, 220));
    check('悬停按钮有多个可点项', (tools?.buttons || 0) >= 2, `buttons=${tools?.buttons}`);
    if (tools?.clickable) await shot('T2-touch-tap-tools.png');
    /* 既然按钮真的可见了，就用触摸真的点一个，证明「看得见也点得到」。
       注意：绝不能随便点第一个 —— 菜单/HOVER 里包含「隐藏桌宠」，点下去窗口会被
       unmap，后续 xwd 抓屏全部报 X_GetImage BadMatch，会把测试带进坑里。
       所以只挑无副作用的按钮（聊天/语音/装扮/音效/夜间/走动）。 */
    if (tools?.clickable && toolsPoint) {
        const picked = await evaluate(`(() => {
            const SAFE = /聊天|说话|chat|语音|voice|装扮|dress|音效|sound|夜间|theme|走动|roam/i;
            const DANGER = /隐藏|hide|退出|quit|close|关闭/i;
            const t = document.querySelector('.tools');
            if (!t) return null;
            const btns = Array.from(t.querySelectorAll('button'));
            const pickInfo = (b) => {
                const r = b.getBoundingClientRect();
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            };
            const label = (b) => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' '
                + (b.getAttribute('title') || '')).trim();
            const all = btns.map(label).slice(0, 8);
            const b = btns.find((el) => !DANGER.test(label(el)) && SAFE.test(label(el)))
                || btns.find((el) => !DANGER.test(label(el)));
            if (!b) return { ok: false, labels: all, why: '只有危险按钮' };
            window.__btnHit = null;
            b.addEventListener('pointerdown', (e) => { window.__btnHit = e.pointerType; }, { once: true, capture: true });
            return { ok: true, pos: pickInfo(b), label: label(b).slice(0, 20), labels: all };
        })()`);
        if (picked?.ok) {
            await tap(send, picked.pos.x, picked.pos.y);
            await sleep(500);
            const hit = await evaluate('window.__btnHit');
            check('触摸能真的点到悬停按钮（按钮收到 pointerType=touch 的事件）',
                hit === 'touch', `点了「${picked.label}」, 收到的 pointerType = ${JSON.stringify(hit)}`);
        } else {
            check('触摸能真的点到悬停按钮（按钮收到 pointerType=touch 的事件）', false,
                JSON.stringify(picked).slice(0, 160));
        }
    } else {
        check('触摸能真的点到悬停按钮（按钮收到 pointerType=touch 的事件）', false, '按钮不可见，无法点击');
    }
    /* 关键回归：整轮触摸交互结束后窗口必须仍是 mapped。
       否则说明某个触摸手势把手隐藏了（踩过这个坑：点了「隐藏桌宠」→ 后续 xwd 全报
       X_GetImage BadMatch）。 */
    const mapAfterTools = sh('xwininfo', ['-id', winGeom()?.id || '', '-stats']);
    check('触摸交互后桌宠窗口仍处于显示状态', /Map State: IsViewable/.test(mapAfterTools),
        (/Map State: (\S+)/.exec(mapAfterTools) || [])[1] || '读不到');

    /* ---------------------------------------------------------------- [6] 双击打字 */
    console.log('\n[6] 双击 → 打开输入框（触屏不合成 dblclick）');
    await closeMenus();
    if (petPoint) {
        const before = await evaluate(`!!document.querySelector('.d-input input, .d-input textarea, .bubble input, #ask input')`);
        await tap(send, petPoint.x, petPoint.y, 70);
        await sleep(90);
        await tap(send, petPoint.x, petPoint.y, 70);
        await sleep(700);
        const after = await evaluate(`(() => {
            const el = document.querySelector('input[type=text], textarea');
            if (!el) return { open: false };
            const r = el.getBoundingClientRect();
            return { open: r.width > 20 && r.height > 8, w: Math.round(r.width), h: Math.round(r.height) };
        })()`);
        check('双击后出现输入框', after?.open === true, `之前=${before} 之后=${JSON.stringify(after)}`);
        await shot('T3-touch-doubletap-input.png');
        await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
        await sleep(250);
    } else {
        check('双击后出现输入框', false, '未定位到宠物');
    }

    /* ---------------------------------------------------------------- [7] 触摸拖拽 */
    console.log('\n[7] 触摸拖拽（手指拖动宠物）');
    await closeMenus();
    // 先把「窗口还活着」这件事单独断言一次：
    // 如果把它和拖拽失败搔在一起，就会像之前那样看不出到底是拖拽不灵
    // 还是窗口已经被前面的交互误关了。
    check('拖拽前宠物窗口仍可见', mapState() === 'IsViewable', mapState());
    if (petPoint) {
        await evaluate(`(() => { document.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        await sleep(300);
        const g = winGeom();
        const inkA = inkBBox(g);
        if (!inkA.bbox) { check('触摸拖拽让宠物真的移动了（≥40 CSS px）', false, '量不到墨迹（宠物在屏幕外？）'); }
        const from = toCss(inkA.bbox ? (inkA.bbox[0] + inkA.bbox[2]) / 2 : petPoint.x * dpr,
            inkA.bbox ? (inkA.bbox[1] + inkA.bbox[3]) / 2 : petPoint.y * dpr);
        await touchDown(send, from.x, from.y);
        // **朝屏幕中心拉**，不要一古脑往右拖：拖到视口外会让形状塔缩成 1x1，
        // 宠物从屏幕上消失，下一轮测试连墨迹都量不到（真踩过）
        const vw = await evaluate('innerWidth') || 1560;
        const dx = from.x > vw / 2 ? -Math.min(240, Math.max(80, Math.round(vw * 0.35))) : 240;
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
            await touchMove(send, from.x + Math.round((dx * i) / steps), from.y);
            await sleep(35);
        }
        await touchUp(send);
        // 只等很短时间就量：放手后宠物会 walkTo(home) 往回走，
        // 等 900ms 再量就只能看到它已经走回去一段（实测只刺 35px，阈值 40）——
        // 那是测试时序问题，不是“拖拽不灵”。
        await sleep(250);
        const inkB = inkBBox(winGeom());
        const cxA = inkA.bbox ? (inkA.bbox[0] + inkA.bbox[2]) / 2 : 0;
        const cxB = inkB.bbox ? (inkB.bbox[0] + inkB.bbox[2]) / 2 : 0;
        const moved = Math.abs(cxB - cxA) / dpr;
        check('触摸拖拽让宠物真的移动了（≥40 CSS px）', moved >= 40,
            `位移 ${moved.toFixed(0)} CSS px（起点 ${cxA.toFixed(0)} → ${cxB.toFixed(0)} 物理）`);
        await shot('T4-touch-drag.png');
    } else {
        check('触摸拖拽让宠物真的移动了（≥40 CSS px）', false, '未定位到宠物');
    }

    /* ---------------------------------------------------------------- [8] 滑动不误触菜单 */
    console.log('\n[8] 触摸快速滑动 → 不应误弹菜单（长按必须被正确取消）');
    await closeMenus();
    if (petPoint) {
        await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        await sleep(250);
        const g = winGeom();
        const ink = inkBBox(g);
        const st = toCss(ink.bbox ? (ink.bbox[0] + ink.bbox[2]) / 2 : petPoint.x * dpr,
            ink.bbox ? (ink.bbox[1] + ink.bbox[3]) / 2 : petPoint.y * dpr);
        await touchDown(send, st.x, st.y);
        await sleep(80);
        for (let i = 1; i <= 5; i++) { await touchMove(send, st.x + i * 30, st.y); await sleep(25); }
        await sleep(520);          // 累计已超长按阈值，但因为滑动过，不该弹
        const m = await menuVisible();
        await touchUp(send);
        await sleep(200);
        check('滑动超过 slop 后不弹菜单', !m, m ? `误弹：${JSON.stringify(m).slice(0, 90)}` : '正确未弹');
    } else {
        check('滑动超过 slop 后不弹菜单', false, '未定位到宠物');
    }

    /* ---------------------------------------------------------------- [9] 鼠标路径回归 */
    console.log('\n[9] 回归：鼠标路径没有被触屏代码改坏');
    await closeMenus();
    check('鼠标回归前宠物窗口仍可见', mapState() === 'IsViewable', mapState());
    // 关键：必须**先关掉触摸模拟**。setTouchEmulationEnabled(true) 会把
    // Input.dispatchMouseEvent 也转成触摸，右键根本走不到 contextmenu ——
    // 这一点本脚本第一版就踩了，误报成“鼠标路径被改坏”。
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await sleep(200);
    await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
    await sleep(300);
    {
        let m = null, used = null;
        // 宠物一直在走动，所以每次都重新量墨迹再试；顺便试几个高度（身体/头部）
        for (const fy of [0.72, 0.6, 0.85]) {
            const ink = inkBBox(winGeom());
            if (!ink.bbox) continue;
            const [x0, y0, x1, y1] = ink.bbox;
            const p = toCss(x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * fy);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 });
            await sleep(420);
            m = await menuVisible();
            if (m) { used = `${p.x},${p.y} (fy=${fy})`; break; }
            await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
            await sleep(200);
        }
        check('鼠标右键仍能弹菜单（触屏代码不影响鼠标）', !!m,
            m ? `${m.items.length} 项，命中 ${used}` : '未弹出（已重测 3 个位置）');
        await evaluate(`(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
        await shot('T5-mouse-regression.png');
    }

    /* ---------------------------------------------------------------- 汇总 */
    console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
    if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
    console.log(`截图目录：${OUT}`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('触屏自检异常：', e.message); process.exit(2); });
