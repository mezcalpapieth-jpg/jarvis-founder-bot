import "dotenv/config";
import express from "express";
import { Bot, webhookCallback, type Context } from "grammy";
import { config } from "./config.js";
import { getAllRepoActivity, formatActivityForTelegram } from "./github.js";
import {
  saveMessage,
  saveDecision,
  saveActionItem,
  getRecentMessages,
  getRecentDecisions,
  getOpenActionItems,
  getChatSummary,
  updateChatSummary,
} from "./db.js";
import { getChatResponse, parseReply, refreshRollingSummary } from "./claude.js";
import { scheduleDailyBriefing } from "./cron.js";

// ── Bot setup ─────────────────────────────────────────────────────────────────

const bot = new Bot(config.telegram.token);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Cache bot info so we don't call getMe() on every message
let _me: Awaited<ReturnType<typeof bot.api.getMe>> | null = null;
async function getMe() {
  if (!_me) _me = await bot.api.getMe();
  return _me;
}

/** Extra send options — passes message_thread_id for forum/topic groups. */
function threadOpts(ctx: Context): Record<string, unknown> {
  const threadId = ctx.message?.message_thread_id;
  return threadId ? { message_thread_id: threadId } : {};
}

/** Returns true if the message mentions the bot or is a reply to the bot. */
async function shouldRespond(ctx: Context): Promise<boolean> {
  const msg = ctx.message;
  if (!msg?.text) return false;

  const me = await getMe();
  const text = msg.text;

  if (msg.reply_to_message?.from?.id === me.id) return true;
  if (text.includes(`@${me.username}`)) return true;
  if (text.startsWith("/")) return true;

  return false;
}

// ── Message handler ───────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const msg = ctx.message;
  const chatId = msg.chat.id;
  const text = msg.text;

  // 1. Persist every message
  await saveMessage({
    chat_id: chatId,
    message_id: msg.message_id,
    user_id: msg.from.id,
    username: msg.from.username ?? null,
    first_name: msg.from.first_name ?? null,
    text,
  });

  // 2. Decide whether to reply
  if (!(await shouldRespond(ctx))) {
    // Still update rolling summary periodically (every 10th message)
    if (msg.message_id % 10 === 0) {
      const recent = await getRecentMessages(chatId, 10);
      const existing = await getChatSummary(chatId);
      const updated = await refreshRollingSummary(existing, recent);
      await updateChatSummary(chatId, updated);
    }
    return;
  }

  // 3. Build context
  const [recentMessages, decisions, actionItems, rollingSummary] = await Promise.all([
    getRecentMessages(chatId, 30),
    getRecentDecisions(chatId, 5),
    getOpenActionItems(chatId),
    getChatSummary(chatId),
  ]);

  // 4. Call Claude
  let rawReply: string;
  try {
    rawReply = await getChatResponse(text, {
      recentMessages,
      decisions,
      actionItems,
      rollingSummary,
    });
  } catch (err) {
    console.error("Claude error:", err);
    await ctx.reply("Sorry, I hit an error. Try again?", threadOpts(ctx));
    return;
  }

  // 5. Parse structured output (decisions / action items)
  const parsed = parseReply(rawReply);

  for (const decision of parsed.decisions) {
    await saveDecision(chatId, decision, recentMessages.slice(-5).map((m) => m.text).join(" | "));
  }

  for (const item of parsed.actionItems) {
    await saveActionItem(chatId, item.task, item.assignedTo, item.dueDate);
  }

  // 6. Send reply (only the human-readable part, not the prefixes)
  if (parsed.replyText) {
    await ctx.reply(parsed.replyText, {
      reply_to_message_id: msg.message_id,
      ...threadOpts(ctx),
    });
  }

  // 7. Update rolling summary
  const updatedSummary = await refreshRollingSummary(rollingSummary, [
    ...recentMessages.slice(-5),
  ]);
  await updateChatSummary(chatId, updatedSummary);
});

// ── /decisions command ────────────────────────────────────────────────────────

// ── /start command ────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 *Jarvis online.*\n\nI'm your founder assistant. I read every message in this group, remember decisions and action items, and give you a daily briefing at 08:00.\n\n*Commands:*\n/briefing — on-demand briefing\n/todos — open action items\n/decisions — recent decisions\n/done <id> — mark a task done\n/github — latest repo activity\n\nMention me with @jarvispronosbot or reply to any of my messages to talk to me.`,
    { parse_mode: "Markdown", ...threadOpts(ctx) }
  );
});

// ── /decisions command ────────────────────────────────────────────────────────

bot.command("decisions", async (ctx) => {
  const decisions = await getRecentDecisions(ctx.chat.id, 10);
  if (decisions.length === 0) {
    await ctx.reply("No decisions recorded yet.", threadOpts(ctx));
    return;
  }
  const list = decisions
    .map((d, i) => `${i + 1}. ${d.summary} _(${d.decided_at.slice(0, 10)})_`)
    .join("\n");
  await ctx.reply(`*Recent Decisions*\n\n${list}`, { parse_mode: "Markdown", ...threadOpts(ctx) });
});

// ── /todos command ────────────────────────────────────────────────────────────

bot.command("todos", async (ctx) => {
  const items = await getOpenActionItems(ctx.chat.id);
  if (items.length === 0) {
    await ctx.reply("No open action items. 🎉", threadOpts(ctx));
    return;
  }
  const list = items
    .map(
      (a, i) =>
        `${i + 1}. [${a.assigned_to ?? "?"}] ${a.task}${a.due_date ? ` _(due ${a.due_date})_` : ""}`
    )
    .join("\n");
  await ctx.reply(`*Open Action Items*\n\n${list}`, { parse_mode: "Markdown", ...threadOpts(ctx) });
});

// ── /done command ─────────────────────────────────────────────────────────────

bot.command("done", async (ctx) => {
  const arg = ctx.match.trim();
  const id = parseInt(arg, 10);
  if (isNaN(id)) {
    await ctx.reply("Usage: /done <action_item_id>");
    return;
  }
  const { error } = await import("./db.js").then((db) => {
    db.markActionItemDone(id);
    return { error: null };
  });
  await ctx.reply(`Action item ${id} marked done ✅`, threadOpts(ctx));
});

// ── /github command ───────────────────────────────────────────────────────────

bot.command("github", async (ctx) => {
  if (config.github.repos.length === 0) {
    await ctx.reply(
      "No GitHub repos configured. Set `GITHUB_REPOS=owner/repo1,owner/repo2` in your env.",
      { parse_mode: "Markdown", ...threadOpts(ctx) }
    );
    return;
  }

  const sentMsg = await ctx.reply("Fetching GitHub activity…", threadOpts(ctx));

  try {
    const activity = await getAllRepoActivity(24);
    const formatted = formatActivityForTelegram(activity);
    await ctx.api.editMessageText(ctx.chat.id, sentMsg.message_id, formatted, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("GitHub fetch error:", err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      sentMsg.message_id,
      "Failed to fetch GitHub activity. Check your `GITHUB_TOKEN` and `GITHUB_REPOS`.",
      { parse_mode: "Markdown" }
    );
  }
});

// ── /briefing command (on-demand) ─────────────────────────────────────────────

bot.command("briefing", async (ctx) => {
  const chatId = ctx.chat.id;
  const [recentMessages, decisions, actionItems, rollingSummary, githubActivity] =
    await Promise.all([
      getRecentMessages(chatId, 50),
      getRecentDecisions(chatId, 10),
      getOpenActionItems(chatId),
      getChatSummary(chatId),
      getAllRepoActivity(24),
    ]);

  const { getDailyBriefing } = await import("./claude.js");
  const briefing = await getDailyBriefing({
    recentMessages,
    decisions,
    actionItems,
    rollingSummary,
    githubActivity,
  });
  await ctx.reply(`📋 *On-Demand Briefing*\n\n${briefing}`, { parse_mode: "Markdown", ...threadOpts(ctx) });
});

// ── Webhook / polling setup ───────────────────────────────────────────────────

async function main() {
  scheduleDailyBriefing(bot);

  if (config.webhook.domain) {
    // Production: use webhook (required on Railway / serverless)
    const app = express();
    app.use(express.json());

    const webhookPath = `/webhook/${config.telegram.token}`;

    // timeoutMilliseconds: 0 disables grammY's 10s handler timeout —
    // Claude + Supabase can take longer than that on cold starts.
    app.use(webhookPath, webhookCallback(bot, "express", { timeoutMilliseconds: 0 }));

    // Health check for Railway
    app.get("/health", (_req, res) => res.json({ ok: true }));

    app.listen(config.webhook.port, () => {
      console.log(`[bot] Express listening on port ${config.webhook.port}`);
    });

    await bot.api.setWebhook(`${config.webhook.domain}${webhookPath}`);
    console.log(`[bot] Webhook set: ${config.webhook.domain}${webhookPath}`);
  } else {
    // Development: long-polling
    console.log("[bot] Starting in long-polling mode...");
    await bot.start();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
