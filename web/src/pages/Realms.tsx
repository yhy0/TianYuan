import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch } from "../api";
import { CopyButton, formatTime } from "../format";
import { useSession } from "../session";

interface RealmCard {
  room_id: string;
  name: string;
  nickname: string;
  description: string;
  owner: string;
  owner_display: string;
  open: boolean;
  created_at: string;
  member_count: number;
}

interface RealmMember {
  name: string;
  display_name: string;
  role: "owner" | "member";
  online?: boolean;
}

interface RealmMessage {
  seq: number;
  id: string;
  sender: string;
  sender_display: string;
  content: string;
  reply_to: string | null;
  mentions: string[];
  created_at: string;
}

interface MessagePage {
  messages: RealmMessage[];
  latest_seq: number;
  earliest_seq: number;
  cursor_expired: boolean;
  has_more: boolean;
}

const VIEW_PREFIX = "tianyuan-dongtian:";
const CLUSTER_GAP = 5 * 60 * 1000;
const TINTS = ["#d5bb84", "#98b6a2", "#e3b2a4", "#c7c1ae", "#b9c4d6"];

function tintOf(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

function shanghaiDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(ms);
}

function timeLabel(ms: number, now = Date.now()): string {
  const day = shanghaiDay(ms);
  const time = clock(ms);
  if (day === shanghaiDay(now)) return time;
  if (day === shanghaiDay(now - 86_400_000)) return `昨天 ${time}`;
  return formatTime(ms);
}

function transcript(messages: RealmMessage[]): Array<{ kind: "time"; key: string; label: string } | { kind: "msg"; key: string; message: RealmMessage; head: boolean }> {
  const rows: Array<{ kind: "time"; key: string; label: string } | { kind: "msg"; key: string; message: RealmMessage; head: boolean }> = [];
  let prev: RealmMessage | null = null;
  for (const message of messages) {
    const at = Date.parse(message.created_at);
    const prevAt = prev ? Date.parse(prev.created_at) : 0;
    const split = !prev || at - prevAt >= CLUSTER_GAP || shanghaiDay(at) !== shanghaiDay(prevAt);
    if (split) rows.push({ kind: "time", key: `t-${message.seq}`, label: timeLabel(at) });
    rows.push({ kind: "msg", key: message.id, message, head: split || prev?.sender !== message.sender });
    prev = message;
  }
  return rows;
}

function viewKeyFor(roomId: string): string {
  return sessionStorage.getItem(`${VIEW_PREFIX}${roomId}`) ?? "";
}

function authHeaders(viewKey: string, token: string, steward: boolean): Headers {
  const headers = new Headers();
  if (viewKey) headers.set("X-Room-Key", viewKey);
  if (steward && token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export function Realms() {
  const { data, error, loading } = useFetch<{ rooms: RealmCard[] }>("/api/channels");

  return (
    <section className="feed-page">
      <div className="hero">
        <p className="eyebrow">天元界 · 诸方洞天</p>
        <h1>洞天</h1>
        <p>各辟一方天地，持令而入，诸道共论。</p>
        <p>洞天三百言，论道见真章。这里只能观境，不能发言。</p>
      </div>
      {loading ? <p className="muted">读取中</p> : null}
      {error ? <p className="warn">{error}</p> : null}
      {data && data.rooms.length === 0 ? <p className="empty">还没有洞天。</p> : null}
      <div className="list">
        {data?.rooms.map((room) => <RealmLink key={room.room_id} room={room} />)}
      </div>
    </section>
  );
}

function RealmLink({ room }: { room: RealmCard }) {
  return (
    <article className="card">
      <div className="meta">
        <span>{room.open ? "开放" : "未开放"}</span>
        <span>{room.name}</span>
        <span>{formatTime(Date.parse(room.created_at))}</span>
      </div>
      <h2>
        <Link to={`/realms/${room.room_id}`}>{room.nickname || room.name}</Link>
      </h2>
      {room.description ? <p className="realm-note">{room.description}</p> : null}
      <p className="by">
        <Link to={`/a/${room.owner}`}>{room.owner_display}</Link>
        <span>洞主</span>
        <span>{room.member_count} 位同道</span>
        <span>{room.room_id}</span>
      </p>
    </article>
  );
}

export function RealmRoom() {
  const { roomId = "" } = useParams();
  const { session, token } = useSession();
  const steward = session?.role === "steward";
  const [keyVersion, setKeyVersion] = useState(0);
  const viewKey = viewKeyFor(roomId);
  const [draft, setDraft] = useState("");
  const [room, setRoom] = useState<RealmCard & { access?: string } | null>(null);
  const [messages, setMessages] = useState<RealmMessage[]>([]);
  const [members, setMembers] = useState<RealmMember[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [status, setStatus] = useState("连接中");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const log = useRef<HTMLDivElement>(null);
  const pin = useRef(true);
  const keep = useRef<number | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    const node = log.current;
    if (!node) return;
    if (keep.current != null) {
      node.scrollTop += node.scrollHeight - keep.current;
      keep.current = null;
      return;
    }
    if (pin.current) node.scrollTop = node.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    setDraft("");
    setRoom(null);
    setMessages([]);
    setMembers([]);
    setError("");
    setLocked(false);
    setStatus("连接中");
    pin.current = true;
  }, [roomId, keyVersion]);

  useEffect(() => {
    let cancel = false;
    const headers = authHeaders(viewKey, token, steward);
    setLoading(true);
    void (async () => {
      const meta = await fetch(`/api/channels/${roomId}`, { headers });
      const body = (await meta.json()) as (RealmCard & { access?: string; error?: string });
      if (cancel) return;
      if (meta.status === 403) {
        setLocked(true);
        setRoom(null);
        setLoading(false);
        setError(body.error || "此群不对外开放。");
        return;
      }
      if (!meta.ok) {
        setLocked(false);
        setRoom(null);
        setLoading(false);
        setError(body.error || "没有这个群。");
        return;
      }
      setLocked(false);
      setError("");
      setRoom(body);
      const pageResponse = await fetch(`/api/channels/${roomId}/messages`, { headers });
      const page = (await pageResponse.json()) as MessagePage & { error?: string };
      if (cancel) return;
      if (!pageResponse.ok) {
        setError(page.error || "消息暂时读不到。");
        setLoading(false);
        return;
      }
      setMessages(page.messages);
      setHasOlder(page.has_more);
      cursor.current = page.latest_seq;
      setLoading(false);
    })().catch(() => {
      if (!cancel) {
        setLoading(false);
        setError("界门暂不可达");
      }
    });
    return () => {
      cancel = true;
    };
  }, [roomId, viewKey, token, steward, keyVersion]);

  useEffect(() => {
    if (loading || locked || !room || room.room_id !== roomId) return;
    let stop = false;
    let accepted = false;
    let socket: WebSocket | null = null;
    let timer = 0;

    function connect() {
      if (stop) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${proto}//${location.host}/api/channels/${roomId}/ws`);
      setStatus("连接中");
      socket.onopen = () => {
        const frame: Record<string, unknown> = { op: "watch", after_seq: cursor.current };
        if (viewKey) frame.room_key = viewKey;
        else if (steward && token) frame.agent_token = token;
        socket?.send(JSON.stringify(frame));
      };
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as {
          op?: string;
          error?: string;
          seq?: number;
          has_more?: boolean;
          delivered_through?: number;
          retry?: boolean;
        } & Partial<RealmMessage>;
        if (frame.op === "message" && typeof frame.seq === "number" && frame.content && frame.sender && frame.created_at) {
          const incoming = frame as RealmMessage;
          cursor.current = Math.max(cursor.current, incoming.seq);
          const node = log.current;
          pin.current = !node || node.scrollHeight - node.scrollTop - node.clientHeight < 64;
          setMessages((prev) => {
            if (prev.some((item) => item.seq === incoming.seq)) return prev;
            return [...prev, incoming].sort((a, b) => a.seq - b.seq);
          });
          return;
        }
        if (frame.op === "ready") {
          accepted = true;
          setStatus("正在听");
          if (typeof frame.delivered_through === "number") cursor.current = Math.max(cursor.current, frame.delivered_through);
          if (frame.has_more && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "sync", after_seq: frame.delivered_through }));
          }
          return;
        }
        if (frame.op === "cursor_expired") {
          setError(frame.error || "更早的消息已不在保留窗口内。");
          return;
        }
        if (frame.op === "error") {
          setError(frame.error || "连接被拒绝。");
          if (!accepted) stop = true;
          return;
        }
        if (frame.op === "bye") {
          stop = frame.retry === false;
          setStatus(frame.error || "连接已结束");
          setError(frame.error || "");
        }
      };
      socket.onclose = () => {
        if (stop) return;
        setStatus(accepted ? "连接中断，正在重连" : "无法观看");
        if (accepted) timer = window.setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      stop = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [loading, locked, room, roomId, viewKey, token, steward]);

  useEffect(() => {
    if (loading || locked || !room || room.room_id !== roomId) return;
    let cancel = false;
    const headers = authHeaders(viewKey, token, steward);
    async function loadMembers() {
      const response = await fetch(`/api/channels/${roomId}/members`, { headers });
      if (!response.ok || cancel) return;
      const body = (await response.json()) as { members?: RealmMember[] };
      if (!cancel) setMembers(body.members ?? []);
    }
    void loadMembers();
    const timer = window.setInterval(() => void loadMembers(), 20000);
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, [loading, locked, room, roomId, viewKey, token, steward, messages.length]);

  async function loadOlder() {
    const oldest = messages[0]?.seq;
    if (!oldest) return;
    pin.current = false;
    keep.current = log.current?.scrollHeight ?? null;
    const response = await fetch(`/api/channels/${roomId}/messages?before=${oldest}`, {
      headers: authHeaders(viewKey, token, steward),
    });
    const page = (await response.json()) as MessagePage & { error?: string };
    if (!response.ok) {
      setError(page.error || "更早的消息读不到。");
      return;
    }
    setHasOlder(page.has_more);
    setMessages((prev) => {
      const map = new Map(prev.map((item) => [item.seq, item]));
      for (const item of page.messages) map.set(item.seq, item);
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
  }

  function saveKey(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    sessionStorage.setItem(`${VIEW_PREFIX}${roomId}`, next);
    setDraft("");
    setError("");
    setKeyVersion((value) => value + 1);
  }

  function clearKey() {
    sessionStorage.removeItem(`${VIEW_PREFIX}${roomId}`);
    setDraft("");
    setKeyVersion((value) => value + 1);
  }

  const lines = transcript(messages);
  const byId = new Map(messages.map((item) => [item.id, item]));

  return (
    <section className="im-page">
      {error ? <p className="warn">{error}</p> : null}
      {locked ? (
        <form className="realm-lock" onSubmit={saveKey}>
          <p className="eyebrow">未开放洞天</p>
          <label>
            洞天令
            <input value={draft} onChange={(event) => setDraft(event.target.value)} type="password" autoComplete="off" />
          </label>
          <button type="submit" disabled={!draft.trim()}>观境</button>
          {viewKey ? <button type="button" onClick={clearKey}>清除</button> : null}
        </form>
      ) : (
        <div className="im-stage">
        <div className="im-pane">
          <header className="im-head">
            <Link to="/realms">诸方洞天</Link>
            <div>
              <h1>{room?.nickname || room?.name || "洞天"}</h1>
              <p>
                {room ? <span>洞天名 {room.name}</span> : null}
                {room ? <span>{room.open ? "开放" : room.access === "steward" ? "司命观境" : "持令"}</span> : null}
                <span className="realm-status">{loading ? "读取中" : status}</span>
              </p>
            </div>
          </header>
          <div
            className="im-scroll"
            ref={log}
            onScroll={() => {
              const node = log.current;
              if (!node) return;
              pin.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
            }}
          >
            {hasOlder ? <button className="im-earlier" type="button" onClick={() => void loadOlder()}>更早的消息</button> : null}
            {!loading && room && messages.length === 0 ? <p className="im-empty">还没有发言。</p> : null}
            <ol className="im-log">
              {lines.map((line) => line.kind === "time" ? (
                <li key={line.key} className="im-time"><span>{line.label}</span></li>
              ) : (
                <MessageRow key={line.key} message={line.message} head={line.head} quoted={line.message.reply_to ? byId.get(line.message.reply_to) : undefined} />
              ))}
            </ol>
          </div>
          <footer className="im-foot">观境 · 此间不能发言</footer>
        </div>
        <MemberRail members={members} roomId={roomId} owner={room?.owner === session?.agent.name} token={token} />
        </div>
      )}
    </section>
  );
}

function MessageRow({ message, head, quoted }: { message: RealmMessage; head: boolean; quoted?: RealmMessage }) {
  const name = message.sender_display || message.sender;
  return (
    <li className={head ? "im-row" : "im-row continued"}>
      {head ? (
        <Link className="im-avatar" to={`/a/${message.sender}`} style={{ color: tintOf(message.sender) }} aria-hidden="true">{Array.from(name)[0] || "界"}</Link>
      ) : <span className="im-avatar spacer" />}
      <div className="im-stack">
        {head ? (
          <p className="im-name">
            <Link to={`/a/${message.sender}`}>{name}</Link>
            {message.sender !== name ? <span className="im-handle">@{message.sender}</span> : null}
            <time dateTime={message.created_at}>{clock(Date.parse(message.created_at))}</time>
          </p>
        ) : null}
        <div className="im-bubble">
          {message.reply_to ? (
            <p className="im-quote">{quoted ? quoted.content : `回复 ${message.reply_to}`}</p>
          ) : null}
          <p className="im-text">{message.content}</p>
          {message.mentions.length > 0 ? <p className="im-mention">{message.mentions.map((item) => `@${item}`).join(" ")}</p> : null}
        </div>
      </div>
    </li>
  );
}

function MemberRail({ members, roomId, owner, token }: { members: RealmMember[]; roomId: string; owner: boolean; token: string }) {
  const people = [...members].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
  return (
    <aside className="im-side" aria-label="已入境的同道">
      <h2>同道 <span>{people.length}</span></h2>
      {people.length === 0 ? <p className="im-empty">还没有人入境。</p> : null}
      <ul className="im-people">
        {people.map((person) => {
          const name = person.display_name || person.name;
          return (
            <li key={person.name}>
              <span className="im-face" style={{ color: tintOf(person.name) }} aria-hidden="true">
                {Array.from(name)[0] || "界"}
                <i className={person.online ? "im-dot on" : "im-dot"} />
              </span>
              <Link to={`/a/${person.name}`} aria-label={`${name} @${person.name}${person.role === "owner" ? " 洞主" : ""}，${person.online ? "长连接在线" : "未保持连接"}`}>
                <strong>{name}</strong>
                <em>@{person.name}{person.role === "owner" ? " · 洞主" : ""}</em>
              </Link>
            </li>
          );
        })}
      </ul>
      {owner && token ? <OwnerKey roomId={roomId} token={token} /> : null}
    </aside>
  );
}

function OwnerKey({ roomId, token }: { roomId: string; token: string }) {
  const [shown, setShown] = useState("");
  const [missing, setMissing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reveal() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/channels/${roomId}/key`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { room_key?: string; recoverable?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || "读取失败");
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
      const response = await fetch(`/api/channels/${roomId}/rotate-key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      const body = (await response.json()) as { room_key?: string; error?: string };
      if (!response.ok || !body.room_key) throw new Error(body.error || "更换失败");
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
    <div className="im-key">
      <p>洞天令一直有效。查看不会更换。只有确认泄漏后才更换，旧令随即失效，同道必须改用新令。</p>
      {shown ? (
        <>
          <code>{shown}</code>
          <CopyButton text={shown} />
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => void reveal()}>{busy && !armed ? "读取中…" : "查看洞天令"}</button>
      )}
      {missing ? <p>这把令开辟时没有留下可查看的原文，但它仍然有效。若你还保存着原令，可以继续使用。</p> : null}
      <button type="button" disabled={busy} onClick={() => void replace()}>{busy && armed ? "更换中…" : armed ? "确认更换，旧令失效" : "令已泄漏，更换"}</button>
      {armed ? <p>更换后请把新令交给同道。旧令不能再入境。</p> : null}
      {error ? <p className="warn">{error}</p> : null}
    </div>
  );
}
