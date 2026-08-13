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

/**
 * Convert a raw monetary value for formatted display without treating invalid
 * input as an intentional zero. The raw input is never changed.
 */
export function getMoneyDisplayValue(input) {
  const parsed = parseMoney(input);
  return parsed.valid
    ? { valid: true, value: parsed.value, reason: null }
    : { valid: false, value: null, reason: parsed.reason };
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

export function parseOptionalMoney(input, { nonNegative = false } = {}) {
  if (typeof input === "string" && input.trim() === "") {
    return { valid: true, blank: true, value: 0, reason: null, input };
  }
  const parsed = parseMoney(input);
  if (!parsed.valid) return { ...parsed, blank: false, value: null };
  if (nonNegative && parsed.value < 0) {
    return { valid: false, blank: false, value: null, reason: "negative_not_allowed", input };
  }
  return { ...parsed, blank: false };
}

export function calculateBalanceProjection({ bankBalance, overdraftLimit, pendingIncomeEntries, remainingExpenses }) {
  const balance = parseOptionalMoney(bankBalance);
  const overdraft = parseOptionalMoney(overdraftLimit, { nonNegative: true });
  const pending = calculateMoneyListTotal(pendingIncomeEntries, "expectedIncomingMoney");
  const remaining = parseMoney(remainingExpenses);
  const currentBalance = balance.valid ? balance.value : null;
  const expenses = remaining.valid ? remaining.value : null;
  const pendingComplete = pending.invalidAmounts.length === 0;
  const balanceAfterUnpaid = currentBalance !== null && expenses !== null
    ? currentBalance - expenses
    : null;
  const projectedAfterMoneyIn = currentBalance !== null && pendingComplete
    ? currentBalance + pending.total
    : null;
  const balanceAfterIncomingMoney = projectedAfterMoneyIn !== null && expenses !== null
    ? projectedAfterMoneyIn - expenses
    : null;
  const availableWithOverdraft = balanceAfterIncomingMoney !== null && overdraft.valid
    ? balanceAfterIncomingMoney + overdraft.value
    : null;

  return {
    balance,
    overdraft,
    pendingTotal: pending.total,
    invalidPendingAmounts: pending.invalidAmounts,
    currentBalance,
    projectedAfterMoneyIn,
    balanceAfterUnpaid,
    balanceAfterIncomingMoney,
    availableWithOverdraft,
  };
}

export function balanceAfterUnpaidExpenses(currentBankBalance, unpaidExpenses) {
  const balance = parseMoney(currentBankBalance);
  const expenses = parseMoney(unpaidExpenses);
  if (!balance.valid || !expenses.valid) return null;
  return balance.value - expenses.value;
}

export function balanceAfterExpectedIncomingMoney(currentBankBalance, expectedIncomingMoney, unpaidExpenses) {
  const balance = parseMoney(currentBankBalance);
  const pending = parseMoney(expectedIncomingMoney);
  const expenses = parseMoney(unpaidExpenses);
  if (!balance.valid || !pending.valid || !expenses.valid) return null;
  return balance.value + pending.value - expenses.value;
}
