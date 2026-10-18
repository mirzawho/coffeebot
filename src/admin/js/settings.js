/* Settings page: admin profile, business hours, payments, daily report delivery. */
"use strict";

const SettingsPage = (() => {
  const { el, icons, toast, openSheet, closeSheet, field, textInput,
    switchInput, switchField, loadingState, errorState, moneyWithCurrency, faDigits, esc } = Ui;

  const WEEKDAYS_FA = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
  // Persian week starts on شنبه (JS weekday 6), then 0..5.
  const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];

  let profile = null; // from /api/admin/me (validated identity)
  let payment = null;
  let hours = null;
  let reportSettings = null;
  let admins = []; // [{ id, label, username }]
  let aiSettings = null;
  let notifSettings = null;
  let membershipSettings = null; // { enabled, channel, channelUrl, message, messageIsDefault }
  let currency = "تومان";

  function hoursSummary() {
    if (!hours) return "";
    const open = hours.filter((h) => h.active);
    if (open.length === 0) return "همیشه تعطیل";
    const sample = open[0];
    const uniform = open.every((h) => h.openTime === sample.openTime && h.closeTime === sample.closeTime);
    if (uniform) return `${open.length === 7 ? "هر روز" : `${faDigits(open.length)} روز در هفته`} · ${faDigits(sample.openTime)} تا ${faDigits(sample.closeTime)}`;
    return `${faDigits(open.length)} روز فعال در هفته`;
  }

  function paymentSummary() {
    if (!payment) return "";
    const methods = [];
    if (payment.cardToCardEnabled) methods.push("کارت به کارت");
    if (payment.walletEnabled) methods.push("کیف پول");
    if (methods.length === 0) return "هیچ روش پرداختی فعال نیست";
    return `${methods.join(" · ")} · ${payment.currency}`;
  }

  function reportSummary() {
    if (!reportSettings) return "";
    if (!reportSettings.enabled) return "غیرفعال";
    return `فعال · هر روز ساعت ${faDigits(reportSettings.time)}`;
  }

  // ---------- render ----------

  function settingsRow(icon, title, summary, onClick) {
    return el(
      "button",
      { class: "row tappable", type: "button", onClick },
      el("span", { class: "leading", html: icon }),
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title", text: title }),
        summary ? el("div", { class: "row-sub", text: summary }) : null,
      ),
      el("span", { class: "row-end" }, el("span", { class: "chev", html: icons.chevron })),
    );
  }

  function render(container) {
    container.innerHTML = "";

    if (!profile) {
      container.appendChild(loadingState());
      return;
    }

    // Profile — actual authenticated identity (never a client-supplied id).
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
    const displayName = fullName || (profile.username ? `@${profile.username}` : "مدیر کافه");
    const avatar = profile.photoUrl
      ? el("img", { class: "profile-avatar", src: esc(profile.photoUrl), alt: "" })
      : el("div", { class: "profile-avatar", text: (displayName || "م").trim().charAt(0) });
    container.appendChild(
      el(
        "div",
        { class: "card profile-card" },
        avatar,
        el(
          "div",
          {},
          el("div", { class: "profile-name", text: displayName }),
          profile.username
            ? el("div", { class: "profile-sub" }, el("span", { class: "ltr", text: `@${profile.username}` }))
            : null,
        ),
      ),
    );

    container.appendChild(el("div", { class: "section-label", text: "تنظیمات" }));
    const list = el(
      "div",
      { class: "card list-card settings-list" },
      settingsRow(icons.clock, "ساعات کاری", hoursSummary(), openHoursSheet),
      settingsRow(icons.card, "پرداخت", paymentSummary(), openPaymentSheet),
      settingsRow(icons.report, "گزارش روزانه", reportSummary(), openReportSheet),
      settingsRow(icons.gear, "هوش مصنوعی", aiSummary(), openAiSheet),
      settingsRow(icons.check, "اعلان‌های مشتری", notifSummary(), openNotifSheet),
      settingsRow(icons.users, "عضویت کانال", membershipSummary(), openMembershipSheet),
    );
    container.appendChild(list);
  }

  // ---------- business hours ----------

  function openHoursSheet() {
    const rows = [];
    const form = el("form", { novalidate: "" });
    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    form.appendChild(formError);

    for (const wd of WEEK_ORDER) {
      const h = hours.find((x) => x.weekday === wd) || { weekday: wd, openTime: "08:00", closeTime: "18:00", active: false };
      const openInput = el("input", { type: "time", value: h.openTime });
      const closeInput = el("input", { type: "time", value: h.closeTime });
      const sw = switchInput(h.active);
      const timeWrap = el(
        "div",
        { style: "display:flex;gap:8px;align-items:center" },
        el("div", { class: "field", style: "flex:1;min-width:0;margin:0" }, el("label", {}, "شروع", openInput)),
        el("div", { class: "field", style: "flex:1;min-width:0;margin:0" }, el("label", {}, "پایان", closeInput)),
      );
      const sync = () => {
        openInput.disabled = !sw.input.checked;
        closeInput.disabled = !sw.input.checked;
        timeWrap.style.opacity = sw.input.checked ? "1" : "0.5";
      };
      sw.input.addEventListener("change", sync);
      sync();
      rows.push({ weekday: wd, openInput, closeInput, sw });
      form.appendChild(
        el(
          "div",
          { class: "card", style: "padding:10px 12px;margin-bottom:10px" },
          el(
            "div",
            { style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px" },
            el("strong", { text: WEEKDAYS_FA[wd] }),
            el("div", { style: "display:flex;align-items:center;gap:8px" }, el("span", { style: "font-size:12px;color:var(--muted)", text: "باز" }), sw.root),
          ),
          timeWrap,
        ),
      );
    }

    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره ساعات کاری" });
    form.appendChild(el("div", { class: "field-hint", style: "margin:14px 0 0", text: "ساعت پایان باید بعد از ساعت شروع باشد؛ ساعت کاری شبانه پشتیبانی نمی‌شود." }));
    form.appendChild(el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      saveBtn.disabled = true;
      const payload = rows.map((r) => ({
        weekday: r.weekday,
        openTime: r.openInput.value || "08:00",
        closeTime: r.closeInput.value || "18:00",
        active: r.sw.input.checked,
      }));
      try {
        hours = await Api.put("/api/admin/business-hours", payload);
        toast("ساعات کاری ذخیره شد");
        closeSheet();
        renderSettingsPage();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    openSheet("ساعات کاری", form);
  }

  // ---------- payments ----------

  function openPaymentSheet() {
    const cardSw = switchField(
      "پرداخت کارت به کارت",
      payment.cardToCardEnabled,
      "مشتری مبلغ را کارت به کارت می‌کند و رسید می‌فرستد",
    );
    const walletSw = switchField(
      "پرداخت با کیف پول",
      payment.walletEnabled,
      "مشتری مبلغ سفارش را از موجودی کیف پولش می‌پردازد",
    );
    const cardF = field("شماره کارت", textInput(payment.cardNumber, { maxlength: 32, inputmode: "numeric", placeholder: "فقط اعداد و خط تیره" }),
      { hint: "مشتری این شماره را برای کارت‌به‌کارت می‌بیند" });
    const nameF = field("به نام", textInput(payment.cardholderName, { maxlength: 100 }));
    const curF = field("واحد پول", textInput(payment.currency || "تومان", { maxlength: 16 }));

    // Card details are only meaningful while card-to-card is on.
    function syncCardFields() {
      const on = cardSw.input.checked;
      cardF.root.hidden = !on;
      nameF.root.hidden = !on;
    }
    cardSw.input.addEventListener("change", syncCardFields);
    syncCardFields();

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      el("div", { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        el("div", { style: "border-bottom:1px solid var(--border)" }, cardSw.root),
        walletSw.root),
      cardF.root,
      nameF.root,
      curF.root,
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      cardF.setError(null);
      saveBtn.disabled = true;
      try {
        payment = await Api.put("/api/admin/settings/payment", {
          cardNumber: cardF.input.value.trim(),
          cardholderName: nameF.input.value.trim(),
          currency: curF.input.value.trim() || "تومان",
          cardToCardEnabled: cardSw.input.checked,
          walletEnabled: walletSw.input.checked,
        });
        currency = payment.currency;
        ProductsPage.setData(currency);
        toast("اطلاعات پرداخت ذخیره شد");
        closeSheet();
        renderSettingsPage();
      } catch (err) {
        const msg = err.message || "ذخیره انجام نشد";
        if (msg.includes("شماره کارت")) cardF.setError(msg);
        else {
          formError.textContent = msg;
          formError.hidden = false;
        }
        saveBtn.disabled = false;
      }
    });

    openSheet("پرداخت", form);
  }

  // ---------- daily report ----------

  function openReportSheet() {
    const enabledSw = switchInput(reportSettings.enabled);
    const timeInput = el("input", { type: "time", value: reportSettings.time || "07:30" });
    const sendEmptySw = switchInput(reportSettings.sendEmpty);
    const chosen = new Set(reportSettings.recipients || []);

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;

    const recipientList = el("div", {});
    function renderRecipients() {
      recipientList.innerHTML = "";
      if (admins.length === 0) {
        recipientList.appendChild(el("div", { class: "field-hint", text: "فهرست مدیران در دسترس نیست." }));
        return;
      }
      for (const a of admins) {
        const cb = el("input", { type: "checkbox" });
        cb.checked = chosen.has(a.id);
        cb.addEventListener("change", () => {
          if (cb.checked) chosen.add(a.id);
          else chosen.delete(a.id);
        });
        recipientList.appendChild(
          el(
            "label",
            { class: "row", style: "cursor:pointer;gap:10px" },
            cb,
            el(
              "div",
              { class: "row-main" },
              el("div", { class: "row-title", text: a.label }),
              a.username
                ? el("div", { class: "row-sub" }, el("span", { class: "ltr", text: `@${a.username}` }))
                : null,
            ),
          ),
        );
      }
    }
    renderRecipients();

    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره تنظیمات" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      el(
        "div",
        { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        el("div", { class: "switch-row", style: "border-bottom:1px solid var(--border)" },
          el("div", { class: "switch-label" }, "گزارش خودکار روزانه", el("div", { class: "switch-sub", text: "هر روز در ساعت تعیین‌شده ارسال می‌شود" })),
          enabledSw.root),
        el("div", { class: "field", style: "margin:12px 0" },
          el("label", {}, "زمان ارسال", timeInput),
          el("div", { class: "field-hint", text: "پیش‌فرض: هر روز ساعت ۰۷:۳۰ به وقت کافه" })),
        el("div", { class: "switch-row" },
          el("div", { class: "switch-label" }, "ارسال در روزهای بدون سفارش", el("div", { class: "switch-sub", text: "گزارش خالی هم ارسال شود" })),
          sendEmptySw.root),
      ),
      el("div", { class: "field-label", text: "مسئول جمع‌آوری سفارش‌های آن روز" }),
      el("div", { class: "field-hint", style: "margin:0 0 8px", text: "گزارش هر روز برای مدیر انتخاب‌شده ارسال می‌شود تا سفارش‌های همان روز را جمع‌آوری و آماده کند." }),
      el("div", { class: "card list-card" }, recipientList),
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      saveBtn.disabled = true;
      try {
        reportSettings = await Api.put("/api/admin/report-settings", {
          enabled: enabledSw.input.checked,
          time: timeInput.value || "07:30",
          sendEmpty: sendEmptySw.input.checked,
          recipients: [...chosen],
        });
        toast("تنظیمات گزارش ذخیره شد");
        closeSheet();
        renderSettingsPage();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    openSheet("گزارش روزانه", form);
  }

  // ---------- data ----------

  function renderSettingsPage() {
    const page = document.getElementById("page-settings");
    render(page);
  }

  async function load() {
    try {
      const [prof, pay, hrs, rep, adminList, ai, notif, memb] = await Promise.all([
        Api.get("/api/admin/me"),
        Api.get("/api/admin/settings/payment"),
        Api.get("/api/admin/business-hours"),
        Api.get("/api/admin/report-settings"),
        Api.get("/api/admin/admins"),
        Api.get("/api/admin/ai-settings"),
        Api.get("/api/admin/notification-settings"),
        Api.get("/api/admin/settings/channel-membership"),
      ]);
      profile = prof;
      payment = pay;
      hours = hrs;
      reportSettings = rep;
      admins = adminList;
      aiSettings = ai;
      notifSettings = notif;
      membershipSettings = memb;
      currency = pay.currency || "تومان";
      renderSettingsPage();
    } catch (err) {
      const page = document.getElementById("page-settings");
      page.innerHTML = "";
      page.appendChild(errorState(err.message, () => void load()));
    }
  }

  return { load, render: renderSettingsPage };

  function aiSummary() {
    if (!aiSettings) return "";
    if (!aiSettings.enabled) return "غیرفعال";
    return "فعال";
  }

  function notifSummary() {
    if (!notifSettings) return "";
    const parts = [];
    parts.push(notifSettings.notifyOrderConfirmed ? "تأیید سفارش: روشن" : "تأیید سفارش: خاموش");
    parts.push(notifSettings.askDeliveryRating ? "امتیاز تحویل: روشن" : "امتیاز تحویل: خاموش");
    parts.push(notifSettings.notifyWalletChanges ? "تغییر کیف پول: روشن" : "تغییر کیف پول: خاموش");
    return parts.join(" · ");
  }

  function membershipSummary() {
    if (!membershipSettings) return "";
    if (!membershipSettings.enabled) return "غیرفعال";
    return membershipSettings.channel ? `فعال · ${membershipSettings.channel}` : "فعال · کانالی تنظیم نشده";
  }

  function openMembershipSheet() {
    const enabledSw = switchField(
      "الزام عضویت در کانال",
      membershipSettings.enabled,
      "مشتریان برای استفاده از ربات باید عضو کانال باشند",
    );
    const channelF = field("شناسه کانال", textInput(membershipSettings.channel || "", { maxlength: 64, placeholder: "@my_cafe_channel یا https://t.me/my_cafe_channel" }), {
      hint: "یوزرنیم عمومی کانال (لینک دعوت پشتیبانی نمی‌شود). ربات باید ادمین کانال باشد.",
    });
    const messageInput = el("textarea", { maxlength: 500, rows: "3" });
    messageInput.value = membershipSettings.messageIsDefault ? "" : membershipSettings.message || "";
    const messageF = field("پیام عضویت (اختیاری)", messageInput, {
      hint: "خالی بگذارید تا پیام پیش‌فرض نمایش داده شود.",
    });

    // The channel link is shown clearly so the operator can verify it.
    const linkPreview = el("div", { class: "field-hint", style: "margin:0 0 12px" });
    function syncLink() {
      if (membershipSettings.channelUrl && !channelF.input.value.trim()) {
        linkPreview.textContent = `لینک عضویت: ${membershipSettings.channelUrl}`;
      } else {
        const raw = channelF.input.value.trim();
        const m = raw.match(/^(?:@|https?:\/\/(?:www\.)?t\.me\/)?([A-Za-z][A-Za-z0-9_]{4,31})/);
        linkPreview.textContent = m ? `لینک عضویت: https://t.me/${m[1]}` : "";
      }
    }
    channelF.input.addEventListener("input", syncLink);
    syncLink();

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      el("div", { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        enabledSw.root),
      channelF.root,
      linkPreview,
      messageF.root,
      el("div", { class: "field-hint", style: "margin:0 0 12px",
        text: "نکته: برای بررسی عضویت، ربات باید در کانال عضو و ادمین باشد (دسترسی «مشاهده اعضا»). در غیر این صورت وضعیت «بررسی ناموفق» نمایش داده می‌شود و مشتریان مسدود نمی‌شوند." }),
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      saveBtn.disabled = true;
      try {
        membershipSettings = await Api.put("/api/admin/settings/channel-membership", {
          enabled: enabledSw.input.checked,
          channel: channelF.input.value.trim(),
          message: messageInput.value.trim(),
        });
        toast("تنظیمات عضویت کانال ذخیره شد");
        closeSheet();
        renderSettingsPage();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    openSheet("عضویت کانال", form);
  }

  function openAiSheet() {
    const personaInput = el("textarea", { maxlength: 4000, rows: "6" });
    personaInput.value = aiSettings.persona || "";
    const personaF = field("شخصیت دستیار", personaInput, {
      hint: "سبک پاسخ‌گویی (زبان، لحن، ایموجی). قوانین امنیتی و سفارش‌گیری همیشه در کد قفل هستند و از اینجا تغییر نمی‌کنند.",
    });
    const enabledSw = switchField("پاسخ‌گویی متنی", aiSettings.enabled, "پاسخ به پیام‌های متنی مشتری با هوش مصنوعی");
    const greetSw = switchField("سلام شخصی‌سازی‌شده با نام مشتری", aiSettings.personalizeGreeting);
    const usualSw = switchField("پیشنهاد سفارش‌های تکراری", aiSettings.suggestUsual);
    const streamSw = switchField("نمایش تدریجی پاسخ", aiSettings.streaming);
    const lenSelect = el(
      "select",
      {},
      el("option", { value: "concise", text: "کوتاه" }),
      el("option", { value: "normal", text: "معمولی" }),
      el("option", { value: "detailed", text: "با جزئیات" }),
    );
    lenSelect.value = aiSettings.replyLength || "normal";
    const lenF = field("طول پاسخ", lenSelect);

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      el("div", { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        el("div", { style: "border-bottom:1px solid var(--border)" }, enabledSw.root),
        greetSw.root,
        el("div", { style: "border-top:1px solid var(--border)" }, usualSw.root),
        el("div", { style: "border-top:1px solid var(--border)" }, streamSw.root)),
      personaF.root,
      lenF.root,
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      saveBtn.disabled = true;
      try {
        aiSettings = await Api.put("/api/admin/ai-settings", {
          enabled: enabledSw.input.checked,
          persona: personaInput.value,
          replyLength: lenSelect.value,
          personalizeGreeting: greetSw.input.checked,
          suggestUsual: usualSw.input.checked,
          streaming: streamSw.input.checked,
        });
        toast("تنظیمات هوش مصنوعی ذخیره شد");
        closeSheet();
        await refresh();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });
    openSheet("تنظیمات هوش مصنوعی", form);
  }

  function openNotifSheet() {
    const confirmSw = switchField("اطلاع به مشتری هنگام تأیید سفارش", notifSettings.notifyOrderConfirmed);
    const ratingSw = switchField("درخواست امتیاز پس از تحویل", notifSettings.askDeliveryRating);
    const walletSw = switchField(
      "اطلاع به مشتری هنگام تغییر کیف پول",
      notifSettings.notifyWalletChanges,
      "تأیید شارژ کارت به کارت و افزایش/کاهش موجودی توسط مدیر",
    );
    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: "ذخیره" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      el("div", { class: "card", style: "padding:4px 14px;margin-bottom:14px" },
        el("div", { style: "border-bottom:1px solid var(--border)" }, confirmSw.root),
        el("div", { style: "border-bottom:1px solid var(--border)" }, ratingSw.root),
        walletSw.root),
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      saveBtn.disabled = true;
      try {
        notifSettings = await Api.put("/api/admin/notification-settings", {
          notifyOrderConfirmed: confirmSw.input.checked,
          askDeliveryRating: ratingSw.input.checked,
          notifyWalletChanges: walletSw.input.checked,
        });
        toast("تنظیمات اعلان ذخیره شد");
        closeSheet();
        await refresh();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });
    openSheet("اعلان‌های مشتری", form);
  }

  // Hook the extra loads into the page refresh cycle.
  const _origLoad = typeof load === "function" ? load : null;
  void _origLoad;
})();