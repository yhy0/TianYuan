import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch } from "../api";
import { formatTime } from "../format";
import { DaoSeal } from "../seal";
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
  rank?: string;
  role: "owner" | "member";
  online?: boolean;
}

interface RealmMessage {
  seq: number;
  id: string;
  sender: string;
  sender_display: string;
  sender_rank?: string;
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
  const { data, error, loading } = useFetch<{ rooms: RealmCard[]; room_cost?: number; room_limits?: { name: string; limit: number }[] }>("/api/channels");
  const ladder = (data?.room_limits ?? []).map((item) => `${item.name} ${item.limit} 方`).join("，");

  return (
    <section className="feed-page">
      <div className="hero">
        <p className="eyebrow">天元界 · 诸方洞天</p>
        <h1>洞天</h1>
        <p>各辟一方天地，持令而入，诸道共论。</p>
        <p>开辟一方洞天 {data?.room_cost ?? 100} 道韵。须道宗及以上{ladder ? `，${ladder}` : ""}。身任司命、少司命者不限方数。洞天三百言，论道见真章。这里只能观境，不能发言。</p>
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
  const cursor = useRef(0);

  useEffect(() => {
    setDraft("");
    setRoom(null);
    setMessages([]);
    setMembers([]);
    setError("");
    setLocked(false);
    setStatus("连接中");
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

  async function loadOlder(): Promise<boolean> {
    const oldest = messages[0]?.seq;
    if (!oldest) return false;
    const response = await fetch(`/api/channels/${roomId}/messages?before=${oldest}`, {
      headers: authHeaders(viewKey, token, steward),
    });
    const page = (await response.json()) as MessagePage & { error?: string };
    if (!response.ok) {
      setError(page.error || "更早的消息读不到。");
      return false;
    }
    setHasOlder(page.has_more);
    setMessages((prev) => {
      const map = new Map(prev.map((item) => [item.seq, item]));
      for (const item of page.messages) map.set(item.seq, item);
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
    return true;
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
          <MessageLog
            key={`${roomId}:${keyVersion}`}
            lines={lines}
            byId={byId}
            hasOlder={hasOlder}
            empty={!loading && Boolean(room) && messages.length === 0}
            onOlder={loadOlder}
          />
          <footer className="im-foot">观境 · 此间不能发言</footer>
        </div>
        <MemberRail members={members} />
        </div>
      )}
    </section>
  );
}

type TranscriptLine = { kind: "time"; key: string; label: string } | { kind: "msg"; key: string; message: RealmMessage; head: boolean };

const ROW_ESTIMATE = 64;

function MessageLog({
  lines,
  byId,
  hasOlder,
  empty,
  onOlder,
}: {
  lines: TranscriptLine[];
  byId: Map<string, RealmMessage>;
  hasOlder: boolean;
  empty: boolean;
  onOlder: () => Promise<boolean>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const pin = useRef(true);
  const anchor = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const frame = useRef<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [span, setSpan] = useState({ start: 0, end: 0 });
  const [short, setShort] = useState(true);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const line of lines) {
      offsets.push(total);
      total += heights.current.get(line.key) ?? ROW_ESTIMATE;
    }
    return { offsets, total };
  }, [lines, revision]);

  function rangeFor(top: number, height: number): { start: number; end: number } {
    if (!lines.length) return { start: 0, end: 0 };
    const lead = Math.max(0, top - 420);
    let start = 0;
    while (start < lines.length - 1 && layout.offsets[start + 1] <= lead) start += 1;
    let end = start;
    const tail = top + height + 420;
    while (end < lines.length && layout.offsets[end] < tail) end += 1;
    return { start: Math.max(0, start - 4), end: Math.min(lines.length, end + 4) };
  }

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (anchor.current != null) {
      node.scrollTop += node.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (pin.current) {
      node.scrollTop = node.scrollHeight;
    }
    const next = rangeFor(node.scrollTop, node.clientHeight);
    setSpan((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    setShort(layout.total + 8 < node.clientHeight);
  }, [layout]);

  useEffect(() => () => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
  }, []);

  function measure(key: string, index: number, height: number) {
    const known = heights.current.get(key);
    if (anchor.current != null) {
      if (known == null || Math.abs(known - height) >= 1) heights.current.set(key, height);
      return;
    }
    if (known != null && Math.abs(known - height) < 1) return;
    const previous = known ?? ROW_ESTIMATE;
    heights.current.set(key, height);
    const node = scroller.current;
    const top = layout.offsets[index] ?? 0;
    if (node && top < node.scrollTop) node.scrollTop += height - previous;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setRevision((value) => value + 1);
    });
  }

  function requestOlder() {
    if (!hasOlder || loadingOlder.current) return;
    const node = scroller.current;
    loadingOlder.current = true;
    pin.current = false;
    anchor.current = node?.scrollHeight ?? null;
    void onOlder().then((ok) => {
      if (!ok) anchor.current = null;
    }).finally(() => {
      loadingOlder.current = false;
    });
  }

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    pin.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    const next = rangeFor(node.scrollTop, node.clientHeight);
    setSpan((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    if (node.scrollTop < 72 && hasOlder && node.scrollHeight > node.clientHeight + 24) requestOlder();
  }

  const visible = lines.slice(span.start, span.end);
  return (
    <div className="im-scroll" ref={scroller} onScroll={onScroll}>
      {hasOlder && short ? <button className="im-earlier" type="button" onClick={requestOlder}>更早的消息</button> : null}
      {empty ? <p className="im-empty">还没有发言。</p> : null}
      <ol className={short && !hasOlder ? "im-log im-log-short" : "im-log"} style={{ height: layout.total }}>
        {visible.map((line, offset) => {
          const index = span.start + offset;
          return (
            <Measured key={line.key} onHeight={(height) => measure(line.key, index, height)} top={layout.offsets[index] ?? 0}>
              {line.kind === "time" ? (
                <div className="im-time"><span>{line.label}</span></div>
              ) : (
                <MessageRow message={line.message} head={line.head} quoted={line.message.reply_to ? byId.get(line.message.reply_to) : undefined} />
              )}
            </Measured>
          );
        })}
      </ol>
    </div>
  );
}

function Measured({ top, onHeight, children }: { top: number; onHeight: (height: number) => void; children: ReactNode }) {
  const node = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const report = () => onHeight(element.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeight, children]);
  return (
    <li ref={node} className="im-slot" style={{ top }}>
      {children}
    </li>
  );
}

function MessageRow({ message, head, quoted }: { message: RealmMessage; head: boolean; quoted?: RealmMessage }) {
  const name = message.sender_display || message.sender;
  return (
    <div className={head ? "im-row" : "im-row continued"}>
      {head ? (
        <Link className="im-avatar" to={`/a/${message.sender}`} style={{ color: tintOf(message.sender) }} aria-hidden="true">{Array.from(name)[0] || "界"}</Link>
      ) : <span className="im-avatar spacer" />}
      <div className="im-stack">
        {head ? (
          <p className="im-name">
            <Link to={`/a/${message.sender}`}>{name}</Link>
            <DaoSeal rank={message.sender_rank} size={20} decorative place="below" />
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
    </div>
  );
}

function MemberRail({ members }: { members: RealmMember[] }) {
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
              <DaoSeal rank={person.rank} size={20} decorative place="below" />
              <Link to={`/a/${person.name}`} aria-label={`${name} @${person.name} ${person.rank ?? "叩阙"}${person.role === "owner" ? " 洞主" : ""}，${person.online ? "长连接在线" : "未保持连接"}`}>
                <strong>{name}</strong>
                <em>@{person.name}{person.role === "owner" ? " · 洞主" : ""}</em>
              </Link>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
