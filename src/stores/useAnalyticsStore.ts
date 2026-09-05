import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Signal, CalibrationResult, ConnectionStatus, SignalOutcome, CalibrationState, ChartContext } from '@/types/domain';

const MAX_SIGNALS = 100;

// Автоудаление истории раз в сутки (см. хук useAutoCleanupSignals.ts и его
// JSDoc с объяснением архитектуры "клиентская проверка" vs "pg_cron").
export const AUTO_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Аудит (синхронизация): «ИСТОРИЯ СИГНАЛОВ» — глобальная (не per-symbol)
// история (см. комментарий у deleteAllSignals/clearSignalHistory ниже), а
// исход для tradeOpened === true сигнала выставляется АСИНХРОННО, в момент
// фактического закрытия демо-сделки (useDemoAccountStore.checkExpiries/
// resolveFromHistory → syncSignalOutcome → updateSignalOutcome), который
// может произойти значительно позже, чем сам сигнал попал в этот массив
// (например, пользователь успел переключиться на другие символы и накопить
// много новых сигналов, пока сделка на предыдущем символе ещё не
// экспирировалась). updateSignalOutcome() ищет запись по id через `.map()`
// и молча не делает ничего, если id уже не найден — то есть простое
// `.slice(0, MAX_SIGNALS)` по свежести могло вытолкнуть из массива ЕЩЁ
// PENDING сигнал до того, как его исход вообще наступил. Результат:
// демо-сделка закрывается (видна в «Последние сделки»), а соответствующая
// строка в «ИСТОРИЯ СИГНАЛОВ» никогда не появляется — сигнал просто
// исчезает бесследно, и с ним, если tradeOpened===false, безвозвратно
// теряется обучающий сэмпл калибровки (см. tick-store/outcomes.ts). Это и
// есть баг «некоторые сигналы после закрытия сделки не обрабатываются в
// ИСТОРИЮ СИГНАЛОВ».
//
// Исправление: эвикшн по MAX_SIGNALS применяется ТОЛЬКО к уже завершённым
// (outcome !== 'pending') сигналам; pending-сигналы никогда не вытесняются,
// сколько бы новых сигналов ни пришло за это время — так что заканчивающая
// свою жизнь сделка ВСЕГДА найдёт свою запись в этом массиве, когда придёт
// её исход. Число одновременно pending-сигналов на практике мало (не более
// одной открытой сделки на инструмент, см. useDemoAccountStore.openTrade),
// так что неограниченный рост массива этим сигналам не грозит.
function capSignals(signals: Signal[]): Signal[] {
  if (signals.length <= MAX_SIGNALS) return signals;
  const capped: Signal[] = [];
  let resolvedCount = 0;
  for (const sig of signals) {
    if (sig.outcome === 'pending') {
      capped.push(sig);
      continue;
    }
    if (resolvedCount < MAX_SIGNALS) {
      capped.push(sig);
      resolvedCount++;
    }
  }
  return capped;
}

interface AnalyticsState {
  signals: Signal[];
  currentSignal: Signal | null;
  calibrationReady: boolean;
  calibrationSampleCount: number;
  calibrationState: CalibrationState | null;
  winRate: number | null;
  connectionStatus: ConnectionStatus;
  calibrationResult: CalibrationResult | null;
  // Метка времени (Date.now()) последнего автоудаления истории — null,
  // пока автоочистка ни разу не запускалась (новый пользователь или
  // локальное хранилище до появления этой фичи). См. maybeRunAutoCleanup.
  lastAutoCleanupAt: number | null;
  // Аудит (точки входа на графике, п.2): раньше ChartPanel рисовал
  // маркеры ВСЕХ сигналов, попавших в видимый диапазон свечей, как только
  // включён showEntryPoints — при активной торговле это давало "хаос" из
  // десятков стрелок разом. Теперь маркер показывается ТОЛЬКО для сигналов,
  // явно выбранных кликом по строке в ИСТОРИЯ СИГНАЛОВ (см.
  // toggleChartSignal ниже и SignalFeed.tsx/SignalCard.tsx) — множество
  // id, а не сам Signal[], чтобы не дублировать данные сигнала и не
  // рассинхронизироваться с signals при апдейтах (outcome/revision и т.п.).
  // Сознательно НЕ персистится (нет в partialize ниже) — это чисто
  // UI-состояние текущей сессии просмотра графика.
  selectedChartSignalIds: Set<string>;
  toggleChartSignal: (signalId: string) => void;
  addSignal: (signal: Signal) => void;
  upsertSignal: (signal: Signal) => void;
  setCurrentSignal: (signal: Signal | null) => void;
  updateSignalOutcome: (signalId: string, outcome: SignalOutcome) => void;
  // Дописывает ценовой контекст (candlesAfter + MFE/MAE), посчитанный в
  // момент резолва исхода (см. tick-store/outcomes.ts::maybeResolveOutcomes
  // и decision/trade-context.ts). Полностью независимо от updateSignalOutcome
  // — чисто описательные данные для постмортем-экспорта (lib/trade-report.ts),
  // ничего не решает и не влияет на outcome/winRate.
  updateSignalChartContext: (signalId: string, chartContext: ChartContext) => void;
  // Аудит (сигналы бесследно пропадают из ИСТОРИЯ СИГНАЛОВ, несмотря на
  // capSignals): точечно поднимает Signal.tradeOpened в true на УЖЕ
  // существующей записи, не трогая остальные поля (outcome, score,
  // revisionNote и т.п.). См. JSDoc у реализации ниже и комментарий в
  // useTickStore.ts::maybeEvaluateSignal.
  markTradeOpened: (signalId: string) => void;
  setCalibrationResult: (result: CalibrationResult | null) => void;
  setCalibrationState: (state: CalibrationState | null) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  clearAll: () => void;
  clearSignalHistory: () => void;
  resetSession: () => void;
  recomputeStats: () => void;
  // Реальные проблемы, п.6: требование "самоудаление раз в сутки" раньше
  // было прямо законтрено в этом файле ("должен очищаться только вручную")
  // — то есть код сознательно противоречил требованию, а не просто не
  // дотягивал до него. Теперь: если с последнего автоудаления прошло
  // >= AUTO_CLEANUP_INTERVAL_MS — полностью очищает историю (тот же набор
  // полей, что clearSignalHistory) и обновляет метку времени; возвращает
  // true, если очистка реально произошла (вызывающий код — см.
  // useAutoCleanupSignals.ts — на этом сигнале гасит OutcomeScheduler и
  // синхронизирует удаление с БД, что этот чистый store-action сознательно
  // не делает сам, т.к. это сторонние эффекты вне зоны ответственности
  // Zustand-стора). При самом первом запуске (lastAutoCleanupAt === null)
  // ничего не удаляет — только фиксирует точку отсчёта, чтобы не стереть
  // уже накопленную историю сразу после обновления приложения.
  maybeRunAutoCleanup: () => boolean;
}

// Баг 1 (ИСТОРИЯ СИГНАЛОВ): раньше useTickStore.start() безусловно вызывал
// clearAll() при каждом монтировании/переключении символа/перезагрузке
// страницы (App.tsx -> useEffect по [symbolId, timeframe, phase,
// marketMode]) — это стирало signals/winRate каждый раз, хотя из UI список
// должен очищаться вручную (кнопка "Удалить все" -> clearSignalHistory
// + DB deleteAllSignals, которая, что важно, не фильтрует по символу/
// таймфрейму — история задумана как ГЛОБАЛЬНАЯ, а не per-symbol) —
// плюс теперь ещё и автоматически раз в сутки (см. maybeRunAutoCleanup
// выше и useAutoCleanupSignals.ts), чтобы локальная история не копилась
// бесконечно без участия пользователя.
//
// Поэтому здесь два независимых исправления:
//  1) persist middleware сохраняет signals в localStorage, чтобы
//     перезагрузка страницы не обнуляла историю (устраняет полную потерю
//     данных при F5). winRate/calibrationSampleCount намеренно НЕ
//     персистятся — это производные величины, пересчитываются из
//     signals через recomputeStats() при старте (см. useTickStore.start()).
//  2) resetSession() — новый, "мягкий" сброс для start(): чистит только
//     currentSignal (транзiентная "активная" карточка предыдущего
//     символа/таймфрейма, которая иначе виснет в UI после переключения),
//     не трогая signals/winRate/calibration*. Именно resetSession()
//     заменяет clearAll() в useTickStore.start() — clearAll() и
//     clearSignalHistory() остаются доступны как есть (полный сброс по
//     явному запросу пользователя/тестов).
export const useAnalyticsStore = create<AnalyticsState>()(
  persist(
    (set, get) => ({
      signals: [],
      currentSignal: null,
      calibrationReady: false,
      calibrationSampleCount: 0,
      calibrationState: null,
      winRate: null,
      connectionStatus: 'idle',
      calibrationResult: null,
      lastAutoCleanupAt: null,
      selectedChartSignalIds: new Set<string>(),

      toggleChartSignal: (signalId) =>
        set((s) => {
          const next = new Set(s.selectedChartSignalIds);
          if (next.has(signalId)) next.delete(signalId);
          else next.add(signalId);
          return { selectedChartSignalIds: next };
        }),

      addSignal: (signal) =>
        set((s) => {
          if (s.signals.some((sig) => sig.id === signal.id)) return {};
          const signals = capSignals([signal, ...s.signals]);
          return { signals };
        }),

      upsertSignal: (signal) =>
        set((s) => {
          const idx = s.signals.findIndex((sig) => sig.id === signal.id);
          if (idx >= 0) {
            const signals = [...s.signals];
            signals[idx] = signal;
            return { signals };
          }
          return { signals: capSignals([signal, ...s.signals]) };
        }),

      setCurrentSignal: (signal) => set({ currentSignal: signal }),

      updateSignalOutcome: (signalId, outcome) =>
        set((s) => {
          const signals = s.signals.map((sig) =>
            sig.id === signalId ? { ...sig, outcome } : sig,
          );
          const currentSignal = s.currentSignal?.id === signalId
            ? { ...s.currentSignal, outcome }
            : s.currentSignal;
          return { signals, currentSignal };
        }),

      updateSignalChartContext: (signalId, chartContext) =>
        set((s) => {
          const signals = s.signals.map((sig) =>
            sig.id === signalId ? { ...sig, chartContext } : sig,
          );
          const currentSignal = s.currentSignal?.id === signalId
            ? { ...s.currentSignal, chartContext }
            : s.currentSignal;
          return { signals, currentSignal };
        }),

      // Аудит (сигналы бесследно пропадают из ИСТОРИЯ СИГНАЛОВ, несмотря на
      // capSignals): pre-close (tick-store/pre-close.ts) снимает
      // tradeOpened ДО того, как сделка ПРЕДЫДУЩЕЙ свечи на этом же
      // инструменте формально истечёт — она истекает РОВНО в момент
      // закрытия ТЕКУЩЕЙ свечи, а pre-close по дизайну всегда срабатывает
      // НЕМНОГО РАНЬШЕ этого момента (это и есть "pre-close"). Поэтому
      // попытка открыть сделку внутри pre-close структурно ВСЕГДА
      // блокируется ещё не истёкшей предыдущей сделкой (guard "не больше
      // одной открытой сделки на инструмент" в useDemoAccountStore.openTrade),
      // и в analytics.signals сразу попадает tradeOpened: false. Реальная
      // сделка при этом успешно открывается чуть позже — в момент
      // фактического закрытия свечи (см.
      // useTickStore.ts::maybeEvaluateSignal, там же вычисляется
      // корректный tradeOpened) — но addSignal() для уже существующего id
      // является намеренным no-op'ом (см. её реализацию выше), поэтому
      // устаревший tradeOpened: false так и оставался в истории НАВСЕГДА,
      // хотя демо-сделка по факту была открыта и получила реальный исход
      // (видно в "Последние сделки" демо-счёта). Поскольку SignalFeed.tsx
      // теперь показывает в "ИСТОРИЯ СИГНАЛОВ" ТОЛЬКО tradeOpened !== false
      // сигналы, этот баг делал такие сигналы не просто неверно
      // помеченными, а полностью НЕВИДИМЫМИ — что и наблюдалось как
      // "некоторые сигналы после закрытия сделки не появляются в ИСТОРИЯ
      // СИГНАЛОВ" (и, как следствие, портило разбивку прибыль/убыток/
      // тайм-аут в статистике внизу экрана). markTradeOpened() точечно
      // поднимает флаг на true для уже существующей записи, не трогая
      // ничего другого.
      markTradeOpened: (signalId) =>
        set((s) => {
          const idx = s.signals.findIndex((sig) => sig.id === signalId);
          if (idx < 0 || s.signals[idx].tradeOpened === true) return {};
          const signals = [...s.signals];
          signals[idx] = { ...signals[idx], tradeOpened: true };
          const currentSignal = s.currentSignal?.id === signalId
            ? { ...s.currentSignal, tradeOpened: true }
            : s.currentSignal;
          return { signals, currentSignal };
        }),

      setCalibrationResult: (result) => {
        if (result) {
          set({
            calibrationResult: result,
            calibrationReady: result.totalTrades > 0,
            calibrationSampleCount: result.totalTrades,
            winRate: result.winRate > 0 ? result.winRate : null,
          });
        } else {
          set({ calibrationResult: null, calibrationReady: false, calibrationSampleCount: 0, winRate: null });
        }
      },

      setCalibrationState: (state) => {
        if (state) {
          set({
            calibrationState: state,
            calibrationSampleCount: state.sampleCount,
            calibrationReady: state.sampleCount >= 10,
          });
        } else {
          set({ calibrationState: null, calibrationSampleCount: 0, calibrationReady: false });
        }
      },

      setConnectionStatus: (status) => set({ connectionStatus: status }),

      clearAll: () => set({
        signals: [],
        currentSignal: null,
        calibrationReady: false,
        calibrationSampleCount: 0,
        calibrationState: null,
        winRate: null,
        calibrationResult: null,
        lastAutoCleanupAt: null,
        selectedChartSignalIds: new Set(),
      }),

      clearSignalHistory: () => set({
        signals: [],
        currentSignal: null,
        winRate: null,
        calibrationSampleCount: 0,
        selectedChartSignalIds: new Set(),
      }),

      resetSession: () => set({ currentSignal: null }),

      maybeRunAutoCleanup: () => {
        const { lastAutoCleanupAt } = get();
        const now = Date.now();
        if (lastAutoCleanupAt === null) {
          set({ lastAutoCleanupAt: now });
          return false;
        }
        if (now - lastAutoCleanupAt < AUTO_CLEANUP_INTERVAL_MS) return false;
        set({
          signals: [],
          currentSignal: null,
          winRate: null,
          calibrationSampleCount: 0,
          lastAutoCleanupAt: now,
          selectedChartSignalIds: new Set(),
        });
        return true;
      },

      recomputeStats: () => {
        const { signals } = get();
        // Аудит (синхронизация с демо-счётом): сигналы, по которым не была
        // открыта реальная демо-сделка (tradeOpened === false — см.
        // Signal.tradeOpened), исключаются из винрейта — они не должны
        // искажать статистику реально торговавшихся сигналов; в UI
        // (SignalFeed.tsx) такие сигналы не показываются вовсе. undefined
        // (сигналы, сохранённые до этого фикса) трактуется как "да" — не
        // пересчитываем задним числом уже накопленную историю.
        const traded = signals.filter((s) => s.tradeOpened !== false);
        const completed = traded.filter((s) => s.outcome === 'win' || s.outcome === 'loss' || s.outcome === 'timeout');
        if (completed.length === 0) {
          set({ winRate: null, calibrationSampleCount: 0 });
          return;
        }
        const wins = completed.filter((s) => s.outcome === 'win').length;
        const decided = completed.filter((s) => s.outcome === 'win' || s.outcome === 'loss');
        const winRate = decided.length > 0 ? wins / decided.length : null;
        set({ winRate, calibrationSampleCount: completed.length });
      },
    }),
    {
      name: 'analytics-signal-history',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Персистится список сигналов (история) и метка времени последнего
      // автоудаления (lastAutoCleanupAt — см. maybeRunAutoCleanup) — без
      // этого перезагрузка страницы обнуляла бы точку отсчёта суточного
      // таймера, и приложение считало бы, что автоочистка ни разу не
      // запускалась. currentSignal — транзиентная "активная" карточка,
      // calibration*/winRate — производные величины, пересчитываемые из
      // signals; их персистенция избыточна и рискует разойтись с реальным
      // module-singleton calibrationModel в useTickStore.
      partialize: (state) => ({ signals: state.signals, lastAutoCleanupAt: state.lastAutoCleanupAt }),
      // localStorage недоступен в SSR/тестовом окружении без DOM —
      // persist сам это учитывает через createJSONStorage, здесь просто
      // подчищаем счётчики/статистику сразу после гидратации, чтобы
      // winRate/calibrationSampleCount не оставались нулевыми при
      // непустой восстановленной истории (recomputeStats читает уже
      // восстановленный get().signals).
      onRehydrateStorage: () => (state) => {
        state?.recomputeStats();
      },
    },
  ),
);
