import { Link, useSearchParams } from "react-router-dom";
import { useFetch, usePagedPosts, type ChannelInfo, type PostCard } from "../api";
import { formatTime, postStatus } from "../format";
import { RankMark } from "../seal";

const BOARDS = {
  latest: "观界",
  hot: "风云",
  quality: "精华",
} as const;

const CHANNELS = [
  ["", "全部"],
  ["lundao", "论道"],
  ["wenjin", "问津"],
  ["jishi", "纪事"],
  ["xuanbang", "悬榜"],
  ["shidao", "试道"],
];

export function Plaza({ board }: { board: keyof typeof BOARDS }) {
  const [params, setParams] = useSearchParams();
  const channel = params.get("channel") ?? "";
  const query = new URLSearchParams({ board });
  if (channel) query.set("channel", channel);
  const firstUrl = `/api/feed?${query.toString()}`;
  const { data, error, loading } = useFetch<{ posts: PostCard[]; next_cursor: string | null }>(firstUrl);
  const catalog = useFetch<{ channels: ChannelInfo[] }>(board === "latest" ? "/api/rules" : null);
  const blurb = catalog.data?.channels.find((item) => item.slug === channel)?.description;
  const page = usePagedPosts(`${board}:${channel}`, data);

  return (
    <section className="feed-page">
      <div className="hero">
        <p className="eyebrow">天元界</p>
        <h1>{BOARDS[board]}</h1>
      </div>
      {board === "latest" ? (
        <div className="chips">
          {CHANNELS.filter(([slug]) => slug !== "shidao").map(([slug, name]) => (
            <button key={slug || "all"} className={channel === slug ? "chip on" : "chip"} onClick={() => setParams(slug ? { channel: slug } : {})} type="button">
              {name}
            </button>
          ))}
          <button className={channel === "shidao" ? "chip trial on" : "chip trial"} onClick={() => setParams({ channel: "shidao" })} type="button">
            试道<span>· 免费参与</span>
          </button>
        </div>
      ) : null}
      {blurb ? <p className="muted channel-note">{blurb}</p> : null}
      {loading ? <p className="muted">读取中</p> : null}
      {error ? <p className="warn">{error}</p> : null}
      {data && page.posts.length === 0 ? <p className="empty">尚无内容。</p> : null}
      <div className="list">
        {page.posts.map((post) => (
          <article key={post.id} className="card">
            <div className="meta">
              <span>{channelName(post.channel)}</span>
              <span>{post.kind_label}</span>
              <span>{formatTime(post.created_at)}</span>
            </div>
            <h2>
              <Link to={`/p/${post.id}`}>{post.title}</Link>
            </h2>
            <p className="by">
              <Link to={`/a/${post.author.name}`} className={post.author.online ? "live" : undefined}>{post.author.display_name}</Link>
              <RankMark rank={post.author.rank} size={20} />
            </p>
            <p className="foot">
              <span>{postStatus(post)}</span>
              <span>评注 {post.reply_count}</span>
              <span>赞同 {post.signal_up}</span>
              <span>驳道 {post.signal_down}</span>
              {post.bounty_locked > 0 ? <span>悬榜 {post.bounty_locked}</span> : null}
            </p>
          </article>
        ))}
      </div>
      {page.pageError ? <p className="warn">{page.pageError}</p> : null}
      {page.cursor ? (
        <button className="more" type="button" disabled={page.paging} onClick={() => void page.loadMore(`${firstUrl}&cursor=${encodeURIComponent(page.cursor ?? "")}`)}>
          {page.paging ? "读取中" : "更多"}
        </button>
      ) : null}
    </section>
  );
}

function channelName(slug: string): string {
  return CHANNELS.find(([id]) => id === slug)?.[1] ?? slug;
}
