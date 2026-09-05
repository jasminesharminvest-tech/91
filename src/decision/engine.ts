import type {
  Candle,
  IndicatorConfig,
  PatternName,
  Signal,
  SignalOutcome,
  Snapshot,
  Timeframe,
  FeatureName,
  Tick,
  SignalComponentToggles,
} from '@/types/domain';
import { DEFAULT_SIGNAL_TOGGLES, DEFAULT_INDICATOR_CONFIG } from '@/types/domain';
import type { CalibrationModel } from './calibration-model';
import { workerClient } from '@/compute/WorkerClient';
import {
  buildSignal,
  type BuildSignalParams,
} from './signal-builder';
import { addBreadcrumb } from '@/lib/sentry';
import { TIMEFRAME_SECONDS } from '@/data/symbols';
import { PRE_CLOSE_SIGNAL_LEAD_MS } from '@/lib/constants';
import { isSuppressedByCooldown, pruneResolvedSignals, type RecentSignalRecord } from './signal-cooldown';

const DEFAULT_BARS_TO_RESOLVE = 5;
const FROZEN_SIGNAL_MAX_AGE_MS = 60_000;

// Audit finding D1 ("Реакция на снятие ликвидности"): patterns whose entry
// conditions are hard geometric checks on the LAST candle's exact OHLC
// (displacement body/range ratio, breakout margin, rejection wicks...) can
// flip from valid to invalid in the last few seconds before a candle closes
// — a partial wick retrace on M1 is common, especially around institutional
// activity. The pre-close freeze mechanism below exists to cut UI/
// notification latency, which is a reasonable trade-off for most patterns,
// but for these three specifically a signal frozen at "close - 5s" can be
// handed out as final even though the bar's ACTUAL close no longer satisfies
// the pattern's own geometry. These are revalidated against the closed bar
// instead of trusting the frozen pre-close value — every other pattern
// keeps the existing fast path unchanged.
const HARD_GEOMETRY_PATTERNS = new Set<PatternName>([
  'liquidity-sweep-reaction',
  'impulse-breakout',
  'consolidation-breakout',
]);

export interface OutcomeRecord {
  signalId: string;
  outcome: SignalOutcome;
  features: number[];
  score: number;
}

export interface DecisionEngineOptions {
  calibration: CalibrationModel | null;
  barsToResolve: number;
  scoreThreshold?: number;
  signalToggles?: SignalComponentToggles;
  priorityThreshold?: number;
}

export class DecisionEngine {
  private calibration: CalibrationModel | null;
  private barsToResolve: number;
  private scoreThreshold: number;
  private signalToggles: SignalComponentToggles;
  private priorityThreshold: number | null;
  private frozenSignal: Signal | null = null;
  private frozenCandleTime: number | null = null;
  private currentSignal: Signal | null = null;
  private currentSnapshot: Snapshot | null = null;
  // BUGFIX (аудит 2026-09-05): раньше между вызовами evaluate() не хранилось
  // никакой истории уже выданных сигналов — движок мог штамповать сигналы в
  // одном направлении в одну и ту же ценовую зону, пока предыдущий ещё не
  // резолвился (реальный кейс: 3 BUY подряд за 2 минуты в пределах ATR друг
  // от друга на BTCUSDT M1). См. signal-cooldown.ts.
  private recentSignals: RecentSignalRecord[] = [];
  // Monotonic counter, incremented on every evaluate() call that reaches the
  // worker. candleTime alone can't distinguish two in-flight requests for the
  // *same* candle (e.g. two maybeTriggerPreClose ticks on the same candleTime,
  // with a tick/snapshot update in between) — worker promises aren't
  // guaranteed to resolve in issue order, so without a per-call sequence
  // number a newer request's response could be overwritten by an older one
  // that happens to resolve later. requestSeq is compared instead of (not
  // just alongside) candleTime, so it also covers the different-candle case.
  private requestSeq = 0;

  constructor(opts: DecisionEngineOptions) {
    this.calibration = opts.calibration;
    this.barsToResolve = opts.barsToResolve > 0 ? opts.barsToResolve : DEFAULT_BARS_TO_RESOLVE;
    this.scoreThreshold = opts.scoreThreshold ?? DEFAULT_INDICATOR_CONFIG.scoreThreshold;
    this.signalToggles = opts.signalToggles ?? DEFAULT_SIGNAL_TOGGLES;
    this.priorityThreshold = opts.priorityThreshold ?? null;
  }

  snapshot(candleTime: number, serverNowMs: number, timeframeSeconds: number): { isFrozen: boolean; shouldFreeze: boolean } {
    const closeTimeMs = (candleTime + timeframeSeconds) * 1000;
    const msUntilClose = closeTimeMs - serverNowMs;
    const shouldFreeze = msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > -PRE_CLOSE_SIGNAL_LEAD_MS;
    return { isFrozen: this.frozenSignal !== null, shouldFreeze };
  }

  async evaluate(
    symbolId: string,
    timeframe: Timeframe,
    candles: Candle[],
    config: IndicatorConfig,
    atrMultiplier: number,
    activeFeatures: FeatureName[],
    tick: Tick | null,
    serverNowMs: number,
    isClosed: boolean = true,
  ): Promise<Signal | null> {
    if (candles.length === 0) return null;
    const hasEnabledSource = this.signalToggles.structure || this.signalToggles.zones || this.signalToggles.liquidity || this.signalToggles.trigger || this.signalToggles.indicator || this.signalToggles.bos || this.signalToggles.macd || this.signalToggles.meanReversion;
    if (!hasEnabledSource) {
      this.currentSignal = null;
      this.frozenSignal = null;
      this.frozenCandleTime = null;
      return null;
    }
    const lastCandle = candles[candles.length - 1];
    const tfSeconds = TIMEFRAME_SECONDS[timeframe];
    const { shouldFreeze } = this.snapshot(lastCandle.time, serverNowMs, tfSeconds);

    const frozenForThisCandle =
      this.frozenSignal && this.frozenCandleTime === lastCandle.time ? this.frozenSignal : null;

    // See HARD_GEOMETRY_PATTERNS above: the actual candle-close call
    // (isClosed === true) for one of these patterns must always recompute
    // against the closed bar rather than short-circuiting on the frozen
    // pre-close value — everything else keeps the fast path below.
    const requiresCloseRevalidation =
      isClosed &&
      frozenForThisCandle !== null &&
      frozenForThisCandle.pattern !== null &&
      HARD_GEOMETRY_PATTERNS.has(frozenForThisCandle.pattern);

    // Fast path: this MUST resolve synchronously, before we ever go to the
    // worker, so a valid frozen signal keeps being returned immediately on
    // every call (up to 5x/sec via maybeTriggerPreClose) instead of paying
    // worker round-trip latency for a result we already have.
    if (frozenForThisCandle && !requiresCloseRevalidation) {
      const age = serverNowMs - (frozenForThisCandle.frozenAt ?? 0);
      if (age > FROZEN_SIGNAL_MAX_AGE_MS) {
        this.frozenSignal = null;
        this.frozenCandleTime = null;
      } else {
        return frozenForThisCandle;
      }
    }

    const requestSeq = ++this.requestSeq;

    const { snapshot, series } = await workerClient.snapshotRequest(
      symbolId,
      timeframe,
      candles,
      config,
      activeFeatures,
      isClosed,
    );
    void series;

    // Race condition guard: if a newer evaluate() call was issued while we
    // were awaiting the worker, requestSeq will have moved on — this
    // response is stale, so it must not overwrite currentSignal/currentSnapshot
    // (or frozenSignal) with outdated data. Just drop it; the newer in-flight
    // call will produce the up-to-date result.
    //
    // Comparing requestSeq (not just candleTime) also covers two in-flight
    // requests for the *same* candleTime: worker promises aren't guaranteed
    // to resolve in issue order, so if an older same-candle request resolves
    // after a newer one, requestSeq (unlike candleTime) still tells them
    // apart and the older response is dropped instead of overwriting the
    // newer result.
    if (this.requestSeq !== requestSeq) {
      return null;
    }

    const signal = buildSignal({
      symbolId,
      timeframe,
      candles,
      config,
      atrMultiplier,
      activeFeatures,
      snapshot,
      calibration: this.calibration,
      tick,
      barsToResolve: this.barsToResolve,
      scoreThreshold: this.scoreThreshold,
      signalToggles: this.signalToggles,
      priorityThreshold: this.priorityThreshold ?? undefined,
    } satisfies BuildSignalParams);

    // BUGFIX (аудит 2026-09-05): подавляем сигнал, если это тот же
    // direction в той же (в пределах ATR) ценовой зоне, что и недавний ещё
    // не резолвленный сигнал — иначе движок "усредняется" в уже
    // проигрывающую зону вместо того, чтобы дождаться исхода. Резолв в
    // recentSignals фиксируется один раз за бар в onCandleClosed(), поэтому
    // многократные вызовы evaluate() внутри одного бара (freeze-цикл) сюда
    // не попадают лишний раз.
    let finalSignal = signal;
    if (finalSignal) {
      this.recentSignals = pruneResolvedSignals(this.recentSignals, lastCandle.time);
      const suppressed = isSuppressedByCooldown({
        recent: this.recentSignals,
        direction: finalSignal.direction,
        entryPrice: finalSignal.entryPrice,
        candleTime: lastCandle.time,
        atrValue: finalSignal.indicators.atr,
      });
      if (suppressed) {
        addBreadcrumb('Signal suppressed by cooldown: same direction/zone as unresolved recent signal', {
          direction: finalSignal.direction,
          entryPrice: finalSignal.entryPrice,
          symbolId,
        });
        finalSignal = null;
      }
    }

    this.currentSignal = finalSignal;
    this.currentSnapshot = snapshot;

    if (requiresCloseRevalidation) {
      // Authoritative close-time result for a hard-geometry pattern: replace
      // whatever was frozen pre-close outright, including invalidating it
      // (signal === null) if the pattern's own geometric conditions no
      // longer hold on the bar's actual close — see HARD_GEOMETRY_PATTERNS.
      this.frozenSignal = finalSignal ? { ...finalSignal, frozenAt: serverNowMs } : null;
      this.frozenCandleTime = finalSignal ? lastCandle.time : null;
      return finalSignal;
    }

    if (shouldFreeze && finalSignal) {
      this.frozenSignal = { ...finalSignal, frozenAt: serverNowMs };
      this.frozenCandleTime = lastCandle.time;
      return this.frozenSignal;
    }

    return finalSignal;
  }

  onCandleClosed(): Signal | null {
    const sig = this.frozenSignal ?? this.currentSignal;
    this.frozenSignal = null;
    this.frozenCandleTime = null;
    if (sig) {
      // Коммитим сигнал в историю кулдауна ровно один раз за бар — это
      // единственное место, где сигнал становится "выданным" для этого
      // бара (см. signal-cooldown.ts и комментарий в evaluate()).
      const tfSeconds = TIMEFRAME_SECONDS[sig.timeframe];
      this.recentSignals = pruneResolvedSignals(this.recentSignals, sig.time);
      this.recentSignals.push({
        direction: sig.direction,
        entryPrice: sig.entryPrice,
        candleTime: sig.time,
        resolvesAtTime: sig.time + sig.barsToResolve * tfSeconds,
      });
    }
    return sig;
  }

  recordOutcome(signal: Signal, outcome: SignalOutcome): OutcomeRecord | null {
    if (outcome === 'pending') return null;
    if (!this.calibration) return null;

    const outcomeValue: 1 | 0 = outcome === 'win' ? 1 : 0;
    const sample = {
      features: signal.featureVector,
      score: signal.score,
      outcome: outcomeValue,
    };

    // Only the (cheap) sample bookkeeping happens here. Retraining the
    // logistic regression is comparatively expensive (500-epoch full-batch
    // gradient descent) and is the calling code's responsibility (see
    // useTickStore.ts, triggerRetrain — it offloads to the worker via
    // workerClient.retrainCalibration()). recordOutcome() itself stays a
    // plain synchronous method that doesn't await anything.
    this.calibration.addSample(sample);
    addBreadcrumb(`Calibration sample added: ${this.calibration.getSampleCount()} samples`, {
      outcome,
      score: signal.score,
    });

    return {
      signalId: signal.id,
      outcome,
      features: signal.featureVector,
      score: signal.score,
    };
  }

  getFrozenSignal(): Signal | null {
    return this.frozenSignal;
  }

  shouldEmitPreClose(serverNowMs: number, candleTime: number, timeframeSeconds: number): boolean {
    const closeTimeMs = (candleTime + timeframeSeconds) * 1000;
    const msUntilClose = closeTimeMs - serverNowMs;
    return msUntilClose <= PRE_CLOSE_SIGNAL_LEAD_MS && msUntilClose > 0;
  }

  getLastSnapshot(): Snapshot | null {
    return this.currentSnapshot;
  }

  setScoreThreshold(threshold: number): void {
    this.scoreThreshold = threshold;
  }

  setSignalToggles(toggles: SignalComponentToggles): void {
    this.signalToggles = toggles;
  }

  setPriorityThreshold(threshold: number): void {
    this.priorityThreshold = threshold;
  }
}
