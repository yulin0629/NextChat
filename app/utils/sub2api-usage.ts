import type { LLMUsage } from "../client/api";

// The gateway (Sub2API) reports a key's spend and limits here; OpenAI's old
// dashboard/billing paths do not exist on it. Amounts are USD at list price.
export const SUB2API_USAGE_PATH = "v1/usage";

const round = (n: unknown) =>
  typeof n === "number" ? Math.round(n * 100) / 100 : undefined;

export function parseSub2ApiUsage(data: any): LLMUsage {
  if (data?.error) {
    throw new Error(data.error.message ?? "Failed to query usage");
  }
  const windows = (Array.isArray(data?.rate_limits) ? data.rate_limits : [])
    .filter((r: any) => typeof r?.window === "string")
    .map((r: any) => ({
      window: r.window,
      used: round(r.used) ?? 0,
      limit: round(r.limit) ?? 0,
    }));
  return {
    used: round(data?.quota?.used),
    total: round(data?.quota?.limit),
    windows: windows.length ? windows : undefined,
  } as LLMUsage;
}
