/* Shared UI helpers for the admin Mini App: formatting, icons, sheets, states. */
"use strict";

const Ui = (() => {
  // ---------- formatting ----------

  const faFormatter = new Intl.NumberFormat("fa-IR");
  const faDateFormatter = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  /** Persian digits for arbitrary strings ("12:30" → "۱۲:۳۰"). */
  function faDigits(s) {
    return String(s).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
  }

  /** Money with Persian digits and grouping: 80000 → "۸۰٬۰۰۰". */
  function money(amount) {
    return faFormatter.format(Number(amount || 0));
  }

  /** "۸۰٬۰۰۰ تومان" */
  function moneyWithCurrency(amount, currency) {
    return `${money(amount)} ${currency}`;
  }

  /** Gregorian YYYY-MM-DD as a Persian Jalali date label (native Intl calendar). */
  function jalaliLabel(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
    return faDateFormatter.format(new Date(`${dateStr}T00:00:00Z`));
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ---------- icons (inline SVG, currentColor) ----------

  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const icons = {
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    chart: svg('<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>'),
    cup: svg('<path d="M17 8h1a3 3 0 0 1 0 6h-1"/><path d="M3 8h14v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V8z"/><path d="M6 2v2"/><path d="M10 2v2"/><path d="M14 2v2"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
    report: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>'),
    pencil: svg('<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'),
    chevron: svg('<path d="M15 18l-6-6 6-6"/>'),
    close: svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>'),
    image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
    check: svg('<path d="M20 6L9 17l-5-5"/>'),
    slash: svg('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  };

  // ---------- toast ----------

  let toastTimer = null;

  function toast(msg, isError) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2800);
  }

  // ---------- bottom sheet ----------

  const sheetRoot = () => document.getElementById("sheet-root");
  let onSheetClose = null;

  /** Replace the sheet content; pass a DOM element for the body. */
  function openSheet(title, bodyEl, opts = {}) {
    document.getElementById("sheet-title").textContent = title;
    const body = document.getElementById("sheet-body");
    body.innerHTML = "";
    body.appendChild(bodyEl);
    onSheetClose = opts.onClose || null;
    sheetRoot().hidden = false;
    const first = bodyEl.querySelector("input, select, textarea");
    if (first) setTimeout(() => first.focus(), 60);
  }

  function closeSheet() {
    sheetRoot().hidden = true;
    const cb = onSheetClose;
    onSheetClose = null;
    if (cb) cb();
  }

  function initChrome() {
    document.getElementById("btn-refresh").innerHTML = icons.refresh;
    document.getElementById("btn-create").innerHTML = icons.plus;
    document.getElementById("sheet-close").innerHTML = icons.close;
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    document.getElementById("sheet-backdrop").addEventListener("click", closeSheet);
  }

  // ---------- DOM builder ----------

  /** el("div", { class: "x", onClick: fn }, child1, "text", ...) */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ---------- page states ----------

  function loadingState() {
    return el("div", { class: "spinner", role: "status", "aria-label": "در حال بارگذاری" });
  }

  function emptyState(title, hint, action) {
    return el(
      "div",
      { class: "empty-state" },
      el("div", { class: "empty-title", text: title }),
      hint ? el("div", { class: "empty-hint", text: hint }) : null,
      action
        ? el("button", { class: "btn small", type: "button", onClick: action.onClick }, action.label)
        : null,
    );
  }

  function errorState(message, onRetry) {
    return el(
      "div",
      { class: "error-state" },
      el("div", { class: "empty-title", text: "خطا در دریافت اطلاعات" }),
      el("div", { class: "empty-hint", text: message || "ارتباط با سرور برقرار نشد." }),
      onRetry ? el("button", { class: "btn small secondary", type: "button", onClick: onRetry }, "تلاش دوباره") : null,
    );
  }

  // ---------- form helpers ----------

  /** A labeled form field with error slot. Returns { root, input, setError(msg) }. */
  function field(label, inputEl, { required, hint } = {}) {
    const error = el("div", { class: "field-error" });
    error.hidden = true;
    const root = el(
      "div",
      { class: "field" },
      el(
        "label",
        {},
        label,
        required ? el("span", { class: "req", text: " *" }) : null,
        inputEl,
      ),
      hint ? el("div", { class: "field-hint", text: hint }) : null,
      error,
    );
    return {
      root,
      input: inputEl,
      setError(msg) {
        if (msg) {
          error.textContent = msg;
          error.hidden = false;
          root.classList.add("invalid");
        } else {
          error.hidden = true;
          root.classList.remove("invalid");
        }
      },
    };
  }

  function textInput(value, attrs = {}) {
    return el("input", { type: "text", value: value ?? "", ...attrs });
  }

  /** Numeric text input that keeps Persian/typing friendly; parseDigits on save. */
  function numberInput(value, attrs = {}) {
    return el("input", {
      type: "text",
      inputmode: "numeric",
      value: value == null ? "" : String(value),
      ...attrs,
    });
  }

  /** Strip separators and convert Persian/Arabic digits to Latin digits. */
  function parseDigits(raw) {
    const s = String(raw ?? "")
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/[,\s٬]/g, "");
    return s;
  }

  /** Label + switch toggle. Returns { root, input }. */
  function switchInput(checked) {
    const input = el("input", { type: "checkbox" });
    input.checked = !!checked;
    const root = el("label", { class: "switch" }, input, el("span", { class: "track" }));
    return { root, input };
  }

  /** Two-option segmented control. Returns { root, value(), set(v) }. */
  function segmented(options, value) {
    let current = value;
    const buttons = options.map((opt) =>
      el(
        "button",
        {
          type: "button",
          class: `seg-btn${opt.value === current ? ` active ${opt.cls || ""}` : ""}`,
          onClick: () => set(opt.value),
        },
        opt.icon ? el("span", { html: opt.icon, class: "seg-icon" }) : null,
        opt.label,
      ),
    );
    function set(v) {
      current = v;
      buttons.forEach((b, i) => {
        b.className = `seg-btn${options[i].value === v ? ` active ${options[i].cls || ""}` : ""}`;
      });
    }
    const root = el("div", { class: "segmented", role: "group" }, buttons);
    return { root, value: () => current, set };
  }

  return {
    faDigits,
    money,
    moneyWithCurrency,
    jalaliLabel,
    esc,
    icons,
    toast,
    openSheet,
    closeSheet,
    initChrome,
    el,
    loadingState,
    emptyState,
    errorState,
    field,
    textInput,
    numberInput,
    parseDigits,
    switchInput,
    segmented,
  };
})();
