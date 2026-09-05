import { describe, it, expect } from 'vitest';
import { ALL_PATTERNS } from './settingsStore';
import type { PatternName } from '@/types/domain';

// Patterns intentionally NOT exposed as a UI toggle in ALL_PATTERNS. Empty
// today — every implemented pattern is meant to be toggleable. If a pattern
// is ever deliberately kept out of the settings UI, add it here with a
// comment explaining why, instead of just leaving it out of ALL_PATTERNS —
// an unexplained gap is exactly the regression this file guards against
// (see audit: 11 fully-implemented, fully-tested patterns were unreachable
// from the UI because ALL_PATTERNS never listed them).
const EXCLUDED_FROM_ALL_PATTERNS: readonly PatternName[] = [];

// Exhaustiveness map: one key per PatternName. If `PatternName` in
// src/types/domain.ts ever gains a new member without a corresponding key
// added here, this file fails to type-check (`npm run typecheck`) — that
// compile-time guarantee is what actually prevents the drift, independent of
// whether anyone remembers to update ALL_PATTERNS or run this test.
const PATTERN_NAME_COVERAGE: Record<PatternName, true> = {
  'hammer': true,
  'shooting-star': true,
  'doji': true,
  'pin-bar': true,
  'bullish-engulfing': true,
  'bearish-engulfing': true,
  'bullish-harami': true,
  'bearish-harami': true,
  'inside-bar': true,
  'morning-star': true,
  'evening-star': true,
  'impulse-breakout': true,
  'consolidation-breakout': true,
  'liquidity-sweep': true,
  'liquidity-sweep-reaction': true,
  'mean-reversion': true,
  'strong-order-block-reaction': true,
  'order-block-continuation': true,
  'macd-deceleration-continuation': true,
  'fvg-return': true,
  'fvg-breaker-block': true,
  'fvg-nested': true,
  'fvg-rejection': true,
  'order-block-breaker': true,
  'order-block-nested': true,
  'inverted-hammer': true,
  'hanging-man': true,
  'marubozu-bullish': true,
  'marubozu-bearish': true,
  'spinning-top': true,
  'piercing-line': true,
  'dark-cloud-cover': true,
  'tweezer-bottom': true,
  'tweezer-top': true,
  'three-white-soldiers': true,
  'three-black-crows': true,
  'abandoned-baby-bottom': true,
  'abandoned-baby-top': true,
  'rising-three-methods': true,
  'falling-three-methods': true,
};

describe('ALL_PATTERNS coverage', () => {
  it('includes every PatternName, or explicitly excludes it', () => {
    const allNames = Object.keys(PATTERN_NAME_COVERAGE) as PatternName[];
    const missing = allNames.filter(
      (name) => !ALL_PATTERNS.includes(name) && !EXCLUDED_FROM_ALL_PATTERNS.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(ALL_PATTERNS).size).toBe(ALL_PATTERNS.length);
  });

  it('only lists names that are actually valid PatternName values', () => {
    const validNames = new Set(Object.keys(PATTERN_NAME_COVERAGE));
    const invalid = ALL_PATTERNS.filter((p) => !validNames.has(p));
    expect(invalid).toEqual([]);
  });
});
