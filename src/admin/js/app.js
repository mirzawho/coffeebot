/* Cafe admin Mini App — bootstrap, routing, app bar. Vanilla JS, no bundler. */

(() => {
  const { el, icons, toast, initChrome } = Ui;

  const state = {
    page: "reports",
    me: null, // validated identity + app context from /api/admin/me
  };

  const PAGES = {
    reports: {
      title: "گزارش‌ها",
      icon: icons.chart,
      label: "گزارش‌ها",
      hasCreate: false,
      refresh: () => ReportsPage.refresh(),
    },
    products: {
      title: "محصولات",
      icon: icons.cup,
      label: "محصولات",
      hasCreate: true,
      refresh: () => ProductsPage.refresh(),
    },
    settings: {
      title: "تنظیمات",
      icon: icons.gear,
      label: "تنظیمات",
      hasCreate: false,
      refresh: () => SettingsPage.load(),
    },
  };

  function switchPage(name) {
    if (!PAGES[name]) return;
    state.page = name;
    for (const key of Object.keys(PAGES)) {
      document.getElementById(`page-${key}`).hidden = key !== name;
    }
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.page === name);
    });
    const cfg = PAGES[name];
    document.getElementById("appbar-title").textContent = cfg.title;
    document.getElementById("btn-create").hidden = !cfg.hasCreate;
    void cfg.refresh();
  }

  function showFatal(message) {
    for (const key of Object.keys(PAGES)) {
      const page = document.getElementById(`page-${key}`);
      page.hidden = key !== state.page;
      page.innerHTML = "";
      if (key === state.page) page.appendChild(Ui.errorState(message));
    }
  }

  function wireChrome() {
    initChrome();

    // bottom navigation
    document.querySelectorAll(".nav-item").forEach((btn) => {
      const cfg = PAGES[btn.dataset.page];
      btn.innerHTML = `${cfg.icon}<span>${cfg.label}</span>`;
      btn.addEventListener("click", () => switchPage(btn.dataset.page));
    });

    document.getElementById("btn-refresh").addEventListener("click", () => {
      void PAGES[state.page].refresh();
    });
    document.getElementById("btn-create").addEventListener("click", () => {
      if (state.page === "products") ProductsPage.openCreateMenu();
    });
  }

  async function boot() {
    wireChrome();
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      if (typeof tg.setHeaderColor === "function") tg.setHeaderColor("#ffffff");
    }

    // Bootstrap: identity (validated server-side) + app context.
    try {
      state.me = await Api.get("/api/admin/me");
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        showFatal("برای استفاده از پنل مدیریت، آن را از داخل ربات تلگرام باز کنید.");
        toast("دسترسی غیرمجاز", true);
        return;
      }
      showFatal("ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید و دوباره تلاش کنید.");
      return;
    }

    ProductsPage.setData(state.me.currency);
    ReportsPage.init(state.me.businessDate);
    switchPage("reports");
  }

  document.addEventListener("DOMContentLoaded", () => void boot());
})();
