/* Reports page: browse orders by date (or a short range) with detail dialog. */
"use strict";

const ReportsPage = (() => {
  const { el, icons, openSheet, field, textInput, loadingState, errorState,
    emptyState, moneyWithCurrency, faDigits, jalaliLabel, esc } = Ui;

  let businessDate = null; // today in the cafe's timezone (from /api/admin/me)
  let from = null;
  let to = null;
  let orders = null;
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
      { class: "row tappable order-row", type: "button", onClick: () => openDetail(o) },
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

  /** Payment card: method, status, receipt preview, approve/reject actions. */
  function paymentCard(o, onChanged) {
    const card = el(
      "div",
      { class: "card", style: "padding:12px 14px;margin-bottom:14px" },
      el(
        "div",
        { style: "display:flex;justify-content:space-between;font-weight:700" },
        el("span", { text: "پرداخت" }),
        el("span", { text: o.paymentMethodLabel }),
      ),
      el("div", { style: "font-size:13px;color:var(--muted);margin-top:6px", text: `وضعیت: ${o.paymentLabel}` }),
    );

    if (o.hasReceipt) {
      const img = el("img", {
        src: `/api/admin/orders/${encodeURIComponent(o.orderNumber)}/receipt/image`,
        alt: "تصویر رسید پرداخت",
        loading: "lazy",
        style: "width:100%;border-radius:10px;margin-top:10px;background:var(--surface-2)",
      });
      img.addEventListener("error", () => {
        img.replaceWith(
          el("div", { style: "font-size:12.5px;color:var(--faint);margin-top:10px", text: "پیش‌نمایش رسید در دسترس نیست." }),
        );
      });
      card.appendChild(img);
    }

    // Only card-to-card orders carry a receipt to review; wallet orders are
    // already paid when they are created.
    if (o.paymentMethod === "card_to_card" && o.paymentStatus !== "paid") {
      const actions = el("div", { class: "form-actions", style: "margin-top:12px" });
      const mk = (label, path, cls) => {
        const b = el("button", { class: `btn ${cls}`, type: "button", text: label });
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            await Api.post(path, {});
            toast("انجام شد");
            await onChanged();
          } catch (err) {
            toast(err.message || "انجام نشد", true);
            b.disabled = false;
          }
        });
        return b;
      };
      actions.appendChild(mk("✅ تأیید پرداخت", `/api/admin/orders/${o.orderNumber}/payment/approve`, ""));
      actions.appendChild(mk("❌ رد رسید", `/api/admin/orders/${o.orderNumber}/payment/reject`, "ghost"));
      card.appendChild(actions);
    }
    return card;
  }

  function openDetail(o) {
    const items = el(
      "div",
      { class: "card list-card", style: "margin-bottom:14px" },
      ...o.items.map((it) =>
        el(
          "div",
          { class: "row" },
          el(
            "div",
            { class: "row-main" },
            el("div", { class: "row-title", text: it.variantName ? `${it.productName} — ${it.variantName}` : it.productName }),
            el("div", { class: "row-sub", text: `${faDigits(it.quantity)} × ${faDigits(it.unitPrice)}` }),
          ),
          el("span", { class: "row-end order-total", text: moneyWithCurrency(it.lineTotal, o.currency) }),
        ),
      ),
    );

    const box = el(
      "div",
      {},
      el(
        "div",
        { class: "card", style: "padding:12px 14px;margin-bottom:14px" },
        el("div", { style: "font-weight:700;margin-bottom:4px", text: o.orderNumber }),
        el("div", { style: "font-size:13px;color:var(--muted)", text: `${o.jalaliDate} — ساعت ${faDigits(o.time)}` }),
        el("div", { style: "font-size:13px;color:var(--muted)", text: `مشتری: ${o.customerName || "بدون نام"}` }),
        o.fulfillmentMethod
          ? el("div", {
              style: "font-size:13px;color:var(--muted);margin-top:4px",
              text: `تحویل: ${o.fulfillmentMethodLabel || "—"}${o.deliveryTime ? ` — ${o.deliveryTime}` : ""}`,
            })
          : null,
        el("span", { class: "badge warn", text: o.statusLabel, style: "margin-top:6px" }),
      ),
      el("div", { class: "field-label", text: "اقلام سفارش" }),
      items,
      el(
        "div",
        { class: "card", style: "padding:12px 14px" },
        el(
          "div",
          { style: "display:flex;justify-content:space-between;font-weight:700" },
          el("span", { text: "جمع کل" }),
          el("span", { text: moneyWithCurrency(o.totalAmount, o.currency) }),
        ),
        o.deliveryNotes
          ? el("div", { style: "font-size:13px;color:var(--muted);margin-top:8px", text: `یادداشت تحویل: ${o.deliveryNotes}` })
          : null,
      ),
      paymentCard(o, async () => {
        openSheet("جزئیات سفارش", await reloadDetail(o));
      }),
    );

    // Lifecycle actions — server validates every transition; buttons disable
    // while a request is pending to prevent duplicate submissions.
    const actions = el("div", { class: "form-actions" });
    const mkAction = (label, path, cls) => {
      const b = el("button", { class: `btn ${cls}`, type: "button", text: label });
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await Api.post(path, {});
          toast("انجام شد");
          openSheet("جزئیات سفارش", await reloadDetail(o));
        } catch (err) {
          toast(err.message || "انجام نشد", true);
          b.disabled = false;
        }
      });
      return b;
    };
    if (o.fulfillmentStatus === "pending") {
      actions.appendChild(mkAction("✅ تأیید سفارش", `/api/admin/orders/${o.orderNumber}/confirm`, ""));
    } else if (o.fulfillmentStatus === "confirmed") {
      actions.appendChild(mkAction("📦 تحویل داده شد", `/api/admin/orders/${o.orderNumber}/deliver`, ""));
    }
    if (actions.childElementCount > 0) box.appendChild(actions);
    openSheet("جزئیات سفارش", box);
  }

  /** Re-fetch the order by number and rebuild the detail sheet. */
  async function reloadDetail(o) {
    const list = await Api.get(`/api/admin/orders?businessDate=${o.businessDate}`);
    const fresh = (list || []).find((x) => x.orderNumber === o.orderNumber) || o;
    const items = el(
      "div",
      { class: "card list-card", style: "margin-bottom:14px" },
      ...fresh.items.map((it) =>
        el(
          "div",
          { class: "row" },
          el(
            "div",
            { class: "row-main" },
            el("div", { class: "row-title", text: it.variantName ? `${it.productName} — ${it.variantName}` : it.productName }),
            el("div", { class: "row-sub", text: `${faDigits(it.quantity)} × ${faDigits(it.unitPrice)}` }),
          ),
          el("span", { class: "row-end order-total", text: moneyWithCurrency(it.lineTotal, fresh.currency) }),
        ),
      ),
    );
    const box = el(
      "div",
      {},
      el(
        "div",
        { class: "card", style: "padding:12px 14px;margin-bottom:14px" },
        el("div", { style: "font-weight:700;margin-bottom:4px", text: fresh.orderNumber }),
        el("div", { style: "font-size:13px;color:var(--muted)", text: `${fresh.jalaliDate} — ساعت ${faDigits(fresh.time)}` }),
        el("div", { style: "font-size:13px;color:var(--muted)", text: `مشتری: ${fresh.customerName || "بدون نام"}` }),
        fresh.fulfillmentMethod
          ? el("div", {
              style: "font-size:13px;color:var(--muted);margin-top:4px",
              text: `تحویل: ${fresh.fulfillmentMethodLabel || "—"}${fresh.deliveryTime ? ` — ${fresh.deliveryTime}` : ""}`,
            })
          : null,
        el("span", { class: "badge warn", text: fresh.statusLabel, style: "margin-top:6px" }),
      ),
      el("div", { class: "field-label", text: "اقلام سفارش" }),
      items,
      el(
        "div",
        { class: "card", style: "padding:12px 14px" },
        el(
          "div",
          { style: "display:flex;justify-content:space-between;font-weight:700" },
          el("span", { text: "جمع کل" }),
          el("span", { text: moneyWithCurrency(fresh.totalAmount, fresh.currency) }),
        ),
      ),
      paymentCard(fresh, async () => {
        openSheet("جزئیات سفارش", await reloadDetail(fresh));
      }),
    );
    return box;
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
      orders = res;
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
