// DSH Whale Widget —— GNOME Shell 扩展版（Wayland 桌面悬浮小鲸鱼）v20
// 交互：左键按住=跟随鼠标走、松开=停；左键短按(无移动)=看余额台词；右键=菜单
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CRED_FILE = `${GLib.get_home_dir()}/.dsh/.credentials.yaml`;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const SNAP_DIST = 70;      // 贴边吸附距离(px)
const PEAK_MODES = ['default', 'liangwen', 'qiangqiang'];

const PEAK_TXT = {
    default: ['⚡ 高峰时段，注意用量哦', '⚡ 现在是高峰计费，先省着点~'],
    liangwen: ['⚡ 梁文峰 · 现在是高峰', '⚡ 梁文峰，烧钱快哦'],
    qiangqiang: ['⚡ !?峰峰!? 高峰哦', '⚡ 峰峰时段来咯'],
};
const OFF_TXT = {
    default: ['🌙 低谷时段，放心大胆用', '🌙 现在是低谷价，很适合跑任务~'],
    liangwen: ['🌙 梁文谷 · 现在是低谷', '🌙 梁文谷，随便用啦'],
    qiangqiang: ['🌙 !?谷谷!? 低谷哦', '🌙 谷谷时段，超划算'],
};
const CUTE_LINES = [
    '呜…我的余额呢 (´･_･`)',
    '要…要抱抱吗 (,,•﹏•,,)',
    '摸鱼被我逮到啦！',
    '今天也要一起加油鸭！',
    '你敲代码的样子真帅~',
    'DeepSeek 天下第一！',
    '哼，不许偷看我的小肚子！',
    '已经盯着你很久了哦~',
    '让我康康你的余额…',
    '辛苦啦，歇一会儿吧~',
    '检测到你在认真工作 (盯~)',
    '小心烧 token 哦~',
    '诶嘿，今天想聊点什么？',
];
const PEAK_MODE_LABEL = {default: '默认', liangwen: '梁文峰谷', qiangqiang: '!?强强?!'};

const BTN_STYLE = 'background-color: transparent; color: #eaf1ff;' +
    'border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 500;';
const BTN_HOVER = 'background-color: rgba(255,255,255,0.12); color: #ffffff;' +
    'border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 500;';

export default class DshWhaleWidget extends Extension {
    enable() {
        this._apiKey = null;
        this._bub = null;
        this._bubTimer = 0;
        this._bubTick = 0;
        this._menu = null;
        this._whaleScale = 1;
        this._mirror = 1;
        this._hold = null;
        this._followTimer = 0;
        this._captureId = 0;
        this._lastMoveAt = 0;
        this._breathing = false;
        this._breathTimer = 0;
        this._peakMode = 'default';
        this._soundOn = true;
        this._readKey();
        this._buildWhale();
        this._placeInitial();
        this._captureId = global.stage.connect('captured-event', (s, ev) => this._onCaptured(ev));
        this._breathTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => this._tryBreath());
    }

    disable() {
        this._hold = null;
        if (this._followTimer) {
            GLib.source_remove(this._followTimer);
            this._followTimer = 0;
        }
        if (this._captureId) {
            global.stage.disconnect(this._captureId);
            this._captureId = 0;
        }
        if (this._breathTimer) {
            GLib.source_remove(this._breathTimer);
            this._breathTimer = 0;
        }
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bubTick) {
            GLib.source_remove(this._bubTick);
            this._bubTick = 0;
        }
        if (this._bub)
            this._bub.destroy();
        this._bub = null;
        if (this._tail)
            this._tail.destroy();
        this._tail = null;
        this._closeMenu();
        if (this._whale) {
            const parent = this._whale.get_parent();
            if (parent)
                parent.remove_child(this._whale);
            this._whale.destroy();
        }
        this._whale = null;
    }

    _assetPath(name) {
        const filePath = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''));
        const dir = filePath.slice(0, filePath.lastIndexOf('/'));
        return `${dir}/assets/${name}`;
    }

    _pick(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    _isPeak() {
        const bj = new Date(Date.now() + 8 * 3600 * 1000);
        const day = bj.getUTCDay();
        const hour = bj.getUTCHours();
        if (day === 0 || day === 6)
            return false;
        return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    }

    _workArea() {
        const lm = Main.layoutManager;
        const mono = lm.primaryMonitor
            || (Array.isArray(lm.monitors) && lm.monitors[0])
            || null;
        if (mono && mono.workArea)
            return mono.workArea;
        try {
            const idx = global.display.get_primary_monitor();
            const g = global.display.get_monitor_geometry(idx);
            return {x: g.x, y: g.y, width: g.width, height: g.height};
        } catch (e) {
            return {x: 0, y: 0, width: 1920, height: 1080};
        }
    }

    _buildWhale() {
        const asset = this._assetPath('dshw.png');
        const icon = new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(asset)),
            icon_size: 220,
            reactive: true,
            track_hover: true,
        });
        icon.set_pivot_point(0.5, 0.5);
        icon.connect('button-press-event', (a, ev) => this._onPress(a, ev));
        icon.connect('button-release-event', () => this._endHold());
        icon.connect('scroll-event', (a, ev) => this._onScroll(a, ev));
        this._w = 220;
        this._h = 220;
        this._img = icon;
        this._whale = icon;
        Main.uiGroup.add_child(this._whale);
        Main.uiGroup.set_child_above_sibling(this._whale, null);
    }

    _placeInitial() {
        const wa = this._workArea();
        const x = wa.x + 24;
        const y = wa.y + wa.height - this._h - 72;
        this._whale.set_position(Math.round(x), Math.round(y));
        this._mirror = -1;
        this._img.set_scale(this._mirror, 1);
    }

    _readKey() {
        this._apiKey = null;
        try {
            const [ok, data] = GLib.file_get_contents(CRED_FILE);
            if (ok) {
                const m = data.toString().match(/DEEPSEEK_API_KEY\s*:\s*"?([^\s"#]+)"?/);
                if (m)
                    this._apiKey = m[1];
            }
        } catch (e) {
            log(`[dsh-whale] cred read failed: ${e}`);
        }
    }

    // —— 统一缩放/镜像 ——
    _easeScale(mul, dur, mode) {
        this._img.ease({
            scale_x: this._mirror * this._whaleScale * mul,
            scale_y: this._whaleScale * mul,
            duration: dur || 160,
            mode: mode || Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _setMirror(m) {
        if (this._mirror === m)
            return;
        this._mirror = m;
        this._easeScale(1, 150, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _playSound(name) {
        if (!this._soundOn)
            return;
        try {
            const p = this._assetPath(name);
            GLib.spawn_async(null, ['/usr/bin/pw-play', p], null,
                GLib.SpawnFlags.SEARCH_PATH |
                GLib.SpawnFlags.STDOUT_TO_DEV_NULL |
                GLib.SpawnFlags.STDERR_TO_DEV_NULL, null);
        } catch (e) { /* 静默 */ }
    }

    _tryBreath() {
        if (this._hold || this._breathing || this._menu || !this._whale)
            return GLib.SOURCE_CONTINUE;
        if (Date.now() - (this._lastMoveAt || 0) < 1600)
            return GLib.SOURCE_CONTINUE;
        this._breathing = true;
        const baseY = this._whale.get_y();
        this._whale.ease({
            y: baseY - 6,
            duration: 650,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                this._breathing = false;
                if (this._whale && !this._hold && !this._menu)
                    this._whale.ease({y: baseY, duration: 650, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
            },
        });
        return GLib.SOURCE_CONTINUE;
    }

    // ============ 交互 ============
    _onPress(a, ev) {
        if (this._menu)
            this._closeMenu();
        if (ev.get_button() === 3) {       // 右键 → 菜单
            const [mx, my] = ev.get_coords();
            this._openMenu(mx, my);
            return Clutter.EVENT_STOP;
        }
        if (ev.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        this._hold = {sx: px, sy: py, moved: false};
        this._playSound('Ya1.mp3');
        this._easeScale(0.93, 90, Clutter.AnimationMode.EASE_OUT_QUAD);
        if (!this._followTimer)
            this._followTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => this._followTick());
        return Clutter.EVENT_STOP;
    }

    _onCaptured(ev) {
        if (!this._hold)
            return Clutter.EVENT_PROPAGATE;
        if (ev.type() === Clutter.EventType.BUTTON_RELEASE && ev.get_button() === 1)
            this._endHold();
        return Clutter.EVENT_PROPAGATE;
    }

    _followTick() {
        const h = this._hold;
        if (!h)
            return GLib.SOURCE_REMOVE;
        try {
            const [mx, my] = global.get_pointer();
            if (Math.abs(mx - h.sx) > 5 || Math.abs(my - h.sy) > 5)
                h.moved = true;
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const nh = Math.round(this._h * this._whaleScale);
            let tx = mx - nw - 6;
            let ty = my - nh + 24;
            if (tx < wa.x)
                tx = mx + 10;
            tx = Math.max(wa.x, Math.min(wa.x + wa.width - nw, tx));
            ty = Math.max(wa.y, Math.min(wa.y + wa.height - nh, ty));
            const rx = Math.round(tx);
            const ry = Math.round(ty);
            // 跟随用即时 set_position：避免 ease 在边缘被 clamp 后反复触发造成抖动/抗拒
            if (this._whale.get_x() !== rx || this._whale.get_y() !== ry)
                this._whale.set_position(rx, ry);
            this._lastMoveAt = Date.now();
            // 翻转由鲸鱼所在半屏决定：左半翻转朝右、右半原图朝左（看屏幕内）
            const cx = rx + nw / 2;
            this._setMirror(cx < wa.x + wa.width / 2 ? -1 : 1);
        } catch (e) {
            log(`[dsh-whale] follow err: ${e}`);
        }
        return GLib.SOURCE_CONTINUE;
    }

    _endHold() {
        if (!this._hold)
            return;
        const moved = this._hold.moved;
        this._hold = null;
        if (this._followTimer) {
            GLib.source_remove(this._followTimer);
            this._followTimer = 0;
        }
        this._snapMaybe();
        this._lastMoveAt = Date.now();
        this._playSound('Ya2.mp3');
        this._easeScale(1, 220, Clutter.AnimationMode.EASE_OUT_BACK);
        if (!moved)
            this._showBalanceFlavor();
    }

    _snapMaybe() {
        try {
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const wx = this._whale.get_x();
            if (wx - wa.x < SNAP_DIST) {
                this._setMirror(-1);
                this._whale.ease({x: wa.x, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            } else if (wa.x + wa.width - (wx + nw) < SNAP_DIST) {
                this._setMirror(1);
                this._whale.ease({x: wa.x + wa.width - nw, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        } catch (e) { /* 忽略 */ }
    }

    _onScroll(a, ev) {
        let up = null;
        try {
            const d = ev.get_scroll_direction();
            if (d === Clutter.ScrollDirection.UP)
                up = true;
            else if (d === Clutter.ScrollDirection.DOWN)
                up = false;
        } catch (e) { /* 忽略 */ }
        if (up === null) {
            const [, dy] = ev.get_scroll_delta();
            up = dy < 0;
        }
        if (up === null)
            up = false;
        const step = up ? 0.08 : -0.08;
        this._whaleScale = Math.max(0.5, Math.min(2.5, (this._whaleScale || 1) + step));
        this._easeScale(1, 140, Clutter.AnimationMode.EASE_OUT_QUAD);
        return Clutter.EVENT_STOP;
    }

    // ============ 右键菜单 ============
    _zoom(d) {
        this._whaleScale = Math.max(0.5, Math.min(2.5, (this._whaleScale || 1) + d));
        this._easeScale(1, 160, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _goHome() {
        if (this._hold)
            this._endHold();
        const wa = this._workArea();
        const x = wa.x + 24;
        const y = wa.y + wa.height - this._h - 72;
        this._mirror = -1;
        this._img.set_scale(this._mirror, 1);
        this._whale.ease({x, y, duration: 280, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        this._lastMoveAt = Date.now();
    }

    _cyclePeak() {
        const i = PEAK_MODES.indexOf(this._peakMode);
        this._peakMode = PEAK_MODES[(i + 1) % PEAK_MODES.length];
    }

    _menuBtn(label, fn, hint) {
        const b = new St.Button({label: hint ? `${label}   ${hint}` : label, can_focus: false});
        b.style = BTN_STYLE;
        b.connect('enter-event', () => {
            b.style = BTN_HOVER;
        });
        b.connect('leave-event', () => {
            b.style = BTN_STYLE;
        });
        b.connect('clicked', () => {
            this._closeMenu();
            fn();
        });
        return b;
    }

    _openMenu(cx, cy) {
        this._closeMenu();
        const wa = this._workArea();
        const box = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(16,25,45,0.97); border-radius: 14px;' +
                'padding: 6px; spacing: 2px; border: 1px solid rgba(255,255,255,0.12);',
        });
        box.add_child(this._menuBtn('💰 查看余额', () => this._showBalanceFlavor()));
        box.add_child(this._menuBtn('🏠 回到左下角', () => this._goHome()));
        box.add_child(this._menuBtn('🔍 放大', () => this._zoom(0.15)));
        box.add_child(this._menuBtn('🔎 缩小', () => this._zoom(-0.15)));
        box.add_child(this._menuBtn('🔊 音效', () => {
            this._soundOn = !this._soundOn;
            this._openMenu(cx, cy);
        }, this._soundOn ? '开' : '关'));
        box.add_child(this._menuBtn('🎙️ 峰谷文案', () => {
            this._cyclePeak();
            this._openMenu(cx, cy);
        }, PEAK_MODE_LABEL[this._peakMode]));
        box.add_child(this._menuBtn('✖ 收起', () => {}));
        Main.uiGroup.add_child(box);
        box.get_preferred_width(-1);
        const [nw] = box.get_preferred_width(-1);
        const [nh] = box.get_preferred_height(-1);
        let x = Math.round(cx - nw - 12);
        let y = Math.round(cy - nh / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - nw, x));
        y = Math.max(wa.y, Math.min(wa.y + wa.height - nh, y));
        box.set_position(x, y);
        this._menu = box;
    }

    _closeMenu() {
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
    }

    // ============ 余额 / 台词 / 气泡 ============
    _showBalanceFlavor() {
        if (!this._apiKey) {
            this._bubble('未配置 DEEPSEEK_API_KEY\n请在 ~/.dsh/.credentials.yaml 填写');
            return;
        }
        this._fetchBalance();
    }

    _fetchBalance() {
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', BALANCE_URL);
        msg.request_headers.append('Authorization', `Bearer ${this._apiKey}`);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                const j = JSON.parse(bytes.get_data());
                const info = j.balance_infos && j.balance_infos[0];
                const total = info ? Number(info.total_balance) : null;
                const cur = (info && info.currency) || 'CNY';
                if (total !== null && isFinite(total)) {
                    const peak = this._isPeak();
                    const arr = Math.random() < 0.6
                        ? (peak ? PEAK_TXT[this._peakMode] : OFF_TXT[this._peakMode])
                        : CUTE_LINES;
                    const flavor = this._pick(arr);
                    this._bubble(`💬 余额 ${cur === 'USD' ? '$' : '¥'} ${total.toFixed(2)}\n${flavor}`);
                } else {
                    this._bubble('余额解析失败，请稍后再试');
                }
            } catch (err) {
                this._bubble(`获取失败：${err}`);
            }
        });
    }

    _bubbleTarget() {
        const wa = this._workArea();
        const w = this._bubW || 200;
        const h = this._bubH || 50;
        const [wx, wy] = this._whale.get_position();
        const [ww] = this._whale.get_size();
        let x = Math.round(wx + ww / 2 - w / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - w, x));
        let y = Math.round(wy - h - 12);
        if (y < wa.y + 4)
            y = wy + this._h + 8;
        y = Math.max(wa.y, Math.min(wa.y + wa.height - h, y));
        return {x, y};
    }

    _bubble(text) {
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bub)
            this._bub.destroy();
        if (this._tail)
            this._tail.destroy();
        const lb = new St.Label({
            text,
            style: 'background-color: #ffffff; color: #203170;' +
                'border-radius: 16px; border: 1px solid rgba(32,49,112,0.15);' +
                'padding: 12px 16px; font-size: 13px; font-weight: 600;' +
                'text-align: center; line-height: 1.4;',
        });
        Main.uiGroup.add_child(lb);
        const [, natW] = lb.get_preferred_width(-1);
        const [, natH] = lb.get_preferred_height(-1);
        this._bubW = Math.max(natW, 120);
        this._bubH = Math.max(natH, 40);
        lb.set_size(this._bubW, this._bubH);
        const [, wy] = this._whale.get_position();
        const pos = this._bubbleTarget();
        lb.set_position(pos.x, pos.y);
        // 尾巴方向：气泡在鲸鱼上方→尾朝下(▼)，在鲸鱼下方→尾朝上(▲)
        this._tailChar = pos.y > wy ? '▲' : '▼';
        const tail = new St.Label({
            text: this._tailChar,
            style: 'color: #ffffff; font-size: 18px; font-weight: 700;',
        });
        Main.uiGroup.add_child(tail);
        this._tail = tail;
        this._placeTail(lb, tail);
        lb.set_pivot_point(0.5, 1);
        lb.set_opacity(0);
        tail.set_opacity(0);
        lb.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        tail.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._bub = lb;
        if (!this._bubTick)
            this._bubTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                if (this._bub) {
                    const t = this._bubbleTarget();
                    if (this._bub.get_x() !== t.x || this._bub.get_y() !== t.y) {
                        this._bub.ease({
                            x: t.x,
                            y: t.y,
                            duration: 80,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                    if (this._tail)
                        this._placeTail(this._bub, this._tail, t);
                    return GLib.SOURCE_CONTINUE;
                }
                this._bubTick = 0;
                return GLib.SOURCE_REMOVE;
            });
        this._bubTimer = setTimeout(() => {
            if (this._bub) {
                this._bub.ease({
                    opacity: 0,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (this._bub)
                            this._bub.destroy();
                        this._bub = null;
                    },
                });
                if (this._tail) {
                    this._tail.ease({
                        opacity: 0,
                        duration: 400,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onComplete: () => {
                            if (this._tail)
                                this._tail.destroy();
                            this._tail = null;
                        },
                    });
                }
            }
        }, 6000);
    }

    // 放置/更新气泡尾巴（跟随气泡目标位置）
    _placeTail(lb, tail, targetPos) {
        const t = targetPos || {x: lb.get_x(), y: lb.get_y()};
        const [, nw] = tail.get_preferred_width(-1);
        const [, nh] = tail.get_preferred_height(-1);
        let tx = Math.round(t.x + this._bubW / 2 - nw / 2);
        let ty;
        if (this._tailChar === '▼')
            ty = Math.round(t.y + this._bubH - nh / 2);   // 尾在气泡下缘(朝鲸鱼)
        else
            ty = Math.round(t.y - nh / 2);                 // 尾在气泡上缘(朝鲸鱼)
        const wa = this._workArea();
        tx = Math.max(wa.x, Math.min(wa.x + wa.width - nw, tx));
        ty = Math.max(wa.y, Math.min(wa.y + wa.height - nh, ty));
        tail.set_position(tx, ty);
    }
}
