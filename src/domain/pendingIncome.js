import { parseMoney } from "./calculations.js";

export function preparePendingIncomeEntry({ id, label, amount, fallbackLabel = "Pending" }) {
  const parsed = parseMoney(amount);
  if (!parsed.valid) return { ok: false, reason: parsed.reason };
  return {
    ok: true,
    entry: {
      id,
      label: String(label || "").trim() || fallbackLabel,
      amount,
    },
  };
}
