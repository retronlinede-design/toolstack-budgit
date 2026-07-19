import test from "node:test";
import assert from "node:assert/strict";

import { formatMobileDueDate, getMobileExpensePresentation, getMobileIncomePresentation } from "../src/domain/mobilePresentation.js";

test("mobile income data maps supported fields without mutation", () => {
  const source = { id: "i1", name: "Salary", amount: "1200", status: "received", date: "2026-07-02", notes: "Monthly" };
  const before = structuredClone(source);
  assert.deepEqual(getMobileIncomePresentation(source), source);
  assert.deepEqual(source, before);
});

test("mobile expense data maps supported fields without mutation", () => {
  const source = { id: "e1", name: "Rent", amount: "700", paid: false, dueDay: 5, note: "Standing order" };
  const before = structuredClone(source);
  assert.deepEqual(getMobileExpensePresentation(source, { activeMonth: "2026-08", language: "en" }), {
    id: "e1", name: "Rent", amount: "700", paid: false, paidLabel: "Unpaid", dueLabel: "August 5", notes: "Standing order",
  });
  assert.deepEqual(source, before);
});

test("missing income and expense notes are omitted", () => {
  assert.equal(getMobileIncomePresentation({ notes: "" }).notes, null);
  assert.equal(getMobileExpensePresentation({ note: "  " }).notes, null);
});

test("missing and invalid due days are omitted", () => {
  assert.equal(formatMobileDueDate("2026-07", null), null);
  assert.equal(formatMobileDueDate("2026-07", 0), null);
  assert.equal(formatMobileDueDate("2026-07", 32), null);
  assert.equal(formatMobileDueDate("invalid", 5), null);
});

test("paid and unpaid labels are explicit", () => {
  assert.equal(getMobileExpensePresentation({ paid: true }, { language: "en" }).paidLabel, "Paid");
  assert.equal(getMobileExpensePresentation({ paid: false }, { language: "en" }).paidLabel, "Unpaid");
});

test("valid due dates are localized and clamp to the month end", () => {
  assert.equal(formatMobileDueDate("2026-02", 31, "en"), "February 28");
  assert.equal(formatMobileDueDate("2024-02", 31, "en"), "February 29");
});

test("German formatter and paid labels are localized", () => {
  assert.equal(formatMobileDueDate("2026-08", 5, "de"), "5. August");
  assert.equal(getMobileExpensePresentation({ paid: true }, { language: "de" }).paidLabel, "Bezahlt");
  assert.equal(getMobileExpensePresentation({ paid: false }, { language: "de" }).paidLabel, "Offen");
});

test("presentation mapping creates detached objects and leaves desktop data intact", () => {
  const income = { id: "i", name: "Pay", amount: "1", status: "expected", extra: "desktop-only" };
  const expense = { id: "e", name: "Bill", amount: "2", paid: false, dueDay: 1, extra: "desktop-only" };
  const mobileIncome = getMobileIncomePresentation(income);
  const mobileExpense = getMobileExpensePresentation(expense, { activeMonth: "2026-07" });
  mobileIncome.name = "Changed";
  mobileExpense.name = "Changed";
  assert.equal(income.name, "Pay");
  assert.equal(expense.name, "Bill");
  assert.equal(income.extra, "desktop-only");
  assert.equal(expense.extra, "desktop-only");
});
