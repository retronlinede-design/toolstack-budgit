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

const uid = () => {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (err) {
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
  } catch (err) {
    return fallback;
  }
};

const toNumber = (v) => {
  const n = Number(String(v == null ? "" : v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
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

const canUseLS = () => {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch (err) {
    return false;
  }
};

const lsGet = (key) => {
  if (!canUseLS()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    return null;
  }
};

const lsSet = (key, value) => {
  if (!canUseLS()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    // ignore
  }
};

// ---------------------------
// UI primitives (MASTER: Check-It)
// ---------------------------

function SmallButton({ children, onClick, tone = "default", className = "", disabled, title, type = "button" }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00]/30 border-[#D5FF00]/30 text-neutral-800 shadow-sm hover:bg-white hover:border-neutral-200"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200 shadow-sm"
        : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200 shadow-sm";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden px-3 py-2 rounded-xl text-sm font-medium border transition active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

/** Normalized Top Actions (mobile-aligned “table/grid”) */
const ACTION_BASE =
  "print:hidden h-10 w-full rounded-xl text-sm font-medium border transition shadow-sm active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center";

function ActionButton({ children, onClick, tone = "default", disabled, title }) {
  const cls =
    tone === "primary"
      ? "bg-[#D5FF00]/30 border-[#D5FF00]/30 text-neutral-800 hover:bg-white hover:border-neutral-200"
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
      ? "bg-[#D5FF00]/30 border-[#D5FF00]/30 text-neutral-800 hover:bg-white hover:border-neutral-200"
      : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200";

  return (
    <label title={title} className={`${ACTION_BASE} ${cls} cursor-pointer`}>
      <span>{children}</span>
      <input
        type="file"
        accept={accept}
        className="hidden"
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
      ? "bg-[#D5FF00]/30 border-[#D5FF00]/30 text-neutral-800 hover:bg-white hover:border-neutral-200"
      : tone === "danger"
        ? "bg-red-50 hover:bg-red-100 text-red-700 border-red-200"
        : "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`print:hidden h-10 w-full rounded-xl text-sm font-medium border transition shadow-sm active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed ${cls} ${className}`}
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
      className="print:hidden select-none h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center text-neutral-700 cursor-grab active:cursor-grabbing"
      aria-label={title}
    >
      <span className="leading-none text-lg">⋮⋮</span>
    </div>
  );
}

function PaidCheck({ checked, onChange }) {
  return (
    <label className="print:hidden h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 shadow-sm flex items-center justify-center cursor-pointer">
      <input
        type="checkbox"
        className="h-4 w-4 accent-[#D5FF00]"
        checked={!!checked}
        onChange={(e) => {
          if (typeof onChange === "function") onChange(e.target.checked);
        }}
      />
    </label>
  );
}

function SelectAllNumberInput({ className = "", value, onChange, placeholder, inputMode = "decimal", title }) {
  // Click/focus selects all so you can type immediately over defaults.
  return (
    <input
      className={className}
      value={value == null ? "0" : value}
      onChange={onChange}
      placeholder={placeholder}
      inputMode={inputMode}
      title={title}
      onFocus={(e) => {
        try {
          e.target.select();
        } catch (err) {
          // ignore
        }
      }}
      onClick={(e) => {
        try {
          e.target.select();
        } catch (err) {
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

function PinIcon({ className = "", filled }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function NoteEditorModal({ open, onClose, item, groupName, onSave, onClear, t }) {
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (open && item) {
      setText(item.note || "");
      setPinned(!!item.notePinned);
    }
  }, [open, item]);

  if (!open || !item) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-[32px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col">
        <div className="px-6 pt-6 pb-4">
          <div className="text-xs font-bold text-neutral-400 uppercase tracking-wider mb-1">{groupName}</div>
          <div className="font-bold text-2xl text-neutral-900 tracking-tight">{t("note")} — {item.name || t("unnamed")}</div>
        </div>
        
        <div className="px-6 pb-6 space-y-4">
          <textarea
            className="w-full h-40 rounded-xl border border-neutral-200 p-4 bg-neutral-50 text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#D5FF00] focus:border-transparent resize-none"
            placeholder={t("notesPlaceholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPinned(!pinned)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition ${pinned ? "bg-[#D5FF00] text-neutral-900" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
            >
              <PinIcon className="h-4 w-4" filled={pinned} />
              {pinned ? "Pinned" : "Pin note"}
            </button>
          </div>
        </div>

        <div className="p-4 bg-neutral-50 border-t border-neutral-100 flex justify-between items-center">
          <div>
            {item.note && (
              <button
                onClick={() => {
                  if (window.confirm("Clear this note?")) onClear();
                }}
                className="text-red-600 text-sm font-medium hover:underline px-2"
              >
                {t("clear")}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-neutral-600 hover:bg-neutral-200 transition">
              {t("cancel")}
            </button>
            <button 
              onClick={() => onSave(text, pinned)}
              className="px-6 py-2 rounded-xl text-sm font-bold bg-[#D5FF00] text-neutral-900 shadow-sm hover:bg-[#c7f000] transition"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NotesPanel({ active, onJump, t }) {
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

  if (notes.length === 0) return null;

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white mt-6">
      <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800 flex items-center gap-2">
        <NoteIcon className="h-5 w-5 text-neutral-500" />
        {t("notes")}
      </div>
      <div className="divide-y divide-neutral-100">
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
                onClick={() => onJump(note.id)}
                className="shrink-0 text-xs font-medium text-[#D5FF00] bg-neutral-900 px-3 py-1.5 rounded-lg hover:bg-neutral-700 transition"
              >
                Jump to item
              </button>
            </div>
          </div>
        ))}
      </div>
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

function DuePicker({ ym, value, onChange, lang = "en", t }) {
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
    if (!open) {
      setPos(null);
      return;
    }

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
  }, []);

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
        className={`w-full h-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm px-3 text-neutral-800 text-sm flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300 ${
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
              className="h-8 px-3 rounded-xl text-xs font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-800"
              onClick={() => setOpen(false)}
              title={t("closeTitle")}
            >
              Close
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
                    className={`h-8 rounded-xl text-sm tabular-nums border transition ${
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
                className="h-8 px-3 rounded-xl text-xs font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-800"
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
      className={`print:hidden h-3 rounded-xl transition-colors duration-200 ${active ? "bg-lime-300 ring-2 ring-lime-100" : "bg-transparent"}`}
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
      className="print:hidden h-10 w-full rounded-xl text-sm font-medium border shadow-sm transition active:translate-y-[1px] flex items-center justify-between px-3 gap-2 bg-white border-neutral-200 text-neutral-700 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 group"
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
function HelpModal({ open, onClose, t }) {
  if (!open) return null;

  const CloseIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  );

  const Section = ({ title, children }) => (
    <div className="rounded-2xl bg-[#D5FF00]/30 p-5 border border-neutral-100">
      <div className="font-bold text-neutral-900 text-sm mb-2">{title}</div>
      <div className="text-sm text-neutral-600 leading-relaxed space-y-2">
        {children}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white rounded-[32px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col max-h-[85vh]">
        
        <div className="px-8 pt-8 pb-6 flex items-start justify-between shrink-0">
          <div>
            <div className="inline-block">
              <div className="font-bold text-3xl text-neutral-900 tracking-tight">{t("helpTitle")}</div>
              <div className="mt-2 h-1 w-full rounded-full bg-[#D5FF00]" />
            </div>
            <div className="text-base text-neutral-500 mt-3 font-medium">{t("helpSubtitle")}</div>
          </div>
          <button
            onClick={onClose}
            className="h-10 w-10 rounded-full bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition shrink-0"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="px-8 pb-8 overflow-y-auto">
          <div className="space-y-4">
            <Section title={t("autosave")}>
              <p>
                {t("autosaveDesc")}
                <span className="ml-2 font-mono text-xs bg-white border border-neutral-200 rounded-lg px-2 py-1 text-neutral-500">{LS_KEY}</span>
              </p>
              <p className="text-orange-600/80 font-medium text-xs bg-orange-50 p-2 rounded-lg border border-orange-100 inline-block">
                {t("autosaveWarn")}
              </p>
            </Section>

            <Section title={t("bestPractice")}>
              <ul className="list-disc pl-4 space-y-1 marker:text-neutral-400">
                <li>
                  {t("bp1")} <span className="font-semibold text-neutral-800">{t("data")}</span> {t("bp1b")}
                </li>
                <li>{t("bp2")}</li>
                <li>
                  {t("bp3")} <span className="font-semibold text-neutral-800">{t("import")}</span> {t("bp3b")}
                </li>
              </ul>
            </Section>

            <Section title={t("reordering")}>
              <p>
                {t("reorderingDesc")} <span className="font-semibold text-neutral-800">⋮⋮</span> {t("reorderingDesc2")}
              </p>
            </Section>

            <Section title={t("paidItems")}>
              <p>{t("paidItemsDesc")}</p>
            </Section>

            <Section title={t("sectionsHelp")}>
              <p>{t("sectionsHelpDesc")}</p>
            </Section>

            <Section title={t("dueDatesHelp")}>
              <p>{t("dueDatesHelpDesc")}</p>
            </Section>

            <Section title={t("copyingHelp")}>
              <p>{t("copyingHelpDesc")}</p>
            </Section>

            <Section title={t("printing")}>
              <p>
                {t("printingDesc")} <span className="font-semibold text-neutral-800">{t("preview")}</span> {t("printingDesc2")} <span className="font-semibold text-neutral-800">{t("printSave")}</span> {t("printingDesc3")}
              </p>
            </Section>

            <Section title={t("privacy")}>
              <p>{t("privacyDesc")}</p>
            </Section>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-neutral-100 text-xs text-neutral-400 font-medium text-center">
          {t("footer")}
        </div>
      </div>
    </div>
  );
}

function ExportModal({ open, onClose, onPreview, onPrint, onBackup, onImport, t }) {
  if (!open) return null;

  const IconWrapper = ({ children }) => (
    <div className="h-10 w-10 rounded-full bg-[#D5FF00] flex items-center justify-center text-neutral-900 shrink-0">
      {children}
    </div>
  );

  const Icons = {
    Preview: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
    Print: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>,
    Download: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    Upload: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
    Close: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  };

  const ActionRow = ({ icon, label, sub, onClick, file }) => {
    const content = (
      <>
        <IconWrapper>{icon}</IconWrapper>
        <div className="flex-1 text-left">
          <div className="font-semibold text-neutral-900 text-base">{label}</div>
          {sub && <div className="text-xs text-neutral-500 font-medium">{sub}</div>}
        </div>
      </>
    );

    const cls = "w-full p-3 rounded-2xl hover:bg-neutral-50 transition flex items-center gap-4 group active:scale-[0.98] border border-transparent hover:border-neutral-100";

    if (file) {
      return (
        <label className={`${cls} cursor-pointer`}>
          {content}
          <input
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files && e.target.files[0] ? e.target.files[0] : null;
              if (f) {
                onClose();
                if (typeof onImport === 'function') onImport(f);
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
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-[32px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all">
        <div className="px-6 pt-6 pb-4 flex items-center justify-between">
          <div className="font-bold text-2xl text-neutral-900 tracking-tight">{t("exportTitle")}</div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition"
          >
            <Icons.Close />
          </button>
        </div>
        
        <div className="px-4 pb-6 flex flex-col gap-2">
          <ActionRow
            icon={<Icons.Preview />}
            label={t("preview")}
            sub="View before printing"
            onClick={() => { onClose(); onPreview(); }}
          />
          <ActionRow
            icon={<Icons.Print />}
            label={t("printSave")}
            sub="Save as PDF or Print"
            onClick={() => { onClose(); onPrint(); }}
          />
          <div className="h-px bg-neutral-100 my-2 mx-4" />
          <ActionRow
            icon={<Icons.Download />}
            label={t("backup")}
            sub="Download JSON file"
            onClick={() => { onClose(); onBackup(); }}
          />
          <ActionRow
            icon={<Icons.Upload />}
            label={t("import")}
            sub="Restore from backup"
            file
            onImport={onImport}
          />
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
  const m = monthData || { incomes: [], expenses: [], notes: "", transactions: [] };

  const incomes = Array.isArray(m.incomes) ? m.incomes.map(normalizeIncomeItem) : [];
  const transactions = Array.isArray(m.transactions) ? m.transactions.map(normalizeTransaction) : [];

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
    };
  }

  const legacyExpenses = Array.isArray(m.expenses) ? m.expenses.map(normalizeExpenseItem) : [];
  return {
    incomes,
    expenseGroups: [{ id: uid(), label: "General", items: legacyExpenses }],
    notes: typeof m.notes === "string" ? m.notes : "",
    transactions,
  };
}

const TRANSLATIONS = {
  en: {
    subtitle: "Monthly personal budgeting tool",
    hub: "HUB",
    preview: "Preview",
    data: "Export",
    help: "Help",
    month: "Month",
    prevMonth: "◀ Prev",
    nextMonth: "Next ▶",
    copyNext: "Copy → Next",
    copyAll: "Copy ALL",
    copyUnpaid: "Copy UNPAID only",
    cancel: "Cancel",
    clear: "Clear",
    income: "Income",
    addIncome: "+ Add income",
    totalIncome: "Total income",
    totalExpenses: "Total expenses",
    expenses: "Expenses",
    addSection: "+ Add section",
    hidePaid: "Hide paid",
    showPaid: "Show paid",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    sortDue: "Sort due",
    clearPaid: "Clear paid",
    clearItems: "Clear items",
    deleteSection: "Delete section",
    notes: "Notes",
    notesPlaceholder: "Optional notes for this month…",
    summary: "Summary",
    remainingExpenses: "Remaining expenses",
    plannedExpenses: "Planned expenses",
    netRemaining: "Net (after remaining)",
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
    noIncome: "No income items yet.",
    noExpenses: "No expense sections yet. Click “Add section”.",
    noItems: "No items.",
    noItemsSection: "No items in this section.",
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
    copyingHelpDesc: "Move to the next month using “Copy → Next”. Choose “Copy UNPAID only” to carry over outstanding balances.",
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
    deleteSectionConfirm: "Delete “{name}” and all items inside it?",
    clearItemsConfirm: "Clear ALL items in “{name}”?",
    clearMonthConfirm: "Clear all income and expenses for this month?",
    unnamed: "(unnamed)",
    none: "(none)",
    salary: "Salary",
    newSection: "New section",
    expense: "Expense",
    sectionLabel: "Section label (e.g., Loans)",
    incomeName: "Income name",
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
    copyNextTitle: "Copy this month to next",
    clearMonthTitle: "Clear this month",
    prevMonthTitle: "Previous month",
    nextMonthTitle: "Next month",
    yearTitle: "Year",
    monthTitle: "Month",
    dragIncomeTitle: "Drag income item",
    dragSectionTitle: "Drag section",
    removeTitle: "Remove",
    sortDueTitle: "Sort by due day (earliest first)",
    clearPaidTitle: "Remove all PAID items in this section",
    clearItemsTitle: "Clear ALL items in this section",
    deleteSectionTitle: "Delete this section and all its items",
    dragExpenseTitle: "Drag expense item",
    closeTitle: "Close",
    clearDueTitle: "Clear due date",
    setDueTitle: "Set due: {d}",
    paidExpenses: "Paid expenses",
    calculator: "Calculator",
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
  },
  de: {
    subtitle: "Monatliches persönliches Budgetierungstool",
    hub: "HUB",
    preview: "Vorschau",
    data: "Export",
    help: "Hilfe",
    month: "Monat",
    prevMonth: "◀ Zurück",
    nextMonth: "Weiter ▶",
    copyNext: "Kopieren → Nächster",
    copyAll: "ALLES kopieren",
    copyUnpaid: "Nur UNBEZAHLTE kopieren",
    cancel: "Abbrechen",
    clear: "Leeren",
    income: "Einkommen",
    addIncome: "+ Einkommen",
    totalIncome: "Gesamteinkommen",
    totalExpenses: "Gesamtausgaben",
    expenses: "Ausgaben",
    addSection: "+ Abschnitt",
    hidePaid: "Bezahlte ausblenden",
    showPaid: "Bezahlte anzeigen",
    expandAll: "Alle erweitern",
    collapseAll: "Alle einklappen",
    sortDue: "Fälligkeit sort.",
    clearPaid: "Bezahlte leeren",
    clearItems: "Elemente leeren",
    deleteSection: "Abschnitt löschen",
    notes: "Notizen",
    notesPlaceholder: "Optionale Notizen für diesen Monat…",
    summary: "Zusammenfassung",
    remainingExpenses: "Verbleibende Ausgaben",
    plannedExpenses: "Geplante Ausgaben",
    netRemaining: "Netto (nach Verbleibenden)",
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
    noIncome: "Keine Einkommenselemente.",
    noExpenses: "Keine Ausgabenabschnitte. Klicken Sie auf „+ Abschnitt“.",
    noItems: "Keine Elemente.",
    noItemsSection: "Keine Elemente in diesem Abschnitt.",
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
    copyingHelpDesc: "Wechseln Sie mit „Kopieren → Nächster“ in den nächsten Monat. Wählen Sie „Nur UNBEZAHLTE kopieren“, um offene Salden zu übertragen.",
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
    deleteSectionConfirm: "„{name}“ und alle Elemente darin löschen?",
    clearItemsConfirm: "ALLE Elemente in „{name}“ leeren?",
    clearMonthConfirm: "Alle Einkommen und Ausgaben für diesen Monat löschen?",
    unnamed: "(unbenannt)",
    none: "(keine)",
    salary: "Gehalt",
    newSection: "Neuer Abschnitt",
    expense: "Ausgabe",
    sectionLabel: "Abschnittsbezeichnung (z. B. Kredite)",
    incomeName: "Einkommensname",
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
    copyNextTitle: "Diesen Monat in den nächsten kopieren",
    clearMonthTitle: "Diesen Monat leeren",
    prevMonthTitle: "Vorheriger Monat",
    nextMonthTitle: "Nächster Monat",
    yearTitle: "Jahr",
    monthTitle: "Monat",
    dragIncomeTitle: "Einkommenselement ziehen",
    dragSectionTitle: "Abschnitt ziehen",
    removeTitle: "Entfernen",
    sortDueTitle: "Nach Fälligkeit sortieren (früheste zuerst)",
    clearPaidTitle: "Alle BEZAHLTEN Elemente in diesem Abschnitt entfernen",
    clearItemsTitle: "ALLE Elemente in diesem Abschnitt leeren",
    deleteSectionTitle: "Diesen Abschnitt und alle seine Elemente löschen",
    dragExpenseTitle: "Ausgabenelement ziehen",
    closeTitle: "Schließen",
    clearDueTitle: "Fälligkeitsdatum löschen",
    setDueTitle: "Fällig setzen: {d}",
    paidExpenses: "Bezahlte Ausgaben",
    calculator: "Taschenrechner",
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
  }
};

function SpendTracker({ active, updateMonth, t, currencySymbol }) {
  const [amount, setAmount] = useState("");
  const [groupId, setGroupId] = useState("");
  const [itemId, setItemId] = useState("");
  const [note, setNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Card");
  const [filter, setFilter] = useState("today"); // 'today' | 'month'

  const expenseGroups = active.expenseGroups || [];
  const transactions = active.transactions || [];

  // Default group/item selection
  useEffect(() => {
    if (!groupId && expenseGroups.length > 0) {
      const firstG = expenseGroups[0];
      setGroupId(firstG.id);
      if (firstG.items && firstG.items.length > 0) {
        setItemId(firstG.items[0].id);
      }
    }
  }, [expenseGroups, groupId]);

  const handleGroupChange = (e) => {
    const newGid = e.target.value;
    setGroupId(newGid);
    const g = expenseGroups.find((x) => x.id === newGid);
    if (g && g.items && g.items.length > 0) {
      setItemId(g.items[0].id);
    } else {
      setItemId("");
    }
  };

  const handleAdd = () => {
    const val = parseFloat(String(amount || "").replace(",", "."));
    if (!val || isNaN(val)) return;

    const newTransaction = {
      id: uid(),
      dateISO: new Date().toISOString(),
      amountCents: Math.round(val * 100),
      groupId: groupId,
      itemId: itemId || null,
      note: (note || "").trim(),
      paymentMethod,
    };

    updateMonth((cur) => ({
      ...cur,
      transactions: [newTransaction, ...(cur.transactions || [])],
    }));

    setAmount("");
    setNote("");
  };

  const handleDelete = (id) => {
    if (!window.confirm(t("removeTitle") + "?")) return;
    updateMonth((cur) => ({
      ...cur,
      transactions: (cur.transactions || []).filter((t) => t.id !== id),
    }));
  };

  // Summary Calculations
  const summaryData = useMemo(() => {
    return expenseGroups.map((g) => {
      const groupItems = g.items || [];
      
      // Calculate per-item stats
      const itemsWithStats = groupItems.map((item) => {
        const planned = toNumber(item.amount);
        const spentCents = transactions
          .filter((t) => t.itemId === item.id)
          .reduce((sum, t) => sum + t.amountCents, 0);
        const spent = spentCents / 100;
        return { ...item, planned, spent, remaining: planned - spent };
      });

      // Group rollup
      const groupPlanned = itemsWithStats.reduce((s, i) => s + i.planned, 0);
      const groupSpentItems = itemsWithStats.reduce((s, i) => s + i.spent, 0);
      // Include transactions that have matching groupId but NO itemId (legacy or general)
      const groupGeneralSpentCents = transactions.filter(t => t.groupId === g.id && !t.itemId).reduce((s, t) => s + t.amountCents, 0);
      const totalGroupSpent = groupSpentItems + (groupGeneralSpentCents / 100);

      return {
        id: g.id,
        label: g.label || t("unnamed"),
        items: itemsWithStats,
        rollup: { planned: groupPlanned, spent: totalGroupSpent, remaining: groupPlanned - totalGroupSpent }
      };
    });
  }, [expenseGroups, transactions, t]);

  // Filtered Transactions
  const filteredTransactions = useMemo(() => {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];
    const monthStr = now.toISOString().slice(0, 7); // YYYY-MM

    return transactions.filter((t) => {
      if (!t) return false;
      const tDate = String(t.dateISO || "").split("T")[0];
      if (filter === "today") return tDate === todayStr;
      return tDate.startsWith(monthStr);
    });
  }, [transactions, filter]);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white">
      <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800">
        {t("spendTracker")}
      </div>
      <div className="p-4 space-y-6">
        {/* Quick Add Form */}
        <div className="space-y-3 bg-neutral-50 p-3 rounded-xl border border-neutral-100">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <input
              className="sm:col-span-3 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
              placeholder={`${t("amount")} (${currencySymbol})`}
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {/* Group Select */}
            <select
              className="sm:col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
              value={groupId}
              onChange={handleGroupChange}
            >
              {expenseGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label || t("unnamed")}
                </option>
              ))}
            </select>
            {/* Item Select */}
            <select
              className="sm:col-span-5 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300 disabled:opacity-50"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              disabled={!groupId}
            >
              {(expenseGroups.find(g => g.id === groupId)?.items || []).map((item) => (
                <option key={item.id} value={item.id}>{item.name || t("unnamed")}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              className="sm:col-span-1 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
              placeholder={t("note")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <select
              className="sm:col-span-1 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
            >
              <option value="Card">{t("card")}</option>
              <option value="Cash">{t("cash")}</option>
              <option value="Other">{t("other")}</option>
            </select>
            <button
              onClick={handleAdd}
              className="sm:col-span-1 rounded-xl bg-[#D5FF00]/30 hover:bg-[#D5FF00]/50 border border-[#D5FF00]/30 text-neutral-800 font-medium py-2 transition shadow-sm"
            >
              {t("addTransaction")}
            </button>
          </div>
        </div>

        {/* Summary Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-neutral-500 border-b border-neutral-100">
                <th className="pb-2 font-medium">{t("budgetLine")}</th>
                <th className="pb-2 font-medium text-right">{t("plannedExpenses")}</th>
                <th className="pb-2 font-medium text-right">{t("spent")}</th>
                <th className="pb-2 font-medium text-right">{t("remaining")}</th>
              </tr>
            </thead>
            <tbody className="text-neutral-800">
              {summaryData.map((group) => (
                <React.Fragment key={group.id}>
                  {/* Group Header / Rollup */}
                  <tr className="bg-neutral-50/80 font-semibold text-xs text-neutral-600">
                    <td className="py-2 pl-2 rounded-l-lg">{group.label}</td>
                    <td className="py-2 text-right tabular-nums">{currencySymbol}{group.rollup.planned.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums">{currencySymbol}{group.rollup.spent.toFixed(2)}</td>
                    <td className={`py-2 text-right tabular-nums pr-2 rounded-r-lg ${group.rollup.remaining < 0 ? "text-red-600" : "text-emerald-600"}`}>
                      {currencySymbol}{group.rollup.remaining.toFixed(2)}
                    </td>
                  </tr>
                  {/* Items */}
                  {group.items.map(item => (
                    <tr key={item.id} className="border-b border-neutral-50 last:border-0">
                      <td className="py-2 pl-6">{item.name || t("unnamed")}</td>
                      <td className="py-2 text-right tabular-nums text-neutral-500">{currencySymbol}{item.planned.toFixed(2)}</td>
                      <td className="py-2 text-right tabular-nums">{currencySymbol}{item.spent.toFixed(2)}</td>
                      <td className={`py-2 text-right tabular-nums font-medium ${item.remaining < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {currencySymbol}{item.remaining.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* Recent Transactions */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-neutral-800">{t("recentTransactions")}</div>
            <div className="flex bg-neutral-100 rounded-lg p-1">
              <button
                onClick={() => setFilter("today")}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${filter === "today" ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700"}`}
              >
                {t("today")}
              </button>
              <button
                onClick={() => setFilter("month")}
                className={`px-3 py-1 rounded-md text-xs font-medium transition ${filter === "month" ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700"}`}
              >
                {t("thisMonth")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {filteredTransactions.length === 0 ? (
              <div className="text-sm text-neutral-500 text-center py-4">{t("noTransactions")}</div>
            ) : (
              filteredTransactions.map((t) => {
                const group = expenseGroups.find((g) => g.id === t.groupId);
                const item = group?.items?.find(i => i.id === t.itemId);
                const label = item ? `${group.label}: ${item.name}` : (group?.label || "Unknown");
                return (
                  <div key={t.id} className="flex items-center justify-between p-3 rounded-xl border border-neutral-100 bg-neutral-50/50">
                    <div>
                      <div className="text-sm font-medium text-neutral-900">
                        {label} <span className="text-neutral-400 font-normal">• {t.paymentMethod}</span>
                      </div>
                      <div className="text-xs text-neutral-500">
                        {(() => {
                          try {
                            const d = new Date(t.dateISO);
                            return isNaN(d.getTime()) ? "??:??" : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          } catch (e) {
                            return "??:??";
                          }
                        })()}
                        {t.note && ` • ${t.note}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="font-semibold text-neutral-900 tabular-nums">
                        {currencySymbol}{(t.amountCents / 100).toFixed(2)}
                      </div>
                      <button
                        onClick={() => handleDelete(t.id)}
                        className="text-neutral-400 hover:text-red-600 transition px-1"
                        title={t("removeTitle")}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------
// App
// ---------------------------

export default function BudgitApp() {
  const [app, setApp] = useState(() => {
    const base = {
      activeMonth: monthKey(),
      months: {},
      lang: "en",
      currency: "EUR",
    };

    const saved = lsGet(LS_KEY);
    const data = saved ? safeParse(saved, base) : base;

    const m = data.activeMonth || monthKey();
    data.activeMonth = m;
    data.months = data.months || {};

    Object.keys(data.months).forEach((k) => {
      data.months[k] = normalizeMonthData(data.months[k]);
    });
    if (!data.months[m]) data.months[m] = normalizeMonthData(null);

    if (!data.lang) data.lang = "en";
    if (!data.currency) data.currency = "EUR";
    return data;
  });

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

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
    lsSet(LS_KEY, JSON.stringify(app));
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
    const item = { id: uid(), name: t("salary"), amount: "0" };
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
      const el = document.getElementById(`item-${itemId}`);
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
      let insertAt = clamp(toIndex, 0, items.length);
      if (fromIndex < insertAt) insertAt = insertAt - 1;

      groups.splice(clamp(insertAt, 0, items.length), 0, moved);
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

  const groupPlannedTotal = (group) => (group.items || []).reduce((s, it) => s + toNumber(it.amount), 0);
  const groupRemainingTotal = (group) =>
    (group.items || []).reduce((s, it) => s + (it.paid ? 0 : toNumber(it.amount)), 0);
  const groupPaidTotal = (group) =>
    (group.items || []).reduce((s, it) => s + (it.paid ? toNumber(it.amount) : 0), 0);

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

  const copyMonthToNext = (mode) => {
    const fromKey = app.activeMonth;
    const toKey = addMonths(fromKey, 1);

    const from = normalizeMonthData(app.months && app.months[fromKey] ? app.months[fromKey] : null);

    const makeItem = (it) => {
      const base = normalizeExpenseItem(it);
      return { ...base, id: uid(), paid: false };
    };

    const nextGroups = (from.expenseGroups || []).map((g) => {
      const items = (g.items || [])
        .filter((it) => (mode === "unpaid" ? !it.paid : true))
        .map(makeItem);
      return { id: uid(), label: String((g.label || "General")).trim() || "General", items };
    });

    const next = normalizeMonthData({
      incomes: (from.incomes || []).map((i) => ({ ...normalizeIncomeItem(i), id: uid() })),
      expenseGroups: nextGroups.length ? nextGroups : [{ id: uid(), label: "General", items: [] }],
      notes: "",
    });

    setApp((a) => {
      const months = { ...(a.months || {}) };
      months[toKey] = next;
      return { ...a, months, activeMonth: toKey };
    });

    setCopyOpen(false);
    notify(mode === "unpaid" ? t("copyUnpaidMsg") : t("copyAllMsg"));
  };

  // ---------------------------
  // Export / Import
  // ---------------------------

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(app, null, 2)], { type: "application/json" });
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
    const text = await file.text();
    const parsed = safeParse(text, null);
    if (!parsed || !parsed.months) {
      notify(t("invalidJson"));
      return;
    }

    const months = { ...(parsed.months || {}) };
    Object.keys(months).forEach((k) => {
      months[k] = normalizeMonthData(months[k]);
    });

    const next = {
      activeMonth: parsed.activeMonth || monthKey(),
      months,
    };
    next.months[next.activeMonth] = normalizeMonthData(next.months[next.activeMonth]);

    setApp(next);
    notify(t("imported"));
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
    } catch (err) {
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
    } catch (err) {
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

  const incomeTotal = useMemo(() => (active.incomes || []).reduce((sum, i) => sum + toNumber(i.amount), 0), [active.incomes]);

  const expensePlannedTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce((sum, g) => sum + groupPlannedTotal(g), 0);
  }, [active.expenseGroups]);

  const expenseRemainingTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce((sum, g) => sum + groupRemainingTotal(g), 0);
  }, [active.expenseGroups]);

  const expensePaidTotal = useMemo(() => {
    const groups = active.expenseGroups || [];
    return groups.reduce((sum, g) => sum + groupPaidTotal(g), 0);
  }, [active.expenseGroups]);

  const netRemaining = useMemo(() => incomeTotal - expensePlannedTotal, [incomeTotal, expensePlannedTotal]);

  const savingsRate = useMemo(() => {
    if (!incomeTotal) return 0;
    return (netRemaining / incomeTotal) * 100;
  }, [netRemaining, incomeTotal]);

  // ---------------------------
  // Print preview computed
  // ---------------------------

  const previewIncomes = active.incomes || [];
  const previewGroups = active.expenseGroups || [];

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
    } catch (err) {
      // ignore
    }
  }, []);

  // ---------------------------
  // Render
  // ---------------------------

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
      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onPreview={openPreview}
        onPrint={() => window.print()}
        onBackup={exportJSON}
        onImport={importJSON}
        t={t}
      />

      {previewOpen ? (
        <style>{`
          @media print {
            body * { visibility: hidden !important; }
            #budgit-print-preview, #budgit-print-preview * { visibility: visible !important; }
            #budgit-print-preview { position: absolute !important; left: 0; top: 0; width: 100%; }
          }
        `}</style>
      ) : null}

      {previewOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:p-0">
          <div className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm transition-opacity print:hidden" onClick={() => setPreviewOpen(false)} />

          <div className="relative w-full max-w-4xl bg-white rounded-[32px] shadow-2xl overflow-hidden ring-1 ring-black/5 transform transition-all flex flex-col max-h-[90vh] print:max-h-none print:rounded-none print:shadow-none print:overflow-visible">
            
            <div className="px-8 pt-8 pb-6 flex items-start justify-between shrink-0 print:hidden">
              <div>
                <div className="inline-block">
                  <div className="font-bold text-3xl text-neutral-900 tracking-tight">{t("printPreview")}</div>
                  <div className="mt-2 h-1 w-full rounded-full bg-[#D5FF00]" />
                </div>
                <div className="text-sm text-neutral-500 mt-3 font-medium max-w-md">{t("previewTip")}</div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.print()}
                  className="h-10 px-5 rounded-full bg-[#D5FF00] hover:bg-[#c7f000] text-neutral-900 font-bold text-sm transition flex items-center gap-2 shadow-sm active:scale-[0.98]"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  {t("printSave")}
                </button>
                <button
                  onClick={() => setPreviewOpen(false)}
                  className="h-10 w-10 rounded-full bg-neutral-100 hover:bg-[#D5FF00] hover:text-neutral-900 flex items-center justify-center text-neutral-600 transition"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>

            <div className="overflow-y-auto p-8 pt-0 print:p-0 print:overflow-visible">
              <div id="budgit-print-preview" className="p-8 border border-neutral-100 rounded-2xl bg-white print:border-none print:p-0 print:rounded-none">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-2xl font-semibold text-neutral-800">Budgit</div>
                    <div className="text-sm text-neutral-700">{monthLabel(app.activeMonth, app.lang)}</div>
                    <div className="mt-3 h-[2px] w-64 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
                  </div>
                  <div className="text-sm text-neutral-700">{t("generated")}: {new Date().toLocaleString()}</div>
                </div>

                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800">{t("income")}</div>
                    <div className="p-4 space-y-2">
                      {previewIncomes.length === 0 ? (
                        <div className="text-sm text-neutral-700">{t("noIncome")}</div>
                      ) : (
                        previewIncomes.map((i) => (
                          <div key={i.id} className="flex items-center justify-between gap-3">
                            <div className="text-neutral-800">{i.name || t("unnamed")}</div>
                            <div className="font-semibold text-neutral-800">
                              <Money value={toNumber(i.amount)} currency={app.currency} />
                            </div>
                          </div>
                        ))
                      )}
                      <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between">
                        <div className="font-semibold text-neutral-800">{t("totalIncome")}</div>
                        <div className="font-semibold text-neutral-800">
                          <Money value={incomeTotal} currency={app.currency} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200">
                    <div className="px-4 py-3 border-b border-neutral-100 font-semibold text-neutral-800">{t("expenses")}</div>
                    <div className="p-4 space-y-4">
                      {previewGroups.length === 0 ? (
                        <div className="text-sm text-neutral-700">{t("noExpenses")}</div>
                      ) : (
                        previewGroups.map((g) => (
                          <div key={g.id} className="rounded-2xl border border-neutral-200">
                            <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between">
                              <div className="font-semibold text-neutral-800">{String((g.label || "General")).trim()}</div>
                              <div className="text-sm text-neutral-700">
                                {t("remainingExpenses")}: <span className="font-semibold text-neutral-800">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span>
                                <span className="text-neutral-400"> • </span>
                                Planned: <span className="font-medium">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span>
                              </div>
                            </div>
                            <div className="p-3 space-y-2">
                              {(g.items || []).length === 0 ? (
                                <div className="text-sm text-neutral-700">No items.</div>
                              ) : (
                                (g.items || []).map((e) => {
                                  const info = dueInfo(app.activeMonth, e.dueDay, app.lang);
                                  return (
                                    <div key={e.id} className="flex items-center justify-between gap-3">
                                      <div className="text-neutral-800">
                                        {e.paid ? "✓ " : ""}
                                        {e.name || t("unnamed")}
                                        {info ? (
                                          <span className="text-neutral-600" title={info.title}>
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

                      <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-neutral-800">{t("remainingExpenses")}</div>
                          <div className="text-xs text-neutral-600">{t("plannedExpenses")}: {currencySymbol}{expensePlannedTotal.toFixed(2)}</div>
                        </div>
                        <div className="font-semibold text-neutral-800">
                          <Money value={expenseRemainingTotal} currency={app.currency} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-[#D5FF00]" : "border-red-200"}`}>
                    <div className="text-sm text-neutral-700">{t("netRemaining")}</div>
                    <div className="text-2xl font-semibold text-neutral-800 mt-1">
                      <Money value={netRemaining} currency={app.currency} />
                    </div>
                    <div className="text-xs text-neutral-700 mt-2">
                      {t("savingsRate")}: <span className="font-medium">{savingsRate.toFixed(1)}%</span>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 p-4">
                    <div className="text-sm text-neutral-700">{t("notes")}</div>
                    <div className="mt-2 whitespace-pre-wrap text-neutral-800 text-sm">{String(active.notes || "").trim() ? active.notes : t("none")}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {/* Master heading style */}
            <div className="relative">
              <img src={budgitLogo} alt="BudgIt" className="h-24 sm:h-32 w-auto select-none" />
            </div>
          </div>

          <div className="w-full sm:w-[520px] lg:w-[620px] mb-12 sm:mb-0">
            <div className="relative">
              <div className="grid grid-cols-3 gap-2 pr-12">
                <ActionButton onClick={() => {}}>{t("hub")}</ActionButton>
                <ActionButton onClick={openPreview}>{t("preview")}</ActionButton>

                <ActionButton onClick={() => setExportModalOpen(true)}>{t("data")}</ActionButton>
              </div>

              <button
                type="button"
                title="Help"
                onClick={() => setHelpOpen(true)}
                className="print:hidden absolute right-0 top-0 h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center font-bold text-neutral-800"
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
          <div className="md:col-span-2 rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
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

                  <div className="relative col-span-2 sm:col-span-2">
                    <MiniActionButton onClick={() => setCopyOpen((v) => !v)} title={t("copyNextTitle")}>
                      {t("copyNext")}
                    </MiniActionButton>

                    {copyOpen ? (
                      <div className="print:hidden absolute z-20 mt-2 w-full rounded-2xl border border-neutral-200 bg-white shadow-xl p-2">
                        <div className="grid grid-cols-1 gap-2">
                          <MiniActionButton tone="primary" onClick={() => copyMonthToNext("all")}>
                            {t("copyAll")}
                          </MiniActionButton>
                          <MiniActionButton onClick={() => copyMonthToNext("unpaid")}>{t("copyUnpaid")}</MiniActionButton>
                          <MiniActionButton tone="danger" onClick={() => setCopyOpen(false)}>
                            {t("cancel")}
                          </MiniActionButton>
                        </div>
                        <div className="mt-2 text-xs text-neutral-600">{t("copyNote")}</div>
                      </div>
                    ) : null}
                  </div>

                  <MiniActionButton tone="danger" onClick={clearMonth} title={t("clearMonthTitle")}>
                    {t("clear")}
                  </MiniActionButton>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-end justify-between gap-3">
                  <div className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-600">{monthLabel(app.activeMonth, app.lang)}</div>
                  <div className="hidden sm:block text-xs text-neutral-500 font-medium tabular-nums">{app.activeMonth}</div>
                </div>
                <div className="mt-2 h-[2px] w-72 rounded-full bg-gradient-to-r from-[#D5FF00]/0 via-[#D5FF00] to-[#D5FF00]/0" />
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Income */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex items-center justify-between">
                  <div className="font-semibold text-neutral-800">{t("income")}</div>
                  <SmallButton tone="primary" onClick={addIncome}>
                    {t("addIncome")}
                  </SmallButton>
                </div>

                <div className="p-4 space-y-2">
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

                  {(active.incomes || []).length === 0 ? (
                    <div className="text-sm text-neutral-700">{t("noIncome")}</div>
                  ) : (
                    (active.incomes || []).map((i, idx) => (
                      <div key={i.id}>
                        <div className="grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border border-transparent">
                          <div
                            className="col-span-1"
                            draggable
                            onDragStart={(e) => setDragPayload({ type: "income", itemId: i.id }, e)}
                            onDragEnd={clearDragState}
                          >
                            <DragHandle title={t("dragIncomeTitle")} />
                          </div>

                          <input
                            className="col-span-6 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
                            value={i.name || ""}
                            onChange={(e) => updateIncome(i.id, { name: e.target.value })}
                            placeholder={t("incomeName")}
                            onFocus={(e) => {
                              try {
                                e.target.select();
                              } catch (err) {
                                // ignore
                              }
                            }}
                            onClick={(e) => {
                              try {
                                e.target.select();
                              } catch (err) {
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
                                  } catch (err) {
                                    // ignore
                                  }
                                  setTimeout(() => setLastAdded(null), 0);
                                });
                              }
                            }}
                          />

                          <SelectAllNumberInput
                            className="col-span-4 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right text-neutral-800 tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
                            value={i.amount == null ? "0" : i.amount}
                            onChange={(e) => updateIncome(i.id, { amount: e.target.value })}
                            inputMode="decimal"
                            placeholder="0"
                            title={t("amount")}
                          />

                          <button
                            className="print:hidden col-span-1 h-10 rounded-xl border bg-red-50 hover:bg-red-100 text-red-700 border-red-200 px-3 shadow-sm"
                            title={t("removeTitle")}
                            onClick={() => deleteIncome(i.id)}
                          >
                            ×
                          </button>
                        </div>

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
                      </div>
                    ))
                  )}

                  {(active.incomes || []).length ? (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div className="text-sm text-neutral-700">{t("totalIncome")}</div>
                      <div className="font-semibold text-neutral-800">
                        <Money value={incomeTotal} currency={app.currency} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Expenses */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="font-semibold text-neutral-800">{t("expenses")}</div>
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

                  {(active.expenseGroups || []).map((g, gIdx) => {
                    const allItems = g.items || [];
                    const itemsVisible = hidePaid ? allItems.filter((it) => !it.paid) : allItems;
                    const itemsCount = allItems.length;

                    return (
                      <div key={g.id}>
                        <div className="rounded-2xl border border-neutral-200 overflow-hidden">
                        <div className="px-3 py-3 border-b border-neutral-100">
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                              <div className="flex items-center gap-2">
                                <div
                                  draggable
                                  onDragStart={(e) => setDragPayload({ type: "expenseGroup", groupId: g.id }, e)}
                                  onDragEnd={clearDragState}
                                >
                                  <DragHandle title={t("dragSectionTitle")} />
                                </div>

                                <input
                                  className="w-[240px] max-w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 font-semibold text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
                                  value={g.label == null ? "" : g.label}
                                  onChange={(e) => updateExpenseGroupLabel(g.id, e.target.value)}
                                  onBlur={() => normalizeExpenseGroupLabel(g.id)}
                                  placeholder={t("sectionLabel")}
                                />

                                <div className="hidden md:block text-sm text-neutral-700">
                                  {itemsCount} item{itemsCount === 1 ? "" : "s"} • {t("remainingExpenses")}:{" "}
                                  <span className="font-semibold text-neutral-800">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span>
                                  <span className="text-neutral-400"> • </span>
                                  Planned: <span className="font-medium">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span>
                                </div>
                              </div>

                              <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)} className="whitespace-nowrap px-4 text-xs sm:text-sm" title="Add item">
                                +
                              </SmallButton>
                            </div>

                            {/* ACTIONS TABLE (consistent sizes) */}
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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

                            <div className="md:hidden text-sm text-neutral-700">
                              {itemsCount} item{itemsCount === 1 ? "" : "s"} • {t("remainingExpenses")}:{" "}
                              <span className="font-semibold text-neutral-800">{currencySymbol}{groupRemainingTotal(g).toFixed(2)}</span>
                              <span className="text-neutral-400"> • </span>
                              Planned: <span className="font-medium">{currencySymbol}{groupPlannedTotal(g).toFixed(2)}</span>
                            </div>
                          </div>
                        </div>

                          <div className="p-3 space-y-2">
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

                            {itemsVisible.length === 0 ? (
                              <div className="text-sm text-neutral-700">{t("noItemsSection")}</div>
                            ) : (
                              itemsVisible.map((e, idx) => (
                                <div key={e.id} id={`item-${e.id}`} className={`transition-colors duration-1000 rounded-2xl ${highlightItem === e.id ? "bg-[#D5FF00]/20" : ""}`}>
                                  <div className="grid grid-cols-12 gap-2 items-center p-2 border border-transparent">
                                    <div
                                      className="col-span-1"
                                      draggable
                                      onDragStart={(ev) => setDragPayload({ type: "expense", fromGroupId: g.id, itemId: e.id }, ev)}
                                      onDragEnd={clearDragState}
                                    >
                                      <DragHandle title={t("dragExpenseTitle")} />
                                    </div>

                                    <div className="col-span-1">
                                      <PaidCheck checked={!!e.paid} onChange={(v) => updateExpenseItem(g.id, e.id, { paid: !!v })} />
                                    </div>

                                    <input
                                      className={`col-span-3 rounded-xl border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300 ${
                                        e.paid ? "bg-[#D5FF00]/30 border-transparent line-through text-lime-800 decoration-lime-800" : "bg-white border-neutral-200 text-neutral-800"
                                      }`}
                                      value={e.name || ""}
                                      onChange={(ev) => updateExpenseItem(g.id, e.id, { name: ev.target.value })}
                                      placeholder={t("expenseName")}
                                      onFocus={(ev) => {
                                        try {
                                          ev.target.select();
                                        } catch (err) {
                                          // ignore
                                        }
                                      }}
                                      onClick={(ev) => {
                                        try {
                                          ev.target.select();
                                        } catch (err) {
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
                                            } catch (err) {
                                              // ignore
                                            }
                                            setTimeout(() => setLastAdded(null), 0);
                                          });
                                        }
                                      }}
                                    />

                                    <SelectAllNumberInput
                                      className={`col-span-3 rounded-xl border px-3 py-2 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300 ${
                                        e.paid ? "bg-[#D5FF00]/30 border-transparent line-through text-lime-800 decoration-lime-800" : "bg-white border-neutral-200 text-neutral-800"
                                      }`}
                                      value={e.amount == null ? "0" : e.amount}
                                      onChange={(ev) => updateExpenseItem(g.id, e.id, { amount: ev.target.value })}
                                      inputMode="decimal"
                                      placeholder="0"
                                      title={t("amount")}
                                    />

                                    <div className="col-span-3">
                                      <DuePicker
                                        ym={app.activeMonth}
                                        value={e.dueDay}
                                        onChange={(due) => updateExpenseItem(g.id, e.id, { dueDay: due })}
                                        lang={app.lang}
                                        t={t}
                                      />
                                    </div>

                                    <div className="col-span-1 flex gap-1">
                                      <button
                                        className={`print:hidden h-10 w-10 rounded-xl border shadow-sm flex items-center justify-center transition ${e.note ? "bg-[#D5FF00] border-[#D5FF00] text-neutral-900" : "bg-white border-neutral-200 text-neutral-400 hover:text-neutral-600"}`}
                                        title={t("note")}
                                        onClick={() => setNoteModal({ groupId: g.id, itemId: e.id })}
                                      >
                                        <NoteIcon className="h-4 w-4" />
                                      </button>
                                      <button
                                        className="print:hidden h-10 w-10 rounded-xl border bg-red-50 hover:bg-red-100 text-red-700 border-red-200 shadow-sm flex items-center justify-center"
                                        title={t("removeTitle")}
                                        onClick={() => deleteExpenseItem(g.id, e.id)}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  </div>

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
                                </div>
                              ))
                            )}
                          </div>
                        </div>
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
                      </div>
                    );
                  })}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="text-sm text-neutral-700">{t("noExpenses")}</div>
                  ) : (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-neutral-700">{t("remainingExpenses")}</div>
                        <div className="text-xs text-neutral-600">{t("plannedExpenses")}: {currencySymbol}{expensePlannedTotal.toFixed(2)}</div>
                      </div>
                      <div className="font-semibold text-neutral-800">
                        <Money value={expenseRemainingTotal} currency={app.currency} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Spend Tracker */}
              <SpendTracker active={active} updateMonth={updateMonth} t={t} currencySymbol={currencySymbol} />

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

            <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
              <div className="px-4 py-3 border-b border-neutral-100">
                <div className="font-semibold text-neutral-800">{t("summary")}</div>
              </div>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("totalIncome")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={incomeTotal} currency={app.currency} />
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("totalExpenses")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={expensePlannedTotal} currency={app.currency} />
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("remainingExpenses")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={expenseRemainingTotal} currency={app.currency} />
                </div>
                <div className="text-xs text-neutral-600 mt-2">
                  <div>{t("plannedExpenses")}: {currencySymbol}{expensePlannedTotal.toFixed(2)}</div>
                  <div>{t("paidExpenses")}: {currencySymbol}{expensePaidTotal.toFixed(2)}</div>
                </div>
              </div>

              <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-[#D5FF00]" : "border-red-200"}`}>
                <div className="text-sm text-neutral-700">{t("netRemaining")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={netRemaining} currency={app.currency} />
                </div>
                <div className="text-xs text-neutral-700 mt-2">
                  {t("savingsRate")}: <span className="font-medium">{savingsRate.toFixed(1)}%</span>
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("quickView")}</div>
                <div className="mt-2 text-sm text-neutral-700 space-y-1">
                  <div className="flex items-center justify-between">
                    <span>{t("sections")}</span>
                    <span className="font-medium text-neutral-800">{(active.expenseGroups || []).length}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("expenseItems")}</span>
                    <span className="font-medium text-neutral-800">{(active.expenseGroups || []).reduce((s, gg) => s + (gg.items || []).length, 0)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("unpaidItems")}</span>
                    <span className="font-medium text-neutral-800">{(active.expenseGroups || []).reduce((s, gg) => s + (gg.items || []).filter((it) => !it.paid).length, 0)}</span>
                  </div>
                </div>
              </div>

              <div className="text-xs text-neutral-600">{t("tip")}</div>
            </div>
          </div>
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
