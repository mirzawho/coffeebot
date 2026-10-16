import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { openDatabase } from "./db/database";
import { setLogLevel, log } from "./utils/logger";
import { MenuService } from "./services/menu";
import { CartService } from "./services/cart";
import { OrdersService } from "./services/orders";
import { BusinessHoursService } from "./services/business-hours";
import { ReportService } from "./services/reports";
import { NotificationService } from "./services/notifications";
import { createAiService } from "./services/ollama";
import { loadPersona } from "./services/persona";
import { CustomersService } from "./services/customers";
import { LoyaltyService } from "./services/loyalty";
import { getReportSettings, getSetting, setSetting } from "./services/settings";
import { TokenService } from "./bot/tokens";
import { createBot, startBot } from "./bot/index";
import { configureAdminMenuButtons } from "./bot/admin-entry";
import type { BotApp } from "./bot/context";
import { TextCaptureFlow } from "./bot/context";
import { createHttpServer } from "./api/server";
import type { ApiApp } from "./api/context";
import { Scheduler } from "./scheduler";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const db = openDatabase(config.databasePath);
  log.info("database ready", { path: config.databasePath });

  const businessHours = new BusinessHoursService(db, config.timezone);
  const menu = new MenuService(db);
  const cart = new CartService(db);
  const orders = new OrdersService(db, businessHours);
  const notifications = new NotificationService(db);
  const reports = new ReportService(db, businessHours, notifications, config.timezone);
  const tokens = new TokenService(db);
  const customers = new CustomersService(db);
  const loyalty = new LoyaltyService(db);

  // AI is enabled whenever an Ollama endpoint is configured (base URL + model).
  // An empty API key does NOT disable it: local Ollama needs no key, and a
  // missing/invalid key against a cloud endpoint surfaces as a real auth
  // failure at request time (handled as "unavailable", never as "disabled").
  // Blank OLLAMA_BASE_URL to opt out of text AI entirely.
  const ai = createAiService({
    apiKey: config.ollamaApiKey,
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    proxy: config.outboundProxyUrl || undefined,
  });
  if (config.ollamaBaseUrl && config.ollamaModel) {
    log.info("ai enabled", {
      model: config.ollamaModel,
      baseUrl: config.ollamaBaseUrl,
      authConfigured: Boolean(config.ollamaApiKey),
    });
  } else {
    log.warn("ai disabled", { reason: "OLLAMA_BASE_URL / OLLAMA_MODEL not configured" });
  }

  // Editable persona (style only). The admin panel persists it in the settings
  // table (ai_persona); the file is the bootstrap default. Seed the setting from
  // the file once so the panel starts from a real value, then the DB wins.
  const persona = loadPersona(config.aiPersonaFile, config.databasePath);
  log.info("persona loaded", {
    path: persona.path,
    fallback: persona.fallback,
    seeded: persona.seeded,
  });
  if (!getSetting(db, "ai_persona").trim()) {
    setSetting(db, "ai_persona", persona.text);
  }

  const botApp: BotApp = {
    db,
    config,
    menu,
    cart,
    orders,
    businessHours,
    ai,
    tokens,
    history: new Map(),
    persona: persona.text,
    customers,
    loyalty,
    profileEdit: new TextCaptureFlow(),
    depositFlow: new TextCaptureFlow(),
    fulfillmentTimeFlow: new TextCaptureFlow(),
  };

  const bot = createBot(botApp);

  const uploadsDir = join(dirname(config.databasePath), "uploads");
  mkdirSync(uploadsDir, { recursive: true });

  const apiApp: ApiApp = {
    config,
    db,
    menu,
    orders,
    businessHours,
    reports,
    notifications,
    uploadsDir,
    customers,
    loyalty,
    // Used only to resolve receipt file_ids into image bytes for the panel.
    bot,
  };

  const httpServer = createHttpServer(apiApp);
  log.info("http server listening", { port: httpServer.port });

  const scheduler = new Scheduler({ db, bot, reports, notifications, businessHours, orders });
  scheduler.start();

  // Warn if report has recipients that are not admins (config drift).
  const rs = getReportSettings(db);
  for (const r of rs.recipients) {
    if (!config.adminIds.has(r)) {
      log.warn("report recipient not in ADMIN_IDS; deliveries will fail", { recipient: r });
    }
  }

  // Supervised bot startup: retries transient failures; a permanent failure is
  // logged loudly and reflected in /health (bot: failed). The HTTP server and
  // scheduler keep running so operators can still reach the admin panel.
  void startBot(bot).then((result) => {
    if (result === "failed") {
      log.error("bot is not running; customer ordering unavailable until restart or network recovery");
      return;
    }
    // Best-effort admin entry point: point each admin's chat menu button at the
    // Mini App. Failures are logged and never stop the customer bot; /admin
    // remains a usable fallback.
    void configureAdminMenuButtons(bot, botApp);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    scheduler.stop();
    try {
      bot.stop();
    } catch {
      /* bot may not be running yet */
    }
    httpServer.stop(true);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
