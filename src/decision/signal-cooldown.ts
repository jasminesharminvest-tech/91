import type { SignalDirection } from '@/types/domain';

// BUGFIX (аудит 2026-09-05): в реальном инциденте движок за 13 минут выдал
// 3 BUY-сигнала подряд (08:20, 08:21, 08:22) почти на одной и той же цене
// (79664.47 / 79664.47 / 79663.19), пока предыдущий с экспирацией 3m ещё не
// резолвился — по сути "усреднение" в уже проигрывающую зону без единой
// проверки. DecisionEngine раньше не хранил никакой истории уже выданных
// сигналов между вызовами evaluate(), поэтому каждый бар оценивался так,
// будто рынок увидели впервые.
//
// Этот модуль — чистая, независимо тестируемая функция: держит ли ещё
// "кулдаун" предыдущий сигнал той же стороны и той же ценовой зоны. Сама
// история сигналов хранится в DecisionEngine (см. engine.ts).

export interface RecentSignalRecord {
  direction: SignalDirection;
  entryPrice: number;
  /** Время закрытой свечи, на которой был выдан этот сигнал (секунды). */
  candleTime: number;
  /** До какого времени (секунды) сигнал считается ещё не резолвленным. */
  resolvesAtTime: number;
}

export interface CooldownCheckParams {
  recent: RecentSignalRecord[];
  direction: SignalDirection;
  entryPrice: number;
  candleTime: number;
  /** ATR на момент нового сигнала — определяет ширину "той же зоны". */
  atrValue: number | null;
  /** Во сколько ATR считать цену "той же зоной". */
  zoneAtrMultiplier?: number;
}

export const DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER = 2;

/**
 * true, если новый сигнал нужно подавить: в его направлении и ценовой зоне
 * уже есть недавний сигнал, который ещё не должен был резолвиться
 * (candleTime нового сигнала раньше recent.resolvesAtTime).
 */
export function isSuppressedByCooldown(params: CooldownCheckParams): boolean {
  const { recent, direction, entryPrice, candleTime, atrValue } = params;
  if (recent.length === 0) return false;
  if (!atrValue || atrValue <= 0) return false;

  const zoneMultiplier = params.zoneAtrMultiplier ?? DEFAULT_COOLDOWN_ZONE_ATR_MULTIPLIER;
  const zoneWidth = atrValue * zoneMultiplier;

  return recent.some((r) => {
    if (r.direction !== direction) return false;
    if (candleTime >= r.resolvesAtTime) return false; // предыдущий сигнал уже должен был резолвиться
    return Math.abs(entryPrice - r.entryPrice) <= zoneWidth;
  });
}

/** Отбрасывает записи, чьё окно резолва уже прошло — не даём массиву расти бесконечно. */
export function pruneResolvedSignals(recent: RecentSignalRecord[], nowCandleTime: number): RecentSignalRecord[] {
  return recent.filter((r) => nowCandleTime < r.resolvesAtTime);
}
