require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const { getMachineList, buildComparison, formatTelegram } = require("./comparison");
const { createGoogleChatHandler } = require("./google-chat");

const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- Telegram Bot ----

// START COMMAND
bot.start((ctx) => {
  ctx.reply(
    "Welcome! Use /compare to compare machine sales before & after rollout."
  );
});

// COMPARE COMMAND
bot.command("compare", async (ctx) => {
  const machines = await getMachineList(supabase);

  if (!machines) {
    return ctx.reply("Error fetching machines or no rollouts found.");
  }

  const buttons = machines.map((m) => [
    Markup.button.callback(
      m.vending_machines?.location || m.vending_machines?.machine_id || `Machine ${m.machineid}`,
      `machine_${m.id}`
    ),
  ]);

  ctx.reply("Select a machine to compare sales:", Markup.inlineKeyboard(buttons));
});

// HANDLE MACHINE SELECTION
bot.action(/^machine_(.+)$/, async (ctx) => {
  const rolloutId = ctx.match[1];
  await ctx.answerCbQuery();

  ctx.reply(
    "Choose comparison type:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Daily", `daily_${rolloutId}`)],
      [Markup.button.callback("Weekly", `weekly_${rolloutId}`)],
      [Markup.button.callback("Monthly", `monthly_${rolloutId}`)],
    ])
  );
});

// DAILY COMPARISON
bot.action(/^daily_(.+)$/, async (ctx) => {
  const rolloutId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply("Fetching daily comparison...");
  const result = await buildComparison(supabase, rolloutId, "daily");
  await sendLongMessage(ctx, formatTelegram(result));
});

// WEEKLY COMPARISON
bot.action(/^weekly_(.+)$/, async (ctx) => {
  const rolloutId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply("Fetching weekly comparison...");
  const result = await buildComparison(supabase, rolloutId, "weekly");
  await sendLongMessage(ctx, formatTelegram(result));
});

// MONTHLY COMPARISON
bot.action(/^monthly_(.+)$/, async (ctx) => {
  const rolloutId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply("Fetching monthly comparison...");
  const result = await buildComparison(supabase, rolloutId, "monthly");
  await sendLongMessage(ctx, formatTelegram(result));
});

// CATCH-ALL: any other message prompts user to use /compare
bot.on("message", (ctx) => {
  ctx.reply("Please use /compare to compare machine sales before & after rollout.");
});

// Send long messages in chunks (Telegram has 4096 char limit)
async function sendLongMessage(ctx, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return ctx.reply(text, { parse_mode: "HTML" });
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + line + "\n").length > MAX) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
      chunk = "";
    }
    chunk += line + "\n";
  }
  if (chunk.trim()) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
}

// ---- Express server for Google Chat ----

const app = express();
app.use(express.json());

const googleChatRouter = createGoogleChatHandler(supabase);
app.use("/google-chat", googleChatRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", telegram: true, googleChat: true });
});

// ---- Start both services ----

const GOOGLE_CHAT_PORT = parseInt(process.env.GOOGLE_CHAT_PORT || "8090", 10);

bot.launch();
console.log("Telegram bot is running...");

app.listen(GOOGLE_CHAT_PORT, () => {
  console.log(`Google Chat endpoint listening on port ${GOOGLE_CHAT_PORT}`);
});
