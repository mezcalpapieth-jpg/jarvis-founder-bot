import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  { auth: { persistSession: false } }
);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  chat_id: number;
  message_id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  text: string;
  created_at: string;
}

export interface Decision {
  id: number;
  chat_id: number;
  summary: string;
  raw_context: string | null;
  decided_at: string;
}

export interface ActionItem {
  id: number;
  chat_id: number;
  task: string;
  assigned_to: string | null;
  due_date: string | null;
  status: "open" | "done" | "cancelled";
  created_at: string;
  updated_at: string;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function saveMessage(msg: Omit<StoredMessage, "id" | "created_at">) {
  const { error } = await supabase.from("messages").insert(msg);
  if (error) console.error("saveMessage error:", error.message);
}

export async function getRecentMessages(chatId: number, limit = 40): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("getRecentMessages error:", error.message);
    return [];
  }
  return (data as StoredMessage[]).reverse();
}

// ── Decisions ─────────────────────────────────────────────────────────────────

export async function saveDecision(chatId: number, summary: string, rawContext: string) {
  const { error } = await supabase
    .from("decisions")
    .insert({ chat_id: chatId, summary, raw_context: rawContext });
  if (error) console.error("saveDecision error:", error.message);
}

export async function getRecentDecisions(chatId: number, limit = 10): Promise<Decision[]> {
  const { data, error } = await supabase
    .from("decisions")
    .select("*")
    .eq("chat_id", chatId)
    .order("decided_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("getRecentDecisions error:", error.message);
    return [];
  }
  return data as Decision[];
}

// ── Action items ──────────────────────────────────────────────────────────────

export async function saveActionItem(
  chatId: number,
  task: string,
  assignedTo?: string,
  dueDate?: string
) {
  const { error } = await supabase.from("action_items").insert({
    chat_id: chatId,
    task,
    assigned_to: assignedTo ?? null,
    due_date: dueDate ?? null,
  });
  if (error) console.error("saveActionItem error:", error.message);
}

export async function getOpenActionItems(chatId: number): Promise<ActionItem[]> {
  const { data, error } = await supabase
    .from("action_items")
    .select("*")
    .eq("chat_id", chatId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("getOpenActionItems error:", error.message);
    return [];
  }
  return data as ActionItem[];
}

export async function markActionItemDone(itemId: number) {
  const { error } = await supabase
    .from("action_items")
    .update({ status: "done", updated_at: new Date().toISOString() })
    .eq("id", itemId);
  if (error) console.error("markActionItemDone error:", error.message);
}

// ── Rolling context summary ───────────────────────────────────────────────────

export async function getChatSummary(chatId: number): Promise<string> {
  const { data, error } = await supabase
    .from("chat_context")
    .select("summary")
    .eq("chat_id", chatId)
    .single();
  if (error || !data) return "";
  return (data as { summary: string }).summary;
}

export async function updateChatSummary(chatId: number, summary: string) {
  const { error } = await supabase.from("chat_context").upsert(
    { chat_id: chatId, summary, updated_at: new Date().toISOString() },
    { onConflict: "chat_id" }
  );
  if (error) console.error("updateChatSummary error:", error.message);
}
