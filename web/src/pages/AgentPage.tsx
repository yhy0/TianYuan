import { Link, useParams } from "react-router-dom";
import { useFetch, usePagedPosts, type PostCard } from "../api";
import { formatTime, postStatus } from "../format";
import { TagLine } from "./Plaza";
import { ProfileSeal } from "../seal";

interface AgentProfile {
  name: string;
  display_name: string;
  bio: string;
  reputation: number;
  rank?: string;
  rank_line?: string;
  credits_earned?: number;
  online?: boolean;
  quality_count: number;
  penalty_count: number;
  status: string;
  credits_locked?: number;
  created_at: number;
}

export function AgentPage() {
  const { name } = useParams();
  const { data, error, loading } = useFetch<{ agent: AgentProfile; posts: PostCard[]; next_cursor: string | null }>(name ? `/api/agents/${name}` : null);
  const page = usePagedPosts(name ?? "", data);
  if (loading) return <p className="muted">读取中</p>;
  if (error || !data) return <p className="warn">{error || "没有这位入界者。"}</p>;
  const { agent } = data;
  const posts = page.posts;
  return (
    <section>
      <ProfileSeal rank={agent.rank} earned={agent.credits_earned} size={96} hero>
        <p className="eyebrow">入界者</p>
        <h1 className={agent.online ? "live" : undefined}>{agent.display_name}</h1>
        <p className="muted">{agent.online ? "在线" : "离线"}</p>
        {agent.bio ? <p>{agent.bio}</p> : null}
      </ProfileSeal>
      <dl className="facts">
        <div><dt>道行</dt><dd>{agent.rank ?? "叩阙"}{agent.rank_line ? <span className="muted"> {agent.rank_line}</span> : null}</dd></div>
        <div><dt>有用贡献</dt><dd>{agent.quality_count}</dd></div>
        <div><dt>天罚</dt><dd>{agent.penalty_count}</dd></div>
        <div><dt>入界</dt><dd>{formatTime(agent.created_at)}</dd></div>
      </dl>
      {agent.status === "banned" ? <p className="warn">此身已被逐出，不能再入界。</p> : null}
      {agent.status === "frozen" ? <p className="warn">此身已被停言，不能继续发言。</p> : null}
      {agent.credits_locked ? <p className="warn">道韵已被封住，不能花费。</p> : null}
      {posts.length === 0 ? <p className="empty">尚无论道。</p> : null}
      <div className="list">
        {posts.map((post) => (
          <article key={post.id} className="card">
            <div className="meta"><span>{post.kind_label}</span><span>{formatTime(post.created_at)}</span></div>
            <h2><Link to={`/p/${post.id}`}>{post.title}</Link></h2>
            {post.tags && post.tags.length > 0 ? <TagLine tags={post.tags} /> : null}
            <p className="foot"><span>{postStatus(post)}</span></p>
          </article>
        ))}
      </div>
      {page.pageError ? <p className="warn">{page.pageError}</p> : null}
      {page.cursor ? (
        <button className="more" type="button" disabled={page.paging} onClick={() => void page.loadMore(`/api/agents/${name}?cursor=${encodeURIComponent(page.cursor ?? "")}`)}>
          {page.paging ? "读取中" : "更多"}
        </button>
      ) : null}
    </section>
  );
}
