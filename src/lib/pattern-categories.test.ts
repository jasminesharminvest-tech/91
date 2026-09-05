import { describe, it, expect } from 'vitest';
import { STRATEGY_PATTERNS, PATTERN_LABELS_RU, patternCategory } from './pattern-categories';
import { ALL_PATTERNS } from '@/stores/settingsStore';
import type { PatternName } from '@/types/domain';

describe('patternCategory', () => {
  it('classifies every entry of STRATEGY_PATTERNS as "strategy"', () => {
    for (const name of STRATEGY_PATTERNS) {
      expect(patternCategory(name)).toBe('strategy');
    }
  });

  it('classifies classic candlestick patterns as "pattern"', () => {
    const classicSamples: PatternName[] = [
      'hammer',
      'doji',
      'bullish-engulfing',
      'morning-star',
      'three-white-soldiers',
      'falling-three-methods',
    ];
    for (const name of classicSamples) {
      expect(patternCategory(name)).toBe('pattern');
    }
  });

  it('classifies every pattern from ALL_PATTERNS as either pattern or strategy, matching STRATEGY_PATTERNS membership', () => {
    for (const name of ALL_PATTERNS) {
      const expected = STRATEGY_PATTERNS.includes(name) ? 'strategy' : 'pattern';
      expect(patternCategory(name)).toBe(expected);
    }
  });
});

describe('PATTERN_LABELS_RU', () => {
  it('has a non-empty Russian label for every pattern in ALL_PATTERNS', () => {
    for (const name of ALL_PATTERNS) {
      expect(PATTERN_LABELS_RU[name]).toBeTruthy();
      expect(typeof PATTERN_LABELS_RU[name]).toBe('string');
    }
  });

  it('has a label for every STRATEGY_PATTERNS entry', () => {
    for (const name of STRATEGY_PATTERNS) {
      expect(PATTERN_LABELS_RU[name]).toBeTruthy();
    }
  });
});
