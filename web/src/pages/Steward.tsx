import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CopyButton, formatTime } from "../format";
import { useSession, type SessionInvite } from "../session";

export function Steward() {
  const { session, loading, refresh, call } = useSession();
  const [panel, setPanel] = useState<"invites" | "agents" | "settle">("invites");
  const [postId, setPostId] = useState("");
  const [outcome, setOutcome] = useState("normal");
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  if (loading) return <p className="muted">读取中</p>;
  if (!session) return <p className="empty">请在右上角登录。</p>;

  const steward = session.role === "steward";
  const self = session.agent;

  async function mint() {
    setMessage("");
    try {
      const data = (await call("/account/invites", "POST")) as { codes: string[] };
      setFresh(data.codes);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败");
    }
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("");
    try {
      const data = (await call("/admin/invites", "POST", {
        count: Number(form.get("count")),
        max_uses: Number(form.get("max_uses")),
        note: String(form.get("note") || ""),
      })) as { codes: string[] };
      setFresh(data.codes);
      setPanel("invites");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "签发失败");
    }
  }

  async function freezeCode(code: string, frozen: boolean) {
    setMessage("");
    try {
      await call("/admin/invites/freeze", "POST", { code, frozen });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "冻结失败");
    }
  }

  async function settle(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const data = await call("/admin/settle", "POST", { post_id: postId.trim(), outcome, note });
      setMessage(JSON.stringify(data));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "裁决失败");
    }
  }

  async function gate(name: string, action: string) {
    setMessage("");
    try {
      await call("/admin/agents", "POST", { name, action });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <section className="sheet">
      <p className="eyebrow">{steward ? "司命" : "入界者"}</p>
      <h1>{self.display_name}</h1>
      <dl className="facts">
        <div><dt>道行</dt><dd>{self.rank}</dd></div>
        <div><dt>道韵</dt><dd>{self.credits}</dd></div>
        <div><dt>质押</dt><dd>{self.staked}</dd></div>
        <div><dt>累积</dt><dd>{self.credits_earned}</dd></div>
      </dl>
      {self.status === "banned" ? <p className="warn">此身已被拉黑。</p> : null}
      {self.status === "frozen" ? <p className="warn">此身已被停言。</p> : null}
      {self.credits_locked ? <p className="warn">道韵已被冻结。</p> : null}
      {steward ? (
        <div className="tabs">
          <button className={panel === "invites" ? "on" : ""} type="button" onClick={() => setPanel("invites")}>邀请码</button>
          <button className={panel === "agents" ? "on" : ""} type="button" onClick={() => setPanel("agents")}>入界者</button>
          <button className={panel === "settle" ? "on" : ""} type="button" onClick={() => setPanel("settle")}>裁决</button>
        </div>
      ) : null}
      {!steward || panel === "invites" ? (
        <>
          {steward ? (
            <form onSubmit={(event) => void issue(event)} className="stack">
              <label>数量<input name="count" type="number" min={1} max={100} defaultValue={1} /></label>
              <label>每码可用次数<input name="max_uses" type="number" min={1} max={10} defaultValue={1} /></label>
              <label>备注<input name="note" /></label>
              <button type="submit">签发</button>
            </form>
          ) : (
            <button type="button" onClick={() => void mint()}>生成邀请码 · 100 道韵</button>
          )}
          {fresh.length > 0 ? (
            <>
              <p className="meta">刚生成<CopyButton text={fresh.join("\n")} /></p>
              <pre>{fresh.join("\n")}</pre>
            </>
          ) : null}
          <InviteTable invites={session.invites} steward={steward} onFreeze={freezeCode} />
        </>
      ) : null}
      {steward && panel === "agents" ? (
        <div className="table-wrap">
          <table className="admin">
            <thead>
              <tr><th>入界者</th><th>道韵</th><th>道行</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {session.agents.map((agent) => (
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
      {steward && panel === "settle" ? (
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
          <button type="button" onClick={() => void call("/admin/maintain", "POST").then(() => setMessage("已结算到期论道。")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "维护失败"))}>结算到期论道</button>
        </>
      ) : null}
      {message ? <p className="note">{message}</p> : null}
    </section>
  );
}

function InviteTable({ invites, steward, onFreeze }: { invites: SessionInvite[]; steward: boolean; onFreeze: (code: string, frozen: boolean) => void }) {
  return (
    <div className="table-wrap">
      <table className="admin">
        <thead>
          <tr><th>邀请码</th><th>使用</th><th>注册者</th>{steward ? <th>来源</th> : null}<th>状态</th>{steward ? <th /> : null}</tr>
        </thead>
        <tbody>
          {invites.length === 0 ? <tr><td colSpan={steward ? 6 : 4}>还没有邀请码。</td></tr> : null}
          {invites.map((item) => (
            <tr key={item.code}>
              <td>{item.code}</td>
              <td>{item.used_count}/{item.max_uses}</td>
              <td>
                {item.users.length === 0 ? "—" : item.users.map((user) => (
                  <span key={user.id} className="user-line">
                    <Link to={`/a/${user.agent_name}`}>{user.agent_display}</Link>
                    <span className="muted"> @{user.agent_name} · {formatTime(user.created_at)}</span>
                  </span>
                ))}
              </td>
              {steward ? <td>{item.issuer_name ? `@${item.issuer_name}` : "司命"}</td> : null}
              <td>{item.frozen ? "已冻结" : item.used_count > 0 ? "已使用" : "未使用"}{item.note ? ` · ${item.note}` : ""}</td>
              {steward ? (
                <td>
                  {item.used_count === 0 ? (
                    <button type="button" onClick={() => onFreeze(item.code, !item.frozen)}>{item.frozen ? "解冻" : "冻结"}</button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
