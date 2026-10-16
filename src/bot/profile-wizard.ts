import type { Context } from "grammy";
import type { BotApp } from "./context";
import { mainMenu, profileWizardKeyboard } from "./keyboards";
import { MAX_ADDRESS_LENGTH, normalizePhone } from "../services/customers";
import { toPersianDigits } from "../utils/dates";

/**
 * Step-by-step profile wizard (name → phone → optional address). Answers are
 * validated as they arrive; the phone must match the mobile pattern (Persian
 * digits are converted). Every step carries inline buttons (لغو / بعدی /
 * تأیید) so the customer never has to type a command.
 */

export type ProfileStep = "name" | "phone" | "address";

interface WizardState {
  fullName?: string;
  phone?: string;
  address?: string | null;
}

const wizardState = new Map<number, WizardState>();
const MAX_PROFILE_NAME_LENGTH = 80;
const SKIP_RE = /^(رد|نه|خیر|-|—|skip|هیچ)$/i;

/** Begin (or restart) the wizard, seeded with the saved profile. */
export async function startProfileWizard(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const p = app.customers.getProfile(userId);
  wizardState.set(userId, {
    fullName: p?.fullName || undefined,
    phone: p?.phone ?? undefined,
    address: p?.address ?? null,
  });
  app.profileEdit.expect(userId, "name");
  await askStep(ctx, app, "name");
}

/** Send the prompt + buttons for one step. */
async function askStep(ctx: Context, app: BotApp, step: ProfileStep): Promise<void> {
  const userId = ctx.from!.id;
  const state = wizardState.get(userId) ?? {};
  const lines: Record<ProfileStep, string[]> = {
    name: [
      "✏️ ویرایش پروفایل — ۱ از ۳",
      "",
      "نام و نام خانوادگی خود را بفرستید:",
      state.fullName ? `نام فعلی: ${state.fullName}` : "",
    ],
    phone: [
      "✏️ ویرایش پروفایل — ۲ از ۳",
      "",
      "شماره موبایل خود را بفرستید (مثلاً ۰۹۱۲۳۴۵۶۷۸۹):",
      state.phone ? `شماره فعلی: ${toPersianDigits(state.phone)}` : "",
    ],
    address: [
      "✏️ ویرایش پروفایل — ۳ از ۳",
      "",
      "آدرس محل تحویل را بنویسید (اختیاری):",
      state.address ? `آدرس فعلی: ${state.address}` : "",
    ],
  };
  await ctx.reply(lines[step].filter(Boolean).join("\n"), {
    reply_markup: profileWizardKeyboard(step, canSkip(step, state)),
  });
}

/** A field can only be skipped when there is a saved value to keep. */
function canSkip(step: ProfileStep, state: WizardState): boolean {
  if (step === "name") return !!state.fullName;
  if (step === "phone") return !!state.phone;
  return true; // the address is optional
}

/** Consume a text answer for the current step. */
export async function handleProfileWizardText(
  ctx: Context,
  app: BotApp,
  text: string,
  step: string,
): Promise<void> {
  const userId = ctx.from!.id;
  const state = wizardState.get(userId) ?? {};

  if (step === "name") {
    const name = text.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
    if (name.length < 2) {
      await ctx.reply("نام واردشده کوتاه است. لطفاً نام و نام خانوادگی را کامل بفرستید:");
      app.profileEdit.expect(userId, "name");
      return;
    }
    state.fullName = name;
    wizardState.set(userId, state);
    app.profileEdit.expect(userId, "phone");
    await askStep(ctx, app, "phone");
    return;
  }

  if (step === "phone") {
    const phone = normalizePhone(text);
    if (!phone) {
      await ctx.reply("شماره موبایل معتبر نیست. لطفاً یک شماره ۱۱ رقمی مثل ۰۹۱۲۳۴۵۶۷۸۹ بفرستید:");
      app.profileEdit.expect(userId, "phone");
      return;
    }
    state.phone = phone;
    wizardState.set(userId, state);
    app.profileEdit.expect(userId, "address");
    await askStep(ctx, app, "address");
    return;
  }

  if (step === "address") {
    state.address = SKIP_RE.test(text.trim())
      ? null
      : text.trim().slice(0, MAX_ADDRESS_LENGTH) || null;
    wizardState.set(userId, state);
    await finishWizard(ctx, app);
    return;
  }

  app.profileEdit.clear(userId);
}

/** «بعدی» / «رد کردن»: keep the current value and advance. */
export async function profileWizardSkip(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  if (!app.profileEdit.isActive(userId)) {
    await ctx.answerCallbackQuery({ text: "این مرحله دیگر معتبر نیست", show_alert: true });
    return;
  }
  const step = app.profileEdit.step(userId) as ProfileStep;
  const state = wizardState.get(userId) ?? {};
  if (step === "name") {
    if (!state.fullName) {
      await ctx.answerCallbackQuery({
        text: "نام الزامی است؛ لطفاً نام خود را بنویسید",
        show_alert: true,
      });
      return;
    }
    app.profileEdit.expect(userId, "phone");
    await askStep(ctx, app, "phone");
    return;
  }
  if (step === "phone") {
    if (!state.phone) {
      await ctx.answerCallbackQuery({
        text: "شماره موبایل الزامی است؛ لطفاً شماره خود را بنویسید",
        show_alert: true,
      });
      return;
    }
    app.profileEdit.expect(userId, "address");
    await askStep(ctx, app, "address");
    return;
  }
  state.address = null;
  wizardState.set(userId, state);
  await finishWizard(ctx, app);
}

/** «تأیید»: save whatever has been collected. */
export async function profileWizardConfirm(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  if (!app.profileEdit.isActive(userId)) {
    await ctx.answerCallbackQuery({ text: "این مرحله دیگر معتبر نیست", show_alert: true });
    return;
  }
  await finishWizard(ctx, app);
}

/** «لغو»: abort the wizard without saving. */
export async function profileWizardCancel(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  app.profileEdit.clear(userId);
  wizardState.delete(userId);
  await ctx.reply("ویرایش پروفایل لغو شد.", { reply_markup: mainMenu() });
}

/** Validate the collected fields and persist the profile. */
async function finishWizard(ctx: Context, app: BotApp): Promise<void> {
  const userId = ctx.from!.id;
  const state = wizardState.get(userId) ?? {};
  if (!state.fullName) {
    app.profileEdit.expect(userId, "name");
    await ctx.reply("نام را وارد کنید.", { reply_markup: profileWizardKeyboard("name", false) });
    return;
  }
  if (!state.phone) {
    app.profileEdit.expect(userId, "phone");
    await ctx.reply("شماره موبایل را وارد کنید.", {
      reply_markup: profileWizardKeyboard("phone", false),
    });
    return;
  }
  const r = app.customers.saveProfile(userId, {
    fullName: state.fullName,
    phone: state.phone,
    address: state.address ?? null,
  });
  if (!r.ok) {
    app.profileEdit.expect(userId, "address");
    await ctx.reply(`${r.error}\n\nدوباره تلاش کنید.`, {
      reply_markup: profileWizardKeyboard("address", true),
    });
    return;
  }
  wizardState.delete(userId);
  app.profileEdit.clear(userId);
  // Keep the Telegram username in sync with the validated sender.
  if (ctx.from) {
    app.customers.recordSender(userId, {
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
    });
  }
  await ctx.reply(
    [
      "✅ پروفایل ذخیره شد.",
      `نام: ${r.profile.fullName}`,
      `موبایل: ${r.profile.phone ? toPersianDigits(r.profile.phone) : "—"}`,
      r.profile.address ? `آدرس: ${r.profile.address}` : "آدرس: ثبت نشده",
    ].join("\n"),
    { reply_markup: mainMenu() },
  );
}
