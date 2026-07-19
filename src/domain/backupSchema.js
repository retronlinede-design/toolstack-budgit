import { INCOME_STATUSES, parseMoney } from "./calculations.js";

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_APP_ID = "BudgIt";
export const BACKUP_LIMITS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxErrors: 50,
  maxMonths: 240,
  maxGroupsPerMonth: 100,
  maxEntriesPerCollection: 1000,
  maxNameLength: 200,
  maxNoteLength: 10000,
  maxShortTextLength: 500,
});

const SUPPORTED_LANGUAGES = new Set(["en", "de"]);
const SUPPORTED_CURRENCIES = new Set(["EUR", "USD", "GBP", "ZAR"]);
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function dateOnlyIsValid(value) {
  if (value === "") return true;
  if (typeof value !== "string" || !DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDateIsValid(value) {
  return typeof value === "string" && value.length <= BACKUP_LIMITS.maxShortTextLength && Number.isFinite(Date.parse(value));
}

function createContext() {
  const errors = [];
  return {
    errors,
    add(path, code, message) {
      if (errors.length < BACKUP_LIMITS.maxErrors) errors.push({ path, code, message });
    },
  };
}

function validateBoundedString(ctx, value, path, maxLength, { allowEmpty = true } = {}) {
  if (typeof value !== "string") {
    ctx.add(path, "invalid_type", "Must be text.");
    return false;
  }
  if (!allowEmpty && value.trim().length === 0) {
    ctx.add(path, "empty_value", "Must not be empty.");
    return false;
  }
  if (value.length > maxLength) {
    ctx.add(path, "text_too_long", `Must be ${maxLength} characters or fewer.`);
    return false;
  }
  return true;
}

function validateId(ctx, value, path, ids, collectionName) {
  if (!validateBoundedString(ctx, value, path, BACKUP_LIMITS.maxNameLength, { allowEmpty: false })) return false;
  if (ids.has(value)) {
    ctx.add(path, "duplicate_id", `Duplicate ${collectionName} ID “${value}”.`);
    return false;
  }
  ids.add(value);
  return true;
}

function validateAmount(ctx, value, path, { nonNegative = false } = {}) {
  const parsed = parseMoney(value);
  if (!parsed.valid) {
    ctx.add(path, "invalid_amount", "Must be a plain finite decimal amount.");
    return false;
  }
  if (nonNegative && parsed.value < 0) {
    ctx.add(path, "negative_amount", "Expense amounts cannot be negative.");
    return false;
  }
  return true;
}

function validateCollection(ctx, value, path, max = BACKUP_LIMITS.maxEntriesPerCollection) {
  if (!Array.isArray(value)) {
    ctx.add(path, "invalid_collection", "Must be a list.");
    return false;
  }
  if (value.length > max) {
    ctx.add(path, "collection_too_large", `Must contain no more than ${max} entries.`);
    return false;
  }
  return true;
}

function validateIncome(ctx, income, path, ids, legacy) {
  if (!isPlainObject(income)) {
    ctx.add(path, "invalid_record", "Income entry must be an object.");
    return null;
  }
  validateId(ctx, income.id, `${path}.id`, ids, "income");
  validateBoundedString(ctx, income.name ?? "", `${path}.name`, BACKUP_LIMITS.maxNameLength);
  validateAmount(ctx, income.amount, `${path}.amount`);
  const status = income.status == null && legacy ? "expected" : income.status;
  if (!INCOME_STATUSES.includes(status)) ctx.add(`${path}.status`, "unsupported_income_status", "Income status is not supported.");
  const date = income.date ?? "";
  if (!dateOnlyIsValid(date)) ctx.add(`${path}.date`, "invalid_date", "Date must be empty or a valid YYYY-MM-DD date.");
  validateBoundedString(ctx, income.notes ?? "", `${path}.notes`, BACKUP_LIMITS.maxNoteLength);
  return { id: income.id, name: income.name ?? "", amount: income.amount, date, status: INCOME_STATUSES.includes(status) ? status : "expected", notes: income.notes ?? "" };
}

function validateExpense(ctx, expense, path, ids, legacy) {
  if (!isPlainObject(expense)) {
    ctx.add(path, "invalid_record", "Expense entry must be an object.");
    return null;
  }
  validateId(ctx, expense.id, `${path}.id`, ids, "expense");
  validateBoundedString(ctx, expense.name ?? "", `${path}.name`, BACKUP_LIMITS.maxNameLength);
  validateAmount(ctx, expense.amount, `${path}.amount`, { nonNegative: true });
  const paid = expense.paid == null && legacy ? false : expense.paid;
  if (typeof paid !== "boolean") ctx.add(`${path}.paid`, "invalid_paid_state", "Paid must be true or false.");
  const dueDay = expense.dueDay ?? null;
  if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
    ctx.add(`${path}.dueDay`, "invalid_due_day", "Due day must be null or an integer from 1 to 31.");
  }
  validateBoundedString(ctx, expense.note ?? "", `${path}.note`, BACKUP_LIMITS.maxNoteLength);
  const notePinned = expense.notePinned ?? false;
  if (typeof notePinned !== "boolean") ctx.add(`${path}.notePinned`, "invalid_note_pin", "Note pin must be true or false.");
  const noteUpdatedAt = expense.noteUpdatedAt ?? null;
  if (noteUpdatedAt !== null && !isoDateIsValid(noteUpdatedAt)) ctx.add(`${path}.noteUpdatedAt`, "invalid_timestamp", "Note timestamp is invalid.");
  return {
    id: expense.id,
    name: expense.name ?? "",
    amount: expense.amount,
    dueDay,
    paid: typeof paid === "boolean" ? paid : false,
    note: expense.note ?? "",
    notePinned: typeof notePinned === "boolean" ? notePinned : false,
    noteUpdatedAt,
  };
}

function validatePendingIncome(ctx, entry, path, ids) {
  if (!isPlainObject(entry)) {
    ctx.add(path, "invalid_record", "Expected incoming money entry must be an object.");
    return null;
  }
  validateId(ctx, entry.id, `${path}.id`, ids, "pending income");
  validateBoundedString(ctx, entry.label ?? "", `${path}.label`, BACKUP_LIMITS.maxNameLength);
  validateAmount(ctx, entry.amount, `${path}.amount`);
  return { id: entry.id, label: entry.label ?? "", amount: entry.amount };
}

function validateTransaction(ctx, transaction, path, ids) {
  if (!isPlainObject(transaction)) {
    ctx.add(path, "invalid_record", "Transaction remnant must be an object.");
    return null;
  }
  validateId(ctx, transaction.id, `${path}.id`, ids, "transaction");
  if (!isoDateIsValid(transaction.dateISO)) ctx.add(`${path}.dateISO`, "invalid_timestamp", "Transaction timestamp is invalid.");
  if (!Number.isSafeInteger(transaction.amountCents)) ctx.add(`${path}.amountCents`, "invalid_amount_cents", "Transaction amount must be a safe integer number of cents.");
  for (const field of ["groupId", "itemId"]) {
    if (transaction[field] !== null && transaction[field] !== undefined && !validateBoundedString(ctx, transaction[field], `${path}.${field}`, BACKUP_LIMITS.maxNameLength, { allowEmpty: false })) break;
  }
  validateBoundedString(ctx, transaction.note ?? "", `${path}.note`, BACKUP_LIMITS.maxNoteLength);
  validateBoundedString(ctx, transaction.paymentMethod ?? "Card", `${path}.paymentMethod`, BACKUP_LIMITS.maxNameLength);
  return {
    id: transaction.id,
    dateISO: transaction.dateISO,
    amountCents: transaction.amountCents,
    groupId: transaction.groupId ?? null,
    itemId: transaction.itemId ?? null,
    note: transaction.note ?? "",
    paymentMethod: transaction.paymentMethod ?? "Card",
  };
}

function validateMonth(ctx, month, monthKey, legacy) {
  const path = `months.${monthKey}`;
  if (!isPlainObject(month)) {
    ctx.add(path, "invalid_month", "Month data must be an object.");
    return null;
  }

  const incomeIds = new Set();
  const groupIds = new Set();
  const expenseIds = new Set();
  const pendingIds = new Set();
  const transactionIds = new Set();

  const incomesSource = month.incomes ?? [];
  const incomes = validateCollection(ctx, incomesSource, `${path}.incomes`)
    ? incomesSource.map((item, index) => validateIncome(ctx, item, `${path}.incomes[${index}]`, incomeIds, legacy)).filter(Boolean)
    : [];

  let groupsSource = month.expenseGroups;
  if (groupsSource === undefined && legacy && Array.isArray(month.expenses)) {
    groupsSource = [{ id: `legacy-general-${monthKey}`, label: "General", items: month.expenses }];
  }
  const expenseGroups = [];
  if (validateCollection(ctx, groupsSource, `${path}.expenseGroups`, BACKUP_LIMITS.maxGroupsPerMonth)) {
    groupsSource.forEach((group, groupIndex) => {
      const groupPath = `${path}.expenseGroups[${groupIndex}]`;
      if (!isPlainObject(group)) {
        ctx.add(groupPath, "invalid_group", "Expense group must be an object.");
        return;
      }
      validateId(ctx, group.id, `${groupPath}.id`, groupIds, "group");
      validateBoundedString(ctx, group.label ?? "", `${groupPath}.label`, BACKUP_LIMITS.maxNameLength);
      const itemsSource = group.items ?? [];
      const items = validateCollection(ctx, itemsSource, `${groupPath}.items`)
        ? itemsSource.map((item, itemIndex) => validateExpense(ctx, item, `${groupPath}.items[${itemIndex}]`, expenseIds, legacy)).filter(Boolean)
        : [];
      expenseGroups.push({ id: group.id, label: group.label ?? "", items });
    });
  }

  let pendingSource = month.pendingIncomeEntries;
  if (pendingSource === undefined && legacy) {
    const parsedLegacyPending = parseMoney(month.pendingMoneyIn ?? "");
    pendingSource = parsedLegacyPending.valid && parsedLegacyPending.value !== 0
      ? [{ id: `legacy-pending-${monthKey}`, label: month.pendingMoneyLabel ?? "Pending", amount: month.pendingMoneyIn }]
      : [];
  }
  const pendingIncomeEntries = validateCollection(ctx, pendingSource ?? [], `${path}.pendingIncomeEntries`)
    ? (pendingSource ?? []).map((item, index) => validatePendingIncome(ctx, item, `${path}.pendingIncomeEntries[${index}]`, pendingIds)).filter(Boolean)
    : [];

  const transactionsSource = month.transactions ?? [];
  const transactions = validateCollection(ctx, transactionsSource, `${path}.transactions`)
    ? transactionsSource.map((item, index) => validateTransaction(ctx, item, `${path}.transactions[${index}]`, transactionIds)).filter(Boolean)
    : [];

  validateBoundedString(ctx, month.notes ?? "", `${path}.notes`, BACKUP_LIMITS.maxNoteLength);
  const bankBalance = month.bankBalance ?? "";
  if (bankBalance !== "") validateAmount(ctx, bankBalance, `${path}.bankBalance`);
  const overdraftLimit = month.overdraftLimit ?? "";
  if (overdraftLimit !== "") validateAmount(ctx, overdraftLimit, `${path}.overdraftLimit`, { nonNegative: true });
  const pendingMoneyIn = month.pendingMoneyIn ?? "";
  if (pendingMoneyIn !== "") validateAmount(ctx, pendingMoneyIn, `${path}.pendingMoneyIn`);
  validateBoundedString(ctx, month.pendingMoneyLabel ?? "", `${path}.pendingMoneyLabel`, BACKUP_LIMITS.maxNameLength);

  return {
    incomes,
    expenseGroups,
    notes: month.notes ?? "",
    transactions,
    bankBalance,
    overdraftLimit,
    pendingIncomeEntries,
    pendingMoneyIn,
    pendingMoneyLabel: month.pendingMoneyLabel ?? "",
  };
}

function recognizeLegacyRoot(root) {
  return isPlainObject(root)
    && typeof root.activeMonth === "string"
    && Object.prototype.hasOwnProperty.call(root, "months")
    && typeof root.lang === "string"
    && typeof root.currency === "string";
}

function validateApplicationData(data, { legacy = false } = {}) {
  const ctx = createContext();
  if (!isPlainObject(data)) {
    ctx.add("data", "invalid_app_data", "Backup data must be an object.");
    return { valid: false, errors: ctx.errors };
  }

  if (!SUPPORTED_LANGUAGES.has(data.lang)) ctx.add("lang", "unsupported_language", "Language must be English or German.");
  if (!SUPPORTED_CURRENCIES.has(data.currency)) ctx.add("currency", "unsupported_currency", "Currency is not supported by BudgIt.");
  if (!MONTH_KEY.test(data.activeMonth)) ctx.add("activeMonth", "invalid_month_key", "Active month must use YYYY-MM format.");

  if (!isPlainObject(data.months)) {
    ctx.add("months", "invalid_months", "Months must be an object keyed by YYYY-MM.");
    return { valid: false, errors: ctx.errors };
  }

  const monthEntries = Object.entries(data.months);
  if (monthEntries.length > BACKUP_LIMITS.maxMonths) ctx.add("months", "too_many_months", `Backup can contain at most ${BACKUP_LIMITS.maxMonths} months.`);
  const months = {};
  let incomeCount = 0;
  let expenseCount = 0;
  for (const [key, month] of monthEntries.slice(0, BACKUP_LIMITS.maxMonths)) {
    if (!MONTH_KEY.test(key)) {
      ctx.add(`months.${key}`, "invalid_month_key", "Month key must use valid YYYY-MM format.");
      continue;
    }
    const normalized = validateMonth(ctx, month, key, legacy);
    if (normalized) {
      months[key] = normalized;
      incomeCount += normalized.incomes.length;
      expenseCount += normalized.expenseGroups.reduce((sum, group) => sum + group.items.length, 0);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(months, data.activeMonth)) {
    ctx.add("activeMonth", "missing_active_month", "Active month must exist in the backup.");
  }

  if (ctx.errors.length) return { valid: false, errors: ctx.errors };
  return {
    valid: true,
    errors: [],
    data: { activeMonth: data.activeMonth, months, lang: data.lang, currency: data.currency },
    summary: { months: monthEntries.length, incomes: incomeCount, expenses: expenseCount },
  };
}

export function validateBackupObject(root) {
  if (!isPlainObject(root)) {
    return { valid: false, format: "unknown", errors: [{ path: "$", code: "invalid_root", message: "Backup must contain a JSON object." }] };
  }

  if (Object.prototype.hasOwnProperty.call(root, "schemaVersion")) {
    if (root.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      return { valid: false, format: "versioned", errors: [{ path: "schemaVersion", code: "unsupported_schema_version", message: `Backup version ${String(root.schemaVersion)} is not supported.` }] };
    }
    if (root.app !== BACKUP_APP_ID) {
      return { valid: false, format: "versioned", errors: [{ path: "app", code: "wrong_application", message: "This file is not a BudgIt backup." }] };
    }
    if (!isoDateIsValid(root.exportedAt)) {
      return { valid: false, format: "versioned", errors: [{ path: "exportedAt", code: "invalid_export_timestamp", message: "Backup export timestamp is invalid." }] };
    }
    const result = validateApplicationData(root.data);
    return { ...result, format: "versioned", schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: root.exportedAt };
  }

  if (!recognizeLegacyRoot(root)) {
    return { valid: false, format: "unknown", errors: [{ path: "$", code: "unrecognized_legacy_backup", message: "This is not a recognized BudgIt backup." }] };
  }
  return { ...validateApplicationData(root, { legacy: true }), format: "legacy", schemaVersion: 0 };
}

export function parseAndValidateBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, format: "unknown", errors: [{ path: "$", code: "invalid_json", message: "The selected file is not valid JSON." }] };
  }
  return validateBackupObject(parsed);
}

export function createBackupEnvelope(appData, exportedAt = new Date().toISOString()) {
  const validation = validateApplicationData(appData);
  if (!validation.valid) return validation;
  return {
    valid: true,
    errors: [],
    envelope: { schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt, app: BACKUP_APP_ID, data: validation.data },
  };
}

export function prepareRestoredApp(validatedData, currentLanguage) {
  return {
    activeMonth: validatedData.activeMonth,
    months: validatedData.months,
    lang: SUPPORTED_LANGUAGES.has(currentLanguage) ? currentLanguage : "en",
    currency: validatedData.currency,
  };
}
