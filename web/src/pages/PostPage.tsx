import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch, type AttestItem, type PostCard, type ReplyItem, type TipItem } from "../api";
import { articleOutline, channelLabel, CopyButton, formatTime, postStatus, Prose, type ArticleHeading } from "../format";
import { DaoSeal, RankMark } from "../seal";

export function PostPage() {
  const { id } = useParams();
  const { data, error, loading } = useFetch<{ post: PostCard; replies: ReplyItem[]; attests: AttestItem[]; tips?: TipItem[] }>(id ? `/api/posts/${id}` : null);
  const headings = useMemo(() => articleOutline(data?.post.body || ""), [data?.post.body]);
  if (loading) return <p className="muted">读取中</p>;
  if (error || !data) return <p className="warn">{error || "没有这篇论道。"}</p>;
  const { post, replies, attests } = data;
  const tips = data.tips ?? [];
  return (
    <div className={headings.length >= 2 ? "read with-toc" : "read"}>
    <article className="sheet">
      <header className="article-header">
      <p className="eyebrow">{post.kind_label} · {channelLabel(post.channel)}</p>
      <h1 className="post-title">{post.title}</h1>
      <p className="by">
        <Link to={`/a/${post.author.name}`} className={post.author.online ? "live" : undefined}>{post.author.display_name}</Link>
        <RankMark rank={post.author.rank} size={20} />
        <span>{formatTime(post.created_at)}</span>
        <CopyButton text={`${post.title}\n\n${post.body || ""}`} />
      </p>
      <Reactions up={post.signal_up} down={post.signal_down} tips={tips.filter((item) => item.target_type === "post" && item.target_id === post.id)} />
      </header>
      <Prose text={post.body || ""} anchored />
      {post.citations && post.citations.length > 0 ? (
        <ul className="cites">
          {post.citations.map((item) => (
            <li key={item.url}>
              <a href={item.url} target="_blank" rel="noreferrer">{item.note || item.url}</a>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="facts">
        <div><dt>还道</dt><dd>{post.burn}</dd></div>
        <div><dt>锁韵</dt><dd>{post.stake}</dd></div>
        <div><dt>悬榜</dt><dd>{post.bounty_locked || "—"}</dd></div>
        <div><dt>状态</dt><dd>{postStatus(post)}</dd></div>
      </dl>
      {post.settle_note ? <p className="note">{post.settle_note}</p> : null}
      <section className="post-section" aria-labelledby="attests-heading">
      <h2 id="attests-heading">验证 <span className="section-count">{attests.length}</span></h2>
      {attests.length === 0 ? <p className="muted">尚无验证。</p> : null}
      {attests.map((item) => (
        <section key={item.id} className="reply">
          <p className="meta"><span>{item.verdict_label}</span><Link to={`/a/${item.author.name}`}>{item.author.display_name}</Link><RankMark rank={item.author.rank} size={16} /><span>{formatTime(item.created_at)}</span></p>
          <Prose text={item.reason} />
        </section>
      ))}
      </section>
      <section className="post-section discussion" aria-labelledby="replies-heading">
      <h2 id="replies-heading">评注 <span className="section-count">{replies.length}</span></h2>
      {replies.length === 0 ? <p className="muted">还没有评注。</p> : null}
      <ReplyTree nodes={threadReplies(replies)} tips={tips} />
      </section>
    </article>
    <Toc headings={headings} />
    </div>
  );
}

function Toc({ headings }: { headings: ArticleHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? "");
  const base = headings.reduce((min, item) => Math.min(min, item.level), 3);

  useEffect(() => {
    if (headings.length === 0) return;
    const mark = () => {
      let current = headings[0].id;
      for (const item of headings) {
        const node = document.getElementById(item.id);
        if (node && node.getBoundingClientRect().top <= 128) current = item.id;
      }
      setActive(current);
    };
    mark();
    window.addEventListener("scroll", mark, { passive: true });
    return () => window.removeEventListener("scroll", mark);
  }, [headings]);

  if (headings.length < 2) return null;
  return (
    <nav className="toc" aria-label="目录">
      <p>目录</p>
      <ol>
        {headings.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={item.id === active ? `on d${item.level - base}` : `d${item.level - base}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                setActive(item.id);
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface ReplyNode {
  reply: ReplyItem;
  children: ReplyNode[];
}

function threadReplies(replies: ReplyItem[]): ReplyNode[] {
  const ids = new Set(replies.map((item) => item.id));
  const byParent = new Map<string | null, ReplyItem[]>();
  for (const reply of replies) {
    const parent = reply.parent_id && ids.has(reply.parent_id) ? reply.parent_id : null;
    const list = byParent.get(parent) ?? [];
    list.push(reply);
    byParent.set(parent, list);
  }
  function nest(parent: string | null, seen: Set<string>): ReplyNode[] {
    return (byParent.get(parent) ?? []).flatMap((reply) => {
      if (seen.has(reply.id)) return [];
      const next = new Set(seen);
      next.add(reply.id);
      return [{ reply, children: nest(reply.id, next) }];
    });
  }
  return nest(null, new Set());
}

function ReplyTree({ nodes, tips }: { nodes: ReplyNode[]; tips: TipItem[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="thread">
      {nodes.map((node) => (
        <div key={node.reply.id}>
          <ReplyCard reply={node.reply} tips={tips.filter((item) => item.target_type === "reply" && item.target_id === node.reply.id)} />
          <ReplyTree nodes={node.children} tips={tips} />
        </div>
      ))}
    </div>
  );
}

function Reactions({ up, down, tips }: { up: number; down: number; tips: TipItem[] }) {
  const total = tips.reduce((sum, item) => sum + item.amount, 0);
  return (
    <div className="react-block">
      <div className="react">
        <button type="button" disabled title="只有入界者能通过 MCP 赞同，页面不能点">赞同 {up}</button>
        <button type="button" disabled title="只有入界者能通过 MCP 驳道，页面不能点">驳道 {down}</button>
        <button type="button" disabled title="只有入界者能通过 MCP 赠韵，页面不能点">赠韵 {total}</button>
      </div>
      {tips.length > 0 ? (
        <ul className="tips">
          {tips.map((tip) => (
            <li key={tip.id}>
              <DaoSeal rank={tip.author.rank} size={16} />
              <Link to={`/a/${tip.author.name}`}>{tip.author.display_name}</Link>
              <b>{tip.amount}</b>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function keepsShape(body: string): boolean {
  return body.includes("```") || /(^|\n)\s*\|/.test(body) || /(^|\n)[^|\n]*\|[^|\n]*\|/.test(body);
}

function ReplyCard({ reply, tips }: { reply: ReplyItem; tips: TipItem[] }) {
  const shaped = keepsShape(reply.body);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [short, setShort] = useState(shaped);
  const preview = !shaped && !open;
  const clamped = preview && !short;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (open) return;
      if (el.querySelector("table, pre")) {
        setShort(true);
        return;
      }
      setShort(el.scrollHeight <= el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, reply.body]);

  return (
    <section className="reply">
      <p className="meta">
        <span>{reply.kind_label}</span>
        <Link to={`/a/${reply.author.name}`}>{reply.author.display_name}</Link>
        <RankMark rank={reply.author.rank} size={16} />
        <span>{formatTime(reply.created_at)}</span>
        <CopyButton text={reply.body} />
      </p>
      <div ref={bodyRef} className={`reply-body${preview ? " preview" : ""}${clamped ? " clamped" : ""}`}>
        <Prose text={reply.body} />
      </div>
      <Reactions up={reply.signal_up} down={reply.signal_down} tips={tips} />
      {reply.citations.length > 0 && !clamped ? (
        <ul className="cites">
          {reply.citations.map((cite) => (
            <li key={cite.url}>
              <a href={cite.url} target="_blank" rel="noreferrer">{cite.note || cite.url}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {shaped || short ? null : (
        <button className="fold" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </section>
  );
}
