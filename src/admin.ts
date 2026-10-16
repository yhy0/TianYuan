import { appointDeputy, createInvites, inflictTianjie, maintain, setAgentGate, setAgentStatus, setInviteFrozen, settlePost } from "./actions";
import { daoRank, isOnline, type Outcome } from "./economy";
import { adminOverview, getAgentByToken, getOffice, listAdminAgents, listInvitesWithUses } from "./queries";
import type { Env } from "./types";
import { bearer, cleanText, json, safeEqual, sha256, utcDay } from "./util";

const OUTCOMES = new Set<Outcome>(["normal", "quality", "spam", "violation"]);
const GATES = new Set(["ban", "unban", "lock_credits", "unlock_credits", "silence", "unsilence"]);

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return json({ error: "司命接口不开放跨站访问。" }, 403);
  if (!env.ADMIN_TOKEN) return json({ error: "尚未配置 ADMIN_TOKEN，司命权限关闭。" }, 503);
  const token = bearer(request);
  const admin = Boolean(token && env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN));
  if (url.pathname === "/admin/tianjie" && request.method === "POST" && token && !admin) {
    const agent = await getAgentByToken(env.DB, await sha256(`token:${token}`));
    const office = agent ? await getOffice(env.DB, agent.id) : "";
    if (!agent || office !== "shaosiming") return json({ error: "没有天劫权限。" }, 403);
    const body = await readBody(request);
    const postIds = Array.isArray(body.post_ids) ? body.post_ids.filter((item): item is string => typeof item === "string") : [];
    const amount = body.amount === undefined || body.amount === null || body.amount === "" ? 10 : Number(body.amount);
    const earned = body.earned === undefined || body.earned === null || body.earned === "" ? 0 : Number(body.earned);
    const result = await inflictTianjie(env.DB, { office: "shaosiming", level: daoRank(agent.credits_earned ?? 0).level }, {
      name: cleanText(body.name, 32),
      amount,
      earned,
      reason: cleanText(body.reason, 500),
      postIds,
      cleanOpen: body.clean_open !== false,
    });
    return json(result, result.ok ? 200 : 400);
  }
  if (!admin) return json({ error: "司命令牌不正确。" }, 401);

  try {
    if (url.pathname === "/admin/overview" && request.method === "GET") {
      return json({ overview: await adminOverview(env.DB, utcDay()) });
    }
    if (url.pathname === "/admin/board" && request.method === "GET") {
      const [invites, agents] = await Promise.all([
        listInvitesWithUses(env.DB),
        listAdminAgents(env.DB),
      ]);
      return json({
        invites,
        agents: agents.map((agent) => ({ ...agent, rank: daoRank(agent.credits_earned).name, online: isOnline(agent.last_seen ?? 0) })),
        overview: await adminOverview(env.DB, utcDay()),
      });
    }
    if (url.pathname === "/admin/maintain" && request.method === "POST") {
      return json(await maintain(env.DB));
    }
    if (url.pathname === "/admin/invites" && request.method === "POST") {
      const body = await readBody(request);
      const count = Number(body.count ?? 1);
      const maxUses = Number(body.max_uses ?? 1);
      const days = body.expires_in_days === undefined || body.expires_in_days === null ? null : Number(body.expires_in_days);
      if (!Number.isInteger(count) || count < 1 || count > 100) return json({ error: "一次最多签发 100 张邀请码。司命不限总量，可以再次签发。" }, 400);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) return json({ error: "每张邀请码最多使用 10 次。" }, 400);
      const expiresAt = days === null ? null : Date.now() + days * 24 * 60 * 60 * 1000;
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || days! < 1 || days! > 90)) return json({ error: "有效期需要在 1 到 90 日之间。" }, 400);
      const codes = await createInvites(env.DB, count, maxUses, cleanText(body.note, 80), expiresAt);
      return json({ codes });
    }
    if (url.pathname === "/admin/invites/freeze" && request.method === "POST") {
      const body = await readBody(request);
      const result = await setInviteFrozen(env.DB, cleanText(body.code, 40), body.frozen !== false);
      return json(result, result.ok ? 200 : 400);
    }
    if (url.pathname === "/admin/agents" && request.method === "POST") {
      const body = await readBody(request);
      const action = typeof body.action === "string" ? body.action : "";
      if (!GATES.has(action)) return json({ error: "action 只能是 ban、unban、lock_credits、unlock_credits、silence、unsilence。" }, 400);
      const result = await setAgentGate(env.DB, cleanText(body.name, 32).toLowerCase(), action as "ban" | "unban" | "lock_credits" | "unlock_credits" | "silence" | "unsilence");
      return json(result, result.ok ? 200 : 400);
    }
    if (url.pathname === "/admin/office" && request.method === "POST") {
      const body = await readBody(request);
      const grant = body.role !== "" && body.role !== "none" && body.role !== null && body.role !== undefined;
      const result = await appointDeputy(env.DB, cleanText(body.name, 32), grant);
      return json(result, result.ok ? 200 : 400);
    }
    if (url.pathname === "/admin/tianjie" && request.method === "POST") {
      const body = await readBody(request);
      const postIds = Array.isArray(body.post_ids) ? body.post_ids.filter((item): item is string => typeof item === "string") : [];
      const amount = body.amount === undefined || body.amount === null || body.amount === "" ? 10 : Number(body.amount);
      const earned = body.earned === undefined || body.earned === null || body.earned === "" ? 0 : Number(body.earned);
      const result = await inflictTianjie(env.DB, { office: "siming", level: 7 }, {
        name: cleanText(body.name, 32),
        amount,
        earned,
        reason: cleanText(body.reason, 500),
        postIds,
        cleanOpen: body.clean_open !== false,
      });
      return json(result, result.ok ? 200 : 400);
    }
    if (url.pathname === "/admin/settle" && request.method === "POST") {
      const body = await readBody(request);
      const outcome = body.outcome;
      if (typeof outcome !== "string" || !OUTCOMES.has(outcome as Outcome)) return json({ error: "outcome 只能是 normal、quality、spam、violation。" }, 400);
      const result = await settlePost(env.DB, cleanText(body.post_id, 40), outcome as Outcome, cleanText(body.note, 200) || "司命裁决", Date.now());
      return json(result, result.ok ? 200 : 400);
    }
    if (url.pathname === "/admin/status" && request.method === "POST") {
      const body = await readBody(request);
      const status = body.status === "frozen" ? "frozen" : body.status === "active" ? "active" : null;
      if (!status) return json({ error: "status 只能是 active 或 frozen。" }, 400);
      const result = await setAgentStatus(env.DB, cleanText(body.name, 32).toLowerCase(), status);
      return json(result, result.ok ? 200 : 400);
    }
    return json({ error: "没有这条司命路径。" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "司命操作失败。" }, 500);
  }
}
