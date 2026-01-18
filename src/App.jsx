import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
      ? "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200 shadow-sm"
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
      ? "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200"
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
      ? "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200"
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
      ? "bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-700 border-neutral-200"
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

function Money({ value }) {
  const v = Number(value) || 0;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return (
    <span className="tabular-nums">
      {sign}€{abs.toFixed(2)}
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
        className="h-4 w-4 accent-lime-500"
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
      className={`print:hidden h-2 rounded-xl transition ${active ? "bg-lime-200" : "bg-transparent"}`}
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-100 flex items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-neutral-800">{t("helpTitle")}</div>
            <div className="text-sm text-neutral-700 mt-1">{t("helpSubtitle")}</div>
            <div className="mt-3 h-[2px] w-56 rounded-full bg-gradient-to-r from-lime-400/0 via-lime-400 to-emerald-400/0" />
          </div>
          <button
            type="button"
            className="px-3 py-2 rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-neutral-800 transition"
            onClick={onClose}
          >
            {t("close")}
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("autosave")}</div>
            <div className="text-sm text-neutral-700 mt-1">
              {t("autosaveDesc")}
              <span className="ml-2 font-mono text-xs bg-neutral-50 border border-neutral-200 rounded-lg px-2 py-1">{LS_KEY}</span>
            </div>
            <div className="text-xs text-neutral-600 mt-2">{t("autosaveWarn")}</div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("bestPractice")}</div>
            <ul className="mt-2 space-y-2 text-sm text-neutral-700 list-disc pl-5">
              <li>
                {t("bp1")} <span className="font-semibold">{t("data")}</span> {t("bp1b")}
              </li>
              <li>{t("bp2")}</li>
              <li>
                {t("bp3")} <span className="font-semibold">{t("import")}</span> {t("bp3b")}
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("reordering")}</div>
            <div className="text-sm text-neutral-700 mt-1">
              {t("reorderingDesc")} <span className="font-semibold">⋮⋮</span> {t("reorderingDesc2")}
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("paidItems")}</div>
            <div className="text-sm text-neutral-700 mt-1">{t("paidItemsDesc")}</div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("printing")}</div>
            <div className="text-sm text-neutral-700 mt-1">
              {t("printingDesc")} <span className="font-semibold">{t("preview")}</span> {t("printingDesc2")} <span className="font-semibold">{t("printSave")}</span> {t("printingDesc3")}
            </div>
          </div>

          <div className="rounded-2xl border border-neutral-200 p-4">
            <div className="font-semibold text-neutral-800">{t("privacy")}</div>
            <div className="text-sm text-neutral-700 mt-1">{t("privacyDesc")}</div>
          </div>
        </div>

        <div className="p-4 border-t border-neutral-100 text-xs text-neutral-600">{t("footer")}</div>
      </div>
    </div>
  );
}

function ExportModal({ open, onClose, onPreview, onPrint, onBackup, onImport, t }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 print:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white border border-neutral-200 shadow-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-100 flex items-center justify-between">
          <div className="text-lg font-semibold text-neutral-800">{t("exportTitle")}</div>
          <button
            type="button"
            className="h-8 w-8 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 flex items-center justify-center text-neutral-600 transition"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="p-4 space-y-2">
          <button
            className="w-full text-left px-4 py-3 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 transition flex items-center justify-between group"
            onClick={() => {
              onClose();
              onPreview();
            }}
          >
            <span className="font-medium">{t("preview")}</span>
            <span className="text-neutral-400 group-hover:text-neutral-600">→</span>
          </button>
          <button
            className="w-full text-left px-4 py-3 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 transition flex items-center justify-between group"
            onClick={() => {
              onClose();
              onPrint();
            }}
          >
            <span className="font-medium">{t("printSave")}</span>
            <span className="text-neutral-400 group-hover:text-neutral-600">→</span>
          </button>
          <button
            className="w-full text-left px-4 py-3 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 transition flex items-center justify-between group"
            onClick={() => {
              onClose();
              onBackup();
            }}
          >
            <span className="font-medium">{t("backup")}</span>
            <span className="text-neutral-400 group-hover:text-neutral-600">→</span>
          </button>
          <label className="w-full text-left px-4 py-3 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 transition flex items-center justify-between group cursor-pointer">
            <span className="font-medium">{t("import")}</span>
            <span className="text-neutral-400 group-hover:text-neutral-600">→</span>
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
                if (file) {
                  onClose();
                  onImport(file);
                }
              }}
            />
          </label>
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
});

// Migration:
// - Legacy: { expenses: [] }
// - New: { expenseGroups: [{ id, label, items: [] }] }
function normalizeMonthData(monthData) {
  const m = monthData || { incomes: [], expenses: [], notes: "" };

  const incomes = Array.isArray(m.incomes) ? m.incomes.map(normalizeIncomeItem) : [];

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
    };
  }

  const legacyExpenses = Array.isArray(m.expenses) ? m.expenses.map(normalizeExpenseItem) : [];
  return {
    incomes,
    expenseGroups: [{ id: uid(), label: "General", items: legacyExpenses }],
    notes: typeof m.notes === "string" ? m.notes : "",
  };
}

const TRANSLATIONS = {
  en: {
    subtitle: "Monthly personal budgeting tool",
    hub: "HUB",
    preview: "Preview",
    data: "Data",
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
    expenses: "Expenses",
    addSection: "+ Add section",
    hidePaid: "Hide paid",
    showPaid: "Show paid",
    expandAll: "Expand all",
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
    exportTitle: "Data",
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
    printing: "Printing / PDF",
    printingDesc: "Use",
    printingDesc2: "to check the layout, then",
    printingDesc3: "and choose “Save as PDF”.",
    privacy: "Privacy",
    privacyDesc: "Budgit runs in your browser. There’s no account system here yet, and nothing is uploaded unless you choose to share your exported file.",
    footer: "ToolStack • Help Pack v1",
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
    copyNextTitle: "Copy this month to next",
    clearMonthTitle: "Clear this month",
    prevMonthTitle: "Previous month",
    nextMonthTitle: "Next month",
    yearTitle: "Year",
    monthTitle: "Month",
    dragIncomeTitle: "Drag income item",
    removeTitle: "Remove",
    sortDueTitle: "Sort by due day (earliest first)",
    clearPaidTitle: "Remove all PAID items in this section",
    clearItemsTitle: "Clear ALL items in this section",
    deleteSectionTitle: "Delete this section and all its items",
    dragExpenseTitle: "Drag expense item",
    closeTitle: "Close",
    clearDueTitle: "Clear due date",
    setDueTitle: "Set due: {d}",
  },
  de: {
    subtitle: "Monatliches persönliches Budgetierungstool",
    hub: "HUB",
    preview: "Vorschau",
    data: "Daten",
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
    expenses: "Ausgaben",
    addSection: "+ Abschnitt",
    hidePaid: "Bezahlte ausblenden",
    showPaid: "Bezahlte anzeigen",
    expandAll: "Alle erweitern",
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
    exportTitle: "Daten",
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
    printing: "Drucken / PDF",
    printingDesc: "Verwenden Sie",
    printingDesc2: "um das Layout zu überprüfen, dann",
    printingDesc3: "und wählen Sie „Als PDF speichern“.",
    privacy: "Datenschutz",
    privacyDesc: "Budgit läuft in Ihrem Browser. Es gibt hier noch kein Kontosystem, und nichts wird hochgeladen, es sei denn, Sie entscheiden sich, Ihre exportierte Datei zu teilen.",
    footer: "ToolStack • Help Pack v1",
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
    copyNextTitle: "Diesen Monat in den nächsten kopieren",
    clearMonthTitle: "Diesen Monat leeren",
    prevMonthTitle: "Vorheriger Monat",
    nextMonthTitle: "Nächster Monat",
    yearTitle: "Jahr",
    monthTitle: "Monat",
    dragIncomeTitle: "Einkommenselement ziehen",
    removeTitle: "Entfernen",
    sortDueTitle: "Nach Fälligkeit sortieren (früheste zuerst)",
    clearPaidTitle: "Alle BEZAHLTEN Elemente in diesem Abschnitt entfernen",
    clearItemsTitle: "ALLE Elemente in diesem Abschnitt leeren",
    deleteSectionTitle: "Diesen Abschnitt und alle seine Elemente löschen",
    dragExpenseTitle: "Ausgabenelement ziehen",
    closeTitle: "Schließen",
    clearDueTitle: "Fälligkeitsdatum löschen",
    setDueTitle: "Fällig setzen: {d}",
  }
};

// ---------------------------
// App
// ---------------------------

export default function BudgitApp() {
  const [app, setApp] = useState(() => {
    const base = {
      activeMonth: monthKey(),
      months: {},
      lang: "en",
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
    return data;
  });

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Collapsed expense groups (UI-only)
  const [collapsed, setCollapsed] = useState(() => ({}));

  // Hide paid items (UI-only)
  const [hidePaid, setHidePaid] = useState(true);

  // Drag state (UI-only)
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);

  // Copy month menu
  const [copyOpen, setCopyOpen] = useState(false);

  // Auto-focus newly added items so you can type immediately over default values.
  const [lastAdded, setLastAdded] = useState(null);

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
    setCollapsed((c) => ({ ...c, [newId]: false }));
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

    setCollapsed((c) => {
      const n = { ...(c || {}) };
      delete n[groupId];
      return n;
    });
  };

  const addExpenseItem = (groupId) => {
    const item = { id: uid(), name: t("expense"), amount: "0", dueDay: null, paid: false };
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => (g.id === groupId ? { ...g, items: [item, ...(g.items || [])] } : g)),
    }));
    setCollapsed((c) => ({ ...c, [groupId]: false }));
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

    setCollapsed((c) => ({ ...c, [toGroupId]: false }));
  };

  const clearPaidInGroup = (groupId) => {
    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, items: (g.items || []).filter((it) => !it.paid) };
      }),
    }));
  };

  const clearGroupItems = (groupId) => {
    const g = (active.expenseGroups || []).find((x) => x.id === groupId);
    const name = String((g && g.label) || "this section").trim();
    const ok = window.confirm(t("clearItemsConfirm", { name }));
    if (!ok) return;

    updateMonth((cur) => ({
      ...cur,
      expenseGroups: (cur.expenseGroups || []).map((g2) => (g2.id === groupId ? { ...g2, items: [] } : g2)),
    }));
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
    setCollapsed({});
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
    setCollapsed({});
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
    setDrag(payload);
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

  const netRemaining = useMemo(() => incomeTotal - expenseRemainingTotal, [incomeTotal, expenseRemainingTotal]);

  const savingsRate = useMemo(() => {
    if (!incomeTotal) return 0;
    return (netRemaining / incomeTotal) * 100;
  }, [netRemaining, incomeTotal]);

  // ---------------------------
  // Notes
  // ---------------------------

  const updateNotes = (notes) => {
    updateMonth((cur) => ({ ...cur, notes }));
  };

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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <div className="absolute inset-0 bg-black/40" onClick={() => setPreviewOpen(false)} />

          <div className="relative w-full max-w-4xl">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-lg font-semibold text-white">{t("printPreview")}</div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-2 rounded-xl text-sm font-medium border border-white/40 bg-white/10 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-white transition"
                  onClick={() => window.print()}
                >
                  {t("printSave")}
                </button>
                <button
                  className="px-3 py-2 rounded-xl text-sm font-medium border border-white/40 bg-white/10 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 text-white transition"
                  onClick={() => setPreviewOpen(false)}
                >
                  {t("close")}
                </button>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-neutral-200 shadow-lg overflow-auto max-h-[80vh]">
              <div id="budgit-print-preview" className="p-6">
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
                              <Money value={toNumber(i.amount)} />
                            </div>
                          </div>
                        ))
                      )}
                      <div className="pt-3 mt-3 border-t border-neutral-100 flex items-center justify-between">
                        <div className="font-semibold text-neutral-800">{t("totalIncome")}</div>
                        <div className="font-semibold text-neutral-800">
                          <Money value={incomeTotal} />
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
                                {t("remainingExpenses")}: <span className="font-semibold text-neutral-800">€{groupRemainingTotal(g).toFixed(2)}</span>
                                <span className="text-neutral-400"> • </span>
                                Planned: <span className="font-medium">€{groupPlannedTotal(g).toFixed(2)}</span>
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
                                        <Money value={toNumber(e.amount)} />
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
                          <div className="text-xs text-neutral-600">{t("plannedExpenses")}: €{expensePlannedTotal.toFixed(2)}</div>
                        </div>
                        <div className="font-semibold text-neutral-800">
                          <Money value={expenseRemainingTotal} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                    <div className="text-sm text-neutral-700">{t("netRemaining")}</div>
                    <div className="text-2xl font-semibold text-neutral-800 mt-1">
                      <Money value={netRemaining} />
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

                <div className="mt-4 text-xs text-neutral-600">{t("previewTip")}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {/* Master heading style */}
            <div className="text-4xl sm:text-5xl font-black tracking-tight text-neutral-800">
              <span>Budg</span>
              <span className="text-neutral-800">It</span>
            </div>
            <div className="text-sm text-neutral-700">{t("subtitle")}</div>
            <div className="mt-3 h-[2px] w-80 rounded-full bg-gradient-to-r from-[#D5FF00]/0 via-[#D5FF00] to-[#D5FF00]/0" />

            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => setLang("en")}
                className={`text-xs font-medium px-2 py-1 rounded-lg transition ${app.lang === "en" ? "bg-neutral-200 text-neutral-800" : "text-neutral-500 hover:text-neutral-700"}`}
              >
                EN
              </button>
              <button
                onClick={() => setLang("de")}
                className={`text-xs font-medium px-2 py-1 rounded-lg transition ${app.lang === "de" ? "bg-neutral-200 text-neutral-800" : "text-neutral-500 hover:text-neutral-700"}`}
              >
                DE
              </button>
            </div>
          </div>

          <div className="w-full sm:w-[520px] lg:w-[620px]">
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
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
            <div className="px-4 py-3 border-b border-neutral-100">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="font-semibold text-neutral-800">{t("month")}</div>

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
                    className="print:hidden h-10 w-full rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm px-3 text-neutral-700"
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
                    className="print:hidden h-10 w-full rounded-xl text-sm font-medium border border-neutral-200 bg-white hover:bg-neutral-50 shadow-sm px-3 text-neutral-700"
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
                  <div className="text-3xl sm:text-4xl font-black tracking-tight text-neutral-800">{monthLabel(app.activeMonth, app.lang)}</div>
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
                            className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 px-3 text-neutral-700"
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
                        <Money value={incomeTotal} />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Expenses */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="font-semibold text-neutral-800">{t("expenses")}</div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 w-full sm:w-auto">
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
                    <MiniActionButton onClick={() => setCollapsed({})} title={t("expandAllTitle")}>
                      {t("expandAll")}
                    </MiniActionButton>
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {(active.expenseGroups || []).map((g) => {
                    const isCollapsed = !!collapsed[g.id];
                    const allItems = g.items || [];
                    const itemsVisible = hidePaid ? allItems.filter((it) => !it.paid) : allItems;
                    const itemsCount = allItems.length;

                    return (
                      <div key={g.id} className="rounded-2xl border border-neutral-200 overflow-hidden">
                        <div className="px-3 py-3 border-b border-neutral-100">
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="print:hidden h-10 w-10 rounded-xl border border-neutral-200 bg-white hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 shadow-sm flex items-center justify-center text-neutral-700"
                                  title={isCollapsed ? "Expand" : "Collapse"}
                                  onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
                                >
                                  <span className="text-lg leading-none">{isCollapsed ? "▸" : "▾"}</span>
                                </button>

                                <input
                                  className="w-[240px] max-w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 font-semibold text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
                                  value={g.label == null ? "" : g.label}
                                  onChange={(e) => updateExpenseGroupLabel(g.id, e.target.value)}
                                  onBlur={() => normalizeExpenseGroupLabel(g.id)}
                                  placeholder={t("sectionLabel")}
                                />

                                <div className="hidden md:block text-sm text-neutral-700">
                                  {itemsCount} item{itemsCount === 1 ? "" : "s"} • {t("remainingExpenses")}:{" "}
                                  <span className="font-semibold text-neutral-800">€{groupRemainingTotal(g).toFixed(2)}</span>
                                  <span className="text-neutral-400"> • </span>
                                  Planned: <span className="font-medium">€{groupPlannedTotal(g).toFixed(2)}</span>
                                </div>
                              </div>

                              <SmallButton tone="primary" onClick={() => addExpenseItem(g.id)} className="whitespace-nowrap px-4 text-xs sm:text-sm" title="Add item">
                                +
                              </SmallButton>
                            </div>

                            {/* ACTIONS TABLE (consistent sizes) */}
                            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
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

                              <MiniActionButton title={t("clearPaidTitle")} onClick={() => clearPaidInGroup(g.id)}>
                                {t("clearPaid")}
                              </MiniActionButton>

                              <MiniActionButton tone="danger" title={t("clearItemsTitle")} onClick={() => clearGroupItems(g.id)}>
                                {t("clearItems")}
                              </MiniActionButton>

                              <MiniActionButton tone="danger" title={t("deleteSectionTitle")} onClick={() => deleteExpenseGroup(g.id)}>
                                {t("deleteSection")}
                              </MiniActionButton>
                            </div>

                            <div className="md:hidden text-sm text-neutral-700">
                              {itemsCount} item{itemsCount === 1 ? "" : "s"} • {t("remainingExpenses")}:{" "}
                              <span className="font-semibold text-neutral-800">€{groupRemainingTotal(g).toFixed(2)}</span>
                              <span className="text-neutral-400"> • </span>
                              Planned: <span className="font-medium">€{groupPlannedTotal(g).toFixed(2)}</span>
                            </div>
                          </div>
                        </div>

                        {!isCollapsed ? (
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
                                <div key={e.id}>
                                  <div className="grid grid-cols-12 gap-2 items-center rounded-2xl p-2 border border-transparent">
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
                                      className={`col-span-3 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300 ${
                                        e.paid ? "line-through text-neutral-600" : ""
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
                                      className="col-span-3 rounded-xl border border-neutral-200 px-3 py-2 bg-white text-right text-neutral-800 tabular-nums focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
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

                                    <button
                                      className="print:hidden col-span-1 h-10 rounded-xl border border-neutral-200 bg-neutral-50 hover:bg-[#D5FF00]/30 hover:border-[#D5FF00]/30 hover:text-neutral-800 px-3 text-neutral-700"
                                      title={t("removeTitle")}
                                      onClick={() => deleteExpenseItem(g.id, e.id)}
                                    >
                                      ×
                                    </button>
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
                        ) : (
                          <div
                            className="p-3 text-sm text-neutral-700"
                            onDragOver={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "expense") return;
                              e.preventDefault();
                              setDropHint({ type: "expenseInsert", groupId: g.id, index: (g.items || []).length });
                            }}
                            onDrop={(e) => {
                              const p = readDragPayload(e);
                              if (!p || p.type !== "expense") return;
                              e.preventDefault();
                              moveExpenseInsert(p.fromGroupId, p.itemId, g.id, (g.items || []).length);
                              clearDragState();
                            }}
                          >
                            {t("collapsedDrop")}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {(active.expenseGroups || []).length === 0 ? (
                    <div className="text-sm text-neutral-700">{t("noExpenses")}</div>
                  ) : (
                    <div className="pt-3 mt-2 border-t border-neutral-100 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-neutral-700">{t("remainingExpenses")}</div>
                        <div className="text-xs text-neutral-600">{t("plannedExpenses")}: €{expensePlannedTotal.toFixed(2)}</div>
                      </div>
                      <div className="font-semibold text-neutral-800">
                        <Money value={expenseRemainingTotal} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div className="rounded-2xl border border-neutral-200 bg-white">
                <div className="px-4 py-3 border-b border-neutral-100">
                  <div className="font-semibold text-neutral-800">{t("notes")}</div>
                </div>
                <div className="p-4">
                  <textarea
                    className="w-full rounded-xl border border-neutral-200 px-3 py-2 bg-white min-h-[90px] text-neutral-800 focus:outline-none focus:ring-2 focus:ring-lime-400/25 focus:border-neutral-300"
                    value={active.notes || ""}
                    onChange={(e) => updateNotes(e.target.value)}
                    placeholder={t("notesPlaceholder")}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-2xl bg-white shadow-sm border border-neutral-200 print:shadow-none">
            <div className="px-4 py-3 border-b border-neutral-100">
              <div className="font-semibold text-neutral-800">{t("summary")}</div>
            </div>
            <div className="p-4 space-y-4">
              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("totalIncome")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={incomeTotal} />
                </div>
              </div>

              <div className="rounded-2xl border border-neutral-200 p-4">
                <div className="text-sm text-neutral-700">{t("remainingExpenses")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={expenseRemainingTotal} />
                </div>
                <div className="text-xs text-neutral-600 mt-2">{t("plannedExpenses")}: €{expensePlannedTotal.toFixed(2)}</div>
              </div>

              <div className={`rounded-2xl border p-4 ${netRemaining >= 0 ? "border-emerald-200" : "border-red-200"}`}>
                <div className="text-sm text-neutral-700">{t("netRemaining")}</div>
                <div className="text-2xl font-semibold text-neutral-800 mt-1">
                  <Money value={netRemaining} />
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

        {toast ? (
          <div className="fixed bottom-6 right-6 rounded-2xl bg-neutral-800 text-white px-4 py-3 shadow-xl print:hidden">
            <div className="text-sm">{toast}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
