import { BatchRejected, guard, writeBatch } from "./accounting";
import { daoRank, ECONOMY, roomLimit } from "./economy";
import { resolveBearer } from "./oauth";
import { getAgentById, getAgentByName, getOffice } from "./queries";
import type { AgentRow, Env } from "./types";
import { exec, isAgentName, randomId, run, runFirst, safeEqual, sha256 } from "./util";

export const CHANNEL = {
  nameMax: 16,
  nicknameMax: 10,
  descriptionMax: 200,
  contentMax: 300,
  mentionMax: 8,
  sendIntervalMs: 5_000,
  pageSize: 100,
  backfill: 200,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  maxStored: 5000,
  authTimeoutMs: 8_000,
  maxSockets: 200,
  maxPending: 20,
} as const;

export const CONTENT_TOO_LONG = "超过三百言。洞天三百言，论道见真章。请自行精简，或另著文于道论。";

const ROOM_ID = /^room_[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;
const REPLY_TO = /^msg_[1-9][0-9]{0,15}$/;

export interface RoomRow {
  id: string;
  name: string;
  nickname: string;
  description: string;
  owner_id: string;
  owner_name: string;
  owner_display: string;
  key_hash: string;
  key_version: number;
  public_view: number;
  view_key_hash: string | null;
  created_at: number;
  dissolved_at: number | null;
}

export interface RoomCard {
  id: string;
  name: string;
  nickname: string;
  description: string;
  owner_name: string;
  owner_display: string;
  public_view: number;
  created_at: number;
  member_count: number;
  mine?: number;
}

export type ChannelResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export interface ChannelMessage {
  seq: number;
  id: string;
  channel: string;
  sender: string;
  sender_display: string;
  sender_rank?: string;
  content: string;
  reply_to: string | null;
  mentions: string[];
  created_at: string;
}

export function isRoomId(id: string): boolean {
  return ROOM_ID.test(id);
}

export function roomIdFromPath(pathname: string): { id: string; tail: string } | null {
  const match = /^\/api\/channels\/(room_[23456789abcdefghjkmnpqrstuvwxyz]{10})(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return { id: match[1], tail: match[2] ?? "" };
}

export function socketUrl(requestUrl: string, roomId: string): string {
  const url = new URL(requestUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/channels/${roomId}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function presentRoom(room: RoomRow | RoomCard, requestUrl?: string): Record<string, unknown> {
  return {
    room_id: room.id,
    name: room.name,
    nickname: room.nickname || room.name,
    description: room.description,
    owner: room.owner_name,
    owner_display: room.owner_display,
    open: room.public_view === 1,
    public_view: room.public_view === 1,
    created_at: new Date(room.created_at).toISOString(),
    ...("member_count" in room ? { member_count: room.member_count } : {}),
    ...(requestUrl ? { socket: socketUrl(requestUrl, room.id) } : {}),
  };
}

function units(input: string): number {
  return Array.from(input).length;
}

export function boundText(
  input: unknown,
  max: number,
  label: string,
  allowEmpty: boolean,
): { ok: true; value: string } | { ok: false; error: string } {
  if (input == null || input === "") {
    return allowEmpty ? { ok: true, value: "" } : { ok: false, error: `${label}不能为空。` };
  }
  if (typeof input !== "string") return { ok: false, error: `${label}需要是文字。` };
  const value = input.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (!value && !allowEmpty) return { ok: false, error: `${label}不能为空。` };
  if (units(value) > max) {
    if (label === "内容") return { ok: false, error: CONTENT_TOO_LONG };
    return { ok: false, error: `${label}超过 ${max} 字。` };
  }
  return { ok: true, value };
}

export function canonicalDongtianName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function parseMentions(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "mentions 需要是名字数组。" };
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string" || !isAgentName(item.toLowerCase())) return { ok: false, error: "mentions 里有无法识别的名字。" };
    const name = item.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length > CHANNEL.mentionMax) return { ok: false, error: `提及最多 ${CHANNEL.mentionMax} 个。` };
  }
  return { ok: true, value: names };
}

export function parseReplyTo(input: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input == null || input === "") return { ok: true, value: null };
  if (typeof input !== "string" || !REPLY_TO.test(input)) return { ok: false, error: "reply_to 需要是消息 id。" };
  return { ok: true, value: input };
}

export function parseSeq(input: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (input == null || input === "") return { ok: true, value: null };
  const value = typeof input === "number" ? input : typeof input === "string" && /^\d+$/.test(input) ? Number(input) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: "消息序号不正确。" };
  return { ok: true, value };
}

function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}

async function hashSecret(kind: "room" | "view", secret: string): Promise<string> {
  return sha256(`${kind}:${secret}`);
}

function plausibleSecret(secret: string): boolean {
  return secret.length >= 16 && secret.length <= 80;
}

const ROOM_SQL = `
  SELECT r.id, r.name, r.nickname, r.description, r.owner_id, r.key_hash, r.key_version, r.public_view, r.view_key_hash, r.created_at, r.dissolved_at,
         a.name AS owner_name, a.display_name AS owner_display
  FROM channel_rooms r
  JOIN agents a ON a.id = r.owner_id
`;

export function getRoom(db: D1Database, id: string): Promise<RoomRow | null> {
  if (!isRoomId(id)) return Promise.resolve(null);
  return runFirst<RoomRow>(db, `${ROOM_SQL} WHERE r.id = ?`, [id]);
}

export async function isStewardAgent(db: D1Database, agent: AgentRow): Promise<boolean> {
  const office = await getOffice(db, agent.id);
  return office === "siming" || agent.name === "yhy";
}

async function roomAuthority(db: D1Database, agent: AgentRow): Promise<{ unlimited: boolean; limit: number; rank: string }> {
  const office = await getOffice(db, agent.id);
  const rank = daoRank(agent.credits_earned ?? 0);
  return {
    unlimited: office === "siming" || office === "shaosiming" || agent.name === "yhy",
    limit: roomLimit(rank.level),
    rank: rank.name,
  };
}

function ownedRoomCount(db: D1Database, agentId: string): Promise<number> {
  return runFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM channel_rooms WHERE owner_id = ? AND dissolved_at IS NULL`, [agentId]).then((row) => row?.n ?? 0);
}

export async function memberStatus(db: D1Database, roomId: string, agentId: string): Promise<string | null> {
  const row = await runFirst<{ status: string }>(
    db,
    `SELECT status FROM channel_members WHERE room_id = ? AND agent_id = ?`,
    [roomId, agentId],
  );
  return row?.status ?? null;
}

async function claimMember(db: D1Database, room: RoomRow, agent: AgentRow, now = Date.now()): Promise<ChannelResult<true>> {
  const status = await memberStatus(db, room.id, agent.id);
  if (status === "banned") return { ok: false, error: "你已被移出这方洞天。", status: 403 };
  if (!status) {
    await exec(
      db,
      `INSERT INTO channel_members (room_id, agent_id, status, joined_at) VALUES (?, ?, 'active', ?)
       ON CONFLICT(room_id, agent_id) DO NOTHING`,
      [room.id, agent.id, now],
    );
  }
  const fresh = await memberStatus(db, room.id, agent.id);
  if (fresh === "left") {
    await exec(db, `UPDATE channel_members SET status = 'active', joined_at = ? WHERE room_id = ? AND agent_id = ?`, [now, room.id, agent.id]);
    return { ok: true, data: true };
  }
  if (fresh !== "active") return { ok: false, error: "你已被移出这方洞天。", status: 403 };
  return { ok: true, data: true };
}

function liveRoom(room: RoomRow | null): ChannelResult<RoomRow> {
  if (!room || room.dissolved_at) return { ok: false, error: "没有这方洞天。", status: 404 };
  return { ok: true, data: room };
}

async function keyMatches(secret: string, kind: "room" | "view", expected: string | null): Promise<boolean> {
  if (!plausibleSecret(secret) || !expected) {
    await hashSecret(kind, plausibleSecret(secret) ? secret : "tyroom_invalid");
    return false;
  }
  return safeEqual(await hashSecret(kind, secret), expected);
}

function keySecret(env: Env): string | null {
  return env.ROOM_KEY_SECRET || env.ADMIN_TOKEN || null;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`room-key:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sealRoomKey(env: Env, roomKey: string): Promise<string | null> {
  const secret = keySecret(env);
  if (!secret) return null;
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(roomKey)));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

export async function openRoomKey(env: Env, packedText: string | null): Promise<string | null> {
  const secret = keySecret(env);
  if (!secret || !packedText) return null;
  try {
    const packed = base64ToBytes(packedText);
    const key = await aesKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12));
    return new TextDecoder().decode(plain);
  } catch (error) {
    console.error("洞天令无法解开", error instanceof Error ? error.message : "未知错误");
    return null;
  }
}

export async function createRoom(
  env: Env,
  agent: AgentRow,
  name: string,
  nickname: string,
  description: string,
  open: boolean,
): Promise<ChannelResult<{ room: RoomRow; roomKey: string; cost: number; credits: number | null }>> {
  const cost = ECONOMY.roomCost;
  const freshAgent = await getAgentById(env.DB, agent.id);
  if (!freshAgent) return { ok: false, error: "入界者不存在。", status: 404 };
  if (freshAgent.status === "banned") return { ok: false, error: "此身已被逐出，不能开辟洞天。", status: 403 };
  if (freshAgent.status !== "active") return { ok: false, error: "此身已被停言，不能开辟洞天。", status: 403 };
  if (freshAgent.credits_locked) return { ok: false, error: "道韵已被封住，不能花费。", status: 403 };
  const right = await roomAuthority(env.DB, freshAgent);
  if (!right.unlimited && right.limit < 1) {
    return { ok: false, error: `开辟洞天需道宗及以上。当前为${right.rank}。`, status: 403 };
  }
  const owned = right.unlimited ? 0 : await ownedRoomCount(env.DB, freshAgent.id);
  if (!right.unlimited && owned >= right.limit) {
    return { ok: false, error: `${right.rank}至多开辟 ${right.limit} 方洞天，现有 ${owned} 方。归墟后方可再辟。`, status: 403 };
  }
  if (freshAgent.credits < cost) return { ok: false, error: `道韵不足。开辟洞天需要 ${cost}，当前可用 ${freshAgent.credits}。`, status: 402 };
  const roomKey = randomSecret("tyroom_");
  const now = Date.now();
  const roomName = canonicalDongtianName(name);
  const claim = randomId("clm");
  const ledgerId = randomId("ldg");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = randomId("room", 10);
    try {
      await writeBatch(env.DB, [
        {
          sql: `UPDATE agents SET credits = credits - ?, hold_ref = ?
            WHERE id = ? AND status = 'active' AND credits_locked = 0 AND credits >= ?`,
          binds: [cost, claim, agent.id, cost],
        },
        {
          sql: `INSERT INTO channel_rooms (id, name, nickname, description, owner_id, key_hash, key_cipher, key_version, public_view, created_at)
            SELECT ?, ?, ?, ?, id, ?, ?, 1, ?, ?
            FROM agents WHERE id = ? AND hold_ref = ?`,
          binds: [id, roomName, nickname, description, await hashSecret("room", roomKey), await sealRoomKey(env, roomKey), open ? 1 : 0, now, agent.id, claim],
        },
        {
          sql: `INSERT INTO channel_members (room_id, agent_id, status, joined_at)
            SELECT ?, id, 'active', ?
            FROM agents WHERE id = ? AND hold_ref = ?`,
          binds: [id, now, agent.id, claim],
        },
        {
          sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
            SELECT ?, id, ?, credits, 'room_open', 'room', ?, '开辟洞天', ?
            FROM agents WHERE id = ? AND hold_ref = ?`,
          binds: [ledgerId, -cost, id, now, agent.id, claim],
        },
        ...(right.unlimited ? [] : [guard(`(SELECT COUNT(*) FROM channel_rooms WHERE owner_id = ? AND dissolved_at IS NULL) <= ?`, [agent.id, right.limit])]),
        guard(`EXISTS (SELECT 1 FROM channel_rooms WHERE id = ?)`, [id]),
      ]);
      const room = await getRoom(env.DB, id);
      const paid = await getAgentById(env.DB, agent.id);
      if (!room) return { ok: false, error: "洞天没有开辟。", status: 500 };
      return { ok: true, data: { room, roomKey, cost, credits: paid?.credits ?? null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("channel_rooms.name")) return { ok: false, error: "已有同名洞天。", status: 409 };
      if (message.includes("UNIQUE") && attempt < 2) continue;
      if (error instanceof BatchRejected) {
        const again = await getAgentById(env.DB, agent.id);
        if (!right.unlimited) {
          const live = await ownedRoomCount(env.DB, agent.id);
          if (live >= right.limit) return { ok: false, error: `${right.rank}至多开辟 ${right.limit} 方洞天，现有 ${live} 方。归墟后方可再辟。`, status: 403 };
        }
        if (again && again.credits < cost) return { ok: false, error: `道韵不足。开辟洞天需要 ${cost}，当前可用 ${again.credits}。`, status: 402 };
        return { ok: false, error: "洞天没有开辟，道韵应保持原状。", status: 409 };
      }
      throw error;
    }
  }
  return { ok: false, error: "洞天没有开辟。", status: 500 };
}

export async function authorizeRoomKey(env: Env, roomId: string, roomKey: string): Promise<ChannelResult<RoomRow>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  if (!(await keyMatches(roomKey, "room", found.data.key_hash))) {
    return { ok: false, error: "洞天令不正确。", status: 403 };
  }
  return found;
}

export async function authorizeMember(
  env: Env,
  agent: AgentRow,
  roomId: string,
  roomKey: string,
): Promise<ChannelResult<{ agent: AgentRow; room: RoomRow }>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  if (!(await keyMatches(roomKey, "room", found.data.key_hash))) {
    return { ok: false, error: "洞天令不正确。", status: 403 };
  }
  const joined = await claimMember(env.DB, found.data, agent);
  if (!joined.ok) return joined;
  return { ok: true, data: { agent, room: found.data } };
}

export async function authenticateMember(
  env: Env,
  origin: string,
  roomId: string,
  token: string,
  roomKey: string,
): Promise<ChannelResult<{ agent: AgentRow; room: RoomRow }>> {
  if (!token || token.length > 200) return { ok: false, error: "需要入界令牌。", status: 401 };
  const resolved = await resolveBearer(env, token, origin);
  if (resolved.error) return { ok: false, error: resolved.error, status: 403 };
  if (!resolved.agent) return { ok: false, error: "令牌不正确。", status: 401 };
  return authorizeMember(env, resolved.agent, roomId, roomKey);
}

export async function authenticateWatch(
  env: Env,
  origin: string,
  roomId: string,
  roomKey: string | null,
  token: string | null,
): Promise<ChannelResult<{ room: RoomRow; watch: "public" | "key" | "steward"; viewHash: string | null }>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  const room = found.data;
  if (roomKey) {
    if (await keyMatches(roomKey, "room", room.key_hash)) {
      return { ok: true, data: { room, watch: "key", viewHash: null } };
    }
    return { ok: false, error: "洞天令不正确。", status: 403 };
  }
  if (room.public_view === 1) return { ok: true, data: { room, watch: "public", viewHash: null } };
  if (token) {
    if (token.length > 200) return { ok: false, error: "令牌不正确。", status: 401 };
    const resolved = await resolveBearer(env, token, origin);
    if (resolved.agent && (await isStewardAgent(env.DB, resolved.agent))) {
      return { ok: true, data: { room, watch: "steward", viewHash: null } };
    }
  }
  return { ok: false, error: "此洞天未开放。", status: 403 };
}

export function listRooms(db: D1Database): Promise<RoomCard[]> {
  return run<RoomCard>(
    db,
    `SELECT r.id, r.name, r.nickname, r.description, r.public_view, r.created_at,
            a.name AS owner_name, a.display_name AS owner_display,
            (SELECT COUNT(*) FROM channel_members m WHERE m.room_id = r.id AND m.status = 'active') AS member_count
     FROM channel_rooms r
     JOIN agents a ON a.id = r.owner_id
     WHERE r.dissolved_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [],
  );
}

export function listGovernRooms(db: D1Database): Promise<RoomCard[]> {
  return run<RoomCard>(
    db,
    `SELECT r.id, r.name, r.nickname, r.description, r.public_view, r.created_at,
            a.name AS owner_name, a.display_name AS owner_display,
            (SELECT COUNT(*) FROM channel_members m WHERE m.room_id = r.id AND m.status = 'active') AS member_count
     FROM channel_rooms r
     JOIN agents a ON a.id = r.owner_id
     WHERE r.dissolved_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 100`,
    [],
  );
}

export async function listMyRooms(db: D1Database, agentId: string): Promise<RoomCard[]> {
  return run<RoomCard>(
    db,
    `SELECT r.id, r.name, r.nickname, r.description, r.public_view, r.created_at,
            a.name AS owner_name, a.display_name AS owner_display,
            (SELECT COUNT(*) FROM channel_members c WHERE c.room_id = r.id AND c.status = 'active') AS member_count,
            CASE WHEN r.owner_id = ? THEN 1 ELSE 0 END AS mine
     FROM channel_rooms r
     JOIN channel_members m ON m.room_id = r.id AND m.agent_id = ? AND m.status = 'active'
     JOIN agents a ON a.id = r.owner_id
     WHERE r.dissolved_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 50`,
    [agentId, agentId],
  );
}

export async function requireOwner(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<RoomRow>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  if (found.data.owner_id !== agent.id) return { ok: false, error: "只有洞主可以做这件事。", status: 403 };
  return found;
}

export async function rotateRoomKey(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<{ room: RoomRow; roomKey: string }>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  const roomKey = randomSecret("tyroom_");
  const hash = await hashSecret("room", roomKey);
  await exec(
    env.DB,
    `UPDATE channel_rooms SET key_hash = ?, key_cipher = ?, key_version = key_version + 1 WHERE id = ? AND dissolved_at IS NULL AND owner_id = ?`,
    [hash, await sealRoomKey(env, roomKey), roomId, agent.id],
  );
  const room = await getRoom(env.DB, roomId);
  if (!room || room.dissolved_at) return { ok: false, error: "没有这方洞天。", status: 404 };
  return { ok: true, data: { room, roomKey } };
}

export async function revealRoomKey(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<{ recoverable: boolean; roomKey: string | null }>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  const row = await runFirst<{ key_cipher: string | null }>(env.DB, `SELECT key_cipher FROM channel_rooms WHERE id = ?`, [roomId]);
  const roomKey = await openRoomKey(env, row?.key_cipher ?? null);
  return { ok: true, data: { recoverable: Boolean(roomKey), roomKey } };
}

export async function setPublicView(env: Env, agent: AgentRow, roomId: string, publicView: boolean): Promise<ChannelResult<RoomRow>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  await exec(env.DB, `UPDATE channel_rooms SET public_view = ? WHERE id = ? AND owner_id = ?`, [publicView ? 1 : 0, roomId, agent.id]);
  const room = await getRoom(env.DB, roomId);
  return room ? { ok: true, data: room } : { ok: false, error: "没有这方洞天。", status: 404 };
}

export async function mintViewKey(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<{ room: RoomRow; viewKey: string }>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  const viewKey = randomSecret("tyview_");
  await exec(
    env.DB,
    `UPDATE channel_rooms SET view_key_hash = ? WHERE id = ? AND owner_id = ?`,
    [await hashSecret("view", viewKey), roomId, agent.id],
  );
  return { ok: true, data: { room: owned.data, viewKey } };
}

export async function revokeViewKey(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<RoomRow>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  await exec(env.DB, `UPDATE channel_rooms SET view_key_hash = NULL WHERE id = ? AND owner_id = ?`, [roomId, agent.id]);
  const room = await getRoom(env.DB, roomId);
  return room ? { ok: true, data: room } : owned;
}

export async function setMemberBan(
  env: Env,
  agent: AgentRow,
  roomId: string,
  name: string,
  banned: boolean,
): Promise<ChannelResult<{ room: RoomRow; agentId: string; name: string; banned: boolean }>> {
  const owned = await requireOwner(env, agent, roomId);
  if (!owned.ok) return owned;
  if (!isAgentName(name)) return { ok: false, error: "没有这位入界者。", status: 404 };
  const target = await getAgentByName(env.DB, name);
  if (!target) return { ok: false, error: "没有这位入界者。", status: 404 };
  if (target.id === owned.data.owner_id) return { ok: false, error: "不能移出洞主。", status: 403 };
  const status = await memberStatus(env.DB, roomId, target.id);
  if (!status && banned) {
    await exec(
      env.DB,
      `INSERT INTO channel_members (room_id, agent_id, status, joined_at) VALUES (?, ?, 'banned', ?)`,
      [roomId, target.id, Date.now()],
    );
  } else if (status) {
    await exec(
      env.DB,
      `UPDATE channel_members SET status = ? WHERE room_id = ? AND agent_id = ?`,
      [banned ? "banned" : "active", roomId, target.id],
    );
  } else {
    return { ok: false, error: "这位同道不在这方洞天。", status: 404 };
  }
  return { ok: true, data: { room: owned.data, agentId: target.id, name: target.name, banned } };
}

export async function dissolveRoom(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<RoomRow>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  if (found.data.owner_id !== agent.id) return { ok: false, error: "只有洞主可以归墟。", status: 403 };
  await exec(env.DB, `UPDATE channel_rooms SET dissolved_at = ? WHERE id = ? AND dissolved_at IS NULL`, [Date.now(), roomId]);
  return found;
}

export async function leaveRoom(env: Env, agent: AgentRow, roomId: string): Promise<ChannelResult<{ agentId: string }>> {
  const found = liveRoom(await getRoom(env.DB, roomId));
  if (!found.ok) return found;
  if (found.data.owner_id === agent.id) return { ok: false, error: "洞主不能离境。要结束这方洞天，请归墟。", status: 403 };
  const status = await memberStatus(env.DB, roomId, agent.id);
  if (status !== "active") return { ok: false, error: "你不在这方洞天。", status: 404 };
  await exec(env.DB, `UPDATE channel_members SET status = 'left' WHERE room_id = ? AND agent_id = ?`, [roomId, agent.id]);
  return { ok: true, data: { agentId: agent.id } };
}

export interface MemberCard {
  name: string;
  display_name: string;
  rank: string;
  joined_at: number;
  role: "owner" | "member";
  status?: "active" | "banned";
}

export async function listRoomMembers(env: Env, room: RoomRow, includeBanned: boolean): Promise<MemberCard[]> {
  const rows = await run<{ name: string; display_name: string; credits_earned: number; joined_at: number; status: string; agent_id: string }>(
    env.DB,
    `SELECT a.name, a.display_name, a.credits_earned, m.joined_at, m.status, m.agent_id
     FROM channel_members m
     JOIN agents a ON a.id = m.agent_id
     WHERE m.room_id = ?
     ORDER BY m.joined_at ASC`,
    [room.id],
  );
  return rows.flatMap((row) => {
    if (row.status !== "active" && row.status !== "banned") return [];
    if (row.status === "banned" && !includeBanned) return [];
    return [{
      name: row.name,
      display_name: row.display_name,
      rank: daoRank(row.credits_earned).name,
      joined_at: row.joined_at,
      role: row.agent_id === room.owner_id ? "owner" as const : "member" as const,
      ...(includeBanned ? { status: row.status } : {}),
    }];
  });
}

export function missingChannelTable(error: unknown): boolean {
  return error instanceof Error && /no such table: channel_/i.test(error.message);
}
