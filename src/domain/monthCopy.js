const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const DEFAULT_MONTH_COPY_OPTIONS = Object.freeze({
  copyIncome: true,
  copyExpenses: true,
  copyEntryNotes: true,
  copyMonthNote: false,
});

export function isValidMonthKey(value) {
  return typeof value === "string" && MONTH_KEY.test(value);
}

export function getNextMonthKey(sourceMonthKey) {
  if (!isValidMonthKey(sourceMonthKey)) return null;
  const [year, month] = sourceMonthKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isMonthMeaningfullyEmpty(month) {
  if (!month || typeof month !== "object" || Array.isArray(month)) return true;
  if (Array.isArray(month.incomes) && month.incomes.length > 0) return false;
  if (Array.isArray(month.pendingIncomeEntries) && month.pendingIncomeEntries.length > 0) return false;
  if (Array.isArray(month.transactions) && month.transactions.length > 0) return false;
  if (hasText(month.notes) || hasText(month.bankBalance) || hasText(month.overdraftLimit)) return false;
  if (hasText(month.pendingMoneyIn) || hasText(month.pendingMoneyLabel)) return false;

  const groups = Array.isArray(month.expenseGroups) ? month.expenseGroups : [];
  return !groups.some((group) => {
    if (Array.isArray(group && group.items) && group.items.length > 0) return true;
    const label = typeof group?.label === "string" ? group.label.trim() : "";
    return label !== "" && label.toLowerCase() !== "general";
  });
}

export function classifyMonthDestination(months, destinationMonthKey) {
  if (!months || !Object.prototype.hasOwnProperty.call(months, destinationMonthKey)) return "not_created";
  return isMonthMeaningfullyEmpty(months[destinationMonthKey]) ? "effectively_empty" : "has_data";
}

function nextId(idFactory, kind) {
  const id = idFactory(kind);
  if (typeof id !== "string" || id.trim() === "") throw new Error("idFactory must return a non-empty string");
  return id;
}

function copyIncomeEntry(income, options, idFactory) {
  return {
    id: nextId(idFactory, "income"),
    name: typeof income?.name === "string" ? income.name : "",
    amount: income?.amount ?? "0",
    date: "",
    status: "expected",
    notes: options.copyEntryNotes && typeof income?.notes === "string" ? income.notes : "",
  };
}

function copyExpenseEntry(expense, options, idFactory, groupId) {
  const copy = {
    id: nextId(idFactory, "expense"),
    name: typeof expense?.name === "string" ? expense.name : "",
    amount: expense?.amount ?? "0",
    dueDay: Number.isInteger(expense?.dueDay) ? expense.dueDay : null,
    paid: false,
    note: options.copyEntryNotes && typeof expense?.note === "string" ? expense.note : "",
    notePinned: options.copyEntryNotes && !!expense?.notePinned,
    noteUpdatedAt: options.copyEntryNotes && expense?.noteUpdatedAt ? expense.noteUpdatedAt : null,
  };
  if (Object.prototype.hasOwnProperty.call(expense || {}, "groupId")) copy.groupId = groupId;
  if (Object.prototype.hasOwnProperty.call(expense || {}, "categoryId")) copy.categoryId = groupId;
  return copy;
}

export function createCopiedMonth({
  sourceMonth,
  copyIncome = true,
  copyExpenses = true,
  copyEntryNotes = true,
  copyMonthNote = false,
  idFactory,
}) {
  if (!sourceMonth || typeof sourceMonth !== "object" || Array.isArray(sourceMonth)) throw new Error("sourceMonth must be an object");
  if (typeof idFactory !== "function") throw new Error("idFactory is required");
  const options = { copyEntryNotes };

  const incomes = copyIncome
    ? (Array.isArray(sourceMonth.incomes) ? sourceMonth.incomes : []).map((income) => copyIncomeEntry(income, options, idFactory))
    : [];
  let expenseGroups = copyExpenses
    ? (Array.isArray(sourceMonth.expenseGroups) ? sourceMonth.expenseGroups : []).map((group) => {
        const groupId = nextId(idFactory, "expenseGroup");
        return {
          id: groupId,
          label: typeof group?.label === "string" ? group.label : "",
          items: (Array.isArray(group?.items) ? group.items : []).map((expense) => copyExpenseEntry(expense, options, idFactory, groupId)),
        };
      })
    : [];
  if (expenseGroups.length === 0) {
    expenseGroups = [{ id: nextId(idFactory, "expenseGroup"), label: "General", items: [] }];
  }

  return {
    incomes,
    expenseGroups,
    notes: copyMonthNote && typeof sourceMonth.notes === "string" ? sourceMonth.notes : "",
    transactions: [],
    bankBalance: "",
    overdraftLimit: "",
    pendingIncomeEntries: [],
    pendingMoneyIn: "",
    pendingMoneyLabel: "",
  };
}

export function getMonthCopySummary({ sourceMonth, destinationState, copyIncome, copyExpenses, copyEntryNotes, copyMonthNote }) {
  const groups = copyExpenses && Array.isArray(sourceMonth?.expenseGroups) ? sourceMonth.expenseGroups : [];
  return {
    incomeEntries: copyIncome && Array.isArray(sourceMonth?.incomes) ? sourceMonth.incomes.length : 0,
    expenseGroups: groups.length,
    expenseEntries: groups.reduce((total, group) => total + (Array.isArray(group?.items) ? group.items.length : 0), 0),
    copyEntryNotes: !!copyEntryNotes,
    copyMonthNote: !!copyMonthNote,
    destinationState,
  };
}

export function applyMonthCopyToApp({
  app,
  sourceMonthKey,
  destinationMonthKey,
  options = DEFAULT_MONTH_COPY_OPTIONS,
  idFactory,
  confirmReplace = false,
}) {
  if (!app || typeof app !== "object") return { ok: false, code: "invalid_app" };
  if (!isValidMonthKey(sourceMonthKey) || !isValidMonthKey(destinationMonthKey)) return { ok: false, code: "invalid_month" };
  if (sourceMonthKey === destinationMonthKey) return { ok: false, code: "same_month" };
  const sourceMonth = app.months?.[sourceMonthKey];
  if (!sourceMonth) return { ok: false, code: "missing_source" };
  const destinationState = classifyMonthDestination(app.months, destinationMonthKey);
  if (destinationState === "has_data" && !confirmReplace) {
    return { ok: false, code: "confirmation_required", destinationState };
  }

  const copiedMonth = createCopiedMonth({ sourceMonth, ...DEFAULT_MONTH_COPY_OPTIONS, ...options, idFactory });
  return {
    ok: true,
    destinationState,
    copiedMonth,
    app: {
      ...app,
      activeMonth: destinationMonthKey,
      months: { ...(app.months || {}), [destinationMonthKey]: copiedMonth },
    },
  };
}
