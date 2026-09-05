import type { CalibrationState } from '@/types/domain';

export const MIN_SAMPLES = 100;
const MAX_SAMPLES = 500;
const LEARNING_RATE = 0.1;
const EPOCHS = 500;
const L2_REGULARIZATION = 0.0001;
const STORAGE_KEY = 'terminal-calibration-v1';

export interface CalibrationSample {
  features: number[];
  score: number;
  outcome: 1 | 0;
}

export interface TrainingResult {
  weights: number[];
  bias: number;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

// Pure module-level function so it can also be run inside the compute
// worker (see src/compute/worker.ts, case 'retrain_calibration') without
// needing a CalibrationModel instance. Constants (EPOCHS/LEARNING_RATE/
// L2_REGULARIZATION) stay in this file — the worker imports the function,
// not the constants, so nothing is duplicated.
export function trainLogisticRegression(
  samples: CalibrationSample[],
  featureCount: number,
): TrainingResult {
  const n = samples.length;
  const w = new Array<number>(featureCount).fill(0);
  let b = 0;

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const gradW = new Array<number>(featureCount).fill(0);
    let gradB = 0;

    for (const s of samples) {
      let z = b;
      for (let i = 0; i < featureCount; i++) {
        z += w[i] * s.features[i];
      }
      const pred = sigmoid(z);
      const err = pred - s.outcome;
      for (let i = 0; i < featureCount; i++) {
        gradW[i] += err * s.features[i];
      }
      gradB += err;
    }

    for (let i = 0; i < featureCount; i++) {
      gradW[i] = gradW[i] / n + L2_REGULARIZATION * w[i];
      w[i] -= LEARNING_RATE * gradW[i];
    }
    b -= LEARNING_RATE * (gradB / n);
  }

  return { weights: w, bias: b };
}

export class CalibrationModel {
  private weights: number[];
  private bias: number;
  private samples: CalibrationSample[] = [];
  private featureCount: number;
  private restoredSampleCount = 0;

  constructor(featureCount: number) {
    this.featureCount = featureCount;
    this.weights = new Array<number>(featureCount).fill(0);
    this.bias = 0;
  }

  isReady(): boolean {
    return this.getSampleCount() >= MIN_SAMPLES;
  }

  getSampleCount(): number {
    return Math.max(this.samples.length, this.restoredSampleCount);
  }

  addSample(sample: CalibrationSample): void {
    if (sample.features.length !== this.featureCount) return;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.shift();
    }
  }

  predict(features: number[]): number {
    if (features.length !== this.featureCount) return sigmoid(0);
    let z = this.bias;
    for (let i = 0; i < this.featureCount; i++) {
      z += this.weights[i] * features[i];
    }
    return sigmoid(z);
  }

  // Synchronous full-batch retrain. Kept for unit tests
  // (calibration-model.test.ts) and as the single source of truth for the
  // training algorithm. Production code paths (engine.ts, useTickStore.ts)
  // no longer call this directly — they offload the same computation to
  // the worker via workerClient.retrainCalibration() and apply the result
  // with applyTrainedWeights() instead, so the UI thread never blocks on
  // the 500-epoch gradient descent below.
  retrain(): void {
    if (this.samples.length < MIN_SAMPLES) return;
    const result = trainLogisticRegression(this.samples, this.featureCount);
    this.weights = result.weights;
    this.bias = result.bias;
  }

  // Applies a training result computed elsewhere (e.g. in the worker) directly,
  // without recomputing anything.
  applyTrainedWeights(result: TrainingResult): void {
    this.weights = [...result.weights];
    this.bias = result.bias;
  }

  exportState(): CalibrationState {
    return {
      weights: [...this.weights],
      bias: this.bias,
      sampleCount: this.getSampleCount(),
    };
  }

  loadState(state: CalibrationState): void {
    if (state.weights.length !== this.featureCount) return;
    this.weights = [...state.weights];
    this.bias = state.bias;
    this.restoredSampleCount = state.sampleCount;
  }

  loadSamples(samples: CalibrationSample[]): void {
    this.samples = samples.slice(-MAX_SAMPLES);
  }

  getSamples(): CalibrationSample[] {
    return [...this.samples];
  }
}

export function loadCalibrationState(featureCount: number): CalibrationModel | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state: CalibrationState; samples: CalibrationSample[] };
    if (!parsed.state || parsed.state.weights.length !== featureCount) return null;
    const model = new CalibrationModel(featureCount);
    model.loadState(parsed.state);
    if (Array.isArray(parsed.samples)) {
      model.loadSamples(parsed.samples);
    }
    return model;
  } catch {
    return null;
  }
}

export function persistCalibrationState(model: CalibrationModel): void {
  try {
    const data = JSON.stringify({
      state: model.exportState(),
      samples: model.getSamples(),
    });
    localStorage.setItem(STORAGE_KEY, data);
  } catch {
    // localStorage may be unavailable — non-fatal
  }
}
