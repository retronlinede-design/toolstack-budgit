export function canonicalizeBlankDueDay(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

export function normalizeExpenseDueDay(value) {
  const canonical = canonicalizeBlankDueDay(value);
  return canonical === null ? null : Number(canonical);
}
