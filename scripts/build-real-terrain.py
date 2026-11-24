import base64
import io
import json
import math
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ZOOM = 9
SIZE = 512
CASES = {
    "taiwan": {"west": 119.5, "east": 122.0, "south": 21.9, "north": 25.3},
    "songxian": {"west": 111.2, "east": 112.4, "south": 33.5, "north": 34.5},
    "lingui": {"west": 109.9, "east": 110.6, "south": 24.9, "north": 25.6},
    "golmud": {"west": 93.0, "east": 96.0, "south": 35.0, "north": 37.0},
    "zhengzhou": {"west": 110.5, "east": 115.0, "south": 32.5, "north": 36.5},
}


def lonlat_to_pixel(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n * 256
    lat_rad = math.radians(max(-85.0511, min(85.0511, lat)))
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n * 256
    return x, y


def tile_url(z, x, y):
    return f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def load_tile(z, x, y):
    cache = Path("scripts/terrain-tiles")
    cache.mkdir(exist_ok=True)
    path = cache / f"{z}-{x}-{y}.png"
    if path.exists():
        return Image.open(path).convert("RGB")
    last_error = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(tile_url(z, x, y), timeout=90) as response:
                payload = response.read()
            path.write_bytes(payload)
            return Image.open(io.BytesIO(payload)).convert("RGB")
        except Exception as error:
            last_error = error
            time.sleep(2 + attempt * 2)
    raise last_error


def decode_terrarium(image):
    arr = np.asarray(image.convert("RGB"), dtype=np.float32)
    return arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0


results = {}
for name, box in CASES.items():
    x0, y0 = lonlat_to_pixel(box["west"], box["north"], ZOOM)
    x1, y1 = lonlat_to_pixel(box["east"], box["south"], ZOOM)
    tx0, ty0 = int(x0 // 256), int(y0 // 256)
    tx1, ty1 = int(x1 // 256), int(y1 // 256)
    tiles = {}
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tiles[(tx, ty)] = load_tile(ZOOM, tx, ty)
    stitched = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for (tx, ty), tile in tiles.items():
        stitched.paste(tile, ((tx - tx0) * 256, (ty - ty0) * 256))
    left = int(round(x0 - tx0 * 256))
    top = int(round(y0 - ty0 * 256))
    right = int(round(x1 - tx0 * 256))
    bottom = int(round(y1 - ty0 * 256))
    cropped = stitched.crop((left, top, right, bottom)).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    heights = decode_terrarium(cropped)
    flat = [int(value) for value in heights.reshape(-1)]
    data = base64.b64encode(
        b"".join(int(value).to_bytes(2, "little", signed=True) for value in flat)
    ).decode("ascii")
    results[name] = {
        **box,
        "n": SIZE,
        "tileZoom": ZOOM,
        "tileRange": [tx0, ty0, tx1, ty1],
        "data": data,
    }
    print(name, box, results[name]["tileRange"])

Path("scripts/real-terrain.json").write_text(json.dumps(results), encoding="utf-8")
print("written scripts/real-terrain.json")
