export type AAModel = {
  id: string;
  slug: string;
  name: string;
  creator: string;
  releaseDate: string | null;
  intelligenceIndex: number | null;
  codingIndex: number | null;
  agenticIndex: number | null;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  medianOutputTokensPerSecond: number | null;
  medianTimeToFirstTokenSeconds: number | null;
};

export type AACatalog = {
  source: string;
  tier: string;
  intelligenceIndexVersion: number | null;
  observedAt: string;
  pagination: { page: number | null; pageSize: number | null; totalPages: number | null; hasMore: boolean };
  models: AAModel[];
};

export function normalizeAAModel(value: unknown): AAModel | null;
export function normalizeAACatalog(payload: unknown, observedAt?: string): AACatalog;
