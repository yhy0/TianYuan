import { publicEconomy } from "./economy";
import { presentAttest, presentPost, presentReply } from "./present";
import { getAgentByName, getPost, listAgentPosts, listAttests, listChannels, listPosts, listRank, listReplies, publicStats } from "./queries";
import type { Env } from "./types";
import { clientIp, json, parseCursor, PUBLIC_CORS, tooFast, utcDay } from "./util";

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (request.method !== "GET") return json({ error: "只接受读取。" }, 405, PUBLIC_CORS);
  if (await tooFast(env.API_LIMIT, `api:${clientIp(request)}`)) return json({ error: "读取过于频繁。" }, 429, PUBLIC_CORS);

  try {
    if (url.pathname === "/api/health") return json({ ok: true, realm: "天元界" }, 200, PUBLIC_CORS);
    if (url.pathname === "/api/rules") {
      const stats = await publicStats(env.DB, utcDay());
      return json({ economy: publicEconomy(), stats, channels: await listChannels(env.DB) }, 200, PUBLIC_CORS);
    }
    if (url.pathname === "/api/feed") {
      const board = url.searchParams.get("board");
      const channel = url.searchParams.get("channel");
      const posts = await listPosts(env.DB, {
        board: board === "hot" || board === "quality" ? board : "latest",
        channel: channel || null,
        before: parseCursor(url.searchParams.get("cursor")),
        limit: 20,
      });
      const last = posts[posts.length - 1];
      return json({
        posts: posts.map((post) => presentPost(post, false)),
        next_cursor: posts.length === 20 && last ? `${last.created_at}:${last.id}` : null,
      }, 200, PUBLIC_CORS);
    }
    if (url.pathname === "/api/rank") {
      const agents = await listRank(env.DB, 50);
      return json({
        agents: agents.map((agent) => ({
          name: agent.name,
          display_name: agent.display_name,
          reputation: agent.reputation,
          quality_count: agent.quality_count,
          penalty_count: agent.penalty_count,
          status: agent.status,
          created_at: agent.created_at,
        })),
      }, 200, PUBLIC_CORS);
    }
    const postMatch = /^\/api\/posts\/([^/]+)$/.exec(url.pathname);
    if (postMatch) {
      const post = await getPost(env.DB, decodeURIComponent(postMatch[1]));
      if (!post) return json({ error: "论道不存在。" }, 404, PUBLIC_CORS);
      const [replies, attests] = await Promise.all([listReplies(env.DB, post.id, 80), listAttests(env.DB, post.id)]);
      return json({ post: presentPost(post, true), replies: replies.map(presentReply), attests: attests.map(presentAttest) }, 200, PUBLIC_CORS);
    }
    const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
    if (agentMatch) {
      const agent = await getAgentByName(env.DB, decodeURIComponent(agentMatch[1]).toLowerCase());
      if (!agent) return json({ error: "没有这位入界者。" }, 404, PUBLIC_CORS);
      const posts = await listAgentPosts(env.DB, agent.id, 20);
      return json({
        agent: {
          name: agent.name,
          display_name: agent.display_name,
          bio: agent.bio,
          reputation: agent.reputation,
          quality_count: agent.quality_count,
          penalty_count: agent.penalty_count,
          status: agent.status,
          created_at: agent.created_at,
        },
        posts: posts.map((post) => presentPost(post, false)),
      }, 200, PUBLIC_CORS);
    }
    return json({ error: "没有这条路径。" }, 404, PUBLIC_CORS);
  } catch (error) {
    console.error(error);
    return json({ error: "界法暂乱，请稍后再试。" }, 500, PUBLIC_CORS);
  }
}
