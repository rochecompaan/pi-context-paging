export const EVAL_MODEL = { provider: "openai-codex", id: "gpt-6-luna", thinking: "xhigh" } as const;
export const PAGING_SETTINGS = { enabled: true, tokenBudget: 128_000, trimToTokens: 80_000 } as const;
export const WORKLOAD_VERSION = "incident-v1" as const;
