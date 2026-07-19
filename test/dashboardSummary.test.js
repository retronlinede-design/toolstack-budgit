import test from "node:test";
import assert from "node:assert/strict";

import { calculateMonthTotals } from "../src/domain/calculations.js";
import { createExpenseAttentionSummary, formatSavingsRate, resolveMonthDueDate } from "../src/domain/dashboardSummary.js";

const currentDate = new Date(2026, 6, 15);
const item = (overrides = {}) => ({ id: "expense", name: "Rent", amount: "10", dueDay: null, paid: false, ...overrides });
const groups = (...items) => [{ id: "group", label: "General", items }];

test("no expenses produces a calm empty summary", () => {
  assert.deepEqual(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: [], currentDate }), { unpaidCount: 0, overdueCount: 0, nextDue: null });
});

test("one unpaid expense is counted", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item()), currentDate }).unpaidCount, 1);
});

test("paid expenses are excluded", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item({ paid: true, dueDay: 1 })), currentDate }).unpaidCount, 0);
});

test("multiple unpaid expenses are counted", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item(), item({ id: "two" })), currentDate }).unpaidCount, 2);
});

test("an earlier expense in the current month is overdue", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item({ dueDay: 5 })), currentDate }).overdueCount, 1);
});

test("a later expense in the current month is not overdue", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item({ dueDay: 20 })), currentDate }).overdueCount, 0);
});

test("unpaid dated expenses in a past month are overdue", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-06", expenseGroups: groups(item({ dueDay: 30 })), currentDate }).overdueCount, 1);
});

test("unpaid expenses in a future month are not overdue", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-08", expenseGroups: groups(item({ dueDay: 1 })), currentDate }).overdueCount, 0);
});

test("undated expense counts as unpaid but cannot become next due", () => {
  const summary = createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item()), currentDate });
  assert.equal(summary.unpaidCount, 1);
  assert.equal(summary.nextDue, null);
});

test("earliest dated unpaid expense is selected", () => {
  const summary = createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item({ id: "late", name: "Phone", dueDay: 20 }), item({ id: "early", name: "Rent", dueDay: 5 })), currentDate });
  assert.equal(summary.nextDue.name, "Rent");
  assert.equal(summary.nextDue.actualDueDay, 5);
});

test("matching due days use deterministic name order", () => {
  const summary = createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item({ name: "Water", dueDay: 5 }), item({ name: "Electricity", dueDay: 5 })), currentDate });
  assert.equal(summary.nextDue.name, "Electricity");
});

test("due day 31 clamps to the last day of non-leap February", () => {
  assert.deepEqual(resolveMonthDueDate("2026-02", 31), { requestedDueDay: 31, actualDueDay: 28, dueStamp: Date.UTC(2026, 1, 28), dueDateISO: "2026-02-28" });
});

test("leap-year February permits day 29", () => {
  assert.equal(resolveMonthDueDate("2024-02", 31).actualDueDay, 29);
});

test("invalid due days and month keys are ignored", () => {
  assert.equal(resolveMonthDueDate("2026-02", 0), null);
  assert.equal(resolveMonthDueDate("2026-02", 32), null);
  assert.equal(resolveMonthDueDate("not-a-month", 1), null);
});

test("structural empty groups do not create attention items", () => {
  assert.equal(createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: [{ id: "g", label: "General", items: [] }], currentDate }).unpaidCount, 0);
});

test("primary dashboard metrics use the established calculation results", () => {
  const totals = calculateMonthTotals({
    incomes: [{ amount: "1000", status: "expected" }, { amount: "200", status: "cancelled" }],
    expenseGroups: groups(item({ amount: "400", paid: false })),
  });
  assert.deepEqual({ expectedIncome: totals.expectedIncome, plannedExpenses: totals.plannedExpenses, leftAfterPlannedExpenses: totals.leftAfterPlannedExpenses, unpaidExpenses: totals.unpaidExpenses }, { expectedIncome: 1000, plannedExpenses: 400, leftAfterPlannedExpenses: 600, unpaidExpenses: 400 });
  assert.equal(totals.cancelledIncome, 200);
});

test("secondary income totals remain distinguishable", () => {
  const totals = calculateMonthTotals({ incomes: [{ amount: "100", status: "received" }, { amount: "50", status: "delayed" }, { amount: "25", status: "cancelled" }] });
  assert.deepEqual({ expected: totals.expectedIncome, received: totals.receivedIncome, delayed: totals.delayedIncome, cancelled: totals.cancelledIncome }, { expected: 150, received: 100, delayed: 50, cancelled: 25 });
});

test("null or non-finite savings rates display as an em dash", () => {
  assert.equal(formatSavingsRate(null), "—");
  assert.equal(formatSavingsRate(NaN), "—");
  assert.equal(formatSavingsRate(Infinity), "—");
  assert.equal(formatSavingsRate(12.34), "12.3%");
});

test("summary counts support singular and plural wording", () => {
  const singular = createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item()), currentDate });
  const plural = createExpenseAttentionSummary({ activeMonth: "2026-07", expenseGroups: groups(item(), item({ id: "two" })), currentDate });
  assert.equal(singular.unpaidCount, 1);
  assert.equal(plural.unpaidCount, 2);
});
