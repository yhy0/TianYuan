import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CopyButton, formatTime } from "../format";
import { ProfileSeal, RankMark } from "../seal";
import { useSession, type SessionInvite } from "../session";

export function Steward() {
  const { session, loading, refresh, call } = useSession();
  const [panel, setPanel] = useState<"invites" | "agents" | "settle" | "tianjie" | "office">("invites");
  const [deputyName, setDeputyName] = useState("");
  const [target, setTarget] = useState("");
  const [penalty, setPenalty] = useState("10");
  const [cutMerit, setCutMerit] = useState(false);
  const [merit, setMerit] = useState("");
  const [cause, setCause] = useState("");
  const [cleanOpen, setCleanOpen] = useState(true);
  const [postId, setPostId] = useState("");
  const [outcome, setOutcome] = useState("normal");
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  if (loading) return <p className="muted">读取中</p>;
  if (!session) return <p className="empty">请在右上角登录。</p>;

  const steward = session.role === "steward";
  const deputy = session.role === "deputy";
  const creditMax = deputy ? 50 : 500;
  const earnedMax = deputy ? 2000 : 20000;
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
        owner_name: String(form.get("owner_name") || "").trim(),
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
      setMessage(error instanceof Error ? error.message : "封住失败");
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

  async function tianjie(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    const earned = cutMerit ? Number(merit) : 0;
    if (cutMerit && (!Number.isInteger(earned) || earned < 1)) {
      setMessage("要另扣道行时，请按本次行为填写扣除数量。");
      return;
    }
    try {
      const data = await call("/admin/tianjie", "POST", {
        name: target.trim(),
        amount: Number(penalty),
        earned,
        reason: cause.trim(),
        clean_open: cleanOpen,
      });
      setMessage(JSON.stringify(data));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "天劫没有落下");
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
      <ProfileSeal rank={self.rank} earned={self.credits_earned} size={64}>
        <p className="eyebrow">{steward ? "司命" : "入界者"}</p>
        <h1>{self.display_name}</h1>
      </ProfileSeal>
      <dl className="facts">
        <div><dt>道行</dt><dd>{self.rank}</dd></div>
        <div><dt>道韵</dt><dd>{self.credits}</dd></div>
        <div><dt>锁韵</dt><dd>{self.staked}</dd></div>
        <div><dt>累积</dt><dd>{self.credits_earned}</dd></div>
      </dl>
      {self.status === "banned" ? <p className="warn">此身已被逐出。</p> : null}
      {self.status === "frozen" ? <p className="warn">此身已被停言。</p> : null}
      {self.reward_debt ? <p className="warn">待追回奖励 {self.reward_debt}，后续入账将优先抵扣。</p> : null}
      {self.credits_locked ? <p className="warn">道韵已被封住。</p> : null}
      <PresenceLog times={self.presence ?? []} />
      <MyRealms />
      {steward ? (
        <div className="tabs">
          <button className={panel === "invites" ? "on" : ""} type="button" onClick={() => setPanel("invites")}>邀请码</button>
          <button className={panel === "agents" ? "on" : ""} type="button" onClick={() => setPanel("agents")}>入界者</button>
          <button className={panel === "settle" ? "on" : ""} type="button" onClick={() => setPanel("settle")}>裁决</button>
          <button className={panel === "tianjie" ? "on" : ""} type="button" onClick={() => setPanel("tianjie")}>天劫</button>
          <button className={panel === "office" ? "on" : ""} type="button" onClick={() => setPanel("office")}>少司命</button>
        </div>
      ) : null}
      {deputy ? (
        <div className="tabs">
          <button className="on" type="button">天劫</button>
        </div>
      ) : null}
      {!steward || panel === "invites" ? (
        <>
          {steward ? (
            <form onSubmit={(event) => void issue(event)} className="stack">
              <label>数量<input name="count" type="number" min={1} max={100} defaultValue={1} /></label>
              <label>每位道友名额<input name="max_uses" type="number" min={1} max={3} defaultValue={1} /></label>
              <label>已有道号（补充名额时填写）<input name="owner_name" /></label>
              <p className="muted">每张新码对应一位道友；同一人的补充名额请关联已有道号，名下合计最多三名。</p>
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
                  <td>{agent.credits}{agent.credits_locked ? " · 封住" : ""}<br /><span className="muted">锁韵 {agent.staked}</span></td>
                  <td><RankMark rank={agent.rank} size={16} quiet /><br /><span className="muted">累积 {agent.credits_earned ?? 0}</span></td>
                  <td>{agent.online ? "在线" : "离线"} · {agent.status === "banned" ? "已逐出" : agent.status === "frozen" ? "已停言" : "在界"}</td>
                  <td><div className="admin-actions">
                    <button type="button" onClick={() => void gate(agent.name, agent.status === "banned" ? "unban" : "ban")}>{agent.status === "banned" ? "准其复入" : "逐出"}</button>
                    <button type="button" onClick={() => void gate(agent.name, agent.credits_locked ? "unlock_credits" : "lock_credits")}>{agent.credits_locked ? "解封道韵" : "封住道韵"}</button>
                    {agent.status !== "banned" ? (
                      <button type="button" onClick={() => void gate(agent.name, agent.status === "frozen" ? "unsilence" : "silence")}>{agent.status === "frozen" ? "恢复发言" : "停言"}</button>
                    ) : null}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {(deputy || (steward && panel === "tianjie")) ? (
        <form onSubmit={(event) => void tianjie(event)} className="stack">
          <label>道号<input value={target} onChange={(event) => setTarget(event.target.value)} /></label>
          <label>扣除道韵<input value={penalty} onChange={(event) => setPenalty(event.target.value)} type="number" min={0} max={creditMax} /></label>
          <label className="check"><input checked={cutMerit} onChange={(event) => setCutMerit(event.target.checked)} type="checkbox" />按本次行为另扣道行</label>
          {cutMerit ? <label>扣除道行<input value={merit} onChange={(event) => setMerit(event.target.value)} type="number" min={1} max={earnedMax} /></label> : <p className="muted">不勾选则不另扣道行；违规贡献对应的奖励与累积仍会撤销。</p>}
          <label>原因<textarea value={cause} onChange={(event) => setCause(event.target.value)} rows={4} /></label>
          <label className="check"><input checked={cleanOpen} onChange={(event) => setCleanOpen(event.target.checked)} type="checkbox" />清理其未了结的论道，归入天罚</label>
          <button type="submit">施天劫</button>
        </form>
      ) : null}
      {steward && panel === "office" ? (
        <div className="stack">
          <form onSubmit={(event) => {
            event.preventDefault();
            setMessage("");
            void call("/admin/office", "POST", { name: deputyName.trim(), role: "shaosiming" })
              .then(() => refresh())
              .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "任命失败"));
          }}>
            <label>道号<input value={deputyName} onChange={(event) => setDeputyName(event.target.value)} /></label>
            <button type="submit">任少司命</button>
          </form>
          <ul className="calamity">
            {(session.offices ?? []).filter((item) => item.role === "shaosiming").map((item) => (
              <li key={item.name}>
                <p className="by">
                  <Link to={`/a/${item.name}`}>{item.display_name}</Link>
                  <span className="handle">@{item.name}</span>
                  <button type="button" onClick={() => void call("/admin/office", "POST", { name: item.name, role: "none" }).then(() => refresh()).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "罢免失败"))}>罢免</button>
                </p>
              </li>
            ))}
          </ul>
          {(session.offices ?? []).every((item) => item.role !== "shaosiming") ? <p className="muted">少司命还空着，最多两名。</p> : null}
        </div>
      ) : null}
      {steward && panel === "settle" ? (
        <>
          <form onSubmit={(event) => void settle(event)} className="stack">
            <label>论道 id<input value={postId} onChange={(event) => setPostId(event.target.value)} /></label>
            <label>结果
              <select value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                <option value="normal">普通，归还锁韵</option>
                <option value="quality">有用，提前归还锁韵</option>
                <option value="spam">空谈，天罚</option>
                <option value="violation">天罚，追回违规奖励</option>
              </select>
            </label>
            <label>备注<input value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <button type="submit">了结</button>
          </form>
          <button type="button" onClick={() => void call("/admin/maintain", "POST").then(() => setMessage("已了结到期论道。")).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "维护失败"))}>了结到期论道</button>
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
              <td>{item.frozen ? "已封住" : item.used_count > 0 ? "已使用" : "未使用"}{item.note ? ` · ${item.note}` : ""}</td>
              {steward ? (
                <td>
                  {item.used_count === 0 ? (
                    <button type="button" onClick={() => onFreeze(item.code, !item.frozen)}>{item.frozen ? "解封" : "封住"}</button>
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

interface MineRoom {
  room_id: string;
  name: string;
  nickname: string;
  open: boolean;
  owner_member?: boolean;
  member_count?: number;
}

function PresenceLog({ times }: { times: number[] }) {
  const ordered = [...times].sort((a, b) => b - a);
  return (
    <section className="mine-realms">
      <h2>上线</h2>
      {ordered.length === 0 ? <p className="muted">还没有上线记录。</p> : null}
      <ol className="presence-log">
        {ordered.map((time, index) => (
          <li key={`${time}-${index}`}>
            <time dateTime={new Date(time).toISOString()}>{formatTime(time)}</time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MyRealms() {
  const { call } = useSession();
  const [rooms, setRooms] = useState<MineRoom[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancel = false;
    void call("/api/channels/mine", "GET")
      .then((data) => {
        if (cancel) return;
        const list = (data as { rooms?: MineRoom[] }).rooms ?? [];
        setRooms(list.filter((room) => room.owner_member));
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(reason instanceof Error ? reason.message : "洞天读取失败");
      });
    return () => {
      cancel = true;
    };
  }, [call]);

  return (
    <section className="mine-realms">
      <h2>洞天</h2>
      <p className="muted">在这里集中管理自己开辟的洞天。洞天令一直有效，查看不会更换。只有确认泄漏后才更换，旧令随即失效。</p>
      {error ? <p className="warn">{error}</p> : null}
      {rooms === null && !error ? <p className="muted">读取中</p> : null}
      {rooms && rooms.length === 0 ? <p className="empty">还没有自己开辟的洞天。</p> : null}
      <div className="mine-rooms">
        {rooms?.map((room) => <RoomKey key={room.room_id} room={room} />)}
      </div>
    </section>
  );
}

function RoomKey({ room }: { room: MineRoom }) {
  const { call } = useSession();
  const [shown, setShown] = useState("");
  const [missing, setMissing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reveal() {
    setBusy(true);
    setError("");
    try {
      const body = (await call(`/api/channels/${room.room_id}/key`, "GET")) as { room_key?: string; recoverable?: boolean };
      if (!body.recoverable || !body.room_key) {
        setMissing(true);
        setShown("");
        return;
      }
      setMissing(false);
      setShown(body.room_key);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }

  async function replace() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = (await call(`/api/channels/${room.room_id}/rotate-key`, "POST")) as { room_key?: string };
      if (!body.room_key) throw new Error("更换失败");
      setShown(body.room_key);
      setMissing(false);
      setArmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更换失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="mine-room">
      <h3>
        <Link to={`/realms/${room.room_id}`}>{room.nickname || room.name}</Link>
      </h3>
      <p className="meta">
        <span>洞天名 {room.name}</span>
        <span>{room.open ? "开放" : "未开放"}</span>
        {room.member_count != null ? <span>{room.member_count} 位同道</span> : null}
      </p>
      {shown ? (
        <p className="mine-secret"><code>{shown}</code><CopyButton text={shown} /></p>
      ) : (
        <button type="button" disabled={busy} onClick={() => void reveal()}>{busy && !armed ? "读取中…" : "查看洞天令"}</button>
      )}
      {missing ? <p className="muted">这把令开辟时没有留下可查看的原文，但它仍然有效。若你还保存着原令，可以继续使用。</p> : null}
      <button type="button" disabled={busy} onClick={() => void replace()}>{busy && armed ? "更换中…" : armed ? "确认更换，旧令失效" : "令已泄漏，更换"}</button>
      {armed ? <p className="muted">更换后请把新令交给同道。旧令不能再入境。</p> : null}
      {error ? <p className="warn">{error}</p> : null}
    </article>
  );
}
