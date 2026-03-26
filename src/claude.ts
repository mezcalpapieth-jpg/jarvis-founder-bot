import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { StoredMessage, Decision, ActionItem } from "./db.js";
import type { RepoActivity } from "./github.js";
import { formatActivityForClaude } from "./github.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a smart, concise executive assistant embedded in a private Telegram group for two startup founders. Your job is to:

1. Help the founders think through decisions, problems, and ideas.
2. Extract and remember decisions and action items from their conversation.
3. Give short, high-signal replies — no fluff, no filler.
4. Proactively surface risks, blind spots, or relevant context from memory.
5. NEVER be sycophantic. Be direct.

When you detect a decision being made, prefix your reply with: [DECISION: <one-line summary>]
When you detect an action item, prefix with: [ACTION: <task> | assigned: <name or "both"> | due: <date or "unspecified">]
You may emit multiple prefixes in one reply.

After any prefixes, give your actual response on a new line.`;

// ── Core chat completion ──────────────────────────────────────────────────────

export interface ChatContext {
  recentMessages: StoredMessage[];
  decisions: Decision[];
  actionItems: ActionItem[];
  rollingSummary: string;
  githubActivity?: RepoActivity[];
}

export async function getChatResponse(
  userMessage: string,
  context: ChatContext
): Promise<string> {
  const contextBlock = buildContextBlock(context);

  const stream = anthropic.messages.stream({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${contextBlock}\n\n---\nLatest message: ${userMessage}`,
      },
    ],
  });

  const final = await stream.finalMessage();

  for (const block of final.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

// ── Daily briefing ────────────────────────────────────────────────────────────

export async function getDailyBriefing(context: ChatContext): Promise<string> {
  const contextBlock = buildContextBlock(context);

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1500,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${contextBlock}\n\n---\nGenerate the daily morning briefing. Include:
1. Open action items (owner + any due dates)
2. Recent decisions made in the last 48 hours
3. GitHub activity: commits shipped, PRs merged, PRs waiting for review, open issues worth flagging
4. Any patterns or risks you notice across the conversation and code activity
5. One sharp question worth discussing today

Keep it under 400 words. Use bullet points. Lead with the GitHub section if there was significant shipping activity.`,
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "No briefing content generated.";
}

// ── Rolling summary updater ───────────────────────────────────────────────────

export async function refreshRollingSummary(
  existingSummary: string,
  newMessages: StoredMessage[]
): Promise<string> {
  if (newMessages.length === 0) return existingSummary;

  const transcript = newMessages
    .map((m) => `${m.first_name ?? m.username ?? m.user_id}: ${m.text}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `You maintain a rolling summary of a founder group chat.

Existing summary:
${existingSummary || "(empty)"}

New messages to integrate:
${transcript}

Update the summary. Keep it under 200 words. Focus on: active threads, pending decisions, commitments made, open questions. Discard resolved or irrelevant details.`,
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return existingSummary;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildContextBlock(ctx: ChatContext): string {
  const parts: string[] = [];

  if (ctx.rollingSummary) {
    parts.push(`## Conversation summary so far\n${ctx.rollingSummary}`);
  }

  if (ctx.decisions.length > 0) {
    const list = ctx.decisions
      .slice(0, 5)
      .map((d) => `- ${d.summary} (${d.decided_at.slice(0, 10)})`)
      .join("\n");
    parts.push(`## Recent decisions\n${list}`);
  }

  if (ctx.actionItems.length > 0) {
    const list = ctx.actionItems
      .map((a) => `- [${a.assigned_to ?? "?"}] ${a.task}${a.due_date ? ` (due ${a.due_date})` : ""}`)
      .join("\n");
    parts.push(`## Open action items\n${list}`);
  }

  if (ctx.githubActivity && ctx.githubActivity.length > 0) {
    const ghBlock = formatActivityForClaude(ctx.githubActivity);
    if (ghBlock) parts.push(`## GitHub activity (last 24h)\n${ghBlock}`);
  }

  if (ctx.recentMessages.length > 0) {
    const transcript = ctx.recentMessages
      .slice(-20)
      .map((m) => `${m.first_name ?? m.username ?? m.user_id}: ${m.text}`)
      .join("\n");
    parts.push(`## Recent messages\n${transcript}`);
  }

  return parts.join("\n\n");
}

// ── Response parser ───────────────────────────────────────────────────────────

export interface ParsedReply {
  decisions: string[];
  actionItems: Array<{ task: string; assignedTo?: string; dueDate?: string }>;
  replyText: string;
}

export function parseReply(raw: string): ParsedReply {
  const decisions: string[] = [];
  const actionItems: ParsedReply["actionItems"] = [];
  const lines = raw.split("\n");
  const replyLines: string[] = [];

  for (const line of lines) {
    const decisionMatch = line.match(/^\[DECISION:\s*(.+?)\]/i);
    if (decisionMatch) {
      decisions.push(decisionMatch[1].trim());
      continue;
    }

    const actionMatch = line.match(
      /^\[ACTION:\s*(.+?)(?:\s*\|\s*assigned:\s*(.+?))?(?:\s*\|\s*due:\s*(.+?))?\]/i
    );
    if (actionMatch) {
      actionItems.push({
        task: actionMatch[1].trim(),
        assignedTo: actionMatch[2]?.trim(),
        dueDate: actionMatch[3]?.trim() === "unspecified" ? undefined : actionMatch[3]?.trim(),
      });
      continue;
    }

    replyLines.push(line);
  }

  return {
    decisions,
    actionItems,
    replyText: replyLines.join("\n").trim(),
  };
}
