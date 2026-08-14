function recoveryDateStamp(referenceDate) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createRawRecoveryFile(rawText, referenceDate = new Date()) {
  if (typeof rawText !== "string") return { ok: false, code: "raw_storage_unavailable" };
  const stamp = recoveryDateStamp(referenceDate);
  if (!stamp) return { ok: false, code: "invalid_recovery_date" };
  return {
    ok: true,
    content: rawText,
    filename: `BudgIt-Raw-Recovery-${stamp}.json`,
    mimeType: "application/json",
  };
}
