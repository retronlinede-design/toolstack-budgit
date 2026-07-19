import test from "node:test";
import assert from "node:assert/strict";

import {
  balanceAfterExpectedIncomingMoney,
  balanceAfterUnpaidExpenses,
  calculateExpenseGroupTotals,
  calculateIncomeTotals,
  calculateMonthTotals,
  calculateSavingsRate,
  normalizeIncomeStatus,
  parseMoney,
} from "../src/domain/calculations.js";

test("expected income counts toward expected monthly income", () => {
  assert.equal(calculateIncomeTotals([{ amount: "1000", status: "expected" }]).expectedIncome, 1000);
});

test("received income counts in both expected and received totals", () => {
  const totals = calculateIncomeTotals([{ amount: "900.50", status: "received" }]);
  assert.equal(totals.expectedIncome, 900.5);
  assert.equal(totals.receivedIncome, 900.5);
});

test("delayed income remains expected and distinguishable", () => {
  const totals = calculateIncomeTotals([{ amount: "250,25", status: "delayed" }]);
  assert.equal(totals.expectedIncome, 250.25);
  assert.equal(totals.delayedIncome, 250.25);
});

test("cancelled income is reported but excluded from usable expected income", () => {
  const totals = calculateIncomeTotals([{ amount: "400", status: "cancelled" }]);
  assert.equal(totals.expectedIncome, 0);
  assert.equal(totals.cancelledIncome, 400);
});

test("mixed income statuses follow the product rules", () => {
  const totals = calculateIncomeTotals([
    { amount: "100", status: "expected" },
    { amount: "200", status: "received" },
    { amount: "300", status: "delayed" },
    { amount: "400", status: "cancelled" },
  ]);
  assert.deepEqual(
    { expected: totals.expectedIncome, received: totals.receivedIncome, delayed: totals.delayedIncome, cancelled: totals.cancelledIncome },
    { expected: 600, received: 200, delayed: 300, cancelled: 400 },
  );
});

test("unknown income statuses normalize safely to expected", () => {
  assert.equal(normalizeIncomeStatus("mystery"), "expected");
  assert.equal(calculateIncomeTotals([{ amount: "75", status: "mystery" }]).expectedIncome, 75);
});

test("malformed income amounts are excluded and exposed for future UI validation", () => {
  const totals = calculateIncomeTotals([{ id: "bad-income", amount: "1,234.56", status: "received" }]);
  assert.equal(totals.expectedIncome, 0);
  assert.equal(totals.receivedIncome, 0);
  assert.deepEqual(totals.invalidAmounts[0], {
    scope: "income", index: 0, id: "bad-income", input: "1,234.56", reason: "invalid_format",
  });
});

test("strict money parsing distinguishes valid zero from invalid input", () => {
  assert.deepEqual(parseMoney("0"), { valid: true, value: 0, reason: null, input: "0" });
  assert.equal(parseMoney(0).valid, true);
  assert.equal(parseMoney("").valid, false);
  assert.equal(parseMoney("abc").valid, false);
  assert.equal(parseMoney(Infinity).valid, false);
});

test("paid and unpaid expenses form planned expense totals", () => {
  const totals = calculateMonthTotals({
    incomes: [],
    expenseGroups: [{ items: [{ amount: "40", paid: true }, { amount: "60", paid: false }] }],
  });
  assert.equal(totals.plannedExpenses, 100);
  assert.equal(totals.paidExpenses, 40);
  assert.equal(totals.unpaidExpenses, 60);
});

test("malformed and negative expenses do not reduce totals and are exposed", () => {
  const totals = calculateMonthTotals({
    expenseGroups: [{ id: "g1", items: [{ id: "bad", amount: "nope" }, { id: "negative", amount: "-25" }] }],
  });
  assert.equal(totals.plannedExpenses, 0);
  assert.deepEqual(totals.invalidAmounts.map((issue) => issue.reason), ["invalid_format", "negative_not_allowed"]);
});

test("empty or normalized empty month data produces neutral finite totals", () => {
  for (const month of [undefined, {}, { incomes: [], expenseGroups: [{ id: "general", label: "General", items: [] }] }]) {
    const totals = calculateMonthTotals(month);
    assert.equal(totals.expectedIncome, 0);
    assert.equal(totals.plannedExpenses, 0);
    assert.equal(totals.leftAfterPlannedExpenses, 0);
    assert.equal(totals.savingsRate, null);
  }
});

test("savings rate is null without positive expected income and finite otherwise", () => {
  assert.equal(calculateSavingsRate(0, 0), null);
  assert.equal(calculateSavingsRate(-100, -50), null);
  assert.equal(calculateSavingsRate(1000, 250), 25);
});

test("both explicitly named balance projections follow their formulas", () => {
  assert.equal(balanceAfterUnpaidExpenses(1000, 650), 350);
  assert.equal(balanceAfterExpectedIncomingMoney(1000, 200, 650), 550);
});

test("no calculation result becomes NaN or Infinity", () => {
  const totals = calculateMonthTotals({
    incomes: [{ amount: Infinity, status: "received" }, { amount: "1e309", status: "expected" }],
    expenseGroups: [{ items: [{ amount: NaN, paid: true }, { amount: "Infinity", paid: false }] }],
  });
  for (const [key, value] of Object.entries(totals)) {
    if (typeof value === "number") assert.equal(Number.isFinite(value), true, `${key} must be finite`);
  }
  assert.equal(Number.isFinite(balanceAfterExpectedIncomingMoney(Infinity, "bad", NaN)), true);
});

test("group-level totals use the same paid, unpaid, and validation rules", () => {
  const totals = calculateExpenseGroupTotals({
    items: [
      { amount: "10", paid: true },
      { amount: "15.50", paid: false },
      { amount: "-5", paid: false },
    ],
  });
  assert.equal(totals.expenseGroupPlannedTotal, 25.5);
  assert.equal(totals.expenseGroupPaidTotal, 10);
  assert.equal(totals.expenseGroupUnpaidTotal, 15.5);
  assert.equal(totals.invalidAmounts[0].reason, "negative_not_allowed");
});

test("existing normalized application month data is accepted without reshaping persistence", () => {
  const normalizedMonth = {
    incomes: [{ id: "income-1", name: "Salary", amount: "2000", date: "", status: "received", notes: "" }],
    expenseGroups: [{
      id: "group-1",
      label: "General",
      items: [{ id: "expense-1", name: "Rent", amount: "800", dueDay: 1, paid: false, note: "", notePinned: false, noteUpdatedAt: null }],
    }],
    notes: "",
    transactions: [],
    bankBalance: "1500",
    overdraftLimit: "0",
    pendingIncomeEntries: [],
    pendingMoneyIn: "",
    pendingMoneyLabel: "",
  };

  const totals = calculateMonthTotals(normalizedMonth);
  assert.equal(totals.expectedIncome, 2000);
  assert.equal(totals.receivedIncome, 2000);
  assert.equal(totals.plannedExpenses, 800);
  assert.equal(totals.unpaidExpenses, 800);
  assert.equal(totals.leftAfterPlannedExpenses, 1200);
  assert.deepEqual(totals.invalidAmounts, []);
});
