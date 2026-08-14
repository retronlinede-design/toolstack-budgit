import {
  calculateBalanceProjection,
  calculateMonthTotals,
  parseMoney,
  parseOptionalMoney,
} from "./calculations.js";
import { resolveMonthDueDate } from "./dashboardSummary.js";

export const FINANCE_ANALYSIS_FORMAT = "budgit-finance-analysis";
export const FINANCE_ANALYSIS_VERSION = 1;

const MONTH_KEY = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
const SUPPORTED_MODES = new Set(["current", "selected", "all"]);

export function isFinanceAnalysisMonthKey(value) {
  return typeof value === "string" && MONTH_KEY.test(value);
}

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

export function isFinanceMeaningfulMonth(month, { includeNotes = false } = {}) {
  if (!month || typeof month !== "object" || Array.isArray(month)) return false;
  if (Array.isArray(month.incomes) && month.incomes.length > 0) return true;
  if (Array.isArray(month.pendingIncomeEntries) && month.pendingIncomeEntries.length > 0) return true;
  if (hasText(month.bankBalance) || hasText(month.overdraftLimit)) return true;
  if ((month.expenseGroups || []).some((group) => Array.isArray(group?.items) && group.items.length > 0)) return true;
  return includeNotes && hasText(month.notes);
}

export function getInvalidFinanceMonthKeys(months) {
  if (!months || typeof months !== "object" || Array.isArray(months)) return [];
  return Object.keys(months).filter((key) => !isFinanceAnalysisMonthKey(key));
}

export function getFinanceMeaningfulMonthKeys(months, options = {}) {
  if (!months || typeof months !== "object" || Array.isArray(months)) return [];
  return Object.keys(months)
    .filter(isFinanceAnalysisMonthKey)
    .filter((key) => isFinanceMeaningfulMonth(months[key], options))
    .sort();
}

function rawValue(input) {
  if (typeof input === "string") return input;
  if (typeof input === "number") return String(input);
  if (input == null) return "";
  return String(input);
}

export function createAnalysisAmount(input, { optional = false, nonNegative = false } = {}) {
  const raw = rawValue(input);
  if (optional && raw.trim() === "") return { raw, value: null, state: "blank" };
  const parsed = optional ? parseOptionalMoney(input, { nonNegative }) : parseMoney(input);
  if (!parsed.valid) {
    if (parsed.reason === "empty") return { raw, value: null, state: "blank" };
    return { raw, value: null, state: "invalid", reason: parsed.reason };
  }
  if (nonNegative && parsed.value < 0) return { raw, value: null, state: "invalid", reason: "negative_not_allowed" };
  return { raw, value: parsed.value, state: "valid" };
}

function addAmountIssue(issues, path, amount) {
  if (amount.state !== "valid" && amount.state !== "blank") issues.push({ path, reason: amount.reason });
  else if (amount.state === "blank") issues.push({ path, reason: "empty" });
}

function monthLabel(monthKey, language) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function projectMonth(monthKey, month, { includeNotes, language }) {
  const issues = [];
  const incomes = (Array.isArray(month?.incomes) ? month.incomes : []).map((income, index) => {
    const amount = createAnalysisAmount(income?.amount);
    addAmountIssue(issues, `facts.income[${index}].amount`, amount);
    const projected = {
      name: typeof income?.name === "string" ? income.name : "",
      amount,
      status: typeof income?.status === "string" ? income.status : "expected",
      date: typeof income?.date === "string" ? income.date : "",
    };
    if (includeNotes) projected.note = typeof income?.notes === "string" ? income.notes : "";
    return projected;
  });

  const expenseGroups = (Array.isArray(month?.expenseGroups) ? month.expenseGroups : []).map((group, groupIndex) => ({
    label: typeof group?.label === "string" ? group.label : "",
    expenses: (Array.isArray(group?.items) ? group.items : []).map((expense, expenseIndex) => {
      const amount = createAnalysisAmount(expense?.amount, { nonNegative: true });
      addAmountIssue(issues, `facts.expenseGroups[${groupIndex}].expenses[${expenseIndex}].amount`, amount);
      const due = resolveMonthDueDate(monthKey, expense?.dueDay);
      const projected = {
        name: typeof expense?.name === "string" ? expense.name : "",
        amount,
        paid: !!expense?.paid,
        dueDay: Number.isInteger(expense?.dueDay) ? expense.dueDay : null,
        dueDate: due?.dueDateISO ?? null,
      };
      if (includeNotes) projected.note = typeof expense?.note === "string" ? expense.note : "";
      return projected;
    }),
  }));

  const bankBalance = createAnalysisAmount(month?.bankBalance, { optional: true });
  const overdraft = createAnalysisAmount(month?.overdraftLimit, { optional: true, nonNegative: true });
  if (bankBalance.state === "invalid") addAmountIssue(issues, "facts.bankBalance", bankBalance);
  if (overdraft.state === "invalid") addAmountIssue(issues, "facts.overdraft", overdraft);

  const expectedIncoming = (Array.isArray(month?.pendingIncomeEntries) ? month.pendingIncomeEntries : []).map((entry, index) => {
    const amount = createAnalysisAmount(entry?.amount);
    addAmountIssue(issues, `facts.expectedIncoming[${index}].amount`, amount);
    return { label: typeof entry?.label === "string" ? entry.label : "", amount };
  });

  const totals = calculateMonthTotals(month);
  const projection = calculateBalanceProjection({
    bankBalance: month?.bankBalance ?? "",
    overdraftLimit: month?.overdraftLimit ?? "",
    pendingIncomeEntries: month?.pendingIncomeEntries ?? [],
    remainingExpenses: totals.unpaidExpenses,
  });
  const expenseAmountsComplete = totals.invalidAmounts.every((issue) => issue.scope !== "expense");
  const totalsComplete = totals.invalidAmounts.length === 0;
  const facts = { income: incomes, expenseGroups, bankBalance, overdraft, expectedIncoming };
  if (includeNotes) facts.monthNote = typeof month?.notes === "string" ? month.notes : "";

  return {
    month: monthKey,
    label: monthLabel(monthKey, language),
    facts,
    derived: {
      expectedIncome: totals.expectedIncome,
      receivedIncome: totals.receivedIncome,
      delayedIncome: totals.delayedIncome,
      cancelledIncome: totals.cancelledIncome,
      plannedExpenses: totals.plannedExpenses,
      paidExpenses: totals.paidExpenses,
      unpaidExpenses: totals.unpaidExpenses,
      projectedRemainder: totals.leftAfterPlannedExpenses,
      actualNet: totals.receivedIncome - totals.paidExpenses,
      savingsRatePercent: totalsComplete ? totals.savingsRate : null,
      expectedIncomingSubtotal: projection.pendingTotal,
      currentBalance: projection.currentBalance,
      projectedBalanceAfterIncoming: projection.projectedAfterMoneyIn,
      balanceAfterUnpaidExpenses: expenseAmountsComplete ? projection.balanceAfterUnpaid : null,
      balanceAfterExpectedIncoming: expenseAmountsComplete ? projection.balanceAfterIncomingMoney : null,
      availableWithOverdraft: expenseAmountsComplete ? projection.availableWithOverdraft : null,
    },
    dataQuality: { complete: issues.length === 0, issues },
  };
}

function selectMonthKeys(app, mode, currentMonthKey, selectedMonthKeys, includeNotes) {
  const months = app?.months && typeof app.months === "object" && !Array.isArray(app.months) ? app.months : {};
  if (mode === "current") {
    if (!isFinanceAnalysisMonthKey(currentMonthKey) || !Object.hasOwn(months, currentMonthKey)) return { ok: false, code: "invalid_current_month" };
    return { ok: true, keys: [currentMonthKey] };
  }
  if (mode === "all") {
    const keys = getFinanceMeaningfulMonthKeys(months, { includeNotes });
    return keys.length ? { ok: true, keys } : { ok: false, code: "no_meaningful_months" };
  }
  const requested = Array.isArray(selectedMonthKeys) ? selectedMonthKeys : [];
  const keys = [...new Set(requested)]
    .filter(isFinanceAnalysisMonthKey)
    .filter((key) => Object.hasOwn(months, key))
    .sort();
  return keys.length ? { ok: true, keys } : { ok: false, code: "no_months_selected" };
}

export function createFinanceAnalysisFilename(monthKeys) {
  const keys = [...new Set(Array.isArray(monthKeys) ? monthKeys : [])].filter(isFinanceAnalysisMonthKey).sort();
  if (!keys.length) return "BudgIt-Finance-Analysis.json";
  const range = keys.length === 1 ? keys[0] : `${keys[0]}_to_${keys.at(-1)}`;
  return `BudgIt-Finance-Analysis-${range}.json`;
}

export function createFinanceAnalysisExport({
  app,
  mode = "current",
  currentMonthKey = app?.activeMonth,
  selectedMonthKeys = [],
  includeNotes = false,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!app || typeof app !== "object" || !SUPPORTED_MODES.has(mode)) return { ok: false, code: "invalid_export_request" };
  const selection = selectMonthKeys(app, mode, currentMonthKey, selectedMonthKeys, !!includeNotes);
  if (!selection.ok) return selection;
  const language = app.lang === "de" ? "de" : "en";
  const months = selection.keys.map((key) => projectMonth(key, app.months[key], { includeNotes: !!includeNotes, language }));
  const document = {
    format: FINANCE_ANALYSIS_FORMAT,
    version: FINANCE_ANALYSIS_VERSION,
    generatedAt,
    currency: typeof app.currency === "string" ? app.currency : "EUR",
    displayLanguage: language,
    selection: {
      mode,
      from: selection.keys[0],
      to: selection.keys.at(-1),
      monthCount: selection.keys.length,
      includedMonths: selection.keys,
      notesIncluded: !!includeNotes,
    },
    analysisGuidance: {
      objectives: [
        "Compare income and expenditure.",
        "Identify recurring and unusually high costs.",
        "Compare trends and significant changes between months.",
        "Identify practical savings opportunities.",
        "Account for incomplete or invalid data.",
      ],
      dataQualityRule: "Totals marked incomplete are subtotals of valid entries and must not be treated as complete monthly totals.",
    },
    months,
  };
  const invalidMonthKeys = getInvalidFinanceMonthKeys(app.months);
  return {
    ok: true,
    document,
    filename: createFinanceAnalysisFilename(selection.keys),
    warnings: invalidMonthKeys.length ? [{ code: "invalid_month_keys_excluded", count: invalidMonthKeys.length }] : [],
  };
}
