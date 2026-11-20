export type MaxExcelntSelection = {
  provider: "excelnt";
  model: string;
  profile: "max-hq";
  mode: "text_only";
};
export function extractExcelntModels(payload: unknown): string[];
export function validateMaxModelSelection(
  provider: unknown, model: unknown, catalog: string[] | null | undefined,
): { ok: true; selection: MaxExcelntSelection | null } | { ok: false; error: string };
