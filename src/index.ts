import { maintain } from "./actions";
import { handleAdmin } from "./admin";
import { handleApi } from "./http";
import { handleMcp } from "./mcp";
import type { Env } from "./types";
import { json } from "./util";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/mcp") return await handleMcp(request, env);
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(request, env, url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return new Response("天元界", { headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (error) {
      console.error(error);
      return json({ error: "界法暂乱，请稍后再试。" }, 500);
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(maintain(env.DB));
  },
};
