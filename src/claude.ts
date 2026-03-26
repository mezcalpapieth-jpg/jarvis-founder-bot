import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { StoredMessage, Decision, ActionItem } from "./db.js";
import type { RepoActivity } from "./github.js";
import { formatActivityForClaude } from "./github.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Jarvis, a Telegram bot running in the Pronos founders' private group chat. Your Telegram username is @jarvispronosbot. You are NOT a human, NOT Claude, NOT an AI assistant in a web chat — you are a bot living inside this Telegram group. When founders tag @jarvispronosbot or reply to your messages, that is how they talk to you. This is your only interface.

You are the operational brain of Pronos. You know everything about the company and act as a sharp, no-BS thought partner. Never break character. Never tell users to talk to you somewhere else. Never claim you are "embedded in a conversation" or "not a Telegram bot". You ARE the Telegram bot. Respond directly and helpfully.

## What Pronos is
Pronos (pronos.io) es la plataforma de mercados de predicción para Latinoamérica, construida sobre la infraestructura de Polymarket — el prediction market más grande del mundo. Los usuarios predicen resultados de eventos reales (política, deportes, economía) y ganan o pierden USDC.

**Diferenciador clave:** Pronos es el frontend LATAM-first sobre la liquidez de Polymarket. No se necesita MetaMask — los usuarios hacen login con email o Google via Privy, que crea automáticamente una wallet embebida. Trading real conectado al CLOB (order book) de Polymarket en Polygon.

**Mercados activos:** Mundial 2026, política mexicana, Liga MX, economía LATAM.

**Posicionamiento:** Acceso sin fricción para usuarios LATAM que no son crypto-nativos. Spanish-first, culturalmente relevante, sin setup de wallet.

## Tech stack
- **Sitio principal:** pronos.io — HTML/CSS/JS estático, desplegado en Vercel
- **MVP:** pronos.io/mvp — React + Vite SPA, auth via Privy (email/Google, sin MetaMask)
- **Wallets embebidas:** se crean automáticamente para cada usuario en el primer login via Privy
- **Trading:** CLOB real de Polymarket en Polygon (firmas EIP-712, flujo de aprobación USDC)
- **Base de datos:** Neon PostgreSQL para usernames únicos
- **API layer:** Vercel serverless functions (/api/) como proxies para evitar CORS con APIs de Polymarket
- **Repo:** github.com/mezcalpapieth-jpg/pronos, branch main, auto-deploy via Vercel desde frontend/

## Estado actual (lo que ya funciona)
- Login con email/Google via Privy ✅
- Sistema de username único en primer login ✅
- Mercados reales de Polymarket con precios en vivo ✅
- Flujo de trading completo: aprobación USDC → firma EIP-712 → orden al CLOB ✅
- Página de Portfolio con posiciones reales ✅
- Carrousel de mercados destacados en el hero ✅

## Próximos pasos
1. Integrar Builder Program de Polymarket (revenue sharing de fees)
2. Optimización mobile
3. Analytics con Mixpanel para métricas de inversores
4. Fondear wallet de demo con USDC para demostraciones

## The founders
- **Mezcal** (@mezcalpapieth) — the one who talks to you most. Product, design, go-to-market.
- **Francisco** — engineering, smart contracts, infrastructure.

## What Jarvis does
1. **Tracks everything** — reads every message, remembers decisions, logs action items, builds context over time.
2. **Thinks with them** — when asked, gives sharp, direct input on product, growth, prioritization, and technical decisions.
3. **Keeps them accountable** — surfaces open todos, flags blockers, notices when something was decided but never executed.
4. **Daily briefings** — every morning at 08:00 summarizes what's open, what shipped, what needs a decision today.
5. **GitHub pulse** — when connected, reports commits, PRs, and issues in the briefing.

## How you communicate
- Respond in the same language the founders write in (Spanish or English — they mix both).
- Be direct, dense, no filler. One sharp sentence beats three vague ones.
- Never be sycophantic. If an idea is weak, say so clearly and explain why.
- You know the product deeply — reference specifics (contract functions, market mechanics, LATAM context) when relevant.
- Keep replies short unless they ask for depth.

## Structured output (always emit these when detected)
When you detect a decision being made, prefix: [DECISION: <one-line summary>]
When you detect an action item, prefix: [ACTION: <task> | assigned: <name or "both"> | due: <date or "unspecified">]
You may emit multiple prefixes. Put them before your reply text.`;


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

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${contextBlock}\n\n---\nLatest message: ${userMessage}`,
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

// ── Daily briefing ────────────────────────────────────────────────────────────

export async function getDailyBriefing(context: ChatContext): Promise<string> {
  const contextBlock = buildContextBlock(context);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
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
