import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKUP_APP_ID,
  BACKUP_LIMITS,
  BACKUP_SCHEMA_VERSION,
  createBackupEnvelope,
  parseAndValidateBackup,
  prepareRestoredApp,
  validateBackupObject,
} from "../src/domain/backupSchema.js";

function validMonth() {
  return {
    incomes: [{ id: "income-1", name: "Salary", amount: "2000", date: "2026-07-01", status: "received", notes: "Monthly salary" }],
    expenseGroups: [{
      id: "group-1",
      label: "General",
      items: [{ id: "expense-1", name: "Rent", amount: "800", dueDay: 1, paid: false, note: "", notePinned: false, noteUpdatedAt: null }],
    }],
    notes: "July plan",
    transactions: [{ id: "transaction-1", dateISO: "2026-07-01T10:00:00.000Z", amountCents: 100, groupId: "group-1", itemId: "expense-1", note: "Legacy remnant", paymentMethod: "Card" }],
    bankBalance: "1500",
    overdraftLimit: "500",
    pendingIncomeEntries: [{ id: "pending-1", label: "Refund", amount: "25" }],
    pendingMoneyIn: "",
    pendingMoneyLabel: "",
  };
}

function validApp() {
  return { activeMonth: "2026-07", months: { "2026-07": validMonth() }, lang: "en", currency: "EUR" };
}

function validEnvelope() {
  return { schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: "2026-07-19T12:00:00.000Z", app: BACKUP_APP_ID, data: validApp() };
}

function expectError(result, code) {
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === code), true, `Expected ${code}: ${JSON.stringify(result.errors)}`);
}

test("valid current-version backup is accepted", () => {
  const result = validateBackupObject(validEnvelope());
  assert.equal(result.valid, true);
  assert.equal(result.format, "versioned");
  assert.deepEqual(result.summary, { months: 1, incomes: 1, expenses: 1 });
});

test("new backups use the documented readable version 1 envelope", () => {
  const result = createBackupEnvelope(validApp(), "2026-07-19T12:00:00.000Z");
  assert.equal(result.valid, true);
  assert.equal(result.envelope.schemaVersion, 1);
  assert.equal(result.envelope.app, "BudgIt");
  assert.equal(result.envelope.exportedAt, "2026-07-19T12:00:00.000Z");
  assert.equal(result.envelope.data.months["2026-07"].incomes[0].amount, "2000");
});

test("recognized legacy direct app-state backup is accepted", () => {
  const result = validateBackupObject(validApp());
  assert.equal(result.valid, true);
  assert.equal(result.format, "legacy");
  assert.equal(result.data.activeMonth, "2026-07");
});

test("known flat legacy expenses normalize into a General expense group", () => {
  const legacy = validApp();
  legacy.months["2026-07"].expenses = legacy.months["2026-07"].expenseGroups[0].items;
  delete legacy.months["2026-07"].expenseGroups;
  const result = validateBackupObject(legacy);
  assert.equal(result.valid, true);
  assert.equal(result.data.months["2026-07"].expenseGroups[0].label, "General");
  assert.equal(result.data.months["2026-07"].expenseGroups[0].items[0].id, "expense-1");
});

test("unsupported schema version is rejected", () => {
  const backup = validEnvelope();
  backup.schemaVersion = 2;
  expectError(validateBackupObject(backup), "unsupported_schema_version");
});

test("wrong application identifier is rejected", () => {
  const backup = validEnvelope();
  backup.app = "AnotherApp";
  expectError(validateBackupObject(backup), "wrong_application");
});

test("null, arrays, and unrelated objects are invalid roots", () => {
  expectError(validateBackupObject(null), "invalid_root");
  expectError(validateBackupObject([]), "invalid_root");
  expectError(validateBackupObject({ months: {} }), "unrecognized_legacy_backup");
});

test("invalid month key is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["July-2026"] = backup.data.months["2026-07"];
  delete backup.data.months["2026-07"];
  backup.data.activeMonth = "July-2026";
  expectError(validateBackupObject(backup), "invalid_month_key");
});

test("invalid month shape is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"] = [];
  expectError(validateBackupObject(backup), "invalid_month");
});

test("malformed monetary value is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes[0].amount = "1,234.56";
  expectError(validateBackupObject(backup), "invalid_amount");
});

test("negative expense is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].expenseGroups[0].items[0].amount = "-1";
  expectError(validateBackupObject(backup), "negative_amount");
});

test("unsupported income status is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes[0].status = "maybe";
  expectError(validateBackupObject(backup), "unsupported_income_status");
});

test("duplicate income IDs are rejected with their location", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes.push({ ...backup.data.months["2026-07"].incomes[0] });
  const result = validateBackupObject(backup);
  expectError(result, "duplicate_id");
  assert.match(result.errors.find((error) => error.code === "duplicate_id").path, /incomes\[1\]\.id/);
});

test("duplicate expense IDs across groups are rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].expenseGroups.push({ id: "group-2", label: "Other", items: [{ ...backup.data.months["2026-07"].expenseGroups[0].items[0] }] });
  expectError(validateBackupObject(backup), "duplicate_id");
});

test("duplicate group IDs are rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].expenseGroups.push({ id: "group-1", label: "Other", items: [] });
  expectError(validateBackupObject(backup), "duplicate_id");
});

test("invalid language is rejected", () => {
  const backup = validEnvelope();
  backup.data.lang = "fr";
  expectError(validateBackupObject(backup), "unsupported_language");
});

test("invalid currency is rejected rather than silently replaced", () => {
  const backup = validEnvelope();
  backup.data.currency = "BTC";
  expectError(validateBackupObject(backup), "unsupported_currency");
});

test("oversized collections are rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes = Array.from({ length: BACKUP_LIMITS.maxEntriesPerCollection + 1 }, (_, index) => ({ id: `income-${index}`, name: "Income", amount: "1", date: "", status: "expected", notes: "" }));
  expectError(validateBackupObject(backup), "collection_too_large");
});

test("excessive text length is rejected", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].notes = "x".repeat(BACKUP_LIMITS.maxNoteLength + 1);
  expectError(validateBackupObject(backup), "text_too_long");
});

test("valid zero amounts remain valid", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes[0].amount = "0";
  backup.data.months["2026-07"].expenseGroups[0].items[0].amount = 0;
  assert.equal(validateBackupObject(backup).valid, true);
});

test("malformed JSON returns a structured result without throwing", () => {
  expectError(parseAndValidateBackup("{not-json"), "invalid_json");
});

test("validated data normalizes into the existing application state shape", () => {
  const result = validateBackupObject(validEnvelope());
  assert.deepEqual(Object.keys(result.data).sort(), ["activeMonth", "currency", "lang", "months"]);
  assert.deepEqual(Object.keys(result.data.months["2026-07"]).sort(), [
    "bankBalance", "expenseGroups", "incomes", "notes", "overdraftLimit", "pendingIncomeEntries", "pendingMoneyIn", "pendingMoneyLabel", "transactions",
  ]);
});

test("restore preserves current interface language and restores backup currency", () => {
  const data = validApp();
  data.lang = "en";
  data.currency = "GBP";
  const restored = prepareRestoredApp(data, "de");
  assert.equal(restored.lang, "de");
  assert.equal(restored.currency, "GBP");
});

test("validation errors are capped", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].incomes = Array.from({ length: 100 }, (_, index) => ({ id: "", name: 1, amount: "bad", date: "bad", status: "bad", notes: 1, index }));
  const result = validateBackupObject(backup);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, BACKUP_LIMITS.maxErrors);
});

test("invalid results never contain NaN or Infinity", () => {
  const backup = validEnvelope();
  backup.data.months["2026-07"].bankBalance = Infinity;
  backup.data.months["2026-07"].transactions[0].amountCents = NaN;
  const result = validateBackupObject(backup);
  expectError(result, "invalid_amount");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("NaN"), false);
  assert.equal(serialized.includes("Infinity"), false);
});
