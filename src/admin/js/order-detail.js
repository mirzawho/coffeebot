/* Shared order detail sheet: view, payment review, lifecycle actions, edit.
 * Used by the reports page and the customer profile's orders tab — one
 * implementation, fetched fresh from GET /api/admin/orders/:ref on every
 * render so the sheet always mirrors persisted server state. */
"use strict";

const OrderDetail = (() => {
  const { el, icons, toast, openSheet, field, textInput, loadingState, errorState,
    moneyWithCurrency, faDigits, segmented } = Ui;

  // Mirrors of the server limits (src/utils/ids.ts) for client-side steering;
  // the server re-validates everything on save.
  const MAX_QTY = 20;
  const MAX_LINES = 40;

  const FULFILLMENT_BADGE = {
    pending: "badge warn",
    confirmed: "badge info",
    delivered: "badge",
    cancelled: "badge off",
  };

  // Receipt previews are fetched with auth headers (an <img> tag cannot carry
  // them), so each preview lives on a blob URL that must be revoked when the
  // sheet it belongs to goes away.
  let receiptObjectUrls = [];
  function revokeReceiptUrls() {
    for (const u of receiptObjectUrls) URL.revokeObjectURL(u);
    receiptObjectUrls = [];
  }
  function receiptImageEl(orderNumber) {
    const holder = el("div", { style: "margin-top:10px" });
    Api.blob(`/api/admin/orders/${encodeURIComponent(orderNumber)}/receipt/image`)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        receiptObjectUrls.push(url);
        holder.appendChild(
          el("img", {
            src: url,
            alt: "تصویر رسید پرداخت",
            loading: "lazy",
            style: "width:100%;border-radius:10px;background:var(--surface-2)",
          }),
        );
      })
      .catch(() => {
        holder.appendChild(
          el("div", {
            style: "font-size:12.5px;color:var(--faint)",
            text: "پیش‌نمایش رسید در دسترس نیست.",
          }),
        );
      });
    return holder;
  }

  /**
   * Open the order detail sheet for `orderNumber`.
   * opts.onChanged — called after any successful mutation so the caller can
   *                  refresh its underlying list (never closes this sheet).
   * opts.onClose   — called when the user closes the sheet (back-navigation,
   *                  e.g. the customer profile re-opens itself).
   */
  function open(orderNumber, opts = {}) {
    void show(orderNumber, opts);
  }

  async function fetchOrder(orderNumber) {
    return Api.get(`/api/admin/orders/${encodeURIComponent(orderNumber)}`);
  }

  function reload(orderNumber, opts) {
    void show(orderNumber, opts);
  }

  /** Fetch + render the detail sheet. */
  async function show(orderNumber, opts) {
    const box = el("div", {}, loadingState());
    // The wrapper always revokes the previews when the sheet goes away, then
    // hands off to the caller's close handler (e.g. the customer profile
    // re-opening itself). openSheet replaces the previous callback without
    // firing it, so re-renders chain without double-invoking onClose.
    const closeHook = {
      onClose: () => {
        revokeReceiptUrls();
        if (opts.onClose) opts.onClose();
      },
    };
    openSheet("جزئیات سفارش", box, closeHook);
    // The previous sheet's content just got detached — its blob URLs are dead
    // weight now. (Rendering below attaches fresh ones to `box` itself, which
    // survives the second openSheet's DOM move.)
    revokeReceiptUrls();
    let o;
    try {
      o = await fetchOrder(orderNumber);
    } catch (err) {
      box.innerHTML = "";
      box.appendChild(errorState(err.message, () => reload(orderNumber, opts)));
      return;
    }
    box.innerHTML = "";
    box.appendChild(buildDetail(o, opts));
    openSheet("جزئیات سفارش", box, closeHook);
  }

  function buildDetail(o, opts) {
    const done = () => {
      if (opts.onChanged) opts.onChanged();
    };

    const statusBadge = el("span", {
      class: FULFILLMENT_BADGE[o.fulfillmentStatus] || "badge",
      text: o.fulfillmentLabel,
      style: "margin-top:6px",
    });

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
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" },
          statusBadge,
          el("span", { class: "badge", text: o.paymentLabel }),
          el("span", { class: "badge", text: o.statusLabel }),
        ),
      ),
      el("div", { class: "field-label", text: "اقلام سفارش" }),
      el(
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
      ),
      el(
        "div",
        { class: "card", style: "padding:12px 14px;margin-bottom:14px" },
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
      paymentCard(o, () => {
        reload(o.orderNumber, opts);
        done();
      }),
    );

    // Lifecycle + edit actions. The server validates every transition; only
    // options that are legal for the CURRENT fulfillment status are shown.
    const actions = el("div", { class: "form-actions" });

    if (o.fulfillmentStatus !== "delivered" && o.fulfillmentStatus !== "cancelled") {
      const editBtn = el("button", { class: "btn secondary", type: "button", text: "✏️ ویرایش سفارش" });
      editBtn.addEventListener("click", () => openEdit(o, opts));
      actions.appendChild(editBtn);
    }

    const mkAction = (label, path) => {
      const b = el("button", { class: "btn", type: "button", text: label });
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await Api.post(path, {});
          toast("انجام شد");
          reload(o.orderNumber, opts);
          done();
        } catch (err) {
          toast(err.message || "انجام نشد", true);
          b.disabled = false;
        }
      });
      return b;
    };
    if (o.fulfillmentStatus === "pending") {
      actions.appendChild(mkAction("✅ تأیید سفارش", `/api/admin/orders/${encodeURIComponent(o.orderNumber)}/confirm`));
    } else if (o.fulfillmentStatus === "confirmed") {
      actions.appendChild(mkAction("📦 تحویل داده شد", `/api/admin/orders/${encodeURIComponent(o.orderNumber)}/deliver`));
    }
    if (actions.childElementCount > 0) box.appendChild(actions);

    return box;
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
      card.appendChild(receiptImageEl(o.orderNumber));
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
      actions.appendChild(mk("✅ تأیید پرداخت", `/api/admin/orders/${encodeURIComponent(o.orderNumber)}/payment/approve`, ""));
      // Reject asks for a reason — it is shown to the customer next to the
      // receipt image. Cancelling the prompt aborts the rejection.
      const rejectBtn = el("button", { class: "btn ghost", type: "button", text: "❌ رد رسید" });
      rejectBtn.addEventListener("click", async () => {
        const reason = prompt("دلیل رد رسید (برای مشتری ارسال می‌شود):");
        if (reason === null) return; // cancelled
        rejectBtn.disabled = true;
        try {
          await Api.post(
            `/api/admin/orders/${encodeURIComponent(o.orderNumber)}/payment/reject`,
            reason.trim() ? { reason: reason.trim() } : {},
          );
          toast("انجام شد");
          await onChanged();
        } catch (err) {
          toast(err.message || "انجام نشد", true);
          rejectBtn.disabled = false;
        }
      });
      actions.appendChild(rejectBtn);
      card.appendChild(actions);
    }
    return card;
  }

  // ---------- edit ----------

  function openEdit(o, opts) {
    // Closing the edit sheet (X / backdrop / cancel) returns to the detail
    // view; openSheet replaces the close-callback without firing it, so the
    // chain stays intact through every re-render.
    const backToDetail = () => reload(o.orderNumber, opts);

    // Editable working copy of the lines. `productId` null marks a legacy
    // snapshot line that cannot be revalidated — save is blocked while one
    // is present (the server would reject it anyway).
    const lines = o.items.map((it) => ({
      productId: it.productId ?? null,
      variantId: it.variantId ?? null,
      quantity: it.quantity,
      productName: it.productName,
      variantName: it.variantName,
      unitPrice: it.unitPrice,
    }));

    let method = o.fulfillmentMethod === "delivery" ? "delivery" : "pickup";
    const formError = el("div", { class: "form-error" });
    formError.hidden = true;

    const linesBox = el("div", { class: "card list-card", style: "margin-bottom:14px" });
    const totalBox = el("div", { style: "display:flex;justify-content:space-between;font-weight:700;margin-top:10px" });

    function lineLabel(l) {
      return l.variantName ? `${l.productName} — ${l.variantName}` : l.productName;
    }

    function renderLines() {
      linesBox.innerHTML = "";
      if (!lines.length) {
        linesBox.appendChild(
          el("div", { class: "row", style: "color:var(--faint);font-size:13px", text: "هیچ قلمی انتخاب نشده است." }),
        );
      }
      lines.forEach((l, idx) => {
        const qtyEl = el("span", { style: "min-width:24px;text-align:center;font-weight:700", text: faDigits(l.quantity) });
        const minus = el("button", { class: "btn small ghost", type: "button", text: "−", "aria-label": "کاهش تعداد", style: "min-width:38px" });
        const plus = el("button", { class: "btn small ghost", type: "button", text: "+", "aria-label": "افزایش تعداد", style: "min-width:38px" });
        const remove = el("button", { class: "btn small danger", type: "button", html: icons.trash, "aria-label": "حذف قلم", style: "min-width:38px" });
        minus.addEventListener("click", () => {
          if (l.quantity <= 1) lines.splice(idx, 1);
          else l.quantity -= 1;
          renderLines();
        });
        plus.addEventListener("click", () => {
          if (l.quantity >= MAX_QTY) {
            toast(`حداکثر تعداد برای هر قلم ${MAX_QTY} است`, true);
            return;
          }
          l.quantity += 1;
          renderLines();
        });
        remove.addEventListener("click", () => {
          lines.splice(idx, 1);
          renderLines();
        });
        linesBox.appendChild(
          el(
            "div",
            { class: "row" },
            el(
              "div",
              { class: "row-main" },
              el("div", { class: "row-title", text: lineLabel(l) }),
              el("div", {
                class: "row-sub",
                text: l.productId == null
                  ? "شناسه محصول ثبت نشده — این قلم قابل ویرایش نیست"
                  : `${faDigits(l.quantity)} × ${faDigits(l.unitPrice)}`,
              }),
            ),
            el(
              "span",
              { class: "row-end", style: "display:flex;gap:6px;align-items:center" },
              minus,
              qtyEl,
              plus,
              remove,
            ),
          ),
        );
      });
      const preview = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
      totalBox.innerHTML = "";
      totalBox.appendChild(el("span", { text: "جمع (پیش‌نمایش)" }));
      totalBox.appendChild(el("span", { text: moneyWithCurrency(preview, o.currency) }));
    }

    // Product picker: active catalog grouped by category. A product with
    // variants contributes one option per variant.
    const pickerSelect = el(
      "select",
      {},
      el("option", { value: "", text: "محصول را انتخاب کنید…" }),
    );
    const pickerF = field("افزودن قلم", pickerSelect, {
      hint: "قیمت‌ها هنگام ذخیره با منوی فعلی بازمحاسبه می‌شوند.",
    });
    const addBtn = el("button", { class: "btn small secondary", type: "button", text: "افزودن به سفارش", style: "width:auto" });

    // key `${productId}:${variantId ?? ""}` → display data for new lines.
    const catalog = new Map();

    let pickerLoaded = false;
    async function loadPicker() {
      if (pickerLoaded) return;
      pickerLoaded = true;
      try {
        const [cats, products] = await Promise.all([
          Api.get("/api/admin/categories"),
          Api.get("/api/admin/products"),
        ]);
        const catName = new Map(cats.map((c) => [c.id, c.name]));
        // Group by category id, preserving server order.
        const groups = new Map();
        for (const p of products) {
          if (!groups.has(p.categoryId)) groups.set(p.categoryId, []);
          groups.get(p.categoryId).push(p);
        }
        for (const [catId, ps] of groups) {
          const og = el("optgroup", { label: catName.get(catId) || "—" });
          for (const p of ps) {
            if (p.variants && p.variants.length) {
              for (const v of p.variants) {
                catalog.set(`${p.id}:${v.id}`, {
                  productId: p.id,
                  variantId: v.id,
                  productName: p.name,
                  variantName: v.name,
                  unitPrice: v.priceAmount,
                });
                og.appendChild(
                  el("option", {
                    value: `${p.id}:${v.id}`,
                    text: `${p.name} — ${v.name} (${faDigits(v.priceAmount)})`,
                  }),
                );
              }
            } else if (p.fixedPriceAmount != null) {
              catalog.set(`${p.id}:`, {
                productId: p.id,
                variantId: null,
                productName: p.name,
                variantName: null,
                unitPrice: p.fixedPriceAmount,
              });
              og.appendChild(
                el("option", {
                  value: `${p.id}:`,
                  text: `${p.name} (${faDigits(p.fixedPriceAmount)})`,
                }),
              );
            }
          }
          pickerSelect.appendChild(og);
        }
      } catch {
        pickerLoaded = false; // allow a later retry on the next open
        toast("دریافت منو انجام نشد", true);
      }
    }

    addBtn.addEventListener("click", () => {
      const raw = pickerSelect.value;
      if (!raw) return;
      const entry = catalog.get(raw);
      if (!entry) return;
      if (lines.length >= MAX_LINES) {
        toast(`حداکثر ${MAX_LINES} قلم در سفارش مجاز است`, true);
        return;
      }
      const existing = lines.find(
        (l) => l.productId === entry.productId && (l.variantId ?? null) === entry.variantId,
      );
      if (existing) {
        if (existing.quantity >= MAX_QTY) {
          toast(`حداکثر تعداد برای هر قلم ${MAX_QTY} است`, true);
          return;
        }
        existing.quantity += 1;
      } else {
        lines.push({ ...entry, quantity: 1 });
      }
      pickerSelect.value = "";
      renderLines();
    });

    const methodSeg = segmented(
      [
        { value: "pickup", label: "تحویل حضوری 🏪" },
        { value: "delivery", label: "ارسال 🛵" },
      ],
      method,
    );
    methodSeg.root.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => { method = methodSeg.value(); });
    });
    const methodF = field("روش تحویل", methodSeg.root);

    const timeF = field(
      "زمان تحویل",
      textInput(o.deliveryTime || "", { maxlength: 100, placeholder: "مثلاً: الان، فردا ساعت ۱۰" }),
      { hint: "متن آزاد — همانند انتخاب مشتری در ربات" },
    );

    const notesInput = el("textarea", { maxlength: 500, rows: "2", placeholder: "مثلاً: بدون قند، زنگ در را بزنید" });
    notesInput.value = o.deliveryNotes || "";
    const notesF = field("یادداشت تحویل (اختیاری)", notesInput);

    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره تغییرات" });
    const cancelBtn = el("button", { class: "btn ghost", type: "button", text: "بازگشت", onClick: backToDetail });

    const form = el(
      "form",
      { novalidate: "" },
      el("div", { class: "field-label", text: "اقلام سفارش" }),
      linesBox,
      totalBox,
      el("div", { style: "display:flex;gap:8px;align-items:flex-end;margin:12px 0" },
        el("div", { style: "flex:1" }, pickerF.root),
        addBtn,
      ),
      el("div", { style: "height:6px" }),
      methodF.root,
      timeF.root,
      notesF.root,
      formError,
      el("div", { class: "form-actions" }, saveBtn, cancelBtn),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      if (!lines.length) {
        formError.textContent = "سفارش باید حداقل یک قلم داشته باشد";
        formError.hidden = false;
        return;
      }
      if (lines.some((l) => l.productId == null)) {
        formError.textContent = "برخی اقلام این سفارش شناسه محصول ندارند و قابل ویرایش نیستند";
        formError.hidden = false;
        return;
      }
      saveBtn.disabled = true;
      try {
        await Api.put(`/api/admin/orders/${encodeURIComponent(o.orderNumber)}`, {
          items: lines.map((l) => ({
            productId: l.productId,
            variantId: l.variantId,
            quantity: l.quantity,
          })),
          fulfillmentMethod: method,
          deliveryTime: timeF.input.value,
          deliveryNotes: notesInput.value,
        });
        toast("سفارش به‌روزرسانی شد");
        if (opts.onChanged) opts.onChanged();
        reload(o.orderNumber, opts);
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    renderLines();
    openSheet("ویرایش سفارش", form, { onClose: backToDetail });
    void loadPicker();
  }

  return { open };
})();
