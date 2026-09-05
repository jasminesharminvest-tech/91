import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorConfig, PatternResult, Signal } from '@/types/domain';
import { DEFAULT_INDICATOR_CONFIG } from '@/types/domain';
import { buildSignal, buildFeatureVector, generateSignalId, shouldRevise, sigmoidFallback, reviseSignal } from './signal-builder';
import { CalibrationModel } from './calibration-model';
import type { Snapshot } from '@/types/domain';

const CONFIG: IndicatorConfig = {
  ...DEFAULT_INDICATOR_CONFIG,
  emaFast: 9,
  emaSlow: 21,
};

function makeCandles(uptrend: boolean): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 60; i++) {
    const change = uptrend ? 1.5 : -1.5;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({ time: i * 60, open, high, low, close, volume: 100 });
    price = close;
  }
  return candles;
}

function makeSnapshot(candles: Candle[], indicators: Partial<Signal['indicators']>): Snapshot {
  return {
    indicators: { ...candles[candles.length - 1], ...indicators } as Signal['indicators'],
    patterns: [],
    structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false },
    regime: 'range',
    lastPrice: candles[candles.length - 1].close,
    candleTime: candles[candles.length - 1].time,
  };
}

describe('generateSignalId', () => {
  it('produces deterministic IDs per candle', () => {
    const id1 = generateSignalId('BTCUSDT', '15m', 1000);
    const id2 = generateSignalId('BTCUSDT', '15m', 1000);
    expect(id1).toBe(id2);
    expect(id1).toBe('BTCUSDT:15m:1000');
  });
});

describe('buildFeatureVector', () => {
  it('includes only non-null indicators', () => {
    const snap = makeSnapshot(makeCandles(true), {
      rsi: 65,
      emaFast: 110,
      emaSlow: 105,
      macdHistogram: 0.5,
      atr: 2,
      bollingerUpper: 115,
      bollingerMiddle: 105,
      bollingerLower: 95,
    });
    const vec = buildFeatureVector(snap);
    expect(vec.values.length).toBeGreaterThan(0);
    expect(vec.keys).toContain('rsi');
    expect(vec.keys).toContain('ema_cross');
    expect(vec.keys).toContain('macd_hist');
  });

  it('returns fixed-length vector even with all null indicators', () => {
    const snap = makeSnapshot(makeCandles(true), {
      rsi: null,
      emaFast: null,
      emaSlow: null,
      macdHistogram: null,
      atr: null,
      bollingerUpper: null,
      bollingerMiddle: null,
      bollingerLower: null,
      vwap: null,
      vwapIsProxyVolume: false,
      volumeProfilePoc: null,
      volumeProfilePocIsProxyVolume: false,
      meanReversionRsi: null,
      impulseVelocity: null,
      adx: null,
    });
    const vec = buildFeatureVector(snap);
    expect(vec.values.length).toBe(12);
    expect(vec.values.every((v) => v === 0)).toBe(true);
  });
});

describe('sigmoidFallback', () => {
  it('returns 0.5 for score 0', () => {
    expect(sigmoidFallback(0)).toBeCloseTo(0.5, 3);
  });

  it('returns higher probability for higher score', () => {
    expect(sigmoidFallback(5)).toBeGreaterThan(sigmoidFallback(0));
    expect(sigmoidFallback(10)).toBeGreaterThan(sigmoidFallback(5));
  });

  it('is bounded in [0, 1]', () => {
    expect(sigmoidFallback(-100)).toBeGreaterThanOrEqual(0);
    expect(sigmoidFallback(100)).toBeLessThanOrEqual(1);
  });
});

describe('shouldRevise', () => {
  it('returns true when delta > 3', () => {
    expect(shouldRevise(6, 2)).toBe(true);
    expect(shouldRevise(2, 6)).toBe(true);
  });

  it('returns false when delta <= 3', () => {
    expect(shouldRevise(4, 2)).toBe(false);
    expect(shouldRevise(2, 4)).toBe(false);
  });
});

describe('reviseSignal', () => {
  it('updates score, reason, and marks as revised', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 105, macdHistogram: -0.5, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal: Signal = {
      id: 'test:1',
      symbolId: 'BTCUSDT',
      direction: 'buy',
      strength: 'moderate',
      score: 2,
      calibratedProbability: 0.5,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      reason: 'initial',
      indicators: snap.indicators,
      pattern: null,
      time: 100,
      timeframe: '15m',
      outcome: 'pending',
      frozenAt: null,
      isRevised: false,
      isPreClose: false,
      revisionNote: null,
      barsToResolve: 5,
      spread: null,
      spreadSource: null,
      recommendedExpiry: 900,
      featureVector: new Array(12).fill(0),
      factors: [], rejectedPatterns: [], engineConfigSnapshot: {} as unknown as Signal['engineConfigSnapshot'],
      chartContext: { candlesBefore: [], candlesAfter: [], maxFavorableExcursion: null, maxAdverseExcursion: null },
      marketContext: { regime: 'range', structure: { trend: 'range', bos: false, choch: false, swingHigh: null, swingLow: null, provisional: false }, session: 'closed' },
    };
    const revised = reviseSignal(signal, 6, 'new reasons', snap, null);
    expect(revised.isRevised).toBe(true);
    expect(revised.score).toBe(6);
    expect(revised.reason).toBe('new reasons');
    expect(revised.revisionNote).toContain('2');
    expect(revised.revisionNote).toContain('6');
  });
});

describe('buildSignal', () => {
  it('returns null when score < 2', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 50, emaFast: 105, emaSlow: 105, macdHistogram: 0, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).toBeNull();
  });

  it('uses fallback sigmoid when calibration not ready', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.calibratedProbability).not.toBeNull();
    expect(signal!.calibratedProbability).toBeGreaterThan(0.5);
  });

  it('uses calibrated probability when model is ready', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const model = new CalibrationModel(12);
    for (let i = 0; i < 15; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: model, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.calibratedProbability).not.toBeNull();
    expect(signal!.calibratedProbability).toBeGreaterThan(0);
    expect(signal!.calibratedProbability).toBeLessThan(1);
  });

  it('populates trade levels, spread, and expiry', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const tick = { price: 100, time: 0, bid: 99.9, ask: 100.1 };
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.entryPrice).toBeGreaterThan(0);
    expect(signal!.stopLoss).toBeGreaterThan(0);
    expect(signal!.takeProfit).toBeGreaterThan(0);
    expect(signal!.spread).toBeCloseTo(0.2, 5);
    expect(signal!.spreadSource).toBe('live');
    expect(signal!.recommendedExpiry).toBeGreaterThan(0);
    expect(signal!.barsToResolve).toBe(5);
    expect(signal!.frozenAt).toBeNull();
    expect(signal!.isRevised).toBe(false);
  });

  // Реальные проблемы, п.1: свеча самого входа раньше выпадала из
  // chartContext (candlesBefore заканчивался ДО неё, candlesAfter
  // начинался СТРОГО после неё — ни один из двух массивов её не содержал).
  it('includes the entry (signal) candle as the last element of chartContext.candlesBefore', () => {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    const before = signal!.chartContext.candlesBefore;
    expect(before.length).toBeGreaterThan(0);
    expect(before[before.length - 1].time).toBe(signal!.time);
    expect(before[before.length - 1]).toEqual(candles[candles.length - 1]);
  });
});

// Audit ("Реакция на снятие ликвидности") findings #4, #6, #9, #10.
describe('buildSignal — liquidity-sweep-reaction structural SL/TP and bonuses', () => {
  function lsrPattern(overrides: Partial<PatternResult> = {}): PatternResult {
    return {
      name: 'liquidity-sweep-reaction',
      direction: 'buy',
      confidence: 0.8,
      strength: 'strong',
      time: 0,
      volumeConfirmed: true,
      setupType: 'continuation',
      ...overrides,
    };
  }

  function buySnapshot(candles: Candle[]) {
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    return snap;
  }

  it('includes a Liquidity Sweep Reaction bonus line in the reason text (finding #4)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow: lastClose - 5, sweepHigh: lastClose - 1, oppositeZonePrice: null })];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.reason).toContain('Liquidity Sweep Reaction');
  });

  it('places the stop beyond the swept extreme, not at a fixed ATR multiple from entry (finding #6)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const sweepLow = lastClose - 5;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow, sweepHigh: lastClose - 1, oppositeZonePrice: null })];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    // atr=2, buffer default 0.1 → stopLoss = sweepLow - 0.2, independent of
    // atrMultiplier (2, which is what the OLD shared estimateTradeLevels
    // would have used to place the stop at a flat distance from entry).
    expect(signal!.stopLoss).toBeCloseTo(sweepLow - 0.2, 6);
  });

  it('targets the nearest opposite liquidity zone when it clears the minimum R:R (finding #6)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const sweepLow = lastClose - 5;
    const oppositeZonePrice = lastClose + 50; // comfortably clears MIN_RR
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow, sweepHigh: lastClose - 1, oppositeZonePrice })];

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    expect(signal!.takeProfit).toBe(oppositeZonePrice);
  });

  it('adjusts the modelled entry price by half the spread in the trade direction (finding #9)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow: lastClose - 5, sweepHigh: lastClose - 1, oppositeZonePrice: null })];
    const tick = { price: lastClose, time: 0, bid: lastClose - 0.05, ask: lastClose + 0.05 }; // spread = 0.1

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
    // Buy → entry is modelled at close + spread/2, not the raw close.
    expect(signal!.entryPrice).toBeCloseTo(lastClose + 0.05, 6);
  });

  it('blocks entry when spread is wide relative to THIS trade\'s planned stop, even though it clears the general ATR-relative gate (finding #10)', () => {
    const candles = makeCandles(true);
    const lastClose = candles[candles.length - 1].close;
    // Sweep bar extreme very close to entry → tiny stopDistance. atr=2, so
    // the general spreadGateMultiplier=3 gate (spread <= atr*3 = 6) is
    // trivially satisfied by a 0.5 spread, but the LSR-specific gate
    // (spread <= stopDistance*0.4) is not.
    const sweepLow = lastClose - 0.05;
    const snap = buySnapshot(candles);
    snap.patterns = [lsrPattern({ sweepLow, sweepHigh: lastClose - 0.01, oppositeZonePrice: null })];
    const tick = { price: lastClose, time: 0, bid: lastClose - 0.25, ask: lastClose + 0.25 }; // spread = 0.5

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).toBeNull();
  });

  it('does not apply the LSR-specific spread gate to other patterns (scoped fix)', () => {
    // Same tight-stop, wide-spread scenario, but with no LSR pattern present
    // — buildSignal falls back to estimateTradeLevels (atrMultiplier*ATR
    // stop), so the LSR-specific gate must not fire for it.
    const candles = makeCandles(true);
    const snap = buySnapshot(candles);
    const tick = { price: candles[candles.length - 1].close, time: 0, bid: candles[candles.length - 1].close - 0.25, ask: candles[candles.length - 1].close + 0.25 };

    const signal = buildSignal({
      symbolId: 'BTCUSDT', timeframe: '15m', candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick, barsToResolve: 5,
    });
    expect(signal).not.toBeNull();
  });
});

describe('buildSignal — priorityThreshold gate (доделка, Задача 1)', () => {
  // Требование: сигнал создаётся только если calibratedProbability
  // (или, без готовой калибровки, sigmoidFallback(evidence.score)) —
  // такого же значения или выше priorityThreshold. Сравнение включительное
  // (>=), не строгое (>).
  function baselineParams() {
    const candles = makeCandles(true);
    const snap = makeSnapshot(candles, {
      rsi: 25, emaFast: 110, emaSlow: 100, macdHistogram: 1, atr: 2,
      bollingerUpper: 115, bollingerMiddle: 105, bollingerLower: 95,
    });
    return {
      symbolId: 'BTCUSDT', timeframe: '15m' as const, candles, config: CONFIG, atrMultiplier: 2,
      activeFeatures: [], snapshot: snap, calibration: null, tick: null, barsToResolve: 5,
    };
  }

  it('does not filter anything when priorityThreshold is undefined (backward-compatible default)', () => {
    const signal = buildSignal(baselineParams());
    expect(signal).not.toBeNull();
  });

  it('creates the signal when calibratedProbability is exactly equal to priorityThreshold (>=, not >)', () => {
    const baseline = buildSignal(baselineParams());
    expect(baseline).not.toBeNull();
    const prob = baseline!.calibratedProbability!;

    const signal = buildSignal({ ...baselineParams(), priorityThreshold: prob });
    expect(signal).not.toBeNull();
    expect(signal!.calibratedProbability).toBeCloseTo(prob, 10);
  });

  it('creates the signal when calibratedProbability is above priorityThreshold', () => {
    const baseline = buildSignal(baselineParams());
    const prob = baseline!.calibratedProbability!;

    const signal = buildSignal({ ...baselineParams(), priorityThreshold: prob - 0.01 });
    expect(signal).not.toBeNull();
  });

  it('returns null (does not create the signal at all) when calibratedProbability is below priorityThreshold', () => {
    const baseline = buildSignal(baselineParams());
    const prob = baseline!.calibratedProbability!;

    const signal = buildSignal({ ...baselineParams(), priorityThreshold: prob + 0.01 });
    expect(signal).toBeNull();
  });

  it('applies the same gate when using a ready calibration model, not only the sigmoid fallback', () => {
    const model = new CalibrationModel(12);
    for (let i = 0; i < 15; i++) {
      model.addSample({ features: new Array(12).fill(0.5), score: 3, outcome: 1 });
    }
    model.retrain();

    const baselineWithModel = buildSignal({ ...baselineParams(), calibration: model });
    expect(baselineWithModel).not.toBeNull();
    const prob = baselineWithModel!.calibratedProbability!;

    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob })).not.toBeNull();
    expect(buildSignal({ ...baselineParams(), calibration: model, priorityThreshold: prob + 0.01 })).toBeNull();
  });
});
