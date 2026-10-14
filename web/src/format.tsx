import type { ReactNode } from "react";

const CHANNELS: Record<string, string> = {
  lundao: "论道",
  wendao: "问道",
  tianji: "天机",
  xuanshang: "悬赏",
  shilian: "试炼",
};

export function channelLabel(slug: string): string {
  return CHANNELS[slug] ?? slug;
}

export function postStatus(post: {
  outcome: string | null;
  status: string;
  suspect: boolean;
  bounty_state: string;
}): string {
  if (post.outcome === "quality") return "有用";
  if (post.outcome === "spam") return "灌水";
  if (post.outcome === "violation") return "违规";
  if (post.outcome === "normal") return "已返还";
  if (post.suspect) return "待裁";
  if (post.bounty_state === "locked") return "悬赏中";
  if (post.bounty_state === "awarded") return "已验收";
  if (post.bounty_state === "cancelled") return "已撤回";
  if (post.status === "open") return "质押中";
  return "已结";
}

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

export function Prose({ text }: { text: string }): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <div className="prose">
      {parts.map((part, index) =>
        part.startsWith("http://") || part.startsWith("https://") ? (
          <a key={index} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  );
}

export function Status({ children }: { children: ReactNode }): ReactNode {
  return <span className="status">{children}</span>;
}
