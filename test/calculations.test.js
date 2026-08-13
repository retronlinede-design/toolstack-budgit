import test from "node:test";
import assert from "node:assert/strict";

import {
  balanceAfterExpectedIncomingMoney,
  balanceAfterUnpaidExpenses,
  calculateBalanceProjection,
  calculateExpenseGroupTotals,
  calculateIncomeTotals,
  calculateMonthTotals,
  calculateSavingsRate,
  getMoneyDisplayValue,
  normalizeIncomeStatus,
  parseMoney,
  parseOptionalMoney,
} from "../src/domain/calculations.js";
import { preparePendingIncomeEntry } from "../src/domain/pendingIncome.js";

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

test("money display uses domain parsing for dot and comma decimals without mutating input", () => {
  for (const raw of ["12.50", "12,50"]) {
    const before = raw;
    assert.deepEqual(getMoneyDisplayValue(raw), { valid: true, value: 12.5, reason: null });
    assert.equal(raw, before);
  }
  assert.deepEqual(getMoneyDisplayValue("not-money"), { valid: false, value: null, reason: "invalid_format" });
  assert.deepEqual(getMoneyDisplayValue(""), { valid: false, value: null, reason: "empty" });
});

test("income amount policy accepts zero and negatives while exposing blank and malformed values", () => {
  const values = [
    { id: "dot", amount: "10.25", status: "expected" },
    { id: "comma", amount: "20,25", status: "expected" },
    { id: "zero", amount: "0", status: "expected" },
    { id: "negative", amount: "-5", status: "expected" },
    { id: "blank", amount: "", status: "expected" },
    { id: "malformed", amount: "oops", status: "expected" },
  ];
  const before = structuredClone(values);
  const totals = calculateIncomeTotals(values);
  assert.equal(totals.expectedIncome, 25.5);
  assert.deepEqual(totals.invalidAmounts.map(({ id, reason }) => ({ id, reason })), [
    { id: "blank", reason: "empty" },
    { id: "malformed", reason: "invalid_format" },
  ]);
  assert.deepEqual(values, before);
});

test("expense amount policy accepts dot, comma, and zero but exposes negative, blank, and malformed values", () => {
  const values = [
    { id: "dot", amount: "10.25", paid: false },
    { id: "comma", amount: "20,25", paid: false },
    { id: "zero", amount: "0", paid: false },
    { id: "negative", amount: "-5", paid: false },
    { id: "blank", amount: "", paid: false },
    { id: "malformed", amount: "oops", paid: false },
  ];
  const before = structuredClone(values);
  const totals = calculateExpenseGroupTotals({ items: values });
  assert.equal(totals.expenseGroupPlannedTotal, 30.5);
  assert.deepEqual(totals.invalidAmounts.map(({ id, reason }) => ({ id, reason })), [
    { id: "negative", reason: "negative_not_allowed" },
    { id: "blank", reason: "empty" },
    { id: "malformed", reason: "invalid_format" },
  ]);
  assert.deepEqual(values, before);
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
  assert.equal(balanceAfterExpectedIncomingMoney(Infinity, "bad", NaN), null);
  assert.equal(balanceAfterUnpaidExpenses("bad", 10), null);
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

test("optional bank balance follows strict money parsing while allowing blank values", () => {
  for (const raw of ["", "   "]) assert.deepEqual(parseOptionalMoney(raw), { valid: true, blank: true, value: 0, reason: null, input: raw });
  for (const [raw, value] of [["0", 0], ["125", 125], ["-25", -25], ["12.50", 12.5], ["12,50", 12.5]]) {
    assert.deepEqual(parseOptionalMoney(raw), { valid: true, blank: false, value, reason: null, input: raw });
  }
  const malformed = parseOptionalMoney("not-money");
  assert.equal(malformed.valid, false);
  assert.equal(malformed.value, null);
  assert.equal(malformed.reason, "invalid_format");
});

test("optional overdraft permits blank and non-negative amounts but rejects negative and malformed values", () => {
  for (const raw of ["", "   "]) assert.equal(parseOptionalMoney(raw, { nonNegative: true }).valid, true);
  for (const raw of ["0", "125", "12.50", "12,50"]) assert.equal(parseOptionalMoney(raw, { nonNegative: true }).valid, true);
  assert.deepEqual(parseOptionalMoney("-1", { nonNegative: true }), { valid: false, blank: false, value: null, reason: "negative_not_allowed", input: "-1" });
  assert.equal(parseOptionalMoney("bad", { nonNegative: true }).valid, false);
});

test("invalid balance inputs make only dependent projections unavailable", () => {
  const invalidBalance = calculateBalanceProjection({ bankBalance: "bad", overdraftLimit: "100", pendingIncomeEntries: [{ id: "p", amount: "25" }], remainingExpenses: 40 });
  assert.equal(invalidBalance.currentBalance, null);
  assert.equal(invalidBalance.balanceAfterUnpaid, null);
  assert.equal(invalidBalance.projectedAfterMoneyIn, null);
  assert.equal(invalidBalance.availableWithOverdraft, null);

  const invalidOverdraft = calculateBalanceProjection({ bankBalance: "100", overdraftLimit: "-10", pendingIncomeEntries: [], remainingExpenses: 40 });
  assert.equal(invalidOverdraft.balanceAfterIncomingMoney, 60);
  assert.equal(invalidOverdraft.availableWithOverdraft, null);
});

test("pending totals retain valid subtotals while invalid entries make dependent projections incomplete", () => {
  const entries = [
    { id: "dot", amount: "10.25" },
    { id: "comma", amount: "20,25" },
    { id: "zero", amount: "0" },
    { id: "negative", amount: "-5" },
    { id: "blank", amount: "" },
    { id: "bad", amount: "oops" },
  ];
  const before = structuredClone(entries);
  const projection = calculateBalanceProjection({ bankBalance: "100", overdraftLimit: "50", pendingIncomeEntries: entries, remainingExpenses: 25 });
  assert.equal(projection.pendingTotal, 25.5);
  assert.deepEqual(projection.invalidPendingAmounts.map(({ id, reason }) => ({ id, reason })), [
    { id: "blank", reason: "empty" },
    { id: "bad", reason: "invalid_format" },
  ]);
  assert.equal(projection.balanceAfterUnpaid, 75);
  assert.equal(projection.projectedAfterMoneyIn, null);
  assert.equal(projection.balanceAfterIncomingMoney, null);
  assert.equal(projection.availableWithOverdraft, null);
  assert.deepEqual(entries, before);
});

test("pending entry preparation preserves valid raw amounts and rejects blank or malformed drafts", () => {
  for (const amount of ["0", "12.50", "12,50", "-5"]) {
    const result = preparePendingIncomeEntry({ id: "pending", label: " Refund ", amount });
    assert.equal(result.ok, true);
    assert.deepEqual(result.entry, { id: "pending", label: "Refund", amount });
  }
  for (const amount of ["", "   ", "not-money"]) {
    assert.equal(preparePendingIncomeEntry({ id: "pending", label: "Refund", amount }).ok, false);
  }
});
