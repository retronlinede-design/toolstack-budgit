import { parseMoney } from "./calculations.js";
import { isCanonicalMonthKey } from "./monthKey.js";

export function calendarMonthKey(referenceDate = new Date()) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Describe unresolved planned income without changing the stored status.
 * Expected rows only become historically unresolved once their month is past.
 */
export function analyzeHistoricalIncome(monthKey, monthData, { currentMonthKey } = {}) {
  const canonicalCurrentMonth = isCanonicalMonthKey(currentMonthKey) ? currentMonthKey : null;
  const historical = isCanonicalMonthKey(monthKey) && canonicalCurrentMonth !== null && monthKey < canonicalCurrentMonth;
  const expectedRows = historical && Array.isArray(monthData?.incomes)
    ? monthData.incomes.filter((income) => income?.status === "expected")
    : [];

  let unresolvedExpectedAmount = 0;
  let invalidUnresolvedAmountCount = 0;
  expectedRows.forEach((income) => {
    const parsed = parseMoney(income?.amount);
    if (parsed.valid) unresolvedExpectedAmount += parsed.value;
    else invalidUnresolvedAmountCount += 1;
  });

  return {
    historical,
    unresolvedExpectedCount: expectedRows.length,
    unresolvedExpectedAmount,
    invalidUnresolvedAmountCount,
    historicalIncomeOutcomeComplete: !historical || expectedRows.length === 0,
  };
}
