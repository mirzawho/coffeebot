/* Products page: category-oriented list, category sheet, product form sheet. */
"use strict";

const ProductsPage = (() => {
  const { el, icons, toast, openSheet, closeSheet, field, textInput, numberInput,
    parseDigits, segmented, moneyWithCurrency, esc } = Ui;

  let categories = [];
  let products = [];
  let currency = "تومان";
  let onListChanged = null; // set by app.js: refreshes list + summary

  function setData(cur) {
    currency = cur || "تومان";
  }

  // ---------- list ----------

  function productsOf(catId) {
    return products.filter((p) => p.categoryId === catId);
  }

  function priceLabel(p) {
    const activeVariants = p.variants.filter((v) => v.active);
    if (activeVariants.length > 0) {
      const prices = activeVariants.map((v) => v.priceAmount);
      const min = Math.min(...prices);
      return prices.length > 1 ? `از ${moneyWithCurrency(min, currency)}` : moneyWithCurrency(min, currency);
    }
    if (p.fixedPriceAmount != null) return moneyWithCurrency(p.fixedPriceAmount, currency);
    return "بدون قیمت";
  }

  function productRow(p) {
    const thumb = p.imagePath
      ? el("span", { class: "thumb" }, el("img", { src: `/${esc(p.imagePath)}`, alt: "", loading: "lazy" }))
      : el("span", { class: "thumb", html: icons.cup });
    if (!p.active) thumb.classList.add("dim");
    const badge = p.active
      ? el("span", { class: "badge" }, el("span", { html: icons.check, style: "width:12px;height:12px;display:flex" }), "موجود")
      : el("span", { class: "badge off" }, el("span", { html: icons.slash, style: "width:12px;height:12px;display:flex" }), "ناموجود");
    return el(
      "button",
      { class: "row tappable", type: "button", onClick: () => openProductForm(p) },
      thumb,
      el(
        "div",
        { class: "row-main" },
        el("div", { class: "row-title", text: p.name }),
        el("div", { class: "row-sub", text: priceLabel(p) }),
      ),
      el("span", { class: "row-end" }, badge),
    );
  }

  function render(container) {
    container.innerHTML = "";

    if (categories.length === 0) {
      container.appendChild(
        Ui.emptyState(
          "هنوز دسته‌بندی‌ای وجود ندارد",
          "برای شروع، اول یک دسته‌بندی بسازید و سپس محصولات را به آن اضافه کنید.",
          { label: "افزودن دسته‌بندی", onClick: () => openCategoryForm(null) },
        ),
      );
      return;
    }

    for (const cat of categories) {
      const items = productsOf(cat.id);
      container.appendChild(
        el(
          "div",
          { class: "cat-head" },
          el(
            "h2",
            {},
            cat.name,
            el("span", { class: "cat-count", text: items.length ? `(${Ui.faDigits(items.length)} محصول)` : "" }),
            cat.active ? null : el("span", { class: "badge off", text: "غیرفعال", style: "margin-inline-start:6px" }),
          ),
          el("button", {
            class: "icon-btn",
            type: "button",
            "aria-label": "ویرایش دسته‌بندی",
            html: icons.pencil,
            onClick: () => openCategoryForm(cat),
          }),
        ),
      );
      const card = el("div", { class: "card list-card" });
      if (items.length === 0) {
        card.appendChild(
          el(
            "div",
            { class: "cat-empty row" },
            el("div", { class: "row-main" }, el("span", { text: "بدون محصول" })),
            el("button", {
              class: "btn small secondary",
              type: "button",
              text: "افزودن محصول",
              onClick: () => openProductForm(null, cat.id),
            }),
          ),
        );
      } else {
        for (const p of items) card.appendChild(productRow(p));
      }
      container.appendChild(card);
    }
  }

  // ---------- data ----------

  async function load() {
    [categories, products] = await Promise.all([
      Api.get("/api/admin/categories"),
      Api.get("/api/admin/products"),
    ]);
  }

  // ---------- category form ----------

  function openCategoryForm(cat, onSuccess) {
    const nameF = field("نام دسته‌بندی", textInput(cat ? cat.name : "", { maxlength: 120, placeholder: "مثلاً نوشیدنی گرم" }), {
      required: true,
    });
    const formError = el("div", { class: "form-error" });
    formError.hidden = true;
    const saveBtn = el("button", { class: "btn", type: "submit", text: cat ? "ذخیره تغییرات" : "افزودن دسته‌بندی" });

    const form = el(
      "form",
      { novalidate: "" },
      formError,
      nameF.root,
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    if (cat) {
      const delBtn = el("button", { class: "btn danger", type: "button", text: "حذف دسته‌بندی", style: "margin-top:12px" });
      delBtn.addEventListener("click", async () => {
        if (!confirm("دسته‌بندی حذف شود؟ دسته‌بندی‌هایی که محصول دارند قابل حذف نیستند.")) return;
        delBtn.disabled = true;
        try {
          await Api.del(`/api/admin/categories/${cat.id}`);
          toast("دسته‌بندی حذف شد");
          closeSheet();
          await refresh();
        } catch (err) {
          toast(err.message || "حذف انجام نشد", true);
          delBtn.disabled = false;
        }
      });
      form.appendChild(delBtn);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      nameF.setError(null);
      const name = nameF.input.value.trim();
      if (!name) {
        nameF.setError("نام دسته‌بندی را وارد کنید");
        return;
      }
      saveBtn.disabled = true;
      try {
        if (cat) {
          await Api.put(`/api/admin/categories/${cat.id}`, { name });
          toast("دسته‌بندی به‌روزرسانی شد");
        } else {
          await Api.post("/api/admin/categories", { name });
          toast("دسته‌بندی افزوده شد");
        }
        closeSheet();
        await refresh();
        if (onSuccess) onSuccess();
      } catch (err) {
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    openSheet(cat ? "ویرایش دسته‌بندی" : "افزودن دسته‌بندی", form);
  }

  // ---------- product form ----------

  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

  function openProductForm(product, presetCategoryId) {
    if (categories.length === 0) {
      // Category-first rule: nothing to attach a product to.
      const box = el(
        "div",
        {},
        el("p", { style: "margin:0 0 12px;color:var(--muted);font-size:13.5px" },
          "برای افزودن محصول، ابتدا باید یک دسته‌بندی داشته باشید."),
        el("button", {
          class: "btn", type: "button", text: "افزودن دسته‌بندی",
          onClick: () => openCategoryForm(null, () => openProductForm(product, presetCategoryId)),
        }),
      );
      openSheet("افزودن محصول", box);
      return;
    }

    const isEdit = !!product;
    let selectedCategoryId = isEdit ? product.categoryId : (presetCategoryId ?? null);
    let selectedFile = null; // pending image upload
    let previewUrl = null;
    let removeImage = false;
    // Declared early: the price/after-hours fields below branch on it.
    const hasVariants = isEdit && product.variants.length > 0;

    const formError = el("div", { class: "form-error" });
    formError.hidden = true;

    // 1. category
    const catSelect = el(
      "select",
      {},
      el("option", { value: "", text: "دسته‌بندی را انتخاب کنید" }),
      ...categories.map((c) =>
        el("option", { value: String(c.id), text: c.active ? c.name : `${c.name} (غیرفعال)` }),
      ),
    );
    if (selectedCategoryId != null) catSelect.value = String(selectedCategoryId);
    const catF = field("دسته‌بندی", catSelect, { required: true });
    catSelect.addEventListener("change", () => {
      selectedCategoryId = catSelect.value ? Number(catSelect.value) : null;
      catF.setError(null);
    });

    // 2. image
    const fileInput = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", style: "display:none" });
    const previewBox = el("div", { class: "preview" });
    const pickBtn = el("button", { class: "btn small secondary", type: "button", text: "انتخاب تصویر" });
    const removeBtn = el("button", { class: "btn small danger", type: "button", text: "حذف تصویر" });
    const imageF = field(
      "تصویر محصول",
      el("div", { class: "image-picker" }, previewBox, el("div", { class: "picker-actions" }, pickBtn, removeBtn, fileInput)),
      { hint: "JPEG، PNG یا WebP — حداکثر ۲ مگابایت" },
    );

    function refreshImageUi() {
      previewBox.innerHTML = "";
      const url = selectedFile ? previewUrl : isEdit && product.imagePath && !removeImage ? `/${product.imagePath}` : null;
      if (url) previewBox.appendChild(el("img", { src: url, alt: "پیش‌نمایش تصویر محصول" }));
      else previewBox.innerHTML = icons.image;
      removeBtn.hidden = !(isEdit && product.imagePath && !removeImage) && !selectedFile;
      pickBtn.textContent = url ? "تغییر تصویر" : "انتخاب تصویر";
    }

    pickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      if (!IMAGE_TYPES.includes(file.type)) {
        imageF.setError("فقط فایل JPEG، PNG یا WebP پذیرفته می‌شود");
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        imageF.setError("حجم تصویر باید کمتر از ۲ مگابایت باشد");
        return;
      }
      imageF.setError(null);
      selectedFile = file;
      removeImage = false;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      refreshImageUi();
    });
    removeBtn.addEventListener("click", () => {
      selectedFile = null;
      removeImage = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      refreshImageUi();
    });

    // 3. name
    const nameF = field("نام محصول", textInput(isEdit ? product.name : "", { maxlength: 120, placeholder: "مثلاً کاپوچینو" }), {
      required: true,
    });

    // 4. description — feeds the AI assistant context
    const descInput = el("textarea", { maxlength: 2000, rows: "4", placeholder: "مثلاً: قهوه‌ای با شیر بخارزده و کف نرم؛ بدون کافئین نداریم." });
    descInput.value = isEdit ? product.description || "" : "";
    const descF = field("توضیحات محصول", descInput, {
      hint: "این توضیحات به هوش مصنوعی کمک می‌کند محصول را بهتر بشناسد و به سؤال‌های مشتریان پاسخ دهد.",
    });

    // 4b. optional emoji (shown in the bot and AI suggestions)
    const emojiInput = textInput(isEdit && product.emoji ? product.emoji : "", { maxlength: 8, placeholder: "☕" });
    const emojiF = field("ایموجی محصول", emojiInput, { hint: "اختیاری — در ربات و پیشنهادهای هوش مصنوعی نمایش داده می‌شود." });

    // 5b. optional after-hours price (empty = regular price applies)
    let afterHoursInput = null;
    let afterHoursF = null;
    if (!hasVariants) {
      const ahWrap = el("div", { class: "price-wrap" });
      afterHoursInput = numberInput(isEdit && product.afterHoursPriceAmount != null ? product.afterHoursPriceAmount : "", {
        placeholder: "مثلاً ۹۵۰۰۰",
      });
      ahWrap.appendChild(afterHoursInput);
      ahWrap.appendChild(el("span", { class: "suffix", text: currency || "تومان" }));
      afterHoursF = field("قیمت خارج از ساعت کاری", ahWrap, {
        hint: "اختیاری — اگر خالی بماند، همان قیمت عادی اعمال می‌شود.",
      });
    }

    // 5. price (skipped when the product has variants — prices live on variants)
    let priceF = null;
    let priceInput = null;
    if (!hasVariants) {
      const wrap = el("div", { class: "price-wrap" });
      priceInput = numberInput(isEdit && product.fixedPriceAmount != null ? product.fixedPriceAmount : "", {
        placeholder: "مثلاً ۸۰۰۰۰",
      });
      wrap.appendChild(priceInput);
      wrap.appendChild(el("span", { class: "suffix", text: currency || "تومان" }));
      priceF = field("قیمت", wrap, { required: true });
    }

    // 6. availability
    const avail = segmented(
      [
        { value: true, label: "موجود", icon: icons.check, cls: "on" },
        { value: false, label: "ناموجود", icon: icons.slash, cls: "off" },
      ],
      isEdit ? product.active : true, // new products default to موجود (existing business rule)
    );
    const availF = field("وضعیت موجودی", avail.root);

    // variants info for existing variant products
    let variantsBox = null;
    if (hasVariants) {
      variantsBox = el(
        "div",
        { class: "card", style: "padding:10px 12px;margin-bottom:14px" },
        el("div", { class: "field-label", text: "قیمت‌ها" }),
        el("div", { style: "font-size:13px;color:var(--muted)" },
          `${Ui.faDigits(product.variants.filter((v) => v.active).length)} قیمت فعال — قیمت‌گذاری از بخش ویرایش واریانت‌ها انجام می‌شود.`),
      );
    }

    // save
    const saveBtn = el("button", { class: "btn", type: "submit", text: isEdit ? "ذخیره تغییرات" : "افزودن محصول" });
    const form = el(
      "form",
      { novalidate: "" },
      formError,
      catF.root,
      imageF.root,
      nameF.root,
      descF.root,
      emojiF.root,
      variantsBox,
      priceF ? priceF.root : null,
      afterHoursF ? afterHoursF.root : null,
      availF.root,
      el("div", { class: "form-actions" }, saveBtn, el("button", { class: "btn ghost", type: "button", text: "انصراف", onClick: closeSheet })),
    );

    async function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError.hidden = true;
      catF.setError(null);
      nameF.setError(null);
      if (priceF) priceF.setError(null);

      // validation
      if (selectedCategoryId == null) {
        catF.setError("دسته‌بندی را انتخاب کنید");
        return;
      }
      const name = nameF.input.value.trim();
      if (!name) {
        nameF.setError("نام محصول را وارد کنید");
        return;
      }
      let fixedPrice = null;
      if (!hasVariants) {
        const raw = parseDigits(priceInput.value);
        if (raw === "") {
          priceF.setError("قیمت را وارد کنید");
          return;
        }
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          priceF.setError("قیمت باید عدد صحیح غیرمنفی باشد");
          return;
        }
        fixedPrice = raw;
      }
      let afterHoursPrice;
      if (!hasVariants) {
        const rawAh = parseDigits(afterHoursInput.value);
        if (rawAh !== "" && (!/^\d+$/.test(rawAh) || !Number.isSafeInteger(Number(rawAh)))) {
          afterHoursF.setError("قیمت خارج از ساعت کاری باید عدد صحیح غیرمنفی باشد");
          return;
        }
        afterHoursPrice = rawAh === "" ? null : rawAh;
      }

      saveBtn.disabled = true;
      try {
        let saved;
        if (isEdit) {
          saved = await Api.put(`/api/admin/products/${product.id}`, {
            categoryId: selectedCategoryId,
            name,
            description: descInput.value,
            fixedPriceAmount: hasVariants ? undefined : fixedPrice,
            afterHoursPriceAmount: hasVariants ? undefined : afterHoursPrice,
            emoji: emojiInput.value.trim() || null,
            active: avail.value(),
          });
          if (removeImage && product.imagePath) {
            await Api.del(`/api/admin/products/${product.id}/image`);
          }
        } else {
          saved = await Api.post("/api/admin/products", {
            categoryId: selectedCategoryId,
            name,
            description: descInput.value,
            fixedPriceAmount: fixedPrice,
            afterHoursPriceAmount: afterHoursPrice,
            emoji: emojiInput.value.trim() || null,
            active: avail.value(),
          });
        }
        if (selectedFile) {
          const b64 = await fileToBase64(selectedFile);
          await Api.post(`/api/admin/products/${saved.id}/image`, { dataBase64: b64, mime: selectedFile.type });
        }
        toast(isEdit ? "محصول به‌روزرسانی شد" : "محصول افزوده شد");
        closeSheet();
        await refresh();
      } catch (err) {
        // Keep the admin's input; show a useful message near the top of the form.
        formError.textContent = err.message || "ذخیره انجام نشد";
        formError.hidden = false;
        saveBtn.disabled = false;
      }
    });

    refreshImageUi();
    openSheet(isEdit ? "ویرایش محصول" : "افزودن محصول", form);
  }

  // ---------- public ----------

  async function refresh() {
    await load();
    const page = document.getElementById("page-products");
    render(page);
    if (onListChanged) onListChanged();
  }

  function setOnChange(fn) {
    onListChanged = fn;
  }

  /** App-bar "+" action menu. */
  function openCreateMenu() {
    const box = el(
      "div",
      { class: "sheet-menu" },
      el("button", { class: "btn secondary", type: "button", onClick: () => { closeSheet(); openCategoryForm(null); } },
        el("span", { html: icons.plus, style: "width:20px;height:20px;display:flex" }), "افزودن دسته‌بندی"),
      el("button", { class: "btn secondary", type: "button", onClick: () => { closeSheet(); openProductForm(null); } },
        el("span", { html: icons.cup, style: "width:20px;height:20px;display:flex" }), "افزودن محصول"),
    );
    openSheet("افزودن", box);
  }

  return { setData, refresh, openCreateMenu, setOnChange };
})();
