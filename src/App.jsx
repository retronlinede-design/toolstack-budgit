/*
  FEATURE UPDATE: Item Notes System

  This update introduces a system for adding notes to individual expense items.

  1.  **Data Model & Migration**:
      - `normalizeExpenseItem` now includes `note`, `notePinned`, and `noteUpdatedAt` fields.
      - This ensures backward compatibility by safely adding these fields with default values to any existing data upon loading.

  2.  **UI - Note Button & Editor**:
      - Each expense item row now has a "Note" button, which shows a checkmark if a note exists.
      - Clicking this button opens the `NoteEditorModal`, a new component for adding, editing, and pinning notes.

  3.  **UI - Consolidated Notes Panel**:
      - A new `NotesPanel` component has been added below the "Spend Tracker".
      - It displays all non-empty notes, sorted by pinned status, then by section and item name.
      - Each note has a "Jump to item" button that smoothly scrolls the corresponding expense item into view and briefly highlights it.

  4.  **Export/Import**:
      - The new note-related fields are automatically included in JSON exports.
      - The import process is backward-compatible and correctly handles both old and new data formats.
*/
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import budgitLogo from "./assets/budgit-graffiti.png";
import {
  INCOME_STATUSES,
  calculateBalanceProjection,
  calculateExpenseGroupTotals,
  calculateMonthTotals,
  getMoneyDisplayValue,
  parseMoney,
} from "./domain/calculations.js";
import { createExpenseAttentionSummary, formatSavingsRate } from "./domain/dashboardSummary.js";
import { normalizeExpenseDueDay } from "./domain/dueDay.js";
import { getMobileExpensePresentation, getMobileIncomePresentation } from "./domain/mobilePresentation.js";
import { analyzeExpenseBreakdown, EXPENSE_BREAKDOWN_CATEGORIES, normalizeExpenseBreakdown } from "./domain/expenseBreakdown.js";
import { INCOME_CATEGORIES, normalizeIncomeCategory } from "./domain/incomeCategory.js";
import { preparePendingIncomeEntry } from "./domain/pendingIncome.js";
import { calculateYearOverview } from "./domain/yearOverview.js";
import { analyzeHistoricalIncome, calendarMonthKey } from "./domain/historicalIncome.js";
import {
  BACKUP_LIMITS,
  createBackupEnvelope,
  parseAndValidateBackup,
  prepareRestoredApp,
} from "./domain/backupSchema.js";
import { getBrowserStorage, readStorageValue, writeStorageValue } from "./domain/storage.js";
import { attachPersistenceLifecycle, createPersistenceCoordinator } from "./domain/persistenceCoordinator.js";
import { writeUiPreference } from "./domain/uiPreferences.js";
import {
  formatMonthKey,
  getCanonicalMonthYears,
  getQuarantinedMonthKeys,
  isCanonicalMonthKey,
  nextMonthKey,
  normalizeCanonicalMonthRecords,
  parseCanonicalMonthKey,
  previousMonthKey,
  resolveOperationalActiveMonth,
} from "./domain/monthKey.js";
import { createRawRecoveryFile } from "./domain/rawRecovery.js";
import {
  createFinanceAnalysisExport,
  getFinanceMeaningfulMonthKeys,
  getInvalidFinanceMonthKeys,
  isFinanceAnalysisMonthKey,
} from "./domain/financeAnalysisExport.js";
import {
  DEFAULT_MONTH_COPY_OPTIONS,
  applyValidatedMonthCopyToApp,
  classifyMonthDestination,
  getMonthCopySummary,
  getNextMonthKey,
  isValidMonthKey,
} from "./domain/monthCopy.js";

// ToolStack Budgit — Simple monthly budgeting tool (free)
// - Runs fully in-browser
// - Saves to localStorage (guarded)
// - Tracks Income + Expenses for each month
// - Expenses support user-labeled sections (Creditors, Loans, Transport, etc.)
// - Labels are edited inline (no prompt dialogs)
// - Drag & drop reordering with TRUE insert positions (within a section + between sections)
// - Check off expenses as paid → Remaining totals update
// - Collapsible expense sections
// - Due date picker (calendar)
// - Copy this month → next month (all or unpaid only)
// - Better Month Picker (month + year selects + prev/next)
// - Print to PDF via browser Print
// - Export/Import JSON backup
// - Print Preview (in-app)
// - Spend Tracker (Real-world purchase tracking)

const LS_KEY = "toolstack_budgit_v1";
const HUB_URL = import.meta.env.VITE_HUB_URL || "";

const uid = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`;
};

const pad2 = (n) => String(n).padStart(2, "0");

const monthKey = (d) => {
  const dd = d || new Date();
  const result = formatMonthKey(dd.getFullYear(), dd.getMonth() + 1);
  if (!result.ok) throw new RangeError("Current date is outside BudgIt's supported month range");
  return result.key;
};

const parseYM = (ym) => {
  const result = parseCanonicalMonthKey(ym);
  return result.ok ? { y: result.year, m: result.month } : { y: null, m: null };
};

const addMonths = (ym, delta) => {
  const result = delta === -1 ? previousMonthKey(ym) : delta === 1 ? nextMonthKey(ym) : { ok: false };
  return result.ok ? result.key : null;
};

const monthLabel = (ym, lang = "en") => {
  const parsed = parseCanonicalMonthKey(ym);
  if (!parsed.ok) return "";
  const d = new Date(parsed.year, parsed.month - 1, 1);
  return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { year: "numeric", month: "long" });
};
 
const safeParse = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};

const toNumber = (v) => {
  const parsed = parseMoney(v);
  return parsed.valid ? parsed.value : 0;
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// ---------------------------
// Due date helpers (calendar UI)
// ---------------------------

const daysInMonthYM = (ym) => {
  const p = parseYM(ym);
  if (!p.y || !p.m) return 31;
  // month is 1-12 → day 0 of next month gives last day of this month
  return new Date(p.y, p.m, 0).getDate();
};

const dueInfo = (ym, dueDay, lang = "en") => {
  const raw = dueDay == null ? null : Number(dueDay);
  if (!raw || !Number.isFinite(raw)) return null;

  const requested = clamp(raw, 1, 31);
  const p = parseYM(ym);
  if (!p.y || !p.m) {
    return {
      display: String(requested),
      title: `Due day: ${requested}`,
      actual: requested,
      requested,
      dim: 31,
    };
  }

  const dim = daysInMonthYM(ym);
  const actual = Math.min(requested, dim);
  const d = new Date(p.y, p.m - 1, actual);

  const locale = lang === "de" ? "de-DE" : "en-US";
  const displayBase = d.toLocaleDateString(locale, { day: "2-digit", month: "short" });
  const display = `${displayBase}${actual !== requested ? "*" : ""}`;

  const full = d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
  const note =
    actual !== requested ? ` (requested ${requested}, month has ${dim} days → using last day ${actual})` : "";

  return {
    display,
    title: `Due: ${full}${note}`,
    actual,
    requested,
    dim,
  };
};

// ---------------------------
// localStorage safe wrapper
// ---------------------------

const lsGet = (key) => {
  const result = readStorageValue(getBrowserStorage(), key);
  return result.ok ? result.value : null;
};

const lsSet = (key, value) => {
  return writeStorageValue(getBrowserStorage(), key, value);
};

// ---------------------------
// UI primitives (MASTER: Check-It)
// ---------------------------

const BUTTON_FOCUS = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D5FF00] focus-visible:ring-offset-2";
const BUTTON_DISABLED = "disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0";

function useModalEscape(open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);
}

function SmallButton({ children, onClick, tone = "default", className = "", disabled, title, type = "button" }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900 shadow-sm hover:bg-[#c7f000] hover:border-[#c7f000]"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200 shadow-sm"
        : "bg-white hover:bg-neutral-100 hover:border-neutral-300 text-neutral-700 border-neutral-200";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden min-h-11 sm:min-h-10 px-3 py-2 rounded-lg text-sm font-semibold border transition active:translate-y-[1px] ${BUTTON_FOCUS} ${BUTTON_DISABLED} ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

/** Normalized Top Actions (mobile-aligned “table/grid”) */
const ACTION_BASE =
  `print:hidden min-h-11 sm:min-h-10 px-4 rounded-lg text-sm font-semibold border transition active:translate-y-[1px] focus-within:outline-none focus-within:ring-2 focus-within:ring-[#D5FF00] focus-within:ring-offset-2 ${BUTTON_FOCUS} ${BUTTON_DISABLED} flex items-center justify-center`;

function ActionButton({ children, onClick, tone = "default", disabled, title }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900 hover:bg-[#c7f000] hover:border-[#c7f000]"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
        : "bg-white hover:bg-neutral-100 hover:border-neutral-300 text-neutral-700 border-neutral-200";

  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${ACTION_BASE} ${cls}`}>
      {children}
    </button>
  );
}

function ActionFileButton({ children, onFile, accept = "application/json", tone = "primary", title }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900 hover:bg-[#c7f000] hover:border-[#c7f000]"
      : "bg-white hover:bg-neutral-100 hover:border-neutral-300 text-neutral-700 border-neutral-200";

  return (
    <label title={title} className={`${ACTION_BASE} ${cls} cursor-pointer`}>
      <span>{children}</span>
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
          if (typeof onFile === "function") onFile(file);
        }}
      />
    </label>
  );
}

function MiniActionButton({ children, onClick, tone = "default", disabled, title, className = "" }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900 hover:bg-[#c7f000] hover:border-[#c7f000]"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
        : "bg-white hover:bg-neutral-100 hover:border-neutral-300 text-neutral-700 border-neutral-200";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden min-h-11 sm:min-h-10 w-full rounded-lg text-sm font-semibold border transition active:translate-y-[1px] ${BUTTON_FOCUS} ${BUTTON_DISABLED} ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

const CURRENCIES = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  ZAR: "R",
};

function Money({ value, currency = "EUR", invalidLabel = "Invalid amount" }) {
  const display = getMoneyDisplayValue(value);
  if (!display.valid) {
    return <span className="tabular-nums" aria-label={invalidLabel} title={invalidLabel}>—</span>;
  }
  const v = display.value;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  const symbol = CURRENCIES[currency] || "€";
  return (
    <span className="tabular-nums">
      {sign}{symbol}{abs.toFixed(2)}
    </span>
  );
}

function DragHandle({ title = "Drag to reorder" }) {
  return (
    <div
      title={title}
      className={`print:hidden select-none h-11 w-11 sm:h-10 sm:w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center text-neutral-700 cursor-grab active:cursor-grabbing ${BUTTON_FOCUS}`}
      aria-label={title}
    >
      <span className="leading-none text-lg">⋮⋮</span>
    </div>
  );
}

function PaidCheck({ checked, onChange, label = "Paid" }) {
  return (
    <label className="print:hidden h-6 w-6 rounded-md border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 flex items-center justify-center cursor-pointer">
      <input
        type="checkbox"
        aria-label={label}
        className="h-3.5 w-3.5 accent-[#D5FF00]"
        checked={!!checked}
        onChange={(e) => {
          if (typeof onChange === "function") onChange(e.target.checked);
        }}
      />
    </label>
  );
}

function SelectAllNumberInput({
  className = "",
  value,
  onChange,
  onKeyDown,
  onBlur,
  placeholder,
  inputMode = "decimal",
  title,
  id,
  ariaInvalid,
  ariaDescribedBy,
}) {
  // Click/focus selects all so you can type immediately over defaults.
  return (
    <input
      className={className}
      value={value == null ? "0" : value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      placeholder={placeholder}
      inputMode={inputMode}
      title={title}
      id={id}
      aria-invalid={ariaInvalid || undefined}
      aria-describedby={ariaDescribedBy || undefined}
      onFocus={(e) => {
        try {
          e.target.select();
        } catch {
          // ignore
        }
      }}
      onClick={(e) => {
        try {
          e.target.select();
        } catch {
          // ignore
        }
      }}
    />
  );
}

function IncomeCategorySelect({ value, onChange, t, className = "" }) {
  const selected = typeof value === "string" && value.trim() ? value : "";
  return (
    <select className={className} value={selected} onChange={onChange} title={t("incomeType")}>
      <option value="">{t("incomeCategory_unclassified")}</option>
      {selected && !INCOME_CATEGORIES.includes(selected) ? <option value={selected}>{selected}</option> : null}
      {INCOME_CATEGORIES.map((category) => <option key={category} value={category}>{t(`incomeCategory_${category}`)}</option>)}
    </select>
  );
}

function ExpenseBreakdownEditor({ expense, currency, t, onChange, onRemove }) {
  const components = Array.isArray(expense.breakdown) ? expense.breakdown : [];
  const analysis = analyzeExpenseBreakdown(expense);
  const [touched, setTouched] = useState(() => new Set());
  const updateComponent = (id, patch) => onChange(components.map((component) => (
    component.id === id ? { ...component, ...patch } : component
  )));
  const removeComponent = (id) => onChange(components.filter((component) => component.id !== id));
  const addComponent = () => onChange([...components, { id: uid(), label: "", category: "other", amount: "" }]);
  const markTouched = (id) => setTouched((current) => new Set(current).add(id));

  let summary;
  if (analysis.state === "unavailable") summary = t("breakdownInvalidParent");
  else if (analysis.complete) summary = <>{t("breakdownComplete")} · <Money value={analysis.validComponentSubtotal} currency={currency} /></>;
  else if (analysis.overallocatedAmount > 0) summary = <>{t("breakdownExceedsBy")} <Money value={analysis.overallocatedAmount} currency={currency} /></>;
  else summary = <><Money value={analysis.validComponentSubtotal} currency={currency} /> {t("breakdownOf")} <Money value={expense.amount} currency={currency} />{analysis.unallocatedAmount > 0 ? <> · <Money value={analysis.unallocatedAmount} currency={currency} /> {t("breakdownUnallocated")}</> : null}</>;

  return (
    <section className="expense-breakdown" aria-label={t("breakdown")}>
      <div className="expense-breakdown-heading">
        <div>
          <div className="expense-breakdown-title">{t("breakdown")}</div>
          <div className={`expense-breakdown-summary ${analysis.complete ? "text-emerald-700" : "text-amber-800"}`}>{summary}</div>
          {analysis.blankComponentCount + analysis.invalidComponentCount > 0 ? <div className="expense-breakdown-warning">{t("breakdownExcludesInvalid", { count: analysis.blankComponentCount + analysis.invalidComponentCount })}</div> : null}
        </div>
        <button type="button" className="expense-breakdown-remove" onClick={onRemove}>{t("removeBreakdown")}</button>
      </div>
      <div className="expense-breakdown-components">
        {components.map((component) => {
          const parsed = parseMoney(component.amount);
          const invalid = touched.has(component.id) && (!parsed.valid || parsed.value < 0);
          const errorId = `breakdown-error-${component.id}`;
          return (
            <div className="expense-breakdown-component" key={component.id}>
              <label>
                <span>{t("component")}</span>
                <input value={component.label} onChange={(event) => updateComponent(component.id, { label: event.target.value })} placeholder={t("componentLabelPlaceholder")} />
              </label>
              <label>
                <span>{t("category")}</span>
                <select value={component.category} onChange={(event) => updateComponent(component.id, { category: event.target.value })}>
                  {component.category && !EXPENSE_BREAKDOWN_CATEGORIES.includes(component.category) ? <option value={component.category}>{component.category}</option> : null}
                  {EXPENSE_BREAKDOWN_CATEGORIES.map((category) => <option value={category} key={category}>{t(`breakdownCategory_${category}`)}</option>)}
                </select>
              </label>
              <label>
                <span>{t("amount")}</span>
                <SelectAllNumberInput value={component.amount} onChange={(event) => updateComponent(component.id, { amount: event.target.value })} onBlur={() => markTouched(component.id)} className={invalid ? "border-red-400 ring-1 ring-red-200" : ""} ariaInvalid={invalid} ariaDescribedBy={invalid ? errorId : undefined} />
                {invalid ? <small id={errorId}>{parsed.valid && parsed.value < 0 ? t("negativeExpenseAmount") : t("invalidAmount")}</small> : null}
              </label>
              <button type="button" className="expense-breakdown-component-remove" onClick={() => removeComponent(component.id)} aria-label={`${t("delete")}: ${component.label || t("component")}`}>×</button>
            </div>
          );
        })}
      </div>
      <div className="expense-breakdown-footer">
        <span>{t("forAnalysisOnly")}</span>
        <button type="button" onClick={addComponent}>{t("addComponent")}</button>
      </div>
    </section>
  );
}

function CalculatorIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="16" y1="14" x2="16" y2="18" />
      <path d="M16 10h.01" />
      <path d="M12 10h.01" />
      <path d="M8 10h.01" />
      <path d="M12 14h.01" />
      <path d="M8 14h.01" />
      <path d="M12 18h.01" />
      <path d="M8 18h.01" />
    </svg>
  );
}

function NoteIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function TrashIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function AddPendingIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
      <path d="M4 7h16v10H4z" />
    </svg>
  );
}

function PinIcon({ className = "", filled }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function ChevronDownIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SearchIcon({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function NoteEditorModal({ open, onClose, item, groupName, onSave, onClear, t }) {
  const [text, setText] = useState(() => item?.note || "");
  const [pinned, setPinned] = useState(() => !!item?.notePinned);
  useModalEscape(open, onClose);

  if (!open || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="note-editor-title" className="modal-surface flex w-full max-w-lg flex-col">
        <div className="px-6 py-5 border-b border-neutral-100 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-1">{groupName}</div>
            <h2 id="note-editor-title" className="font-bold text-2xl text-neutral-900 tracking-tight">{t("note")} — {item.name || t("unnamed")}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t("close")} className={`h-11 w-11 shrink-0 rounded-xl border border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100 ${BUTTON_FOCUS}`}>×</button>
        </div>
        
        <div className="p-6 space-y-4">
          <label className="block">
            <span className="block mb-2 text-sm font-semibold text-neutral-800">{t("notes")}</span>
            <textarea
              className="w-full h-40 rounded-xl border border-neutral-200 p-4 bg-neutral-50 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#D5FF00] focus:border-transparent resize-none"
              placeholder={t("notesPlaceholder")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </label>
          
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPinned(!pinned)}
              className={`min-h-11 flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition ${BUTTON_FOCUS} ${pinned ? "bg-[#D5FF00] text-neutral-900" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
            >
              <PinIcon className="h-4 w-4" filled={pinned} />
              {pinned ? t("pinned") : t("pinNote")}
            </button>
          </div>
        </div>

        <div className="p-4 bg-neutral-50 border-t border-neutral-100 flex justify-between items-center">
          <div>
            {item.note && (
              <button
                onClick={() => {
                  if (window.confirm(t("clearNoteConfirm"))) onClear();
                }}
                className={`min-h-11 rounded-xl border border-red-200 bg-white px-4 py-2 text-red-700 text-sm font-medium hover:bg-red-50 ${BUTTON_FOCUS}`}
              >
                {t("deleteNote")}
              </button>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button onClick={onClose} className={`min-h-11 px-4 py-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 hover:bg-neutral-100 transition ${BUTTON_FOCUS}`}>
              {t("cancel")}
            </button>
            <button 
              onClick={() => onSave(text, pinned)}
              className={`min-h-11 px-6 py-2 rounded-xl border border-[#D5FF00] text-sm font-bold bg-[#D5FF00] text-neutral-900 shadow-sm hover:bg-[#c7f000] transition ${BUTTON_FOCUS}`}
            >
              {t("save")}
            </button> 
          </div>
        </div>
      </div>
    </div>
  );
}

function NotesPanel({ active, onJump, t }) {
  const [isOpen, setIsOpen] = useState(() => lsGet("budgit_notes_open") !== "false");
  useEffect(() => {
    writeUiPreference(lsSet, "budgit_notes_open", isOpen);
  }, [isOpen]);
  const notes = useMemo(() => {
    const list = [];
    (active.expenseGroups || []).forEach(g => {
      (g.items || []).forEach(item => {
        if (item.note && item.note.trim()) {
          list.push({ ...item, groupLabel: g.label || t("unnamed"), groupId: g.id });
        }
      });
    });
    // Sort: Pinned first, then Group, then Item Name
    return list.sort((a, b) => {
      if (a.notePinned !== b.notePinned) return a.notePinned ? -1 : 1;
      const gCmp = a.groupLabel.localeCompare(b.groupLabel);
      if (gCmp !== 0) return gCmp;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [active, t]);

  if (notes.length === 0) {
    return (
      <section className="rounded-2xl border border-neutral-200 bg-white mt-6 p-4" aria-labelledby="notes-empty-title">
        <h2 id="notes-empty-title" className="font-semibold text-neutral-900">{t("notes")}</h2>
        <p className="mt-1 text-sm text-neutral-600">{t("noNotes")}</p>
      </section>
    );
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white mt-6 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="notes-panel-content"
        className={`w-full min-h-11 px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800 flex items-center justify-between transition ${BUTTON_FOCUS} ${isOpen ? "bg-[#D5FF00]" : "bg-white hover:bg-[#D5FF00]/30"}`}
      >
        <div className="flex items-center gap-2">
          <NoteIcon className="h-5 w-5 text-neutral-500" />
          {t("notes")}
        </div>
        <ChevronDownIcon className={`h-5 w-5 text-neutral-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && (
        <div id="notes-panel-content" className="divide-y divide-neutral-100">
          {notes.map(note => (
            <div key={note.id} className="p-4 hover:bg-neutral-50 transition">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    {note.notePinned && <PinIcon className="h-3 w-3 text-neutral-400" filled />}
                    <span className="font-bold text-neutral-900 text-sm">{note.name || t("unnamed")}</span>
                    <span className="text-xs text-neutral-500 bg-neutral-100 px-2 py-0.5 rounded-md">{note.groupLabel}</span>
                  </div>
                  <div className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed">{note.note}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onJump(note.id)}
                  className={`shrink-0 min-h-11 text-xs font-medium text-[#D5FF00] bg-neutral-900 px-3 py-2 rounded-lg hover:bg-neutral-700 transition ${BUTTON_FOCUS}`}
                >
                  {t("jumpToItem")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function DuePicker({ ym, value, onChange, lang = "en", t, compact = false }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);

  const info = useMemo(() => dueInfo(ym, value, lang), [ym, value, lang]);
  const ymParts = useMemo(() => parseYM(ym), [ym]);

  const dim = useMemo(() => daysInMonthYM(ym), [ym]);
  const firstDow = useMemo(() => {
    // Monday-start: 0=Mon ... 6=Sun
    if (!ymParts.y || !ymParts.m) return 0;
    const js = new Date(ymParts.y, ymParts.m - 1, 1).getDay(); // 0=Sun ... 6=Sat
    return (js + 6) % 7;
  }, [ymParts.y, ymParts.m]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Keep the calendar fully on-screen (flip up/down, clamp left/right)
  useLayoutEffect(() => {
    if (!open) return undefined;

    const place = () => {
      const btn = btnRef.current;
      const pop = popRef.current;
      if (!btn || !pop) return;

      const pad = 8;
      const r = btn.getBoundingClientRect();

      // Measure popover size (works even if visibility:hidden)
      const pr = pop.getBoundingClientRect();
      const w = pr.width || 256;
      const h = pr.height || 300;

      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;

      // Prefer aligning right edge with button right edge
      let left = r.right - w;
      left = Math.max(pad, Math.min(left, vw - w - pad));

      // Prefer below; if not enough space, flip above
      let top = r.bottom + 8;
      if (top + h > vh - pad) {
        top = r.top - 8 - h;
      }
      top = Math.max(pad, Math.min(top, vh - h - pad));

      setPos({ top, left });
    };

    // Place immediately, then on resize/scroll
    place();
    window.addEventListener("resize", place);
    // Capture scroll events from any scrollable parent
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, ym]);

  const weekLabels = useMemo(() => {
    // Mon → Sun
    const base = new Date(2024, 0, 1); // Monday (Jan 1, 2024)
    const labels = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const locale = lang === "de" ? "de-DE" : "en-US";
      labels.push(d.toLocaleDateString(locale, { weekday: "short" }));
    }
    return labels;
  }, [lang]);

  const days = useMemo(() => {
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= dim; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [firstDow, dim]);

  const btnLabel = info ? (compact ? String(info.requested) : info.display) : t("due");
  const btnTitle = info ? info.title : t("selectDueDate");

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        title={btnTitle}
        onClick={() => setOpen((v) => !v)}
        className={`w-full ${compact ? "h-8 rounded-md px-1.5 shadow-none" : "h-10 rounded-xl px-3 shadow-sm"} border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-neutral-300 hover:text-neutral-800 text-neutral-800 text-sm flex items-center justify-between gap-1 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300 ${
          info ? "font-medium" : "text-neutral-500"
        }`}
      >
        <span className="tabular-nums truncate">{btnLabel}</span>
        <span className={`flex items-center ${compact ? "gap-1" : "gap-2"}`}>
          {info ? (
            <span
              className={`${compact ? "h-5 w-5 rounded-md" : "h-6 w-6 rounded-lg"} border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-600 flex items-center justify-center`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof onChange === "function") onChange(null);
                setOpen(false);
              }}
              title={t("clearDueDate")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (typeof onChange === "function") onChange(null);
                  setOpen(false);
                }
              }}
            >
              ×
            </span>
          ) : null}
          <CalendarIcon className={`${compact ? "h-4 w-4" : "h-5 w-5"} text-neutral-600`} />
        </span>
      </button>

      {open ? (
        <div
          ref={popRef}
          style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
          className="print:hidden fixed z-50 w-64 rounded-2xl border border-neutral-200 bg-white shadow-xl overflow-hidden max-h-[75vh] overflow-auto"
        >
          <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-neutral-800">{monthLabel(ym, lang)}</div>
            <button
              type="button"
              className={`min-h-11 px-3 rounded-xl text-xs font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-800 ${BUTTON_FOCUS}`}
              onClick={() => setOpen(false)}
              title={t("closeTitle")}
            >
              {t("close")}
            </button>
          </div>

          <div className="p-3">
            <div className="grid grid-cols-7 gap-1 text-[11px] text-neutral-500 mb-2">
              {weekLabels.map((w, idx) => (
                <div key={idx} className="text-center">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {days.map((d, idx) => {
                if (!d) return <div key={idx} className="h-8" />;
                const selected = Number(value) === d;
                return (
                  <button
                    key={idx}
                    type="button"
                    className={`min-h-10 rounded-xl text-sm tabular-nums border transition ${BUTTON_FOCUS} ${
                      selected
                        ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-800"
                        : "bg-white border-neutral-200 text-neutral-700 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800"
                    }`}
                    onClick={() => {
                      if (typeof onChange === "function") onChange(d);
                      setOpen(false);
                    }}
                    title={t("setDueTitle", { d })}
                  >
                    {d}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-neutral-600">{t("clickDay")}</div>
              <button
                type="button"
                className={`min-h-11 px-3 rounded-xl text-xs font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-800 ${BUTTON_FOCUS}`}
                onClick={() => {
                  if (typeof onChange === "function") onChange(null);
                  setOpen(false);
                }}
              >
                {t("clearDate")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InsertDropZone({ active, onDragOver, onDrop }) {
  return (
    <div
      className={`print:hidden h-3 rounded-xl transition-colors duration-200 md:h-1.5 ${active ? "bg-[#D5FF00]/50 ring-2 ring-[#D5FF00]/20" : "bg-transparent"}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    />
  );
}

// Selected state = dark grey + white (master)
function TogglePill({ on, labelOn = "On", labelOff = "Off", onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`print:hidden min-h-11 sm:min-h-10 w-full rounded-xl text-sm font-medium border shadow-sm transition active:translate-y-[1px] flex items-center justify-between px-3 gap-2 bg-white border-neutral-200 text-neutral-700 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 group ${BUTTON_FOCUS}`}
    >
      <span className="truncate">{on ? labelOn : labelOff}</span>
      <div
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ease-in-out ${
          on ? "bg-neutral-800" : "bg-neutral-200 group-hover:bg-neutral-300"
        }`}
      >
        <div
          className={`absolute left-[2px] top-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
            on ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </div>
    </button>
  );
}

/** ToolStack — Help Pack v1 (shared modal) */
function HelpItem({ title, children }) {
  return (
    <div className="border-b border-neutral-100 last:border-0 py-6">
      <h3 className="font-bold text-neutral-900 text-lg mb-3">{title}</h3>
      <div className="text-sm text-neutral-600 leading-relaxed space-y-2">
        {children}
      </div>
    </div>
  );
}

function HelpModal({ open, onClose, t }) {
  useModalEscape(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="help-modal-title" className="modal-surface flex max-h-[90vh] w-full max-w-2xl flex-col">
        
        {/* Header */}
        <div className="relative px-8 pt-10 pb-8 bg-neutral-50 border-b border-neutral-100">
          <div className="absolute top-6 right-6">
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close")}
              className={`h-11 w-11 rounded-xl bg-white border border-neutral-200 hover:bg-[#D5FF00] hover:border-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition-all shadow-sm ${BUTTON_FOCUS}`}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="flex items-center gap-6">
            <div className="w-16 h-16 rounded-2xl bg-[#D5FF00] flex items-center justify-center shadow-sm text-neutral-900 shrink-0">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <div>
              <h2 id="help-modal-title" className="text-3xl font-black text-neutral-900 tracking-tight">{t("helpTitle")}</h2>
              <p className="text-neutral-500 mt-2 font-medium max-w-md">{t("helpSubtitle")}</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-8 py-2">
          <HelpItem title={t("help_about_title")}>
            <p>{t("help_about_p1")}</p>
            <p>{t("help_about_p2")}</p>
          </HelpItem>

          <HelpItem title={t("help_how_title")}>
            <p>{t("help_how_intro")}</p>
            <ol className="list-decimal list-outside pl-5 space-y-3 mt-3">
              <li>
                <strong>{t("help_how_step1_title")}</strong>
                <p>{t("help_how_step1_desc")}</p>
              </li>
              <li>
                <strong>{t("help_how_step2_title")}</strong>
                <p>{t("help_how_step2_desc")}</p>
              </li>
              <li>
                <strong>{t("help_how_step3_title")}</strong>
                <p>{t("help_how_step3_desc")}</p>
              </li>
              <li>
                <strong>{t("help_how_step4_title")}</strong>
                <p>{t("help_how_step4_desc")}</p>
                <ul className="list-disc list-outside pl-5 mt-1">
                  <li>{t("help_how_step4_li1")}</li>
                  <li>{t("help_how_step4_li2")}</li>
                  <li>{t("help_how_step4_li3")}</li>
                </ul>
              </li>
              <li>
                <strong>{t("help_how_step5_title")}</strong>
                <p>{t("help_how_step5_desc")}</p>
              </li>
              <li>
                <strong>{t("help_how_step6_title")}</strong>
                <p>{t("help_how_step6_desc")}</p>
              </li>
            </ol>
          </HelpItem>

          <HelpItem title={t("help_data_title")}>
            <p>{t("help_data_p1")}</p>
            <p>{t("help_data_p2")}</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>{t("help_data_li1")}</li>
              <li>{t("help_data_li2")}</li>
              <li>{t("help_data_li3")}</li>
              <li>{t("help_data_li4")}</li>
            </ul>
            <p className="mt-2">{t("help_data_p3")}</p>
          </HelpItem>

          <HelpItem title={t("help_income_status_title")}>
            <p>{t("help_income_status_desc")}</p>
          </HelpItem>

          <HelpItem title={t("help_income_category_title")}>
            <p>{t("help_income_category_desc")}</p>
            <p>{t("help_income_category_employer")}</p>
          </HelpItem>

          <HelpItem title={t("help_backup_title")}>
            <p dangerouslySetInnerHTML={{ __html: t("help_backup_p1") }} />
            <p dangerouslySetInnerHTML={{ __html: t("help_backup_p2") }} />
            <p className="mt-2">{t("help_backup_p3")}</p>
            <ul className="list-disc list-inside space-y-1 pl-2">
              <li>{t("help_backup_li1")}</li>
              <li>{t("help_backup_li2")}</li>
              <li>{t("help_backup_li3")}</li>
            </ul>
          </HelpItem>

          <HelpItem title={t("help_buttons_title")}>
            <ul className="space-y-3">
              <li dangerouslySetInnerHTML={{ __html: t("help_buttons_li1") }} />
              <li dangerouslySetInnerHTML={{ __html: t("help_buttons_li2") }} />
              <li dangerouslySetInnerHTML={{ __html: t("help_buttons_li3") }} />
              <li dangerouslySetInnerHTML={{ __html: t("help_buttons_li4") }} />
            </ul>
          </HelpItem>

          <HelpItem title={t("help_tech_title")}>
            <p>{t("help_tech_p1")}</p>
            <p><code className="text-xs bg-neutral-100 border border-neutral-200 rounded p-1 font-mono text-neutral-600">toolstack_budgit_v1</code></p>
            <p className="mt-2">{t("help_tech_p2")}</p>
            <p><code className="text-xs bg-neutral-100 border border-neutral-200 rounded p-1 font-mono text-neutral-600">toolstack.profile.v1</code></p>
          </HelpItem>

          <HelpItem title={t("help_notes_title")}>
            <p>{t("help_notes_p1")}</p>
            <p>{t("help_notes_p2")}</p>
          </HelpItem>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-neutral-100 bg-neutral-50 text-center">
          <div className="text-xs font-bold text-neutral-400 uppercase tracking-widest">{t("footer")}</div>
        </div>
      </div>
    </div>
  );
}

function ExportIconWrapper({ children }) {
  return (
    <div className="h-10 w-10 rounded-full bg-[#D5FF00] flex items-center justify-center text-neutral-900 shrink-0">
      {children}
    </div>
  );
}

const ExportIcons = {
  Print: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
  Download: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Upload: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Close: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Mail: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  Spark: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z"/><path d="m5 15-.75 2.25L2 18l2.25.75L5 21l.75-2.25L8 18l-2.25-.75L5 15Z"/><path d="m19 13-.75 2.25L16 16l2.25.75L19 19l.75-2.25L22 16l-2.25-.75L19 13Z"/></svg>,
};

const monthName = (ym, lang = "en") => {
  const { y, m } = parseYM(ym);
  if (!y || !m) return String(ym || "");
  return new Date(y, m - 1, 1).toLocaleDateString(lang === "de" ? "de-DE" : "en-US", { month: "long" });
};

function ExportActionRow({ icon, label, sub, onClick, file, onClose, onImport }) {
  const content = (
    <>
      <ExportIconWrapper>{icon}</ExportIconWrapper>
      <div className="flex-1 text-left">
        <div className="font-semibold text-neutral-900 text-base">{label}</div>
        {sub && <div className="text-xs text-neutral-500 font-medium">{sub}</div>}
      </div>
    </>
  );

  const cls = `w-full min-h-14 p-3 rounded-2xl hover:bg-neutral-50 transition flex items-center gap-4 group active:scale-[0.98] border border-transparent hover:border-neutral-100 focus-within:outline-none focus-within:ring-2 focus-within:ring-[#D5FF00] focus-within:ring-offset-2 ${BUTTON_FOCUS}`;

  if (file) {
    return (
      <label className={`${cls} cursor-pointer`}>
        {content}
        <input
          type="file"
          accept="application/json"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
            if (f) {
              onClose();
              if (typeof onImport === "function") onImport(f);
              e.target.value = "";
            }
          }}
        />
      </label>
    );
  }

  return (
    <button type="button" className={cls} onClick={onClick}>
      {content}
    </button>
  );
}

function ExportModal({ open, initialView = "backup", onClose, onBackup, onImport, onFinanceExport, onRawRecovery, rawRecoveryAvailable, quarantinedMonthCount, activeMonth, months, lang, t }) {
  const [view, setView] = useState(initialView);
  const [financeMode, setFinanceMode] = useState("current");
  const [includeNotes, setIncludeNotes] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState(() => {
    const choices = getFinanceMeaningfulMonthKeys(months, { includeNotes: false });
    return new Set(choices.includes(activeMonth) ? [activeMonth] : choices.slice(-1));
  });
  const meaningfulMonths = useMemo(() => getFinanceMeaningfulMonthKeys(months, { includeNotes }), [months, includeNotes]);
  const invalidMonthCount = useMemo(() => getInvalidFinanceMonthKeys(months).length, [months]);
  useModalEscape(open, () => { setView("backup"); onClose(); });
  if (!open) return null;

  const closeModal = () => {
    setView("backup");
    onClose();
  };

  const toggleSelectedMonth = (monthKey) => {
    setSelectedMonths((current) => {
      const next = new Set(current);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return next;
    });
  };

  const eligibleSelectedMonths = meaningfulMonths.filter((monthKey) => selectedMonths.has(monthKey));
  const selectedCount = eligibleSelectedMonths.length;
  const currentMonthValid = isFinanceAnalysisMonthKey(activeMonth) && Object.hasOwn(months || {}, activeMonth);
  const canDownload = financeMode === "current"
    ? currentMonthValid
    : financeMode === "selected"
      ? selectedCount > 0
      : meaningfulMonths.length > 0;

  const downloadFinanceExport = () => {
    if (!canDownload) return;
    const succeeded = onFinanceExport({
      mode: financeMode,
      selectedMonthKeys: eligibleSelectedMonths,
      includeNotes,
    });
    if (succeeded) closeModal();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden"> 
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={closeModal} />
      <div role="dialog" aria-modal="true" aria-labelledby="export-modal-title" className={`modal-surface w-full ${view === "finance" ? "max-w-lg" : "max-w-sm"}`}>
        <div className="px-6 pt-6 pb-4 flex items-center justify-between">
          <div>
            <h2 id="export-modal-title" className="font-bold text-2xl text-neutral-900 tracking-tight">{view === "finance" ? t("financeAiTitle") : t("backupRestore")}</h2>
            <div className="text-sm text-neutral-500 font-medium mt-1">{view === "finance" ? t("financeAiDescription") : t("backupRestoreDescription")}</div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            aria-label={t("close")}
            className={`h-11 w-11 rounded-xl bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition ${BUTTON_FOCUS}`}
          >
            <ExportIcons.Close />
          </button>
        </div>
        
        {view === "backup" ? <div className="px-4 pb-6 flex flex-col gap-2">
          <ExportActionRow
            icon={<ExportIcons.Download />}
            label={t("export_download_json_label")}
            sub={t("export_download_json_sub")}
            onClick={() => { closeModal(); onBackup(); }}
          />
          {quarantinedMonthCount > 0 ? (
            <div className="finance-export-warning mx-2 my-1" role="status">
              <div className="font-semibold">{t("rawRecoveryTitle")}</div>
              <div className="mt-1">{t("rawRecoveryDescription")}</div>
              <button
                type="button"
                disabled={!rawRecoveryAvailable}
                onClick={() => { if (onRawRecovery()) closeModal(); }}
                className={`mt-3 min-h-10 rounded-lg border border-neutral-300 bg-white px-3 text-xs font-bold text-neutral-800 hover:bg-neutral-100 ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}
              >
                {t("rawRecoveryDownload")}
              </button>
            </div>
          ) : null}
          <ExportActionRow
            icon={<ExportIcons.Upload />}
            label={t("export_import_json_label")}
            sub={t("export_import_json_sub")}
            file
            onClose={closeModal}
            onImport={onImport}
          />
        </div> : (
          <div className="max-h-[72vh] overflow-y-auto px-5 pb-5">
            <fieldset className="space-y-2">
              <legend className="finance-export-label">{t("financeAiMonthSelection")}</legend>
              {[
                ["current", t("financeAiCurrentMonth"), t("financeAiCurrentMonthDescription")],
                ["selected", t("financeAiSelectMonths"), t("financeAiSelectMonthsDescription")],
                ["all", t("financeAiAllMonths"), t("financeAiAllMonthsDescription")],
              ].map(([mode, label, description]) => (
                <label key={mode} className={`finance-export-option ${financeMode === mode ? "finance-export-option-active" : ""}`}>
                  <input type="radio" name="finance-export-mode" value={mode} checked={financeMode === mode} onChange={() => setFinanceMode(mode)} className="accent-[#D5FF00]" />
                  <span><span className="block text-sm font-semibold text-neutral-900">{label}</span><span className="block text-xs text-neutral-500">{description}</span></span>
                </label>
              ))}
            </fieldset>

            {financeMode === "selected" ? (
              <div className="mt-4">
                <div className="finance-export-label">{t("financeAiAvailableMonths")}</div>
                {meaningfulMonths.length ? (
                  <div className="finance-month-list">
                    {meaningfulMonths.map((monthKey, index) => {
                      const year = monthKey.slice(0, 4);
                      const previousYear = index > 0 ? meaningfulMonths[index - 1].slice(0, 4) : null;
                      return <React.Fragment key={monthKey}>
                        {year !== previousYear ? <div className="finance-month-year">{year}</div> : null}
                        <label className="finance-month-choice">
                          <input type="checkbox" checked={selectedMonths.has(monthKey)} onChange={() => toggleSelectedMonth(monthKey)} className="accent-[#D5FF00]" />
                          <span>{monthName(monthKey, lang)} {year}</span>
                        </label>
                      </React.Fragment>;
                    })}
                  </div>
                ) : <div className="finance-export-empty">{t("financeAiNoMeaningfulMonths")}</div>}
              </div>
            ) : null}

            {financeMode === "all" && !meaningfulMonths.length ? <div className="finance-export-empty mt-3">{t("financeAiNoMeaningfulMonths")}</div> : null}
            {financeMode === "current" && !currentMonthValid ? <div role="alert" className="finance-export-warning mt-3">{t("financeAiInvalidCurrentMonth")}</div> : null}
            {invalidMonthCount > 0 ? <div role="status" className="finance-export-warning mt-3">{t(invalidMonthCount === 1 ? "financeAiInvalidMonthWarning" : "financeAiInvalidMonthsWarning", { count: invalidMonthCount })}</div> : null}

            <label className="finance-notes-option">
              <input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} className="accent-[#D5FF00]" />
              <span><span className="block text-sm font-semibold text-neutral-900">{t("financeAiIncludeNotes")}</span><span className="block text-xs text-neutral-500">{t("financeAiIncludeNotesDescription")}</span></span>
            </label>

            <div className="finance-privacy-note">{t("financeAiPrivacy")}</div>
            {!canDownload ? <div role="status" className="mt-2 text-xs font-medium text-red-700">{t("financeAiNoSelection")}</div> : null}

            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4">
              <button type="button" onClick={closeModal} className={`min-h-11 rounded-lg border border-neutral-200 bg-white px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-100 ${BUTTON_FOCUS}`}>{t("cancel")}</button>
              <button type="button" disabled={!canDownload} onClick={downloadFinanceExport} className={`min-h-11 rounded-lg border border-[#D5FF00] bg-[#D5FF00] px-4 text-sm font-bold text-neutral-950 hover:bg-[#c7f000] ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}>{t("financeAiDownload")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  ); 
}

function MonthCopyModal({ sourceMonthKey, sourceMonth, months, lang, onClose, onCopy, t }) {
  const [destinationMonthKey, setDestinationMonthKey] = useState(() => getNextMonthKey(sourceMonthKey) || "");
  const [copyIncome, setCopyIncome] = useState(DEFAULT_MONTH_COPY_OPTIONS.copyIncome);
  const [copyExpenses, setCopyExpenses] = useState(DEFAULT_MONTH_COPY_OPTIONS.copyExpenses);
  const [copyEntryNotes, setCopyEntryNotes] = useState(DEFAULT_MONTH_COPY_OPTIONS.copyEntryNotes);
  const [copyMonthNote, setCopyMonthNote] = useState(DEFAULT_MONTH_COPY_OPTIONS.copyMonthNote);

  useModalEscape(true, onClose);

  const destinationValid = isValidMonthKey(destinationMonthKey) && destinationMonthKey !== sourceMonthKey;
  const destinationState = destinationValid ? classifyMonthDestination(months, destinationMonthKey) : null;
  const destinationLabel = destinationValid ? monthLabel(destinationMonthKey, lang) : destinationMonthKey;
  const sourceLabel = monthLabel(sourceMonthKey, lang);
  const summary = getMonthCopySummary({ sourceMonth, destinationState, copyIncome, copyExpenses, copyEntryNotes, copyMonthNote });
  const options = { copyIncome, copyExpenses, copyEntryNotes, copyMonthNote };
  const destructive = destinationState === "has_data";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="month-copy-title"
        aria-describedby={destructive ? "month-copy-warning" : "month-copy-reset-summary"}
        className="modal-surface max-h-[90vh] w-full max-w-xl overflow-y-auto"
      >
        <div className="px-6 pt-6 pb-4 border-b border-neutral-100 flex items-start justify-between gap-4">
          <div>
            <h2 id="month-copy-title" className="text-2xl font-bold text-neutral-900">{t("copyMonth")}</h2>
            <p className="mt-1 text-sm text-neutral-600">{t("copySource", { month: sourceLabel })}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("close")} className={`h-11 w-11 rounded-xl border border-neutral-200 text-neutral-600 hover:bg-neutral-100 ${BUTTON_FOCUS}`}>×</button>
        </div>

        <div className="p-6 space-y-5">
          <label className="block">
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-neutral-500">{t("copyTo")}</span>
            <input
              autoFocus
              type="month"
              value={destinationMonthKey}
              onChange={(event) => setDestinationMonthKey(event.target.value)}
              className="mt-2 w-full h-11 rounded-xl border border-neutral-200 px-3 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/60"
            />
          </label>

          {!destinationValid && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {destinationMonthKey === sourceMonthKey ? t("copySameMonthError") : t("copyInvalidMonthError")}
            </div>
          )}

          {destructive && (
            <div id="month-copy-warning" role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
              <div className="font-bold">{t("destinationHasData")}</div>
              <div className="mt-1">{t("replaceMonthWarning", { month: destinationLabel })}</div>
            </div>
          )}

          {destinationState && !destructive && (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
              {destinationState === "not_created" ? t("destinationNotCreated") : t("destinationEffectivelyEmpty")}
            </div>
          )}

          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-neutral-900">{t("whatWillBeCopied")}</legend>
            <label className="flex items-center gap-3 text-sm text-neutral-800">
              <input type="checkbox" checked={copyIncome} onChange={(event) => setCopyIncome(event.target.checked)} className="h-4 w-4 accent-[#D5FF00]" />
              {t("copyIncomeEntries")}
            </label>
            <label className="flex items-center gap-3 text-sm text-neutral-800">
              <input type="checkbox" checked={copyExpenses} onChange={(event) => setCopyExpenses(event.target.checked)} className="h-4 w-4 accent-[#D5FF00]" />
              {t("copyExpenseEntries")}
            </label>
            <label className="flex items-center gap-3 text-sm text-neutral-800">
              <input type="checkbox" checked={copyEntryNotes} onChange={(event) => setCopyEntryNotes(event.target.checked)} className="h-4 w-4 accent-[#D5FF00]" />
              {t("copyEntryNotes")}
            </label>
            <label className="flex items-center gap-3 text-sm text-neutral-800">
              <input type="checkbox" checked={copyMonthNote} onChange={(event) => setCopyMonthNote(event.target.checked)} className="h-4 w-4 accent-[#D5FF00]" />
              {t("copyMonthNote")}
            </label>
          </fieldset>

          <div className="rounded-xl border border-neutral-200 p-4">
            <div className="text-sm font-bold text-neutral-900">{t("copyPreview")}</div>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-neutral-600">{t("sourceMonth")}</dt><dd className="font-medium text-neutral-900">{sourceLabel}</dd>
              <dt className="text-neutral-600">{t("destinationMonth")}</dt><dd className="font-medium text-neutral-900">{destinationLabel || "—"}</dd>
              <dt className="text-neutral-600">{t("incomeEntries")}</dt><dd>{summary.incomeEntries}</dd>
              <dt className="text-neutral-600">{t("expenseGroups")}</dt><dd>{summary.expenseGroups}</dd>
              <dt className="text-neutral-600">{t("expenseItems")}</dt><dd>{summary.expenseEntries}</dd>
              <dt className="text-neutral-600">{t("entryNotes")}</dt><dd>{summary.copyEntryNotes ? t("yes") : t("no")}</dd>
              <dt className="text-neutral-600">{t("monthNote")}</dt><dd>{summary.copyMonthNote ? t("yes") : t("no")}</dd>
            </dl>
          </div>

          <div id="month-copy-reset-summary" className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700">
            <div className="font-bold text-neutral-900">{t("whatWillBeReset")}</div>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              <li>{t("resetPaid")}</li>
              <li>{t("resetIncomeStatus")}</li>
              <li>{t("resetDates")}</li>
              <li>{t("resetBalance")}</li>
              <li>{t("resetPending")}</li>
              <li>{t("resetTransactions")}</li>
            </ul>
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-neutral-100 p-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={`min-h-11 px-4 py-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 hover:bg-neutral-100 ${BUTTON_FOCUS}`}>{t("cancel")}</button>
          {destructive ? (
            <button
              type="button"
              disabled={!destinationValid}
              aria-describedby="month-copy-warning"
              onClick={() => onCopy({ destinationMonthKey, options, confirmReplace: true })}
              className={`min-h-11 px-5 py-2 rounded-xl border border-red-700 text-sm font-bold bg-red-700 text-white hover:bg-red-800 ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}
            >
              {t("replaceMonthAction", { month: destinationLabel })}
            </button>
          ) : (
            <button
              type="button"
              disabled={!destinationValid}
              onClick={() => onCopy({ destinationMonthKey, options, confirmReplace: false })}
              className={`min-h-11 px-5 py-2 rounded-xl border border-[#D5FF00] text-sm font-bold bg-[#D5FF00] text-neutral-900 hover:bg-[#c7f000] ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}
            >
              {t("createMonthAction", { month: destinationLabel })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BalanceCheck({
  balance,
  pendingIncomeEntries,
  overdraftLimit,
  onBalanceUpdate,
  onAddPendingIncome,
  onDeletePendingIncome,
  onOverdraftLimitUpdate,
  remainingExpenses,
  currency,
  currencySymbol,
  t,
}) {
  const [draftLabel, setDraftLabel] = useState("");
  const [draftAmount, setDraftAmount] = useState("");
  const [balanceTouched, setBalanceTouched] = useState(false);
  const [overdraftTouched, setOverdraftTouched] = useState(false);
  const [draftAmountTouched, setDraftAmountTouched] = useState(false);
  const [draftAttempted, setDraftAttempted] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const pendingEntries = Array.isArray(pendingIncomeEntries) ? pendingIncomeEntries : [];
  const projection = calculateBalanceProjection({ bankBalance: balance, overdraftLimit, pendingIncomeEntries: pendingEntries, remainingExpenses });
  const {
    currentBalance,
    pendingTotal: totalPendingMoneyIn,
    projectedAfterMoneyIn,
    balanceAfterUnpaid,
    balanceAfterIncomingMoney,
    availableWithOverdraft,
  } = projection;
  const balanceInvalid = !projection.balance.valid;
  const overdraftInvalid = !projection.overdraft.valid;
  const invalidPendingCount = projection.invalidPendingAmounts.length;
  const draftValidation = parseMoney(draftAmount);
  const draftInvalidVisible = (draftAmountTouched || draftAttempted) && !draftValidation.valid;
  const canAttemptPending = !!String(draftLabel || "").trim() || !!String(draftAmount || "").trim();
  const isShort = typeof availableWithOverdraft === "number" && availableWithOverdraft < 0;
  const invalidAmountNotice = (count) => t(count === 1 ? "excludesInvalidAmount" : "excludesInvalidAmounts", { count });

  const addPendingEntry = () => {
    setDraftAttempted(true);
    const prepared = preparePendingIncomeEntry({
      id: uid(),
      label: String(draftLabel || "").trim() || t("pendingIncomeFallback"),
      amount: draftAmount,
      fallbackLabel: t("pendingIncomeFallback"),
    });
    if (!prepared.ok) return;
    onAddPendingIncome(prepared.entry);
    setDraftLabel("");
    setDraftAmount("");
    setDraftAmountTouched(false);
    setDraftAttempted(false);
  };

  return (
    <div className={`cash-position-panel print:hidden ${isShort ? "cash-position-panel-short" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="summary-heading !border-0 !p-0">{t("cashPosition")}</div>
          <div className="text-xs text-neutral-500 mt-1">{t("cashPositionDesc")}</div>
        </div>
        <div className={`text-xs font-bold px-2 py-1 rounded-lg ${isShort ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"}`}>
          {currency}
        </div>
      </div>

      {balanceInvalid || overdraftInvalid || invalidPendingCount > 0 ? <div role="status" className="cash-position-warning">{t("cashPositionUnavailable")}{invalidPendingCount > 0 ? ` ${invalidAmountNotice(invalidPendingCount)}` : ""}</div> : null}

      <div className="cash-position-flow">
        <div><span>{t("bankNow")}</span><strong><Money value={currentBalance} currency={currency} invalidLabel={t("projectionUnavailable")} /></strong></div>
        <div><span><b aria-hidden="true">+</b>{t("expectedIncoming")}</span><strong><Money value={totalPendingMoneyIn} currency={currency} /></strong>{invalidPendingCount > 0 ? <small>{invalidAmountNotice(invalidPendingCount)}</small> : null}</div>
        <div><span><b aria-hidden="true">−</b>{t("unpaidBills")}</span><strong><Money value={remainingExpenses} currency={currency} /></strong></div>
        <div className="cash-position-result"><span><b aria-hidden="true">=</b>{t("projectedCash")}</span><strong><Money value={balanceAfterIncomingMoney} currency={currency} invalidLabel={t("projectionUnavailable")} /></strong></div>
      </div>
      <div className="cash-position-overdraft"><span>{t("availableIncludingOverdraft")}</span><strong className={isShort ? "text-red-700" : ""}><Money value={availableWithOverdraft} currency={currency} invalidLabel={t("projectionUnavailable")} /></strong></div>

      <button type="button" className={`cash-input-toggle ${BUTTON_FOCUS}`} onClick={() => setEditOpen((open) => !open)} aria-expanded={editOpen} aria-controls="cash-input-editor"><span>{t("editCashInputs")}</span><ChevronDownIcon className={`h-4 w-4 transition-transform ${editOpen ? "rotate-180" : ""}`} /></button>

      {editOpen ? <div id="cash-input-editor" className="cash-input-editor">
        <label htmlFor="bank-balance-input" className="block">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-neutral-500">{t("currentBalance")}</span>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 font-semibold">{currencySymbol}</span>
            <SelectAllNumberInput
              id="bank-balance-input"
              className={`w-full rounded-lg border pl-8 pr-3 py-2 bg-white text-right text-neutral-900 font-bold text-lg tracking-tight tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 ${balanceTouched && balanceInvalid ? "border-red-400" : "border-neutral-300 focus:border-neutral-500"}`}
              value={balance}
              onChange={onBalanceUpdate}
              onBlur={() => setBalanceTouched(true)}
              placeholder="0.00"
              title={t("currentBalance")}
              inputMode="decimal"
              ariaInvalid={balanceTouched && balanceInvalid}
              ariaDescribedBy={balanceTouched && balanceInvalid ? "bank-balance-error" : undefined}
            />
          </div>
          {balanceTouched && balanceInvalid ? <span id="bank-balance-error" className="mt-1 block text-xs font-medium text-red-700">{t("invalidAmount")}</span> : null}
        </label>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-neutral-500">{t("pendingMoneyIn")}</div>
          <div className="mt-1 grid grid-cols-[1fr_82px_44px] gap-1.5">
            <input
              className="min-w-0 rounded-lg border border-neutral-200 px-2 py-1.5 bg-white text-neutral-800 text-xs focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPendingEntry();
              }}
              placeholder={t("pendingIncomeLabelPlaceholder")}
              title={t("pendingIncomeLabel")}
            />
            <SelectAllNumberInput
              className={`min-w-0 rounded-lg border px-2 py-1.5 bg-white text-right text-neutral-800 text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 ${draftInvalidVisible ? "border-red-400" : "border-neutral-200 focus:border-neutral-300"}`}
              value={draftAmount}
              onChange={(e) => setDraftAmount(e.target.value)}
              onBlur={() => setDraftAmountTouched(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPendingEntry();
              }}
              placeholder="0"
              title={t("amount")}
              inputMode="decimal"
              ariaInvalid={draftInvalidVisible}
              ariaDescribedBy={draftInvalidVisible ? "pending-draft-amount-error" : undefined}
            />
            <button
              type="button"
              onClick={addPendingEntry}
              disabled={!canAttemptPending}
              className={`h-11 rounded-lg border border-neutral-200 bg-white hover:bg-neutral-100 hover:border-neutral-300 text-neutral-700 text-sm font-bold ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}
              title={t("addPendingIncome")}
            >
              +
            </button>
          </div>
          {draftInvalidVisible ? <div id="pending-draft-amount-error" className="mt-1 text-xs font-medium text-red-700">{t("invalidAmount")}</div> : null}

          {pendingEntries.length ? (
            <div className="mt-2 max-h-56 overflow-y-auto pr-1 space-y-1">
              {pendingEntries.map((entry) => {
                const entryValid = getMoneyDisplayValue(entry.amount).valid;
                return <div key={entry.id} className="flex items-center gap-2 text-xs leading-5">
                  <span className="min-w-0 flex-1 truncate text-neutral-700">{entry.label || t("pendingIncomeFallback")}</span>
                  <span className={`w-16 text-right tabular-nums font-medium ${entryValid ? "text-neutral-800" : "text-red-700"}`}>
                    <Money value={entry.amount} currency={currency} invalidLabel={t("invalidAmount")} />
                  </span>
                  <button
                    type="button"
                    onClick={() => onDeletePendingIncome(entry.id)}
                    className={`h-11 w-11 shrink-0 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 ${BUTTON_FOCUS}`}
                    title={t("removeTitle")}
                    aria-label={`${t("delete")}: ${entry.label || t("pendingIncomeFallback")}`}
                  >
                    x
                  </button>
                </div>;
              })}
            </div>
          ) : <div className="mt-2 text-xs text-neutral-500">{t("noPendingIncome")}</div>}

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-neutral-600">{t("pendingMoneyTotal")}</span>
            <span className="font-semibold text-neutral-900"><Money value={totalPendingMoneyIn} currency={currency} /></span>
          </div>
          {invalidPendingCount > 0 ? <div className="mt-1 text-xs font-medium text-red-700">{invalidAmountNotice(invalidPendingCount)}</div> : null}
        </div>

        <label htmlFor="overdraft-limit-input" className="block">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-neutral-500">{t("overdraftLimit")}</span>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 font-semibold">{currencySymbol}</span>
            <SelectAllNumberInput
              id="overdraft-limit-input"
              className={`w-full rounded-lg border pl-8 pr-3 py-2 bg-white text-right text-neutral-900 font-bold text-lg tracking-tight tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 ${overdraftTouched && overdraftInvalid ? "border-red-400" : "border-neutral-300 focus:border-neutral-500"}`}
              value={overdraftLimit}
              onChange={onOverdraftLimitUpdate}
              onBlur={() => setOverdraftTouched(true)}
              placeholder="0.00"
              title={t("overdraftLimit")}
              inputMode="decimal"
              ariaInvalid={overdraftTouched && overdraftInvalid}
              ariaDescribedBy={overdraftTouched && overdraftInvalid ? "overdraft-limit-error" : undefined}
            />
          </div>
          {overdraftTouched && overdraftInvalid ? <span id="overdraft-limit-error" className="mt-1 block text-xs font-medium text-red-700">{t(projection.overdraft.reason === "negative_not_allowed" ? "negativeOverdraft" : "invalidAmount")}</span> : null}
        </label>
        <div className="cash-projection-details"><span>{t("projectionDetails")}</span><dl><div><dt>{t("projectedAfterMoneyIn")}</dt><dd><Money value={projectedAfterMoneyIn} currency={currency} invalidLabel={t("projectionUnavailable")} /></dd></div><div><dt>{t("balanceAfterUnpaidExpenses")}</dt><dd><Money value={balanceAfterUnpaid} currency={currency} invalidLabel={t("projectionUnavailable")} /></dd></div></dl></div>
      </div> : null}
    </div>
  );
}

// ---------------------------
// Data normalization / migration
// ---------------------------

const normalizeIncomeItem = (x) => ({
  id: x && x.id ? x.id : uid(),
  name: x && typeof x.name === "string" ? x.name : "",
  amount: x && x.amount != null ? x.amount : "0",
  date: x && typeof x.date === "string" ? x.date : "",
  status: x && INCOME_STATUSES.includes(x.status) ? x.status : "expected",
  notes: x && typeof x.notes === "string" ? x.notes : "",
  ...normalizeIncomeCategory(x),
});

const normalizePendingIncomeEntry = (x) => ({
  id: x && x.id ? x.id : uid(),
  label: x && typeof x.label === "string" ? x.label : "",
  amount: x && x.amount != null ? x.amount : "0",
});

const normalizeExpenseItem = (x) => ({
  id: x && x.id ? x.id : uid(),
  name: x && typeof x.name === "string" ? x.name : "",
  amount: x && x.amount != null ? x.amount : "0",
  dueDay: normalizeExpenseDueDay(x?.dueDay),
  paid: !!(x && x.paid),
  note: x && typeof x.note === "string" ? x.note : "",
  notePinned: !!(x && x.notePinned),
  noteUpdatedAt: x && x.noteUpdatedAt ? x.noteUpdatedAt : null,
  ...normalizeExpenseBreakdown(x, uid),
});

const normalizeTransaction = (x) => ({
  id: x && x.id ? x.id : uid(),
  dateISO: x && typeof x.dateISO === "string" && x.dateISO.length > 10 ? x.dateISO : new Date().toISOString(),
  amountCents: x && typeof x.amountCents === "number" ? x.amountCents : 0,
  groupId: x && (x.groupId || x.categoryId) ? (x.groupId || x.categoryId) : null,
  itemId: x && x.itemId ? x.itemId : null,
  note: x && typeof x.note === "string" ? x.note : "",
  paymentMethod: x && typeof x.paymentMethod === "string" ? x.paymentMethod : "Card",
});

// Migration:
// - Legacy: { expenses: [] }
// - New: { expenseGroups: [{ id, label, items: [] }] }
function normalizeMonthData(monthData) {
  const m = monthData || { incomes: [], expenses: [], notes: "", transactions: [], bankBalance: "", overdraftLimit: "", pendingIncomeEntries: [], pendingMoneyIn: "", pendingMoneyLabel: "" };

  const incomes = Array.isArray(m.incomes) ? m.incomes.map(normalizeIncomeItem) : [];
  const transactions = Array.isArray(m.transactions) ? m.transactions.map(normalizeTransaction) : [];
  const legacyPendingAmount = m.pendingMoneyIn != null ? m.pendingMoneyIn : "";
  const pendingIncomeEntries = Array.isArray(m.pendingIncomeEntries)
    ? m.pendingIncomeEntries.map(normalizePendingIncomeEntry)
    : toNumber(legacyPendingAmount) !== 0
      ? [normalizePendingIncomeEntry({ label: m.pendingMoneyLabel || "Pending", amount: legacyPendingAmount })]
      : [];

  if (Array.isArray(m.expenseGroups)) {
    const groups = m.expenseGroups
      .filter(Boolean)
      .map((g) => ({
        id: g && g.id ? g.id : uid(),
        label: g && typeof g.label === "string" ? g.label : "",
        items: Array.isArray(g && g.items) ? g.items.map(normalizeExpenseItem) : [],
      }));

    return {
      incomes,
      expenseGroups: groups.length ? groups : [{ id: uid(), label: "General", items: [] }],
      notes: typeof m.notes === "string" ? m.notes : "",
      transactions,
      bankBalance: m.bankBalance != null ? m.bankBalance : "",
      overdraftLimit: m.overdraftLimit != null ? m.overdraftLimit : "",
      pendingIncomeEntries,
      pendingMoneyIn: m.pendingMoneyIn != null ? m.pendingMoneyIn : "",
      pendingMoneyLabel: typeof m.pendingMoneyLabel === "string" ? m.pendingMoneyLabel : "",
    };
  }

  const legacyExpenses = Array.isArray(m.expenses) ? m.expenses.map(normalizeExpenseItem) : [];
  return {
    incomes,
    expenseGroups: [{ id: uid(), label: "General", items: legacyExpenses }],
    notes: typeof m.notes === "string" ? m.notes : "",
    transactions,
    bankBalance: m.bankBalance != null ? m.bankBalance : "",
    overdraftLimit: m.overdraftLimit != null ? m.overdraftLimit : "",
    pendingIncomeEntries,
    pendingMoneyIn: m.pendingMoneyIn != null ? m.pendingMoneyIn : "",
    pendingMoneyLabel: typeof m.pendingMoneyLabel === "string" ? m.pendingMoneyLabel : "",
  };
}

function loadInitialAppState() {
  const base = {
    activeMonth: monthKey(),
    months: {},
    lang: "en",
    currency: "EUR",
  };
  const stored = readStorageValue(getBrowserStorage(), LS_KEY);
  if (!stored.ok) return { app: initializeAppData(base), loadFailure: stored.code };
  if (stored.value == null) return { app: initializeAppData(base), loadFailure: null };

  const parsed = safeParse(stored.value, null);
  const supportedLanguage = !parsed?.lang || parsed.lang === "en" || parsed.lang === "de";
  const supportedCurrency = !parsed?.currency || Object.prototype.hasOwnProperty.call(CURRENCIES, parsed.currency);
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !parsed.months
    || typeof parsed.months !== "object"
    || Array.isArray(parsed.months)
    || (parsed.activeMonth != null && typeof parsed.activeMonth !== "string")
    || !supportedLanguage
    || !supportedCurrency
  ) {
    return { app: initializeAppData(base), loadFailure: "invalid_saved_data" };
  }
  try {
    return { app: initializeAppData(parsed), loadFailure: null };
  } catch {
    return { app: initializeAppData(base), loadFailure: "invalid_saved_data" };
  }
}

function initializeAppData(source) {
  const data = { ...source, months: normalizeCanonicalMonthRecords(source.months, normalizeMonthData) };
  const activeMonth = resolveOperationalActiveMonth(data.activeMonth, monthKey());
  data.activeMonth = activeMonth;
  if (!data.months[activeMonth]) data.months[activeMonth] = normalizeMonthData(null);
  if (!data.lang) data.lang = "en";
  if (!data.currency) data.currency = "EUR";
  return data;
}

const TRANSLATIONS = {
  en: {
    subtitle: "Monthly personal budgeting tool",
    yearOverview: "Year view",
    backToMonth: "Back to Month",
    previousYear: "Previous year",
    nextYear: "Next year",
    planningDetails: "Planning Details",
    yearInsights: "Year Insights",
    strongestMonth: "Strongest month",
    weakestMonth: "Weakest month",
    averageMonthlyActualNet: "Average monthly actual net",
    incomeStatusIncomplete: "Income status incomplete",
    unresolvedIncome: "Unresolved income",
    expectedEntrySingular: "expected entry",
    expectedEntryPlural: "expected entries",
    unresolvedAmount: "unresolved",
    unresolvedSubtotalIncompleteSingular: "Unresolved subtotal excludes 1 invalid amount.",
    unresolvedSubtotalIncompletePlural: "Unresolved subtotal excludes {count} invalid amounts.",
    historicalIncomePrintWarning: "Some expected income has not been reconciled.",
    provisionalActualNet: "Provisional actual net",
    annualActualNetProvisional: "Includes unresolved historical income",
    nonProvisionalMonthBasisSingular: "Based on 1 non-provisional month",
    nonProvisionalMonthBasisPlural: "Based on {count} non-provisional months",
    unavailable: "Unavailable",
    noData: "No data",
    noYearData: "No yearly data available yet.",
    yearReceivedIncome: "Received Income",
    yearPaidExpenses: "Paid Expenses",
    yearUnpaidExpenses: "Unpaid Expenses",
    actualNet: "Actual Net",
    monthsWithData: "Months with Data",
    monthsWithUnpaidExpenses: "Months with Unpaid Expenses",
    yearLeftAfterPlanned: "Left After Planned Expenses",
    tableMonth: "Month",
    tableExpected: "Expected",
    tableReceived: "Received",
    tablePlanned: "Planned",
    tablePaid: "Paid",
    tableUnpaid: "Unpaid",
    tableActualNet: "Actual Net",
    openMonth: "Open {month}",
    hub: "HUB",
    commands: "Commands",
    export: "Export",
    tools: "Tools",
    settings: "Settings",
    primaryNavigation: "Primary navigation",
    menu: "Menu",
    financeAiMenu: "Finance AI",
    financeAiMenuDescription: "Create an analysis-ready file",
    print: "Print",
    printMenuDescription: "Preview and print this month",
    backupRestore: "Backup & restore",
    backupRestoreDescription: "Protect or restore BudgIt data",
    emailDraft: "Email draft",
    emailDraftDescription: "Prepare a shareable email",
    monthlyLedger: "Monthly ledger",
    monthActions: "Month actions",
    yearShort: "Year",
    copyShort: "Copy",
    openCommands: "Open commands",
    closeCommands: "Close commands",
    commandNavigate: "Navigate",
    commandOutput: "Output",
    commandTools: "Tools",
    commandPreferences: "Preferences",
    language: "Language",
    currency: "Currency",
    preview: "Print preview",
    data: "Backup & export",
    help: "Help",
    month: "Month",
    prevMonth: "◀ Prev",
    nextMonth: "Next ▶",
    copyNext: "Copy → Next",
    copyMonth: "Copy month",
    copySource: "Copy {month}",
    copyTo: "Copy to",
    whatWillBeCopied: "What will be copied",
    whatWillBeReset: "What will be reset",
    copyIncomeEntries: "Copy income entries",
    copyExpenseEntries: "Copy expense groups and entries",
    copyEntryNotes: "Copy entry notes",
    copyMonthNote: "Copy month note",
    copyPreview: "Copy preview",
    sourceMonth: "Source month",
    destinationMonth: "Destination month",
    incomeEntries: "Income entries",
    expenseGroups: "Expense groups",
    entryNotes: "Entry notes",
    monthNote: "Month note",
    yes: "Yes",
    no: "No",
    destinationHasData: "This month already contains data",
    destinationNotCreated: "The destination month has not been created yet.",
    destinationEffectivelyEmpty: "The destination month exists but contains no budget data.",
    replaceMonthWarning: "{month} already contains budget data. Replacing it will permanently remove that month’s current entries.",
    createMonthAction: "Create {month}",
    replaceMonthAction: "Replace {month}",
    copySameMonthError: "The destination must be different from the source month.",
    copyInvalidMonthError: "Choose a valid destination month.",
    resetPaid: "Paid expenses become unpaid.",
    resetIncomeStatus: "All income statuses become expected.",
    resetDates: "Income receipt dates and temporary payment dates are cleared.",
    resetBalance: "Current bank balance and overdraft are not copied.",
    resetPending: "Expected incoming money is not copied.",
    resetTransactions: "Transaction remnants are not copied.",
    monthCopied: "{destination} created from {source}.",
    monthCopyNotSaved: "The month was copied in this open page, but it could not be saved. Download a backup now.",
    monthCopyInvalid: "The copied month could not be validated. No data was changed.",
    monthCopyValidationError: "Could not copy {month}. Check {field}: {problem}",
    copyAll: "Copy all",
    copyUnpaid: "Copy unpaid only",
    cancel: "Cancel",
    back: "Back",
    clear: "Clear",
    startAgain: "Clear month",
    income: "Income",
    addIncome: "Add income",
    totalIncome: "Expected Income",
    invalidAmount: "Enter a valid amount.",
    negativeExpenseAmount: "Expense amount cannot be negative.",
    excludesInvalidAmount: "Excludes {count} invalid amount",
    excludesInvalidAmounts: "Excludes {count} invalid amounts",
    totalsIncomplete: "Totals are incomplete.",
    totalExpenses: "Planned Expenses",
    expenses: "Expenses",
    addSection: "Add group",
    addExpense: "Add expense",
    hidePaid: "Hide paid",
    showPaid: "Show paid",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    sortDue: "Sort due",
    clearPaid: "Clear paid",
    clearItems: "Clear items",
    deleteSection: "Delete group",
    notes: "Notes",
    notesPlaceholder: "Optional notes for this month…",
    summary: "Summary",
    expectedIncome: "Expected Income",
    remainingExpenses: "Unpaid Expenses",
    unpaidExpenses: "Unpaid Expenses",
    plannedExpenses: "Planned Expenses",
    groupPlanned: "Planned",
    groupUnpaid: "Unpaid",
    netRemaining: "Left After Planned Expenses",
    leftAfterPlannedExpenses: "Projected remainder",
    financialDetails: "Financial details",
    receivedIncome: "Received income",
    delayedIncome: "Delayed income",
    cancelledIncome: "Cancelled income",
    expenseAttention: "Expense status",
    unpaidExpenseSingular: "unpaid expense",
    unpaidExpensePlural: "unpaid expenses",
    overdue: "overdue",
    nextDue: "Next due",
    noUnpaidExpenses: "No unpaid expenses",
    negativeValue: "Negative value",
    savingsRate: "Savings rate",
    quickView: "Quick view",
    sections: "Sections",
    expenseItems: "Expense items",
    unpaidItems: "Unpaid items",
    tip: "Tip: Paid items don’t count toward remaining expenses. Use “Hide paid” to keep lists clean.",
    printPreview: "Print preview",
    printSave: "Print / Save PDF",
    close: "Close",
    generated: "Generated",
    noIncome: "No income added yet.",
    noExpenses: "No expense groups added yet.",
    noItems: "No items.",
    noItemsSection: "No expenses in this group.",
    noPendingIncome: "No pending income.",
    noNotes: "No notes added.",
    save: "Save",
    pinned: "Pinned",
    pinNote: "Pin note",
    deleteNote: "Delete note",
    clearNoteConfirm: "Delete this note?",
    jumpToItem: "Go to expense",
    collapsedDrop: "Collapsed. Drop an item here to move it into this section.",
    due: "Due",
    backup: "Backup (JSON)",
    import: "Import (JSON)",
    exportTitle: "Export",
    helpTitle: "Help",
    helpSubtitle: "How your data is saved + how to keep continuity.",
    autosave: "Autosave (default)",
    autosaveDesc: "BudgIt saves automatically in your browser (localStorage) under:",
    autosaveWarn: "If you clear browser data or switch devices/browsers, your local data won’t follow automatically.",
    bestPractice: "Best practice (continuity)",
    bp1: "Use",
    bp1b: "once a week (or after big updates) to create a backup JSON file.",
    bp2: "Store that JSON in a safe place (Google Drive / iCloud / email to yourself / USB).",
    bp3: "On a new device/browser, use",
    bp3b: "to restore everything.",
    reordering: "Reordering",
    reorderingDesc: "Drag using the",
    reorderingDesc2: "handle. Drop on the small lines between items to insert exactly where you want.",
    paidItems: "Paid items",
    paidItemsDesc: "Tick the checkbox to mark an expense as paid. Paid items don’t count toward remaining totals.",
    sectionsHelp: "Groups",
    sectionsHelpDesc: "Organise expenses by group. Select a group name to rename it, or use “Add group” to create one.",
    dueDatesHelp: "Due Dates",
    dueDatesHelpDesc: "Set due dates to track when bills are due. Use “Sort due” to organize items by date.",
    copyingHelp: "Rolling Over",
    copyingHelpDesc: "Use “Copy month” to review what will carry forward. Paid and income statuses, dates, balances, pending money, and transaction remnants are reset.",
    help_income_status_title: "Income statuses",
    help_income_status_desc: "Expected means planned or not yet reconciled; Received confirms receipt; Delayed records a delay; Cancelled means it is no longer expected. Expected income left in a past month is marked unresolved until you review its status.",
    help_income_category_title: "Income classification",
    help_income_category_desc: "Income type describes what incoming money represents. It does not change the amount received or any BudgIt totals.",
    help_income_category_employer: "If an employer deposit includes money provided for social-insurance contributions, record salary and employer contribution as separate income rows that together equal the actual deposit. Do not add the contribution separately if it is already included in the Salary amount.",
    printing: "Printing / PDF",
    printingDesc: "Use",
    printingDesc2: "to check the layout, then",
    printingDesc3: "and choose “Save as PDF”.",
    privacy: "Privacy",
    privacyDesc: "BudgIt runs in your browser. There’s no account system here yet, and nothing is uploaded unless you choose to share your exported file.",
    footer: "ToolStack • Help Pack v2",
    copyUnpaidMsg: "Copied unpaid → next month",
    copyAllMsg: "Copied month → next month",
    monthCleared: "Month cleared",
    imported: "Imported",
    invalidJson: "Invalid JSON",
    importConfirm: "Importing replaces the current budget data in this app. Continue?",
    invalidBackup: "This backup cannot be restored.",
    backupTooLarge: "This backup is too large. The maximum size is 5 MB.",
    backupExportFailed: "Backup could not be created.",
    importSaveFailed: "The backup was valid, but it could not be saved. Your current data was not replaced.",
    importSummary: "Restore this {format}?\n\n{months} months, {incomes} income entries, {expenses} expense entries.\n\nThis replaces the current BudgIt data. Continue?",
    legacyBackup: "legacy BudgIt backup",
    versionedBackup: "BudgIt backup",
    saveStatusSaved: "Saved on this device",
    saveStatusSaving: "Saving…",
    saveStatusError: "Could not save",
    saveStatusImported: "Imported successfully",
    saveStatusLoadError: "Could not load saved data",
    historicalDataNeedsRecovery: "Historical data needs recovery",
    quarantinedMonthSingular: "{count} stored month cannot be used because its date is invalid. The data has been preserved.",
    quarantinedMonthPlural: "{count} stored months cannot be used because their dates are invalid. The data has been preserved.",
    rawRecoveryTitle: "Raw recovery data",
    rawRecoveryDescription: "Download the exact stored browser data before recovery. It may contain invalid or legacy records and is not a normal BudgIt backup.",
    rawRecoveryDownload: "Download raw recovery file",
    rawRecoveryUnavailable: "Raw recovery data is not available.",
    rawRecoveryExported: "Raw recovery file downloaded.",
    backupBlockedByQuarantine: "Normal backup is blocked by historical data with an invalid date. Download the raw recovery file first.",
    saveFailureAdvice: "Download a backup now. Your latest changes are only in this open page.",
    loadFailureAdvice: "Existing browser data was left unchanged. Restore a known backup to continue safely.",
    balanceCheck: "Balance projection",
    cashPosition: "Cash position",
    cashPositionDesc: "Bank position · bank now + expected incoming − unpaid bills",
    cashPositionUnavailable: "Cash position is incomplete while related amounts are invalid.",
    bankNow: "Bank now",
    expectedIncoming: "Expected incoming",
    unpaidBills: "Unpaid bills",
    projectedCash: "Projected cash",
    availableIncludingOverdraft: "Available incl. overdraft",
    editCashInputs: "Edit cash inputs",
    projectionDetails: "Projection details",
    budgetSummary: "Budget summary",
    budgetPlan: "Budget plan",
    projectedRemainderFormula: "Expected income − planned expenses",
    balanceCheckDesc: "Bank balance plus pending money, minus remaining expenses.",
    pendingMoneyIn: "Expected incoming",
    pendingIncomeLabel: "Pending money description",
    pendingIncomeLabelPlaceholder: "Overtime, eBay, refund",
    pendingIncomeFallback: "Pending",
    addPendingIncome: "Add pending money",
    pendingMoneyTotal: "Expected incoming",
    pendingMoneyLabel: "Pending label / notes",
    pendingMoneyPlaceholder: "Salary, refund, transfer expected",
    overdraftLimit: "Overdraft limit",
    negativeOverdraft: "Overdraft cannot be negative.",
    projectionUnavailable: "Unavailable while related amounts are invalid.",
    pendingSourceInvalid: "Enter a valid income amount before adding it to pending money.",
    availableWithOverdraft: "Available with overdraft",
    currentBalanceShort: "Current balance",
    projectedAfterMoneyIn: "Projected balance after money in",
    deleteSectionConfirm: "Delete “{name}” and all items inside it?",
    clearItemsConfirm: "Clear ALL items in “{name}”?",
    clearMonthConfirm: "Clear all income and expenses for this month?",
    unnamed: "(unnamed)",
    none: "(none)",
    salary: "Salary",
    newSection: "New group",
    expense: "Expense",
    sectionLabel: "Group name (e.g., Loans)",
    incomeName: "Income name",
    sourceLabel: "Source",
    incomeDate: "Date",
    incomeStatus: "Status",
    incomeType: "Type",
    incomeCategory_unclassified: "Unclassified",
    incomeCategory_salary: "Salary",
    incomeCategory_overtime: "Overtime",
    incomeCategory_bonus: "Bonus",
    incomeCategory_allowance: "Allowance",
    incomeCategory_employer_contribution: "Employer contribution",
    incomeCategory_reimbursement: "Reimbursement",
    incomeCategory_other: "Other",
    actions: "Actions",
    edit: "Edit",
    delete: "Delete",
    date: "Date",
    status: "Status",
    paidState: "Paid",
    unpaidState: "Unpaid",
    dueLabel: "Due",
    entrySingular: "entry",
    entryPlural: "entries",
    status_expected: "Expected",
    status_received: "Received",
    status_delayed: "Delayed",
    status_cancelled: "Cancelled",
    addIncomeToPending: "Add to Pending Money In",
    includeExpenseInBalance: "Include in Balance Check",
    alreadyInBalance: "Already included",
    incomeNoteTodo: "Income notes are not linked yet.",
    expenseName: "Expense name",
    breakdown: "Breakdown",
    addBreakdown: "Add breakdown",
    addComponent: "Add component",
    component: "Component",
    componentLabelPlaceholder: "Component label",
    breakdownComplete: "Breakdown complete",
    breakdownIncomplete: "Incomplete",
    breakdownOf: "of",
    breakdownUnallocated: "unallocated",
    breakdownExceedsBy: "Exceeds payment by",
    breakdownExcludesInvalid: "Excludes {count} invalid component(s)",
    breakdownInvalidParent: "Enter a valid payment amount to check the breakdown",
    removeBreakdown: "Remove breakdown",
    removeBreakdownConfirm: "Remove this breakdown and all its entered components?",
    breakdownDataInvalid: "This breakdown has an unsupported stored structure and was left unchanged.",
    forAnalysisOnly: "For analysis only · not added to expense totals",
    breakdownCategory_health: "Health",
    breakdownCategory_pension: "Pension",
    breakdownCategory_unemployment: "Unemployment",
    breakdownCategory_long_term_care: "Long-term care",
    breakdownCategory_tax: "Tax",
    breakdownCategory_insurance: "Insurance",
    breakdownCategory_other: "Other",
    amount: "Amount",
    dueDay: "Due day",
    setDue: "Set due",
    clickDay: "Click a day to set due date.",
    clearDate: "Clear",
    dueDate: "Due",
    selectDueDate: "Select a due date",
    clearDueDate: "Clear due date",
    copyNote: "Note: copied items are set to unpaid in the new month.",
    previewTip: "Tip: If the preview looks right, hit “Print / Save PDF” and choose “Save as PDF”.",
    togglePaidTitle: "Toggle visibility of paid items",
    expandAllTitle: "Expand all sections",
    collapseAllTitle: "Collapse all sections",
    copyNextTitle: "Copy this month",
    clearMonthTitle: "Clear this month",
    prevMonthTitle: "Previous month",
    nextMonthTitle: "Next month",
    yearTitle: "Year",
    monthTitle: "Month",
    dragIncomeTitle: "Drag income item",
    dragSectionTitle: "Drag section",
    removeTitle: "Delete",
    sortDueTitle: "Sort by due day (earliest first)",
    clearPaidTitle: "Remove all PAID items in this section",
    clearItemsTitle: "Clear ALL items in this section",
    deleteSectionTitle: "Delete this group and all its expenses",
    dragExpenseTitle: "Drag expense item",
    closeTitle: "Close",
    clearDueTitle: "Clear due date",
    setDueTitle: "Set due: {d}",
    paidExpenses: "Paid expenses",
    calculator: "Calculator",
    insights: "Insights",
    spendTracker: "Spend Tracker",
    addTransaction: "Add transaction",
    recentTransactions: "Recent transactions",
    today: "Today",
    thisMonth: "This Month",
    paymentMethod: "Payment method",
    card: "Card",
    cash: "Cash",
    other: "Other",
    category: "Category",
    spent: "Spent",
    remaining: "Remaining",
    noTransactions: "No transactions yet.",
    note: "Note",
    budgetLine: "Budget Line",
    search: "Search",
    searchPlaceholder: "Search items...",
    currentBalance: "Bank balance now",
    projectedBalance: "Projected Balance",
    projectedBalanceDesc: "Bank Balance - Remaining",
    balanceAfterUnpaidExpenses: "Balance after unpaid expenses",
    balanceAfterExpectedIncomingMoney: "Balance after expected incoming money",
    help_about_title: "About BudgIt",
    help_about_p1: "BudgIt is a local-first budgeting tool built to help you plan, organise, and print structured monthly budgets. It allows you to group expenses into custom sections, calculate totals automatically, and generate a clean printable overview.",
    help_about_p2: "All data is stored directly in your browser. There are no accounts, no cloud storage, and no automatic data transmission.",
    help_how_title: "How BudgIt Works",
    help_how_intro: "BudgIt follows a simple structured workflow:",
    help_how_step1_title: "Enter Your Income",
    help_how_step1_desc: "Start by entering your total monthly income.",
    help_how_step2_title: "Create Expense Groups",
    help_how_step2_desc: "Organise your expenses into custom sections (e.g., Housing, Transport, Insurance, Food).",
    help_how_step3_title: "Add Expense Items",
    help_how_step3_desc: "Add individual items inside each group. Totals update automatically.",
    help_how_step4_title: "Review Your Balance",
    help_how_step4_desc: "BudgIt calculates:",
    help_how_step4_li1: "Section subtotals",
    help_how_step4_li2: "Total expenses",
    help_how_step4_li3: "Remaining balance (Income − Expenses)",
    help_how_step5_title: "Preview & Print",
    help_how_step5_desc: "Use Preview to generate a clean print-ready budget sheet. Print or Save as PDF if required.",
    help_how_step6_title: "Export a Backup",
    help_how_step6_desc: "After major updates, export a JSON backup to secure your data.",
    help_data_title: "How Your Data Is Saved",
    help_data_p1: "Your data is saved locally in this browser using secure local storage.",
    help_data_p2: "This means:",
    help_data_li1: "Your data stays on this device",
    help_data_li2: "Clearing browser data will remove your budget",
    help_data_li3: "Incognito/private mode will not retain data",
    help_data_li4: "Data does not automatically sync across devices",
    help_data_p3: "For long-term safety, regular backups are essential.",
    help_backup_title: "Backup & Restore",
    help_backup_p1: "<strong>Export</strong> downloads a full JSON backup of your current budget.",
    help_backup_p2: "<strong>Import</strong> restores a previously exported JSON file. Importing replaces the current budget data in the app.",
    help_backup_p3: "Recommended routine:",
    help_backup_li1: "Export weekly",
    help_backup_li2: "Export after major edits",
    help_backup_li3: "Store backups in two locations (e.g., Downloads + Drive/USB)",
    help_buttons_title: "Buttons Explained",
    help_buttons_li1: "<strong>Preview</strong> – Opens the print-ready version of your budget.",
    help_buttons_li2: "<strong>Print / Save PDF</strong> – Prints only the preview sheet. You can select “Save as PDF” in your browser.",
    help_buttons_li3: "<strong>Export</strong> – Downloads a JSON backup file.",
    help_buttons_li4: "<strong>Import</strong> – Restores your budget from a JSON backup file.",
    help_tech_title: "Technical Storage Keys (Advanced)",
    help_tech_p1: "App data key:",
    help_tech_p2: "Shared profile key:",
    help_notes_title: "Important Notes",
    help_notes_p1: "BudgIt is a financial planning tool. All totals depend on the accuracy of the amounts you enter.",
    help_notes_p2: "This app does not provide financial, tax, or accounting advice.",    
    email_subject: "BudgIt Export Pack – {today}",
    email_body: "Attached: PDF export from BudgIt (please attach the downloaded PDF file).\nExports are generated locally on your device. No data is uploaded automatically.",
    export_title: "Export Pack",
    export_subtitle: "Save, share, or back up your data.",
    export_download_pdf_label: "Download PDF",
    export_download_pdf_sub: "Save as PDF",
    export_print_pdf_label: "Print / Save PDF",
    export_print_pdf_sub: "Prints preview sheet only",
    export_email_label: "Create Email Draft",
    export_email_sub: "Share via email",
    export_download_json_label: "Export backup",
    export_download_json_sub: "Backup your data",
    export_import_json_label: "Import backup",
    export_import_json_sub: "Import replaces current app data. Export first if unsure.",
    financeAiTitle: "Finance AI export",
    financeAiActionDescription: "Create an analysis file for a Finance GPT or AI assistant.",
    financeAiDescription: "Choose the months and context to include in a local analysis file.",
    financeAiMonthSelection: "Months to include",
    financeAiCurrentMonth: "Current month",
    financeAiCurrentMonthDescription: "Export the open month, including an empty budget.",
    financeAiSelectMonths: "Select months",
    financeAiSelectMonthsDescription: "Choose from months containing financial data.",
    financeAiAllMonths: "All meaningful months",
    financeAiAllMonthsDescription: "Export every month containing useful financial data.",
    financeAiAvailableMonths: "Available months",
    financeAiIncludeNotes: "Include notes",
    financeAiIncludeNotesDescription: "Adds income, expense and month notes. Off by default.",
    financeAiPrivacy: "Creates a local JSON file only. Nothing is uploaded automatically. Names, labels, breakdown details and optional notes may contain personal information.",
    financeAiDownload: "Download Finance AI file",
    financeAiNoMeaningfulMonths: "No meaningful months are available for this selection.",
    financeAiNoSelection: "Choose at least one available month.",
    financeAiInvalidCurrentMonth: "The current month key is not valid for analysis export.",
    financeAiInvalidMonthWarning: "{count} non-standard historical month key was excluded.",
    financeAiInvalidMonthsWarning: "{count} non-standard historical month keys were excluded.",
    financeAiExported: "Finance AI file downloaded.",
    financeAiExportFailed: "The Finance AI file could not be created.",
  },
  de: {
    subtitle: "Monatliches persönliches Budgetierungstool",
    yearOverview: "Jahresansicht",
    backToMonth: "Zurück zum Monat",
    previousYear: "Vorheriges Jahr",
    nextYear: "Nächstes Jahr",
    planningDetails: "Planungsdetails",
    yearInsights: "Jahresanalyse",
    strongestMonth: "Stärkster Monat",
    weakestMonth: "Schwächster Monat",
    averageMonthlyActualNet: "Durchschnittlicher monatlicher Saldo",
    incomeStatusIncomplete: "Einnahmenstatus unvollständig",
    unresolvedIncome: "Ungeklärte Einnahmen",
    expectedEntrySingular: "erwarteter Eintrag",
    expectedEntryPlural: "erwartete Einträge",
    unresolvedAmount: "ungeklärt",
    unresolvedSubtotalIncompleteSingular: "Die ungeklärte Zwischensumme schließt 1 ungültigen Betrag aus.",
    unresolvedSubtotalIncompletePlural: "Die ungeklärte Zwischensumme schließt {count} ungültige Beträge aus.",
    historicalIncomePrintWarning: "Einige erwartete Einnahmen wurden noch nicht abgestimmt.",
    provisionalActualNet: "Vorläufiger tatsächlicher Saldo",
    annualActualNetProvisional: "Enthält ungeklärte historische Einnahmen",
    nonProvisionalMonthBasisSingular: "Basiert auf 1 nicht vorläufigen Monat",
    nonProvisionalMonthBasisPlural: "Basiert auf {count} nicht vorläufigen Monaten",
    unavailable: "Nicht verfügbar",
    noData: "Keine Daten",
    noYearData: "Noch keine Jahresdaten verfügbar.",
    yearReceivedIncome: "Erhaltene Einnahmen",
    yearPaidExpenses: "Bezahlte Ausgaben",
    yearUnpaidExpenses: "Offene Ausgaben",
    actualNet: "Tatsächlicher Saldo",
    monthsWithData: "Monate mit Daten",
    monthsWithUnpaidExpenses: "Monate mit offenen Ausgaben",
    yearLeftAfterPlanned: "Nach geplanten Ausgaben übrig",
    tableMonth: "Monat",
    tableExpected: "Erwartet",
    tableReceived: "Erhalten",
    tablePlanned: "Geplant",
    tablePaid: "Bezahlt",
    tableUnpaid: "Offen",
    tableActualNet: "Tatsächlicher Saldo",
    openMonth: "{month} öffnen",
    hub: "HUB",
    commands: "Befehle",
    export: "Export",
    tools: "Werkzeuge",
    settings: "Einstellungen",
    primaryNavigation: "Hauptnavigation",
    menu: "Menü",
    financeAiMenu: "Finance AI",
    financeAiMenuDescription: "Datei für die Finanzanalyse erstellen",
    print: "Drucken",
    printMenuDescription: "Monat ansehen und drucken",
    backupRestore: "Sichern & wiederherstellen",
    backupRestoreDescription: "BudgIt-Daten schützen oder wiederherstellen",
    emailDraft: "E-Mail-Entwurf",
    emailDraftDescription: "E-Mail zum Teilen vorbereiten",
    monthlyLedger: "Monatsübersicht",
    monthActions: "Monatsaktionen",
    yearShort: "Jahr",
    copyShort: "Kopieren",
    openCommands: "Befehle öffnen",
    closeCommands: "Befehle schließen",
    commandNavigate: "Navigation",
    commandOutput: "Ausgabe",
    commandTools: "Werkzeuge",
    commandPreferences: "Einstellungen",
    language: "Sprache",
    currency: "Währung",
    preview: "Druckvorschau",
    data: "Sicherung & Export",
    help: "Hilfe",
    month: "Monat",
    prevMonth: "◀ Zurück",
    nextMonth: "Weiter ▶",
    copyNext: "Kopieren → Nächster",
    copyMonth: "Monat kopieren",
    copySource: "{month} kopieren",
    copyTo: "Kopieren nach",
    whatWillBeCopied: "Was kopiert wird",
    whatWillBeReset: "Was zurückgesetzt wird",
    copyIncomeEntries: "Einnahmen kopieren",
    copyExpenseEntries: "Ausgabengruppen und Einträge kopieren",
    copyEntryNotes: "Notizen an Einträgen kopieren",
    copyMonthNote: "Monatsnotiz kopieren",
    copyPreview: "Kopiervorschau",
    sourceMonth: "Quellmonat",
    destinationMonth: "Zielmonat",
    incomeEntries: "Einnahmen",
    expenseGroups: "Ausgabengruppen",
    entryNotes: "Eintragsnotizen",
    monthNote: "Monatsnotiz",
    yes: "Ja",
    no: "Nein",
    destinationHasData: "Dieser Monat enthält bereits Daten",
    destinationNotCreated: "Der Zielmonat wurde noch nicht erstellt.",
    destinationEffectivelyEmpty: "Der Zielmonat ist vorhanden, enthält aber keine Budgetdaten.",
    replaceMonthWarning: "{month} enthält bereits Budgetdaten. Beim Ersetzen werden die aktuellen Einträge dieses Monats dauerhaft gelöscht.",
    createMonthAction: "{month} erstellen",
    replaceMonthAction: "{month} ersetzen",
    copySameMonthError: "Der Zielmonat muss sich vom Quellmonat unterscheiden.",
    copyInvalidMonthError: "Wählen Sie einen gültigen Zielmonat.",
    resetPaid: "Bezahlte Ausgaben werden auf offen gesetzt.",
    resetIncomeStatus: "Alle Einnahmen werden auf erwartet gesetzt.",
    resetDates: "Eingangs- und vorübergehende Zahlungsdaten werden geleert.",
    resetBalance: "Aktueller Kontostand und Dispokredit werden nicht kopiert.",
    resetPending: "Erwartete Geldeingänge werden nicht kopiert.",
    resetTransactions: "Transaktionsreste werden nicht kopiert.",
    monthCopied: "{destination} wurde aus {source} erstellt.",
    monthCopyNotSaved: "Der Monat wurde auf dieser geöffneten Seite kopiert, konnte aber nicht gespeichert werden. Laden Sie jetzt eine Sicherung herunter.",
    monthCopyInvalid: "Der kopierte Monat konnte nicht validiert werden. Es wurden keine Daten geändert.",
    monthCopyValidationError: "{month} konnte nicht kopiert werden. Prüfen Sie {field}: {problem}",
    copyAll: "Alles kopieren",
    copyUnpaid: "Nur offene kopieren",
    cancel: "Abbrechen",
    back: "Zurück",
    clear: "Leeren",
    startAgain: "Monat leeren",
    income: "Einkommen",
    addIncome: "Einnahme hinzufügen",
    totalIncome: "Erwartete Einnahmen",
    invalidAmount: "Geben Sie einen gültigen Betrag ein.",
    negativeExpenseAmount: "Der Ausgabenbetrag darf nicht negativ sein.",
    excludesInvalidAmount: "Schließt {count} ungültigen Betrag aus",
    excludesInvalidAmounts: "Schließt {count} ungültige Beträge aus",
    totalsIncomplete: "Die Summen sind unvollständig.",
    totalExpenses: "Geplante Ausgaben",
    expenses: "Ausgaben",
    addSection: "Gruppe hinzufügen",
    addExpense: "Ausgabe hinzufügen",
    hidePaid: "Bezahlte ausblenden",
    showPaid: "Bezahlte anzeigen",
    expandAll: "Alle erweitern",
    collapseAll: "Alle einklappen",
    sortDue: "Fälligkeit sort.",
    clearPaid: "Bezahlte leeren",
    clearItems: "Elemente leeren",
    deleteSection: "Gruppe löschen",
    notes: "Notizen",
    notesPlaceholder: "Optionale Notizen für diesen Monat…",
    summary: "Zusammenfassung",
    expectedIncome: "Erwartete Einnahmen",
    remainingExpenses: "Offene Ausgaben",
    unpaidExpenses: "Offene Ausgaben",
    plannedExpenses: "Geplante Ausgaben",
    groupPlanned: "Geplant",
    groupUnpaid: "Offen",
    netRemaining: "Verfügbar nach geplanten Ausgaben",
    leftAfterPlannedExpenses: "Voraussichtlicher Restbetrag",
    financialDetails: "Finanzdetails",
    receivedIncome: "Erhaltene Einnahmen",
    delayedIncome: "Verspätete Einnahmen",
    cancelledIncome: "Stornierte Einnahmen",
    expenseAttention: "Ausgabenstatus",
    unpaidExpenseSingular: "offene Ausgabe",
    unpaidExpensePlural: "offene Ausgaben",
    overdue: "überfällig",
    nextDue: "Als Nächstes fällig",
    noUnpaidExpenses: "Keine offenen Ausgaben",
    negativeValue: "Negativer Wert",
    savingsRate: "Sparquote",
    quickView: "Schnellansicht",
    sections: "Abschnitte",
    expenseItems: "Ausgabenelemente",
    unpaidItems: "Unbezahlte Elemente",
    tip: "Tipp: Bezahlte Elemente zählen nicht zu den verbleibenden Ausgaben. Verwenden Sie „Bezahlte ausblenden“, um Listen sauber zu halten.",
    printPreview: "Druckvorschau",
    printSave: "Drucken / PDF speichern",
    close: "Schließen",
    generated: "Erstellt",
    noIncome: "Noch keine Einnahmen hinzugefügt.",
    noExpenses: "Noch keine Ausgabengruppen hinzugefügt.",
    noItems: "Keine Elemente.",
    noItemsSection: "Keine Ausgaben in dieser Gruppe.",
    noPendingIncome: "Keine ausstehenden Einnahmen.",
    noNotes: "Keine Notizen hinzugefügt.",
    save: "Speichern",
    pinned: "Angeheftet",
    pinNote: "Notiz anheften",
    deleteNote: "Notiz löschen",
    clearNoteConfirm: "Diese Notiz löschen?",
    jumpToItem: "Zur Ausgabe",
    collapsedDrop: "Eingeklappt. Element hier ablegen, um es in diesen Abschnitt zu verschieben.",
    due: "Fällig",
    backup: "Sicherung (JSON)",
    import: "Importieren (JSON)",
    exportTitle: "Export",
    helpTitle: "Hilfe",
    helpSubtitle: "Wie Ihre Daten gespeichert werden + wie Sie Kontinuität wahren.",
    autosave: "Automatische Speicherung (Standard)",
    autosaveDesc: "BudgIt speichert automatisch in Ihrem Browser (localStorage) unter:",
    autosaveWarn: "Wenn Sie Browserdaten löschen oder Geräte/Browser wechseln, folgen Ihre lokalen Daten nicht automatisch.",
    bestPractice: "Best Practice (Kontinuität)",
    bp1: "Verwenden Sie",
    bp1b: "einmal pro Woche (oder nach großen Updates), um eine JSON-Sicherungsdatei zu erstellen.",
    bp2: "Speichern Sie diese JSON an einem sicheren Ort (Google Drive / iCloud / E-Mail an sich selbst / USB).",
    bp3: "Verwenden Sie auf einem neuen Gerät/Browser",
    bp3b: "um alles wiederherzustellen.",
    reordering: "Neuordnen",
    reorderingDesc: "Ziehen Sie mit dem",
    reorderingDesc2: "Griff. Lassen Sie auf die kleinen Linien zwischen den Elementen fallen, um genau dort einzufügen.",
    paidItems: "Bezahlte Elemente",
    paidItemsDesc: "Aktivieren Sie das Kontrollkästchen, um eine Ausgabe als bezahlt zu markieren. Bezahlte Elemente zählen nicht zu den verbleibenden Summen.",
    sectionsHelp: "Gruppen",
    sectionsHelpDesc: "Ordnen Sie Ausgaben in Gruppen. Wählen Sie einen Gruppennamen zum Umbenennen oder erstellen Sie eine neue Gruppe über „Gruppe hinzufügen“.",
    dueDatesHelp: "Fälligkeitsdaten",
    dueDatesHelpDesc: "Legen Sie Fälligkeitsdaten fest, um Rechnungen zu verfolgen. Verwenden Sie „Fälligkeit sort.“, um Elemente nach Datum zu ordnen.",
    copyingHelp: "Übertrag",
    copyingHelpDesc: "Mit „Monat kopieren“ prüfen Sie vorab, was übernommen wird. Bezahl- und Einnahmestatus, Daten, Kontostände, erwartete Geldeingänge und Transaktionsreste werden zurückgesetzt.",
    help_income_status_title: "Einnahmenstatus",
    help_income_status_desc: "Erwartet bedeutet geplant oder noch nicht abgestimmt; Erhalten bestätigt den Eingang; Verspätet kennzeichnet eine Verzögerung; Storniert bedeutet, dass die Einnahme nicht mehr erwartet wird. Erwartete Einnahmen in vergangenen Monaten werden als ungeklärt markiert, bis ihr Status geprüft wurde.",
    help_income_category_title: "Einnahmen klassifizieren",
    help_income_category_desc: "Die Einnahmenart beschreibt, wofür ein Geldeingang steht. Sie ändert weder den erhaltenen Betrag noch die Summen in BudgIt.",
    help_income_category_employer: "Enthält eine Arbeitgeberzahlung Geld für Sozialversicherungsbeiträge, erfassen Sie Gehalt und Arbeitgeberbeitrag als getrennte Einnahmen, die zusammen dem tatsächlichen Geldeingang entsprechen. Erfassen Sie den Beitrag nicht zusätzlich, wenn er bereits im Gehaltsbetrag enthalten ist.",
    printing: "Drucken / PDF",
    printingDesc: "Verwenden Sie",
    printingDesc2: "um das Layout zu überprüfen, dann",
    printingDesc3: "und wählen Sie „Als PDF speichern“.",
    privacy: "Datenschutz",
    privacyDesc: "BudgIt läuft in Ihrem Browser. Es gibt hier noch kein Kontosystem, und nichts wird hochgeladen, es sei denn, Sie entscheiden sich, Ihre exportierte Datei zu teilen.",
    footer: "ToolStack • Help Pack v2",
    copyUnpaidMsg: "Unbezahlte kopiert → nächster Monat",
    copyAllMsg: "Monat kopiert → nächster Monat",
    monthCleared: "Monat geleert",
    imported: "Importiert",
    invalidJson: "Ungültiges JSON",
    importConfirm: "Der Import ersetzt die aktuellen Budgetdaten in dieser App. Fortfahren?",
    invalidBackup: "Diese Sicherung kann nicht wiederhergestellt werden.",
    backupTooLarge: "Diese Sicherung ist zu groß. Die maximale Größe beträgt 5 MB.",
    backupExportFailed: "Die Sicherung konnte nicht erstellt werden.",
    importSaveFailed: "Die Sicherung war gültig, konnte aber nicht gespeichert werden. Ihre aktuellen Daten wurden nicht ersetzt.",
    importSummary: "Diese {format} wiederherstellen?\n\n{months} Monate, {incomes} Einnahmen, {expenses} Ausgaben.\n\nDies ersetzt die aktuellen BudgIt-Daten. Fortfahren?",
    legacyBackup: "ältere BudgIt-Sicherung",
    versionedBackup: "BudgIt-Sicherung",
    saveStatusSaved: "Auf diesem Gerät gespeichert",
    saveStatusSaving: "Wird gespeichert…",
    saveStatusError: "Speichern nicht möglich",
    saveStatusImported: "Erfolgreich importiert",
    saveStatusLoadError: "Gespeicherte Daten konnten nicht geladen werden",
    historicalDataNeedsRecovery: "Historische Daten müssen wiederhergestellt werden",
    quarantinedMonthSingular: "{count} gespeicherter Monat kann wegen eines ungültigen Datums nicht verwendet werden. Die Daten wurden beibehalten.",
    quarantinedMonthPlural: "{count} gespeicherte Monate können wegen ungültiger Datumsangaben nicht verwendet werden. Die Daten wurden beibehalten.",
    rawRecoveryTitle: "Rohdaten zur Wiederherstellung",
    rawRecoveryDescription: "Laden Sie vor der Wiederherstellung die exakten Browserdaten herunter. Sie können ungültige oder ältere Datensätze enthalten und sind keine reguläre BudgIt-Sicherung.",
    rawRecoveryDownload: "Rohdaten herunterladen",
    rawRecoveryUnavailable: "Rohdaten zur Wiederherstellung sind nicht verfügbar.",
    rawRecoveryExported: "Rohdaten wurden heruntergeladen.",
    backupBlockedByQuarantine: "Die reguläre Sicherung wird durch historische Daten mit ungültigem Datum blockiert. Laden Sie zuerst die Rohdaten herunter.",
    saveFailureAdvice: "Laden Sie jetzt eine Sicherung herunter. Ihre neuesten Änderungen sind nur auf dieser geöffneten Seite vorhanden.",
    loadFailureAdvice: "Vorhandene Browserdaten wurden nicht verändert. Stellen Sie eine bekannte Sicherung wieder her, um sicher fortzufahren.",
    balanceCheck: "Kontostandsprognose",
    cashPosition: "Kontostand & Ausblick",
    cashPositionDesc: "Bankposition · Kontostand + erwartete Eingänge − offene Rechnungen",
    cashPositionUnavailable: "Der Kontostandsausblick ist unvollständig, solange zugehörige Beträge ungültig sind.",
    bankNow: "Jetzt auf dem Konto",
    expectedIncoming: "Erwartete Eingänge",
    unpaidBills: "Offene Rechnungen",
    projectedCash: "Voraussichtlicher Kontostand",
    availableIncludingOverdraft: "Verfügbar inkl. Dispo",
    editCashInputs: "Kontodaten bearbeiten",
    projectionDetails: "Prognosedetails",
    budgetSummary: "Budgetübersicht",
    budgetPlan: "Budgetplanung",
    projectedRemainderFormula: "Erwartete Einnahmen − geplante Ausgaben",
    balanceCheckDesc: "Kontostand plus erwartetes Geld, minus verbleibende Ausgaben.",
    pendingMoneyIn: "Erwartete Eingänge",
    pendingIncomeLabel: "Beschreibung für erwartetes Geld",
    pendingIncomeLabelPlaceholder: "Überstunden, eBay, Erstattung",
    pendingIncomeFallback: "Erwartet",
    addPendingIncome: "Erwartetes Geld hinzufügen",
    pendingMoneyTotal: "Erwartete Eingänge",
    pendingMoneyLabel: "Label / Notizen",
    pendingMoneyPlaceholder: "Gehalt, Erstattung, erwartete Überweisung",
    overdraftLimit: "Dispolimit",
    negativeOverdraft: "Der Dispo darf nicht negativ sein.",
    projectionUnavailable: "Nicht verfügbar, solange zugehörige Beträge ungültig sind.",
    pendingSourceInvalid: "Geben Sie einen gültigen Einkommensbetrag ein, bevor Sie ihn als erwartetes Geld hinzufügen.",
    availableWithOverdraft: "Verfügbar mit Dispo",
    currentBalanceShort: "Aktueller Kontostand",
    projectedAfterMoneyIn: "Voraussichtlicher Kontostand nach Eingang",
    deleteSectionConfirm: "„{name}“ und alle Elemente darin löschen?",
    clearItemsConfirm: "ALLE Elemente in „{name}“ leeren?",
    clearMonthConfirm: "Alle Einkommen und Ausgaben für diesen Monat löschen?",
    unnamed: "(unbenannt)",
    none: "(keine)",
    salary: "Gehalt",
    newSection: "Neue Gruppe",
    expense: "Ausgabe",
    sectionLabel: "Gruppenname (z. B. Kredite)",
    incomeName: "Einkommensname",
    sourceLabel: "Quelle",
    incomeDate: "Datum",
    incomeStatus: "Status",
    incomeType: "Art",
    incomeCategory_unclassified: "Nicht klassifiziert",
    incomeCategory_salary: "Gehalt",
    incomeCategory_overtime: "Überstunden",
    incomeCategory_bonus: "Bonus",
    incomeCategory_allowance: "Zulage",
    incomeCategory_employer_contribution: "Arbeitgeberbeitrag",
    incomeCategory_reimbursement: "Erstattung",
    incomeCategory_other: "Sonstiges",
    actions: "Aktionen",
    edit: "Bearbeiten",
    delete: "Löschen",
    date: "Datum",
    status: "Status",
    paidState: "Bezahlt",
    unpaidState: "Offen",
    dueLabel: "Fällig",
    entrySingular: "Eintrag",
    entryPlural: "Einträge",
    status_expected: "Erwartet",
    status_received: "Erhalten",
    status_delayed: "Verspätet",
    status_cancelled: "Storniert",
    addIncomeToPending: "Zu erwartetem Geld hinzufügen",
    includeExpenseInBalance: "In Kontostand-Check einbeziehen",
    alreadyInBalance: "Bereits einbezogen",
    incomeNoteTodo: "Einkommensnotizen sind noch nicht verknüpft.",
    expenseName: "Ausgabenname",
    breakdown: "Aufschlüsselung",
    addBreakdown: "Aufschlüsselung hinzufügen",
    addComponent: "Bestandteil hinzufügen",
    component: "Bestandteil",
    componentLabelPlaceholder: "Bezeichnung des Bestandteils",
    breakdownComplete: "Aufschlüsselung vollständig",
    breakdownIncomplete: "Unvollständig",
    breakdownOf: "von",
    breakdownUnallocated: "noch nicht zugeordnet",
    breakdownExceedsBy: "Übersteigt die Zahlung um",
    breakdownExcludesInvalid: "Schließt {count} ungültige Bestandteile aus",
    breakdownInvalidParent: "Geben Sie einen gültigen Zahlungsbetrag ein, um die Aufschlüsselung zu prüfen",
    removeBreakdown: "Aufschlüsselung entfernen",
    removeBreakdownConfirm: "Diese Aufschlüsselung und alle eingegebenen Bestandteile entfernen?",
    breakdownDataInvalid: "Diese Aufschlüsselung hat eine nicht unterstützte gespeicherte Struktur und wurde unverändert gelassen.",
    forAnalysisOnly: "Nur zur Analyse · wird nicht zu den Ausgaben addiert",
    breakdownCategory_health: "Krankenversicherung",
    breakdownCategory_pension: "Rentenversicherung",
    breakdownCategory_unemployment: "Arbeitslosenversicherung",
    breakdownCategory_long_term_care: "Pflegeversicherung",
    breakdownCategory_tax: "Steuern",
    breakdownCategory_insurance: "Versicherung",
    breakdownCategory_other: "Sonstiges",
    amount: "Betrag",
    dueDay: "Fälligkeitstag",
    setDue: "Fällig setzen",
    clickDay: "Klicken Sie auf einen Tag, um das Fälligkeitsdatum festzulegen.",
    clearDate: "Leeren",
    dueDate: "Fällig",
    selectDueDate: "Fälligkeitsdatum wählen",
    clearDueDate: "Fälligkeitsdatum löschen",
    copyNote: "Hinweis: Kopierte Elemente werden im neuen Monat auf unbezahlt gesetzt.",
    previewTip: "Tipp: Wenn die Vorschau korrekt aussieht, klicken Sie auf „Drucken / PDF speichern“ und wählen Sie „Als PDF speichern“.",
    togglePaidTitle: "Sichtbarkeit bezahlter Elemente umschalten",
    expandAllTitle: "Alle Abschnitte erweitern",
    collapseAllTitle: "Alle einklappen",
    copyNextTitle: "Diesen Monat kopieren",
    clearMonthTitle: "Diesen Monat leeren",
    prevMonthTitle: "Vorheriger Monat",
    nextMonthTitle: "Nächster Monat",
    yearTitle: "Jahr",
    monthTitle: "Monat",
    dragIncomeTitle: "Einkommenselement ziehen",
    dragSectionTitle: "Abschnitt ziehen",
    removeTitle: "Löschen",
    sortDueTitle: "Nach Fälligkeit sortieren (früheste zuerst)",
    clearPaidTitle: "Alle BEZAHLTEN Elemente in diesem Abschnitt entfernen",
    clearItemsTitle: "ALLE Elemente in diesem Abschnitt leeren",
    deleteSectionTitle: "Diese Gruppe und alle Ausgaben löschen",
    dragExpenseTitle: "Ausgabenelement ziehen",
    closeTitle: "Schließen",
    clearDueTitle: "Fälligkeitsdatum löschen",
    setDueTitle: "Fällig setzen: {d}",
    paidExpenses: "Bezahlte Ausgaben",
    calculator: "Taschenrechner",
    insights: "Einblicke",
    spendTracker: "Ausgaben-Tracker",
    addTransaction: "Transaktion hinzufügen",
    recentTransactions: "Letzte Transaktionen",
    today: "Heute",
    thisMonth: "Diesen Monat",
    paymentMethod: "Zahlungsmethode",
    card: "Karte",
    cash: "Bar",
    other: "Andere",
    category: "Kategorie",
    spent: "Ausgegeben",
    remaining: "Verbleibend",
    noTransactions: "Noch keine Transaktionen.",
    note: "Notiz",
    budgetLine: "Budgetzeile",
    search: "Suchen",
    searchPlaceholder: "Elemente suchen...",
    currentBalance: "Jetzt auf dem Konto",
    projectedBalance: "Voraussichtlicher Kontostand",
    projectedBalanceDesc: "Kontostand - Verbleibend",
    balanceAfterUnpaidExpenses: "Kontostand nach offenen Ausgaben",
    balanceAfterExpectedIncomingMoney: "Kontostand nach erwarteten Geldeingängen",
    help_about_title: "Über BudgIt",
    help_about_p1: "BudgIt ist ein lokales Budgetierungstool, das Ihnen hilft, strukturierte monatliche Budgets zu planen, zu organisieren und zu drucken. Sie können Ausgaben in benutzerdefinierte Abschnitte gruppieren, Summen automatisch berechnen und eine saubere druckbare Übersicht erstellen.",
    help_about_p2: "Alle Daten werden direkt in Ihrem Browser gespeichert. Es gibt keine Konten, keine Cloud-Speicherung und keine automatische Datenübertragung.",
    help_how_title: "Wie BudgIt funktioniert",
    help_how_intro: "BudgIt folgt einem einfachen strukturierten Arbeitsablauf:",
    help_how_step1_title: "Geben Sie Ihr Einkommen ein",
    help_how_step1_desc: "Beginnen Sie mit der Eingabe Ihres gesamten monatlichen Einkommens.",
    help_how_step2_title: "Ausgabengruppen erstellen",
    help_how_step2_desc: "Organisieren Sie Ihre Ausgaben in benutzerdefinierten Abschnitten (z. B. Wohnen, Transport, Versicherung, Essen).",
    help_how_step3_title: "Ausgabenelemente hinzufügen",
    help_how_step3_desc: "Fügen Sie einzelne Elemente in jede Gruppe ein. Die Summen werden automatisch aktualisiert.",
    help_how_step4_title: "Überprüfen Sie Ihren Kontostand",
    help_how_step4_desc: "BudgIt berechnet:",
    help_how_step4_li1: "Zwischensummen der Abschnitte",
    help_how_step4_li2: "Gesamtausgaben",
    help_how_step4_li3: "Verbleibender Saldo (Einkommen − Ausgaben)",
    help_how_step5_title: "Vorschau & Drucken",
    help_how_step5_desc: "Verwenden Sie die Vorschau, um ein sauberes, druckfertiges Budgetblatt zu erstellen. Drucken oder speichern Sie es bei Bedarf als PDF.",
    help_how_step6_title: "Sicherung exportieren",
    help_how_step6_desc: "Exportieren Sie nach größeren Aktualisierungen eine JSON-Sicherung, um Ihre Daten zu sichern.",
    help_data_title: "Wie Ihre Daten gespeichert werden",
    help_data_p1: "Ihre Daten werden lokal in diesem Browser unter Verwendung von sicherem lokalen Speicher gespeichert.",
    help_data_p2: "Das bedeutet:",
    help_data_li1: "Ihre Daten bleiben auf diesem Gerät",
    help_data_li2: "Das Löschen von Browserdaten entfernt Ihr Budget",
    help_data_li3: "Im Inkognito-/Privatmodus werden keine Daten gespeichert",
    help_data_li4: "Daten werden nicht automatisch zwischen Geräten synchronisiert",
    help_data_p3: "Für langfristige Sicherheit sind regelmäßige Sicherungen unerlässlich.",
    help_backup_title: "Sichern & Wiederherstellen",
    help_backup_p1: "<strong>Export</strong> lädt eine vollständige JSON-Sicherung Ihres aktuellen Budgets herunter.",
    help_backup_p2: "<strong>Import</strong> stellt eine zuvor exportierte JSON-Datei wieder her. Der Import ersetzt die aktuellen Budgetdaten in der App.",
    help_backup_p3: "Empfohlene Routine:",
    help_backup_li1: "Wöchentlich exportieren",
    help_backup_li2: "Nach größeren Bearbeitungen exportieren",
    help_backup_li3: "Sicherungen an zwei Orten speichern (z. B. Downloads + Drive/USB)",
    help_buttons_title: "Erklärung der Schaltflächen",
    help_buttons_li1: "<strong>Vorschau</strong> – Öffnet die druckfertige Version Ihres Budgets.",
    help_buttons_li2: "<strong>Drucken / PDF speichern</strong> – Druckt nur das Vorschaublatt. Sie können in Ihrem Browser „Als PDF speichern“ auswählen.",
    help_buttons_li3: "<strong>Export</strong> – Lädt eine JSON-Sicherungsdatei herunter.",
    help_buttons_li4: "<strong>Import</strong> – Stellt Ihr Budget aus einer JSON-Sicherungsdatei wieder her.",
    help_tech_title: "Technische Speicherschlüssel (Erweitert)",
    help_tech_p1: "App-Daten-Schlüssel:",
    help_tech_p2: "Geteilter Profilschlüssel:",
    help_notes_title: "Wichtige Hinweise",
    help_notes_p1: "BudgIt ist ein Finanzplanungstool. Alle Summen hängen von der Genauigkeit der von Ihnen eingegebenen Beträge ab.",
    help_notes_p2: "Diese App bietet keine finanzielle, steuerliche oder buchhalterische Beratung.",    
    email_subject: "BudgIt Export-Paket – {today}",
    email_body: "Anbei: PDF-Export von BudgIt (bitte die heruntergeladene PDF-Datei anhängen).\nExporte werden lokal auf Ihrem Gerät generiert. Es werden keine Daten automatisch hochgeladen.",
    export_title: "Export-Paket",
    export_subtitle: "Speichern, teilen oder sichern Sie Ihre Daten.",
    export_download_pdf_label: "PDF herunterladen",
    export_download_pdf_sub: "Als PDF speichern",
    export_print_pdf_label: "Drucken / PDF speichern",
    export_print_pdf_sub: "Druckt nur das Vorschaublatt",
    export_email_label: "E-Mail-Entwurf erstellen",
    export_email_sub: "Per E-Mail teilen",
    export_download_json_label: "Sicherung exportieren",
    export_download_json_sub: "Sichern Sie Ihre Daten",
    export_import_json_label: "Sicherung importieren",
    export_import_json_sub: "Der Import ersetzt die aktuellen App-Daten. Im Zweifelsfall zuerst exportieren.",
    financeAiTitle: "Finance-AI-Export",
    financeAiActionDescription: "Analysedatei für einen Finance GPT oder KI-Assistenten erstellen.",
    financeAiDescription: "Wählen Sie Monate und Kontext für eine lokale Analysedatei aus.",
    financeAiMonthSelection: "Enthaltene Monate",
    financeAiCurrentMonth: "Aktueller Monat",
    financeAiCurrentMonthDescription: "Den geöffneten Monat exportieren, auch wenn er leer ist.",
    financeAiSelectMonths: "Monate auswählen",
    financeAiSelectMonthsDescription: "Monate mit Finanzdaten gezielt auswählen.",
    financeAiAllMonths: "Alle relevanten Monate",
    financeAiAllMonthsDescription: "Alle Monate mit nützlichen Finanzdaten exportieren.",
    financeAiAvailableMonths: "Verfügbare Monate",
    financeAiIncludeNotes: "Notizen einschließen",
    financeAiIncludeNotesDescription: "Fügt Einnahmen-, Ausgaben- und Monatsnotizen hinzu. Standardmäßig aus.",
    financeAiPrivacy: "Erstellt nur eine lokale JSON-Datei. Es wird nichts automatisch hochgeladen. Namen, Bezeichnungen, Aufschlüsselungsdetails und optionale Notizen können persönliche Informationen enthalten.",
    financeAiDownload: "Finance-AI-Datei herunterladen",
    financeAiNoMeaningfulMonths: "Für diese Auswahl sind keine relevanten Monate verfügbar.",
    financeAiNoSelection: "Wählen Sie mindestens einen verfügbaren Monat aus.",
    financeAiInvalidCurrentMonth: "Der aktuelle Monatsschlüssel ist für den Analyseexport ungültig.",
    financeAiInvalidMonthWarning: "{count} nicht standardmäßiger historischer Monatsschlüssel wurde ausgeschlossen.",
    financeAiInvalidMonthsWarning: "{count} nicht standardmäßige historische Monatsschlüssel wurden ausgeschlossen.",
    financeAiExported: "Finance-AI-Datei heruntergeladen.",
    financeAiExportFailed: "Die Finance-AI-Datei konnte nicht erstellt werden.",
  }
};

// ---------------------------
// App
// ---------------------------

function YearValue({ value, hasData, currency }) {
  return hasData ? <Money value={value} currency={currency} /> : <span>—</span>;
}

function YearOverviewView({ app, year, onYearChange, onBack, onOpenMonth, onPrint, t }) {
  const referenceMonthKey = calendarMonthKey();
  const overview = useMemo(
    () => calculateYearOverview(app, year, { currentMonthKey: referenceMonthKey }),
    [app, year, referenceMonthKey],
  );
  const hasYearData = overview.monthsWithData > 0;
  const openMonth = (month) => {
    if (month.hasData) onOpenMonth(month.monthKey);
  };
  const handleMonthKeyDown = (event, month) => {
    if (!month.hasData || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openMonth(month);
  };
  const monthAriaLabel = (month) => t("openMonth", { month: monthLabel(month.monthKey, app.lang) });
  const primaryMetrics = [
    ["yearReceivedIncome", overview.totals.receivedIncome],
    ["yearPaidExpenses", overview.totals.paidExpenses],
    ["actualNet", overview.totals.actualNet],
    ["yearUnpaidExpenses", overview.totals.unpaidExpenses],
  ];
  const detailMetrics = [
    ["expectedIncome", overview.totals.expectedIncome, true],
    ["plannedExpenses", overview.totals.plannedExpenses, true],
    ["yearLeftAfterPlanned", overview.totals.leftAfterPlanned, true],
    ["monthsWithData", overview.monthsWithData, false],
    ["monthsWithUnpaidExpenses", overview.monthsWithUnpaidExpenses, false],
  ];

  return (
    <main className="year-overview-page">
      <header className="year-overview-header">
        <div>
          <h1 className="year-overview-title">{t("yearOverview")}</h1>
          <p className="year-overview-year" aria-live="polite">{overview.year}</p>
        </div>
        <div className="year-overview-actions print:hidden">
          <button type="button" className="year-secondary-button" onClick={onBack}>{t("backToMonth")}</button>
          <button type="button" className="year-secondary-button" onClick={onPrint}>{t("printSave")}</button>
        </div>
      </header>

      <nav className="year-navigation print:hidden" aria-label={t("yearOverview")}>
        <button type="button" className="year-nav-button" onClick={() => onYearChange(year - 1)} aria-label={t("previousYear")}>
          <span aria-hidden="true">←</span><span>{t("previousYear")}</span>
        </button>
        <strong className="year-navigation-value">{year}</strong>
        <button type="button" className="year-nav-button" onClick={() => onYearChange(year + 1)} aria-label={t("nextYear")}>
          <span>{t("nextYear")}</span><span aria-hidden="true">→</span>
        </button>
      </nav>

      {overview.quarantinedMonthCount > 0 ? (
        <div className="quarantine-status print:hidden" role="status">
          <span className="quarantine-status-mark" aria-hidden="true">!</span>
          <span>
            <strong>{t("historicalDataNeedsRecovery")}</strong>
            <span>{t(overview.quarantinedMonthCount === 1 ? "quarantinedMonthSingular" : "quarantinedMonthPlural", { count: overview.quarantinedMonthCount })}</span>
          </span>
        </div>
      ) : null}

      <section aria-label={t("yearOverview")} className="year-summary-grid">
        {primaryMetrics.map(([label, value]) => (
          <article key={label} className={`year-summary-card ${label === "actualNet" && value < 0 ? "year-summary-card-negative" : ""}`}>
            <h2>{t(label)}</h2>
            <div className="year-summary-value"><YearValue value={value} hasData={hasYearData} currency={app.currency} /></div>
            {label === "actualNet" && value < 0 ? <span className="year-negative-label">{t("negativeValue")}</span> : null}
            {label === "actualNet" && overview.actualNetProvisional ? <span className="year-provisional-label">{t("annualActualNetProvisional")}</span> : null}
          </article>
        ))}
      </section>

      <section className="year-section" aria-labelledby="planning-details-title">
        <h2 id="planning-details-title" className="year-section-title">{t("planningDetails")}</h2>
        <dl className="year-details-grid">
          {detailMetrics.map(([label, value, monetary]) => (
            <div key={label} className="year-detail-item">
              <dt>{t(label)}</dt>
              <dd>{monetary ? <YearValue value={value} hasData={hasYearData} currency={app.currency} /> : value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="year-section" aria-labelledby="monthly-overview-title">
        <h2 id="monthly-overview-title" className="year-section-title">{t("yearOverview")} — {year}</h2>
        <div className="year-table-wrap">
          <table className="year-table">
            <thead>
              <tr>
                {["tableMonth", "tableExpected", "tableReceived", "tablePlanned", "tablePaid", "tableUnpaid", "tableActualNet", "unresolvedIncome"].map((label) => (
                  <th key={label} scope="col">{t(label)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.months.map((month) => (
                <tr
                  key={month.monthKey}
                  className={month.hasData ? "year-month-row year-month-row-interactive" : "year-month-row year-month-row-empty"}
                  tabIndex={month.hasData ? 0 : undefined}
                  aria-label={month.hasData ? monthAriaLabel(month) : undefined}
                  onClick={() => openMonth(month)}
                  onKeyDown={(event) => handleMonthKeyDown(event, month)}
                >
                  <th scope="row"><span>{monthName(month.monthKey, app.lang)}</span>{!month.hasData ? <small>{t("noData")}</small> : null}</th>
                  {["expectedIncome", "receivedIncome", "plannedExpenses", "paidExpenses", "unpaidExpenses", "actualNet"].map((field) => (
                    <td key={field} className={field === "actualNet" && month.hasData && month.actualNet < 0 ? "year-negative-value" : ""}>
                      <YearValue value={month[field]} hasData={month.hasData} currency={app.currency} />
                      {field === "actualNet" && month.actualNetProvisional ? <small className="year-provisional-text">{t("provisionalActualNet")}</small> : null}
                    </td>
                  ))}
                  <td>{month.actualNetProvisional ? <span className="year-unresolved-badge">{month.historicalIncomeStatus.unresolvedExpectedCount}</span> : <span aria-label={t("no")}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="year-mobile-list">
          {overview.months.map((month) => (
            <article key={month.monthKey} className="year-month-card">
              <div className="year-month-card-header">
                <h3>{monthName(month.monthKey, app.lang)}</h3>
                {!month.hasData ? <span>{t("noData")}</span> : month.actualNetProvisional ? <span className="year-unresolved-badge">{t("unresolvedIncome")}</span> : null}
              </div>
              {month.hasData ? (
                <>
                  <dl className="year-month-card-grid">
                    {["receivedIncome", "paidExpenses", "actualNet", "unpaidExpenses", "expectedIncome", "plannedExpenses"].map((field) => (
                      <div key={field}>
                        <dt>{t(field)}</dt>
                        <dd className={field === "actualNet" && month.actualNet < 0 ? "year-negative-value" : ""}><Money value={month[field]} currency={app.currency} />{field === "actualNet" && month.actualNetProvisional ? <small className="year-provisional-text">{t("provisionalActualNet")}</small> : null}</dd>
                      </div>
                    ))}
                  </dl>
                  <button type="button" className="year-month-open-button print:hidden" onClick={() => openMonth(month)}>{monthAriaLabel(month)}</button>
                </>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="year-section" aria-labelledby="year-insights-title">
        <h2 id="year-insights-title" className="year-section-title">{t("yearInsights")}</h2>
        {!hasYearData ? <p className="year-empty-state">{t("noYearData")}</p> : (
          <dl className="year-insights-grid">
            <div><dt>{t("strongestMonth")}</dt><dd>{overview.strongestMonth ? <>{monthName(overview.strongestMonth.monthKey, app.lang)} <Money value={overview.strongestMonth.actualNet} currency={app.currency} /></> : t("unavailable")}</dd></div>
            <div><dt>{t("weakestMonth")}</dt><dd>{overview.weakestMonth ? <>{monthName(overview.weakestMonth.monthKey, app.lang)} <Money value={overview.weakestMonth.actualNet} currency={app.currency} /></> : t("unavailable")}</dd></div>
            <div><dt>{t("averageMonthlyActualNet")}</dt><dd>{overview.averages.actualNet == null ? t("unavailable") : <><Money value={overview.averages.actualNet} currency={app.currency} /><small className="year-provisional-text">{t(overview.reconciledActualNetMonthCount === 1 ? "nonProvisionalMonthBasisSingular" : "nonProvisionalMonthBasisPlural", { count: overview.reconciledActualNetMonthCount })}</small></>}</dd></div>
          </dl>
        )}
      </section>
    </main>
  );
}

export default function BudgitApp() {
  const [initialLoad] = useState(loadInitialAppState);
  const [app, setReactApp] = useState(initialLoad.app);
  const [currentView, setCurrentView] = useState("month");
  const [overviewYear, setOverviewYear] = useState(() => parseYM(initialLoad.app.activeMonth).y || new Date().getFullYear());
  const [saveStatus, setSaveStatus] = useState(initialLoad.loadFailure ? "load_error" : "saved");
  const [saveErrorCode, setSaveErrorCode] = useState(initialLoad.loadFailure);
  const [persistenceCoordinator] = useState(() =>
    createPersistenceCoordinator({
      initialState: initialLoad.app,
      storage: getBrowserStorage(),
      storageKey: LS_KEY,
      locked: !!initialLoad.loadFailure,
      onSaveStart: () => setSaveStatus("saving"),
      onSaveResult: (result) => {
        if (result.ok) {
          setSaveErrorCode(null);
          setSaveStatus("saved");
        } else {
          setSaveErrorCode(result.code);
          setSaveStatus("error");
        }
      },
    })
  );
  const setApp = (updater, options) => {
    const current = persistenceCoordinator.getLatest();
    const next = typeof updater === "function" ? updater(current) : updater;
    persistenceCoordinator.setLatest(next, options);
    setReactApp(next);
  };

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  useModalEscape(previewOpen, () => setPreviewOpen(false));
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportModalView, setExportModalView] = useState("backup");
  const [openHeaderMenu, setOpenHeaderMenu] = useState(null);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const [monthActionsOpen, setMonthActionsOpen] = useState(false);
  const headerMenusRef = useRef(null);
  const monthControlsRef = useRef(null);
  useModalEscape(!!openHeaderMenu, () => setOpenHeaderMenu(null));
  useModalEscape(monthPickerOpen || monthActionsOpen, () => {
    setMonthPickerOpen(false);
    setMonthActionsOpen(false);
  });

  useEffect(() => {
    if (!openHeaderMenu && !monthPickerOpen && !monthActionsOpen) return undefined;
    const closeOnOutsidePress = (event) => {
      if (openHeaderMenu && !headerMenusRef.current?.contains(event.target) && !monthControlsRef.current?.contains(event.target)) setOpenHeaderMenu(null);
      if ((monthPickerOpen || monthActionsOpen) && !monthControlsRef.current?.contains(event.target)) {
        setMonthPickerOpen(false);
        setMonthActionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [openHeaderMenu, monthPickerOpen, monthActionsOpen]);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const [financialDetailsOpen, setFinancialDetailsOpen] = useState(false);

  // Hide paid items (UI-only)
  const [hidePaid, setHidePaid] = useState(false);

  // Drag state (UI-only)
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);

  // Copy month menu
  const [copyOpen, setCopyOpen] = useState(false);

  // Auto-focus newly added items so you can type immediately over default values.
  const [lastAdded, setLastAdded] = useState(null);

  // Note Modal State
  const [noteModal, setNoteModal] = useState(null); // { groupId, itemId }
  const [highlightItem, setHighlightItem] = useState(null);
  const [touchedAmountFields, setTouchedAmountFields] = useState(() => new Set());
  const [expandedBreakdowns, setExpandedBreakdowns] = useState(() => new Set());

  const notify = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    persistenceCoordinator.schedule();
    const detachLifecycle = attachPersistenceLifecycle({
      windowTarget: window,
      documentTarget: document,
      flush: persistenceCoordinator.flush,
    });
    return () => {
      detachLifecycle();
      persistenceCoordinator.cancelPending();
    };
  }, [persistenceCoordinator]);

  const active = useMemo(() => {
    const m = app.activeMonth;
    return normalizeMonthData(app.months && app.months[m] ? app.months[m] : null);
  }, [app]);
  const quarantinedMonthKeys = useMemo(() => getQuarantinedMonthKeys(app.months), [app.months]);
  const rawRecoveryRead = readStorageValue(getBrowserStorage(), LS_KEY);
  const rawRecoveryAvailable = rawRecoveryRead.ok && typeof rawRecoveryRead.value === "string";

  const t = (key, args = {}) => {
    const txt = TRANSLATIONS[app.lang || "en"][key] || key;
    // simple replacement for {name}
    return txt.replace(/\{(\w+)\}/g, (_, k) => args[k] || "");
  };

  const incomeAmountTouchKey = (id) => `${app.activeMonth}:income:${id}`;
  const expenseAmountTouchKey = (groupId, id) => `${app.activeMonth}:expense:${groupId}:${id}`;
  const markAmountTouched = (key) => {
    setTouchedAmountFields((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  };

  const updateMonth = (updater) => {
    setApp((a) => {
      const m = a.activeMonth;
      const months = { ...(a.months || {}) };
      const cur = normalizeMonthData(months[m]);
      months[m] = normalizeMonthData(updater(cur));
      return { ...a, months };
    });
  };

  const ensureMonth = (m) => {
    if (!isCanonicalMonthKey(m)) return false;
    setApp((a) => {
      const months = { ...(a.months || {}) };
      if (!months[m]) months[m] = normalizeMonthData(null);
      return { ...a, activeMonth: m, months };
    });
    return true;
  };

  const setLang = (lang) => {
    setApp((a) => ({ ...a, lang }));
  };

  const currencySymbol = CURRENCIES[app.currency] || "€";

  // ---------------------------
  // Better Month Picker
  // ---------------------------

  const years = useMemo(() => {
    const nowY = new Date().getFullYear();
    const ys = getCanonicalMonthYears(app.months);
    const minY = Math.min(nowY - 3, ...(ys.length ? ys : [nowY]));
    const maxY = Math.max(nowY + 3, ...(ys.length ? ys : [nowY]));
    const out = [];
    for (let y = minY; y <= maxY; y++) out.push(y);
    return out;
  }, [app.months]);

  const activeYM = useMemo(() => parseYM(app.activeMonth), [app.activeMonth]);

  const setActiveYear = (y) => {
    const mm = clamp(activeYM.m || 1, 1, 12);
    ensureMonth(`${y}-${pad2(mm)}`);
  };

  const setActiveMonthNum = (m) => {
    const yy = activeYM.y || new Date().getFullYear();
    ensureMonth(`${yy}-${pad2(m)}`);
  };

  // ---------------------------
  // Income actions
  // ---------------------------

  const addIncome = () => {
    const item = { id: uid(), name: t("salary"), amount: "0", date: "", status: "expected", notes: "" };
    updateMonth((cur) => ({ ...cur, incomes: [item, ...(cur.incomes || [])] }));
    setLastAdded({ kind: "income", id: item.id });
  };

  const updateIncome = (id, patch) => {
    updateMonth((cur) => ({
      ...cur,
      incomes: (cur.incomes || []).map((x) => (x.id === id ? { ...x, ...patch } : x)),
    }));
  };

  const deleteIncome = (id) => {
    updateMonth((cur) => ({
      ...cur,
      incomes: (cur.incomes || []).filter((x) => x.id !== id),
    }));
  };

  const addIncomeToPending = (item) => {
    const prepared = preparePendingIncomeEntry({
      id: uid(),
      label: String(item && item.name ? item.name : t("pendingIncomeFallback")).trim(),
      amount: item && item.amount != null ? item.amount : "0",
      fallbackLabel: t("pendingIncomeFallback"),
    });
    if (!prepared.ok) {
      notify(t("pendingSourceInvalid"));
      return;
    }
    updateMonth((cur) => ({
      ...cur,
      pendingIncomeEntries: [...(cur.pendingIncomeEntries || []), prepared.entry],
    }));
  };

  const openIncomeNotePlaceholder = () => {
    // TODO: Link income rows into the existing notes workflow once notes support non-expense records.
    notify(t("incomeNoteTodo"));
  };

  // Income insert reorder
  const moveIncomeInsert = (itemId, toIndex) => {
    updateMonth((cur) => {
      const items = [...(cur.incomes || [])];
      const fromIndex = items.findIndex((x) => x.id === itemId);
      if (fromIndex < 0) return cur;
      const moved = items.splice(fromIndex, 1)[0];
      let insertAt = clamp(toIndex, 0, items.length);
      if (fromIndex < insertAt) insertAt = insertAt - 1;
      items.splice(clamp(insertAt, 0, items.length), 0, moved);
      return { ...cur, incomes: items };
    });
  };

  // ---------------------------
  // Expense groups + items
  // ---------------------------

  const addExpenseGroup = () => {
    const newId = uid();
    const group = { id: newId, label: t("newSection"), items: [] };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: [group, ...(cur.expenseGroups || [])],
    }));
  };

  const updateExpenseGroupLabel = (groupId, label) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => (g.id === groupId ? { ...g, label } : g)),
    }));
  };

  const normalizeExpenseGroupLabel = (groupId) => {
    const g = (active.expenseGroups || []).find((x) => x.id === groupId);
    const clean = String(g && g.label != null ? g.label : "").trim();
    updateExpenseGroupLabel(groupId, clean || "General");
  };

  const deleteExpenseGroup = (groupId) => {
    const g = (active.expenseGroups || []).find((x) => x.id === groupId);
    const name = String((g && g.label) || "this section").trim();
    const ok = window.confirm(t("deleteSectionConfirm", { name }));
    if (!ok) return;

    updateMonth((cur) => {
      const next = (cur.expenseGroups || []).filter((x) => x.id !== groupId);
      return {
        ...cur,
        expenseGroups: next.length ? next : [{ id: uid(), label: "General", items: [] }],
      };
    });
  };

  const addExpenseItem = (groupId) => {
    const item = { id: uid(), name: t("expense"), amount: "0", dueDay: null, paid: false };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => (g.id === groupId ? { ...g, items: [item, ...(g.items || [])] } : g)),
    }));
    setLastAdded({ kind: "expense", groupId, id: item.id });
  };

  const updateExpenseItem = (groupId, itemId, patch) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          items: (g.items || []).map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
        };
      }),
    }));
  };

  const deleteExpenseItem = (groupId, itemId) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, items: (g.items || []).filter((it) => it.id !== itemId) };
      }),
    }));
  };

  const breakdownKey = (groupId, itemId) => `${groupId}:${itemId}`;
  const toggleExpenseBreakdown = (groupId, expense) => {
    if (Object.prototype.hasOwnProperty.call(expense, "breakdown") && !Array.isArray(expense.breakdown)) {
      notify(t("breakdownDataInvalid"));
      return;
    }
    if (!Array.isArray(expense.breakdown) || expense.breakdown.length === 0) {
      updateExpenseItem(groupId, expense.id, { breakdown: [{ id: uid(), label: "", category: "other", amount: "" }] });
    }
    setExpandedBreakdowns((current) => {
      const next = new Set(current);
      const key = breakdownKey(groupId, expense.id);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const updateExpenseBreakdown = (groupId, itemId, breakdown) => updateExpenseItem(groupId, itemId, { breakdown });
  const removeExpenseBreakdown = (groupId, expense) => {
    const components = Array.isArray(expense.breakdown) ? expense.breakdown : [];
    const populated = components.some((component) => String(component?.label || "").trim() || String(component?.amount || "").trim() || (component?.category && component.category !== "other"));
    if (populated && !window.confirm(t("removeBreakdownConfirm"))) return;
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((group) => group.id !== groupId ? group : {
        ...group,
        items: (group.items || []).map((item) => {
          if (item.id !== expense.id) return item;
          const nextItem = { ...item };
          delete nextItem.breakdown;
          return nextItem;
        }),
      }),
    }));
    setExpandedBreakdowns((current) => {
      const next = new Set(current);
      next.delete(breakdownKey(groupId, expense.id));
      return next;
    });
  };

  const updateExpenseItemNote = (groupId, itemId, note, pinned) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return {
          ...g,
          items: (g.items || []).map((it) => (it.id === itemId ? { ...it, note, notePinned: pinned, noteUpdatedAt: new Date().toISOString() } : it)),
        };
      }),
    }));
    setNoteModal(null);
  };

  const handleJumpTo = (itemId) => {
    setHighlightItem(itemId);
    setTimeout(() => {
      const candidates = [...document.querySelectorAll(`[data-expense-item="${itemId}"]`)];
      const el = candidates.find((candidate) => candidate.getClientRects().length > 0)
        || document.getElementById(`item-${itemId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
    setTimeout(() => setHighlightItem(null), 2000);
  };

  // Expense insert reorder: within section + between sections
  const moveExpenseInsert = (fromGroupId, itemId, toGroupId, toIndex) => {
    updateMonth((cur) => {
      const groups = (cur.expenseGroups || []).map((g) => ({ ...g, items: [...(g.items || [])] }));
      const fromG = groups.find((g) => g.id === fromGroupId);
      const toG = groups.find((g) => g.id === toGroupId);
      if (!fromG || !toG) return cur;

      const fromIndex = fromG.items.findIndex((x) => x.id === itemId);
      if (fromIndex < 0) return cur;

      const moved = fromG.items.splice(fromIndex, 1)[0];
      if (!moved) return cur;

      let insertAt = clamp(toIndex, 0, toG.items.length);
      if (fromGroupId === toGroupId && fromIndex < insertAt) insertAt = insertAt - 1;

      toG.items.splice(clamp(insertAt, 0, toG.items.length), 0, moved);
      return { ...cur, expenseGroups: groups };
    });
  };

  const moveExpenseGroupInsert = (groupId, toIndex) => {
    updateMonth((cur) => {
      const groups = [...(cur.expenseGroups || [])];
      const fromIndex = groups.findIndex((g) => g.id === groupId);
      if (fromIndex < 0) return cur;

      const moved = groups.splice(fromIndex, 1)[0];
      let insertAt = clamp(toIndex, 0, groups.length);
      if (fromIndex < insertAt) insertAt = insertAt - 1;

      groups.splice(clamp(insertAt, 0, groups.length), 0, moved);
      return { ...cur, expenseGroups: groups };
    });
  };

  const sortGroupByDue = (groupId) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        const items = [...(g.items || [])];

        // Sort by due day (earliest first). Items with no due day go last.
        items.sort((a, b) => {
          const da = a.dueDay == null ? 999 : Number(a.dueDay);
          const db = b.dueDay == null ? 999 : Number(b.dueDay);
          if (da !== db) return da - db;
          return String(a.name || "").localeCompare(String(b.name || ""));
        });

        return { ...g, items };
      }),
    }));
  };

  const groupPlannedTotal = (group) => calculateExpenseGroupTotals(group).expenseGroupPlannedTotal;
  const groupRemainingTotal = (group) => calculateExpenseGroupTotals(group).expenseGroupUnpaidTotal;

  // ---------------------------
  // Month actions
  // ---------------------------

  const clearMonth = () => {
    const ok = window.confirm(t("clearMonthConfirm"));
    if (!ok) return;
    setApp((a) => {
      const m = a.activeMonth;
      const months = { ...(a.months || {}) };
      months[m] = normalizeMonthData({
        incomes: [],
        expenseGroups: [{ id: uid(), label: "General", items: [] }],
        notes: "",
      });
      return { ...a, months };
    });
    notify(t("monthCleared"));
  };

  const performMonthCopy = ({ destinationMonthKey, options, confirmReplace }) => {
    const result = applyValidatedMonthCopyToApp({
      app,
      sourceMonthKey: app.activeMonth,
      destinationMonthKey,
      options,
      idFactory: () => uid(),
      confirmReplace,
    });
    if (!result.ok) {
      if (result.code === "same_month") {
        notify(t("copySameMonthError"));
      } else if (result.validationErrors?.length) {
        const issue = result.validationErrors[0];
        const field = issue.path
          .replace(`months.${destinationMonthKey}.`, "")
          .replace(/expenseGroups\[(\d+)\]/, (_, index) => `expense group ${Number(index) + 1}`)
          .replace(/\.items\[(\d+)\]/, (_, index) => `, item ${Number(index) + 1}`)
          .replace(/incomes\[(\d+)\]/, (_, index) => `income ${Number(index) + 1}`)
          .replace(/\./g, ", ");
        notify(t("monthCopyValidationError", {
          month: monthLabel(destinationMonthKey, app.lang),
          field,
          problem: issue.message,
        }));
      } else {
        notify(t("monthCopyInvalid"));
      }
      return;
    }

    const persisted = persistenceCoordinator.persistExplicit(result.app);
    if (!persisted.ok) setApp(result.app, { scheduleSave: false });
    else setReactApp(result.app);
    setCopyOpen(false);
    if (persisted.ok) {
      setSaveErrorCode(null);
      setSaveStatus("saved");
      notify(t("monthCopied", {
        source: monthLabel(app.activeMonth, app.lang),
        destination: monthLabel(destinationMonthKey, app.lang),
      }));
    } else {
      setSaveErrorCode(persisted.locked ? (saveErrorCode || persisted.code) : persisted.code);
      setSaveStatus("error");
      notify(t("monthCopyNotSaved"));
    }
  };

  // ---------------------------
  // Export / Import
  // ---------------------------

  const exportJSON = () => {
    const backup = createBackupEnvelope(app);
    if (!backup.valid) {
      if (getQuarantinedMonthKeys(app.months).length) {
        notify(t("backupBlockedByQuarantine"));
        return;
      }
      const detail = backup.errors[0] ? backup.errors[0].message : t("invalidBackup");
      notify(`${t("backupExportFailed")} ${detail}`);
      return;
    }
    const blob = new Blob([JSON.stringify(backup.envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `toolstack-budgit-${app.activeMonth}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportRawRecovery = () => {
    const stored = readStorageValue(getBrowserStorage(), LS_KEY);
    const recovery = stored.ok ? createRawRecoveryFile(stored.value) : { ok: false };
    if (!recovery.ok) {
      notify(t("rawRecoveryUnavailable"));
      return false;
    }
    const blob = new Blob([recovery.content], { type: recovery.mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recovery.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    notify(t("rawRecoveryExported"));
    return true;
  };

  const openExportDestination = (view) => {
    setOpenHeaderMenu(null);
    setExportModalView(view);
    setExportModalOpen(true);
  };

  const createEmailDraft = () => {
    setOpenHeaderMenu(null);
    const today = new Date().toISOString().split("T")[0];
    const subject = encodeURIComponent(t("email_subject", { today }));
    const body = encodeURIComponent(t("email_body"));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const exportFinanceAnalysis = ({ mode, selectedMonthKeys, includeNotes }) => {
    const result = createFinanceAnalysisExport({
      app,
      mode,
      currentMonthKey: app.activeMonth,
      selectedMonthKeys,
      includeNotes,
    });
    if (!result.ok) {
      notify(t("financeAiExportFailed"));
      return false;
    }
    try {
      const blob = new Blob([JSON.stringify(result.document, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify(t("financeAiExported"));
      return true;
    } catch {
      notify(t("financeAiExportFailed"));
      return false;
    }
  };

  const importJSON = async (file) => {
    if (!file) return;
    if (file.size > BACKUP_LIMITS.maxFileBytes) {
      notify(t("backupTooLarge"));
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch {
      notify(t("invalidBackup"));
      return;
    }
    const validation = parseAndValidateBackup(text);
    if (!validation.valid) {
      const firstError = validation.errors[0];
      notify(`${t("invalidBackup")} ${firstError ? firstError.message : ""}`.trim());
      return;
    }

    const summary = validation.summary;
    const ok = window.confirm(t("importSummary", {
      months: summary.months,
      incomes: summary.incomes,
      expenses: summary.expenses,
      format: validation.format === "legacy" ? t("legacyBackup") : t("versionedBackup"),
    }));
    if (!ok) return;

    const next = prepareRestoredApp(validation.data, app.lang);
    const persisted = persistenceCoordinator.persistExplicit(next, { allowWhileLocked: true });
    if (!persisted.ok) {
      setSaveErrorCode(persisted.code);
      setSaveStatus("error");
      notify(t("importSaveFailed"));
      return;
    }
    persistenceCoordinator.setLocked(false);
    setReactApp(next);
    setSaveErrorCode(null);
    setSaveStatus("imported");
  };

  const openPreview = () => setPreviewOpen(true);
  const openCalculator = () => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("android")) {
      window.location.href = "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_CALCULATOR;end";
    } else {
      window.location.href = "ms-calculator:";
    }
  };

  // ---------------------------
  // Drag & drop helpers
  // ---------------------------

  const setDragPayload = (payload, e) => {
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.setData("text/plain", JSON.stringify(payload));
    } catch {
      // ignore
    }
    setTimeout(() => setDrag(payload), 0);
  };

  const readDragPayload = (e) => {
    try {
      const j = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
      if (!j) return drag;
      const p = safeParse(j, null);
      return p || drag;
    } catch {
      return drag;
    }
  };

  const clearDragState = () => {
    setDrag(null);
    setDropHint(null);
  };

  // ---------------------------
  // Totals
  // ---------------------------

  const monthTotals = useMemo(() => calculateMonthTotals(active), [active]);
  const historicalIncomeStatus = useMemo(
    () => analyzeHistoricalIncome(app.activeMonth, active, { currentMonthKey: calendarMonthKey() }),
    [app.activeMonth, active],
  );
  const invalidIncomeAmounts = useMemo(
    () => monthTotals.invalidAmounts.filter((issue) => issue.scope === "income"),
    [monthTotals.invalidAmounts],
  );
  const invalidExpenseAmounts = useMemo(
    () => monthTotals.invalidAmounts.filter((issue) => issue.scope === "expense"),
    [monthTotals.invalidAmounts],
  );
  const incomeAmountIssues = useMemo(
    () => new Map(invalidIncomeAmounts.map((issue) => [issue.id, issue])),
    [invalidIncomeAmounts],
  );
  const expenseAmountIssues = useMemo(
    () => new Map(invalidExpenseAmounts.map((issue) => [`${issue.groupId}:${issue.id}`, issue])),
    [invalidExpenseAmounts],
  );
  const invalidIncomeCount = invalidIncomeAmounts.length;
  const invalidExpenseCount = invalidExpenseAmounts.length;
  const invalidAmountNotice = (count) => t(count === 1 ? "excludesInvalidAmount" : "excludesInvalidAmounts", { count });
  const amountIssueMessage = (issue) => t(issue?.reason === "negative_not_allowed" ? "negativeExpenseAmount" : "invalidAmount");
  const incomeTotal = monthTotals.expectedIncome;
  const expensePlannedTotal = monthTotals.plannedExpenses;
  const expenseRemainingTotal = monthTotals.unpaidExpenses;
  const expensePaidTotal = monthTotals.paidExpenses;
  const netRemaining = monthTotals.leftAfterPlannedExpenses;
  const savingsRate = monthTotals.savingsRate;
  const expenseAttention = createExpenseAttentionSummary({
    activeMonth: app.activeMonth,
    expenseGroups: active.expenseGroups,
    currentDate: new Date(),
  });

  // ---------------------------
  // Print preview computed
  // ---------------------------

  const previewIncomes = active.incomes || [];
  const previewGroups = active.expenseGroups || [];
  const visibleIncomes = (active.incomes || []).filter((i) => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return (
      (i.name || "").toLowerCase().includes(q) ||
      (i.amount || "").toString().includes(searchTerm) ||
      (i.date || "").includes(searchTerm) ||
      (i.notes || "").toLowerCase().includes(q) ||
      t(`status_${i.status || "expected"}`).toLowerCase().includes(q)
    );
  });

  // ---------------------------
  // Self-tests (minimal)
  // ---------------------------

  useEffect(() => {
    try {
      const t = normalizeMonthData(null);
      console.assert(Array.isArray(t.expenseGroups) && t.expenseGroups.length >= 1, "normalizeMonthData should create at least one group");

      // dueInfo: Feb 2024 has 29 days.
      const di = dueInfo("2024-02", 31);
      console.assert(di && di.actual === 29, "dueInfo should clamp to last day of month");
      console.assert(di && String(di.display).includes("*"), "dueInfo should mark clamped days with *");

      // move simulation: g1 → g2
      const g1 = { id: "g1", label: "A", items: [{ id: "i1", name: "x", amount: "1", paid: false, dueDay: 1 }] };
      const g2 = { id: "g2", label: "B", items: [] };
      const m = normalizeMonthData({ incomes: [], expenseGroups: [g1, g2], notes: "" });
      const before = m.expenseGroups[0].items.length;

      const sim = (() => {
        const cur = { ...m, expenseGroups: m.expenseGroups.map((gg) => ({ ...gg, items: [...gg.items] })) };
        const groups = cur.expenseGroups;
        const fromG = groups.find((gg) => gg.id === "g1");
        const toG = groups.find((gg) => gg.id === "g2");
        const fromIndex = fromG.items.findIndex((x) => x.id === "i1");
        const mv = fromG.items.splice(fromIndex, 1)[0];
        toG.items.splice(0, 0, mv);
        return cur;
      })();

      console.assert(sim.expenseGroups[0].items.length === before - 1, "sim move should remove from source");
      console.assert(sim.expenseGroups[1].items.length === 1, "sim move should insert into target");
    } catch {
      // ignore
    }
  }, []);

  // ---------------------------
  // Render
  // ---------------------------

  if (currentView === "year") {
    return (
      <YearOverviewView
        app={app}
        year={overviewYear}
        onYearChange={setOverviewYear}
        onBack={() => setCurrentView("month")}
        onOpenMonth={(selectedMonth) => {
          if (!Object.prototype.hasOwnProperty.call(app.months || {}, selectedMonth)) return;
          setApp((current) => ({ ...current, activeMonth: selectedMonth }));
          setCurrentView("month");
        }}
        onPrint={() => window.print()}
        t={t}
      />
    );
  }

  return (
    <div className="app-shell">
      <style>{`
        :root { color-scheme: light; }
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-none { border: none !important; }
          .print\\:p-0 { padding: 0 !important; }
        }
      `}</style>

      {noteModal && (() => {
        const g = active.expenseGroups.find(g => g.id === noteModal.groupId);
        const item = g?.items.find(i => i.id === noteModal.itemId);
        return (
          <NoteEditorModal
            open={!!noteModal}
            onClose={() => setNoteModal(null)}
            item={item}
            groupName={g?.label}
            onSave={(text, pinned) => updateExpenseItemNote(noteModal.groupId, noteModal.itemId, text, pinned)}
            onClear={() => updateExpenseItemNote(noteModal.groupId, noteModal.itemId, "", false)}
            t={t}
          />
        );
      })()}

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} t={t} />
      {copyOpen && (
        <MonthCopyModal
          key={app.activeMonth}
          sourceMonthKey={app.activeMonth}
          sourceMonth={active}
          months={app.months || {}}
          lang={app.lang}
          onClose={() => setCopyOpen(false)}
          onCopy={performMonthCopy}
          t={t}
        />
      )}
      {exportModalOpen ? <ExportModal
        open={exportModalOpen}
        initialView={exportModalView}
        onClose={() => setExportModalOpen(false)}
        onBackup={exportJSON}
        onImport={importJSON}
        onFinanceExport={exportFinanceAnalysis}
        onRawRecovery={exportRawRecovery}
        rawRecoveryAvailable={rawRecoveryAvailable}
        quarantinedMonthCount={quarantinedMonthKeys.length}
        activeMonth={app.activeMonth}
        months={app.months || {}}
        lang={app.lang}
        t={t}
      /> : null}

      {previewOpen ? (
        <style>{`
          @media print {
            @page { margin: 5mm; size: auto; }
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body * { visibility: hidden !important; }
            #budgit-print-preview, #budgit-print-preview * { visibility: visible !important; }
            #budgit-print-preview { position: absolute !important; left: 0; top: 0; width: 100%; margin: 0 !important; padding: 0 !important; }
          }
        `}</style>
      ) : null}

      {previewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:p-0 print:static print:block print:h-auto">
          <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity print:hidden" onClick={() => setPreviewOpen(false)} />

          <div role="dialog" aria-modal="true" aria-labelledby="print-preview-title" className="modal-surface flex max-h-[90vh] w-full max-w-4xl flex-col print:static print:max-h-none print:w-full print:max-w-none print:transform-none print:overflow-visible print:rounded-none print:border-0 print:shadow-none">
            
            <div className="px-8 pt-8 pb-6 flex items-start justify-between shrink-0 print:hidden">
              <div>
                <div className="inline-block">
                  <h2 id="print-preview-title" className="font-bold text-3xl text-neutral-900 tracking-tight">{t("printPreview")}</h2>
                  <div className="mt-2 h-1 w-full rounded-full bg-[#D5FF00]" />
                </div>
                <div className="text-sm text-neutral-500 mt-3 font-medium max-w-md">{t("previewTip")}</div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className={`min-h-11 px-5 rounded-xl bg-[#D5FF00] hover:bg-[#c7f000] text-neutral-900 font-bold text-sm transition flex items-center gap-2 shadow-sm active:scale-[0.98] ${BUTTON_FOCUS}`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  {t("printSave")}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  aria-label={t("close")}
                  className={`h-11 w-11 rounded-xl bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition ${BUTTON_FOCUS}`}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            <div className="overflow-y-auto p-4 pt-0 sm:p-8 sm:pt-0 print:p-0 print:overflow-visible">
              <div id="budgit-print-preview" className="p-4 sm:p-8 border border-neutral-100 rounded-2xl bg-white print:border-none print:p-0 print:rounded-none">
                <div className="flex items-start justify-between gap-4 print:gap-2">
                  <div>
                    <img src={budgitLogo} alt="BudgIt" className="h-16 w-auto object-contain mb-2 print:h-20 print:mb-2" />
                    <div className="text-sm text-neutral-700 print:text-4xl print:font-bold print:text-neutral-900">{monthLabel(app.activeMonth, app.lang)}</div>
                    <div className="mt-3 h-[2px] w-64 rounded-full bg-gradient-to-r from-[#D5FF00]/0 via-[#D5FF00] to-[#D5FF00]/0 print:mt-2 print:h-[2px]" />
                  </div>
                  <div className="text-xs text-neutral-500 print:text-[10px]">{t("generated")}: {new Date().toLocaleString()}</div>
                </div>

                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 print:grid-cols-2 print:mt-3 print:gap-4">
                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-bold text-xl text-neutral-900 print:text-3xl print:py-3 print:px-4">{t("income")}</div>
                    <div className="p-4 space-y-2 print:p-2 print:space-y-1">
                      {!historicalIncomeStatus.historicalIncomeOutcomeComplete ? (
                        <div className="historical-income-warning" role="status">
                          <strong>{t("incomeStatusIncomplete")}</strong>
                          <span>{t("historicalIncomePrintWarning")}</span>
                        </div>
                      ) : null}
                      {previewIncomes.length === 0 ? (
                        <div className="text-sm text-neutral-700 print:text-xs">{t("noIncome")}</div>
                      ) : (
                        previewIncomes.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-3 print:text-xs">
                            <div className="text-neutral-800 break-words font-medium">
                              {i.name || t("unnamed")}
                              {typeof i.category === "string" && i.category.trim() ? <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-neutral-500">{INCOME_CATEGORIES.includes(i.category) ? t(`incomeCategory_${i.category}`) : i.category}</span> : null}
                            </div>
                            <div className="font-semibold text-neutral-800">
                              <Money value={i.amount} currency={app.currency} invalidLabel={t("invalidAmount")} />
                            </div>
                          </div>
                        ))
                      )}
                      <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between print:pt-2 print:mt-2">
                        <div>
                          <div className="font-semibold text-neutral-800 print:text-sm">{t("totalIncome")}</div>
                          {invalidIncomeCount > 0 ? <div className="text-xs font-medium text-red-700">{invalidAmountNotice(invalidIncomeCount)}</div> : null}
                        </div>
                        <div className="font-semibold text-neutral-800 print:text-sm">
                          <Money value={incomeTotal} currency={app.currency} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-bold text-xl text-neutral-900 print:text-3xl print:py-3 print:px-4">{t("expenses")}</div>
                    <div className="p-4 space-y-4 print:p-2 print:space-y-2">
                      {previewGroups.length === 0 ? (
                        <div className="text-sm text-neutral-700 print:text-xs">{t("noExpenses")}</div>
                      ) : (
                        previewGroups.map((g) => (
                          <div key={g.id} className="rounded-2xl border border-neutral-200 print:rounded-lg">
                            <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between bg-neutral-50 print:bg-neutral-100 print:py-1 print:px-2">
                              <div className="font-semibold text-neutral-800 print:text-xs">{String((g.label || "General")).trim()}</div>
                              <div className="text-sm text-neutral-700 print:text-[10px]">
                                {t("remainingExpenses")}: <span className="font-semibold text-neutral-800">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span>
                                <span className="text-neutral-400"> • </span>
                                {t("plannedExpenses")}: <span className="font-medium">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span>
                              </div>
                            </div>
                            <div className="p-3 space-y-2 print:p-2 print:space-y-1">
                              {(g.items || []).length === 0 ? (
                                <div className="text-sm text-neutral-700 print:text-xs">{t("noItemsSection")}</div>
                              ) : (
                                (g.items || []).map((e) => {
                                  const info = dueInfo(app.activeMonth, e.dueDay, app.lang);
                                  return (
                                    <div key={e.id} className="flex items-center justify-between gap-3 print:text-xs">
                                      <div className="text-neutral-800 break-words font-medium">
                                        {e.paid ? "✓ " : ""}
                                        {e.name || t("unnamed")}
                                        {info ? (
                                          <span className="text-neutral-600" title={info.title} style={{ whiteSpace: 'nowrap' }}>
                                            {" "}({t("due")} {info.display})
                                          </span>
                                        ) : null}
                                        {Array.isArray(e.breakdown) && e.breakdown.length ? (
                                          <div className="mt-1 border-l border-neutral-300 pl-3 text-[11px] font-normal text-neutral-600 print:text-[9px]">
                                            <div className="font-semibold uppercase tracking-wide">{t("breakdown")} · {t("forAnalysisOnly")}{!analyzeExpenseBreakdown(e).complete ? ` · ${t("breakdownIncomplete")}` : ""}</div>
                                            {e.breakdown.map((component) => (
                                              <div key={component.id} className="flex justify-between gap-4">
                                                <span>{component.label || t("component")} · {EXPENSE_BREAKDOWN_CATEGORIES.includes(component.category) ? t(`breakdownCategory_${component.category}`) : (component.category || t("breakdownCategory_other"))}</span>
                                                <Money value={component.amount} currency={app.currency} invalidLabel={t("invalidAmount")} />
                                              </div>
                                            ))}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div className="text-neutral-800">
                                        <Money value={e.amount} currency={app.currency} invalidLabel={amountIssueMessage(expenseAmountIssues.get(`${g.id}:${e.id}`))} />
                                      </div>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        ))
                      )}

                      <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between print:pt-2 print:mt-1">
                        <div>
                          <div className="font-semibold text-neutral-800 print:text-sm">{t("remainingExpenses")}</div>
                          <div className="text-xs text-neutral-600 print:text-[10px]">{t("plannedExpenses")}: {currencySymbol}{expensePlannedTotal.toFixed(2)}</div>
                          {invalidExpenseCount > 0 ? <div className="text-xs font-medium text-red-700">{invalidAmountNotice(invalidExpenseCount)}</div> : null}
                        </div>
                        <div className="font-semibold text-neutral-800 print:text-sm">
                          <Money value={expenseRemainingTotal} currency={app.currency} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 break-inside-avoid print:grid-cols-2 print:mt-3 print:gap-4">
                  <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-[#D5FF00]" : "border-red-200"}`}>
                    <div className="text-sm text-neutral-700 print:text-xs">{t("netRemaining")}</div>
                    <div className="text-2xl font-semibold text-neutral-800 mt-1 print:text-xl">
                      <Money value={netRemaining} currency={app.currency} />
                    </div>
                    <div className="text-xs text-neutral-700 mt-2 print:text-[10px]">
                      {t("savingsRate")}: <span className="font-medium">{savingsRate == null ? "—" : `${savingsRate.toFixed(1)}%`}</span>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 p-4">
                    <div className="text-sm text-neutral-700 print:text-xs">{t("notes")}</div>
                    <div className="mt-2 whitespace-pre-wrap text-neutral-800 text-sm print:text-xs">{String(active.notes || "").trim() ? active.notes : t("none")}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="brand-header" ref={headerMenusRef}>
          <div className="brand-nav-cluster">
            <img src={budgitLogo} alt="BudgIt" className="brand-logo" />

            <nav className="primary-header-nav print:hidden" aria-label={t("primaryNavigation")}>
              {["tools", "export", "settings"].map((menu) => <div key={menu} className="header-menu-wrap">
                <button type="button" className={`header-menu-launcher ${openHeaderMenu === menu ? "header-menu-launcher-active" : ""} ${BUTTON_FOCUS}`} onClick={() => setOpenHeaderMenu((open) => open === menu ? null : menu)} aria-expanded={openHeaderMenu === menu} aria-haspopup="dialog" aria-controls={`header-${menu}-menu`}><span>{t(menu)}</span><ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${openHeaderMenu === menu ? "rotate-180" : ""}`} /></button>
                {openHeaderMenu === menu ? <div id={`header-${menu}-menu`} className="header-menu-panel" role="dialog" aria-label={t(menu)}>
                  {menu === "export" ? <>
                    <button type="button" onClick={() => openExportDestination("finance")}><ExportIcons.Spark /><span><strong>{t("financeAiMenu")}</strong><small>{t("financeAiMenuDescription")}</small></span></button>
                    <button type="button" onClick={() => { setOpenHeaderMenu(null); openPreview(); }}><ExportIcons.Print /><span><strong>{t("print")}</strong><small>{t("printMenuDescription")}</small></span></button>
                    <button type="button" onClick={() => openExportDestination("backup")}><ExportIcons.Download /><span><strong>{t("backupRestore")}</strong><small>{t("backupRestoreDescription")}</small></span></button>
                    <button type="button" onClick={createEmailDraft}><ExportIcons.Mail /><span><strong>{t("emailDraft")}</strong><small>{t("emailDraftDescription")}</small></span></button>
                  </> : null}
                  {menu === "tools" ? <>
                    <button type="button" onClick={() => { setOpenHeaderMenu(null); openCalculator(); }}><CalculatorIcon className="h-5 w-5" /><span><strong>{t("calculator")}</strong></span></button>
                    <button type="button" onClick={() => { setOpenHeaderMenu(null); setHelpOpen(true); }}><span aria-hidden="true">?</span><span><strong>{t("help")}</strong></span></button>
                    {HUB_URL ? <button type="button" onClick={() => { setOpenHeaderMenu(null); window.location.href = HUB_URL; }}><span aria-hidden="true">↗</span><span><strong>{t("hub")}</strong></span></button> : null}
                  </> : null}
                  {menu === "settings" ? <div className="header-settings-panel">
                    <div><span className="header-settings-label">{t("language")}</span><div className="command-choice-row">{["en", "de"].map((lang) => <button key={lang} type="button" aria-pressed={app.lang === lang} onClick={() => setLang(lang)} className={`command-choice ${app.lang === lang ? "command-choice-active" : ""} ${BUTTON_FOCUS}`}>{lang.toUpperCase()}</button>)}</div></div>
                    <div><span className="header-settings-label">{t("currency")}</span><div className="command-choice-row">{Object.keys(CURRENCIES).map((currency) => <button key={currency} type="button" aria-pressed={app.currency === currency} onClick={() => setApp((current) => ({ ...current, currency }))} className={`command-choice ${app.currency === currency ? "command-choice-active" : ""} ${BUTTON_FOCUS}`}>{currency}</button>)}</div></div>
                  </div> : null}
                </div> : null}
              </div>)}
            </nav>
          </div>

          <div className="top-utility-area print:hidden">
            <div role="status" aria-live={saveStatus === "error" || saveStatus === "load_error" ? "assertive" : "polite"} title={saveErrorCode || undefined} className={`header-save-state ${saveStatus === "error" || saveStatus === "load_error" ? "header-save-state-error" : ""}`}>
              <span className={`command-save-dot ${saveStatus === "saving" ? "command-save-dot-saving" : ""}`} aria-hidden="true" />
              <span>{saveStatus === "saving" && t("saveStatusSaving")}{saveStatus === "saved" && t("saveStatusSaved")}{saveStatus === "imported" && t("saveStatusImported")}{saveStatus === "error" && t("saveStatusError")}{saveStatus === "load_error" && t("saveStatusLoadError")}</span>
            </div>
            {saveStatus === "error" || saveStatus === "load_error" ? <div className="command-save-error">{saveStatus === "error" ? t("saveFailureAdvice") : t("loadFailureAdvice")}</div> : null}
            {quarantinedMonthKeys.length > 0 ? <div className="quarantine-status" role="status"><span className="quarantine-status-mark" aria-hidden="true">!</span><span><strong>{t("historicalDataNeedsRecovery")}</strong><span>{t(quarantinedMonthKeys.length === 1 ? "quarantinedMonthSingular" : "quarantinedMonthPlural", { count: quarantinedMonthKeys.length })}</span></span></div> : null}
          </div>
        </div>

        <div className="month-top-surface mt-5 print:shadow-none" ref={monthControlsRef}>
            <div className="month-toolbar">
              <div className="month-navigator">
                <button type="button" className={`month-nav-arrow ${BUTTON_FOCUS}`} onClick={() => ensureMonth(addMonths(app.activeMonth, -1))} aria-label={t("prevMonthTitle")}>‹</button>
                <div className="month-picker-wrap">
                  <button type="button" className={`month-current-button ${BUTTON_FOCUS}`} onClick={() => setMonthPickerOpen((open) => !open)} aria-expanded={monthPickerOpen} aria-controls="month-picker-panel">
                    <span>{monthLabel(app.activeMonth, app.lang)}</span><ChevronDownIcon className={`h-4 w-4 transition-transform ${monthPickerOpen ? "rotate-180" : ""}`} />
                  </button>
                  {monthPickerOpen ? <div id="month-picker-panel" className="month-picker-panel">
                    <label><span>{t("monthTitle")}</span><select value={activeYM.m || 1} onChange={(e) => { setActiveMonthNum(Number(e.target.value)); setMonthPickerOpen(false); }}>{Array.from({ length: 12 }).map((_, i) => <option key={i + 1} value={i + 1}>{new Date(2000, i, 1).toLocaleDateString(app.lang === "de" ? "de-DE" : "en-US", { month: "long" })}</option>)}</select></label>
                    <label><span>{t("yearTitle")}</span><select value={activeYM.y || new Date().getFullYear()} onChange={(e) => { setActiveYear(Number(e.target.value)); setMonthPickerOpen(false); }}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
                  </div> : null}
                </div>
                <button type="button" className={`month-nav-arrow ${BUTTON_FOCUS}`} onClick={() => ensureMonth(addMonths(app.activeMonth, 1))} aria-label={t("nextMonthTitle")}>›</button>
                <button type="button" className={`month-year-view ${BUTTON_FOCUS}`} onClick={() => { setOverviewYear(activeYM.y || new Date().getFullYear()); setCurrentView("year"); }}>{t("yearOverview")}</button>
              </div>

              <div className="ledger-context-row">
                <div><div className="ledger-context-label">{t("monthlyLedger")}</div><div className="accent-rule" /></div>
                <div className="desktop-ledger-actions">
                  <button type="button" className={`ledger-context-action ${BUTTON_FOCUS}`} onClick={() => setCopyOpen(true)}>{t("copyMonth")}</button>
                  <button type="button" className={`ledger-context-action ${BUTTON_FOCUS}`} onClick={() => setSearchOpen((open) => !open)}><SearchIcon className="h-4 w-4" />{t("search")}</button>
                  <div className="month-actions-wrap"><button type="button" className={`ledger-context-action ${BUTTON_FOCUS}`} onClick={() => setMonthActionsOpen((open) => !open)} aria-expanded={monthActionsOpen} aria-controls="month-actions-menu">{t("monthActions")}<ChevronDownIcon className="h-4 w-4" /></button>{monthActionsOpen ? <div id="month-actions-menu" className="month-actions-menu"><button type="button" onClick={() => { setMonthActionsOpen(false); clearMonth(); }}>{t("startAgain")}</button></div> : null}</div>
                </div>
              </div>

              <div className="mobile-ledger-actions">
                <button type="button" onClick={() => { setOverviewYear(activeYM.y || new Date().getFullYear()); setCurrentView("year"); }}>{t("yearShort")}</button>
                <button type="button" onClick={() => setCopyOpen(true)}>{t("copyShort")}</button>
                <button type="button" onClick={() => setSearchOpen((open) => !open)}>{t("search")}</button>
                <button type="button" onClick={() => setMonthActionsOpen((open) => !open)} aria-expanded={monthActionsOpen} aria-controls="mobile-month-actions-menu">{t("actions")}</button>
              </div>

              {monthActionsOpen ? <div id="mobile-month-actions-menu" className="mobile-month-actions-menu"><button type="button" onClick={() => { setMonthActionsOpen(false); clearMonth(); }}>{t("startAgain")}</button></div> : null}

              {searchOpen ? <div className="ledger-search-row"><input autoFocus placeholder={t("searchPlaceholder")} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearchTerm(""); } }} /><button type="button" onClick={() => { setSearchOpen(false); setSearchTerm(""); }} aria-label={t("close")}>×</button></div> : null}
            </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="primary-surface order-2 md:order-1 md:col-span-2 print:shadow-none">
            <div className="min-w-0 max-w-full p-4 space-y-4">
              {/* Income */}
              <section className="ledger-section">
                <div className="ledger-section-header">
                  <h2 className="ledger-section-title">{t("income")}</h2>
                  <SmallButton tone="primary" onClick={addIncome} className="!py-1.5 !text-xs">
                    {t("addIncome")}
                  </SmallButton>
                </div>

                <div className="px-3 pb-3">
                  {!searchTerm && (
                    <InsertDropZone
                      active={dropHint && dropHint.type === "incomeInsert" && dropHint.index === 0}
                      onDragOver={(e) => {
                        const p = readDragPayload(e);
                        if (!p || p.type !== "income") return;
                        e.preventDefault();
                        setDropHint({ type: "incomeInsert", index: 0 });
                      }}
                      onDrop={(e) => {
                        const p = readDragPayload(e);
                        if (!p || p.type !== "income") return;
                        e.preventDefault();
                        moveIncomeInsert(p.itemId, 0);
                        clearDragState();
                      }}
                    />
                  )}

                  {visibleIncomes.length === 0 ? (
                    <div className="ledger-empty-state">{t("noIncome")}</div>
                  ) : (
                    <>
                    <div className="mobile-entry-list">
                      {visibleIncomes.map((income) => {
                        const mobileIncome = getMobileIncomePresentation(income);
                        const amountIssue = incomeAmountIssues.get(income.id);
                        const amountTouched = touchedAmountFields.has(incomeAmountTouchKey(income.id));
                        const showAmountError = amountTouched && !!amountIssue;
                        const amountErrorId = `mobile-income-amount-error-${income.id}`;
                        return (
                          <article key={income.id} className="mobile-entry-card" aria-labelledby={`mobile-income-${income.id}`}>
                            <div className="flex items-start gap-3">
                              {!searchTerm ? (
                                <div draggable onDragStart={(event) => setDragPayload({ type: "income", itemId: income.id }, event)} onDragEnd={clearDragState} className="mobile-entry-action flex min-h-11 w-11 shrink-0 cursor-grab items-center justify-center px-0 touch-pan-y" title={t("dragIncomeTitle")} aria-label={t("dragIncomeTitle")}>⋮</div>
                              ) : null}
                              <label className="mobile-entry-heading">
                                <span className="mobile-entry-label">{t("incomeName")}</span>
                                <input id={`mobile-income-${income.id}`} className="mobile-entry-input font-semibold" value={mobileIncome.name} onChange={(event) => updateIncome(income.id, { name: event.target.value })} placeholder={t("incomeName")} />
                              </label>
                              <div className="mobile-entry-amount pt-5"><Money value={mobileIncome.amount} currency={app.currency} invalidLabel={t("invalidAmount")} /></div>
                            </div>
                            <label className="mt-3 block">
                              <span className="mobile-entry-label">{t("amount")}</span>
                              <SelectAllNumberInput
                                className={`mobile-entry-input text-right tabular-nums ${showAmountError ? "border-red-400 ring-1 ring-red-200" : ""}`}
                                value={mobileIncome.amount == null ? "0" : mobileIncome.amount}
                                onChange={(event) => updateIncome(income.id, { amount: event.target.value })}
                                onBlur={() => markAmountTouched(incomeAmountTouchKey(income.id))}
                                inputMode="decimal"
                                title={t("amount")}
                                ariaInvalid={showAmountError}
                                ariaDescribedBy={showAmountError ? amountErrorId : undefined}
                              />
                              {showAmountError ? <span id={amountErrorId} className="mt-1 block text-xs font-medium text-red-700">{amountIssueMessage(amountIssue)}</span> : null}
                            </label>
                            <div className="mobile-entry-meta mt-3 grid-cols-2">
                              <label>
                                <span className="mobile-entry-label">{t("status")}</span>
                                <select className="mobile-entry-input" value={INCOME_STATUSES.includes(mobileIncome.status) ? mobileIncome.status : "expected"} onChange={(event) => updateIncome(income.id, { status: event.target.value })}>
                                  {INCOME_STATUSES.map((status) => <option key={status} value={status}>{t(`status_${status}`)}</option>)}
                                </select>
                              </label>
                              <label>
                                <span className="mobile-entry-label">{t("incomeType")}</span>
                                <IncomeCategorySelect className="mobile-entry-input" value={income.category} onChange={(event) => updateIncome(income.id, { category: event.target.value || undefined })} t={t} />
                              </label>
                            </div>
                            {mobileIncome.date ? <div className="mt-3 text-sm text-neutral-700"><span className="mobile-entry-label">{t("date")}</span>{mobileIncome.date}</div> : null}
                            {mobileIncome.notes ? <div className="mobile-entry-notes mt-3"><span className="mobile-entry-label">{t("notes")}</span>{mobileIncome.notes}</div> : null}
                            <div className="mobile-entry-actions print:hidden">
                              <button type="button" className="mobile-entry-action" onClick={() => document.getElementById(`mobile-income-${income.id}`)?.focus()}>{t("edit")}</button>
                              <button type="button" className="mobile-entry-action" onClick={() => addIncomeToPending(income)} title={t("addIncomeToPending")}>{t("addIncomeToPending")}</button>
                              <button type="button" className="mobile-entry-action" onClick={openIncomeNotePlaceholder}>{t("notes")}</button>
                              <button type="button" className="mobile-entry-action-danger ml-auto" onClick={() => deleteIncome(income.id)} aria-label={`${t("delete")}: ${mobileIncome.name || t("incomeName")}`}>{t("delete")}</button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <div className="desktop-entry-table">
                      <div className="ledger-table">
                        <div className="ledger-grid-income ledger-table-heading">
                          <div />
                          <div>{t("sourceLabel")}</div>
                          <div className="ledger-table-amount">{t("amount")} ({app.currency})</div>
                          <div className="text-center">{t("incomeType")}</div>
                          <div className="text-center">{t("incomeStatus")}</div>
                          <div className="text-center">{t("actions")}</div>
                        </div>
                        <div>
                    {visibleIncomes.map((i, idx) => {
                      const amountIssue = incomeAmountIssues.get(i.id);
                      const amountTouched = touchedAmountFields.has(incomeAmountTouchKey(i.id));
                      const showAmountError = amountTouched && !!amountIssue;
                      const amountErrorId = `desktop-income-amount-error-${i.id}`;
                      return (
                      <div key={i.id}>
                        <div className="ledger-grid-income ledger-table-row">
                          <div
                            className="ledger-table-handle print:hidden"
                            draggable={!searchTerm}
                            onDragStart={(e) => setDragPayload({ type: "income", itemId: i.id }, e)}
                            onDragEnd={clearDragState}
                          >
                            {!searchTerm && (
                              <div title={t("dragIncomeTitle")} className="h-5 w-5 rounded text-neutral-400 hover:text-neutral-700 flex items-center justify-center cursor-grab active:cursor-grabbing">
                                ⋮
                              </div>
                            )}
                          </div>

                          <input
                            className="ledger-table-control"
                            value={i.name || ""}
                            onChange={(e) => updateIncome(i.id, { name: e.target.value })}
                            placeholder={t("incomeName")}
                            onFocus={(e) => {
                              try {
                                e.target.select();
                              } catch {
                                // ignore
                              }
                            }}
                            onClick={(e) => {
                              try {
                                e.target.select();
                              } catch {
                                // ignore
                              }
                            }}
                            ref={(node) => {
                              if (!node || !lastAdded) return;
                              if (lastAdded.kind === "income" && lastAdded.id === i.id) {
                                requestAnimationFrame(() => {
                                  try {
                                    node.focus();
                                    node.select();
                                  } catch {
                                    // ignore
                                  }
                                  setTimeout(() => setLastAdded(null), 0);
                                });
                              }
                            }}
                          />

                          <div className="min-w-0">
                            <SelectAllNumberInput
                              className={`ledger-table-control ledger-table-amount ${showAmountError ? "border-red-400 ring-1 ring-red-200" : ""}`}
                              value={i.amount == null ? "0" : i.amount}
                              onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                              onBlur={() => markAmountTouched(incomeAmountTouchKey(i.id))}
                              inputMode="decimal"
                              placeholder="0"
                              title={t("amount")}
                              ariaInvalid={showAmountError}
                              ariaDescribedBy={showAmountError ? amountErrorId : undefined}
                            />
                            {showAmountError ? <div id={amountErrorId} className="mt-0.5 text-left text-[10px] font-medium leading-tight text-red-700">{amountIssueMessage(amountIssue)}</div> : null}
                          </div>

                          <IncomeCategorySelect
                            className="ledger-table-control ledger-table-status text-neutral-700"
                            value={i.category}
                            onChange={(e) => updateIncome(i.id, { category: e.target.value || undefined })}
                            t={t}
                          />

                          <select
                            className="ledger-table-control ledger-table-status text-neutral-700"
                            value={INCOME_STATUSES.includes(i.status) ? i.status : "expected"}
                            onChange={(e) => updateIncome(i.id, { status: e.target.value })}
                            title={t("incomeStatus")}
                          >
                            {INCOME_STATUSES.map((status) => (
                              <option key={status} value={status}>{t(`status_${status}`)}</option>
                            ))}
                          </select>

                          <div className="ledger-table-actions">
                            <button
                              type="button"
                              className="ledger-icon-button"
                              title={t("addIncomeToPending")}
                              onClick={() => addIncomeToPending(i)}
                            >
                              <AddPendingIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className="ledger-icon-button"
                              title={t("note")}
                              onClick={openIncomeNotePlaceholder}
                            >
                              <NoteIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className="ledger-icon-button-danger"
                              title={t("removeTitle")}
                              onClick={() => deleteIncome(i.id)}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <button className="hidden" type="button">

                            ×
                          </button>
                        </div>

                        {!searchTerm && (
                          <InsertDropZone
                            active={dropHint && dropHint.type === "incomeInsert" && dropHint.index === idx + 1}
                            onDragOver={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "income") return;
                              e.preventDefault();
                              setDropHint({ type: "incomeInsert", index: idx + 1 });
                            }}
                            onDrop={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "income") return;
                              e.preventDefault();
                              moveIncomeInsert(p.itemId, idx + 1);
                              clearDragState();
                            }}
                          />
                        )}
                      </div>
                      );
                    })}
                        </div>
                      </div>
                    </div>
                    </>
                  )}

                  {(active.incomes || []).length ? (
                    <div className="pt-3 mt-2 flex items-center justify-between px-2">
                      <div>
                        <div className="text-sm text-neutral-700">{t("totalIncome")}</div>
                        {invalidIncomeCount > 0 ? <div className="text-xs font-medium text-red-700">{invalidAmountNotice(invalidIncomeCount)}</div> : null}
                      </div>
                      <div className="ledger-table-amount font-semibold text-neutral-800">
                        <Money value={incomeTotal} currency={app.currency} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              {/* Expenses */}
              <section className="ledger-section">
                <div className="ledger-section-header flex-col sm:flex-row">
                  <h2 className="ledger-section-title">{t("expenses")}</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-2 gap-2 w-full sm:w-auto">
                    <MiniActionButton tone="primary" onClick={addExpenseGroup}>
                      {t("addSection")}
                    </MiniActionButton>
                    <TogglePill
                      on={hidePaid}
                      labelOn={t("hidePaid")}
                      labelOff={t("showPaid")}
                      title={t("togglePaidTitle")}
                      onClick={() => setHidePaid((v) => !v)}
                    />
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {!searchTerm && (
                    <InsertDropZone
                      active={dropHint && dropHint.type === "groupInsert" && dropHint.index === 0}
                      onDragOver={(e) => {
                        const p = readDragPayload(e);
                        if (!p || p.type !== "expenseGroup") return;
                        e.preventDefault();
                        setDropHint({ type: "groupInsert", index: 0 });
                      }}
                      onDrop={(e) => {
                        const p = readDragPayload(e);
                        if (!p || p.type !== "expenseGroup") return;
                        e.preventDefault();
                        moveExpenseGroupInsert(p.groupId, 0);
                        clearDragState();
                      }}
                    />
                  )}

                  {(active.expenseGroups || []).map((g, gIdx) => {
                    const allItems = g.items || [];
                    let itemsVisible = hidePaid ? allItems.filter((it) => !it.paid) : allItems;
                    
                    const matchesGroup = (g.label || "").toLowerCase().includes(searchTerm.toLowerCase());
                    
                    if (searchTerm.trim()) {
                      if (!matchesGroup) {
                        itemsVisible = itemsVisible.filter(i => 
                          (i.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
                          (i.amount || "").toString().includes(searchTerm) ||
                          (i.note || "").toLowerCase().includes(searchTerm.toLowerCase())
                        );
                      }
                    }

                    if (itemsVisible.length === 0 && !matchesGroup && searchTerm.trim()) return null;

                    const itemsCount = allItems.length;

                    return (
                      <div key={g.id}>
                        <div className="ledger-group">
                        <div className="ledger-group-header">
                          <div className="flex flex-col gap-2.5">
                            <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:justify-between">
                              <div className="flex min-w-0 flex-1 items-center gap-2">
                                <div
                                  draggable={!searchTerm}
                                  onDragStart={(e) => setDragPayload({ type: "expenseGroup", groupId: g.id }, e)}
                                  onDragEnd={clearDragState}
                                >
                                  {!searchTerm && <DragHandle title={t("dragSectionTitle")} />}
                                </div>

                                <input
                                  className="ledger-group-title h-10 rounded-xl border border-neutral-200 bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300 md:h-9"
                                  value={g.label == null ? "" : g.label}
                                  onChange={(e) => updateExpenseGroupLabel(g.id, e.target.value)}
                                  onBlur={() => normalizeExpenseGroupLabel(g.id)}
                                  placeholder={t("sectionLabel")}
                                />

                                <div className="ledger-group-meta hidden lg:flex">
                                  <span>{itemsCount} {t(itemsCount === 1 ? "entrySingular" : "entryPlural")}</span>
                                  <span><span className="ledger-group-meta-label">{t("groupPlanned")}</span><span className="ledger-group-meta-value">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span></span>
                                  <span><span className="ledger-group-meta-label">{t("groupUnpaid")}</span><span className="ledger-group-meta-unpaid">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span></span>
                                </div>
                              </div>

                              <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)} className="whitespace-nowrap px-4 text-xs md:!min-h-9 sm:text-sm" title={t("addExpense")}>
                                {t("addExpense")}
                              </SmallButton>
                            </div>

                            {/* ACTIONS TABLE (consistent sizes) */}
                            <div className="ledger-group-actions">
                              <MiniActionButton title={t("sortDueTitle")} onClick={() => sortGroupByDue(g.id)}>
                                {t("sortDue")}
                              </MiniActionButton>

                              <TogglePill
                                on={hidePaid}
                                labelOn={t("hidePaid")}
                                labelOff={t("showPaid")}
                                title={t("togglePaidTitle")}
                                onClick={() => setHidePaid((v) => !v)}
                              />

                              <MiniActionButton tone="danger" title={t("deleteSectionTitle")} onClick={() => deleteExpenseGroup(g.id)}>
                                {t("deleteSection")}
                              </MiniActionButton>
                            </div>

                            <div className="ledger-group-meta lg:hidden">
                              <span>{itemsCount} {t(itemsCount === 1 ? "entrySingular" : "entryPlural")}</span>
                              <span><span className="ledger-group-meta-label">{t("groupPlanned")}</span><span className="ledger-group-meta-value">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span></span>
                              <span><span className="ledger-group-meta-label">{t("groupUnpaid")}</span><span className="ledger-group-meta-unpaid">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span></span>
                            </div>
                          </div>
                        </div>

                          <div className="ledger-group-body">
                            {!searchTerm && (
                              <InsertDropZone
                                active={dropHint && dropHint.type === "expenseInsert" && dropHint.groupId === g.id && dropHint.index === 0}
                                onDragOver={(e) => {
                                  const p = readDragPayload(e);
                                  if (!p || p.type !== "expense") return;
                                  e.preventDefault();
                                  setDropHint({ type: "expenseInsert", groupId: g.id, index: 0 });
                                }}
                                onDrop={(e) => {
                                  const p = readDragPayload(e);
                                  if (!p || p.type !== "expense") return;
                                  e.preventDefault();
                                  moveExpenseInsert(p.fromGroupId, p.itemId, g.id, 0);
                                  clearDragState();
                                }}
                              />
                            )}

                            {itemsVisible.length === 0 ? (
                              <div className="ledger-empty-state">{t("noItemsSection")}</div>
                            ) : (
                              <>
                              <div className="mobile-entry-list">
                                {itemsVisible.map((expense) => {
                                  const mobileExpense = getMobileExpensePresentation(expense, { activeMonth: app.activeMonth, language: app.lang });
                                  const amountIssue = expenseAmountIssues.get(`${g.id}:${expense.id}`);
                                  const amountTouched = touchedAmountFields.has(expenseAmountTouchKey(g.id, expense.id));
                                  const showAmountError = amountTouched && !!amountIssue;
                                  const amountErrorId = `mobile-expense-amount-error-${expense.id}`;
                                  return (
                                    <article key={expense.id} data-expense-item={expense.id} className={`mobile-entry-card ${highlightItem === expense.id ? "ring-2 ring-[#D5FF00]" : ""}`} aria-labelledby={`mobile-expense-${expense.id}`}>
                                      <div className="flex items-start gap-3">
                                        {!searchTerm ? <div draggable onDragStart={(event) => setDragPayload({ type: "expense", fromGroupId: g.id, itemId: expense.id }, event)} onDragEnd={clearDragState} className="mobile-entry-action flex min-h-11 w-11 shrink-0 cursor-grab items-center justify-center px-0 touch-pan-y" title={t("dragExpenseTitle")} aria-label={t("dragExpenseTitle")}>⋮</div> : null}
                                        <label className="mobile-entry-heading">
                                          <span className="mobile-entry-label">{t("expenseName")}</span>
                                          <input id={`mobile-expense-${expense.id}`} className={`mobile-entry-input font-semibold ${mobileExpense.paid ? "line-through text-neutral-500" : ""}`} value={mobileExpense.name} onChange={(event) => updateExpenseItem(g.id, expense.id, { name: event.target.value })} placeholder={t("expenseName")} />
                                        </label>
                                        <div className={`mobile-entry-amount pt-5 ${mobileExpense.paid ? "line-through text-neutral-500" : ""}`}><Money value={mobileExpense.amount} currency={app.currency} invalidLabel={amountIssueMessage(amountIssue)} /></div>
                                      </div>
                                      <div className="mt-3 flex items-center justify-between gap-3">
                                        <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${mobileExpense.paid ? "border-[#D5FF00] bg-[#D5FF00]/20 text-neutral-800" : "border-neutral-300 text-neutral-700"}`}>{mobileExpense.paidLabel}</span>
                                        {mobileExpense.dueLabel ? <span className="text-sm text-neutral-700"><span className="font-medium">{t("dueLabel")}:</span> {mobileExpense.dueLabel}</span> : null}
                                      </div>
                                      <label className="mt-3 block">
                                        <span className="mobile-entry-label">{t("amount")}</span>
                                        <SelectAllNumberInput
                                          className={`mobile-entry-input text-right tabular-nums ${showAmountError ? "border-red-400 ring-1 ring-red-200" : ""}`}
                                          value={mobileExpense.amount == null ? "0" : mobileExpense.amount}
                                          onChange={(event) => updateExpenseItem(g.id, expense.id, { amount: event.target.value })}
                                          onBlur={() => markAmountTouched(expenseAmountTouchKey(g.id, expense.id))}
                                          inputMode="decimal"
                                          title={t("amount")}
                                          ariaInvalid={showAmountError}
                                          ariaDescribedBy={showAmountError ? amountErrorId : undefined}
                                        />
                                        {showAmountError ? <span id={amountErrorId} className="mt-1 block text-xs font-medium text-red-700">{amountIssueMessage(amountIssue)}</span> : null}
                                      </label>
                                      <div className="mt-3">
                                        <span className="mobile-entry-label">{t("dueDate")}</span>
                                        <DuePicker ym={app.activeMonth} value={expense.dueDay} onChange={(due) => updateExpenseItem(g.id, expense.id, { dueDay: due })} lang={app.lang} t={t} />
                                      </div>
                                      {mobileExpense.notes ? <div className="mobile-entry-notes mt-3"><span className="mobile-entry-label">{t("notes")}</span>{mobileExpense.notes}</div> : null}
                                      <div className="mobile-entry-actions print:hidden">
                                        <button type="button" className="mobile-entry-action" onClick={() => document.getElementById(`mobile-expense-${expense.id}`)?.focus()}>{t("edit")}</button>
                                        <button type="button" className="mobile-entry-action" onClick={() => updateExpenseItem(g.id, expense.id, { paid: !expense.paid })} aria-label={`${expense.paid ? t("unpaidState") : t("paidState")}: ${mobileExpense.name || t("expenseName")}`}>{expense.paid ? t("unpaidState") : t("paidState")}</button>
                                        <button type="button" className={`mobile-entry-action ${Array.isArray(expense.breakdown) && expense.breakdown.length ? "mobile-entry-action-active" : ""}`} onClick={() => toggleExpenseBreakdown(g.id, expense)} aria-expanded={expandedBreakdowns.has(breakdownKey(g.id, expense.id))}>{Array.isArray(expense.breakdown) && expense.breakdown.length ? t("breakdown") : t("addBreakdown")}</button>
                                        <button type="button" className="mobile-entry-action" onClick={() => setNoteModal({ groupId: g.id, itemId: expense.id })}>{t("notes")}</button>
                                        <button type="button" className="mobile-entry-action-danger ml-auto" onClick={() => deleteExpenseItem(g.id, expense.id)} aria-label={`${t("delete")}: ${mobileExpense.name || t("expenseName")}`}>{t("delete")}</button>
                                      </div>
                                      {expandedBreakdowns.has(breakdownKey(g.id, expense.id)) && Array.isArray(expense.breakdown) ? <ExpenseBreakdownEditor expense={expense} currency={app.currency} t={t} onChange={(breakdown) => updateExpenseBreakdown(g.id, expense.id, breakdown)} onRemove={() => removeExpenseBreakdown(g.id, expense)} /> : null}
                                    </article>
                                  );
                                })}
                              </div>
                              <div className="desktop-entry-table">
                                <div className="ledger-table">
                                  <div className="ledger-grid-expense ledger-table-heading">
                                    <div />
                                    <div className="text-center">{t("paid")}</div>
                                    <div>{t("expenseName")}</div>
                                    <div className="ledger-table-amount">{t("amount")} ({app.currency})</div>
                                    <div className="text-center">{t("dueDate")}</div>
                                    <div className="text-center">{t("breakdown")}</div>
                                    <div className="text-center">{t("actions")}</div>
                                  </div>
                                  <div>
                              {itemsVisible.map((e, idx) => {
                                const amountIssue = expenseAmountIssues.get(`${g.id}:${e.id}`);
                                const amountTouched = touchedAmountFields.has(expenseAmountTouchKey(g.id, e.id));
                                const showAmountError = amountTouched && !!amountIssue;
                                const amountErrorId = `desktop-expense-amount-error-${e.id}`;
                                return (
                                <div key={e.id} id={`item-${e.id}`} data-expense-item={e.id} className={`transition-colors duration-1000 rounded-2xl ${highlightItem === e.id ? "bg-[#D5FF00]/20" : ""}`}>
                                  <div className={`ledger-grid-expense ledger-table-row ${e.paid ? "ledger-table-row-paid" : "ledger-table-row-unpaid"}`}>
                                    <div
                                      className="ledger-table-handle print:hidden"
                                      draggable={!searchTerm}
                                      onDragStart={(ev) => setDragPayload({ type: "expense", fromGroupId: g.id, itemId: e.id }, ev)}
                                      onDragEnd={clearDragState}
                                    >
                                      {!searchTerm && (
                                        <div title={t("dragExpenseTitle")} className="h-5 w-5 rounded text-neutral-400 hover:text-neutral-700 flex items-center justify-center cursor-grab active:cursor-grabbing">
                                          ⋮
                                        </div>
                                      )}
                                    </div>

                                    <div className="flex justify-center">
                                      <PaidCheck checked={!!e.paid} label={e.paid ? t("paidState") : t("unpaidState")} onChange={(v) => updateExpenseItem(g.id, e.id, { paid: !!v })} />
                                    </div>

                                    <input
                                      className={`ledger-table-control ${
                                        e.paid ? "line-through text-neutral-600 decoration-[#D5FF00] decoration-2" : "text-neutral-800"
                                      }`}
                                      value={e.name || ""}
                                      onChange={(ev) => updateExpenseItem(g.id, e.id, { name: ev.target.value })}
                                      placeholder={t("expenseName")}
                                      onFocus={(ev) => {
                                        try {
                                          ev.target.select();
                                        } catch {
                                          // ignore
                                        }
                                      }}
                                      onClick={(ev) => {
                                        try {
                                          ev.target.select();
                                        } catch {
                                          // ignore
                                        }
                                      }}
                                      ref={(node) => {
                                        if (!node || !lastAdded) return;
                                        if (lastAdded.kind === "expense" && lastAdded.groupId === g.id && lastAdded.id === e.id) {
                                          requestAnimationFrame(() => {
                                            try {
                                              node.focus();
                                              node.select();
                                            } catch {
                                              // ignore
                                            }
                                            setTimeout(() => setLastAdded(null), 0);
                                          });
                                        }
                                      }}
                                    />

                                    <div className="min-w-0">
                                      <SelectAllNumberInput
                                        className={`ledger-table-control ledger-table-amount ${
                                          e.paid ? "line-through text-neutral-600 decoration-[#D5FF00] decoration-2" : "text-neutral-800"
                                        } ${showAmountError ? "border-red-400 ring-1 ring-red-200" : ""}`}
                                        value={e.amount == null ? "0" : e.amount}
                                        onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                        onBlur={() => markAmountTouched(expenseAmountTouchKey(g.id, e.id))}
                                        inputMode="decimal"
                                        placeholder="0"
                                        title={t("amount")}
                                        ariaInvalid={showAmountError}
                                        ariaDescribedBy={showAmountError ? amountErrorId : undefined}
                                      />
                                      {showAmountError ? <div id={amountErrorId} className="mt-0.5 text-left text-[10px] font-medium leading-tight text-red-700">{amountIssueMessage(amountIssue)}</div> : null}
                                    </div>

                                    <div className="ledger-table-due">
                                      <DuePicker
                                        ym={app.activeMonth}
                                        value={e.dueDay}
                                        onChange={(due) => updateExpenseItem(g.id, e.id, { dueDay: due })}
                                        lang={app.lang}
                                        t={t}
                                        compact
                                      />
                                    </div>

                                    <div className="flex min-w-0 justify-center">
                                      <button
                                        type="button"
                                        className={`ledger-breakdown-button ${Array.isArray(e.breakdown) && e.breakdown.length ? "ledger-breakdown-button-active" : ""}`}
                                        title={Array.isArray(e.breakdown) && e.breakdown.length ? t("breakdown") : t("addBreakdown")}
                                        aria-label={Array.isArray(e.breakdown) && e.breakdown.length ? t("breakdown") : t("addBreakdown")}
                                        aria-expanded={expandedBreakdowns.has(breakdownKey(g.id, e.id))}
                                        onClick={() => toggleExpenseBreakdown(g.id, e)}
                                      >
                                        <span aria-hidden="true" className="ledger-breakdown-mark"><span /><span /><span /></span>
                                        <span>{Array.isArray(e.breakdown) && e.breakdown.length ? t("breakdown") : t("addBreakdown")}</span>
                                      </button>
                                    </div>

                                    <div className="ledger-table-actions">
                                      <button
                                        type="button"
                                        className={`ledger-icon-button ${e.paid ? "" : "text-neutral-300 cursor-default hover:bg-transparent hover:text-neutral-300"}`}
                                        title={e.paid ? t("includeExpenseInBalance") : t("alreadyInBalance")}
                                        disabled={!e.paid}
                                        onClick={() => updateExpenseItem(g.id, e.id, { paid: false })}
                                      >
                                        <AddPendingIcon className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        className={`ledger-icon-button ${e.note ? "text-neutral-900 bg-[#D5FF00]/40" : ""}`}
                                        title={t("note")}
                                        onClick={() => setNoteModal({ groupId: g.id, itemId: e.id })}
                                      >
                                        <NoteIcon className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        className="ledger-icon-button-danger"
                                        title={t("removeTitle")}
                                        onClick={() => deleteExpenseItem(g.id, e.id)}
                                      >
                                        <TrashIcon className="h-3.5 w-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        className="hidden"
                                        title={t("removeTitle")}
                                        onClick={() => deleteExpenseItem(g.id, e.id)}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </div>

                                  {expandedBreakdowns.has(breakdownKey(g.id, e.id)) && Array.isArray(e.breakdown) ? <ExpenseBreakdownEditor expense={e} currency={app.currency} t={t} onChange={(breakdown) => updateExpenseBreakdown(g.id, e.id, breakdown)} onRemove={() => removeExpenseBreakdown(g.id, e)} /> : null}

                                  {!searchTerm && (
                                    <InsertDropZone
                                      active={dropHint && dropHint.type === "expenseInsert" && dropHint.groupId === g.id && dropHint.index === idx + 1}
                                      onDragOver={(ev) => {
                                        const p = readDragPayload(ev);
                                        if (!p || p.type !== "expense") return;
                                        ev.preventDefault();
                                        setDropHint({ type: "expenseInsert", groupId: g.id, index: idx + 1 });
                                      }}
                                      onDrop={(ev) => {
                                        const p = readDragPayload(ev);
                                        if (!p || p.type !== "expense") return;
                                        ev.preventDefault();
                                        moveExpenseInsert(p.fromGroupId, p.itemId, g.id, idx + 1);
                                        clearDragState();
                                      }}
                                    />
                                  )}
                                </div>
                                );
                              })}
                                  </div>
                                </div>
                              </div>
                              </>
                            )}
                          </div>
                        </div>
                        {!searchTerm && (
                          <InsertDropZone
                            active={dropHint && dropHint.type === "groupInsert" && dropHint.index === gIdx + 1}
                            onDragOver={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "expenseGroup") return;
                              e.preventDefault();
                              setDropHint({ type: "groupInsert", index: gIdx + 1 });
                            }}
                            onDrop={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "expenseGroup") return;
                              e.preventDefault();
                              moveExpenseGroupInsert(p.groupId, gIdx + 1);
                              clearDragState();
                            }}
                          />
                        )}
                      </div>
                    );
                  })}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="ledger-empty-state">{t("noExpenses")}</div>
                  ) : (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-neutral-700">{t("remainingExpenses")}</div>
                        <div className="text-xs text-neutral-600">{t("plannedExpenses")}: {currencySymbol}{expensePlannedTotal.toFixed(2)}</div>
                        {invalidExpenseCount > 0 ? <div className="text-xs font-medium text-red-700">{invalidAmountNotice(invalidExpenseCount)}</div> : null}
                      </div>
                      <div className="ledger-table-amount font-semibold text-neutral-800">
                        <Money value={expenseRemainingTotal} currency={app.currency} />
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <NotesPanel active={active} onJump={handleJumpTo} t={t} />
            </div>
          </div>

          {/* Summary */}
          <div className="order-1 flex flex-col gap-3 md:order-2">
            <div className="summary-panel print:shadow-none">
              <div className="summary-heading">{t("budgetSummary")}</div>
              <div className="p-4 space-y-4">
              {invalidIncomeCount > 0 || invalidExpenseCount > 0 ? (
                <div role="status" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <div className="font-semibold">{t("totalsIncomplete")}</div>
                  {invalidIncomeCount > 0 ? <div>{t("income")}: {invalidAmountNotice(invalidIncomeCount)}</div> : null}
                  {invalidExpenseCount > 0 ? <div>{t("expenses")}: {invalidAmountNotice(invalidExpenseCount)}</div> : null}
                </div>
              ) : null}
              {!historicalIncomeStatus.historicalIncomeOutcomeComplete ? (
                <div role="status" className="historical-income-warning">
                  <strong>{t("incomeStatusIncomplete")}</strong>
                  <span>
                    {historicalIncomeStatus.unresolvedExpectedCount} {t(historicalIncomeStatus.unresolvedExpectedCount === 1 ? "expectedEntrySingular" : "expectedEntryPlural")}
                    {historicalIncomeStatus.invalidUnresolvedAmountCount === 0 ? <> · <Money value={historicalIncomeStatus.unresolvedExpectedAmount} currency={app.currency} /> {t("unresolvedAmount")}</> : null}
                  </span>
                  {historicalIncomeStatus.invalidUnresolvedAmountCount > 0 ? <span>{t(historicalIncomeStatus.invalidUnresolvedAmountCount === 1 ? "unresolvedSubtotalIncompleteSingular" : "unresolvedSubtotalIncompletePlural", { count: historicalIncomeStatus.invalidUnresolvedAmountCount })}</span> : null}
                </div>
              ) : null}
              <div className="grid grid-cols-1 border-y border-neutral-200 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                {[["expectedIncome", incomeTotal, false], ["plannedExpenses", expensePlannedTotal, false], ["leftAfterPlannedExpenses", netRemaining, netRemaining < 0], ["unpaidExpenses", expenseRemainingTotal, false]].map(([label, value, negative]) => (
                  <div key={label} className={`summary-stat ${label === "leftAfterPlannedExpenses" ? "summary-stat-primary" : ""}`}>
                    <div className="summary-label break-words">{t(label)}</div>
                    <div className={`summary-value ${negative ? "text-red-700" : ""}`}>
                      {negative ? <span className="sr-only">{t("negativeValue")}: </span> : null}
                      <Money value={value} currency={app.currency} />
                    </div>
                    {label === "leftAfterPlannedExpenses" ? <div className="summary-context"><strong>{t("budgetPlan")}</strong><span>{t("projectedRemainderFormula")}</span></div> : null}
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-neutral-50 px-3 py-2 text-sm text-neutral-700" aria-label={t("expenseAttention")}>
                {expenseAttention.unpaidCount === 0 ? t("noUnpaidExpenses") : <>
                  <span>{expenseAttention.unpaidCount} {t(expenseAttention.unpaidCount === 1 ? "unpaidExpenseSingular" : "unpaidExpensePlural")}</span>
                  {expenseAttention.overdueCount > 0 ? <span> · {expenseAttention.overdueCount} {t("overdue")}</span> : null}
                  {expenseAttention.nextDue ? <span> · {t("nextDue")}: {expenseAttention.nextDue.name || t("unnamed")} — {new Date(`${expenseAttention.nextDue.dueDateISO}T12:00:00`).toLocaleDateString(app.lang === "de" ? "de-DE" : "en-US", { day: "numeric", month: "long" })}</span> : null}
                </>}
              </div>

              <div className="border-t border-neutral-100 pt-3">
                <button type="button" aria-expanded={financialDetailsOpen} aria-controls="financial-details-panel" onClick={() => setFinancialDetailsOpen((open) => !open)} className="w-full flex items-center justify-between gap-3 rounded-xl px-2 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50">
                  <span>{t("financialDetails")}</span>
                  <ChevronDownIcon className={`h-5 w-5 text-neutral-400 transition-transform ${financialDetailsOpen ? "rotate-180" : ""}`} />
                </button>
                {financialDetailsOpen ? <dl id="financial-details-panel" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 px-2 text-sm">
                  {[["receivedIncome", monthTotals.receivedIncome], ["delayedIncome", monthTotals.delayedIncome], ["cancelledIncome", monthTotals.cancelledIncome], ["paidExpenses", expensePaidTotal]].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-neutral-100 py-1.5"><dt className="text-neutral-600">{t(label)}</dt><dd className="font-medium text-neutral-800"><Money value={value} currency={app.currency} /></dd></div>)}
                  <div className="flex items-center justify-between gap-3 border-b border-neutral-100 py-1.5"><dt className="text-neutral-600">{t("savingsRate")}</dt><dd className="font-medium text-neutral-800">{formatSavingsRate(savingsRate)}</dd></div>
                </dl> : null}
              </div>

            </div>
            </div>
            <BalanceCheck
              balance={active.bankBalance}
              pendingIncomeEntries={active.pendingIncomeEntries}
              overdraftLimit={active.overdraftLimit}
              onBalanceUpdate={(e) => updateMonth(cur => ({ ...cur, bankBalance: e.target.value }))}
              onAddPendingIncome={(entry) => updateMonth(cur => ({ ...cur, pendingIncomeEntries: [...(cur.pendingIncomeEntries || []), entry] }))}
              onDeletePendingIncome={(id) => updateMonth(cur => ({ ...cur, pendingIncomeEntries: (cur.pendingIncomeEntries || []).filter((entry) => entry.id !== id) }))}
              onOverdraftLimitUpdate={(e) => updateMonth(cur => ({ ...cur, overdraftLimit: e.target.value }))}
              remainingExpenses={expenseRemainingTotal}
              currency={app.currency}
              currencySymbol={currencySymbol}
              t={t}
            />
          </div>
        </div>

        {toast ? (
          <div className="fixed bottom-6 right-6 rounded-2xl bg-neutral-800 text-white px-4 py-3 shadow-xl print:hidden">
            <div className="text-sm">{toast}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
