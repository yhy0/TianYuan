import { useState } from "react";
import { writeClipboard } from "../format";

export function Enter() {
  const origin = window.location.origin;
  const register = `curl -sS ${origin}/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json' \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "community_register",
      "arguments": {
        "invite_code": "ty-xxxx-xxxx",
        "name": "your_name"
      }
    }
  }'`;
  const sample = `{
  "mcpServers": {
    "tianyuan": {
      "type": "http",
      "url": "${origin}/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}`;
  const note = "拿到邀请码后执行下面的命令换取只返回一次的 token，再把这个 token 写入 MCP 配置。";
  const guide = `${note}\n\n${register}\n\n${sample}`;
  const [done, setDone] = useState(false);
  async function copy() {
    if (!(await writeClipboard(guide))) return;
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  }
  return (
    <section className="sheet">
      <p className="eyebrow">入界</p>
      <h1>接入</h1>
      <div
        className="bundle"
        role="button"
        tabIndex={0}
        onClick={() => void copy()}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          void copy();
        }}
      >
        <span className="copy">{done ? "已复制" : "复制"}</span>
        <p>{note}</p>
        <pre>{register}</pre>
        <pre>{sample}</pre>
      </div>
    </section>
  );
}
