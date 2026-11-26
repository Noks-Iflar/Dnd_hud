"""Режет листы Gemini на отдельные PNG для HUD Хвора.

Запуск: python3 -I cut.py <папка_с_листами> <папка_вывода>
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def load(name):
    return np.asarray(Image.open(os.path.join(SRC, name)).convert("RGB")).astype(np.float32)


def fg_mask(a, bg):
    return a.min(axis=2) < 225 if bg == "white" else a.max(axis=2) > 28


def find_boxes(mask, min_frac=0.002, merge=14):
    m = ndi.binary_opening(mask, iterations=2)
    md = ndi.binary_dilation(m, iterations=merge)
    lab, _ = ndi.label(md)
    H, W = mask.shape
    res = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if (lab[sl] == i).sum() < min_frac * H * W:
            continue
        sub = m[sl]
        ys = np.where(sub.any(1))[0]
        xs = np.where(sub.any(0))[0]
        y0, x0 = sl[0].start, sl[1].start
        res.append((y0 + ys[0], y0 + ys[-1] + 1, x0 + xs[0], x0 + xs[-1] + 1))
    return res


def reading_order(boxes, tol):
    boxes = sorted(boxes, key=lambda b: (b[0] + b[1]) / 2)
    rows = []
    for b in boxes:
        cy = (b[0] + b[1]) / 2
        if rows and abs(cy - rows[-1][0]) < tol:
            rows[-1][1].append(b)
        else:
            rows.append([cy, [b]])
    out = []
    for _, r in rows:
        out += sorted(r, key=lambda b: b[2])
    return out


def crop(a, b, pad):
    H, W = a.shape[:2]
    y0, y1, x0, x1 = b
    return a[max(0, y0 - pad):min(H, y1 + pad), max(0, x0 - pad):min(W, x1 + pad)].copy()


def cut_white(a, holes):
    """Убирает белый фон (и, если holes, крупные белые «дыры» внутри рамок) с мягким краем."""
    near = a.min(axis=2) > 225
    lab, n = ndi.label(near)
    H, W = near.shape
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, edge[edge > 0])
    if holes and n:
        sizes = ndi.sum(near, lab, range(1, n + 1))
        big = [i + 1 for i, s in enumerate(sizes) if s > 0.008 * H * W]
        bg |= np.isin(lab, big)
    band = ndi.binary_dilation(bg, iterations=3) & ~bg
    alpha = np.ones((H, W), np.float32)
    alpha[bg] = 0
    soft = np.clip((255 - a.min(axis=2)) / (255 - 60.0), 0, 1)
    alpha[band] = soft[band]
    am = np.maximum(alpha, 1e-3)[..., None]
    un = np.clip((a - (1 - am) * 255) / am, 0, 255)
    rgb = np.where(band[..., None], un, a)
    return rgb, alpha


def cut_black(a):
    near = a.max(axis=2) < 22
    lab, _ = ndi.label(near)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, edge[edge > 0])
    band = ndi.binary_dilation(bg, iterations=4) & ~bg
    H, W = near.shape
    alpha = np.ones((H, W), np.float32)
    alpha[bg] = 0
    soft = np.clip(a.max(axis=2) / 90.0, 0, 1)
    alpha[band] = soft[band]
    am = np.maximum(alpha, 1e-3)[..., None]
    rgb = np.where(band[..., None], np.clip(a / am, 0, 255), a)
    return rgb, alpha


def circle(a, b):
    y0, y1, x0, x1 = b
    cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
    r = min(y1 - y0, x1 - x0) / 2
    s = int(np.ceil(r))
    sub = a[int(cy) - s:int(cy) + s, int(cx) - s:int(cx) + s].copy()
    yy, xx = np.mgrid[0:sub.shape[0], 0:sub.shape[1]]
    d = np.hypot(yy + 0.5 - sub.shape[0] / 2, xx + 0.5 - sub.shape[1] / 2)
    alpha = np.clip(r - 1 - d + 0.5, 0, 1).astype(np.float32)
    return sub, alpha


def save(rgb, alpha, name, longest):
    arr = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    im = Image.fromarray(arr, "RGBA").convert("RGBa")
    w, h = im.size
    k = longest / max(w, h)
    im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS).convert("RGBA")
    im.save(os.path.join(OUT, name + ".png"), optimize=True)
    return im


made = {}


def sheet(file, bg, names, tol, pad, longest, mode, merge=14):
    a = load(file)
    boxes = reading_order(find_boxes(fg_mask(a, bg), merge=merge), tol)
    if len(boxes) != len(names):
        raise SystemExit(f"{file}: найдено {len(boxes)} элементов, ожидалось {len(names)}")
    for b, name in zip(boxes, names):
        if mode == "circle":
            rgb, al = circle(a, b)
        elif mode == "black":
            rgb, al = cut_black(crop(a, b, pad))
        else:
            rgb, al = cut_white(crop(a, b, pad), holes=(mode == "white-holes"))
        size = longest[name] if isinstance(longest, dict) else longest
        made[name] = save(rgb, al, name, size)
    print(f"{file}: {len(boxes)} шт.")


# 1. Сферы
sheet("sheet-orbs.jpg", "black", ["orb-empty", "orb-blood", "orb-blood-khvor"], 300, 0, 512, "circle")
# 2. Круглые рамки и щит
sheet("sheet-frames.png", "white", ["orb-frame", "portrait-frame", "ac-shield"], 300, 6, 512, "white-holes")
# 3. Камни
sheet("sheet-gems.jpg", "black", ["gem-slot", "gem-pact", "gem-action", "gem-bonus", "gem-reaction"], 300, 24, 128, "black")
# 4. Иконки
sheet("sheet-icons-ui.jpg", "white",
      ["icon-initiative", "icon-skills", "icon-short-rest", "icon-long-rest", "icon-inventory",
       "icon-sheet", "icon-spellbook", "icon-journal", "icon-end-turn"], 200, 2, 128, "white")
sheet("sheet-icons-actions.jpg", "white",
      ["icon-dash", "icon-disengage", "icon-dodge", "icon-help", "icon-hide", "icon-ready",
       "icon-loot", "icon-statblock", "icon-targets", "icon-effects", "status-khvor",
       "status-concentration"], 200, 2, 128, "white")
# Перегенерированная иконка Хвора заменяет вариант с листа
if os.path.exists(os.path.join(SRC, "sheet-status-khvor.jpg")):
    sheet("sheet-status-khvor.jpg", "white", ["status-khvor"], 200, 2, 128, "white")

# 5. Панель, ячейка, карточка, гнездо (панель — с отдельным гребнем)
a = load("sheet-panel.jpg")
boxes = reading_order(find_boxes(fg_mask(a, "white")), 300)
assert len(boxes) == 4, len(boxes)
panel_box, others = boxes[0], boxes[1:]
for b, name, size in zip(others, ["slot-frame", "initiative-frame", "gem-socket-empty"], [256, 320, 128]):
    rgb, al = cut_white(crop(a, b, 6), holes=True)
    made[name] = save(rgb, al, name, size)

rgb, al = cut_white(crop(a, panel_box, 6), holes=False)
H, W = al.shape
tops = np.array([np.argmax(al[:, x] > 0.5) if (al[:, x] > 0.5).any() else H for x in range(W)])
border_top = int(np.median(tops))
crest_cols = np.where(tops < border_top - 3)[0]
cx0, cx1 = crest_cols.min() - 6, crest_cols.max() + 7
cy0 = int(tops[crest_cols].min())
cy1 = border_top + (border_top - cy0) + 12
k = 1536 / W
made["panel-crest"] = save(rgb[cy0:cy1, cx0:cx1], al[cy0:cy1, cx0:cx1], "panel-crest",
                           round(max(cy1 - cy0, cx1 - cx0) * k))
shift = (cx1 - cx0) + 60
rgb[cy0:cy1, cx0:cx1] = rgb[cy0:cy1, cx0 - shift:cx1 - shift]
al[cy0:cy1, cx0:cx1] = al[cy0:cy1, cx0 - shift:cx1 - shift]
top = border_top
made["panel-frame"] = save(rgb[top:], al[top:], "panel-frame", 1536)
print(f"sheet-panel.jpg: 4 шт. + гребень; панель {made['panel-frame'].size}, гребень {made['panel-crest'].size}")

import json
manifest = {
    "panel-frame": {"size": made["panel-frame"].size, "slice": 64,
                    "note": "9-slice: border-image-slice 64 fill"},
    "panel-crest": {"size": made["panel-crest"].size,
                    "offsetTop": round((cy0 - border_top) * k),
                    "note": "по центру панели по горизонтали; offsetTop — от верхнего края panel-frame"},
}
with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

# Превью
names = list(made)
cell, cols = 170, 7
rows = (len(names) + cols - 1) // cols
prev = Image.new("RGBA", (cols * cell, rows * (cell + 26)), (22, 20, 26, 255))
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf", 13)
d = ImageDraw.Draw(prev)
for i, n in enumerate(names):
    im = made[n].copy()
    im.thumbnail((cell - 20, cell - 20))
    x, y = (i % cols) * cell, (i // cols) * (cell + 26)
    d.rectangle([x + 4, y + 4, x + cell - 4, y + cell - 4], fill=(70, 60, 50, 255))
    prev.alpha_composite(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
    d.text((x + 6, y + cell + 2), n, fill=(220, 214, 230, 255), font=font)
prev.save(os.path.join(os.path.dirname(OUT.rstrip("/")), "preview.png"))
print("всего файлов:", len(made))
