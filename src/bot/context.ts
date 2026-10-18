import type { Config } from "../config";
import type { Db } from "../db/database";
import type { MenuService } from "../services/menu";
import type { CartService } from "../services/cart";
import type { OrdersService } from "../services/orders";
import type { BusinessHoursService } from "../services/business-hours";
import type { AiService } from "../services/ollama";
import type { TokenService } from "./tokens";
import type { CustomersService } from "../services/customers";
import type { LoyaltyService } from "../services/loyalty";
import type { NotificationService } from "../services/notifications";
import type { ChannelMembershipService } from "../services/membership";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Named per-user capture flows. A user in an active flow has their next text
 * consumed by the flow instead of the AI. `step` lets multi-field wizards
 * (profile edit, checkout fulfillment) know which question was last asked.
 */
export class TextCaptureFlow {
  private active = new Map<number, string>();
  expect(userId: number, step = "default"): void {
    this.active.set(userId, step);
  }
  isActive(userId: number): boolean {
    return this.active.has(userId);
  }
  step(userId: number): string {
    return this.active.get(userId) ?? "default";
  }
  clear(userId: number): void {
    this.active.delete(userId);
  }
}

/** Everything the bot handlers need, injected once at startup. */
export interface BotApp {
  db: Db;
  config: Config;
  menu: MenuService;
  cart: CartService;
  orders: OrdersService;
  businessHours: BusinessHoursService;
  ai: AiService;
  tokens: TokenService;
  /** Bounded per-user AI conversation history (in-memory). */
  history: Map<number, ChatTurn[]>;
  /** Editable persona text (style only), loaded once at startup. */
  persona: string;
  customers: CustomersService;
  loyalty: LoyaltyService;
  /** Durable customer notifications (payment review outcomes). */
  notifications: NotificationService;
  /** Telegram channel membership enforcement (settings + verification cache). */
  membership: ChannelMembershipService;
  /** Multi-step profile wizard (name → phone → address). */
  profileEdit: TextCaptureFlow;
  /** Next text message is captured as a wallet deposit amount. */
  depositFlow: TextCaptureFlow;
  /** Next admin text is the rejection reason for the order id in `step`. */
  rejectReasonFlow: TextCaptureFlow;
}

const HISTORY_CAP = 300;

export function pushHistory(app: BotApp, userId: number, turn: ChatTurn): void {
  let list = app.history.get(userId);
  if (!list) {
    list = [];
    app.history.set(userId, list);
  }
  list.push(turn);
  if (list.length > 12) list.splice(0, list.length - 12);
  if (app.history.size > HISTORY_CAP) {
    const first = app.history.keys().next().value;
    if (first !== undefined && first !== userId) app.history.delete(first);
  }
}
