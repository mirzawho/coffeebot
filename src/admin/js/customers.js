/* Customers page: directory list + per-customer profile, wallet, orders. */
"use strict";

const CustomersPage = (() => {
  const { el, icons, toast, openSheet, closeSheet, loadingState, errorState, emptyState,
    moneyWithCurrency, faDigits, esc } = Ui;

  let currency = "تومان";
  let rows = [];
  let query = "";
  let membershipFilter = ""; // "" | "member" | "not_member" | "unknown" | "none"
  let listBox = null;
  // Transactions tab filters (shared across profile opens, like query).
  let txType = "all"; // all | wallet_in | wallet_out | card
  let txFrom = ""; // YYYY-MM-DD
  let txTo = ""; // YYYY-MM-DD

  function setData(cur) {
    currency = cur || "تومان";
  }

  // ---------- membership helpers ----------

  const MEMBERSHIP_BADGE = {
    member: { cls: "badge", text: "عضو کانال" },
    not_member: { cls: "badge off", text: "عضو نیست" },
    unknown: { cls: "badge warn", text: "بررسی ناموفق" },
  };

  function membershipBadge(m) {
    if (!m) return null;
    const b = MEMBERSHIP_BADGE[m.status] || { cls: "badge", text: m.statusLabel || "—" };
    return el("span", { class: b.cls, text: b.text });
  }

  // ---------- list ----------

  function customerRow(c) {
    const name = c.name || "بدون نام";
    const avatar = c.name
      ? el("div", { class: "profile-avatar", style: "width:44px;height:44px;font-size:17px", text: c.name.trim().charAt(0) })
      : el("div", { class: "profile-avatar", style: "width:44px;height:44px;font-size:15px", html: icons.users });
    const sub = [
      c.username ? `@${c.username}` : null,
      c.phone ? Ui.faDigits(c.phone) : null,
      `${faDigits(c.orderCount)} سفارش`,
      c.lastActiveAt ? `آخرین فعالیت ${Ui.jalaliLabel(c.lastActiveAt.slice(0, 10))}` : null,
    ].filter(Boolean).join(" · ");
    return el(
      "button",
      { class: "row tappable", type: "button", onClick: () => openDetail(c.id) },
      avatar,
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title" },
          name,
          c.membership ? el("span", { style: "margin-inline-start:6px" }, membershipBadge(c.membership)) : null),
        el("div", { class: "row-sub", text: sub }),
      ),
      el(
        "span",
        { class: "row-end" },
        el("span", { class: "badge info", text: moneyWithCurrency(c.balance, currency) }),
        el("span", { class: "chev", html: icons.chevron }),
      ),
    );
  }

  const MEMBERSHIP_FILTERS = [
    { value: "", label: "همه" },
    { value: "member", label: "عضو" },
    { value: "not_member", label: "غیرعضو" },
    { value: "unknown", label: "نامشخص" },
    { value: "none", label: "بررسی‌نشده" },
  ];

  function render(container) {
    container.innerHTML = "";

    const search = el("input", {
      type: "text",
      value: query,
      placeholder: "جستجوی نام، @یوزرنیم یا شماره تماس…",
      "aria-label": "جستجوی مشتری",
    });
    search.addEventListener("input", () => {
      query = search.value.trim();
      void loadList();
    });
    const searchWrap = el(
      "div",
      { class: "search-wrap" },
      el("span", { class: "search-icon", html: icons.search }),
      search,
    );
    const filterSeg = Ui.segmented(
      MEMBERSHIP_FILTERS.map((f) => ({ value: f.value, label: f.label })),
      membershipFilter,
    );
    filterSeg.root.querySelectorAll("button").forEach((b, i) => {
      b.addEventListener("click", () => {
        membershipFilter = MEMBERSHIP_FILTERS[i].value;
        void loadList();
      });
    });
    container.appendChild(el("div", { class: "card filter-bar" }, searchWrap,
      el("div", { style: "margin-top:8px;width:100%" }, filterSeg.root)));

    listBox = el("div", { style: "margin-top:12px" });
    container.appendChild(listBox);
    void loadList();
  }

  let loadToken = 0;

  async function loadList() {
    const box = listBox;
    if (!box) return;
    const token = ++loadToken;
    box.innerHTML = "";
    box.appendChild(loadingState());
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (membershipFilter) params.set("membership", membershipFilter);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await Api.get(`/api/admin/customers${qs}`);
      if (token !== loadToken) return;
      rows = res;
      box.innerHTML = "";
      if (!rows.length) {
        box.appendChild(
          query
            ? emptyState("مشتری‌ای با این جستجو پیدا نشد", "نام یا شماره تماس دیگری را امتحان کنید.")
            : emptyState("هنوز مشتری‌ای ثبت نشده است", "مشتریان پس از اولین سفارش یا ثبت پروفایل اینجا نمایش داده می‌شوند."),
        );
        return;
      }
      const card = el("div", { class: "card list-card" });
      for (const c of rows) card.appendChild(customerRow(c));
      box.appendChild(card);
    } catch (err) {
      if (token !== loadToken) return;
      box.innerHTML = "";
      box.appendChild(errorState(err.message, () => void loadList()));
    }
  }

  // ---------- detail ----------

  const DEPOSIT_STATUS_LABELS = {
    pending: "در انتظار بررسی",
    approved: "تأیید شده",
    rejected: "رد شده",
  };

  /** "YYYY-MM-DD HH:MM" → "۲۵ مهر ۱۴۰۵ · ۱۶:۴۸" */
  function formatDateTime(s) {
    if (!s) return "";
    return `${Ui.jalaliLabel(s.slice(0, 10))} · ${faDigits(s.slice(11))}`;
  }

  function statTile(label, value) {
    return el(
      "div",
      { class: "stat-tile" },
      el("div", { class: "stat-value", text: value }),
      el("div", { class: "stat-label", text: label }),
    );
  }

  function orderRow(o, customerId) {
    return el(
      "button",
      {
        class: "row tappable order-row",
        type: "button",
        // The shared detail sheet reads the order fresh by number (so it is
        // guaranteed to belong to the list it came from). On close the
        // profile re-opens on the orders tab with refreshed data.
        onClick: () =>
          OrderDetail.open(o.orderNumber, {
            onClose: () => openDetail(customerId, "orders"),
          }),
      },
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title" }, o.orderNumber,
          el("span", { class: "badge", text: o.fulfillmentLabel, style: "margin-inline-start:6px" })),
        el("div", { class: "row-sub", text: `${o.jalaliDate} · ${o.paymentMethodLabel} · ${o.paymentLabel}` }),
      ),
      el(
        "span",
        { class: "row-end" },
        el("span", { class: "order-total", text: moneyWithCurrency(o.totalAmount, o.currency) }),
        el("span", { class: "chev", html: icons.chevron }),
      ),
    );
  }

  const TX_TYPE_FILTERS = [
    { value: "all", label: "همه" },
    { value: "wallet_out", label: "کاهش کیف پول" },
    { value: "wallet_in", label: "افزایش کیف پول" },
    { value: "card", label: "کارت به کارت" },
  ];

  function txRow(t, onOpen) {
    const isCard = t.source === "card";
    const positive = t.amount > 0;
    const sign = isCard ? "−" : positive ? "+" : "−";
    const color = isCard ? "color:var(--muted)" : positive ? "color:var(--ok)" : "color:var(--danger)";
    const sub = [formatDateTime(t.time), t.note, t.orderNumber].filter(Boolean).join(" · ");
    return el(
      "button",
      { class: "row tappable", type: "button", onClick: () => onOpen(t) },
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title" },
          t.kindLabel,
          isCard && t.paymentStatusLabel
            ? el("span", { class: "badge", text: t.paymentStatusLabel, style: "margin-inline-start:6px" })
            : null),
        el("div", { class: "row-sub", text: sub }),
      ),
      el(
        "span",
        { class: "row-end order-total", style: color },
        `${sign}${moneyWithCurrency(Math.abs(t.amount), currency)}`,
      ),
    );
  }

  /** Detail dialog for one transaction (wallet ledger entry or card payment). */
  function openTxDetail(t, customerId) {
    const infoRow = (label, value, isolateLtr) =>
      el(
        "div",
        { class: "row", style: "padding:10px 0" },
        el("div", { class: "row-main" }, el("div", { class: "row-sub", text: label })),
        el("span", {
          class: "row-end",
          style: "font-weight:600;color:var(--text)",
        }, isolateLtr && value != null ? el("span", { class: "ltr", text: String(value) }) : value ?? "—"),
      );

    const isCard = t.source === "card";
    const amountText = `${t.amount > 0 ? "+" : "−"}${moneyWithCurrency(Math.abs(t.amount), currency)}`;

    const box = el(
      "div",
      {},
      el(
        "div",
        { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        infoRow("نوع تراکنش", t.kindLabel),
        infoRow("مبلغ", el("span", { style: t.amount > 0 ? "color:var(--ok)" : "color:var(--danger)", text: amountText })),
        infoRow("زمان", formatDateTime(t.time)),
        t.balanceAfter != null ? infoRow("مانده بعد از تراکنش", moneyWithCurrency(t.balanceAfter, currency)) : null,
        t.note ? infoRow("توضیح", t.note) : null,
        t.orderNumber ? infoRow("شماره سفارش", t.orderNumber, true) : null,
        t.paymentStatusLabel ? infoRow("وضعیت پرداخت", t.paymentStatusLabel) : null,
        t.fulfillmentLabel ? infoRow("وضعیت تحویل", t.fulfillmentLabel) : null,
      ),
    );

    if (t.orderNumber) {
      box.appendChild(
        el("div", { class: "form-actions" },
          el("button", {
            class: "btn secondary",
            type: "button",
            text: "مشاهده سفارش",
            onClick: () =>
              OrderDetail.open(t.orderNumber, {
                onClose: () => openDetail(customerId, "tx"),
              }),
          })),
      );
    }
    openSheet("جزئیات تراکنش", box);
  }

  function depositRow(d) {
    const cls = d.status === "approved" ? "badge" : d.status === "rejected" ? "badge off" : "badge warn";
    return el(
      "div",
      { class: "row" },
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title" },
          moneyWithCurrency(d.amount, currency),
          el("span", { class: cls, text: DEPOSIT_STATUS_LABELS[d.status] ?? d.status, style: "margin-inline-start:6px" })),
        el("div", { class: "row-sub", text: formatDateTime(d.time) }),
      ),
      d.hasReceipt ? el("span", { class: "row-end" }, el("span", { class: "badge info", text: "رسید" })) : null,
    );
  }

  function section(title, children, emptyText) {
    if (!children.length) {
      return el("div", {}, el("div", { class: "section-label", text: title }),
        el("div", { class: "card", style: "padding:12px 14px;color:var(--faint);font-size:13px", text: emptyText }));
    }
    return el(
      "div",
      {},
      el("div", { class: "section-label", text: title }),
      el("div", { class: "card list-card" }, ...children),
    );
  }

  /** 2-column action grid under the phone: Telegram chat + call. */
  function profileActions(profile) {
    const btns = [];
    if (profile?.username) {
      btns.push(el(
        "a",
        {
          class: "btn small secondary",
          href: `https://t.me/${encodeURIComponent(profile.username)}`,
          target: "_blank",
          rel: "noopener noreferrer",
          style: "text-decoration:none;justify-content:center",
        },
        el("span", { html: icons.send, style: "width:16px;height:16px;display:flex" }),
        "گفتگو تلگرام",
      ));
    }
    if (profile?.phone) {
      btns.push(el(
        "a",
        {
          class: "btn small secondary",
          href: `tel:${profile.phone}`,
          style: "text-decoration:none;justify-content:center",
        },
        el("span", { html: icons.phone, style: "width:16px;height:16px;display:flex" }),
        "تماس",
      ));
    }
    if (!btns.length) return null;
    return el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px" }, ...btns);
  }

  // ---------- wallet adjustment dialog ----------

  async function openAdjustDialog(id, customerName, onDone) {
    const box = el("div", {}, loadingState());
    openSheet("ثبت تراکنش کیف پول", box);
    let d;
    try {
      d = await Api.get(`/api/admin/customers/${id}`);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorState(err.message, () => void openAdjustDialog(id, customerName, onDone)));
      return;
    }
    box.innerHTML = "";

    box.appendChild(
      el("div", { class: "card", style: "padding:10px 14px;margin-bottom:14px" },
        el("div", { class: "switch-sub", text: customerName }),
        el("div", { style: "font-weight:700;margin-top:2px", text: `موجودی فعلی: ${moneyWithCurrency(d.balance, currency)}` })),
    );

    let direction = 1; // 1 = credit, -1 = debit
    const dir = Ui.segmented(
      [
        { value: 1, label: "افزایش موجودی", icon: icons.plus, cls: "on" },
        { value: -1, label: "کاهش موجودی", icon: icons.minus, cls: "off" },
      ],
      1,
    );
    const dirF = Ui.field("نوع تراکنش", dir.root);
    const amountF = Ui.field("مبلغ", Ui.numberInput("", { inputmode: "numeric", placeholder: "مثلاً ۵۰۰۰۰" }), {
      required: true,
      hint: `واحد: ${currency}`,
    });
    const noteF = Ui.field("توضیح (اختیاری)", Ui.textInput("", { maxlength: 200, placeholder: "مثلاً تخفیف همکاری" }), {
      hint: "این توضیح همراه پیام اطلاع‌رسانی برای مشتری ارسال می‌شود",
    });

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: "ثبت تراکنش" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      dirF.root,
      amountF.root,
      noteF.root,
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      amountF.setError(null);
      const raw = Ui.parseDigits(amountF.input.value);
      if (!/^\d+$/.test(raw) || Number(raw) === 0) {
        amountF.setError("مبلغ را به عدد غیرصفر وارد کنید");
        return;
      }
      const amount = direction * Number(raw);
      saveBtn.disabled = true;
      try {
        const r = await Api.post(`/api/admin/customers/${id}/wallet`, {
          amount,
          note: noteF.input.value,
        });
        toast(`تراکنش ثبت شد. موجودی جدید: ${moneyWithCurrency(r.balance, currency)}`);
        toast("به مشتری اطلاع داده می‌شود");
        closeSheet();
        onDone();
      } catch (err) {
        formError.textContent = err.message || "ثبت تراکنش انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    // segmented's internal set() updates the visual; the click hook tracks the
    // signed direction for the submit handler.
    dir.root.querySelectorAll("button").forEach((b, i) => {
      b.addEventListener("click", () => { direction = i === 0 ? 1 : -1; });
    });

    openSheet("ثبت تراکنش کیف پول", form);
  }

  // ---------- detail ----------

  async function openDetail(id, initialTab) {
    const box = el("div", {}, loadingState());
    openSheet("پروفایل مشتری", box);
    let d;
    try {
      d = await Api.get(`/api/admin/customers/${id}`);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorState(err.message, () => void openDetail(id)));
      return;
    }
    box.innerHTML = "";

    const name = d.profile ? d.profile.fullName || "بدون نام" : "بدون نام";

    // --- profile panel ---
    const profilePanel = () => {
      const wrap = el("div", {});
      const avatar = d.profile
        ? el("div", { class: "profile-avatar", text: name.trim().charAt(0) })
        : el("div", { class: "profile-avatar", html: icons.users });
      wrap.appendChild(
        el(
          "div",
          { class: "card profile-card", style: "margin-bottom:14px;align-items:flex-start" },
          avatar,
          el(
            "div",
            { style: "flex:1;min-width:0" },
            el("div", { class: "profile-name", text: name }),
            d.profile?.username
              ? el("div", { class: "profile-sub" }, el("span", { class: "ltr", text: `@${d.profile.username}` }))
              : null,
            d.profile?.phone
              ? el("div", { class: "profile-sub" }, el("span", { class: "ltr", text: faDigits(d.profile.phone) }))
              : null,
            profileActions(d.profile),
          ),
        ),
      );
      // Telegram identity info (id + username) as a small labeled list.
      wrap.appendChild(
        el(
          "div",
          { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
          infoRow("شناسه تلگرام", d.profile?.telegramId ? String(d.profile.telegramId) : "—", true),
          infoRow("یوزرنیم", d.profile?.username ? `@${d.profile.username}` : "ثبت نشده", true),
          infoRow("شماره تماس", d.profile?.phone ? faDigits(d.profile.phone) : "ثبت نشده", true),
          infoRow("آدرس", d.profile?.address || "ثبت نشده", false),
          infoRow("کارت بانکی", d.card?.hasCard ? d.card.masked : "ثبت نشده", true),
        ),
      );
      // Refund history (recent first) — masked destination card only.
      if (d.refunds && d.refunds.length) {
        const refundRows = d.refunds.map((r) =>
          el("div", { class: "row" },
            el("div", { class: "row-main" },
              el("div", { class: "row-title" },
                moneyWithCurrency(r.amount, currency),
                " ",
                el("span", { class: r.status === "pending" ? "badge warn" : r.status === "cancelled" ? "badge off" : "badge", text: r.statusLabel })),
              el("div", { class: "row-sub", text: `${r.orderNumber || "—"} · ${r.settlementLabel}${r.cardMasked ? ` · ${r.cardMasked}` : ""}` }),
              el("div", { class: "row-sub", text: r.createdAt }))),
        );
        wrap.appendChild(
          el("div", { class: "card list-card", style: "margin-bottom:14px" },
            el("div", { class: "section-label", text: "تاریخچه ریفاند" }),
            ...refundRows),
        );
      }
      // Channel membership (cached last verification + manual recheck).
      wrap.appendChild(membershipCard(d, id));
      wrap.appendChild(
        el(
          "div",
          { class: "stat-grid" },
          statTile("موجودی کیف پول", moneyWithCurrency(d.balance, currency)),
          statTile("تعداد سفارش", faDigits(d.orderCount)),
          statTile("مبلغ سفارش‌ها", moneyWithCurrency(d.orderValue, currency)),
          statTile("پرداخت‌شده", moneyWithCurrency(d.paidTotal, currency)),
        ),
      );
      if (d.outstanding > 0) {
        wrap.appendChild(
          el("div", { class: "form-error", style: "background:var(--warn-soft);color:var(--warn)" },
            `مبلغ تسویه‌نشده: ${moneyWithCurrency(d.outstanding, currency)}`),
        );
      }
      return wrap;
    };

    const ordersPanel = () =>
      section("", d.orders.map((o) => orderRow(o, id)), "هنوز سفارشی ثبت نکرده است.");

    const txPanel = () => {
      const wrap = el("div", {});
      const seg = Ui.segmented(
        TX_TYPE_FILTERS.map((f) => ({ value: f.value, label: f.label })),
        txType,
      );
      seg.root.querySelectorAll("button").forEach((b, i) => {
        b.addEventListener("click", () => {
          txType = TX_TYPE_FILTERS[i].value;
          void loadTx();
        });
      });
      const fromInput = el("input", { type: "date", value: txFrom, "aria-label": "از تاریخ" });
      const toInput = el("input", { type: "date", value: txTo, "aria-label": "تا تاریخ" });
      fromInput.addEventListener("change", () => { txFrom = fromInput.value; void loadTx(); });
      toInput.addEventListener("change", () => { txTo = toInput.value; void loadTx(); });
      wrap.appendChild(el("div", { class: "card filter-bar" },
        el("div", { style: "width:100%" }, seg.root),
        el("div", { style: "display:flex;gap:8px;width:100%;margin-top:8px" },
          el("div", { style: "flex:1" }, fromInput),
          el("div", { style: "flex:1" }, toInput),
        ),
      ));
      const box = el("div", { style: "margin-top:12px" });
      wrap.appendChild(box);

      let token = 0;
      async function loadTx() {
        const my = ++token;
        box.innerHTML = "";
        box.appendChild(loadingState());
        try {
          const qs = new URLSearchParams();
          if (txType && txType !== "all") qs.set("type", txType);
          if (txFrom) qs.set("from", txFrom);
          if (txTo) qs.set("to", txTo);
          const q = qs.toString() ? `?${qs.toString()}` : "";
          const items = await Api.get(`/api/admin/customers/${id}/transactions${q}`);
          if (my !== token) return;
          box.innerHTML = "";
          if (!items.length) {
            box.appendChild(emptyState("تراکنشی یافت نشد", "فیلترها را تغییر دهید."));
            return;
          }
          const card = el("div", { class: "card list-card" });
          for (const t of items) card.appendChild(txRow(t, (tt) => openTxDetail(tt, id)));
          box.appendChild(card);
        } catch (err) {
          if (my !== token) return;
          box.innerHTML = "";
          box.appendChild(errorState(err.message, () => void loadTx()));
        }
      }
      void loadTx();
      return wrap;
    };

    const walletPanel = () => {
      const wrap = el("div", {});
      wrap.appendChild(
        el(
          "div",
          { class: "card", style: "padding:14px;margin-bottom:14px" },
          el("div", { class: "switch-sub", text: "موجودی کیف پول" }),
          el("div", { style: "font-size:22px;font-weight:700;margin-top:2px", text: moneyWithCurrency(d.balance, currency) }),
          el("button", {
            class: "btn small",
            type: "button",
            style: "margin-top:10px;width:auto",
            text: "ثبت تراکنش (افزایش/کاهش)",
            onClick: () => openAdjustDialog(id, name, () => void openDetail(id)),
          }),
        ),
      );
      wrap.appendChild(section("درخواست‌های واریز", d.deposits.map(depositRow), "درخواست واریزی ندارد."));
      return wrap;
    };

    // --- referral panel (معرفی و زیرمجموعه‌ها) ---
    const referralPanel = () => {
      const wrap = el("div", {});
      const box = el("div", {}, loadingState());
      wrap.appendChild(box);

      let state = null; // last loaded payload
      let referredOffset = 0;

      function copyText(text) {
        const done = () => toast("کپی شد");
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => toast("کپی انجام نشد", true));
        } else {
          const ta = el("textarea", { style: "position:fixed;opacity:0" });
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch { toast("کپی انجام نشد", true); }
          ta.remove();
        }
      }

      function customerSub(c) {
        return [
          c.username ? `@${c.username}` : null,
          c.referralCode ? `کد: ${c.referralCode}` : null,
          c.createdAt ? `تاریخ: ${Ui.jalaliLabel(c.createdAt.slice(0, 10))}` : null,
        ].filter(Boolean).join(" · ");
      }

      function referrerCard() {
        if (!state.referrer) {
          return el("div", { class: "card", style: "padding:14px;margin-bottom:14px" },
            el("div", { class: "switch-sub", text: "معرف این مشتری" }),
            el("div", { style: "margin-top:6px;color:var(--text-dim)", text: "این مشتری با کد معرف ثبت‌نام نکرده است." }));
        }
        const r = state.referrer;
        const link = r.id ? `?customer=${r.id}` : null;
        return el("div", { class: "card", style: "padding:14px;margin-bottom:14px" },
          el("div", { class: "switch-sub", text: "معرف این مشتری" }),
          el("div", { style: "font-weight:700;margin-top:6px" },
            r.name || "بدون نام",
            r.username ? el("span", { class: "ltr", style: "margin-inline-start:6px", text: `@${r.username}` }) : null),
          el("div", { class: "row-sub", style: "margin-top:4px" },
            r.referralCode ? `کد معرف: ${r.referralCode}` : null,
            r.phone ? ` · ${faDigits(r.phone)}` : null),
          el("div", { class: "row-sub", style: "margin-top:2px" },
            `تاریخ ثبت: ${r.createdAt ? Ui.jalaliLabel(r.createdAt.slice(0, 10)) : "—"}`),
          el("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
            el("button", { class: "btn small", type: "button", text: "پروفایل معرف", onClick: () => openDetail(r.id) }),
            el("button", { class: "btn small ghost danger", type: "button", text: "لغو ارتباط با معرف", onClick: () => void removeReferrer() })),
        );
      }

      function referredList() {
        const items = state.referred || [];
        const rows = items.map((c) =>
          el("button", { class: "row tappable", type: "button", onClick: () => openDetail(c.id) },
            el("div", { class: "profile-avatar", style: "width:40px;height:40px;font-size:15px",
              text: (c.name || "ب").trim().charAt(0) }),
            el("div", { class: "row-main" },
              el("div", { class: "row-title", text: c.name || "بدون نام" }),
              el("div", { class: "row-sub", text: customerSub(c) }))));
        const card = section(
          "زیرمجموعه‌ها (مشتریان دعوت‌شده)",
          rows,
          items.length === 0 ? "هنوز مشتری با کد معرف این شخص ثبت‌نام نکرده است." : null,
        );
        if (state.referredCount > items.length) {
          card.appendChild(el("button", {
            class: "btn small ghost", type: "button", style: "margin:10px auto;display:block",
            text: "نمایش موارد بیشتر",
            onClick: () => { referredOffset += state.limit; void load(); },
          }));
        }
        return card;
      }

      async function setReferrer() {
        const chosen = await pickCustomer("انتخاب معرف", id);
        if (!chosen) return;
        if (!confirm(`«${chosen.name || chosen.id}» به عنوان معرف این مشتری ثبت شود؟`)) return;
        try {
          await Api.post(`/api/admin/customers/${id}/referrer`, { referrerId: chosen.id });
          toast("معرف با موفقیت ثبت شد");
          await load();
        } catch (err) {
          toast(err.message || "ثبت معرف انجام نشد", true);
        }
      }

      async function removeReferrer() {
        if (!confirm("ارتباط این مشتری با معرف حذف شود؟ کد معرف خود مشتری و سایر اطلاعات دست‌نخورده می‌ماند.")) return;
        try {
          await Api.del(`/api/admin/customers/${id}/referrer`);
          toast("ارتباط با معرف حذف شد");
          await load();
        } catch (err) {
          toast(err.message || "حذف ارتباط انجام نشد", true);
        }
      }

      async function load() {
        box.innerHTML = "";
        box.appendChild(loadingState());
        try {
          state = await Api.get(`/api/admin/customers/${id}/referral?offset=${referredOffset}&limit=20`);
        } catch (err) {
          box.innerHTML = "";
          box.appendChild(errorState(err.message, () => void load()));
          return;
        }
        box.innerHTML = "";
        // A. Own referral code
        const codeCard = el("div", { class: "card", style: "padding:14px;margin-bottom:14px" },
          el("div", { class: "switch-sub", text: "کد معرف این مشتری" }),
          el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap" },
            el("span", { class: "ltr", style: "font-size:20px;font-weight:800;letter-spacing:2px", text: state.code }),
            el("button", { class: "btn small", type: "button", text: "کپی کد", onClick: () => copyText(state.code) })),
          state.link
            ? el("div", { style: "margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap" },
                el("span", { class: "ltr row-sub", style: "word-break:break-all;flex:1;min-width:180px", text: state.link }),
                el("button", { class: "btn small ghost", type: "button", text: "کپی لینک", onClick: () => copyText(state.link) }))
            : el("div", { class: "row-sub", style: "margin-top:8px", text: "لینک دعوت پس از روشن شدن ربات در دسترس می‌شود." }),
          el("div", { style: "margin-top:8px" }, statTile("تعداد زیرمجموعه‌ها", faDigits(state.referredCount))),
        );
        box.appendChild(codeCard);
        // B. Current referrer + admin actions
        box.appendChild(referrerCard());
        box.appendChild(el("div", { style: "display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap" },
          el("button", { class: "btn small", type: "button", text: "تغییر معرف", onClick: () => void setReferrer() })));
        // C. Referred customers
        box.appendChild(referredList());
      }

      void load();
      return wrap;
    };

    /** Searchable customer picker. Resolves to a customer row or null. */
    function pickCustomer(title, excludeId) {
      return new Promise((resolve) => {
        const results = el("div", { style: "margin-top:10px;max-height:260px;overflow:auto" });
        const input = el("input", { type: "text", placeholder: "جستجو بر اساس نام، یوزرنیم، تلفن یا کد…", style: "width:100%" });
        let timer = null;
        input.addEventListener("input", () => {
          clearTimeout(timer);
          const q = input.value.trim();
          if (q.length < 1) { results.innerHTML = ""; return; }
          timer = setTimeout(async () => {
            try {
              const list = await Api.get(`/api/admin/customers?q=${encodeURIComponent(q)}`);
              results.innerHTML = "";
              const matches = list.filter((c) => c.id !== excludeId).slice(0, 20);
              if (!matches.length) {
                results.appendChild(el("div", { class: "row-sub", style: "padding:10px 0", text: "مشتری‌ای یافت نشد." }));
                return;
              }
              for (const c of matches) {
                results.appendChild(el("button", {
                  class: "row tappable", type: "button",
                  onClick: () => { closeSheet(); resolve(c); },
                },
                  el("div", { class: "profile-avatar", style: "width:36px;height:36px;font-size:14px", text: (c.name || "ب").trim().charAt(0) }),
                  el("div", { class: "row-main" },
                    el("div", { class: "row-title", text: c.name || "بدون نام" }),
                    el("div", { class: "row-sub", text: [
                      c.username ? `@${c.username}` : null,
                      c.phone ? faDigits(c.phone) : null,
                      `شناسه: ${c.id}`,
                    ].filter(Boolean).join(" · ") }))));
              }
            } catch {
              results.innerHTML = "";
              results.appendChild(el("div", { class: "row-sub", style: "padding:10px 0", text: "جستجو انجام نشد." }));
            }
          }, 250);
        });
        openSheet(title, el("div", {},
          el("div", { class: "form-field" }, input),
          results,
          el("div", { class: "form-actions" },
            el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: () => { closeSheet(); resolve(null); } }))));
        setTimeout(() => input.focus(), 50);
      });
    }

    box.appendChild(
      Ui.tabs(
        [
          { key: "profile", label: "پروفایل", icon: icons.users, build: profilePanel },
          { key: "orders", label: "سفارش‌ها", icon: icons.order, build: ordersPanel },
          { key: "tx", label: "تراکنش‌ها", icon: icons.chart, build: txPanel },
          { key: "wallet", label: "کیف پول", icon: icons.wallet, build: walletPanel },
          { key: "referral", label: "معرفی و زیرمجموعه‌ها", icon: icons.send, build: referralPanel },
        ],
        initialTab || "profile",
      ),
    );
  }

  /** A compact label/value row for the profile info card. */
  function infoRow(label, value, isolateLtr) {
    return el(
      "div",
      { class: "row", style: "padding:10px 0" },
      el("div", { class: "row-main" }, el("div", { class: "row-sub", text: label })),
      el("span", {
        class: "row-end",
        style: "font-weight:600;color:var(--text)",
      }, isolateLtr ? el("span", { class: "ltr", text: value }) : value),
    );
  }

  /** Channel-membership card: cached status, last check time, manual recheck. */
  function membershipCard(d, customerId) {
    const m = d.membership || {};
    const statusValue = m.status
      ? el("span", {}, membershipBadge({ status: m.status, statusLabel: m.statusLabel }))
      : el("span", { style: "font-weight:600;color:var(--text)", text: "هنوز بررسی نشده" });
    const statusRow = el(
      "div",
      { class: "row", style: "padding:10px 0" },
      el("div", { class: "row-main" }, el("div", { class: "row-sub", text: "وضعیت" })),
      el("span", { class: "row-end" }, statusValue),
    );
    const checkBtn = el("button", {
      class: "btn small",
      type: "button",
      style: "margin-top:10px;width:auto",
      text: "بررسی مجدد",
      disabled: !m.configuredChannel,
      onClick: () => void runMembershipCheck(customerId, d),
    });
    return el(
      "div",
      { class: "card", style: "padding:10px 14px;margin-bottom:14px" },
      el("div", { class: "section-label", style: "margin:0 0 4px", text: "عضویت کانال" }),
      statusRow,
      infoRow("کانال", m.configuredChannel || "تنظیم نشده", true),
      m.channel && m.channel !== m.configuredChannel
        ? infoRow("کانالِ بررسی‌شده", m.channel, true)
        : null,
      infoRow("آخرین بررسی", m.checkedAt || "—", false),
      m.enforcementEnabled
        ? el("div", { class: "field-hint", style: "margin:4px 0 0", text: "دکمه عضویت کانال برای مشتریان غیرعضو در منوی اصلی ربات نمایش داده می‌شود (اجباری نیست)." })
        : el("div", { class: "field-hint", style: "margin:4px 0 0", text: "نمایش دکمه عضویت کانال در ربات غیرفعال است (فقط نمایش وضعیت)." }),
      !m.configuredChannel
        ? el("div", { class: "field-hint", style: "margin:4px 0 0", text: "برای بررسی، ابتدا کانال را در تنظیمات عضویت کانال پیکربندی کنید." })
        : null,
      checkBtn,
    );
  }

  async function runMembershipCheck(customerId, current) {
    try {
      const r = await Api.post(`/api/admin/customers/${customerId}/membership-check`, {});
      const label = r.statusLabel || r.status;
      toast(`وضعیت عضویت: ${label}`);
      // Refresh the detail sheet with the fresh result.
      void openDetail(customerId);
    } catch (err) {
      toast(err.message || "بررسی عضویت انجام نشد", true);
    }
  }

  // ---------- public ----------

  async function refresh() {
    const page = document.getElementById("page-customers");
    render(page);
  }

  return { setData, refresh };
})();