/**
 * V2 · M2 十二项承重物理验收（docs/V2/01 §6）。
 * 运行：tsx scripts/v2/verify-m2.ts
 */

import { Grid } from '../../src/v2/core/grid';
import { PSI_PER_HPA } from '../../src/v2/physics/qg';
import { TwoLayerQG } from '../../src/v2/physics/qgTwoLayer';
import {
  WaterLedger,
  capeProxy,
  coldPoolStep,
  dragCoefficient,
  ekmanSuction,
  froudeNumber,
  latentHeatingK,
  omegaFromW,
  qVectorFrontogenesis,
  radiationHeating,
  surfaceFlux,
  upperJetForcing,
} from '../../src/v2/physics/m2';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? '✅' : '❌'} ${name} · ${detail}`);
  if (!ok) failed += 1;
}

const n = 128;
const grid = new Grid(640, n);
const size = n * n;

// 6.1 温度/厚度 → 两层斜压 C
{
  const qg = new TwoLayerQG(grid, 30);
  const zero = new Float64Array(size);
  qg.resetFromPressure(zero);
  const dT = new Float64Array(size);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = grid.xKm(i) - 320;
      const y = grid.yKm(j) - 320;
      dT[j * n + i] = 8 * Math.exp(-(x * x + y * y) / (2 * 90 * 90));
    }
  }
  qg.addTemperature(dT);
  let maxC = 0;
  let maxQDiff = 0;
  for (let k = 0; k < size; k += 1) {
    maxC = Math.max(maxC, Math.abs(qg.psi1[k] - qg.psi2[k]));
    maxQDiff = Math.max(maxQDiff, Math.abs(qg.q1[k] - qg.q2[k]));
  }
  check(
    '6.1 温度卡驱动斜压 C',
    maxC > 1e3 && maxQDiff > 1e-8 && !qg.isBarotropic(),
    `max|C|=${maxC.toExponential(2)}，max|q1−q2|=${maxQDiff.toExponential(2)}`,
  );
  // 反演后仍保持斜压结构。
  qg.invert();
  let maxAfter = 0;
  for (let k = 0; k < size; k += 1) maxAfter = Math.max(maxAfter, Math.abs(qg.psi1[k] - qg.psi2[k]));
  check('6.1 斜压模可反演', maxAfter > 1e3, `max|C| after invert=${maxAfter.toExponential(2)}`);
}

// 6.3 凝结潜热：1 g/kg 凝结约释放 2.49 K
{
  const heat = latentHeatingK(1);
  check('6.3 凝结潜热', Math.abs(heat - 2.49) < 0.03, `1 g/kg → ${heat.toFixed(3)} K`);
}

// 6.5 Ekman 抽吸
{
  const u = new Float64Array(size);
  const v = new Float64Array(size).fill(0);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      // 有侧向切变，τ 的旋度才非零。
      u[j * n + i] = 8 + 0.08 * (grid.yKm(j) - 320);
    }
  }
  const sea = new Float64Array(size).fill(1e-4);
  const city = new Float64Array(size).fill(1.0);
  const wSea = ekmanSuction(u, v, sea, grid, 30);
  const wCity = ekmanSuction(u, v, city, grid, 30);
  let maxSea = 0;
  let maxCity = 0;
  for (let k = 0; k < size; k += 1) {
    maxSea = Math.max(maxSea, Math.abs(wSea[k]));
    maxCity = Math.max(maxCity, Math.abs(wCity[k]));
  }
  check(
    '6.5 Ekman 抽吸（城市 > 海面）',
    maxCity > maxSea * 1.2 && maxCity > 0.005,
    `海 ${maxSea.toFixed(2)} cm/s，城市 ${maxCity.toFixed(2)} cm/s，Cd=${dragCoefficient(1).toExponential(2)}`,
  );
}

// 6.10 高空急流入口/出口
{
  const u = new Float64Array(size);
  const v = new Float64Array(size);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      u[j * n + i] = 20 * Math.tanh((i - 64) / 12);
    }
  }
  const w = upperJetForcing(u, v, grid, 30);
  let max = 0;
  for (const value of w) max = Math.max(max, Math.abs(value));
  check('6.10 高空强迫（急流入口/出口）', max > 0.05, `max|w_low|=${max.toFixed(2)} cm/s`);
}

// 6.8 冷池
{
  const cold = coldPoolStep(25, 8, 0.05);
  check(
    '6.8 冷池（冷却 + 阵风锋）',
    cold.coolingKPerH > 0 && cold.gustSpeed > 0 && cold.liftCmS > 0,
    `冷却 ${cold.coolingKPerH.toFixed(3)} K/h，阵风 ${cold.gustSpeed.toFixed(2)} m/s，抬升 ${cold.liftCmS.toFixed(1)} cm/s`,
  );
}

// 6.12 辐射日变化
{
  const noon = radiationHeating(22, 0.2, 12, true, 0.2, 30);
  const night = radiationHeating(22, 0.2, 0, true, 0.2, 30);
  check('6.12 辐射日变化（白天 > 夜间）', noon > night, `12h=${noon.toFixed(2)} K/h，0h=${night.toFixed(2)} K/h`);
}

// 6.4 地表通量
{
  const ocean = surfaceFlux(8, 24, 8, 28, false, 0, 1);
  const land = surfaceFlux(8, 24, 8, 30, true, 0.1, 1);
  check(
    '6.4 地表通量（海面蒸发 > 陆地）',
    ocean.evaporation > land.evaporation,
    `海 ${ocean.evaporation.toFixed(3)}，陆 ${land.evaporation.toFixed(3)} g/kg/h`,
  );
}

// 6.6 地形 Fr / 阻挡
{
  const blocked = froudeNumber(5, 0.01, 1200);
  const over = froudeNumber(20, 0.01, 800);
  check('6.6 Froude 数（绕流/翻越）', blocked < 1 && over > 1, `Fr 山地=${blocked.toFixed(2)}，强风=${over.toFixed(2)}`);
}

// 6.7 Q 矢量锋生
{
  const theta = new Float64Array(size);
  const u = new Float64Array(size);
  const v = new Float64Array(size);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = grid.xKm(i) - 320;
      const y = grid.yKm(j) - 320;
      theta[j * n + i] = 0.1 * (x / 1); // 10 K/100 km = 1e-4 K/m
      u[j * n + i] = 0.1 * x; // 纯变形场：∂u/∂x = 1e-4 s⁻¹
      v[j * n + i] = -0.1 * y;
    }
  }
  const f = qVectorFrontogenesis(theta, u, v, grid);
  check('6.7 Q 矢量锋生', f > 1e-5, `max F=${f.toExponential(2)} K/10km/h`);
}

// 6.8 CAPE 代理
{
  const warmWet = capeProxy(8, 16, 0);
  const coldDry = capeProxy(-2, 3, 0);
  check('6.8 CAPE（暖湿 > 冷干）', warmWet > coldDry, `暖湿 ${warmWet.toFixed(0)} J/kg，冷干 ${coldDry.toFixed(0)} J/kg`);
}

// 6.11 水汽四栏账本
{
  const q = new Float64Array([10, 20, 30]);
  const cloud = new Float64Array([2, 4, 6]);
  const ledger = new WaterLedger();
  ledger.reset(q, cloud);
  ledger.addEvaporation(5);
  ledger.addRain(8);
  q[0] = 10 - 8 + 5; // 降水移除 8，蒸发补回 5
  ledger.update(q, cloud);
  check(
    '6.11 水汽账本闭合',
    ledger.start === 72 && ledger.closure() <= 0.02,
    `start=${ledger.start}，evap=${ledger.evaporated}，rain=${ledger.rained}，end=${ledger.end}，闭合=${(ledger.closure() * 100).toFixed(2)}%`,
  );
}

// ω 方程诊断
{
  const up = omegaFromW(20);
  const down = omegaFromW(-10);
  check('ω 方程（上升为负）', up < 0 && down > 0, `w=20cm/s → ω=${up.toFixed(2)} Pa/s；w=-10 → ${down.toFixed(2)} Pa/s`);
}

// beta 项（6.9）：检查 q 中包含 βy
{
  const qg = new TwoLayerQG(grid, 30);
  const zero = new Float64Array(size);
  qg.resetFromPressure(zero);
  let vary = 0;
  for (let j = 0; j < n; j += 2) {
    vary = Math.max(vary, Math.abs(qg.q1[j * n + 64] - qg.q1[64 * n + 64]));
  }
  check('6.9 beta 项', vary > 1e-8, `max Δq(βy)=${vary.toExponential(2)}`);
}

// 6.2 位涡反演一致性：C 存在时压力不为零
{
  const p = new Float64Array(size);
  p.fill(0);
  p[64 * n + 64] = -10; // 单个格点近似
  const qg = new TwoLayerQG(grid, 30);
  qg.resetFromPressure(p);
  let psiMax = 0;
  for (const value of qg.psi1) psiMax = Math.max(psiMax, Math.abs(value));
  check('6.2 位涡初始化', psiMax > 1e4 * PSI_PER_HPA / 1e5, `max|ψ|=${psiMax.toExponential(2)}`);
}

console.log(failed === 0 ? '\nM2 承重物理（含潜热/ω）验收全部通过。' : `\n${failed} 项未通过。`);
if (failed > 0) process.exit(1);
