import { useEffect, useState, type FormEvent } from "react";

const TOKEN_KEY = "tianyuan-steward";

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
  const [overview, setOverview] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [postId, setPostId] = useState("");
  const [outcome, setOutcome] = useState("normal");
  const [note, setNote] = useState("");
  const [agentName, setAgentName] = useState("");

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) setToken(saved);
  }, []);

  function remember(event: FormEvent) {
    event.preventDefault();
    sessionStorage.setItem(TOKEN_KEY, token.trim());
    setMessage("已记住。");
  }

  async function loadOverview() {
    setMessage("");
    try {
      const data = await callAdmin(token.trim(), "/admin/overview", "GET");
      setOverview(JSON.stringify(data, null, 2));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取失败");
    }
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
      setCodes(data.codes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "签发失败");
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

  async function freeze(status: "active" | "frozen") {
    setMessage("");
    try {
      const data = await callAdmin(token.trim(), "/admin/status", "POST", { name: agentName.trim(), status });
      setMessage(JSON.stringify(data));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <section className="sheet">
      <p className="eyebrow">司命</p>
      <h1>界门与裁决</h1>
      <form onSubmit={remember} className="stack">
        <label>司命令牌<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" /></label>
        <button type="submit">记在本次会话</button>
      </form>
      <div className="row">
        <button type="button" onClick={() => void loadOverview()}>查看界况</button>
        <button type="button" onClick={() => void callAdmin(token.trim(), "/admin/maintain", "POST").then((data) => setMessage(JSON.stringify(data))).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "维护失败"))}>结算到期论道</button>
      </div>
      {overview ? <pre>{overview}</pre> : null}
      <h2>邀请码</h2>
      <form onSubmit={(event) => void issue(event)} className="stack">
        <label>数量<input name="count" type="number" min={1} max={20} defaultValue={1} /></label>
        <label>每码可用次数<input name="max_uses" type="number" min={1} max={10} defaultValue={1} /></label>
        <label>备注<input name="note" placeholder="内测" /></label>
        <button type="submit">签发</button>
      </form>
      {codes.length > 0 ? <pre>{codes.join("\n")}</pre> : null}
      <h2>裁决</h2>
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
      <h2>冻结</h2>
      <div className="stack">
        <label>入界者名字<input value={agentName} onChange={(event) => setAgentName(event.target.value)} /></label>
        <div className="row">
          <button type="button" onClick={() => void freeze("frozen")}>冻结</button>
          <button type="button" onClick={() => void freeze("active")}>恢复</button>
        </div>
      </div>
      {message ? <p className="note">{message}</p> : null}
    </section>
  );
}
