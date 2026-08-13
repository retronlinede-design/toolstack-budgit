import test from "node:test";
import assert from "node:assert/strict";

import {
  applyMonthCopyToApp,
  applyValidatedMonthCopyToApp,
  classifyMonthDestination,
  createCopiedMonth,
  getMonthCopySummary,
  getNextMonthKey,
  isMonthMeaningfullyEmpty,
} from "../src/domain/monthCopy.js";
import { validateApplicationState } from "../src/domain/backupSchema.js";

const emptyMonth = () => ({ incomes: [], expenseGroups: [{ id: "default", label: "General", items: [] }], notes: "", transactions: [], bankBalance: "", overdraftLimit: "", pendingIncomeEntries: [], pendingMoneyIn: "", pendingMoneyLabel: "" });
const populatedMonth = () => ({
  incomes: [
    { id: "i1", name: "Salary", amount: "2000", date: "2026-07-01", status: "received", notes: "Recurring" },
    { id: "i2", name: "Late", amount: "50", date: "2026-07-10", status: "delayed", notes: "" },
    { id: "i3", name: "Cancelled", amount: "25", date: "2026-07-11", status: "cancelled", notes: "" },
  ],
  expenseGroups: [{ id: "g1", label: "Housing", items: [{ id: "e1", groupId: "g1", name: "Rent", amount: "800", dueDay: 1, paid: true, paymentDate: "2026-07-01", note: "Reference", notePinned: true, noteUpdatedAt: "2026-07-01T10:00:00.000Z" }] }],
  notes: "Month-only note",
  transactions: [{ id: "t1", amountCents: 100 }],
  bankBalance: "1500",
  overdraftLimit: "500",
  pendingIncomeEntries: [{ id: "p1", label: "Refund", amount: "20" }],
  pendingMoneyIn: "20",
  pendingMoneyLabel: "Refund",
});

function deterministicIds() {
  let number = 0;
  return (kind) => `${kind}-${++number}`;
}

test("January advances to February", () => assert.equal(getNextMonthKey("2026-01"), "2026-02"));
test("December advances to January of the next year", () => assert.equal(getNextMonthKey("2026-12"), "2027-01"));
test("invalid source month is rejected", () => assert.equal(getNextMonthKey("July 2026"), null));

test("destination cannot equal source", () => {
  const result = applyMonthCopyToApp({ app: { activeMonth: "2026-07", months: { "2026-07": emptyMonth() }, lang: "en", currency: "EUR" }, sourceMonthKey: "2026-07", destinationMonthKey: "2026-07", idFactory: deterministicIds() });
  assert.equal(result.code, "same_month");
});

test("default structural month is effectively empty", () => assert.equal(isMonthMeaningfullyEmpty(emptyMonth()), true));
test("income makes a month meaningful", () => assert.equal(isMonthMeaningfullyEmpty({ ...emptyMonth(), incomes: [{ id: "i" }] }), false));
test("expense entries make a month meaningful", () => assert.equal(isMonthMeaningfullyEmpty({ ...emptyMonth(), expenseGroups: [{ id: "g", label: "General", items: [{ id: "e" }] }] }), false));
test("a custom empty expense group makes a month meaningful", () => assert.equal(isMonthMeaningfullyEmpty({ ...emptyMonth(), expenseGroups: [{ id: "g", label: "Housing", items: [] }] }), false));
test("notes make a month meaningful", () => assert.equal(isMonthMeaningfullyEmpty({ ...emptyMonth(), notes: "Remember this" }), false));
test("entered bank balance makes a month meaningful, including zero", () => assert.equal(isMonthMeaningfullyEmpty({ ...emptyMonth(), bankBalance: "0" }), false));
test("destination states distinguish absent, empty, and populated months", () => {
  assert.equal(classifyMonthDestination({}, "2026-08"), "not_created");
  assert.equal(classifyMonthDestination({ "2026-08": emptyMonth() }, "2026-08"), "effectively_empty");
  assert.equal(classifyMonthDestination({ "2026-08": populatedMonth() }, "2026-08"), "has_data");
});

test("income entries copy when enabled and omit when disabled", () => {
  assert.equal(createCopiedMonth({ sourceMonth: populatedMonth(), copyIncome: true, idFactory: deterministicIds() }).incomes.length, 3);
  assert.equal(createCopiedMonth({ sourceMonth: populatedMonth(), copyIncome: false, idFactory: deterministicIds() }).incomes.length, 0);
});

test("expense groups and entries copy when enabled and omit when disabled", () => {
  const copied = createCopiedMonth({ sourceMonth: populatedMonth(), copyExpenses: true, idFactory: deterministicIds() });
  assert.equal(copied.expenseGroups.length, 1);
  assert.equal(copied.expenseGroups[0].items.length, 1);
  const withoutExpenses = createCopiedMonth({ sourceMonth: populatedMonth(), copyExpenses: false, idFactory: deterministicIds() });
  assert.equal(withoutExpenses.expenseGroups.length, 1);
  assert.equal(withoutExpenses.expenseGroups[0].label, "General");
  assert.deepEqual(withoutExpenses.expenseGroups[0].items, []);
});

test("paid expenses reset to unpaid and payment metadata is not carried", () => {
  const expense = createCopiedMonth({ sourceMonth: populatedMonth(), idFactory: deterministicIds() }).expenseGroups[0].items[0];
  assert.equal(expense.paid, false);
  assert.equal(Object.hasOwn(expense, "paymentDate"), false);
});

test("all income statuses reset to expected and receipt dates clear", () => {
  const incomes = createCopiedMonth({ sourceMonth: populatedMonth(), idFactory: deterministicIds() }).incomes;
  assert.deepEqual(incomes.map((income) => income.status), ["expected", "expected", "expected"]);
  assert.deepEqual(incomes.map((income) => income.date), ["", "", ""]);
});

test("temporary balances, pending money, overdraft, and transaction remnants do not copy", () => {
  const copied = createCopiedMonth({ sourceMonth: populatedMonth(), idFactory: deterministicIds() });
  assert.equal(copied.bankBalance, "");
  assert.equal(copied.overdraftLimit, "");
  assert.deepEqual(copied.pendingIncomeEntries, []);
  assert.equal(copied.pendingMoneyIn, "");
  assert.equal(copied.pendingMoneyLabel, "");
  assert.deepEqual(copied.transactions, []);
});

test("entry notes copy when enabled and clear when disabled", () => {
  const withNotes = createCopiedMonth({ sourceMonth: populatedMonth(), copyEntryNotes: true, idFactory: deterministicIds() });
  assert.equal(withNotes.incomes[0].notes, "Recurring");
  assert.equal(withNotes.expenseGroups[0].items[0].note, "Reference");
  const withoutNotes = createCopiedMonth({ sourceMonth: populatedMonth(), copyEntryNotes: false, idFactory: deterministicIds() });
  assert.equal(withoutNotes.incomes[0].notes, "");
  assert.equal(withoutNotes.expenseGroups[0].items[0].note, "");
  assert.equal(withoutNotes.expenseGroups[0].items[0].notePinned, false);
});

test("month note copies only when enabled", () => {
  assert.equal(createCopiedMonth({ sourceMonth: populatedMonth(), copyMonthNote: true, idFactory: deterministicIds() }).notes, "Month-only note");
  assert.equal(createCopiedMonth({ sourceMonth: populatedMonth(), copyMonthNote: false, idFactory: deterministicIds() }).notes, "");
});

test("copied records get new IDs and group references are updated", () => {
  const copied = createCopiedMonth({ sourceMonth: populatedMonth(), idFactory: deterministicIds() });
  assert.notEqual(copied.incomes[0].id, "i1");
  assert.notEqual(copied.expenseGroups[0].id, "g1");
  assert.notEqual(copied.expenseGroups[0].items[0].id, "e1");
  assert.equal(copied.expenseGroups[0].items[0].groupId, copied.expenseGroups[0].id);
});

test("source is not mutated and copied data shares no mutable nested references", () => {
  const source = populatedMonth();
  const snapshot = structuredClone(source);
  const copied = createCopiedMonth({ sourceMonth: source, idFactory: deterministicIds() });
  assert.deepEqual(source, snapshot);
  assert.notEqual(copied.incomes, source.incomes);
  assert.notEqual(copied.incomes[0], source.incomes[0]);
  assert.notEqual(copied.expenseGroups, source.expenseGroups);
  assert.notEqual(copied.expenseGroups[0], source.expenseGroups[0]);
  assert.notEqual(copied.expenseGroups[0].items[0], source.expenseGroups[0].items[0]);
});

test("copy summary counts enabled records and options", () => {
  assert.deepEqual(getMonthCopySummary({ sourceMonth: populatedMonth(), destinationState: "not_created", copyIncome: true, copyExpenses: true, copyEntryNotes: false, copyMonthNote: true }), {
    incomeEntries: 3, expenseGroups: 1, expenseEntries: 1, copyEntryNotes: false, copyMonthNote: true, destinationState: "not_created",
  });
});

test("populated destination is not replaced without explicit confirmation", () => {
  const destination = populatedMonth();
  const app = { activeMonth: "2026-07", months: { "2026-07": populatedMonth(), "2026-08": destination }, lang: "en", currency: "EUR" };
  const result = applyMonthCopyToApp({ app, sourceMonthKey: "2026-07", destinationMonthKey: "2026-08", idFactory: deterministicIds() });
  assert.equal(result.code, "confirmation_required");
  assert.equal(app.months["2026-08"], destination);
});

test("confirmed state update changes only destination and active month", () => {
  const source = populatedMonth();
  const unrelated = populatedMonth();
  const destination = populatedMonth();
  const app = { activeMonth: "2026-07", months: { "2026-07": source, "2026-08": destination, "2026-06": unrelated }, lang: "de", currency: "GBP" };
  const result = applyMonthCopyToApp({ app, sourceMonthKey: "2026-07", destinationMonthKey: "2026-08", idFactory: deterministicIds(), confirmReplace: true });
  assert.equal(result.ok, true);
  assert.equal(result.app.activeMonth, "2026-08");
  assert.equal(result.app.lang, "de");
  assert.equal(result.app.currency, "GBP");
  assert.equal(result.app.months["2026-07"], source);
  assert.equal(result.app.months["2026-06"], unrelated);
  assert.notEqual(result.app.months["2026-08"], destination);
});

test("validated copy creates an absent next month and produces fresh persistable data", () => {
  const source = { ...populatedMonth(), transactions: [] };
  const sourceSnapshot = structuredClone(source);
  const app = { activeMonth: "2026-07", months: { "2026-07": source }, lang: "en", currency: "EUR" };
  const result = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    idFactory: deterministicIds(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.destinationState, "not_created");
  assert.equal(result.app.activeMonth, "2026-08");
  assert.deepEqual(source, sourceSnapshot);
  assert.notEqual(result.copiedMonth.incomes[0].id, source.incomes[0].id);
  assert.notEqual(result.copiedMonth.expenseGroups[0].items[0].id, source.expenseGroups[0].items[0].id);
  assert.equal(validateApplicationState(result.app).valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.app)), result.app);
});

test("unrelated invalid historical data does not block a valid copy or get rewritten", () => {
  const source = { ...populatedMonth(), transactions: [] };
  const invalidHistory = {
    ...emptyMonth(),
    incomes: [{ id: "old-income", name: "Legacy bad value", amount: "not-money", date: "", status: "expected", notes: "keep exactly" }],
  };
  const app = {
    activeMonth: "2026-07",
    months: { "2026-05": invalidHistory, "2026-07": source },
    lang: "en",
    currency: "EUR",
  };
  assert.equal(validateApplicationState(app).valid, false);

  const result = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    idFactory: deterministicIds(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.app.months["2026-05"], invalidHistory);
  assert.deepEqual(result.app.months["2026-05"], invalidHistory);
  assert.equal(result.app.months["2026-07"], source);
  assert.equal(result.app.months["2026-08"], result.copiedMonth);
});

test("invalid copied source data is rejected with a precise field error", () => {
  const source = {
    ...emptyMonth(),
    incomes: [{ id: "bad", name: "Broken", amount: "not-money", date: "", status: "expected", notes: "" }],
  };
  const snapshot = structuredClone(source);
  const app = { activeMonth: "2026-07", months: { "2026-07": source }, lang: "en", currency: "EUR" };
  const result = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    idFactory: deterministicIds(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_copied_month");
  assert.equal(result.validationErrors[0].path, "months.2026-08.incomes[0].amount");
  assert.equal(result.validationErrors[0].code, "invalid_amount");
  assert.deepEqual(source, snapshot);
  assert.equal(Object.hasOwn(app.months, "2026-08"), false);
});

test("validated copy still requires authorization before replacing meaningful data", () => {
  const destination = populatedMonth();
  const app = { activeMonth: "2026-07", months: { "2026-07": populatedMonth(), "2026-08": destination }, lang: "en", currency: "EUR" };
  const result = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    idFactory: deterministicIds(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "confirmation_required");
  assert.equal(app.months["2026-08"], destination);
});

test("validated copy rejects malformed options and unsafe generated IDs", () => {
  const app = { activeMonth: "2026-07", months: { "2026-07": populatedMonth() }, lang: "en", currency: "EUR" };
  const invalidOptions = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    options: { copyIncome: "yes" },
    idFactory: deterministicIds(),
  });
  assert.equal(invalidOptions.code, "invalid_copy_options");
  assert.equal(invalidOptions.validationErrors[0].path, "copyOptions.copyIncome");

  const invalidIds = applyValidatedMonthCopyToApp({
    app,
    sourceMonthKey: "2026-07",
    destinationMonthKey: "2026-08",
    idFactory: () => "",
  });
  assert.equal(invalidIds.code, "copy_generation_failed");
  assert.equal(invalidIds.validationErrors[0].code, "invalid_generated_id");
  assert.equal(Object.hasOwn(app.months, "2026-08"), false);
});
