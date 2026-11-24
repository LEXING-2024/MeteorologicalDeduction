import { MAP_KM_PER_PX, MAP_SIZE, MESOCYCLONE_VORTICITY, RAIN_SATURATION_FRACTION } from '../config/constants';
import { compassLabelFromToward, verticalContributions } from './field';
import { frontLabel } from './fronts';
import type {
  GoalEvaluation,
  LevelDefinition,
  RunSimulation,
  SimulationSnapshot,
  WeatherCondition,
  WeatherEntity,
} from './types';

export interface ReportEntry {
  label: string;
  text: string;
  tone?: 'good' | 'warn' | 'neutral';
}

export interface ReportStage {
  index: string;
  title: string;
  en: string;
  summary: string;
  entries: ReportEntry[];
}

export interface RunReport {
  stages: ReportStage[];
  verdict: string;
  detail: string;
  recommendation: string;
}

function findEntity(entities: WeatherEntity[], id?: string): WeatherEntity | undefined {
  return id ? entities.find((entity) => entity.id === id) : undefined;
}

function pressureRange(snapshot: SimulationSnapshot): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of snapshot.grid.pLow) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function targetConditions(level: LevelDefinition): WeatherCondition[] {
  const target = level.target;
  if (target.kind === 'multi' || target.kind === 'persistent' || target.kind === 'persistentRain' || target.kind === 'accumulatedRain' || target.kind === 'sequence' || target.kind === 'window') {
    return target.conditions;
  }
  if (target.kind === 'hourWindow') {
    return target.minQ === undefined
      ? []
      : [{ kind: 'moisture', cityId: target.cityId, minQ: target.minQ }];
  }
  return [target];
}

function recommendationFor(level: LevelDefinition): string {
  return level.hint;
}

/**
 * What to change next, derived from the condition that actually failed.
 *
 * Before this, 66 of the 72 levels fell back to `level.hint`, which is the
 * answer key: the one place that should teach ("you are short on lift, not on
 * moisture") instead repeated the solution.  The copy here is keyed by the
 * condition kind, so it stays correct for every level that uses that check.
 */
const REMEDY: Partial<Record<WeatherCondition['kind'], string>> = {
  vertical: '把 L 的影响圈完整覆盖城市；仍然不够就换更深的一档，或用高空槽补高层抬升。',
  highVertical: '检查系统的浅薄/深厚：冷高压只压低层，暖高压才压得住高层。',
  moisture: '把水汽中心放到城市上风侧、影响圈覆盖城市；单张上限 +40，必要时叠第二张。',
  rain: '先看城市有没有净上升（W>0），再看 Q 是否越过凝结阈值，最后才加水汽或锋面强度。',
  clear: '把 H 的中心压到城市上，或提高一档强度；下沉必须压过现有的抬升。',
  temperature: '换更大一档的冷/暖气团；两张同极气团落在同一点会合并，不会更冷或更热。',
  front: '冷、暖气团要分居城市两侧，再用 H/L 让风穿过温度梯度；只叠在一起不构成锋面。',
  wind: '拉大 H 与 L 的气压差，或把两者放在城市两侧，风才会沿着你希望的方向穿过城市。',
  advect: '风沿等压线绕低压：调整 H/L 的位置，让低层风把水汽推向目标城市。',
  shear: '把冷、暖气团或 H/L 分置城市两侧，让相邻风矢的方向差拉开。',
  dryline: '把干、湿气团做成一条边界并让城市落在边界上；干湿对比不足时干线抬升不触发。',
  hazard: '高影响天气是 W、水汽、层结与地形的合成结果：先满足 W，再检查温度层结是否支持该现象。',
  rotation: '让冷、暖气团分居城市两侧并把低压中心压在城上，闭合旋转才起得来。',
  stability: '层结卡的上冷下暖制造不稳定，上暖下冷制造稳定；按目标选择对应模式。',
  typhoon: '暖低压要在 ≥26.5℃ 的海面连续降水两回合才会升级；登陆或进入冷水会逐回合减弱。',
  pressure: '调整 H/L 的强度与距离，让城市落在目标气压区间内。',
  pressureTendency: '两回合之间改变气压场（换更强的 H/L 或移动中心），单回合摆好不会产生变压。',
  temperatureChange: '先跑一回合暖场，再换上强冷空气，两回合之差才是降温幅度。',
  windShift: '把气压中心从城市一侧搬到另一侧，风向才会真的反转。',
  visibility: '能见度由降水、雾、沙尘与冰雹共同决定，先确认目标现象已经出现。',
  airMass: '气团的冷热由温度旋钮决定、干湿由水汽旋钮决定，θe 落在目标象限才算该气团。',
  dry: '干雷暴要求有上升但不落地降水：减少水汽供给，或降低抬升强度。',
};

function genericDiagnosis(_level: LevelDefinition, evaluation: GoalEvaluation): string {
  const failed = (evaluation.conditionResults ?? []).filter((item) => !item.passed);
  if (failed.length === 0) return '';
  const parts = failed.slice(0, 2).map((item) => {
    const remedy = REMEDY[item.condition.kind] ?? '';
    return `${item.label}：当前 ${item.actual}，目标 ${item.target}。${remedy}`;
  });
  if (failed.length > 2) parts.push(`另有 ${failed.length - 2} 项未达成。`);
  return parts.join(' ');
}

/**
 * The moisture budget is settled after the round is sampled, so a wet card can
 * shrink between pressing "run" and reading the panel.  Without a line saying
 * so, that looks like a bug — it is the cost of the rain that just fell.
 */
function moistureBudgetEntries(simulation: RunSimulation): ReportEntry[] {
  const before = new Map(simulation.before.entities.map((entity) => [entity.id, entity]));
  const entries: ReportEntry[] = [];
  for (const entity of simulation.after.entities) {
    const previous = before.get(entity.id);
    if (!previous) continue;
    const delta = entity.strength - previous.strength;
    if (Math.abs(delta) < 0.05) continue;
    const isWet = entity.type === 'wet';
    entries.push({
      label: isWet ? '水汽收支' : '潜热反馈',
      text: isWet
        ? `${previous.strength.toFixed(1)} → <b>${entity.strength.toFixed(1)}</b> g/m³（本回合降水消耗 ${Math.abs(delta).toFixed(1)}，下一回合按此值起算）。`
        : `${previous.strength.toFixed(1)} → <b>${entity.strength.toFixed(1)}</b> hPa（凝结潜热使低压加深 ${Math.abs(delta).toFixed(1)}）。`,
      tone: delta > 0 ? 'good' : 'neutral',
    });
  }
  return entries.slice(0, 3);
}

export function buildReport(
  level: LevelDefinition,
  simulation: RunSimulation,
  evaluation: GoalEvaluation,
): RunReport {
  const conditions = targetConditions(level);
  const weatherCondition = conditions.find((item) => item.kind !== 'advect') ?? conditions[0];
  const cityId =
    (weatherCondition && 'cityId' in weatherCondition && weatherCondition.cityId) ||
    level.cities[0]?.id ||
    'A';
  const city = level.cities.find((item) => item.id === cityId) ?? level.cities[0];
  // The mesocyclone threshold is data, not a magic number.  It used to be
  // printed as 40 while the physics and level targets use 4 (10x mismatch),
  // teaching the player a threshold the game never applies.
  const vorticityTarget =
    conditions.find((item) => item.kind === 'rotation' && item.cityId === city.id)?.minVorticity ??
    MESOCYCLONE_VORTICITY;
  const weather = simulation.after.cities[city.id];
  const beforeWeather = simulation.before.cities[city.id];
  const pressure = pressureRange(simulation.after);
  const advectCondition = conditions.find((item) => item.kind === 'advect');
  const targetWet = advectCondition
    ? findEntity(simulation.after.entities, advectCondition.entityId)
    : undefined;
  const targetWetBefore = advectCondition
    ? findEntity(simulation.before.entities, advectCondition.entityId)
    : undefined;
  const sourceMotion = targetWet
    ? simulation.motions.find((motion) => motion.entityId === targetWet.id)
    : simulation.motions[0];

  const wind = weather.wind;
  const windHigh = weather.windHigh;
  const wetDistanceKm = sourceMotion ? sourceMotion.distance : 0;
  const wetDirection = sourceMotion ? compassLabelToward(sourceMotion.wind.towardDeg) : '无';
  const contributions = verticalContributions(simulation.after.entities, city.x, city.y);
  const contributionText =
    contributions.length > 0
      ? contributions
          .slice(0, 3)
          .map((item) => {
            const isLow = item.entity.type === 'coldLow' || item.entity.type === 'warmLow';
            const label = `${item.entity.type === 'coldHigh' ? '冷高压' : item.entity.type === 'warmHigh' ? '暖高压' : isLow ? '低压' : '系统'}`;
            return `${label} 低层${item.value >= 0 ? '+' : ''}${item.value.toFixed(2)} / 高层${item.highValue >= 0 ? '+' : ''}${item.highValue.toFixed(2)}`;
          })
          .join('　')
      : '无地面气压系统影响该城';
  const upperAirEntities = simulation.after.entities.filter(
    (entity) => entity.type === 'trough' || entity.type === 'inversion' || entity.type === 'jet',
  );
  const upperAirText = upperAirEntities.length
    ? upperAirEntities
        .map((entity) => {
          const meta = entity.type === 'trough' ? '高空槽' : entity.type === 'inversion' ? '层结' : '急流';
          const mode = entity.type === 'inversion' ? (entity.inversionMode === 'stable' ? '上暖下冷' : '上冷下暖') : '';
          return `${meta}${mode ? ` ${mode}` : ''}`;
        })
        .join(' · ')
    : '无高空环境系统';
  const frontText =
    weather.frontType === 'none'
      ? ''
      : `${frontLabel(weather.frontType)}抬升 +${weather.frontLift.toFixed(2)}`;

  const qSat = weather.qSat;
  const condensationThreshold = qSat * RAIN_SATURATION_FRACTION;
  const qDeficit = weather.Q - condensationThreshold;

  const targetEntries: ReportEntry[] = (evaluation.conditionResults ?? []).map((item) => ({
    label: item.label,
    text: `${item.actual} / ${item.target}`,
    tone: item.passed ? 'good' : 'warn',
  }));

  const stages: ReportStage[] = [
    {
      index: '01',
      title: '风场',
      en: 'WIND',
      summary:
        wetDistanceKm > 1
          ? `低层风与高空引导叠加，水汽向${wetDirection}移动 ${wetDistanceKm.toFixed(0)} km。`
          : wind.speed > 0.3
            ? `${city.name}出现 ${wind.fromLabel}风，但水汽源没有明显位移。`
            : '气压场接近静止，风矢量微弱。',
      entries: [
        {
          label: '半球',
          text: `${level.base.hemisphere === 'N' ? '北纬' : '南纬'} ${level.base.latitude}° · ${level.base.hemisphere === 'N' ? '北半球右偏' : '南半球左偏'}。`,
        },
        {
          label: '低层气压',
          text:
            pressure.max - pressure.min > 0.2
              ? `低层 P 范围 <b>${pressure.min.toFixed(1)}–${pressure.max.toFixed(1)}</b> hPa，等压线间隔 2 hPa（每 4 hPa 标注）。`
              : '低层场中尚无显著气压差。',
        },
        {
          label: '高层 P 距平',
          text: `高层 P 距平 <b>${weather.pHigh >= 0 ? '+' : ''}${weather.pHigh.toFixed(1)}</b> hPa；${level.base.hemisphere === 'N' ? '北半球' : '南半球'}高层风 ${windHigh.speed.toFixed(1)} m/s。`,
        },
        {
          label: '低层风',
          text: `${city.name} <b>${wind.speed.toFixed(1)} m/s</b>（${wind.beaufort} 级），来向 ${wind.fromLabel}；陆面摩擦后风速已折减。`,
          tone: wind.speed > 0.5 ? 'good' : 'neutral',
        },
        {
          label: '高空环境',
          text: upperAirText,
          tone: upperAirEntities.length > 0 ? 'good' : 'neutral',
        },
        {
          label: '水汽输送',
          text:
            sourceMotion && wetDistanceKm > 0.5
              ? `水汽向<b>${wetDirection}</b>位移 <b>${wetDistanceKm.toFixed(0)} km</b>；风矢量去向 ${sourceMotion.wind.towardDeg.toFixed(0)}°。`
              : targetWetBefore
                ? '水汽仍停留在原处，风场不足以输送。'
                : '场上没有可移动水汽。',
          tone: wetDistanceKm > 5 ? 'good' : 'warn',
        },
      ],
    },
    {
      index: '02',
      title: '上升 / 下沉',
      en: 'VERTICAL',
      summary:
        weather.W > 0.05
          ? `${city.name}低层 W=${weather.wLow.toFixed(2)}、高层 W=${weather.wHigh.toFixed(2)}，综合 W=${weather.W.toFixed(2)}（上升指数）。`
          : weather.W < -0.05
            ? `${city.name}净下沉，综合 W=${weather.W.toFixed(2)}（下沉指数）。`
            : `${city.name}综合垂直运动接近零。`,
      entries: [
        {
          label: '低层 / 高层 W',
          text: `低层 <b>${weather.wLow >= 0 ? '+' : ''}${weather.wLow.toFixed(2)}</b> · 高层 <b>${weather.wHigh >= 0 ? '+' : ''}${weather.wHigh.toFixed(2)}</b> · 综合 <b>${weather.W >= 0 ? '+' : ''}${weather.W.toFixed(2)}</b>（运行前 ${beforeWeather.W >= 0 ? '+' : ''}${beforeWeather.W.toFixed(2)}）。`,
          tone: weather.W > 0.05 ? 'good' : weather.W < -0.05 ? 'warn' : 'neutral',
        },
        { label: '贡献项', text: contributionText },
        {
          label: '气团 / 线特征',
          text: `气团 ${weather.airMass === 'neutral' ? '未定' : weather.airMass}；风向切变 ${weather.shear.toFixed(0)}°；干线强度 ${weather.dryline.toFixed(2)}。`,
        },
        {
          label: '锋面',
          text: frontText || '当前站点没有冷暖气团交叠形成的锋面。',
          tone: frontText ? 'good' : 'neutral',
        },
        {
          label: '云与稳定度',
          text: `云量 ${weather.cloud.toFixed(0)}%，云顶 <b>${weather.cloudTop.toFixed(1)} km</b>；稳定度 ${weather.stability > 0.04 ? '不稳定（上冷下暖）' : weather.stability < -0.04 ? '稳定（上暖下冷）' : '中性'}。`,
        },
        {
          label: '中层与旋转',
          text: `中层 T <b>${weather.midTemperature.toFixed(1)}°C</b>（暖层 >2.5°C 时利于冻雨）；低层涡度 <b>${weather.vorticity.toFixed(0)} ×10⁻⁴ s⁻¹</b>（≥${vorticityTarget} 具备中气旋结构）。`,
          tone: weather.vorticity >= vorticityTarget ? 'good' : 'neutral',
        },
      ],
    },
    {
      index: '03',
      title: '降水',
      en: 'PRECIP',
      summary:
        weather.R > 0.02
          ? `${city.name}出现${
              weather.precipitationType === 'snow'
                ? '降雪'
                : weather.precipitationType === 'hail'
                  ? '冰雹'
                  : weather.precipitationType === 'freezingRain'
                    ? '冻雨'
                    : '降雨'
            }，24 小时等效 ${weather.rain24h.toFixed(1)} mm。`
          : '没有发生有效降水。',
      entries: [
        {
          label: '水汽',
          text: `Q <b>${weather.Q.toFixed(1)}</b> / 凝结阈值 ${condensationThreshold.toFixed(1)} g/m³；露点 ${weather.dewPoint.toFixed(1)}°C。`,
          tone: qDeficit > 0 ? 'good' : 'warn',
        },
        {
          label: '降水率',
          text: `<b>R = ${weather.R.toFixed(2)}</b> mm/3h；24 小时等效 <b>${weather.rain24h.toFixed(1)} mm</b>（${weather.rainGrade}）；能见度 ${weather.visibility.toFixed(1)} km。`,
          tone: weather.R > 0.02 ? 'good' : 'neutral',
        },
        {
          label: '对流判级',
          text: `综合 W=${weather.W.toFixed(1)} → ${weather.convection >= 3 ? '冰雹级' : weather.convection === 2 ? '雷暴级' : weather.convection === 1 ? '暴雨级' : '一般降水/无对流'}。`,
          tone: weather.convection >= 2 ? 'warn' : 'neutral',
        },
        {
          label: '天气现象',
          text:
            weather.hazard === 'hail'
              ? `冰雹：综合 W=${weather.W.toFixed(1)}，云顶 ${weather.cloudTop.toFixed(1)} km，T=${weather.T.toFixed(1)}°C。`
              : weather.hazard === 'thunderstorm'
                ? `雷暴：综合 W=${weather.W.toFixed(1)}。`
                : weather.hazard === 'tornado'
                  ? `龙卷：W=${weather.W.toFixed(1)}，切变 ${weather.shear.toFixed(0)}°，涡度 ${weather.vorticity.toFixed(0)}。`
                  : weather.hazard === 'freezingRain'
                    ? `冻雨：地面 T=${weather.T.toFixed(1)}°C，中层暖层 ${weather.midTemperature.toFixed(1)}°C。`
                    : weather.hazard === 'fog'
                      ? '雾：近饱和、静风、稳定层结。'
                      : weather.hazard === 'dust'
                        ? '沙尘：地表干、风速达到 4 级以上。'
                        : '无高影响天气现象。',
          tone: weather.hazard === 'none' ? 'neutral' : 'warn',
        },
        ...moistureBudgetEntries(simulation),
        ...targetEntries,
      ],
    },
  ];

  let recommendation = recommendationFor(level);
  if (evaluation.passed) {
    recommendation = level.successNote;
  } else if (evaluation.holding) {
    recommendation = evaluation.detail;
  } else {
    switch (level.target.kind) {
      case 'vertical':
        recommendation =
          weather.W <= (level.target.minW ?? 0)
            ? `${city.name} W=${weather.W.toFixed(2)}，尚未越过零线。把 L 的影响圈覆盖 ${city.name}；如已覆盖，改用 −20 hPa 档。`
            : level.hint;
        break;
      case 'moisture': {
        const wetEntities = simulation.after.entities.filter((entity) => entity.type === 'wet');
        const wetCount = wetEntities.length;
        const nearWet = wetEntities.filter((entity) => Math.hypot(entity.x - city.x, entity.y - city.y) <= entity.radius * 0.92);
        if (level.index === 13 && weather.Q < (level.target.minQ ?? 0)) {
          if (wetCount <= 1) {
            recommendation = `A 城 Q=${weather.Q.toFixed(1)}，单个水汽上限 +40，不够 70。再叠一张水汽，并把它放在同一上风方向。`;
          } else if (nearWet.length <= 1) {
            recommendation = `A 城 Q=${weather.Q.toFixed(1)}，第二个水汽影响圈没覆盖 A 城，Q 没有叠加。把两张水汽放到 A 城同一上风方向。`;
          } else {
            recommendation = `A 城 Q=${weather.Q.toFixed(1)}，水汽不在同一上风方向，风把水汽吹向别处，A 城 Q 没有完整叠加。`;
          }
        } else {
          recommendation =
            weather.Q < (level.target.minQ ?? 0)
              ? `${city.name} Q=${weather.Q.toFixed(1)}，距目标还差 ${((level.target.minQ ?? 0) - weather.Q).toFixed(1)} g/m³。把水汽中心移到 ${city.name}，或叠加第二张水汽。`
              : level.hint;
        }
        break;
      }
      case 'rain':
        if (weather.W <= 0.05) {
          recommendation = `有雨的必要条件尚未满足：${city.name} W=${weather.W.toFixed(2)}，空气没有上升。先让 L 或锋面覆盖 ${city.name}。`;
        } else if (qDeficit <= 0) {
          recommendation = `${city.name}已经上升（W=${weather.W.toFixed(2)}），但水汽 Q=${weather.Q.toFixed(1)} 未越过凝结阈值。把水汽向 ${city.name} 靠拢或改用 +40 g/m³。`;
        } else if (weather.frontType === 'none' && weather.wHigh < 0.5) {
          recommendation = `${city.name}低层 W=${weather.wLow.toFixed(2)}，高层 W=${weather.wHigh.toFixed(2)}。低层虽有上升，但高层支撑不足，云顶只到 ${weather.cloudTop.toFixed(1)} km；改用深厚冷低压，或加入高空槽增强高层抬升。`;
        } else if (level.target.min24h !== undefined && weather.rain24h < level.target.min24h) {
          recommendation = `${city.name}的锋面已经抬升，但 24 小时等效只有 ${weather.rain24h.toFixed(0)} mm。加强冷锋强度、叠加热水汽，或让锋面正好压在 ${city.name}。`;
        } else {
          recommendation = level.hint;
        }
        break;
      case 'clear':
        recommendation =
          weather.R > 0
            ? `${city.name}仍有 R=${weather.R.toFixed(2)} mm/3h，残存 W=${weather.W.toFixed(2)}。H 的下沉补偿不足：把 H 靠近 ${city.name} 或选择 +20 hPa。`
            : level.hint;
        break;
      case 'rotation':
        recommendation =
          weather.vorticity < (level.target.minVorticity ?? 0)
            ? `${city.name} 涡度 ${weather.vorticity.toFixed(0)}，距中气旋阈值还差 ${((level.target.minVorticity ?? 0) - weather.vorticity).toFixed(0)}。让冷、暖气团分居城市两侧，并把低压中心压在城上，形成闭合旋转。`
            : level.hint;
        break;
      case 'typhoon': {
        const storms = simulation.after.entities.filter((entity) => entity.type === 'typhoon');
        recommendation =
          storms.length === 0
            ? '场上没有台风。先在暖海面（海温 ≥26.5°C）放一个暖低压并让它持续降水两回合，它会升级为热带气旋。'
            : '台风需要在暖海面停留增强，再借助高空急流转向；提前登陆会迅速减弱。检查台风中心与城市距离，以及海温/登陆状态。';
        break;
      }
      case 'advect': {
        const b = level.cities.find((item) => item.id === advectCondition?.cityId);
        const distancePx =
          targetWet && b ? Math.hypot(targetWet.x - b.x, targetWet.y - b.y) : Number.POSITIVE_INFINITY;
        const kmPerPx = level.base.domainScale
          ? level.base.domainScale / MAP_SIZE
          : MAP_KM_PER_PX;
        recommendation = `水汽当前距${b?.name ?? 'B 城'} ${Number.isFinite(distancePx) ? (distancePx * kmPerPx).toFixed(0) : '—'} km。低层风沿等压线绕低压：调整 H/L 的位置，让风把水汽送向目标。可继续运行下一回合。`;
        break;
      }
      case 'temperature': {
        if (level.target.minT !== undefined) {
          recommendation =
            weather.T <= level.target.minT
              ? `${city.name} T=${weather.T.toFixed(1)}°C，还需升温 ${(level.target.minT - weather.T).toFixed(1)}°C。用 +10°C 暖气团覆盖 ${city.name}。`
              : level.hint;
        } else {
          recommendation =
            weather.T >= (level.target.maxT ?? 0)
              ? `${city.name} T=${weather.T.toFixed(1)}°C，还需降低 ${(weather.T - (level.target.maxT ?? 0)).toFixed(1)}°C。−5°C 档不足，选择 −10°C 冷气团或叠加两张冷气团。`
              : level.hint;
        }
        break;
      }
      case 'multi':
      case 'persistent':
      case 'persistentRain':
      case 'accumulatedRain':
      case 'sequence':
        recommendation = `${evaluation.detail} ${genericDiagnosis(level, evaluation)}`.trim();
        break;
      default:
        recommendation = level.hint;
        break;
    }
  }

  // A level hint is the answer key; only fall back to it when the condition
  // itself cannot produce a diagnosis.
  if (!evaluation.passed && !evaluation.holding && recommendation === level.hint) {
    recommendation = genericDiagnosis(level, evaluation) || level.hint;
  }

  if (!evaluation.passed && !evaluation.holding && level.failureAdvice) {
    // Level-authored copy: `missing` when the primary condition never formed,
    // `weak` when it formed but the magnitude is short.  {R24}/{R} are filled
    // from the measured rainfall so the text stays specific.
    const primaryMet = evaluation.conditionResults?.[0]?.passed ?? false;
    const advice = primaryMet
      ? (level.failureAdvice.weak ?? level.failureAdvice.missing)
      : level.failureAdvice.missing;
    recommendation = advice
      .replace('{R24}', weather.rain24h.toFixed(0))
      .replace('{R}', weather.R.toFixed(2));
  }

  return {
    stages,
    verdict: evaluation.passed ? '目标达成' : evaluation.holding ? '持续推演中' : '目标未达成',
    detail: evaluation.detail,
    recommendation,
  };
}

function compassLabelToward(deg: number): string {
  return compassLabelFromToward(deg);
}
