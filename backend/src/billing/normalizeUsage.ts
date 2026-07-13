import { UsageEntry } from "./types";
import { MODE_BURN_RATES, PROVIDER_MULTIPLIERS, DEFAULT_PROVIDER_MULTIPLIER, CREDITS_PER_1K_EFFECTIVE_TOKENS } from "./constants";

export function computeCredits(entries: UsageEntry[]): number {
  let totalEffective = 0;
  for (const e of entries) {
    const burn = MODE_BURN_RATES[e.mode] ?? MODE_BURN_RATES["build"];
    const mult = PROVIDER_MULTIPLIERS[e.provider] ?? DEFAULT_PROVIDER_MULTIPLIER;
    totalEffective += e.totalTokens * burn * mult;
  }
  return Math.ceil((totalEffective / 1000) * CREDITS_PER_1K_EFFECTIVE_TOKENS);
}
