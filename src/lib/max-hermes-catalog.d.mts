export function readMaxHermesBearer(options?: { env?: NodeJS.ProcessEnv; readFile?: (path: string, encoding: string) => string }): string;
export function maxHermesProfileBase(env?: NodeJS.ProcessEnv): string;
export function fetchMaxExcelntModels(options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; readFile?: (path: string, encoding: string) => string }): Promise<string[]>;
