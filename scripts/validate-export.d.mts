// validate-export.mjs 的类型声明（给 test/export.test.ts 用）。
export declare const VOCAB_FIELDS: string[];
export declare function longestEnglishRun(s: string): number;
export declare function validateVocab(data: unknown): string[];
export declare function validateBackup(data: unknown): string[];
export declare function validateExport(data: unknown): { kind: 'vocab' | 'backup' | 'unknown' | '?'; errors: string[]; count: number };
