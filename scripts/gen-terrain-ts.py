import json
import math

data = json.load(open("scripts/real-terrain.json", encoding="utf-8"))
lines = [
    "// Generated from public Terrarium DEM tiles (zoom 9), resampled to 96x96.",
    "// Approximate case topography; not a survey-grade DEM.",
    "export interface RealTerrainData {",
    "  west: number;",
    "  east: number;",
    "  south: number;",
    "  north: number;",
    "  n: number;",
    "  widthKm: number;",
    "  heightKm: number;",
    "  data: string;",
    "}",
    "",
    "export const REAL_TERRAIN: Record<string, RealTerrainData> = {",
]
for key, value in data.items():
    lat = (value["south"] + value["north"]) / 2
    width = (value["east"] - value["west"]) * 111.32 * math.cos(math.radians(lat))
    height = (value["north"] - value["south"]) * 110.57
    lines.append(f"  {key}: {{")
    lines.append(
        f"    west: {value['west']}, east: {value['east']}, south: {value['south']}, north: {value['north']},"
    )
    lines.append(f"    n: {value['n']}, widthKm: {width:.1f}, heightKm: {height:.1f},")
    lines.append(f"    data: '{value['data']}',")
    lines.append("  },")
lines.append("};")
open("src/config/realTerrain.ts", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("written")
