import type { Config } from "../config";
import type { Db } from "../db/database";
import type { MenuService } from "../services/menu";
import type { OrdersService } from "../services/orders";
import type { BusinessHoursService } from "../services/business-hours";
import type { ReportService } from "../services/reports";
import type { NotificationService } from "../services/notifications";
import type { CustomersService } from "../services/customers";
import type { LoyaltyService } from "../services/loyalty";

export interface ApiApp {
  config: Config;
  db: Db;
  menu: MenuService;
  orders: OrdersService;
  businessHours: BusinessHoursService;
  reports: ReportService;
  notifications: NotificationService;
  /** Absolute directory for uploaded product images (inside the data volume). */
  uploadsDir: string;
  customers: CustomersService;
  loyalty: LoyaltyService;
  /**
   * Telegram bot, used only to resolve receipt file_ids into image bytes for
   * the admin panel. Optional so tests can build an ApiApp without a network.
   */
  bot?: { api: { getFile(fileId: string): Promise<{ file_path?: string }> } };
}
