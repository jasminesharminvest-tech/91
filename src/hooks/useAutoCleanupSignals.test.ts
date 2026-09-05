import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAnalyticsStore } from '@/stores/useAnalyticsStore';

vi.mock('@/stores/useTickStore', () => ({ clearOutcomeScheduler: vi.fn() }));
vi.mock('@/lib/signal-persistence', () => ({ deleteAllSignals: vi.fn().mockResolvedValue(undefined) }));

import { clearOutcomeScheduler } from '@/stores/useTickStore';
import { deleteAllSignals } from '@/lib/signal-persistence';
import { useAutoCleanupSignals } from './useAutoCleanupSignals';

describe('useAutoCleanupSignals', () => {
  beforeEach(() => {
    useAnalyticsStore.getState().clearAll();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not touch the scheduler/DB on the first-ever mount (baseline run)', () => {
    renderHook(() => useAutoCleanupSignals());
    expect(clearOutcomeScheduler).not.toHaveBeenCalled();
    expect(deleteAllSignals).not.toHaveBeenCalled();
    expect(useAnalyticsStore.getState().lastAutoCleanupAt).not.toBeNull();
  });

  it('clears the outcome scheduler and triggers deleteAllSignals when a cleanup is actually due', () => {
    useAnalyticsStore.setState({ lastAutoCleanupAt: Date.now() - 25 * 60 * 60 * 1000 });
    renderHook(() => useAutoCleanupSignals());
    expect(clearOutcomeScheduler).toHaveBeenCalledTimes(1);
    expect(deleteAllSignals).toHaveBeenCalledTimes(1);
  });
});
