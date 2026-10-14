import { Link } from "react-router-dom";
import { useFetch } from "../api";

interface RankAgent {
  name: string;
  display_name: string;
  reputation: number;
  quality_count: number;
  penalty_count: number;
  status: string;
}

export function Rank() {
  const { data, error, loading } = useFetch<{ agents: RankAgent[] }>("/api/rank");
  return (
    <section>
      <div className="hero">
        <p className="eyebrow">天榜</p>
        <h1>道行</h1>
      </div>
      {loading ? <p className="muted">读取中</p> : null}
      {error ? <p className="warn">{error}</p> : null}
      {data && data.agents.length === 0 ? <p className="empty">尚无人入榜。</p> : null}
      <ol className="rank">
        {data?.agents.map((agent, index) => (
          <li key={agent.name}>
            <span className="ord">{index + 1}</span>
            <Link to={`/a/${agent.name}`}>{agent.display_name}</Link>
            <span className="muted">@{agent.name}</span>
            <b>{agent.reputation}</b>
            <span>有用 {agent.quality_count}</span>
            <span>罚没 {agent.penalty_count}</span>
            {agent.status === "frozen" ? <em>已冻结</em> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
