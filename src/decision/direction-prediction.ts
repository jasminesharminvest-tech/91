import type { Candle, DirectionComponents, SignalDirection, Snapshot, SignalComponentToggles, FeatureName, SignalFactor, SignalFactorKind } from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES } from '@/types/domain';
import { orderBlockStrength, detectImbalances } from '@/compute/indicators/order-block-strength';
import { liquidityPools } from '@/compute/indicators/liquidity-pools';
import { levelRejection } from '@/compute/indicators/level-rejection';
import { supportResistance } from '@/compute/indicators/support-resistance';
import { FEATURE_NAMES, DEFAULT_WEIGHTS } from './featureCalibration';
import { selectTopPattern } from './pattern-selection';

export interface DirectionScoreResult {
  direction: SignalDirection | null;
  score: number;
  components: DirectionComponents;
  reasons: string[];
  // Структурированная версия reasons — см. SignalFactor в types/domain.ts.
  // Каждый push(reasons, ...) ниже сопровождается ровно одним push(factors,
  // ...) с тем же текстом в поле `argument`, так что reasons и factors
  // всегда описывают одни и те же события, просто в разных представлениях
  // (человекочитаемая строка vs структура для агрегации/экспорта).
  factors: SignalFactor[];
}

export function computeDirectionScore(
  candles: Candle[],
  snapshot: Snapshot,
  toggles: SignalComponentToggles = DEFAULT_SIGNAL_TOGGLES,
  activeFeatures: FeatureName[] = [],
  atrPeriod: number = 14,
  rsiOverbought: number = 70,
  rsiOversold: number = 30,
): DirectionScoreResult {
  // Individual indicator/pattern gating ("Активные индикаторы" / "Активные паттерны").
  // Distinct from `toggles`, which is the separate "Компоненты сигнала" category switch.
  // ВАЖНО: пустой activeFeatures означает «ничего не выбрано», а не «фильтра
  // нет — считать всё активным» (иначе кнопка «выключить все индикаторы/
  // паттерны» в UI включала бы вообще все фичи — см. IndicatorAggregator.ts).
  const hasFeature = (name: FeatureName) => activeFeatures.includes(name);
  const components: DirectionComponents = {
    structure: 0,
    zones: 0,
    liquidity: 0,
    trigger: 0,
    indicator: 0,
    bos: 0,
    macd: 0,
    meanReversion: 0,
  };

  const buyReasons: string[] = [];
  const sellReasons: string[] = [];
  const buyFactors: SignalFactor[] = [];
  const sellFactors: SignalFactor[] = [];
  const last = candles[candles.length - 1];
  const entryPrice = last.close;

  function pushBuy(kind: SignalFactorKind, name: string, contribution: number, argument: string, value: number | null = null): void {
    buyReasons.push(argument);
    buyFactors.push({ kind, name, direction: 'buy', contribution, argument, value });
  }
  function pushSell(kind: SignalFactorKind, name: string, contribution: number, argument: string, value: number | null = null): void {
    sellReasons.push(argument);
    sellFactors.push({ kind, name, direction: 'sell', contribution, argument, value });
  }

  // 1. Structure (BOS/CHoCH)
  const struct = snapshot.structure;
  if (struct.bos) {
    if (struct.trend === 'up') {
      components.structure = 1;
      components.bos = 1;
      pushBuy('structure', 'bos', 1, 'BOS bullish');
    } else if (struct.trend === 'down') {
      components.structure = -1;
      components.bos = -1;
      pushSell('structure', 'bos', -1, 'BOS bearish');
    }
  }
  if (struct.choch) {
    if (struct.trend === 'up') {
      components.structure = 0.5;
      pushBuy('structure', 'choch', 0.5, 'CHoCH bullish');
    } else if (struct.trend === 'down') {
      components.structure = -0.5;
      pushSell('structure', 'choch', -0.5, 'CHoCH bearish');
    }
  }

  // 2. Zones (OB proximity) — only when the "order-block-strength" indicator is active
  // Reuses snapshot.indicators.atr (computed by IndicatorAggregator from
  // config.atrPeriod) instead of recomputing ATR with a hardcoded period, so
  // there is a single source of truth for the ATR value across the pipeline.
  const atrValue = snapshot.indicators.atr;
  const proximity = atrValue ? atrValue * 2 : 0;

  if (hasFeature('order-block-strength')) {
    const obZones = orderBlockStrength(candles, 50, snapshot.structure, true);
    const activeBullOB = obZones.filter((z) => z.direction === 'bullish' && z.status !== 'broken');
    const activeBearOB = obZones.filter((z) => z.direction === 'bearish' && z.status !== 'broken');

    for (const ob of activeBullOB) {
      if (Math.abs(entryPrice - ob.low) <= proximity || (entryPrice >= ob.low && entryPrice <= ob.high)) {
        components.zones = ob.strengthScore;
        const label = ob.status === 'tested-hold'
          ? `Tested bullish OB holding (${ob.touchCount} touch${ob.touchCount !== 1 ? 'es' : ''})`
          : 'Untouched bullish OB nearby';
        pushBuy('strategy', 'order-block-strength', ob.strengthScore, label);
        break;
      }
    }
    for (const ob of activeBearOB) {
      if (Math.abs(entryPrice - ob.high) <= proximity || (entryPrice >= ob.low && entryPrice <= ob.high)) {
        components.zones = -ob.strengthScore;
        const label = ob.status === 'tested-hold'
          ? `Tested bearish OB holding (${ob.touchCount} touch${ob.touchCount !== 1 ? 'es' : ''})`
          : 'Untouched bearish OB nearby';
        pushSell('strategy', 'order-block-strength', -ob.strengthScore, label);
        break;
      }
    }
  }

  // 3. Liquidity (FVG + liquidity pools) — each gated by its own indicator toggle.
  // FVG detection ships from the order-block-strength module, so it follows that indicator's toggle.
  if (hasFeature('order-block-strength')) {
    const fvgs = detectImbalances(candles);
    // detectImbalances() already filters out invalidated zones internally;
    // this is a defence-in-depth re-filter kept under the correct field name
    // (invalidated = full-close invalidation, not touched = CE-touch).
    const activeFvgs = fvgs.filter((f) => !f.invalidated);
    for (const fvg of activeFvgs.slice(-3)) {
      if (fvg.direction === 'bullish' && entryPrice >= fvg.lower && entryPrice <= fvg.upper) {
        components.liquidity = 0.5;
        pushBuy('strategy', 'liquidity-pools', 0.5, 'Untouched bullish FVG nearby');
        break;
      }
      if (fvg.direction === 'bearish' && entryPrice >= fvg.lower && entryPrice <= fvg.upper) {
        components.liquidity = -0.5;
        pushSell('strategy', 'liquidity-pools', -0.5, 'Untouched bearish FVG nearby');
        break;
      }
    }
  }

  // 3b. Level rejection — touch + wick-ratio + failure-to-close on clustered
  // S/R levels. Replaces the removed 'level-reaction' pattern.
  // Uses += so OB proximity contribution in components.zones is not overwritten;
  // an order block and a naked S/R level are distinct phenomena and can co-exist.
  if (hasFeature('level-rejection')) {
    const levelZones = levelRejection(candles, 100, atrPeriod);
    for (const zone of levelZones) {
      const nearZone = Math.abs(entryPrice - zone.price) <= proximity ||
        (entryPrice >= zone.zoneLow && entryPrice <= zone.zoneHigh);
      if (!nearZone) continue;
      const contribution = zone.direction === 'bullish' ? zone.strengthScore : -zone.strengthScore;
      components.zones += contribution;
      const label = zone.status === 'tested-hold'
        ? `Level rejection at ${zone.type} holding (${zone.touchCount} touch${zone.touchCount !== 1 ? 'es' : ''})`
        : `Level ${zone.type} reaction in progress`;
      if (zone.direction === 'bullish') pushBuy('indicator', 'level-rejection', contribution, label);
      else pushSell('indicator', 'level-rejection', contribution, label);
      break;
    }
  }

  if (hasFeature('liquidity-pools')) {
    const pools = liquidityPools(candles);
    if (pools.length > 0) {
      const nearestPool = pools.reduce((a, b) =>
        Math.abs(b.price - entryPrice) < Math.abs(a.price - entryPrice) ? b : a,
      );
      if (nearestPool.type === 'buy-side' && Math.abs(nearestPool.price - entryPrice) <= proximity) {
        components.liquidity += 0.3;
        pushBuy('strategy', 'liquidity-pools', 0.3, 'Buy-side liquidity pool nearby');
      } else if (nearestPool.type === 'sell-side' && Math.abs(nearestPool.price - entryPrice) <= proximity) {
        components.liquidity -= 0.3;
        pushSell('strategy', 'liquidity-pools', -0.3, 'Sell-side liquidity pool nearby');
      }
    }
  }

  // 4. Trigger (candlestick pattern) — select by confidence, not array order
  const patterns = snapshot.patterns;
  const selection = selectTopPattern(patterns);
  if (selection) {
    const { top: topPattern, sameDir, fusionConfidence: fusionBoost } = selection;
    const fusionLabel = sameDir.length >= 2
      ? ` + ${sameDir.length - 1} confirming pattern${sameDir.length > 2 ? 's' : ''}`
      : '';
    // Continuation vs. reversal-at-key-level (Spring/Upthrust) label for
    // liquidity-sweep/-reaction — surfaced in reason text so the two setup
    // types can be told apart in the signal history and, eventually,
    // calibrated/reviewed separately (see strategy doc §11 and audit
    // finding #7: they have different false-positive profiles by
    // construction and shouldn't be pooled).
    const setupLabel = topPattern.setupType ? ` [${topPattern.setupType}]` : '';
    const patternArgument = `${topPattern.name} pattern (${(topPattern.confidence * 100).toFixed(0)}%)${fusionLabel}${setupLabel}`;
    if (topPattern.direction === 'buy') {
      components.trigger = fusionBoost;
      pushBuy('pattern', topPattern.name, fusionBoost, patternArgument, topPattern.confidence);
    } else if (topPattern.direction === 'sell') {
      components.trigger = -fusionBoost;
      pushSell('pattern', topPattern.name, -fusionBoost, patternArgument, topPattern.confidence);
    }
  }

  // 5. Indicator (EMA/RSI/Bollinger)
  const ind = snapshot.indicators;
  if (ind.emaFast !== null && ind.emaSlow !== null) {
    if (ind.emaFast > ind.emaSlow) {
      components.indicator += 0.5;
      pushBuy('indicator', 'ema', 0.5, 'EMA fast above slow', ind.emaFast - ind.emaSlow);
    } else if (ind.emaFast < ind.emaSlow) {
      components.indicator -= 0.5;
      pushSell('indicator', 'ema', -0.5, 'EMA fast below slow', ind.emaFast - ind.emaSlow);
    }
  }
  if (ind.rsi !== null) {
    if (ind.rsi < rsiOversold) {
      components.indicator += 0.3;
      pushBuy('indicator', 'rsi', 0.3, `RSI oversold (${ind.rsi.toFixed(1)})`, ind.rsi);
    } else if (ind.rsi > rsiOverbought) {
      components.indicator -= 0.3;
      pushSell('indicator', 'rsi', -0.3, `RSI overbought (${ind.rsi.toFixed(1)})`, ind.rsi);
    }
  }
  components.indicator = Math.max(-1, Math.min(1, components.indicator));

  // 6. MACD histogram — normalized by ATR so the contribution is comparable
  // across instruments/timeframes instead of raw price units.
  if (ind.macdHistogram !== null && atrValue && atrValue > 0) {
    const normalized = ind.macdHistogram / atrValue;
    if (normalized > 0) {
      components.macd = Math.min(1, normalized);
      pushBuy('indicator', 'macd', components.macd, 'MACD histogram positive', ind.macdHistogram);
    } else if (normalized < 0) {
      components.macd = Math.max(-1, normalized);
      pushSell('indicator', 'macd', components.macd, 'MACD histogram negative', ind.macdHistogram);
    }
  }

  // 7. Mean reversion (Bollinger + RSI)
  if (ind.bollingerLower !== null && ind.bollingerUpper !== null && ind.bollingerMiddle !== null) {
    if (entryPrice <= ind.bollingerLower) {
      components.meanReversion = 0.5;
      pushBuy('indicator', 'bollinger', 0.5, 'Price at lower Bollinger band', ind.bollingerLower);
    } else if (entryPrice >= ind.bollingerUpper) {
      components.meanReversion = -0.5;
      pushSell('indicator', 'bollinger', -0.5, 'Price at upper Bollinger band', ind.bollingerUpper);
    }
  }

  if (!toggles.structure) components.structure = 0;
  if (!toggles.zones) components.zones = 0;
  if (!toggles.liquidity) components.liquidity = 0;
  if (!toggles.trigger) components.trigger = 0;
  if (!toggles.indicator) components.indicator = 0;
  if (!toggles.bos) components.bos = 0;
  if (!toggles.macd) components.macd = 0;
  if (!toggles.meanReversion) components.meanReversion = 0;

  // Compute weighted score, scaled to match the 0-10 evidence range
  let weightedScore = 0;
  for (let i = 0; i < FEATURE_NAMES.length; i++) {
    const name = FEATURE_NAMES[i];
    const weight = DEFAULT_WEIGHTS[name];
    const componentValue = components[name];
    weightedScore += weight * componentValue;
  }
  // Scale from raw weighted sum to the 0-10 score range used by the signal builder
  const scaledScore = weightedScore * 10;

  // Tie (scaledScore === 0): the weighted buy/sell evidence exactly cancels
  // out. That is "no signal", not a silent default to 'buy' — an explicit
  // null keeps buildSignal() from ever emitting a directional signal on a
  // genuine draw, rather than relying on the UI's score-threshold minimum
  // (SettingsPanel.tsx `min: 0.5`) to incidentally filter it out.
  const direction: SignalDirection | null =
    scaledScore > 0 ? 'buy' : scaledScore < 0 ? 'sell' : null;
  const score = Math.abs(scaledScore);
  const reasons = direction === 'buy' ? buyReasons : direction === 'sell' ? sellReasons : [];

  // Toggles that zeroed out a component above (см. блок if (!toggles.X) ...)
  // must also drop the matching factor(s) — иначе `factors` показывал бы
  // вклад, который реально не попал в score. Тот же принцип, что уже
  // применяется к score через components, просто теперь применяется и к
  // структурной копии причин.
  const disabledFactorNames = new Set<string>();
  if (!toggles.structure) { disabledFactorNames.add('bos'); disabledFactorNames.add('choch'); }
  if (!toggles.zones) { disabledFactorNames.add('order-block-strength'); disabledFactorNames.add('level-rejection'); }
  if (!toggles.liquidity) { disabledFactorNames.add('liquidity-pools'); }
  if (!toggles.indicator) { disabledFactorNames.add('rsi'); disabledFactorNames.add('ema'); }
  if (!toggles.bos) { disabledFactorNames.add('bos'); }
  if (!toggles.macd) { disabledFactorNames.add('macd'); }
  if (!toggles.meanReversion) { disabledFactorNames.add('bollinger'); }

  const rawFactors = direction === 'buy' ? buyFactors : direction === 'sell' ? sellFactors : [];
  const factors = rawFactors.filter((f) => {
    if (disabledFactorNames.has(f.name)) return false;
    if (!toggles.trigger && f.kind === 'pattern') return false;
    return true;
  });

  return { direction, score, components, reasons, factors };
}

export function isPatternInRange(candles: Candle[], snapshot: Snapshot): boolean {
  const levels = supportResistance(candles);
  const last = candles[candles.length - 1];
  // Reuses snapshot.indicators.atr (config.atrPeriod-driven) rather than a
  // hardcoded-period recompute — see computeDirectionScore above.
  const atrValue = snapshot.indicators.atr;
  if (!atrValue || atrValue <= 0) return false;

  const nearLevel = levels.some((l) => Math.abs(last.close - l.price) <= atrValue);
  const obZones = orderBlockStrength(candles, 50, snapshot.structure, true);
  const nearOB = obZones.some((z) =>
    z.status !== 'broken' && last.close >= z.low - atrValue * 0.5 && last.close <= z.high + atrValue * 0.5,
  );
  return !nearLevel && !nearOB;
}
