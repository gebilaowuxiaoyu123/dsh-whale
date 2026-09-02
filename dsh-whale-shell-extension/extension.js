// DSH Whale Widget —— GNOME Shell 扩展版（Wayland 桌面悬浮小鲸鱼）v14
// 交互：按住鲸鱼 → 跟随鼠标走；松开 → 停靠（短按无移动 = 单击 → 余额+随机台词）
// 吸附：松手时贴近屏幕左/右缘自动吸附并按侧镜像朝向屏幕内；气泡锚定鲸鱼、智能防越界并跟随
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CRED_FILE = `${GLib.get_home_dir()}/.dsh/.credentials.yaml`;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const POS_FILE = `${GLib.get_user_config_dir()}/dshw-pos.json`;
const SNAP_DIST = 70; // 贴边吸附距离(px)

// —— 从 dsh-whale widget.js 移植的文案（精简元气版）——
const PEAK_LINES = [
    '⚡ 高峰时段，注意用量哦',
    '⚡ 现在是高峰计费，先省着点~',
];
const OFF_LINES = [
    '🌙 低谷时段，放心大胆用',
    '🌙 现在是低谷价，很适合跑任务~',
];
const CUTE_LINES = [
    '呜…我的余额呢 (´･_･`)',
    '要…要抱抱吗 (,,•﹏•,,)',
    '摸鱼被我逮到啦！',
    '今天也要一起加油鸭！',
    '你敲代码的样子真帅~',
    'DeepSeek 天下第一！',
    '哼，不许偷看我的小肚子！',
    '已经盯着你很久了哦~',
];

export default class DshWhaleWidget extends Extension {
    enable() {
        this._apiKey = null;
        this._bub = null;
        this._bubTimer = 0;
        this._bubTick = 0;
        this._whaleScale = 1;
        this._mirror = 1;
        this._hold = null;
        this._followTimer = 0;
        this._captureId = 0;
        this._readKey();
        this._buildWhale();
        this._placeInitial();
        // 全局捕获：按下后无论指针移到哪里，松开都能结束跟随
        this._captureId = global.stage.connect('captured-event', (s, ev) => this._onCaptured(ev));
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
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bubTick) {
            GLib.source_remove(this._bubTick);
            this._bubTick = 0;
        }
        if (this._bub)
            this._bub.destroy();
        this._bub = null;
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
        let x = wa.x + wa.width - this._w - 48;
        let y = wa.y + wa.height - this._h - 84;
        try {
            const [ok, data] = GLib.file_get_contents(POS_FILE);
            if (ok) {
                const p = JSON.parse(data.toString());
                if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
                    x = p.x;
                    y = p.y;
                }
            }
        } catch (e) {
            log(`[dsh-whale] pos read failed: ${e}`);
        }
        this._whale.set_position(Math.round(x), Math.round(y));
        // 初始按屏幕左右半区朝向屏幕内
        this._mirror = (x + this._w / 2) < wa.x + wa.width / 2 ? 1 : -1;
        this._img.set_scale(this._mirror, 1);
    }

    _savePos() {
        const [x, y] = this._whale.get_position();
        try {
            GLib.file_set_contents(POS_FILE, JSON.stringify({x, y}));
        } catch (e) {
            log(`[dsh-whale] pos save failed: ${e}`);
        }
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

    // —— 统一缩放/镜像：scale_x = _mirror * whaleScale * mul ——
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

    // ============ 交互：按住跟随 / 松开停 ============
    _onPress(a, ev) {
        if (ev.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        this._hold = {sx: px, sy: py, moved: false};
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
            if (this._whale.get_x() !== rx || this._whale.get_y() !== ry) {
                this._whale.ease({
                    x: rx,
                    y: ry,
                    duration: 110,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            // 跟随中：鼠标在鲸鱼左侧则朝左看鼠标，反之朝右
            const center = rx + nw / 2;
            this._setMirror(mx < center ? -1 : 1);
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
        this._easeScale(1, 220, Clutter.AnimationMode.EASE_OUT_BACK);
        this._savePos();
        if (!moved)
            this._showBalanceFlavor();
    }

    // 松手后贴近左/右缘：吸附边缘并镜像朝向屏幕内
    _snapMaybe() {
        try {
            const wa = this._workArea();
            const nw = Math.round(this._w * this._whaleScale);
            const wx = this._whale.get_x();
            if (wx - wa.x < SNAP_DIST) {
                this._setMirror(1); // 贴左缘 → 朝右(看屏幕内)
                this._whale.ease({x: wa.x, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            } else if (wa.x + wa.width - (wx + nw) < SNAP_DIST) {
                this._setMirror(-1); // 贴右缘 → 朝左(看屏幕内)
                this._whale.ease({x: wa.x + wa.width - nw, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_BACK});
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
                    const flavor = Math.random() < 0.6
                        ? (this._isPeak() ? this._pick(PEAK_LINES) : this._pick(OFF_LINES))
                        : this._pick(CUTE_LINES);
                    this._bubble(`💬 余额 ${cur === 'USD' ? '$' : '¥'} ${total.toFixed(2)}\n${flavor}`);
                } else {
                    this._bubble('余额解析失败，请稍后再试');
                }
            } catch (err) {
                this._bubble(`获取失败：${err}`);
            }
        });
    }

    // —— 气泡：锚定鲸鱼、智能防越界，并跟随鲸鱼移动 ——
    _placeBubble(lb) {
        const wa = this._workArea();
        const w = this._bubW || 200;
        const h = this._bubH || 50;
        const [wx, wy] = this._whale.get_position();
        const [ww] = this._whale.get_size();
        let x = Math.round(wx + ww / 2 - w / 2);
        x = Math.max(wa.x, Math.min(wa.x + wa.width - w, x));
        let y = Math.round(wy - h - 12);
        if (y < wa.y + 4) // 上方放不下 → 放到鲸鱼下方
            y = wy + this._h + 8;
        y = Math.max(wa.y, Math.min(wa.y + wa.height - h, y));
        lb.set_position(x, y);
    }

    _bubble(text) {
        if (this._bubTimer)
            clearTimeout(this._bubTimer);
        if (this._bub)
            this._bub.destroy();
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
        this._placeBubble(lb);
        lb.set_pivot_point(0.5, 1);
        lb.set_opacity(0);
        lb.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._bub = lb;
        if (!this._bubTick)
            this._bubTick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                if (this._bub) {
                    this._placeBubble(this._bub);
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
            }
        }, 6000);
    }
}
