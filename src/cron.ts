import cron from "node-cron";
import type { Bot } from "grammy";
import { config } from "./config.js";
import {
  getRecentMessages,
  getRecentDecisions,
  getOpenActionItems,
  getChatSummary,
} from "./db.js";
import { getDailyBriefing } from "./claude.js";
import { getAllRepoActivity } from "./github.js";

/**
 * Schedules the daily morning briefing.
 * Fires at 08:00 every day in the system timezone.
 * Set TZ=America/New_York (or your tz) in Railway env vars to control timezone.
 */
export function scheduleDailyBriefing(bot: Bot): void {
  // "0 8 * * *" = 08:00 every day
  cron.schedule("0 8 * * *", async () => {
    console.log("[cron] Running daily briefing...");
    try {
      const chatId = config.founderChatId;

      const [recentMessages, decisions, actionItems, rollingSummary, githubActivity] =
        await Promise.all([
          getRecentMessages(chatId, 50),
          getRecentDecisions(chatId, 10),
          getOpenActionItems(chatId),
          getChatSummary(chatId),
          getAllRepoActivity(24),
        ]);

      const briefing = await getDailyBriefing({
        recentMessages,
        decisions,
        actionItems,
        rollingSummary,
        githubActivity,
      });

      await bot.api.sendMessage(
        chatId,
        `☀️ *Daily Briefing*\n\n${briefing}`,
        { parse_mode: "Markdown" }
      );

      console.log("[cron] Daily briefing sent.");
    } catch (err) {
      console.error("[cron] Daily briefing failed:", err);
    }
  });

  console.log("[cron] Daily briefing scheduled at 08:00.");
}
