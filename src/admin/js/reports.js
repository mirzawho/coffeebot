/* Reports page: browse orders by date (or a short range).
 * Detail, payment review, edit and lifecycle actions live in the shared
 * OrderDetail sheet — one implementation for this page and the customer
 * profile's orders tab. */
"use strict";

const ReportsPage = (() => {
  const { el, icons, loadingState, errorState, emptyState, moneyWithCurrency, faDigits, jalaliLabel } = Ui;

  let businessDate = null; // today in the cafe's timezone (from /api/admin/me)
  let from = null;
  let to = null;
  let listBox = null; // current DOM container for the order list

  function init(today) {
    businessDate = today;
    from = today;
    to = today;
  }

  function apiPath() {
    if (from && to && from === to) return `/api/admin/orders?businessDate=${from}`;
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return `/api/admin/orders?${qs.toString()}`;
  }

  function filterNote() {
    if (from && to && from === to) return jalaliLabel(from);
    const parts = [];
    if (from) parts.push(`از ${jalaliLabel(from)}`);
    if (to) parts.push(`تا ${jalaliLabel(to)}`);
    return parts.join(" ") || "همه سفارش‌های اخیر";
  }

  function orderRow(o) {
    const payBadge =
      o.paymentStatus === "paid"
        ? el("span", { class: "badge", text: "پرداخت شده" })
        : o.paymentStatus === "rejected"
          ? el("span", { class: "badge off", text: "رسید رد شده" })
          : o.hasReceipt
            ? el("span", { class: "badge info", text: "رسید" })
            : null;
    return el(
      "button",
      {
        class: "row tappable order-row",
        type: "button",
        // Any change inside the sheet (payment, status, edit) refreshes the
        // list behind it so row badges and totals stay in sync.
        onClick: () => OrderDetail.open(o.orderNumber, { onChanged: () => void loadOrders() }),
      },
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title" }, o.orderNumber, payBadge),
        el("div", { class: "row-sub", text: `${o.customerName || "بدون نام"} · ${faDigits(o.time)} · ${o.paymentMethodLabel}` }),
      ),
      el(
        "span",
        { class: "row-end" },
        el("span", { class: "order-total", text: moneyWithCurrency(o.totalAmount, o.currency) }),
        el("span", { class: "chev", html: icons.chevron }),
      ),
    );
  }

  function render(container) {
    container.innerHTML = "";

    const fromInput = el("input", { type: "date", value: from || "", "aria-label": "از تاریخ" });
    const toInput = el("input", { type: "date", value: to || "", "aria-label": "تا تاریخ" });
    const note = el("div", { class: "filter-note", text: filterNote() });

    fromInput.addEventListener("change", () => {
      from = fromInput.value || null;
      if (to && from && from > to) { to = from; toInput.value = to; }
      note.textContent = filterNote();
      void loadOrders();
    });
    toInput.addEventListener("change", () => {
      to = toInput.value || null;
      if (from && to && to < from) { from = to; fromInput.value = from; }
      note.textContent = filterNote();
      void loadOrders();
    });

    const todayBtn = el("button", {
      class: "btn small ghost",
      type: "button",
      text: "امروز",
      onClick: () => {
        from = businessDate;
        to = businessDate;
        fromInput.value = from;
        toInput.value = to;
        note.textContent = filterNote();
        void loadOrders();
      },
    });

    container.appendChild(
      el("div", { class: "card filter-bar" }, fromInput, el("span", { class: "sep", text: "تا" }), toInput, todayBtn),
    );
    container.appendChild(note);

    listBox = el("div", { style: "margin-top:12px" });
    container.appendChild(listBox);
    void loadOrders();
  }

  let loadToken = 0;

  async function loadOrders() {
    const box = listBox;
    if (!box) return;
    const token = ++loadToken;
    box.innerHTML = "";
    box.appendChild(loadingState());
    try {
      const res = await Api.get(apiPath());
      if (token !== loadToken) return; // a newer filter change superseded this load
      const orders = res;
      box.innerHTML = "";
      if (!orders.length) {
        box.appendChild(
          emptyState(
            "سفارشی برای این تاریخ ثبت نشده است",
            "تاریخ دیگری را انتخاب کنید یا با دکمه به‌روزرسانی دوباره تلاش کنید.",
          ),
        );
        return;
      }
      const card = el("div", { class: "card list-card" });
      for (const o of orders) card.appendChild(orderRow(o));
      box.appendChild(card);
    } catch (err) {
      if (token !== loadToken) return;
      box.innerHTML = "";
      box.appendChild(errorState(err.message, () => void loadOrders()));
    }
  }

  /** App-bar refresh: reload the current filter, never reset it. */
  async function refresh() {
    if (!businessDate) return;
    const page = document.getElementById("page-reports");
    render(page);
  }

  return { init, render, refresh };
})();