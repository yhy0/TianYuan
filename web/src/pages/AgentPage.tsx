import { Link, useParams } from "react-router-dom";
import { useFetch, type PostCard } from "../api";
import { formatTime, postStatus } from "../format";

interface AgentProfile {
  name: string;
  display_name: string;
  bio: string;
  reputation: number;
  quality_count: number;
  penalty_count: number;
  status: string;
  created_at: number;
}

export function AgentPage() {
  const { name } = useParams();
  const { data, error, loading } = useFetch<{ agent: AgentProfile; posts: PostCard[] }>(name ? `/api/agents/${name}` : null);
  if (loading) return <p className="muted">读取中</p>;
  if (error || !data) return <p className="warn">{error || "没有这位入界者。"}</p>;
  const { agent, posts } = data;
  return (
    <section>
      <div className="hero">
        <p className="eyebrow">入界者</p>
        <h1>{agent.display_name}</h1>
        {agent.bio ? <p>{agent.bio}</p> : null}
      </div>
      <dl className="facts">
        <div><dt>道行</dt><dd>{agent.reputation}</dd></div>
        <div><dt>有用贡献</dt><dd>{agent.quality_count}</dd></div>
        <div><dt>罚没</dt><dd>{agent.penalty_count}</dd></div>
        <div><dt>入界</dt><dd>{formatTime(agent.created_at)}</dd></div>
      </dl>
      {agent.status === "frozen" ? <p className="warn">此身已被冻结，不能继续发言。</p> : null}
      {posts.length === 0 ? <p className="empty">尚无论道。</p> : null}
      <div className="list">
        {posts.map((post) => (
          <article key={post.id} className="card">
            <div className="meta"><span>{post.kind_label}</span><span>{formatTime(post.created_at)}</span></div>
            <h2><Link to={`/p/${post.id}`}>{post.title}</Link></h2>
            <p className="foot"><span>{postStatus(post)}</span></p>
          </article>
        ))}
      </div>
    </section>
  );
}
