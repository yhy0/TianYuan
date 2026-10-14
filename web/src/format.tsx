import { useState, type ReactNode } from "react";

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

type HeadingLevel = 1 | 2 | 3 | 4;

export interface ArticleHeading {
  id: string;
  level: 1 | 2 | 3;
  text: string;
}

type Block =
  | { type: "h"; level: HeadingLevel; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; start: number; items: string[] }
  | { type: "pre"; text: string }
  | { type: "quote"; text: string };

export function articleOutline(source: string): ArticleHeading[] {
  return parseBlocks(source).flatMap((block, index) => {
    if (block.type !== "h" || block.level === 4) return [];
    return [{ id: `h${index}`, level: block.level, text: plainHeading(block.text) }];
  });
}

export function Prose({ text, anchored = false }: { text: string; anchored?: boolean }): ReactNode {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className="prose">
      {blocks.map((block, index) => renderBlock(block, index, anchored))}
    </div>
  );
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "pre", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = Math.min(heading[1].length, 4) as HeadingLevel;
      blocks.push({ type: "h", level: depth, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    const ordered = /^(\d+)\.\s+/.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ol", start: Number(ordered[1]), items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index].trim() !== "" && !blockStart(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    const text = body.join("\n").trim();
    if (text) blocks.push({ type: "p", text });
  }
  return blocks;
}

function blockStart(line: string): boolean {
  return /^(#{1,6})\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^>\s?/.test(line) || line.trim().startsWith("```");
}

function renderBlock(block: Block, index: number, anchored: boolean): ReactNode {
  const key = `b${index}`;
  if (block.type === "h") {
    const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
    const id = anchored && block.level <= 3 ? `h${index}` : undefined;
    return <Tag key={key} id={id}>{rich(block.text, key)}</Tag>;
  }
  if (block.type === "ul") {
    return (
      <ul key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{rich(item, `${key}-${itemIndex}`)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "ol") {
    return (
      <ol key={key} start={block.start}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{rich(item, `${key}-${itemIndex}`)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "pre") return <pre key={key}><code>{block.text}</code></pre>;
  if (block.type === "quote") return <blockquote key={key}>{rich(block.text, key)}</blockquote>;
  return <p key={key}>{rich(block.text, key)}</p>;
}

function rich(text: string, keyBase: string): ReactNode[] {
  return text.split("\n").flatMap((line, index) => {
    const nodes = inlineNodes(line, `${keyBase}-${index}`);
    return index === 0 ? nodes : [<br key={`${keyBase}-br${index}`} />, ...nodes];
  });
}

function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let count = 0;
  while (rest.length > 0) {
    const marks = [rest.indexOf("`"), rest.indexOf("**"), rest.search(/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/), rest.search(/https?:\/\/\S+/)].filter((value) => value >= 0);
    if (marks.length === 0) {
      nodes.push(rest);
      break;
    }
    const at = Math.min(...marks);
    if (at > 0) nodes.push(rest.slice(0, at));
    rest = rest.slice(at);
    const key = `${keyBase}-${count}`;
    count += 1;
    if (rest.startsWith("`")) {
      const end = rest.indexOf("`", 1);
      if (end < 0) {
        nodes.push(rest);
        break;
      }
      nodes.push(<code key={key}>{rest.slice(1, end)}</code>);
      rest = rest.slice(end + 1);
      continue;
    }
    if (rest.startsWith("**")) {
      const end = rest.indexOf("**", 2);
      if (end < 0) {
        nodes.push(rest);
        break;
      }
      nodes.push(<strong key={key}>{inlineNodes(rest.slice(2, end), key)}</strong>);
      rest = rest.slice(end + 2);
      continue;
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : link[0]);
      rest = rest.slice(link[0].length);
      continue;
    }
    const bare = /^(https?:\/\/\S+)/.exec(rest);
    if (bare) {
      let url = bare[1];
      let tail = "";
      while (url.length > 0 && /[),.;:!?，。、；：）】》]/.test(url.at(-1) ?? "")) {
        tail = `${url.at(-1)}${tail}`;
        url = url.slice(0, -1);
      }
      const href = safeHref(url);
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="noreferrer">{url}</a> : url);
      rest = tail + rest.slice(bare[1].length);
      continue;
    }
    nodes.push(rest[0]);
    rest = rest.slice(1);
  }
  return nodes;
}

function plainHeading(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function CopyButton({ text }: { text: string }): ReactNode {
  const [done, setDone] = useState(false);
  async function copy() {
    if (!(await writeClipboard(text))) return;
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  }
  return (
    <button className="copy" type="button" onClick={() => void copy()}>
      {done ? "已复制" : "复制"}
    </button>
  );
}

export function Status({ children }: { children: ReactNode }): ReactNode {
  return <span className="status">{children}</span>;
}
