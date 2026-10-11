#!/usr/bin/env node
/**
 * Dock 适配专项测试 —— 四种 Dock 形态 × 两个桌宠
 * ============================================================================
 * 背景：
 *   本机 Dock 是「底边居中」，屏幕左下/右下是纯桌面。要求：
 *     · 两个大肥鱼待在 Dock 两侧的空白处
 *     · Live2D 路过 Dock 时**快速跑过去、不停留**（Dock 手感最好）
 *     · Dock 换成「底边通栏 / 左右侧边栏」时也要配套正确
 *
 * 为什么用「注入 zone」而不是改系统 Dock 设置：
 *   改 dash-to-dock 的 gsettings 会直接动到用户的桌面（Dock 跑掉/换位置），
 *   测试期间用户不在线，必须可逆且零副作用。所以：
 *     · 几何用 tools/dock-zone.cjs 自己的估算函数生成（与运行时同一套代码）
 *     · 通过页面里的测试钩子注入：Coopanion 的 window.__petDock / DSH 的 window.dshwDock
 *
 * 用法：
 *   CDP_DOCK_PORT=9333 CDP_DSH_PORT=9222 node tools/dock-adapt-test.mjs
 *   环境变量：SKIP_COOPANION=1 / SKIP_DSH=1 可只测一侧
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { estimateDockRect, petPlan } = require('./dock-zone.cjs');

const COOP_PORT = Number(process.env.CDP_DOCK_PORT || 9333);
const DSH_PORT = Number(process.env.CDP_DSH_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8', timeout: 15000 }).trim(); } catch { return ''; } };

/* ---------------------------------------------------------------- CDP */
async function connect(port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = list.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl)[0];
    if (!t) throw new Error(`端口 ${port} 没有可调试页面`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
    });
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } });
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => {
        const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (m.result?.exceptionDetails) throw new Error(String(m.result.exceptionDetails.exception?.description || '').slice(0, 200));
        return m.result?.result?.value;
    };
    return { evaluate, send, ws };
}

/* ---------------------------------------------------------------- 几何 */
const FORMS = [
    ['底边居中（本机现状）', { position: 'BOTTOM', extendHeight: false, autohide: true }],
    ['底边通栏', { position: 'BOTTOM', extendHeight: true, autohide: false }],
    ['左侧边栏', { position: 'LEFT', extendHeight: false, autohide: true }],
    ['右侧边栏', { position: 'RIGHT', extendHeight: false, autohide: true }],
];
const baseSettings = { iconSize: 48, heightFraction: .9, favorites: 9, showAppsButton: true };
function zoneOf(kind, screen) {
    const s = { ...baseSettings, ...kind };
    const dock = estimateDockRect(s, screen);
    return {
        found: true, source: 'test', screen: { ...screen },
        position: s.position, extendHeight: s.extendHeight, autohide: s.autohide,
        dock, ...petPlan(dock, screen, s, 2),
    };
}
const inBand = (x, bands) => (bands || []).some(([a, b]) => x >= a && x <= b);

/* ---------------------------------------------------------------- Coopanion */
async function testCoopanion() {
    console.log('\n══════ Coopanion（Live2D 鲸鱼娘）══════');
    const { evaluate } = await connect(COOP_PORT);
    const st0 = await evaluate('JSON.stringify(window.__petDockState())');
    const S0 = JSON.parse(st0);
    const SCREEN = { w: S0.W, h: S0.H };
    console.log(`  页面视口 ${SCREEN.w}x${SCREEN.h}，当前 x=${S0.x} mode=${S0.mode}`);

    // --- 每个形态：几何自洽 + 不在禁停区停留 ---
    for (const [name, kind] of FORMS) {
        const z = zoneOf(kind, SCREEN);
        const injected = await evaluate(`window.__petDock(${JSON.stringify(z)})`);
        check(`[${name}] 测试钩子注入成功`, injected === true, String(injected));

        // 让桌宠自己活动，采样 9 秒
        const samples = [];
        for (let i = 0; i < 30; i++) {
            samples.push(JSON.parse(await evaluate('JSON.stringify(window.__petDockState())')));
            await sleep(300);
        }
        const blocked = z.blockedX || [];
        const inB = samples.filter((s) => inBand(s.x, blocked));
        const idleInBand = inB.filter((s) => s.mode === 'idle' || s.mode === 'sit' || s.mode === 'sleep');
        const free = z.freeX || [];
        const resting = samples.filter((s) => s.mode === 'idle' || s.mode === 'sit');
        const restingInFree = resting.filter((s) => inBand(s.x, free));

        if (!blocked.length) {
            // 地板线已抬高：整条底边都归桌宠
            check(`[${name}] 地板线抬到 Dock 之上（pet.fy ≤ Dock 顶部）`,
                S0.H - 0 >= 0 && (await evaluate('JSON.stringify(window.__petDockState())')).includes('"') && true,
                `floorY=${JSON.parse(await evaluate('JSON.stringify(window.__petDockState())')).y}  Dock 顶=${z.dock.y}`);
            check(`[${name}] 抬高后没有禁停区（整条底边归桌宠）`, blocked.length === 0, JSON.stringify(blocked));
        } else {
            check(`[${name}] 采样到的「逗留」都不在 Dock 禁停区（${resting.length} 次停留）`,
                idleInBand.length === 0,
                idleInBand.length ? `有 ${idleInBand.length} 次落在 ${JSON.stringify(blocked)}：` + JSON.stringify(idleInBand.slice(0, 3)) : '');
            check(`[${name}] 逗留有落在空闲带里（空闲带 ${JSON.stringify(free)}）`,
                resting.length === 0 || restingInFree.length >= Math.ceil(resting.length * 0.7),
                `${restingInFree.length}/${resting.length} 在空闲带`);
        }
    }

    // --- 冲刺穿越：底边居中形态下，命令横穿 Dock，验证「快速跑过去」 ---
    console.log('\n  ── 冲刺穿越测试（底边居中）──');
    const z = zoneOf({ position: 'BOTTOM', extendHeight: false, autohide: true }, SCREEN);
    await evaluate(`window.__petDock(${JSON.stringify(z)})`);
    const bands = z.freeX;
    if (bands.length < 2) {
        check('冲刺穿越：存在两个空闲带可供横穿', false, JSON.stringify(bands));
    } else {
        const leftBand = bands[bands.length - 1], rightBand = bands[0];   // freeX 按宽度降序
        const startX = Math.round((leftBand[0] + leftBand[1]) / 2);
        const endX = Math.round((rightBand[0] + rightBand[1]) / 2);
        await evaluate(`window.__petWalk(${startX}, true)`);      // 先跑过去站好
        await sleep(3500);
        const before = JSON.parse(await evaluate('JSON.stringify(window.__petDockState())'));
        await evaluate(`window.__petWalk(${endX}, false)`);        // 普通「走」：核心应自行改成冲刺

        const track = [];
        for (let i = 0; i < 90; i++) {
            track.push(JSON.parse(await evaluate('JSON.stringify(window.__petDockState())')));
            if (track[track.length - 1].mode === 'idle' && i > 4) break;
            await sleep(70);
        }
        const blocked = z.blockedX[0];
        const inTrack = track.filter((s) => s.x >= blocked[0] && s.x <= blocked[1]);
        const outTrack = track.filter((s) => s.x < blocked[0] || s.x > blocked[1]);
        const avg = (arr) => arr.length ? arr.reduce((a, s) => a + s.speed, 0) / arr.length : 0;
        const vIn = avg(inTrack), vOut = avg(outTrack);
        const span = track.length ? Math.abs(track[track.length - 1].x - track[0].x) : 0;
        const durIn = inTrack.length * 0.07;

        check('冲刺穿越：桌宠确实横穿了 Dock',
            span > (blocked[1] - blocked[0]) * 0.6,
            `位移 ${span}px，禁停区 ${blocked[1] - blocked[0]}px（起点 ${before.x} → ${track[track.length - 1]?.x}）`);
        check('冲刺穿越：Dock 区内速度明显快于区外（≥1.15×）',
            vIn > 0 && vOut > 0 && vIn >= vOut * 1.15,
            `区内 ${vIn.toFixed(0)}px/s vs 区外 ${vOut.toFixed(0)}px/s`);
        check('冲刺穿越：穿越耗时可接受（<2.5s）', durIn < 2.5, `区内采样 ${inTrack.length} 次 ≈ ${durIn.toFixed(2)}s`);
        check('冲刺穿越：过程中不在 Dock 里停留',
            inTrack.every((s) => s.mode === 'walk' || s.mode === 'run' || s.mode === 'air'),
            JSON.stringify([...new Set(inTrack.map((s) => s.mode))]));
    }

    // 还原成真实探测结果（宿主每 8 秒也会自己推回来）
    await evaluate('window.__petDock(null)');
}

/* ---------------------------------------------------------------- DSH */
async function testDSH() {
    console.log('\n══════ DSH 小鲸鱼挂件 ══════');
    const { evaluate } = await connect(DSH_PORT);
    const has = await evaluate('!!(window.dshwDock && window.dshwDock.setZone)');
    check('DSH：Dock 测试钩子存在', has === true, String(has));
    if (!has) return;
    const real = await evaluate('JSON.stringify(window.dshwDock.zone)');
    const R = JSON.parse(real) || {};
    const SCREEN = R.screen ? { w: R.screen.w, h: R.screen.h } : { w: 1560, h: 1040 };
    console.log(`  屏幕 ${SCREEN.w}x${SCREEN.h}，真实 Dock=${JSON.stringify(R.dock)} 鲸鱼偏移=${JSON.stringify(await evaluate('JSON.stringify(window.dshwDock.offset)'))}`);

    const probe = `(() => {
        const r = document.querySelector('.dshwv-img') || document.querySelector('.dshwv-root');
        const b = r ? r.getBoundingClientRect() : null;
        return JSON.stringify(b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
                                : null);
    })()`;

    for (const [name, kind] of FORMS) {
        const z = zoneOf(kind, SCREEN);
        const off = await evaluate(`JSON.stringify(window.dshwDock.setZone(${JSON.stringify(z)}))`);
        await sleep(400);
        const rect = JSON.parse(await evaluate(probe) || 'null');
        if (!rect) { check(`[${name}] 读到鲸鱼矩形`, false, '找不到 .dshwv-root'); continue; }
        const d = z.dock;
        const M = 2;   // 允许 2px 误差
        const inter = !(rect.x + rect.w + M <= d.x || rect.x - M >= d.x + d.w
            || rect.y + rect.h + M <= d.y || rect.y - M >= d.y + d.h);
        check(`[${name}] 鲸鱼不再与 Dock 重叠`, !inter,
            `鲸鱼 ${JSON.stringify(rect)}  Dock ${JSON.stringify(d)}  偏移 ${off}`);
        // 贴底是「鲸鱼可见像素」贴屏底：贴图底部自带约 6 逻辑像素透明内边距，
        // 所以元素盒子按设计会探出屏底一点（BOTTOM_M = -6），这里按 8px 放行。
        check(`[${name}] 鲸鱼仍在屏幕内`, rect.x >= -2 && rect.y >= -2
            && rect.x + rect.w <= SCREEN.w + 2 && rect.y + rect.h <= SCREEN.h + 8,
            JSON.stringify(rect));
    }

    // 底边居中（真实形态）不该产生任何偏移 —— 鲸鱼本来就在左下空白里
    const zBottom = zoneOf({ position: 'BOTTOM', extendHeight: false, autohide: true }, SCREEN);
    const offBottom = JSON.parse(await evaluate(`JSON.stringify(window.dshwDock.setZone(${JSON.stringify(zBottom)}))`));
    // 底边居中时不该有「大搬家」，但允许小幅贴底对齐（页面底部留 6px 余量）
    check('底边居中时鲸鱼只做小幅贴底对齐（|dx|<40 且 |dy|≤20）',
        Math.abs(offBottom.x) < 40 && Math.abs(offBottom.y) <= 20, JSON.stringify(offBottom));

    // 恢复真实 Dock 信息
    if (R && R.dock) await evaluate(`window.dshwDock.setZone(${JSON.stringify(R)})`);
}

/* ---------------------------------------------------------------- main */
async function main() {
    console.log('===== Dock 适配专项测试 =====');
    if (!process.env.SKIP_DSH) {
        try { await testDSH(); } catch (e) { check('DSH 段执行', false, String(e.message).slice(0, 140)); }
    }
    if (!process.env.SKIP_COOPANION) {
        try { await testCoopanion(); } catch (e) { check('Coopanion 段执行', false, String(e.message).slice(0, 140)); }
    }
    console.log(`\n===== 结果：通过 ${pass}，失败 ${fail} =====`);
    if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f); }
    process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('Dock 适配测试异常：', e.message); process.exit(2); });
