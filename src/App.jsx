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
import budgitSub from "./assets/budgit-sub.png";
import {
  INCOME_STATUSES,
  balanceAfterExpectedIncomingMoney,
  balanceAfterUnpaidExpenses,
  calculateExpenseGroupTotals,
  calculateMoneyListTotal,
  calculateMonthTotals,
  parseMoney,
} from "./domain/calculations.js";
import { createExpenseAttentionSummary, formatSavingsRate } from "./domain/dashboardSummary.js";
import { getMobileExpensePresentation, getMobileIncomePresentation } from "./domain/mobilePresentation.js";
import { calculateYearOverview } from "./domain/yearOverview.js";
import {
  BACKUP_LIMITS,
  createBackupEnvelope,
  parseAndValidateBackup,
  prepareRestoredApp,
  validateApplicationState,
} from "./domain/backupSchema.js";
import { getBrowserStorage, readStorageValue, writeStorageValue } from "./domain/storage.js";
import {
  DEFAULT_MONTH_COPY_OPTIONS,
  applyMonthCopyToApp,
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
  const y = dd.getFullYear();
  const m = pad2(dd.getMonth() + 1);
  return `${y}-${m}`; // YYYY-MM
};

const parseYM = (ym) => {
  const parts = String(ym || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return { y, m };
};

const addMonths = (ym, delta) => {
  const p = parseYM(ym);
  if (!p.y || !p.m) return monthKey();
  const d = new Date(p.y, p.m - 1, 1);
  d.setMonth(d.getMonth() + delta);
  return monthKey(d);
};

const monthLabel = (ym, lang = "en") => {
  const parts = String(ym || "").split("-");
  const y = parts[0];
  const m = parts[1];
  if (!y || !m) return String(ym || "");
  const d = new Date(Number(y), Number(m) - 1, 1);
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
        : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200 shadow-sm";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden min-h-11 sm:min-h-10 px-3 py-2 rounded-xl text-sm font-medium border transition active:translate-y-[1px] ${BUTTON_FOCUS} ${BUTTON_DISABLED} ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

/** Normalized Top Actions (mobile-aligned “table/grid”) */
const ACTION_BASE =
  `print:hidden min-h-11 sm:min-h-9 px-4 sm:px-6 rounded-xl text-xs font-medium border transition shadow-sm active:translate-y-[1px] focus-within:outline-none focus-within:ring-2 focus-within:ring-[#D5FF00] focus-within:ring-offset-2 ${BUTTON_FOCUS} ${BUTTON_DISABLED} flex items-center justify-center`;

function ActionButton({ children, onClick, tone = "default", disabled, title }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900 hover:bg-[#c7f000] hover:border-[#c7f000]"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
        : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200";

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
      : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200";

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
        : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden min-h-11 sm:min-h-10 w-full rounded-xl text-sm font-medium border transition shadow-sm active:translate-y-[1px] ${BUTTON_FOCUS} ${BUTTON_DISABLED} ${cls} ${className}`}
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

function Money({ value, currency = "EUR" }) {
  const v = Number(value) || 0;
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

function SelectAllNumberInput({ className = "", value, onChange, onKeyDown, placeholder, inputMode = "decimal", title }) {
  // Click/focus selects all so you can type immediately over defaults.
  return (
    <input
      className={className}
      value={value == null ? "0" : value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      inputMode={inputMode}
      title={title}
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
      <div role="dialog" aria-modal="true" aria-labelledby="note-editor-title" className="relative w-full max-w-lg bg-white rounded-[28px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col">
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
  useEffect(() => lsSet("budgit_notes_open", isOpen), [isOpen]);
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

  const btnLabel = info ? info.display : t("due");
  const btnTitle = info ? info.title : t("selectDueDate");

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        title={btnTitle}
        onClick={() => setOpen((v) => !v)}
        className={`w-full ${compact ? "h-8 rounded-md px-2 shadow-none" : "h-10 rounded-xl px-3 shadow-sm"} border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-neutral-300 hover:text-neutral-800 text-neutral-800 text-sm flex items-center justify-between gap-1 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300 ${
          info ? "font-medium" : "text-neutral-500"
        }`}
      >
        <span className="tabular-nums truncate">{btnLabel}</span>
        <span className="flex items-center gap-2">
          {info ? (
            <span
              className="h-6 w-6 rounded-lg border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-600 flex items-center justify-center"
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
          <CalendarIcon className="h-5 w-5 text-neutral-600" />
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
      <div role="dialog" aria-modal="true" aria-labelledby="help-modal-title" className="relative w-full max-w-2xl bg-white rounded-[28px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col max-h-[90vh]">
        
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

function ExportModal({ open, onClose, onPrint, onBackup, onImport, t }) {
  useModalEscape(open, onClose);
  if (!open) return null;

  const handleEmail = () => {
    const today = new Date().toISOString().split('T')[0];
    const subject = encodeURIComponent(t("email_subject", { today }));
    const body = encodeURIComponent(t("email_body"));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden"> 
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="export-modal-title" className="relative w-full max-w-sm bg-white rounded-[28px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all">
        <div className="px-6 pt-6 pb-4 flex items-center justify-between">
          <div>
            <h2 id="export-modal-title" className="font-bold text-2xl text-neutral-900 tracking-tight">{t("export_title")}</h2>
            <div className="text-sm text-neutral-500 font-medium mt-1">{t("export_subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className={`h-11 w-11 rounded-xl bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition ${BUTTON_FOCUS}`}
          >
            <ExportIcons.Close />
          </button>
        </div>
        
        <div className="px-4 pb-6 flex flex-col gap-2">
          <ExportActionRow
            icon={<ExportIcons.Print />}
            label={t("export_print_pdf_label")}
            sub={t("export_print_pdf_sub")}
            onClick={() => { onClose(); onPrint(); }}
          />
          <ExportActionRow
            icon={<ExportIcons.Mail />}
            label={t("export_email_label")}
            sub={t("export_email_sub")}
            onClick={handleEmail}
          />
          <div className="h-px bg-neutral-100 my-2 mx-4" />
          <ExportActionRow
            icon={<ExportIcons.Download />}
            label={t("export_download_json_label")}
            sub={t("export_download_json_sub")}
            onClick={() => { onClose(); onBackup(); }}
          />
          <ExportActionRow
            icon={<ExportIcons.Upload />}
            label={t("export_import_json_label")}
            sub={t("export_import_json_sub")}
            file
            onClose={onClose}
            onImport={onImport}
          />
        </div>
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
        className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-[28px] bg-white shadow-2xl ring-1 ring-black/5"
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
            <span className="text-sm font-semibold text-neutral-800">{t("copyTo")}</span>
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
  const currentBalance = toNumber(balance);
  const pendingEntries = Array.isArray(pendingIncomeEntries) ? pendingIncomeEntries : [];
  const totalPendingMoneyIn = calculateMoneyListTotal(pendingEntries, "expectedIncomingMoney").total;
  const projectedAfterMoneyIn = currentBalance + totalPendingMoneyIn;
  const balanceAfterUnpaid = balanceAfterUnpaidExpenses(currentBalance, remainingExpenses);
  const balanceAfterIncomingMoney = balanceAfterExpectedIncomingMoney(currentBalance, totalPendingMoneyIn, remainingExpenses);
  const overdraftAmount = toNumber(overdraftLimit);
  const availableWithOverdraft = balanceAfterIncomingMoney + overdraftAmount;
  const isShort = availableWithOverdraft < 0;
  const canAddPending = !!String(draftLabel || "").trim() || toNumber(draftAmount) !== 0;

  const addPendingEntry = () => {
    if (!canAddPending) return;
    onAddPendingIncome({
      id: uid(),
      label: String(draftLabel || "").trim() || t("pendingIncomeFallback"),
      amount: draftAmount,
    });
    setDraftLabel("");
    setDraftAmount("");
  };

  return (
    <div className={`rounded-2xl bg-white shadow-sm border p-4 print:hidden ${isShort ? "border-red-200" : "border-neutral-200"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-neutral-900">{t("balanceCheck")}</div>
          <div className="text-xs text-neutral-500 mt-1">{t("balanceCheckDesc")}</div>
        </div>
        <div className={`text-xs font-bold px-2 py-1 rounded-lg ${isShort ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"}`}>
          {currency}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <label htmlFor="bank-balance-input" className="block">
          <span className="text-xs text-neutral-600 font-medium">{t("currentBalance")}</span>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 font-semibold">{currencySymbol}</span>
            <SelectAllNumberInput
              id="bank-balance-input"
              className="w-full rounded-xl border border-neutral-200 pl-8 pr-3 py-2 bg-white text-right text-neutral-800 font-semibold text-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300"
              value={balance}
              onChange={onBalanceUpdate}
              placeholder="0.00"
              title={t("currentBalance")}
              inputMode="decimal"
            />
          </div>
        </label>

        <div>
          <div className="text-xs text-neutral-600 font-medium">{t("pendingMoneyIn")}</div>
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
              className="min-w-0 rounded-lg border border-neutral-200 px-2 py-1.5 bg-white text-right text-neutral-800 text-xs tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300"
              value={draftAmount}
              onChange={(e) => setDraftAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPendingEntry();
              }}
              placeholder="0"
              title={t("amount")}
              inputMode="decimal"
            />
            <button
              type="button"
              onClick={addPendingEntry}
              disabled={!canAddPending}
              className={`h-11 rounded-lg border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 text-neutral-700 text-sm font-bold ${BUTTON_FOCUS} ${BUTTON_DISABLED}`}
              title={t("addPendingIncome")}
            >
              +
            </button>
          </div>

          {pendingEntries.length ? (
            <div className="mt-2 max-h-56 overflow-y-auto pr-1 space-y-1">
              {pendingEntries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 text-xs leading-5">
                  <span className="min-w-0 flex-1 truncate text-neutral-700">{entry.label || t("pendingIncomeFallback")}</span>
                  <span className="w-16 text-right tabular-nums font-medium text-neutral-800">{currencySymbol}{toNumber(entry.amount).toFixed(2)}</span>
                  <button
                    type="button"
                    onClick={() => onDeletePendingIncome(entry.id)}
                    className={`h-11 w-11 shrink-0 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 ${BUTTON_FOCUS}`}
                    title={t("removeTitle")}
                    aria-label={`${t("delete")}: ${entry.label || t("pendingIncomeFallback")}`}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : <div className="mt-2 text-xs text-neutral-500">{t("noPendingIncome")}</div>}

          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-neutral-600">{t("pendingMoneyTotal")}</span>
            <span className="font-semibold text-neutral-900"><Money value={totalPendingMoneyIn} currency={currency} /></span>
          </div>
        </div>

        <label htmlFor="overdraft-limit-input" className="block">
          <span className="text-xs text-neutral-600 font-medium">{t("overdraftLimit")}</span>
          <div className="relative mt-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 font-semibold">{currencySymbol}</span>
            <SelectAllNumberInput
              id="overdraft-limit-input"
              className="w-full rounded-xl border border-neutral-200 pl-8 pr-3 py-2 bg-white text-right text-neutral-800 font-semibold text-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 focus:border-neutral-300"
              value={overdraftLimit}
              onChange={onOverdraftLimitUpdate}
              placeholder="0.00"
              title={t("overdraftLimit")}
              inputMode="decimal"
            />
          </div>
        </label>
      </div>

      <div className="mt-4 pt-3 border-t border-neutral-100 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-600">{t("currentBalanceShort")}</span>
          <span className="font-semibold text-neutral-800"><Money value={currentBalance} currency={currency} /></span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-600">{t("projectedAfterMoneyIn")}</span>
          <span className="font-semibold text-neutral-800"><Money value={projectedAfterMoneyIn} currency={currency} /></span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-600">{t("remainingExpenses")}</span>
          <span className="font-semibold text-neutral-800"><Money value={remainingExpenses} currency={currency} /></span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-600">{t("balanceAfterUnpaidExpenses")}</span>
          <span className={`font-semibold ${balanceAfterUnpaid < 0 ? "text-red-700" : "text-neutral-800"}`}><Money value={balanceAfterUnpaid} currency={currency} /></span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-600">{t("balanceAfterExpectedIncomingMoney")}</span>
          <span className={`font-semibold ${balanceAfterIncomingMoney < 0 ? "text-red-700" : "text-neutral-800"}`}><Money value={balanceAfterIncomingMoney} currency={currency} /></span>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-neutral-500">{t("availableWithOverdraft")}</span>
          <span className={`font-medium ${isShort ? "text-red-700" : "text-neutral-600"}`}><Money value={availableWithOverdraft} currency={currency} /></span>
        </div>
      </div>
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
  dueDay: x && x.dueDay != null ? Number(x.dueDay) : null,
  paid: !!(x && x.paid),
  note: x && typeof x.note === "string" ? x.note : "",
  notePinned: !!(x && x.notePinned),
  noteUpdatedAt: x && x.noteUpdatedAt ? x.noteUpdatedAt : null,
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
  const data = { ...source, months: { ...(source.months || {}) } };
  const activeMonth = data.activeMonth || monthKey();
  data.activeMonth = activeMonth;
  Object.keys(data.months).forEach((key) => {
    data.months[key] = normalizeMonthData(data.months[key]);
  });
  if (!data.months[activeMonth]) data.months[activeMonth] = normalizeMonthData(null);
  if (!data.lang) data.lang = "en";
  if (!data.currency) data.currency = "EUR";
  return data;
}

const TRANSLATIONS = {
  en: {
    subtitle: "Monthly personal budgeting tool",
    yearOverview: "Year Overview",
    backToMonth: "Back to Month",
    previousYear: "Previous year",
    nextYear: "Next year",
    planningDetails: "Planning Details",
    yearInsights: "Year Insights",
    strongestMonth: "Strongest month",
    weakestMonth: "Weakest month",
    averageMonthlyActualNet: "Average monthly actual net",
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
    preview: "Preview",
    data: "Export",
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
    monthCopied: "Month copied successfully",
    monthCopyNotSaved: "The month was copied in this open page, but it could not be saved. Download a backup now.",
    monthCopyInvalid: "The copied month could not be validated. No data was changed.",
    copyAll: "Copy ALL",
    copyUnpaid: "Copy UNPAID only",
    cancel: "Cancel",
    clear: "Clear",
    startAgain: "Start Again",
    income: "Income",
    addIncome: "Add income",
    totalIncome: "Expected Income",
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
    leftAfterPlannedExpenses: "Left After Planned Expenses",
    financialDetails: "Financial details",
    receivedIncome: "Received income",
    delayedIncome: "Delayed income",
    cancelledIncome: "Cancelled income",
    expenseAttention: "Expense attention summary",
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
    autosaveDesc: "Budgit saves automatically in your browser (localStorage) under:",
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
    sectionsHelp: "Sections",
    sectionsHelpDesc: "Group expenses by category. Click the section name to rename it. Use “Add section” to create new ones.",
    dueDatesHelp: "Due Dates",
    dueDatesHelpDesc: "Set due dates to track when bills are due. Use “Sort due” to organize items by date.",
    copyingHelp: "Rolling Over",
    copyingHelpDesc: "Use “Copy month” to review what will carry forward. Paid and income statuses, dates, balances, pending money, and transaction remnants are reset.",
    printing: "Printing / PDF",
    printingDesc: "Use",
    printingDesc2: "to check the layout, then",
    printingDesc3: "and choose “Save as PDF”.",
    privacy: "Privacy",
    privacyDesc: "Budgit runs in your browser. There’s no account system here yet, and nothing is uploaded unless you choose to share your exported file.",
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
    saveFailureAdvice: "Download a backup now. Your latest changes are only in this open page.",
    loadFailureAdvice: "Existing browser data was left unchanged. Restore a known backup to continue safely.",
    balanceCheck: "Balance Check",
    balanceCheckDesc: "Bank balance plus pending money, minus remaining expenses.",
    pendingMoneyIn: "Pending money in",
    pendingIncomeLabel: "Pending money description",
    pendingIncomeLabelPlaceholder: "Overtime, eBay, refund",
    pendingIncomeFallback: "Pending",
    addPendingIncome: "Add pending money",
    pendingMoneyTotal: "Pending money in total",
    pendingMoneyLabel: "Pending label / notes",
    pendingMoneyPlaceholder: "Salary, refund, transfer expected",
    overdraftLimit: "Overdraft limit",
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
    currentBalance: "Current Bank Balance",
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
  },
  de: {
    subtitle: "Monatliches persönliches Budgetierungstool",
    yearOverview: "Jahresübersicht",
    backToMonth: "Zurück zum Monat",
    previousYear: "Vorheriges Jahr",
    nextYear: "Nächstes Jahr",
    planningDetails: "Planungsdetails",
    yearInsights: "Jahresanalyse",
    strongestMonth: "Stärkster Monat",
    weakestMonth: "Schwächster Monat",
    averageMonthlyActualNet: "Durchschnittlicher monatlicher Saldo",
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
    preview: "Vorschau",
    data: "Export",
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
    monthCopied: "Monat erfolgreich kopiert",
    monthCopyNotSaved: "Der Monat wurde auf dieser geöffneten Seite kopiert, konnte aber nicht gespeichert werden. Laden Sie jetzt eine Sicherung herunter.",
    monthCopyInvalid: "Der kopierte Monat konnte nicht validiert werden. Es wurden keine Daten geändert.",
    copyAll: "ALLES kopieren",
    copyUnpaid: "Nur UNBEZAHLTE kopieren",
    cancel: "Abbrechen",
    clear: "Leeren",
    startAgain: "Neu starten",
    income: "Einkommen",
    addIncome: "Einnahme hinzufügen",
    totalIncome: "Erwartete Einnahmen",
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
    leftAfterPlannedExpenses: "Verfügbar nach geplanten Ausgaben",
    financialDetails: "Finanzdetails",
    receivedIncome: "Erhaltene Einnahmen",
    delayedIncome: "Verspätete Einnahmen",
    cancelledIncome: "Stornierte Einnahmen",
    expenseAttention: "Übersicht offener Ausgaben",
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
    autosaveDesc: "Budgit speichert automatisch in Ihrem Browser (localStorage) unter:",
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
    sectionsHelp: "Abschnitte",
    sectionsHelpDesc: "Gruppieren Sie Ausgaben nach Kategorie. Klicken Sie auf den Abschnittsnamen, um ihn umzubenennen. Verwenden Sie „+ Abschnitt“, um neue zu erstellen.",
    dueDatesHelp: "Fälligkeitsdaten",
    dueDatesHelpDesc: "Legen Sie Fälligkeitsdaten fest, um Rechnungen zu verfolgen. Verwenden Sie „Fälligkeit sort.“, um Elemente nach Datum zu ordnen.",
    copyingHelp: "Übertrag",
    copyingHelpDesc: "Mit „Monat kopieren“ prüfen Sie vorab, was übernommen wird. Bezahl- und Einnahmestatus, Daten, Kontostände, erwartete Geldeingänge und Transaktionsreste werden zurückgesetzt.",
    printing: "Drucken / PDF",
    printingDesc: "Verwenden Sie",
    printingDesc2: "um das Layout zu überprüfen, dann",
    printingDesc3: "und wählen Sie „Als PDF speichern“.",
    privacy: "Datenschutz",
    privacyDesc: "Budgit läuft in Ihrem Browser. Es gibt hier noch kein Kontosystem, und nichts wird hochgeladen, es sei denn, Sie entscheiden sich, Ihre exportierte Datei zu teilen.",
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
    saveFailureAdvice: "Laden Sie jetzt eine Sicherung herunter. Ihre neuesten Änderungen sind nur auf dieser geöffneten Seite vorhanden.",
    loadFailureAdvice: "Vorhandene Browserdaten wurden nicht verändert. Stellen Sie eine bekannte Sicherung wieder her, um sicher fortzufahren.",
    balanceCheck: "Kontostand-Check",
    balanceCheckDesc: "Kontostand plus erwartetes Geld, minus verbleibende Ausgaben.",
    pendingMoneyIn: "Erwartetes Geld",
    pendingIncomeLabel: "Beschreibung für erwartetes Geld",
    pendingIncomeLabelPlaceholder: "Überstunden, eBay, Erstattung",
    pendingIncomeFallback: "Erwartet",
    addPendingIncome: "Erwartetes Geld hinzufügen",
    pendingMoneyTotal: "Erwartetes Geld gesamt",
    pendingMoneyLabel: "Label / Notizen",
    pendingMoneyPlaceholder: "Gehalt, Erstattung, erwartete Überweisung",
    overdraftLimit: "Dispolimit",
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
    currentBalance: "Aktueller Kontostand",
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
  }
};

// ---------------------------
// App
// ---------------------------

function YearValue({ value, hasData, currency }) {
  return hasData ? <Money value={value} currency={currency} /> : <span>—</span>;
}

function YearOverviewView({ app, year, onYearChange, onBack, onOpenMonth, onPrint, t }) {
  const overview = useMemo(() => calculateYearOverview(app, year), [app, year]);
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

      <section aria-label={t("yearOverview")} className="year-summary-grid">
        {primaryMetrics.map(([label, value]) => (
          <article key={label} className={`year-summary-card ${label === "actualNet" && value < 0 ? "year-summary-card-negative" : ""}`}>
            <h2>{t(label)}</h2>
            <div className="year-summary-value"><YearValue value={value} hasData={hasYearData} currency={app.currency} /></div>
            {label === "actualNet" && value < 0 ? <span className="year-negative-label">{t("negativeValue")}</span> : null}
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
                {["tableMonth", "tableExpected", "tableReceived", "tablePlanned", "tablePaid", "tableUnpaid", "tableActualNet"].map((label) => (
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
                    </td>
                  ))}
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
                {!month.hasData ? <span>{t("noData")}</span> : null}
              </div>
              {month.hasData ? (
                <>
                  <dl className="year-month-card-grid">
                    {["receivedIncome", "paidExpenses", "actualNet", "unpaidExpenses", "expectedIncome", "plannedExpenses"].map((field) => (
                      <div key={field}>
                        <dt>{t(field)}</dt>
                        <dd className={field === "actualNet" && month.actualNet < 0 ? "year-negative-value" : ""}><Money value={month[field]} currency={app.currency} /></dd>
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
            <div><dt>{t("strongestMonth")}</dt><dd>{monthName(overview.strongestMonth.monthKey, app.lang)} <Money value={overview.strongestMonth.actualNet} currency={app.currency} /></dd></div>
            <div><dt>{t("weakestMonth")}</dt><dd>{monthName(overview.weakestMonth.monthKey, app.lang)} <Money value={overview.weakestMonth.actualNet} currency={app.currency} /></dd></div>
            <div><dt>{t("averageMonthlyActualNet")}</dt><dd><Money value={overview.averages.actualNet} currency={app.currency} /></dd></div>
          </dl>
        )}
      </section>
    </main>
  );
}

export default function BudgitApp() {
  const [initialLoad] = useState(loadInitialAppState);
  const [app, setApp] = useState(initialLoad.app);
  const [currentView, setCurrentView] = useState("month");
  const [overviewYear, setOverviewYear] = useState(() => parseYM(initialLoad.app.activeMonth).y || new Date().getFullYear());
  const [saveStatus, setSaveStatus] = useState(initialLoad.loadFailure ? "load_error" : "saved");
  const [saveErrorCode, setSaveErrorCode] = useState(initialLoad.loadFailure);
  const persistenceLocked = useRef(!!initialLoad.loadFailure);
  const skipNextSave = useRef(false);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  useModalEscape(previewOpen, () => setPreviewOpen(false));
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

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

  const notify = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    if (persistenceLocked.current) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }

    const statusTimer = setTimeout(() => setSaveStatus("saving"), 0);
    const saveTimer = setTimeout(() => {
      const result = writeStorageValue(getBrowserStorage(), LS_KEY, JSON.stringify(app));
      if (result.ok) {
        setSaveErrorCode(null);
        setSaveStatus("saved");
      } else {
        setSaveErrorCode(result.code);
        setSaveStatus("error");
      }
    }, 200);
    return () => {
      clearTimeout(statusTimer);
      clearTimeout(saveTimer);
    };
  }, [app]);

  const active = useMemo(() => {
    const m = app.activeMonth;
    return normalizeMonthData(app.months && app.months[m] ? app.months[m] : null);
  }, [app]);

  const t = (key, args = {}) => {
    const txt = TRANSLATIONS[app.lang || "en"][key] || key;
    // simple replacement for {name}
    return txt.replace(/\{(\w+)\}/g, (_, k) => args[k] || "");
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
    setApp((a) => {
      const months = { ...(a.months || {}) };
      if (!months[m]) months[m] = normalizeMonthData(null);
      return { ...a, activeMonth: m, months };
    });
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
    const keys = Object.keys(app.months || {});
    const ys = keys
      .map((k) => parseYM(k).y)
      .filter((y) => !!y);
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
    const entry = {
      id: uid(),
      label: String(item && item.name ? item.name : t("pendingIncomeFallback")).trim(),
      amount: item && item.amount != null ? item.amount : "0",
    };
    updateMonth((cur) => ({
      ...cur,
      pendingIncomeEntries: [...(cur.pendingIncomeEntries || []), entry],
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
    const result = applyMonthCopyToApp({
      app,
      sourceMonthKey: app.activeMonth,
      destinationMonthKey,
      options,
      idFactory: () => uid(),
      confirmReplace,
    });
    if (!result.ok) {
      notify(result.code === "same_month" ? t("copySameMonthError") : t("monthCopyInvalid"));
      return;
    }

    const validation = validateApplicationState(result.app);
    if (!validation.valid) {
      notify(t("monthCopyInvalid"));
      return;
    }

    const persisted = persistenceLocked.current
      ? { ok: false, code: saveErrorCode || "storage_unavailable" }
      : writeStorageValue(getBrowserStorage(), LS_KEY, JSON.stringify(result.app));

    skipNextSave.current = true;
    setApp(result.app);
    setCopyOpen(false);
    if (persisted.ok) {
      setSaveErrorCode(null);
      setSaveStatus("saved");
      notify(t("monthCopied"));
    } else {
      setSaveErrorCode(persisted.code);
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
    const persisted = writeStorageValue(getBrowserStorage(), LS_KEY, JSON.stringify(next));
    if (!persisted.ok) {
      setSaveErrorCode(persisted.code);
      setSaveStatus("error");
      notify(t("importSaveFailed"));
      return;
    }
    persistenceLocked.current = false;
    skipNextSave.current = true;
    setApp(next);
    setSaveErrorCode(null);
    setSaveStatus("imported");
  };

  const openPreview = () => setPreviewOpen(true);

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
    <div className="min-h-screen bg-neutral-50 text-neutral-800">
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
      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onPrint={() => window.print()}
        onBackup={exportJSON}
        onImport={importJSON}
        t={t}
      />

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

          <div role="dialog" aria-modal="true" aria-labelledby="print-preview-title" className="relative w-full max-w-4xl bg-white rounded-[28px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col max-h-[90vh] print:max-h-none print:rounded-none print:shadow-none print:overflow-visible print:static print:w-full print:max-w-none print:transform-none">
            
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
                      {previewIncomes.length === 0 ? (
                        <div className="text-sm text-neutral-700 print:text-xs">{t("noIncome")}</div>
                      ) : (
                        previewIncomes.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-3 print:text-xs">
                            <div className="text-neutral-800 break-words font-medium">{i.name || t("unnamed")}</div>
                            <div className="font-semibold text-neutral-800">
                              <Money value={toNumber(i.amount)} currency={app.currency} />
                            </div>
                          </div>
                        ))
                      )}
                      <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between print:pt-2 print:mt-2">
                        <div className="font-semibold text-neutral-800 print:text-sm">{t("totalIncome")}</div>
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
                                      </div>
                                      <div className="text-neutral-800">
                                        <Money value={toNumber(e.amount)} currency={app.currency} />
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <div>
            {/* Master heading style */}
            <div className="relative flex flex-wrap items-center gap-3 w-full">
              <img src={budgitLogo} alt="BudgIt" className="h-24 sm:h-32 w-auto select-none shrink-0" />
            </div>
          </div>

          <div className="hidden md:flex justify-center">
            <img
              src={budgitSub}
              alt="BudgIt Subheading"
              className="h-24 sm:h-32 w-auto object-contain max-w-[90%] select-none"
            />
          </div>

          <div className="flex flex-col items-end">
            <div className="relative flex justify-end gap-2 pt-2 mb-12 md:mb-0 w-full">
              <div className="flex items-center gap-2">
                {HUB_URL ? (
                  <ActionButton onClick={() => { window.location.href = HUB_URL; }}>{t("hub")}</ActionButton>
                ) : null}
                <ActionButton onClick={() => {
                  setOverviewYear(parseYM(app.activeMonth).y || new Date().getFullYear());
                  setCurrentView("year");
                }}>{t("yearOverview")}</ActionButton>
                <ActionButton onClick={openPreview}>{t("preview")}</ActionButton>
                <ActionButton onClick={() => setExportModalOpen(true)}>{t("data")}</ActionButton>
              </div>

              <button
                type="button"
                title="Help"
                onClick={() => setHelpOpen(true)}
                className="print:hidden h-9 w-9 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center font-bold text-neutral-800 text-sm"
                aria-label="Help"
              >
                ?
              </button>

              <div className="print:hidden absolute right-0 top-12">
                <div className="flex items-center gap-1 p-1 bg-white border border-neutral-200 rounded-xl w-fit shadow-sm">
                  <button
                    onClick={() => setLang("en")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                      app.lang === "en"
                        ? "bg-[#D5FF00] text-neutral-900 shadow-sm"
                        : "text-neutral-500 hover:text-neutral-900 hover:bg-[#D5FF00]/30"
                    }`}
                  >
                    EN
                  </button>
                  <button
                    onClick={() => setLang("de")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                      app.lang === "de"
                        ? "bg-[#D5FF00] text-neutral-900 shadow-sm"
                        : "text-neutral-500 hover:text-neutral-900 hover:bg-[#D5FF00]/30"
                    }`}
                  >
                    DE
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 min-w-0 max-w-full rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
            <div className="px-4 py-3 border-b border-neutral-100">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 w-full sm:w-auto">
                  <MiniActionButton onClick={() => ensureMonth(addMonths(app.activeMonth, -1))} title={t("prevMonthTitle")}>
                    {t("prevMonth")}
                  </MiniActionButton>
                  <MiniActionButton onClick={() => ensureMonth(addMonths(app.activeMonth, 1))} title={t("nextMonthTitle")}>
                    {t("nextMonth")}
                  </MiniActionButton>

                  <select
                    value={activeYM.y || new Date().getFullYear()}
                    onChange={(e) => setActiveYear(Number(e.target.value))}
                    className="print:hidden h-10 w-full rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 shadow-sm px-3 text-neutral-700 cursor-pointer"
                    title={t("yearTitle")}
                  >
                    {years.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>

                  <select
                    value={activeYM.m || 1}
                    onChange={(e) => setActiveMonthNum(Number(e.target.value))}
                    className="print:hidden h-10 w-full rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 focus:outline-none focus:ring-2 focus:ring-[#D5FF00]/50 shadow-sm px-3 text-neutral-700 cursor-pointer"
                    title={t("monthTitle")}
                  >
                    {Array.from({ length: 12 }).map((_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {new Date(2000, i, 1).toLocaleDateString(app.lang === "de" ? "de-DE" : "en-US", { month: "long" })}
                      </option>
                    ))}
                  </select>

                  <div className="relative col-span-1">
                    <MiniActionButton onClick={() => setCopyOpen(true)} title={t("copyNextTitle")} className="!h-8 !text-xs">
                      {t("copyMonth")}
                    </MiniActionButton>
                  </div>

                  <MiniActionButton tone="danger" onClick={clearMonth} title={t("clearMonthTitle")}>
                    {t("startAgain")}
                  </MiniActionButton>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-end justify-between gap-3">
                  <div className="flex items-center gap-6">
                    <div className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-600">{monthLabel(app.activeMonth, app.lang)}</div>
                    {searchOpen ? (
                      <div className="relative flex items-center">
                        <input 
                          autoFocus
                          className="h-9 pl-3 pr-8 rounded-xl text-xs font-medium border border-neutral-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#D5FF00] w-32 sm:w-48 transition-all"
                          placeholder={t("searchPlaceholder")}
                          value={searchTerm}
                          onChange={e => setSearchTerm(e.target.value)}
                          onKeyDown={e => { if(e.key === 'Escape') { setSearchOpen(false); setSearchTerm(""); } }}
                        />
                        <button 
                          onClick={() => { setSearchOpen(false); setSearchTerm(""); }}
                          className="absolute right-2 text-neutral-400 hover:text-neutral-600"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <button onClick={() => setSearchOpen(true)} title={t("search")} className="h-9 w-9 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center text-neutral-500 transition">
                        <SearchIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="hidden sm:block text-xs text-neutral-500 font-medium tabular-nums">{app.activeMonth}</div>
                </div>
                <div
                  role="status"
                  aria-live={saveStatus === "error" || saveStatus === "load_error" ? "assertive" : "polite"}
                  title={saveErrorCode || undefined}
                  className={`mt-2 text-xs ${saveStatus === "error" || saveStatus === "load_error" ? "text-red-700" : "text-neutral-500"}`}
                >
                  {saveStatus === "saving" && t("saveStatusSaving")}
                  {saveStatus === "saved" && t("saveStatusSaved")}
                  {saveStatus === "imported" && t("saveStatusImported")}
                  {saveStatus === "error" && (
                    <><span className="font-semibold">{t("saveStatusError")}</span> — {t("saveFailureAdvice")}</>
                  )}
                  {saveStatus === "load_error" && (
                    <><span className="font-semibold">{t("saveStatusLoadError")}</span> — {t("loadFailureAdvice")}</>
                  )}
                </div>
                <div className="mt-2 h-[2px] w-72 rounded-full bg-gradient-to-r from-[#D5FF00]/0 via-[#D5FF00] to-[#D5FF00]/0" />
              </div>
            </div>

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
                              <div className="mobile-entry-amount pt-5"><Money value={mobileIncome.amount} currency={app.currency} /></div>
                            </div>
                            <div className="mobile-entry-meta mt-3 grid-cols-2">
                              <label>
                                <span className="mobile-entry-label">{t("amount")}</span>
                                <SelectAllNumberInput className="mobile-entry-input text-right tabular-nums" value={mobileIncome.amount == null ? "0" : mobileIncome.amount} onChange={(event) => updateIncome(income.id, { amount: event.target.value })} inputMode="decimal" title={t("amount")} />
                              </label>
                              <label>
                                <span className="mobile-entry-label">{t("status")}</span>
                                <select className="mobile-entry-input" value={INCOME_STATUSES.includes(mobileIncome.status) ? mobileIncome.status : "expected"} onChange={(event) => updateIncome(income.id, { status: event.target.value })}>
                                  {INCOME_STATUSES.map((status) => <option key={status} value={status}>{t(`status_${status}`)}</option>)}
                                </select>
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
                          <div className="text-center">{t("incomeStatus")}</div>
                          <div className="text-center">{t("actions")}</div>
                        </div>
                        <div>
                    {visibleIncomes.map((i, idx) => (
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

                          <SelectAllNumberInput
                            className="ledger-table-control ledger-table-amount"
                            value={i.amount == null ? "0" : i.amount}
                            onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                            inputMode="decimal"
                            placeholder="0"
                            title={t("amount")}
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
                    ))}
                        </div>
                      </div>
                    </div>
                    </>
                  )}

                  {(active.incomes || []).length ? (
                    <div className="pt-3 mt-2 flex items-center justify-between px-2">
                      <div className="text-sm text-neutral-700">{t("totalIncome")}</div>
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
                                  return (
                                    <article key={expense.id} data-expense-item={expense.id} className={`mobile-entry-card ${highlightItem === expense.id ? "ring-2 ring-[#D5FF00]" : ""}`} aria-labelledby={`mobile-expense-${expense.id}`}>
                                      <div className="flex items-start gap-3">
                                        {!searchTerm ? <div draggable onDragStart={(event) => setDragPayload({ type: "expense", fromGroupId: g.id, itemId: expense.id }, event)} onDragEnd={clearDragState} className="mobile-entry-action flex min-h-11 w-11 shrink-0 cursor-grab items-center justify-center px-0 touch-pan-y" title={t("dragExpenseTitle")} aria-label={t("dragExpenseTitle")}>⋮</div> : null}
                                        <label className="mobile-entry-heading">
                                          <span className="mobile-entry-label">{t("expenseName")}</span>
                                          <input id={`mobile-expense-${expense.id}`} className={`mobile-entry-input font-semibold ${mobileExpense.paid ? "line-through text-neutral-500" : ""}`} value={mobileExpense.name} onChange={(event) => updateExpenseItem(g.id, expense.id, { name: event.target.value })} placeholder={t("expenseName")} />
                                        </label>
                                        <div className={`mobile-entry-amount pt-5 ${mobileExpense.paid ? "line-through text-neutral-500" : ""}`}><Money value={mobileExpense.amount} currency={app.currency} /></div>
                                      </div>
                                      <div className="mt-3 flex items-center justify-between gap-3">
                                        <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${mobileExpense.paid ? "border-[#D5FF00] bg-[#D5FF00]/20 text-neutral-800" : "border-neutral-300 text-neutral-700"}`}>{mobileExpense.paidLabel}</span>
                                        {mobileExpense.dueLabel ? <span className="text-sm text-neutral-700"><span className="font-medium">{t("dueLabel")}:</span> {mobileExpense.dueLabel}</span> : null}
                                      </div>
                                      <label className="mt-3 block">
                                        <span className="mobile-entry-label">{t("amount")}</span>
                                        <SelectAllNumberInput className="mobile-entry-input text-right tabular-nums" value={mobileExpense.amount == null ? "0" : mobileExpense.amount} onChange={(event) => updateExpenseItem(g.id, expense.id, { amount: event.target.value })} inputMode="decimal" title={t("amount")} />
                                      </label>
                                      <div className="mt-3">
                                        <span className="mobile-entry-label">{t("dueDate")}</span>
                                        <DuePicker ym={app.activeMonth} value={expense.dueDay} onChange={(due) => updateExpenseItem(g.id, expense.id, { dueDay: due })} lang={app.lang} t={t} />
                                      </div>
                                      {mobileExpense.notes ? <div className="mobile-entry-notes mt-3"><span className="mobile-entry-label">{t("notes")}</span>{mobileExpense.notes}</div> : null}
                                      <div className="mobile-entry-actions print:hidden">
                                        <button type="button" className="mobile-entry-action" onClick={() => document.getElementById(`mobile-expense-${expense.id}`)?.focus()}>{t("edit")}</button>
                                        <button type="button" className="mobile-entry-action" onClick={() => updateExpenseItem(g.id, expense.id, { paid: !expense.paid })} aria-label={`${expense.paid ? t("unpaidState") : t("paidState")}: ${mobileExpense.name || t("expenseName")}`}>{expense.paid ? t("unpaidState") : t("paidState")}</button>
                                        <button type="button" className="mobile-entry-action" onClick={() => setNoteModal({ groupId: g.id, itemId: expense.id })}>{t("notes")}</button>
                                        <button type="button" className="mobile-entry-action-danger ml-auto" onClick={() => deleteExpenseItem(g.id, expense.id)} aria-label={`${t("delete")}: ${mobileExpense.name || t("expenseName")}`}>{t("delete")}</button>
                                      </div>
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
                                    <div className="text-center">{t("actions")}</div>
                                  </div>
                                  <div>
                              {itemsVisible.map((e, idx) => (
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

                                    <SelectAllNumberInput
                                      className={`ledger-table-control ledger-table-amount ${
                                        e.paid ? "line-through text-neutral-600 decoration-[#D5FF00] decoration-2" : "text-neutral-800"
                                      }`}
                                      value={e.amount == null ? "0" : e.amount}
                                      onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                      inputMode="decimal"
                                      placeholder="0"
                                      title={t("amount")}
                                    />

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
                              ))}
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
          <div className="flex flex-col gap-3">
            <div className="flex justify-end gap-2 print:hidden">
              <button
                type="button"
                onClick={() => {
                  const ua = navigator.userAgent.toLowerCase();
                  if (ua.indexOf("android") > -1) {
                    window.location.href = "intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.APP_CALCULATOR;end";
                  } else {
                    window.location.href = "ms-calculator:";
                  }
                }}
                className="h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center text-neutral-600 transition"
                title={t("calculator")}
              >
                <CalculatorIcon className="h-5 w-5" />
              </button>

              <div className="flex items-center gap-1 p-1 bg-white border border-neutral-200 rounded-xl w-fit shadow-sm">
                {Object.keys(CURRENCIES).map((c) => (
                  <button
                    key={c}
                    onClick={() => setApp((a) => ({ ...a, currency: c }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${app.currency === c ? "bg-[#D5FF00] text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-900 hover:bg-[#D5FF00]/30"}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800">{t("summary")}</div>
              <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[["expectedIncome", incomeTotal, false], ["plannedExpenses", expensePlannedTotal, false], ["leftAfterPlannedExpenses", netRemaining, netRemaining < 0], ["unpaidExpenses", expenseRemainingTotal, false]].map(([label, value, negative]) => (
                  <div key={label} className={`rounded-2xl border p-4 min-w-0 ${negative ? "border-red-200" : "border-neutral-200"}`}>
                    <div className="text-sm leading-5 text-neutral-700 break-words">{t(label)}</div>
                    <div className={`text-2xl font-semibold mt-1 tabular-nums ${negative ? "text-red-700" : "text-neutral-800"}`}>
                      {negative ? <span className="sr-only">{t("negativeValue")}: </span> : null}
                      <Money value={value} currency={app.currency} />
                    </div>
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
