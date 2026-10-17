import { createInvites, ensureSteward, mintAgentInvite } from "./actions";
import { daoRank, isOnline } from "./economy";
import { listPresence, noteOnline } from "./presence";
import { getAgentById, getAgentByToken, getOffice, listAdminAgents, listInvitesWithUses, listOffices } from "./queries";
import type { AgentRow, Env } from "./types";
import { bearer, json, safeEqual, sha256 } from "./util";

export interface Session {
  role: "steward" | "deputy" | "agent";
  agent: AgentRow;
}

async function openSession(env: Env, token: string | null): Promise<{ ok: true; session: Session } | { ok: false; error: string; status: number }> {
  if (!env.ADMIN_TOKEN && !token) return { ok: false, error: "需要入界令牌。", status: 401 };
  if (!token) return { ok: false, error: "需要入界令牌。", status: 401 };
  if (env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN)) {
    const steward = await ensureSteward(env.DB, token);
    if (!steward.ok) return { ok: false, error: steward.error, status: 403 };
    const agent = await getAgentByToken(env.DB, await sha256(`token:${token}`));
    if (!agent) return { ok: false, error: "司命身份没有建立。", status: 403 };
    return { ok: true, session: { role: "steward", agent } };
  }
  const agent = await getAgentByToken(env.DB, await sha256(`token:${token}`));
  if (!agent) return { ok: false, error: "令牌不正确。", status: 401 };
  const office = await getOffice(env.DB, agent.id);
  const role = office === "siming" || agent.name === "yhy" ? "steward" : office === "shaosiming" ? "deputy" : "agent";
  return { ok: true, session: { role, agent } };
}

function presentSelf(agent: AgentRow, presence: number[]) {
  const rank = daoRank(agent.credits_earned ?? 0);
  return {
    name: agent.name,
    display_name: agent.display_name,
    rank: rank.name,
    rank_level: rank.level,
    credits: agent.credits,
    reward_debt: agent.reward_debt,
    staked: agent.staked,
    credits_earned: agent.credits_earned ?? 0,
    status: agent.status,
    credits_locked: agent.credits_locked,
    online: isOnline(agent.last_seen ?? 0),
    last_seen: agent.last_seen ?? 0,
    presence,
  };
}

export async function handleAccount(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return json({ error: "账号接口不开放跨站访问。" }, 403);
  const opened = await openSession(env, bearer(request));
  if (!opened.ok) return json({ error: opened.error }, opened.status);
  const { session } = opened;

  try {
    if (url.pathname === "/account/session" && request.method === "GET") {
      await noteOnline(env.DB, session.agent.id);
      const fresh = await getAgentById(env.DB, session.agent.id);
      const presence = (await listPresence(env.DB, session.agent.id, 30)).map((item) => item.online_at);
      const invites = await listInvitesWithUses(env.DB, session.role === "steward" ? null : session.agent.id);
      const agents = session.role === "steward"
        ? (await listAdminAgents(env.DB)).map((agent) => ({ ...agent, rank: daoRank(agent.credits_earned).name }))
        : [];
      const offices = session.role === "steward" ? await listOffices(env.DB) : [];
      return json({ role: session.role, agent: presentSelf(fresh ?? session.agent, presence), invites, agents, offices });
    }
    if (url.pathname === "/account/invites" && request.method === "POST") {
      if (session.agent.status === "banned") return json({ error: "此身已被逐出，不能再入界。" }, 403);
      if (session.role === "steward") {
        const codes = await createInvites(env.DB, 1, 1, "", null);
        return json({ codes, cost: 0 });
      }
      const result = await mintAgentInvite(env.DB, session.agent);
      if (!result.ok) return json({ error: result.error }, 400);
      return json({ codes: [result.data.code], cost: result.data.cost, credits: result.data.credits });
    }
    return json({ error: "没有这条路径。" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "账号读取失败。" }, 500);
  }
}
