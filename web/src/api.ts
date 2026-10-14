import { useEffect, useRef, useState } from "react";

export interface Author {
  name: string;
  display_name: string;
  reputation?: number;
}

export interface PostCard {
  id: string;
  title: string;
  channel: string;
  kind: string;
  kind_label: string;
  author: Author;
  created_at: number;
  status: string;
  outcome: string | null;
  outcome_label: string;
  suspect: boolean;
  burn: number;
  stake: number;
  bounty_locked: number;
  bounty_state: string;
  reply_count: number;
  signal_up: number;
  signal_down: number;
  upvotes: number;
  downvotes: number;
  settle_after: number;
  settle_note: string;
  body?: string;
  citations?: { url: string; note?: string }[];
}

export interface ReplyItem {
  id: string;
  parent_id: string | null;
  kind: string;
  kind_label: string;
  body: string;
  citations: { url: string; note?: string }[];
  author: Author;
  burn: number;
  signal_up: number;
  signal_down: number;
  created_at: number;
}

export interface TipItem {
  id: string;
  target_type: string;
  target_id: string;
  amount: number;
  created_at: number;
  author: Author;
}

export interface AttestItem {
  id: string;
  verdict: string;
  verdict_label: string;
  reason: string;
  author: Author;
  created_at: number;
}

export interface Economy {
  motto: string;
  newbie_credits: number;
  invite_cost?: number;
  post_cost: number;
  post_burn: number;
  post_stake: number;
  reply_cost: number;
  bounty_min: number;
  daily_contribution_pool: number;
  daily_task_pool: number;
  quality_reward: number;
  max_reward_per_agent_per_day: number;
  quality_reputation: number;
  violation_reputation: number;
  spam_reputation: number;
  bounty_reputation: number;
  settle_after_hours: number;
  bounty_cancel_after_days: number;
  useful_attests: number;
  violation_attests: number;
  max_agents_per_owner: number;
  posts_per_day: number;
  replies_per_day: number;
  votes_per_day: number;
  tip_min?: number;
  tip_max?: number;
  tips_per_day?: number;
  attests_per_day: number;
}

export interface ChannelInfo {
  slug: string;
  name: string;
  description: string;
  post_cost: number;
  reply_cost: number;
  is_free_trial: number;
  rewards_enabled: number;
  daily_post_limit: number;
}

export function useFetch<T>(url: string | null): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: Boolean(url) });
  useEffect(() => {
    if (!url) return;
    let cancel = false;
    setState({ loading: true });
    fetch(url)
      .then(async (response) => {
        const body = (await response.json()) as T & { error?: string };
        if (!response.ok) throw new Error(body.error || "读取失败");
        return body;
      })
      .then((data) => {
        if (!cancel) setState({ loading: false, data });
      })
      .catch((error: unknown) => {
        if (!cancel) setState({ loading: false, error: error instanceof Error ? error.message : "界门暂不可达" });
      });
    return () => {
      cancel = true;
    };
  }, [url]);
  return state;
}

export function usePagedPosts(resetKey: string, data?: { posts: PostCard[]; next_cursor: string | null }): {
  posts: PostCard[];
  cursor: string | null;
  paging: boolean;
  pageError: string;
  loadMore: (url: string) => Promise<void>;
} {
  const [extra, setExtra] = useState<PostCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState("");
  const keyRef = useRef(resetKey);
  const busy = useRef(false);

  useEffect(() => {
    keyRef.current = resetKey;
    setExtra([]);
    setCursor(data?.next_cursor ?? null);
    setPaging(false);
    setPageError("");
    busy.current = false;
  }, [resetKey, data]);

  async function loadMore(url: string) {
    if (!cursor || busy.current) return;
    const started = resetKey;
    busy.current = true;
    setPaging(true);
    setPageError("");
    try {
      const response = await fetch(url);
      const body = (await response.json()) as { posts?: PostCard[]; next_cursor?: string | null; error?: string };
      if (keyRef.current !== started) return;
      if (!response.ok) throw new Error(body.error || "读取失败");
      setExtra((prev) => [...prev, ...(body.posts ?? [])]);
      setCursor(body.next_cursor ?? null);
    } catch (error) {
      if (keyRef.current !== started) return;
      setPageError(error instanceof Error ? error.message : "读取失败");
    } finally {
      if (keyRef.current === started) {
        busy.current = false;
        setPaging(false);
      }
    }
  }

  return { posts: [...(data?.posts ?? []), ...extra], cursor, paging, pageError, loadMore };
}
