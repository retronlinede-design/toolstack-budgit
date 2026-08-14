import assert from "node:assert/strict";
import test from "node:test";

import { validateBackupObject } from "../src/domain/backupSchema.js";
import {
  FINANCE_ANALYSIS_FORMAT,
  FINANCE_ANALYSIS_VERSION,
  createAnalysisAmount,
  createFinanceAnalysisExport,
  createFinanceAnalysisFilename,
  getFinanceMeaningfulMonthKeys,
  isFinanceMeaningfulMonth,
} from "../src/domain/financeAnalysisExport.js";

const emptyMonth = () => ({
  incomes: [], expenseGroups: [{ id: "default", label: "General", items: [] }], notes: "", transactions: [],
  bankBalance: "", overdraftLimit: "", pendingIncomeEntries: [], pendingMoneyIn: "", pendingMoneyLabel: "",
});

const populatedMonth = () => ({
  incomes: [
    { id: "income-1", name: "Salary", amount: "2000", date: "2026-01-02", status: "received", notes: "Private income note" },
    { id: "income-2", name: "Delayed", amount: "200,50", date: "", status: "delayed", notes: "" },
    { id: "income-3", name: "Cancelled", amount: "50", date: "", status: "cancelled", notes: "" },
  ],
  expenseGroups: [{
    id: "group-1", label: "Housing", items: [
      { id: "expense-1", groupId: "group-1", categoryId: "group-1", name: "Rent", amount: "800", dueDay: 1, paid: true, note: "Private expense note", notePinned: true, noteUpdatedAt: "2026-01-01T10:00:00.000Z" },
      { id: "expense-2", name: "Power", amount: "100.25", dueDay: 31, paid: false, note: "", notePinned: false, noteUpdatedAt: null },
    ],
  }],
  notes: "Private month note",
  transactions: [{ id: "transaction-1", amountCents: 99999 }],
  bankBalance: "500",
  overdraftLimit: "100",
  pendingIncomeEntries: [{ id: "pending-1", label: "Refund", amount: "25,50" }],
  pendingMoneyIn: "999",
  pendingMoneyLabel: "Legacy",
});

const app = (months, extra = {}) => ({ activeMonth: "2026-01", lang: "en", currency: "EUR", months, ...extra });
const create = (options = {}) => createFinanceAnalysisExport({
  app: app({ "2026-01": populatedMonth() }), generatedAt: "2026-08-14T10:00:00.000Z", ...options,
});

test("current-month export uses an independent stable format and is not a backup", () => {
  const result = create();
  assert.equal(result.ok, true);
  assert.equal(result.document.format, FINANCE_ANALYSIS_FORMAT);
  assert.equal(result.document.version, FINANCE_ANALYSIS_VERSION);
  assert.equal(result.document.generatedAt, "2026-08-14T10:00:00.000Z");
  assert.equal(result.document.selection.mode, "current");
  assert.deepEqual(result.document.selection.includedMonths, ["2026-01"]);
  assert.equal(validateBackupObject(result.document).valid, false);
});

test("current empty month remains exportable", () => {
  const result = createFinanceAnalysisExport({ app: app({ "2026-01": emptyMonth() }), mode: "current" });
  assert.equal(result.ok, true);
  assert.equal(result.document.months.length, 1);
  assert.equal(result.document.months[0].derived.plannedExpenses, 0);
});

test("selected sparse months are deduplicated and chronologically ordered", () => {
  const source = app({ "2026-08": populatedMonth(), "2026-01": populatedMonth(), "2026-04": populatedMonth() });
  const result = createFinanceAnalysisExport({ app: source, mode: "selected", selectedMonthKeys: ["2026-08", "2026-01", "2026-08"] });
  assert.deepEqual(result.document.selection.includedMonths, ["2026-01", "2026-08"]);
  assert.equal(result.document.selection.from, "2026-01");
  assert.equal(result.document.selection.to, "2026-08");
  assert.equal(result.document.selection.monthCount, 2);
});

test("all meaningful months exclude placeholders, transaction-only months, and custom empty groups", () => {
  const transactionOnly = { ...emptyMonth(), transactions: [{ id: "t", amountCents: 100 }] };
  const customGroupOnly = { ...emptyMonth(), expenseGroups: [{ id: "g", label: "Housing", items: [] }] };
  const months = {
    "2026-01": emptyMonth(), "2026-02": transactionOnly, "2026-03": customGroupOnly,
    "2026-04": { ...emptyMonth(), incomes: [{ id: "i", name: "Template", amount: "" }] },
    "2026-05": { ...emptyMonth(), pendingIncomeEntries: [{ id: "p", label: "Refund", amount: "" }] },
    "2026-06": { ...emptyMonth(), bankBalance: "0" },
  };
  assert.deepEqual(getFinanceMeaningfulMonthKeys(months), ["2026-04", "2026-05", "2026-06"]);
  const result = createFinanceAnalysisExport({ app: app(months), mode: "all" });
  assert.deepEqual(result.document.selection.includedMonths, ["2026-04", "2026-05", "2026-06"]);
});

test("notes-only months are meaningful only when notes are requested", () => {
  const month = { ...emptyMonth(), notes: "Context" };
  assert.equal(isFinanceMeaningfulMonth(month), false);
  assert.equal(isFinanceMeaningfulMonth(month, { includeNotes: true }), true);
});

test("currency, display language, localized label, and selection metadata are exported", () => {
  const result = createFinanceAnalysisExport({ app: app({ "2026-01": populatedMonth() }, { lang: "de", currency: "GBP" }), includeNotes: true });
  assert.equal(result.document.currency, "GBP");
  assert.equal(result.document.displayLanguage, "de");
  assert.equal(result.document.months[0].label, "Januar 2026");
  assert.equal(result.document.selection.notesIncluded, true);
});

test("income, expense, actual-net, savings, expected incoming, and balance metrics use domain semantics", () => {
  const month = create().document.months[0];
  assert.deepEqual(month.derived, {
    expectedIncome: 2200.5, receivedIncome: 2000, delayedIncome: 200.5, cancelledIncome: 50,
    plannedExpenses: 900.25, paidExpenses: 800, unpaidExpenses: 100.25,
    projectedRemainder: 1300.25, actualNet: 1200, savingsRatePercent: (1300.25 / 2200.5) * 100,
    expectedIncomingSubtotal: 25.5, currentBalance: 500, projectedBalanceAfterIncoming: 525.5,
    balanceAfterUnpaidExpenses: 399.75, balanceAfterExpectedIncoming: 425.25, availableWithOverdraft: 525.25,
  });
  assert.equal(month.facts.expenseGroups[0].expenses[1].dueDate, "2026-01-31");
});

test("amount projection supports dot, comma, blank, malformed, and negative-expense states", () => {
  assert.deepEqual(createAnalysisAmount("12.50"), { raw: "12.50", value: 12.5, state: "valid" });
  assert.deepEqual(createAnalysisAmount("12,50"), { raw: "12,50", value: 12.5, state: "valid" });
  assert.deepEqual(createAnalysisAmount(""), { raw: "", value: null, state: "blank" });
  assert.deepEqual(createAnalysisAmount("unknown"), { raw: "unknown", value: null, state: "invalid", reason: "invalid_format" });
  assert.deepEqual(createAnalysisAmount("-2", { nonNegative: true }), { raw: "-2", value: null, state: "invalid", reason: "negative_not_allowed" });
});

test("invalid entries remain raw, totals are subtotals, and quality paths contain no IDs", () => {
  const month = populatedMonth();
  month.incomes.push({ id: "secret-income-id", name: "Blank", amount: "", status: "expected" });
  month.expenseGroups[0].items.push({ id: "secret-expense-id", name: "Bad", amount: "oops", paid: false });
  month.expenseGroups[0].items.push({ id: "negative", name: "Credit", amount: "-10", paid: false });
  const exported = createFinanceAnalysisExport({ app: app({ "2026-01": month }) }).document.months[0];
  assert.equal(exported.dataQuality.complete, false);
  assert.deepEqual(exported.dataQuality.issues.slice(-4), [
    { path: "facts.income[3].amount", reason: "empty" },
    { path: "facts.income[3].status", reason: "historical_expected_income" },
    { path: "facts.expenseGroups[0].expenses[2].amount", reason: "invalid_format" },
    { path: "facts.expenseGroups[0].expenses[3].amount", reason: "negative_not_allowed" },
  ]);
  assert.equal(exported.facts.income[3].amount.raw, "");
  assert.equal(exported.derived.plannedExpenses, 900.25);
  assert.equal(exported.derived.savingsRatePercent, null);
  assert.equal(exported.derived.balanceAfterUnpaidExpenses, null);
  assert.equal(JSON.stringify(exported).includes("secret-"), false);
});

test("optional blank balance and overdraft remain blank rather than zero", () => {
  const month = emptyMonth();
  const exported = createFinanceAnalysisExport({ app: app({ "2026-01": month }) }).document.months[0];
  assert.deepEqual(exported.facts.bankBalance, { raw: "", value: null, state: "blank" });
  assert.deepEqual(exported.facts.overdraft, { raw: "", value: null, state: "blank" });
  assert.equal(exported.dataQuality.complete, true);
});

test("invalid balance and overdraft make dependent projections null", () => {
  const month = { ...emptyMonth(), bankBalance: "bad", overdraftLimit: "-20" };
  const exported = createFinanceAnalysisExport({ app: app({ "2026-01": month }) }).document.months[0];
  assert.equal(exported.derived.currentBalance, null);
  assert.equal(exported.derived.projectedBalanceAfterIncoming, null);
  assert.equal(exported.derived.availableWithOverdraft, null);
  assert.deepEqual(exported.dataQuality.issues.map((issue) => issue.reason), ["invalid_format", "negative_not_allowed"]);
});

test("notes off excludes every supported note while notes on includes only supported note content", () => {
  const without = create({ includeNotes: false }).document.months[0];
  const withNotes = create({ includeNotes: true }).document.months[0];
  assert.equal(Object.hasOwn(without.facts, "monthNote"), false);
  assert.equal(Object.hasOwn(without.facts.income[0], "note"), false);
  assert.equal(Object.hasOwn(without.facts.expenseGroups[0].expenses[0], "note"), false);
  assert.equal(withNotes.facts.monthNote, "Private month note");
  assert.equal(withNotes.facts.income[0].note, "Private income note");
  assert.equal(withNotes.facts.expenseGroups[0].expenses[0].note, "Private expense note");
  assert.equal(JSON.stringify(withNotes).includes("notePinned"), false);
  assert.equal(JSON.stringify(withNotes).includes("noteUpdatedAt"), false);
});

test("internal IDs, transactions, legacy fields, and activeMonth are excluded without source mutation", () => {
  const source = app({ "2026-01": populatedMonth() });
  const before = structuredClone(source);
  const document = createFinanceAnalysisExport({ app: source }).document;
  const serialized = JSON.stringify(document);
  for (const forbidden of ["income-1", "group-1", "expense-1", "pending-1", "transaction-1", "transactions", "pendingMoneyIn", "pendingMoneyLabel", "activeMonth"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(source, before);
});

test("malformed historical month keys are excluded and reported without blocking valid months", () => {
  const source = app({ "": populatedMonth(), "0202-01": populatedMonth(), "2026-01": populatedMonth() });
  const result = createFinanceAnalysisExport({ app: source, mode: "all" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.selection.includedMonths, ["2026-01"]);
  assert.deepEqual(result.warnings, [{ code: "invalid_month_keys_excluded", count: 2 }]);
});

test("invalid or empty selections return structured errors", () => {
  assert.equal(createFinanceAnalysisExport({ app: app({ "2026-01": emptyMonth() }), mode: "all" }).code, "no_meaningful_months");
  assert.equal(createFinanceAnalysisExport({ app: app({ "2026-01": populatedMonth() }), mode: "selected", selectedMonthKeys: [] }).code, "no_months_selected");
  assert.equal(createFinanceAnalysisExport({ app: app({ "2026-01": populatedMonth() }), mode: "current", currentMonthKey: "bad" }).code, "invalid_current_month");
});

test("filenames are deterministic and filesystem-safe for single, range, and sparse selections", () => {
  assert.equal(createFinanceAnalysisFilename(["2026-08"]), "BudgIt-Finance-Analysis-2026-08.json");
  assert.equal(createFinanceAnalysisFilename(["2026-08", "2026-01", "2026-08"]), "BudgIt-Finance-Analysis-2026-01_to_2026-08.json");
  assert.equal(createFinanceAnalysisFilename([]), "BudgIt-Finance-Analysis.json");
});

test("past expected income is exported as unresolved historical status without changing format version", () => {
  const month = populatedMonth();
  month.incomes.unshift({ id: "unresolved-id", name: "Expected salary", amount: "3000,50", date: "", status: "expected", notes: "" });
  const result = createFinanceAnalysisExport({
    app: app({ "2026-01": month }),
    generatedAt: "2026-08-14T10:00:00.000Z",
  });
  const exported = result.document.months[0];
  assert.equal(result.document.format, "budgit-finance-analysis");
  assert.equal(result.document.version, 1);
  assert.deepEqual(exported.historicalIncomeStatus, {
    complete: false,
    unresolvedExpectedCount: 1,
    unresolvedExpectedAmount: 3000.5,
    invalidUnresolvedAmountCount: 0,
  });
  assert.ok(exported.dataQuality.issues.some((issue) => issue.path === "facts.income[0].status" && issue.reason === "historical_expected_income"));
  assert.match(result.document.analysisGuidance.actualNetRule, /provisional/i);
  assert.equal(JSON.stringify(exported).includes("unresolved-id"), false);
});

test("invalid historical expected amounts retain both amount and status uncertainty", () => {
  const month = emptyMonth();
  month.incomes = [{ id: "bad", name: "Unknown", amount: "unknown", date: "", status: "expected", notes: "" }];
  const exported = createFinanceAnalysisExport({
    app: app({ "2026-01": month }),
    generatedAt: "2026-08-14T10:00:00.000Z",
  }).document.months[0];
  assert.equal(exported.historicalIncomeStatus.unresolvedExpectedAmount, 0);
  assert.equal(exported.historicalIncomeStatus.invalidUnresolvedAmountCount, 1);
  assert.deepEqual(exported.dataQuality.issues.map((issue) => issue.reason), ["invalid_format", "historical_expected_income"]);
});

test("current expected and historical explicit outcomes do not receive historical expected issues", () => {
  const current = { ...emptyMonth(), incomes: [{ id: "i", name: "Plan", amount: "100", status: "expected", date: "", notes: "" }] };
  const resolved = populatedMonth();
  const result = createFinanceAnalysisExport({
    app: app({ "2026-07": resolved, "2026-08": current }, { activeMonth: "2026-08" }),
    mode: "selected",
    selectedMonthKeys: ["2026-07", "2026-08"],
    generatedAt: "2026-08-14T10:00:00.000Z",
  });
  for (const exported of result.document.months) {
    assert.equal(exported.historicalIncomeStatus.complete, true);
    assert.equal(exported.dataQuality.issues.some((issue) => issue.reason === "historical_expected_income"), false);
  }
});

test("complete expense breakdowns export analytical facts without IDs or double counting", () => {
  const month = populatedMonth();
  month.expenseGroups[0].items[0].breakdown = [
    { id: "secret-component-1", label: "Health insurance", category: "health", amount: "300,50" },
    { id: "secret-component-2", label: "Pension", category: "pension", amount: "499.50" },
  ];
  const exported = createFinanceAnalysisExport({ app: app({ "2026-01": month }), includeNotes: false }).document;
  const expense = exported.months[0].facts.expenseGroups[0].expenses[0];
  assert.equal(expense.breakdown.complete, true);
  assert.equal(expense.breakdown.validComponentSubtotal, 800);
  assert.deepEqual(expense.breakdown.components[0], { label: "Health insurance", category: "health", amount: { raw: "300,50", value: 300.5, state: "valid" } });
  assert.equal(exported.months[0].derived.plannedExpenses, 900.25);
  assert.equal(JSON.stringify(exported).includes("secret-component"), false);
  assert.match(exported.analysisGuidance.expenseBreakdownRule, /must never be added/i);
});

test("incomplete breakdowns expose component quality paths while notes toggle keeps labels", () => {
  const month = populatedMonth();
  month.expenseGroups[0].items[0].breakdown = [
    { id: "blank", label: "Unallocated part", category: "other", amount: "" },
    { id: "bad", label: "Invalid part", category: "future_category", amount: "bad" },
  ];
  const withoutNotes = createFinanceAnalysisExport({ app: app({ "2026-01": month }), includeNotes: false }).document.months[0];
  const withNotes = createFinanceAnalysisExport({ app: app({ "2026-01": month }), includeNotes: true }).document.months[0];
  assert.equal(withoutNotes.facts.expenseGroups[0].expenses[0].breakdown.complete, false);
  assert.deepEqual(withoutNotes.dataQuality.issues.slice(-3), [
    { path: "facts.expenseGroups[0].expenses[0].breakdown.components[0].amount", reason: "empty" },
    { path: "facts.expenseGroups[0].expenses[0].breakdown.components[1].amount", reason: "invalid_format" },
    { path: "facts.expenseGroups[0].expenses[0].breakdown", reason: "breakdown_total_mismatch" },
  ]);
  assert.equal(withoutNotes.facts.expenseGroups[0].expenses[0].breakdown.components[0].label, "Unallocated part");
  assert.equal(withNotes.facts.expenseGroups[0].expenses[0].breakdown.components[0].label, "Unallocated part");
});
