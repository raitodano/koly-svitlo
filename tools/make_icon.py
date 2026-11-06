"""Генерує tools/icon.ico (блискавка на темному квадраті) без сторонніх бібліотек."""
import struct
import zlib
from pathlib import Path

BOLT = [(13, 2), (4, 14), (10, 14), (9, 22), (18, 10), (12, 10)]  # у координатах 24×24
BG = (42, 33, 22, 255)
FG = (245, 165, 36, 255)


def inside(poly, x, y):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def render(size, ss=4):
    radius = size * 0.22
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    x, y = px + (sx + 0.5) / ss, py + (sy + 0.5) / ss
                    # заокруглений квадрат
                    cx = min(max(x, radius), size - radius)
                    cy = min(max(y, radius), size - radius)
                    if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                        continue
                    col = FG if inside(BOLT, x * 24 / size, y * 24 / size) else BG
                    for k in range(4):
                        acc[k] += col[k]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def main():
    sizes = [16, 32, 48, 256]
    pngs = [render(s) for s in sizes]
    out = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for s, png in zip(sizes, pngs):
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    out += b"".join(pngs)
    path = Path(__file__).with_name("icon.ico")
    path.write_bytes(out)
    print(f"{path} ({len(out)} байт)")


if __name__ == "__main__":
    main()
