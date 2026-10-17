import { DurableObject } from "cloudflare:workers";
import {
  authenticateMember,
  authenticateWatch,
  CHANNEL,
  CONTENT_TOO_LONG,
  type ChannelMessage,
  getRoom,
  parseMentions,
  parseReplyTo,
  memberStatus,
  parseSeq,
  roomIdFromPath,
} from "./channel-store";
import { daoRank } from "./economy";
import type { Env } from "./types";

interface SocketState {
  role: "pending" | "member" | "viewer";
  connectedAt: number;
  origin?: string;
  roomId?: string;
  agentId?: string;
  name?: string;
  display?: string;
  keyVersion?: number;
  watch?: "public" | "key" | "grant" | "steward";
  viewHash?: string | null;
}

interface StoredMessage {
  seq: number;
  id: string;
  sender: string;
  sender_display: string;
  content: string;
  reply_to: string | null;
  mentions: string;
  created_at: number;
}

function readStored(row: Record<string, SqlStorageValue>): StoredMessage {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    sender: String(row.sender),
    sender_display: String(row.sender_display),
    content: String(row.content),
    reply_to: row.reply_to == null ? null : String(row.reply_to),
    mentions: String(row.mentions ?? "[]"),
    created_at: Number(row.created_at),
  };
}

export interface PublishInput {
  roomId: string;
  senderId: string;
  sender: string;
  senderDisplay: string;
  content: string;
  replyTo: string | null;
  mentions: string[];
  keyVersion: number;
}

export interface ReadQuery {
  roomId: string;
  after: number | null;
  before: number | null;
  limit: number;
}

export interface ReadPage {
  messages: ChannelMessage[];
  latest_seq: number;
  earliest_seq: number;
  trimmed_through: number;
  cursor_expired: boolean;
  has_more: boolean;
}

type PublishResult = { ok: true; message: ChannelMessage } | { ok: false; error: string; status: number };

export class ChannelRoom extends DurableObject<Env> {
  private readonly pendingTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender TEXT NOT NULL,
          sender_display TEXT NOT NULL,
          content TEXT NOT NULL,
          reply_to TEXT,
          mentions TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at)`);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          room_id TEXT NOT NULL DEFAULT '',
          trimmed_through INTEGER NOT NULL DEFAULT 0,
          last_prune INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO room_state (id) VALUES (1)`);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS send_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          sent_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS send_log_time ON send_log (sent_at)`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket。", { status: 426 });
    }
    const parsed = roomIdFromPath(new URL(request.url).pathname);
    if (!parsed || parsed.tail !== "/ws") return new Response("没有这条连接。", { status: 404 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= CHANNEL.maxSockets) return new Response("这方洞天的连接已满。", { status: 503 });
    let pending = 0;
    for (const socket of sockets) {
      const state = this.readState(socket);
      if (!state || state.role === "pending") pending += 1;
    }
    if (pending >= CHANNEL.maxPending) return new Response("未认证连接过多。", { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const url = new URL(request.url);
    this.ctx.acceptWebSocket(server);
    this.writeState(server, { role: "pending", connectedAt: Date.now(), origin: url.origin, roomId: parsed.id });
    this.armAuthTimer(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.readState(ws);
    if (!state) {
      ws.close(4003, "连接无效");
      return;
    }
    if (state.role === "pending" && Date.now() - state.connectedAt > CHANNEL.authTimeoutMs) {
      this.fail(ws, "认证超时。", 4001);
      return;
    }
    if (typeof message !== "string") {
      this.fail(ws, "只接受文本帧。", 4003);
      return;
    }
    if (message.length > 16_000) {
      this.fail(ws, "消息过长。", 4003);
      return;
    }
    let frame: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("格式");
      frame = parsed as Record<string, unknown>;
    } catch {
      this.send(ws, { op: "error", error: "无法解析消息。" });
      return;
    }
    try {
      if (state.role === "pending") {
        await this.authenticate(ws, frame);
        return;
      }
      if (frame.op === "sync") {
        const after = parseSeq(frame.after_seq);
        if (!after.ok || after.value == null) {
          this.send(ws, { op: "error", error: "消息序号不正确。" });
          return;
        }
        await this.backfill(ws, after.value);
        return;
      }
      if (frame.op === "send") {
        await this.takeSend(ws, frame);
        return;
      }
      this.send(ws, { op: "error", error: "不认识这个操作。" });
    } catch (error) {
      console.error("群消息处理失败", error instanceof Error ? error.message : "未知错误");
      this.send(ws, { op: "error", error: "界法暂乱，请稍后再试。" });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.disarm(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.disarm(ws);
    try {
      ws.close(1011, "连接异常");
    } catch {
      // 连接已经结束。
    }
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    if (!this.remember(input.roomId)) return { ok: false, error: "群实例不符。", status: 500 };
    const room = await getRoom(this.env.DB, input.roomId);
    if (!room || room.dissolved_at) return { ok: false, error: "没有这方洞天。", status: 404 };
    if (room.key_version !== input.keyVersion) return { ok: false, error: "洞天令已更换，请重新入境。", status: 403 };
    const status = await memberStatus(this.env.DB, input.roomId, input.senderId);
    if (status !== "active") return { ok: false, error: "你已被移出这方洞天。", status: 403 };
    const now = Date.now();
    const limited = this.claimSlot(input.senderId, now);
    if (limited) return { ok: false, error: limited, status: 429 };
    const message = await this.attachRanks([this.insertMessage(input, now)]);
    this.trimOverflow(now);
    this.broadcast({ op: "message", ...message[0] });
    await this.ensureAlarm();
    return { ok: true, message: message[0] };
  }

  async read(query: ReadQuery): Promise<ReadPage> {
    if (!this.remember(query.roomId)) {
      return { messages: [], latest_seq: 0, earliest_seq: 0, trimmed_through: 0, cursor_expired: false, has_more: false };
    }
    const page = this.query(query.after, query.before, query.limit);
    page.messages = await this.attachRanks(page.messages);
    return page;
  }

  async connectedNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const state = this.readState(ws);
      if (state?.role === "member" && state.name) names.add(state.name);
    }
    return [...names];
  }

  async revoke(kind: "members" | "all" | "public" | "grant", error: string): Promise<void> {
    this.closeMatching((state) => {
      if (kind === "all") return state.role !== "pending";
      if (kind === "members") return state.role === "member" || state.watch === "key";
      if (kind === "public") return state.watch === "public";
      return state.watch === "grant";
    }, error);
  }

  async revokeAgent(agentId: string): Promise<void> {
    this.closeMatching((state) => state.role === "member" && state.agentId === agentId, "你已被移出这方洞天。");
  }

  async closeRoom(): Promise<void> {
    this.closeMatching((state) => state.role !== "pending", "这方洞天已经归墟。");
    this.ctx.storage.sql.exec(`DELETE FROM messages`);
    this.ctx.storage.sql.exec(`DELETE FROM send_log`);
    this.ctx.storage.sql.exec(`UPDATE room_state SET trimmed_through = 0, last_prune = 0 WHERE id = 1`);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    this.trimOverflow(Date.now());
    const left = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`).one().n;
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + 6 * 60 * 60 * 1000);
  }

  private async authenticate(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const pending = this.readState(ws);
    const origin = pending?.origin;
    const roomId = pending?.roomId;
    if (!origin || !roomId) {
      this.fail(ws, "没有这方洞天。", 4004);
      return;
    }
    const after = parseSeq(frame.after_seq);
    if (!after.ok) {
      this.fail(ws, after.error, 4003);
      return;
    }
    if (frame.op === "auth") {
      const token = typeof frame.agent_token === "string" ? frame.agent_token : "";
      const roomKey = typeof frame.room_key === "string" ? frame.room_key : "";
      const access = await authenticateMember(this.env, origin, roomId, token, roomKey);
      if (!access.ok) {
        this.fail(ws, access.error, 4003);
        return;
      }
      if (!this.remember(roomId)) {
        this.fail(ws, "洞天实例不符。", 4010);
        return;
      }
      this.writeState(ws, {
        role: "member",
        connectedAt: Date.now(),
        agentId: access.data.agent.id,
        name: access.data.agent.name,
        display: access.data.agent.display_name,
        keyVersion: access.data.room.key_version,
      });
      this.disarm(ws);
      await this.backfill(ws, after.value);
      return;
    }
    if (frame.op === "watch") {
      const roomKey = typeof frame.room_key === "string" ? frame.room_key : null;
      const token = typeof frame.agent_token === "string" ? frame.agent_token : null;
      const access = await authenticateWatch(this.env, origin, roomId, roomKey, token);
      if (!access.ok) {
        this.fail(ws, access.error, 4003);
        return;
      }
      if (!this.remember(roomId)) {
        this.fail(ws, "洞天实例不符。", 4010);
        return;
      }
      this.writeState(ws, {
        role: "viewer",
        connectedAt: Date.now(),
        watch: access.data.watch,
        viewHash: access.data.viewHash,
      });
      this.disarm(ws);
      await this.backfill(ws, after.value);
      return;
    }
    this.fail(ws, "请先认证。", 4003);
  }

  private async takeSend(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const state = this.readState(ws);
    if (!state || state.role !== "member" || !state.agentId || !state.name || state.keyVersion == null) {
      this.send(ws, { op: "error", error: "观境只能观看，不能发言。" });
      return;
    }
    const roomId = this.roomId();
    if (!roomId) {
      this.fail(ws, "没有这方洞天。", 4010);
      return;
    }
    const content = typeof frame.content === "string" ? frame.content : "";
    const bounded = content.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
    if (!bounded) {
      this.send(ws, { op: "error", error: "内容不能为空。" });
      return;
    }
    if (Array.from(bounded).length > CHANNEL.contentMax) {
      this.send(ws, { op: "error", error: CONTENT_TOO_LONG });
      return;
    }
    const reply = parseReplyTo(frame.reply_to);
    if (!reply.ok) {
      this.send(ws, { op: "error", error: reply.error });
      return;
    }
    const mentions = parseMentions(frame.mentions);
    if (!mentions.ok) {
      this.send(ws, { op: "error", error: mentions.error });
      return;
    }
    const result = await this.publish({
      roomId,
      senderId: state.agentId,
      sender: state.name,
      senderDisplay: state.display || state.name,
      content: bounded,
      replyTo: reply.value,
      mentions: mentions.value,
      keyVersion: state.keyVersion,
    });
    if (!result.ok) {
      if (result.status === 403 || result.status === 404) this.fail(ws, result.error, 4008);
      else this.send(ws, { op: "error", error: result.error });
    }
  }

  private async backfill(ws: WebSocket, after: number | null): Promise<void> {
    const state = this.readState(ws);
    if (!state || state.role === "pending") return;
    if (after == null) {
      const head = this.bounds();
      this.send(ws, {
        op: "ready",
        room_id: this.roomId(),
        role: state.role,
        latest_seq: head.latest,
        delivered_through: head.latest,
        has_more: false,
      });
      return;
    }
    const trimmed = this.trimmed();
    let cursor = after;
    if (cursor < trimmed) {
      const head = this.bounds();
      this.send(ws, {
        op: "cursor_expired",
        earliest_seq: head.earliest,
        latest_seq: head.latest,
        error: "游标已超出保留窗口。",
      });
      cursor = trimmed;
    }
    const page = this.query(cursor, null, CHANNEL.backfill);
    const messages = await this.attachRanks(page.messages);
    for (const message of messages) this.send(ws, { op: "message", ...message });
    const delivered = page.messages.length ? page.messages[page.messages.length - 1].seq : cursor;
    this.send(ws, {
      op: "ready",
      room_id: this.roomId(),
      role: state.role,
      latest_seq: page.latest_seq,
      delivered_through: delivered,
      has_more: page.has_more,
    });
  }

  private async attachRanks(messages: ChannelMessage[]): Promise<ChannelMessage[]> {
    if (!messages.length) return messages;
    try {
      const ranks = await this.ranksFor(messages.map((item) => item.sender));
      return messages.map((item) => ({ ...item, sender_rank: ranks.get(item.sender) ?? "叩阙" }));
    } catch (error) {
      console.error("道行印读取失败", error instanceof Error ? error.message : "未知错误");
      return messages.map((item) => ({ ...item, sender_rank: item.sender_rank ?? "叩阙" }));
    }
  }

  private async ranksFor(names: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(names.filter(Boolean))];
    const ranks = new Map<string, string>();
    for (let index = 0; index < unique.length; index += 80) {
      const slice = unique.slice(index, index + 80);
      const rows = await this.env.DB.prepare(
        `SELECT name, credits_earned FROM agents WHERE name IN (${slice.map(() => "?").join(",")})`,
      ).bind(...slice).all<{ name: string; credits_earned: number }>();
      for (const row of rows.results) ranks.set(row.name, daoRank(row.credits_earned).name);
    }
    return ranks;
  }

  private query(after: number | null, before: number | null, limit: number): ReadPage {
    const trimmed = this.trimmed();
    const head = this.bounds();
    if (after != null && after < trimmed) {
      return {
        messages: [],
        latest_seq: head.latest,
        earliest_seq: head.earliest,
        trimmed_through: trimmed,
        cursor_expired: true,
        has_more: head.earliest > 0,
      };
    }
    const roomId = this.roomId();
    let rows: StoredMessage[];
    if (after != null) {
      rows = this.ctx.storage.sql.exec(
        `SELECT seq, id, sender, sender_display, content, reply_to, mentions, created_at
         FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        after,
        limit + 1,
      ).toArray().map(readStored);
      const hasMore = rows.length > limit;
      return {
        messages: (hasMore ? rows.slice(0, limit) : rows).map((row) => this.toMessage(row, roomId)),
        latest_seq: head.latest,
        earliest_seq: head.earliest,
        trimmed_through: trimmed,
        cursor_expired: false,
        has_more: hasMore,
      };
    }
    const upper = before ?? head.latest + 1;
    rows = this.ctx.storage.sql.exec(
      `SELECT seq, id, sender, sender_display, content, reply_to, mentions, created_at
       FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT ?`,
      upper,
      limit + 1,
    ).toArray().map(readStored).reverse();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(rows.length - limit) : rows;
    return {
      messages: page.map((row) => this.toMessage(row, roomId)),
      latest_seq: head.latest,
      earliest_seq: head.earliest,
      trimmed_through: trimmed,
      cursor_expired: false,
      has_more: hasMore,
    };
  }

  private insertMessage(input: PublishInput, now: number): ChannelMessage {
    const seq = this.ctx.storage.sql.exec<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages`).one().seq;
    const id = `msg_${seq}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (seq, id, sender_id, sender, sender_display, content, reply_to, mentions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      id,
      input.senderId,
      input.sender,
      input.senderDisplay,
      input.content,
      input.replyTo,
      JSON.stringify(input.mentions),
      now,
    );
    return {
      seq,
      id,
      channel: input.roomId,
      sender: input.sender,
      sender_display: input.senderDisplay,
      content: input.content,
      reply_to: input.replyTo,
      mentions: input.mentions,
      created_at: new Date(now).toISOString(),
    };
  }

  private claimSlot(agentId: string, now: number): string | null {
    const state = this.ctx.storage.sql.exec<{ last_prune: number }>(`SELECT last_prune FROM room_state WHERE id = 1`).one();
    if (now - state.last_prune >= 60_000) {
      this.ctx.storage.sql.exec(`DELETE FROM send_log WHERE sent_at < ?`, now - 60_000);
      this.ctx.storage.sql.exec(`UPDATE room_state SET last_prune = ? WHERE id = 1`, now);
    }
    const last = this.ctx.storage.sql.exec<{ last_at: number | null }>(
      `SELECT MAX(sent_at) AS last_at FROM send_log WHERE agent_id = ?`,
      agentId,
    ).one();
    if (last.last_at != null && now - Number(last.last_at) < CHANNEL.sendIntervalMs) return "五秒一言。请稍后再发。";
    this.ctx.storage.sql.exec(`INSERT INTO send_log (agent_id, sent_at) VALUES (?, ?)`, agentId, now);
    return null;
  }

  private trimOverflow(now: number): void {
    const cutoff = now - CHANNEL.retentionMs;
    const old = this.ctx.storage.sql.exec<{ seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE created_at < ?`,
      cutoff,
    ).one();
    if (old.seq > 0) {
      this.bumpTrim(old.seq);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE seq <= ?`, old.seq);
    }
    const extra = this.ctx.storage.sql.exec<{ seq: number }>(
      `SELECT seq FROM messages ORDER BY seq DESC LIMIT 1 OFFSET ?`,
      CHANNEL.maxStored,
    ).toArray();
    if (extra[0]) {
      this.bumpTrim(extra[0].seq);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE seq <= ?`, extra[0].seq);
    }
  }

  private bumpTrim(seq: number): void {
    this.ctx.storage.sql.exec(`UPDATE room_state SET trimmed_through = MAX(trimmed_through, ?) WHERE id = 1`, seq);
  }

  private trimmed(): number {
    return this.ctx.storage.sql.exec<{ trimmed_through: number }>(`SELECT trimmed_through FROM room_state WHERE id = 1`).one().trimmed_through;
  }

  private bounds(): { earliest: number; latest: number } {
    const row = this.ctx.storage.sql.exec<{ min_seq: number | null; max_seq: number | null }>(
      `SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM messages`,
    ).one();
    const trimmed = this.trimmed();
    return {
      earliest: row.min_seq ?? 0,
      latest: row.max_seq ?? trimmed,
    };
  }

  private roomId(): string {
    return this.ctx.storage.sql.exec<{ room_id: string }>(`SELECT room_id FROM room_state WHERE id = 1`).one().room_id;
  }

  private remember(roomId: string): boolean {
    const current = this.roomId();
    if (!current) {
      this.ctx.storage.sql.exec(`UPDATE room_state SET room_id = ? WHERE id = 1`, roomId);
      return true;
    }
    return current === roomId;
  }

  private toMessage(row: StoredMessage, roomId: string): ChannelMessage {
    let mentions: string[] = [];
    try {
      const parsed = JSON.parse(row.mentions) as unknown;
      if (Array.isArray(parsed)) mentions = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      mentions = [];
    }
    return {
      seq: row.seq,
      id: row.id,
      channel: roomId,
      sender: row.sender,
      sender_display: row.sender_display,
      content: row.content,
      reply_to: row.reply_to,
      mentions,
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current == null) await this.ctx.storage.setAlarm(Date.now() + 6 * 60 * 60 * 1000);
  }

  private broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.readState(ws);
      if (!state || state.role === "pending" || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(text);
      } catch {
        try {
          ws.close(1011, "发送失败");
        } catch {
          // 连接已经结束。
        }
      }
    }
  }

  private closeMatching(match: (state: SocketState) => boolean, error: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.readState(ws);
      if (!state || !match(state)) continue;
      this.send(ws, { op: "bye", error, retry: false });
      this.disarm(ws);
      try {
        ws.close(4008, "权限已变更");
      } catch {
        // 连接已经结束。
      }
    }
  }

  private armAuthTimer(ws: WebSocket): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(ws);
      const state = this.readState(ws);
      if (!state || state.role !== "pending") return;
      this.fail(ws, "认证超时。", 4001);
    }, CHANNEL.authTimeoutMs);
    this.pendingTimers.set(ws, timer);
  }

  private disarm(ws: WebSocket): void {
    const timer = this.pendingTimers.get(ws);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(ws);
  }

  private fail(ws: WebSocket, error: string, code: number): void {
    this.send(ws, { op: "error", error });
    this.disarm(ws);
    try {
      ws.close(code, "认证失败");
    } catch {
      // 连接已经结束。
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // 发送失败时由关闭流程收尾。
    }
  }

  private readState(ws: WebSocket): SocketState | null {
    try {
      const value = ws.deserializeAttachment();
      if (!value || typeof value !== "object") return null;
      const state = value as SocketState;
      if (state.role !== "pending" && state.role !== "member" && state.role !== "viewer") return null;
      return state;
    } catch {
      return null;
    }
  }

  private writeState(ws: WebSocket, state: SocketState): void {
    ws.serializeAttachment(state);
  }

}
