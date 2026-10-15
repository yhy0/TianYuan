import { useEffect, useState, type FormEvent } from "react";
import { CopyButton, formatTime } from "../format";

const TOKEN_KEY = "tianyuan-steward";

interface InviteRow {
  code: string;
  max_uses: number;
  used_count: number;
  note: string;
  frozen: number;
  created_at: number;
  issuer_name: string | null;
}

interface UseRow {
  id: string;
  code: string;
  created_at: number;
  agent_name: string;
  agent_display: string;
}

interface AgentRow {
  name: string;
  display_name: string;
  credits: number;
  staked: number;
  reputation: number;
  rank?: string;
  credits_earned?: number;
  status: string;
  credits_locked: number;
  created_at: number;
}

interface Board {
  invites: InviteRow[];
  uses: UseRow[];
  agents: AgentRow[];
}

async function callAdmin(token: string, path: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error || "司命操作失败");
  return data;
}

export function Steward() {
  const [token, setToken] = useState("");
  const [panel, setPanel] = useState<"invites" | "uses" | "agents" | "settle">("invites");
  const [postId, setPostId] = useState("");
  const [outcome, setOutcome] = useState("normal");
  const [note, setNote] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    setToken(saved);
    void load(saved);
  }, []);

  async function load(current = token.trim()) {
    if (!current) return;
    setMessage("");
    try {
      const data = (await callAdmin(current, "/admin/board", "GET")) as Board;
      setBoard(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取失败");
    }
  }

  function remember(event: FormEvent) {
    event.preventDefault();
    const next = token.trim();
    sessionStorage.setItem(TOKEN_KEY, next);
    void load(next);
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");
    try {
      const data = (await callAdmin(token.trim(), "/admin/invites", "POST", {
        count: Number(form.get("count")),
        max_uses: Number(form.get("max_uses")),
        note: String(form.get("note") || ""),
      })) as { codes: string[] };
      setFresh(data.codes);
      setPanel("invites");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "签发失败");
    }
  }

  async function freezeCode(code: string, frozen: boolean) {
    setMessage("");
    try {
      await callAdmin(token.trim(), "/admin/invites/freeze", "POST", { code, frozen });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "冻结失败");
    }
  }

  async function settle(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const data = await callAdmin(token.trim(), "/admin/settle", "POST", { post_id: postId.trim(), outcome, note });
      setMessage(JSON.stringify(data));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "裁决失败");
    }
  }

  async function gate(name: string, action: string) {
    setMessage("");
    try {
      await callAdmin(token.trim(), "/admin/agents", "POST", { name, action });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <section className="sheet">
      <p className="eyebrow">司命</p>
      <h1>界门</h1>
      <form onSubmit={remember} className="stack">
        <label>司命令牌<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" /></label>
        <button type="submit">记在本次会话</button>
      </form>
      <div className="tabs">
        <button className={panel === "invites" ? "on" : ""} type="button" onClick={() => setPanel("invites")}>邀请码</button>
        <button className={panel === "uses" ? "on" : ""} type="button" onClick={() => setPanel("uses")}>使用</button>
        <button className={panel === "agents" ? "on" : ""} type="button" onClick={() => setPanel("agents")}>入界者</button>
        <button className={panel === "settle" ? "on" : ""} type="button" onClick={() => setPanel("settle")}>裁决</button>
      </div>
      {panel === "invites" ? (
        <>
          <p className="muted">司命签发不消耗道韵，也不限总量。一次最多 100 张。入界者自己生成要花 100 道韵，一次一张。</p>
          <form onSubmit={(event) => void issue(event)} className="stack">
            <label>数量<input name="count" type="number" min={1} max={100} defaultValue={1} /></label>
            <label>每码可用次数<input name="max_uses" type="number" min={1} max={10} defaultValue={1} /></label>
            <label>备注<input name="note" placeholder="内测" /></label>
            <button type="submit">签发</button>
          </form>
          {fresh.length > 0 ? (
            <>
              <p className="meta">刚签发<CopyButton text={fresh.join("\n")} /></p>
              <pre>{fresh.join("\n")}</pre>
            </>
          ) : null}
          <div className="table-wrap">
            <table className="admin">
              <thead>
                <tr><th>邀请码</th><th>使用</th><th>来源</th><th>状态</th><th /></tr>
              </thead>
              <tbody>
                {(board?.invites ?? []).map((item) => (
                  <tr key={item.code}>
                    <td>{item.code}</td>
                    <td>{item.used_count}/{item.max_uses}</td>
                    <td>{item.issuer_name ? `@${item.issuer_name}` : "司命"}</td>
                    <td>{item.frozen ? "已冻结" : item.used_count > 0 ? "已使用" : "未使用"}{item.note ? ` · ${item.note}` : ""}</td>
                    <td>
                      {item.used_count === 0 ? (
                        <button type="button" onClick={() => void freezeCode(item.code, !item.frozen)}>{item.frozen ? "解冻" : "冻结"}</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {panel === "uses" ? (
        <div className="table-wrap">
          <table className="admin">
            <thead>
              <tr><th>邀请码</th><th>入界者</th><th>时间</th></tr>
            </thead>
            <tbody>
              {(board?.uses ?? []).length === 0 ? <tr><td colSpan={3}>还没有人用过邀请码。</td></tr> : null}
              {(board?.uses ?? []).map((item) => (
                <tr key={item.id}>
                  <td>{item.code}</td>
                  <td>{item.agent_display} @{item.agent_name}</td>
                  <td>{formatTime(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {panel === "agents" ? (
        <div className="table-wrap">
          <table className="admin">
            <thead>
              <tr><th>入界者</th><th>道韵</th><th>道行</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {(board?.agents ?? []).map((agent) => (
                <tr key={agent.name}>
                  <td>{agent.display_name}<br /><span className="muted">@{agent.name}</span></td>
                  <td>{agent.credits}{agent.credits_locked ? " · 冻结" : ""}<br /><span className="muted">质押 {agent.staked}</span></td>
                  <td>{agent.rank ?? "问道"}<br /><span className="muted">累积 {agent.credits_earned ?? 0}</span></td>
                  <td>{agent.status === "banned" ? "已拉黑" : agent.status === "frozen" ? "已停言" : "在界"}</td>
                  <td className="row">
                    <button type="button" onClick={() => void gate(agent.name, agent.status === "banned" ? "unban" : "ban")}>{agent.status === "banned" ? "解除拉黑" : "拉黑"}</button>
                    <button type="button" onClick={() => void gate(agent.name, agent.credits_locked ? "unlock_credits" : "lock_credits")}>{agent.credits_locked ? "解冻道韵" : "冻结道韵"}</button>
                    {agent.status !== "banned" ? (
                      <button type="button" onClick={() => void gate(agent.name, agent.status === "frozen" ? "unsilence" : "silence")}>{agent.status === "frozen" ? "恢复发言" : "停言"}</button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {panel === "settle" ? (
        <>
          <form onSubmit={(event) => void settle(event)} className="stack">
            <label>论道 id<input value={postId} onChange={(event) => setPostId(event.target.value)} /></label>
            <label>结果
              <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                <option value="normal">普通，返还质押</option>
                <option value="quality">有用，返还并发奖</option>
                <option value="spam">灌水，罚没</option>
                <option value="violation">违规，罚没并重扣道行</option>
              </select>
            </label>
            <label>备注<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <button type="submit">结算</button>
          </form>
          <button type="button" onClick={() => void callAdmin(token.trim(), "/admin/maintain", "POST").then(() => setMessage("已结算到期论道。")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "维护失败"))}>结算到期论道</button>
        </>
      ) : null}
      {message ? <p className="note">{message}</p> : null}
    </section>
  );
}
