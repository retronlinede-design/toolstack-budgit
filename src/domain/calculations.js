export const INCOME_STATUSES = ["expected", "received", "delayed", "cancelled"];

const SIMPLE_DECIMAL = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/;

/**
 * Parse money entered by the current UI.
 *
 * Accepted inputs are finite JavaScript numbers and plain decimal strings such
 * as "1200", "1200.50", "1200,50", ".50", or "-.50". Thousands
 * separators, exponent notation, empty strings, NaN, and Infinity are invalid.
 */
export function parseMoney(input) {
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? { valid: true, value: input, reason: null, input }
      : { valid: false, value: 0, reason: "not_finite", input };
  }

  if (typeof input !== "string") {
    return { valid: false, value: 0, reason: "unsupported_type", input };
  }

  const trimmed = input.trim();
  if (!trimmed) return { valid: false, value: 0, reason: "empty", input };
  if (!SIMPLE_DECIMAL.test(trimmed)) {
    return { valid: false, value: 0, reason: "invalid_format", input };
  }

  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value)
    ? { valid: true, value, reason: null, input }
    : { valid: false, value: 0, reason: "not_finite", input };
}

export function normalizeIncomeStatus(status) {
  return INCOME_STATUSES.includes(status) ? status : "expected";
}

function invalidAmount(scope, item, index, parsed, reason = parsed.reason) {
  return {
    scope,
    index,
    id: item && item.id ? item.id : null,
    input: item ? item.amount : undefined,
    reason,
  };
}

export function calculateIncomeTotals(incomes) {
  const totals = {
    expectedIncome: 0,
    receivedIncome: 0,
    delayedIncome: 0,
    cancelledIncome: 0,
    invalidAmounts: [],
  };

  const items = Array.isArray(incomes) ? incomes : [];
  items.forEach((item, index) => {
    const parsed = parseMoney(item && item.amount);
    if (!parsed.valid) {
      totals.invalidAmounts.push(invalidAmount("income", item, index, parsed));
      return;
    }

    const status = normalizeIncomeStatus(item && item.status);
    if (status !== "cancelled") totals.expectedIncome += parsed.value;
    if (status === "received") totals.receivedIncome += parsed.value;
    if (status === "delayed") totals.delayedIncome += parsed.value;
    if (status === "cancelled") totals.cancelledIncome += parsed.value;
  });

  return totals;
}

export function calculateExpenseGroupTotals(group) {
  const totals = {
    expenseGroupPlannedTotal: 0,
    expenseGroupPaidTotal: 0,
    expenseGroupUnpaidTotal: 0,
    invalidAmounts: [],
  };

  const items = Array.isArray(group && group.items) ? group.items : [];
  items.forEach((item, index) => {
    const parsed = parseMoney(item && item.amount);
    if (!parsed.valid) {
      totals.invalidAmounts.push(invalidAmount("expense", item, index, parsed));
      return;
    }
    if (parsed.value < 0) {
      totals.invalidAmounts.push(invalidAmount("expense", item, index, parsed, "negative_not_allowed"));
      return;
    }

    totals.expenseGroupPlannedTotal += parsed.value;
    if (item && item.paid) totals.expenseGroupPaidTotal += parsed.value;
    else totals.expenseGroupUnpaidTotal += parsed.value;
  });

  return totals;
}

export function calculateExpenseTotals(expenseGroups) {
  const totals = {
    plannedExpenses: 0,
    paidExpenses: 0,
    unpaidExpenses: 0,
    invalidAmounts: [],
  };

  const groups = Array.isArray(expenseGroups) ? expenseGroups : [];
  groups.forEach((group, groupIndex) => {
    const groupTotals = calculateExpenseGroupTotals(group);
    totals.plannedExpenses += groupTotals.expenseGroupPlannedTotal;
    totals.paidExpenses += groupTotals.expenseGroupPaidTotal;
    totals.unpaidExpenses += groupTotals.expenseGroupUnpaidTotal;
    totals.invalidAmounts.push(
      ...groupTotals.invalidAmounts.map((issue) => ({
        ...issue,
        groupIndex,
        groupId: group && group.id ? group.id : null,
      })),
    );
  });

  return totals;
}

export function calculateSavingsRate(expectedIncome, leftAfterPlannedExpenses) {
  if (!Number.isFinite(expectedIncome) || expectedIncome <= 0) return null;
  if (!Number.isFinite(leftAfterPlannedExpenses)) return null;
  const rate = (leftAfterPlannedExpenses / expectedIncome) * 100;
  return Number.isFinite(rate) ? rate : null;
}

export function calculateMonthTotals(monthData) {
  const month = monthData && typeof monthData === "object" ? monthData : {};
  const income = calculateIncomeTotals(month.incomes);
  const expenses = calculateExpenseTotals(month.expenseGroups);
  const leftAfterPlannedExpenses = income.expectedIncome - expenses.plannedExpenses;

  return {
    ...income,
    ...expenses,
    leftAfterPlannedExpenses,
    savingsRate: calculateSavingsRate(income.expectedIncome, leftAfterPlannedExpenses),
    invalidAmounts: [...income.invalidAmounts, ...expenses.invalidAmounts],
  };
}

export function calculateMoneyListTotal(items, scope = "money") {
  const result = { total: 0, invalidAmounts: [] };
  const list = Array.isArray(items) ? items : [];
  list.forEach((item, index) => {
    const parsed = parseMoney(item && item.amount);
    if (parsed.valid) result.total += parsed.value;
    else result.invalidAmounts.push(invalidAmount(scope, item, index, parsed));
  });
  return result;
}

function finiteMoneyValue(input) {
  const parsed = parseMoney(input);
  return parsed.valid ? parsed.value : 0;
}

export function balanceAfterUnpaidExpenses(currentBankBalance, unpaidExpenses) {
  const result = finiteMoneyValue(currentBankBalance) - finiteMoneyValue(unpaidExpenses);
  return Number.isFinite(result) ? result : 0;
}

export function balanceAfterExpectedIncomingMoney(currentBankBalance, expectedIncomingMoney, unpaidExpenses) {
  const result = finiteMoneyValue(currentBankBalance) + finiteMoneyValue(expectedIncomingMoney) - finiteMoneyValue(unpaidExpenses);
  return Number.isFinite(result) ? result : 0;
}
