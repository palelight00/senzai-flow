#!/usr/bin/env python3
"""アプリアイコンPNGを生成する（外部依存なし・zlibのみ）。
   teal の正方形に、白い「記録カード＋3本線」を描いたシンプルなログアイコン。
   実行: python3 tools/make_icons.py
"""
import struct
import zlib
import os

TEAL = (10, 124, 134)
WHITE = (248, 250, 250)

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")


def make_png(size, path):
    px = bytearray(size * size * 4)

    def setp(x, y, rgb, a=255):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            px[i], px[i + 1], px[i + 2], px[i + 3] = rgb[0], rgb[1], rgb[2], a

    # 背景: teal で全面塗り（iOS が角丸マスクするので full-bleed）
    for y in range(size):
        for x in range(size):
            setp(x, y, TEAL)

    def rounded_rect(x0, y0, x1, y1, r, rgb):
        for y in range(y0, y1):
            for x in range(x0, x1):
                # 角丸判定
                cx = min(max(x, x0 + r), x1 - 1 - r)
                cy = min(max(y, y0 + r), y1 - 1 - r)
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                    setp(x, y, rgb)

    s = size
    # 白いカード
    cx0, cy0 = int(s * 0.22), int(s * 0.18)
    cx1, cy1 = int(s * 0.78), int(s * 0.82)
    rounded_rect(cx0, cy0, cx1, cy1, int(s * 0.06), WHITE)

    # カード上部のタブ（クリップボード風）
    tabw = int(s * 0.20)
    tx0 = (s - tabw) // 2
    rounded_rect(tx0, int(s * 0.12), tx0 + tabw, int(s * 0.21), int(s * 0.03), WHITE)

    # 3本の teal ライン（記録の行）
    line_h = int(s * 0.045)
    gap = int(s * 0.115)
    lx0 = int(s * 0.30)
    lx1 = int(s * 0.70)
    start_y = int(s * 0.34)
    for k in range(3):
        ly0 = start_y + k * gap
        # 行頭の四角（チェック風）
        rounded_rect(int(s * 0.27), ly0, int(s * 0.27) + line_h, ly0 + line_h, int(s * 0.012), TEAL)
        # 行の線
        rounded_rect(lx0 + line_h, ly0 + line_h // 4, lx1, ly0 + line_h - line_h // 4,
                     int(s * 0.012), TEAL)

    _write_png(path, size, size, px)
    print("wrote", path)


def _write_png(path, w, h, rgba):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0
        raw.extend(rgba[y * w * 4:(y + 1) * w * 4])

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    make_png(192, os.path.join(OUT_DIR, "icon-192.png"))
    make_png(512, os.path.join(OUT_DIR, "icon-512.png"))
    make_png(180, os.path.join(OUT_DIR, "apple-touch-icon.png"))
