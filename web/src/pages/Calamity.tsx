import { Link } from "react-router-dom";
import { useFetch, type PostCard } from "../api";
import { channelLabel, formatTime, postStatus } from "../format";
import { RankMark } from "../seal";

interface Penalty {
  id: string;
  name: string;
  display_name: string;
  amount: number;
  deducted: number;
  earned: number;
  reason: string;
  created_at: number;
}

export function Calamity() {
  const { data, error, loading } = useFetch<{ people: Penalty[]; posts: PostCard[] }>("/api/calamity");
  return (
    <section>
      <div className="hero">
        <p className="eyebrow">天元界 · 界律昭明</p>
        <h1>天罚</h1>
        <p>违律者受罚，失道者留痕。</p>
      </div>
      {loading ? <p className="muted">读取中</p> : null}
      {error ? <p className="warn">{error}</p> : null}
      <h2>入界者</h2>
      {data && data.people.length === 0 ? <p className="empty">尚无天罚。</p> : null}
      <ul className="calamity">
        {data?.people.map((person) => (
          <li key={person.id}>
            <p className="by">
              <Link to={`/a/${person.name}`}>{person.display_name}</Link>
              <span className="handle">@{person.name}</span>
              <b>-{person.deducted} 道韵</b>
              {person.earned > 0 ? <b>-{person.earned} 道行</b> : null}
              <span>{formatTime(person.created_at)}{person.deducted < person.amount ? ` · 原拟 ${person.amount}` : ""}</span>
            </p>
            <p>{person.reason}</p>
          </li>
        ))}
      </ul>
      <h2>论道</h2>
      {data && data.posts.length === 0 ? <p className="empty">尚无被清出的论道。</p> : null}
      <div className="list">
        {data?.posts.map((post) => (
          <article key={post.id} className="card">
            <div className="meta">
              <span>{channelLabel(post.channel)}</span>
              <span>{post.kind_label}</span>
              <span>{formatTime(post.created_at)}</span>
            </div>
            <h2><Link to={`/p/${post.id}`}>{post.title}</Link></h2>
            <p className="by">
              <Link to={`/a/${post.author.name}`}>{post.author.display_name}</Link>
              <RankMark rank={post.author.rank} size={16} quiet />
            </p>
            <p className="foot">
              <span>{postStatus(post)}</span>
              {post.settle_note ? <span>{post.settle_note}</span> : null}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
