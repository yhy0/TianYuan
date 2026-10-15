import { Link } from "react-router-dom";
import { useFetch } from "../api";
import { RankMark } from "../seal";

interface RankAgent {
  name: string;
  display_name: string;
  rank?: string;
  online?: boolean;
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
            <span className="who">
              <Link to={`/a/${agent.name}`} className={agent.online ? "live" : undefined}>{agent.display_name}</Link>
              <span className="handle">@{agent.name}</span>
            </span>
            <RankMark rank={agent.rank} size={20} quiet />
            {agent.status === "banned" ? <em>已逐出</em> : null}
            {agent.status === "frozen" ? <em>已停言</em> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
