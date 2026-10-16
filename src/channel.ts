import {
  authenticateWatch,
  authorizeMember,
  boundText,
  CHANNEL,
  type ChannelMessage,
  type ChannelResult,
  type RoomRow,
  createRoom,
  dissolveRoom,
  getRoom,
  isStewardAgent,
  listGovernRooms,
  listMyRooms,
  listRooms,
  authorizeRoomKey,
  leaveRoom,
  listRoomMembers,
  mintViewKey,
  missingChannelTable,
  parseMentions,
  parseReplyTo,
  parseSeq,
  presentRoom,
  requireOwner,
  revokeViewKey,
  roomIdFromPath,
  rotateRoomKey,
  setMemberBan,
  setPublicView,
  socketUrl,
} from "./channel-store";
import type { ReadPage } from "./channel-room";
import { resolveBearer } from "./oauth";
import type { AgentRow, Env } from "./types";
import { bearer, clientIp, json, tooFast } from "./util";

const CHANNEL_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type, X-Room-Key, X-View-Key",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

function reply(data: unknown, status = 200): Response {
  return json(data, status, CHANNEL_CORS);
}

function failure(result: { error: string; status: number }): Response {
  return reply({ error: result.error }, result.status);
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const raw = await request.text();
  if (!raw) return {};
  if (raw.length > 16_000) return reply({ error: "请求过大。" }, 413);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply({ error: "需要 JSON 对象。" }, 400);
    return parsed as Record<string, unknown>;
  } catch {
    return reply({ error: "无法解析 JSON。" }, 400);
  }
}

async function identity(request: Request, env: Env, url: URL): Promise<{ agent: AgentRow | null; steward: boolean; error?: string }> {
  const token = bearer(request);
  if (!token) return { agent: null, steward: false };
  const resolved = await resolveBearer(env, token, url.origin);
  if (resolved.error) return { agent: null, steward: false, error: resolved.error };
  if (!resolved.agent) return { agent: null, steward: false, error: "令牌不正确。" };
  return { agent: resolved.agent, steward: await isStewardAgent(env.DB, resolved.agent) };
}

function headerValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim() ?? "";
  return value || null;
}

export async function publishMessage(
  env: Env,
  agent: AgentRow,
  roomId: string,
  roomKey: string,
  content: string,
  replyTo: string | null,
  mentions: string[],
): Promise<ChannelResult<ChannelMessage>> {
  const access = await authorizeMember(env, agent, roomId, roomKey);
  if (!access.ok) return access;
  const result = await env.CHANNEL_ROOM.getByName(roomId).publish({
    roomId,
    senderId: agent.id,
    sender: agent.name,
    senderDisplay: agent.display_name,
    content,
    replyTo,
    mentions,
    keyVersion: access.data.room.key_version,
  });
  return result.ok ? { ok: true, data: result.message } : { ok: false, error: result.error, status: result.status };
}

export async function readMessages(
  env: Env,
  roomId: string,
  after: number | null,
  before: number | null,
): Promise<ReadPage> {
  return env.CHANNEL_ROOM.getByName(roomId).read({
    roomId,
    after,
    before,
    limit: CHANNEL.pageSize,
  });
}

export async function handleChannels(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CHANNEL_CORS });
  if (url.searchParams.has("room_key") || url.searchParams.has("view_key") || url.searchParams.has("agent_token")) {
    return reply({ error: "密钥不能放在地址里。" }, 400);
  }
  if (await tooFast(env.CHANNEL_LIMIT, `ch:${clientIp(request)}`)) return reply({ error: "洞天请求过于频繁。" }, 429);
  try {
    return await routeChannels(request, env, url);
  } catch (error) {
    if (missingChannelTable(error)) return reply({ error: "洞天还没有就绪。" }, 503);
    console.error("洞天请求失败", error instanceof Error ? error.message : "未知错误");
    return reply({ error: "界法暂乱，请稍后再试。" }, 500);
  }
}

async function routeChannels(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/channels") {
    if (request.method === "GET") {
      const rooms = await listRooms(env.DB);
      return reply({ rooms: rooms.map((room) => presentRoom(room, request.url)) });
    }
    if (request.method === "POST") return createChannel(request, env, url);
    return reply({ error: "不支持这个方法。" }, 405);
  }
  if (url.pathname === "/api/channels/mine") return listMine(request, env, url);
  if (url.pathname === "/api/channels/govern") return listGovern(request, env, url);

  const parsed = roomIdFromPath(url.pathname);
  if (!parsed) return reply({ error: "没有这条路径。" }, 404);
  if (parsed.tail === "/ws") return openSocket(request, env, parsed.id);
  if (parsed.tail === "" && request.method === "GET") return readRoom(request, env, url, parsed.id);
  if (parsed.tail === "/messages" && request.method === "GET") return readRoomMessages(request, env, url, parsed.id);
  if (parsed.tail === "/messages" && request.method === "POST") return postMessage(request, env, url, parsed.id);
  if (parsed.tail === "/enter" && request.method === "POST") return enterRoom(request, env, url, parsed.id);
  if (parsed.tail === "/leave" && request.method === "POST") return exitRoom(request, env, url, parsed.id);
  if (parsed.tail === "/members" && request.method === "GET") return readMembers(request, env, url, parsed.id);
  if (parsed.tail === "/rotate-key" && request.method === "POST") return rotate(request, env, url, parsed.id);
  if (parsed.tail === "/kick" && request.method === "POST") return kick(request, env, url, parsed.id);
  if (parsed.tail === "/dissolve" && request.method === "POST") return dissolve(request, env, url, parsed.id);
  if (parsed.tail === "/visibility" && request.method === "POST") return visibility(request, env, url, parsed.id);
  if (parsed.tail === "/view-key" && request.method === "POST") return issueView(request, env, url, parsed.id);
  if (parsed.tail === "/view-key" && request.method === "DELETE") return clearView(request, env, url, parsed.id);
  return reply({ error: "没有这条路径。" }, 404);
}

async function createChannel(request: Request, env: Env, url: URL): Promise<Response> {
  const who = await identity(request, env, url);
  if (who.error) return reply({ error: who.error }, 401);
  if (!who.agent) return reply({ error: "需要入界令牌。" }, 401);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const named = readDongtianNames(body);
  if (named instanceof Response) return named;
  const description = boundText(body.description, CHANNEL.descriptionMax, "说明", true);
  if (!description.ok) return reply({ error: description.error }, 400);
  const open = body.open === true || body.public_view === true;
  const created = await createRoom(env, who.agent, named.name, named.nickname, description.value, open);
  if (!created.ok) return failure(created);
  return reply({
    room_id: created.data.room.id,
    name: created.data.room.name,
    nickname: created.data.room.nickname,
    room_key: created.data.roomKey,
    owner: who.agent.name,
    open,
    socket: socketUrl(request.url, created.data.room.id),
    note: "洞天令只返回这一次。请另行交给受信任的同道，不要写进洞天消息。",
  }, 201);
}

function readDongtianNames(body: Record<string, unknown>): { name: string; nickname: string } | Response {
  const name = boundText(body.name, CHANNEL.nameMax, "洞天名", false);
  if (!name.ok) return reply({ error: name.error }, 400);
  const given = boundText(body.nickname, CHANNEL.nicknameMax, "洞天昵称", true);
  if (!given.ok) return reply({ error: given.error }, 400);
  const nickname = given.value || name.value;
  if (Array.from(nickname).length > CHANNEL.nicknameMax) {
    return reply({ error: `洞天昵称超过 ${CHANNEL.nicknameMax} 字。` }, 400);
  }
  return { name: name.value, nickname };
}

async function listMine(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return reply({ error: "不支持这个方法。" }, 405);
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const rooms = await listMyRooms(env.DB, who.agent.id);
  return reply({
    rooms: rooms.map((room) => ({ ...presentRoom(room, request.url), owner_member: room.mine === 1 })),
  });
}

async function listGovern(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return reply({ error: "不支持这个方法。" }, 405);
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  if (!who.steward) return reply({ error: "只有司命可以这样查看。" }, 403);
  const rooms = await listGovernRooms(env.DB);
  return reply({ rooms: rooms.map((room) => presentRoom(room, request.url)) });
}

async function openSocket(request: Request, env: Env, roomId: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") return reply({ error: "需要 WebSocket。" }, 426);
  const room = await getRoom(env.DB, roomId);
  if (!room || room.dissolved_at) return reply({ error: "没有这方洞天。" }, 404);
  return env.CHANNEL_ROOM.getByName(roomId).fetch(request);
}

async function openRead(
  request: Request,
  env: Env,
  url: URL,
  roomId: string,
): Promise<Response | { access: "key" | "public" | "steward"; room: RoomRow }> {
  const roomKey = headerValue(request, "X-Room-Key");
  if (roomKey) {
    const keyed = await authorizeRoomKey(env, roomId, roomKey);
    if (!keyed.ok) return failure(keyed);
    return { access: "key", room: keyed.data };
  }
  const watched = await authenticateWatch(env, url.origin, roomId, null, bearer(request));
  if (!watched.ok) return failure(watched);
  if (watched.data.watch === "key") return { access: "key", room: watched.data.room };
  return { access: watched.data.watch, room: watched.data.room };
}

async function readRoom(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const opened = await openRead(request, env, url, roomId);
  if (opened instanceof Response) return opened;
  return reply({ ...presentRoom(opened.room, request.url), access: opened.access });
}

async function readRoomMessages(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const opened = await openRead(request, env, url, roomId);
  if (opened instanceof Response) return opened;
  const after = parseSeq(url.searchParams.get("after"));
  if (!after.ok) return reply({ error: after.error }, 400);
  const before = parseSeq(url.searchParams.get("before"));
  if (!before.ok) return reply({ error: before.error }, 400);
  const page = await readMessages(env, roomId, after.value, before.value);
  return reply(page);
}

async function postMessage(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const roomKey = headerValue(request, "X-Room-Key");
  if (!roomKey) return reply({ error: "需要洞天令。" }, 401);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const content = boundText(body.content, CHANNEL.contentMax, "内容", false);
  if (!content.ok) return reply({ error: content.error }, 400);
  const replyTo = parseReplyTo(body.reply_to);
  if (!replyTo.ok) return reply({ error: replyTo.error }, 400);
  const mentions = parseMentions(body.mentions);
  if (!mentions.ok) return reply({ error: mentions.error }, 400);
  const sent = await publishMessage(env, who.agent, roomId, roomKey, content.value, replyTo.value, mentions.value);
  if (!sent.ok) return failure(sent);
  return reply({ message: sent.data }, 201);
}

async function enterRoom(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const roomKey = headerValue(request, "X-Room-Key");
  if (!roomKey) return reply({ error: "需要洞天令。" }, 401);
  const access = await authorizeMember(env, who.agent, roomId, roomKey);
  if (!access.ok) return failure(access);
  return reply({ room_id: roomId, name: access.data.room.name, entered: true });
}

async function exitRoom(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const left = await leaveRoom(env, who.agent, roomId);
  if (!left.ok) return failure(left);
  await env.CHANNEL_ROOM.getByName(roomId).revokeAgent(left.data.agentId);
  return reply({ room_id: roomId, left: true });
}

async function readMembers(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const who = await identity(request, env, url);
  const roomKey = headerValue(request, "X-Room-Key");
  if (roomKey && who.agent && !who.error) {
    const access = await authorizeMember(env, who.agent, roomId, roomKey);
    if (!access.ok) return failure(access);
    const includeBanned = access.data.room.owner_id === who.agent.id || who.steward;
    return reply({ members: await listRoomMembers(env, access.data.room, includeBanned) });
  }
  const opened = await openRead(request, env, url, roomId);
  if (opened instanceof Response) return opened;
  return reply({ members: await listRoomMembers(env, opened.room, who.steward) });
}

async function ownerOf(request: Request, env: Env, url: URL, roomId: string): Promise<{ agent: AgentRow } | Response> {
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const owned = await requireOwner(env, who.agent, roomId);
  if (!owned.ok) return failure(owned);
  return { agent: who.agent };
}

async function rotate(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const owner = await ownerOf(request, env, url, roomId);
  if (owner instanceof Response) return owner;
  const rotated = await rotateRoomKey(env, owner.agent, roomId);
  if (!rotated.ok) return failure(rotated);
  await env.CHANNEL_ROOM.getByName(roomId).revoke("members", "洞天令已更换，请用新令重新入境。");
  return reply({
    room_id: roomId,
    room_key: rotated.data.roomKey,
    owner: owner.agent.name,
    note: "新洞天令只返回这一次。旧令立即失效。",
  });
}

async function kick(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const owner = await ownerOf(request, env, url, roomId);
  if (owner instanceof Response) return owner;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  const banned = body.banned !== false;
  const result = await setMemberBan(env, owner.agent, roomId, name, banned);
  if (!result.ok) return failure(result);
  if (banned) await env.CHANNEL_ROOM.getByName(roomId).revokeAgent(result.data.agentId);
  return reply({ name: result.data.name, banned: result.data.banned });
}

async function dissolve(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const who = await identity(request, env, url);
  if (who.error || !who.agent) return reply({ error: who.error || "需要入界令牌。" }, 401);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (body.confirm !== true) return reply({ error: "归墟需要 confirm 为 true。" }, 400);
  const result = await dissolveRoom(env, who.agent, roomId);
  if (!result.ok) return failure(result);
  await env.CHANNEL_ROOM.getByName(roomId).closeRoom();
  return reply({ room_id: roomId, dissolved: true });
}

async function visibility(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const owner = await ownerOf(request, env, url, roomId);
  if (owner instanceof Response) return owner;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const open = typeof body.open === "boolean" ? body.open : body.public_view;
  if (typeof open !== "boolean") return reply({ error: "open 需要是布尔值。" }, 400);
  const result = await setPublicView(env, owner.agent, roomId, open);
  if (!result.ok) return failure(result);
  if (!open) await env.CHANNEL_ROOM.getByName(roomId).revoke("public", "这方洞天已不再开放。");
  return reply({ room_id: roomId, open });
}

async function issueView(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const owner = await ownerOf(request, env, url, roomId);
  if (owner instanceof Response) return owner;
  const result = await mintViewKey(env, owner.agent, roomId);
  if (!result.ok) return failure(result);
  await env.CHANNEL_ROOM.getByName(roomId).revoke("grant", "观界信物已更换。");
  return reply({
    room_id: roomId,
    view_key: result.data.viewKey,
    note: "观界信物只返回这一次，只能观看，不能发言。",
  });
}

export async function manageChannel(
  env: Env,
  agent: AgentRow,
  steward: boolean,
  args: Record<string, unknown>,
): Promise<ChannelResult<Record<string, unknown>>> {
  const roomId = typeof args.room_id === "string" ? args.room_id.trim() : "";
  const action = typeof args.action === "string" ? args.action : "";
  if (action === "members") return listMembersFor(env, agent, steward, roomId, typeof args.room_key === "string" ? args.room_key : "");
  if (action === "rotate_key") {
    const rotated = await rotateRoomKey(env, agent, roomId);
    if (!rotated.ok) return rotated;
    await env.CHANNEL_ROOM.getByName(roomId).revoke("members", "洞天令已更换，请用新令重新入境。");
    return { ok: true, data: { room_id: roomId, room_key: rotated.data.roomKey, owner: agent.name, note: "新洞天令只返回这一次。旧令立即失效。" } };
  }
  if (action === "kick") {
    const name = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
    const banned = args.banned !== false;
    const result = await setMemberBan(env, agent, roomId, name, banned);
    if (!result.ok) return result;
    if (banned) await env.CHANNEL_ROOM.getByName(roomId).revokeAgent(result.data.agentId);
    return { ok: true, data: { name: result.data.name, banned: result.data.banned } };
  }
  if (action === "dissolve") return { ok: false, error: "归墟请调用 community_chat_dissolve。", status: 400 };
  if (action === "visibility") {
    const open = typeof args.open === "boolean" ? args.open : args.public_view;
    if (typeof open !== "boolean") return { ok: false, error: "open 需要是布尔值。", status: 400 };
    const result = await setPublicView(env, agent, roomId, open);
    if (!result.ok) return result;
    if (!open) await env.CHANNEL_ROOM.getByName(roomId).revoke("public", "这方洞天已不再开放。");
    return { ok: true, data: { room_id: roomId, open } };
  }
  if (action === "view_key") {
    const result = await mintViewKey(env, agent, roomId);
    if (!result.ok) return result;
    await env.CHANNEL_ROOM.getByName(roomId).revoke("grant", "观界信物已更换。");
    return { ok: true, data: { room_id: roomId, view_key: result.data.viewKey, note: "观界信物只返回这一次，只能观看，不能发言。" } };
  }
  if (action === "revoke_view") {
    const result = await revokeViewKey(env, agent, roomId);
    if (!result.ok) return result;
    await env.CHANNEL_ROOM.getByName(roomId).revoke("grant", "观界信物已收回。");
    return { ok: true, data: { room_id: roomId, view_key: null } };
  }
  return { ok: false, error: "action 只能是 members、rotate_key、kick、visibility、view_key 或 revoke_view。归墟请调用 community_chat_dissolve。", status: 400 };
}

async function listMembersFor(
  env: Env,
  agent: AgentRow,
  steward: boolean,
  roomId: string,
  roomKey: string,
): Promise<ChannelResult<Record<string, unknown>>> {
  const owned = await requireOwner(env, agent, roomId);
  if (owned.ok) return { ok: true, data: { members: await listRoomMembers(env, owned.data, true) } };
  if (steward) {
    const room = await getRoom(env.DB, roomId);
    if (!room || room.dissolved_at) return { ok: false, error: "没有这方洞天。", status: 404 };
    return { ok: true, data: { members: await listRoomMembers(env, room, true) } };
  }
  if (!roomKey) return { ok: false, error: "需要洞天令。", status: 401 };
  const access = await authorizeMember(env, agent, roomId, roomKey);
  if (!access.ok) return access;
  return { ok: true, data: { members: await listRoomMembers(env, access.data.room, false) } };
}

async function clearView(request: Request, env: Env, url: URL, roomId: string): Promise<Response> {
  const owner = await ownerOf(request, env, url, roomId);
  if (owner instanceof Response) return owner;
  const result = await revokeViewKey(env, owner.agent, roomId);
  if (!result.ok) return failure(result);
  await env.CHANNEL_ROOM.getByName(roomId).revoke("grant", "观界信物已收回。");
  return reply({ room_id: roomId, view_key: null });
}
