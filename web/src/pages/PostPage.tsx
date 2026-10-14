import { useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch, type AttestItem, type PostCard, type ReplyItem } from "../api";
import { channelLabel, formatTime, postStatus, Prose } from "../format";

export function PostPage() {
  const { id } = useParams();
  const { data, error, loading } = useFetch<{ post: PostCard; replies: ReplyItem[]; attests: AttestItem[] }>(id ? `/api/posts/${id}` : null);
  if (loading) return <p className="muted">读取中</p>;
  if (error || !data) return <p className="warn">{error || "没有这篇论道。"}</p>;
  const { post, replies, attests } = data;
  return (
    <article className="sheet">
      <p className="eyebrow">{post.kind_label} · {channelLabel(post.channel)}</p>
      <h1>{post.title}</h1>
      <p className="by">
        <Link to={`/a/${post.author.name}`}>{post.author.display_name}</Link>
        <span>道行 {post.author.reputation ?? 0}</span>
        <span>{formatTime(post.created_at)}</span>
      </p>
      <Prose text={post.body || ""} />
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
        <div><dt>销毁</dt><dd>{post.burn}</dd></div>
        <div><dt>质押</dt><dd>{post.stake}</dd></div>
        <div><dt>悬赏</dt><dd>{post.bounty_locked || "—"}</dd></div>
        <div><dt>状态</dt><dd>{postStatus(post)}</dd></div>
      </dl>
      {post.settle_note ? <p className="note">{post.settle_note}</p> : null}
      <h2>验证</h2>
      {attests.length === 0 ? <p className="muted">尚无验证。</p> : null}
      {attests.map((item) => (
        <section key={item.id} className="reply">
          <p className="meta"><span>{item.verdict_label}</span><Link to={`/a/${item.author.name}`}>{item.author.display_name}</Link><span>{formatTime(item.created_at)}</span></p>
          <Prose text={item.reason} />
        </section>
      ))}
      <h2>评注</h2>
      {replies.length === 0 ? <p className="muted">还没有评注。</p> : null}
      <ReplyTree nodes={threadReplies(replies)} />
    </article>
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

function ReplyTree({ nodes }: { nodes: ReplyNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="thread">
      {nodes.map((node) => (
        <div key={node.reply.id}>
          <ReplyCard reply={node.reply} />
          <ReplyTree nodes={node.children} />
        </div>
      ))}
    </div>
  );
}

function ReplyCard({ reply }: { reply: ReplyItem }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [short, setShort] = useState(false);
  const clamped = !open && !short;

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => {
      if (open) return;
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
        <span>{formatTime(reply.created_at)}</span>
        <span>赞同 {reply.signal_up}</span>
      </p>
      <div ref={bodyRef} className={clamped ? "reply-body clamped" : "reply-body"}>
        <Prose text={reply.body} />
      </div>
      {reply.citations.length > 0 && !clamped ? (
        <ul className="cites">
          {reply.citations.map((cite) => (
            <li key={cite.url}>
              <a href={cite.url} target="_blank" rel="noreferrer">{cite.note || cite.url}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {short ? null : (
        <button className="fold" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "展开"}
        </button>
      )}
    </section>
  );
}
