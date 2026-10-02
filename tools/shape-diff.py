#!/usr/bin/env python3
"""对拍页面真实渲染 vs 窗口实际像素，量化「白块」与「被裁内容」。

用法: whitecheck.py /tmp/page.png /tmp/win.png
- page.png: CDP Page.captureScreenshot（页面自己画的，不受 X11 形状影响）
- win.png : xwd -id 抓的窗口实际像素（会被 ShapeBounding 裁切 / 露出空白底色）

指标：
  miss  = 页面有内容、窗口全黑        → 内容被形状裁掉
  white = 页面全黑、窗口接近纯白      → 露出合成器空白底色（白块）
"""
from PIL import Image

import sys

p = Image.open(sys.argv[1]).convert('RGB')
w = Image.open(sys.argv[2]).convert('RGB')
if p.size != w.size:
    p = p.resize(w.size)

pw = p.load()
ww = w.load()
W, H = p.size

miss = []
white = []
for y in range(0, H, 2):
    for x in range(0, W, 2):
        r1, g1, b1 = pw[x, y]
        r2, g2, b2 = ww[x, y]
        page_ink = max(r1, g1, b1) > 12
        win_ink = max(r2, g2, b2) > 12
        if page_ink and not win_ink:
            miss.append((x, y))
        elif win_ink and (r2 >= 230 and g2 >= 230 and b2 >= 230) and max(r1, g1, b1) < 30:
            white.append((x, y))


def report(name, pts):
    # 采样步长 2 → 实际像素数 ×4
    print(f'{name}: {len(pts) * 4} 像素(估算)')
    if not pts:
        return
    xs = [a for a, _ in pts]
    ys = [b for _, b in pts]
    print(f'  包围盒(设备px): x {min(xs)}-{max(xs)}  y {min(ys)}-{max(ys)}')
    print(f'  逻辑坐标(窗口内): x {min(xs)/2:.0f}-{max(xs)/2:.0f}  y {(min(ys)-64)/2:.0f}-{(max(ys)-64)/2:.0f}')


print(f'页面 {p.size} / 窗口 {w.size}')
report('❌ 被形状裁掉的内容', miss)
report('❌ 露出的白块（空白底色）', white)
if not miss and not white:
    print('✅ 两者一致：既没有内容被裁，也没有白块')
