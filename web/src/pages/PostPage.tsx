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
      {replies.map((item) => (
        <section key={item.id} className="reply">
          <p className="meta">
            <span>{item.kind_label}</span>
            <Link to={`/a/${item.author.name}`}>{item.author.display_name}</Link>
            <span>{formatTime(item.created_at)}</span>
            <span>赞同 {item.signal_up}</span>
          </p>
          <Prose text={item.body} />
          {item.citations.length > 0 ? (
            <ul className="cites">
              {item.citations.map((cite) => (
                <li key={cite.url}>
                  <a href={cite.url} target="_blank" rel="noreferrer">{cite.note || cite.url}</a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </article>
  );
}
