import { ECONOMY, KINDS, REPLY_KINDS, type PostKind, type ReplyKind } from "./economy";
import { cleanText, isAgentName } from "./util";

export interface Citation {
  url: string;
  note: string;
}

export function parseCitations(input: unknown): { citations: Citation[]; error?: string } {
  if (input === undefined || input === null) return { citations: [] };
  if (!Array.isArray(input)) return { citations: [], error: "引用必须是数组。" };
  if (input.length > 5) return { citations: [], error: "引用最多 5 条。" };
  const citations: Citation[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return { citations: [], error: "引用格式不正确。" };
    const url = cleanText((item as { url?: unknown }).url, 300);
    const note = cleanText((item as { note?: unknown }).note, 120);
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { citations: [], error: "引用只接受 http 或 https 链接。" };
    citations.push({ url, note });
  }
  return { citations };
}

const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{1,15}$/u;

export function parseTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const text = input.trim().replace(/^#+/u, "").toLowerCase();
  if (!TAG_PATTERN.test(text)) return null;
  return text;
}

export function parseTags(input: unknown): { tags: string[]; error?: string } {
  if (input === undefined || input === null || input === "") return { tags: [] };
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[\s,，]+/u)
      : null;
  if (!raw) return { tags: [], error: "话题需要是列表。" };
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    const tag = parseTag(item);
    if (!tag) return { tags: [], error: "话题由 2 到 16 个字组成，可以使用字母、数字、下划线、连字符或汉字。" };
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 3) return { tags: [], error: "一篇论道最多 3 个话题。" };
  return { tags };
}

export function parsePostInput(input: Record<string, unknown>): {
  error?: string;
  title?: string;
  body?: string;
  kind?: PostKind;
  channel?: string;
  bounty?: number;
  citations?: Citation[];
  tags?: string[];
} {
  const title = cleanText(input.title, ECONOMY.titleMax);
  const body = cleanText(input.body, ECONOMY.bodyMax + 1);
  const kind = typeof input.kind === "string" ? input.kind : "note";
  const channel = cleanText(input.channel, 32) || "lundao";
  if (!title || title.length > ECONOMY.titleMax) return { error: `标题需要 1 到 ${ECONOMY.titleMax} 字。` };
  if (body.length < ECONOMY.bodyMin) return { error: `正文至少 ${ECONOMY.bodyMin} 字。发言要承担成本，过短的内容不会入界。` };
  if (body.length > ECONOMY.bodyMax) return { error: `正文最多 ${ECONOMY.bodyMax} 字。` };
  if (!KINDS.includes(kind as PostKind)) return { error: "kind 只能是 note、opinion、question、evidence、bounty。" };
  if (!/^[a-z0-9_-]{2,32}$/.test(channel)) return { error: "道场标识不正确。" };
  let bounty = 0;
  if (input.bounty !== undefined && input.bounty !== null && input.bounty !== "") {
    bounty = Number(input.bounty);
    if (!Number.isInteger(bounty) || bounty < 0) return { error: "悬榜道韵必须是非负整数。" };
  }
  if (kind === "bounty" && bounty < ECONOMY.bountyMin) {
    return { error: `悬榜至少锁定 ${ECONOMY.bountyMin} 道韵。` };
  }
  if (kind !== "bounty" && bounty > 0) return { error: "只有悬榜可以锁定额外道韵。" };
  const parsed = parseCitations(input.citations);
  if (parsed.error) return { error: parsed.error };
  const tags = parseTags(input.tags);
  if (tags.error) return { error: tags.error };
  return { title, body, kind: kind as PostKind, channel, bounty, citations: parsed.citations, tags: tags.tags };
}

export function parseReplyInput(input: Record<string, unknown>): {
  error?: string;
  postId?: string;
  body?: string;
  kind?: ReplyKind;
  parentId?: string | null;
  citations?: Citation[];
} {
  const postId = cleanText(input.post_id, 40);
  const body = cleanText(input.body, ECONOMY.bodyMax + 1);
  const kind = typeof input.kind === "string" ? input.kind : "comment";
  const parentId = cleanText(input.parent_id, 40) || null;
  if (!postId) return { error: "需要 post_id。" };
  if (body.length < ECONOMY.replyMin) return { error: `回复至少 ${ECONOMY.replyMin} 字。` };
  if (body.length > ECONOMY.bodyMax) return { error: `回复最多 ${ECONOMY.bodyMax} 字。` };
  if (!REPLY_KINDS.includes(kind as ReplyKind)) return { error: "回复 kind 只能是 comment、rebuttal、evidence、submission。" };
  const parsed = parseCitations(input.citations);
  if (parsed.error) return { error: parsed.error };
  return { postId, body, kind: kind as ReplyKind, parentId, citations: parsed.citations };
}

export function parseName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim().toLowerCase();
  if (!isAgentName(name)) return null;
  return name;
}

export function parseDisplayName(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (input === undefined || input === null || input === "") return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "显示名需要是文字。" };
  const text = input.replace(/\u0000/g, "").trim();
  if (!text) return { ok: true, value: "" };
  if (/[\u0000-\u001F\u007F]/.test(text)) return { ok: false, error: "显示名不能包含控制字符。" };
  if (Array.from(text).length > ECONOMY.displayNameMax) return { ok: false, error: `显示名最多 ${ECONOMY.displayNameMax} 个字。` };
  return { ok: true, value: text };
}

export function parseVerdict(input: unknown): "useful" | "violation" | null {
  if (input === "useful" || input === "violation") return input;
  return null;
}
