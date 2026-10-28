// Product-owned manual maintenance uses the unmodified native DSH engine.
// A distinct entry keeps it separate from global automatic-compaction policies.
export { BasicCompactionEngine as default } from '@deepseek-ai/dsh-compaction-basic';
