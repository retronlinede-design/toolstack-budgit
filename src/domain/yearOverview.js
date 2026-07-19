import { calculateMonthTotals } from "./calculations.js";

function normalizeYear(selectedYear) {
  const year = Number(selectedYear);
  if (!Number.isInteger(year)) throw new TypeError("selectedYear must be an integer");
  return year;
}

function sum(months, field) {
  return months.reduce((total, month) => total + (month.hasData ? month[field] : 0), 0);
}

/**
 * Build a read-only calendar-year summary from BudgIt's existing application state.
 * A month is considered present when its YYYY-MM key exists in appData.months;
 * recorded zero-value months therefore remain distinct from missing months.
 */
export function calculateYearOverview(appData, selectedYear) {
  const year = normalizeYear(selectedYear);
  const sourceMonths = appData && typeof appData === "object" && appData.months && typeof appData.months === "object"
    ? appData.months
    : {};

  const months = Array.from({ length: 12 }, (_, index) => {
    const monthNumber = index + 1;
    const monthKey = `${year}-${String(monthNumber).padStart(2, "0")}`;
    const hasData = Object.prototype.hasOwnProperty.call(sourceMonths, monthKey);
    const totals = hasData ? calculateMonthTotals(sourceMonths[monthKey]) : null;
    const receivedIncome = totals?.receivedIncome ?? 0;
    const paidExpenses = totals?.paidExpenses ?? 0;

    return {
      monthKey,
      monthNumber,
      hasData,
      expectedIncome: totals?.expectedIncome ?? 0,
      receivedIncome,
      plannedExpenses: totals?.plannedExpenses ?? 0,
      paidExpenses,
      unpaidExpenses: totals?.unpaidExpenses ?? 0,
      leftAfterPlanned: totals?.leftAfterPlannedExpenses ?? 0,
      actualNet: receivedIncome - paidExpenses,
      savingsRate: totals?.savingsRate ?? null,
    };
  });

  const populatedMonths = months.filter((month) => month.hasData);
  const monthsWithData = populatedMonths.length;
  const totals = {
    expectedIncome: sum(months, "expectedIncome"),
    receivedIncome: sum(months, "receivedIncome"),
    plannedExpenses: sum(months, "plannedExpenses"),
    paidExpenses: sum(months, "paidExpenses"),
    unpaidExpenses: sum(months, "unpaidExpenses"),
    leftAfterPlanned: sum(months, "leftAfterPlanned"),
    actualNet: sum(months, "actualNet"),
  };
  const average = (field) => monthsWithData ? totals[field] / monthsWithData : null;

  let strongestMonth = null;
  let weakestMonth = null;
  populatedMonths.forEach((month) => {
    if (!strongestMonth || month.actualNet > strongestMonth.actualNet) strongestMonth = month;
    if (!weakestMonth || month.actualNet < weakestMonth.actualNet) weakestMonth = month;
  });

  return {
    year,
    months,
    totals,
    averages: {
      expectedIncome: average("expectedIncome"),
      receivedIncome: average("receivedIncome"),
      plannedExpenses: average("plannedExpenses"),
      paidExpenses: average("paidExpenses"),
      actualNet: average("actualNet"),
    },
    strongestMonth,
    weakestMonth,
    monthsWithData,
    monthsWithUnpaidExpenses: populatedMonths.filter((month) => month.unpaidExpenses > 0).length,
  };
}
