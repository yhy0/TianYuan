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
  return (
    <section className="sheet">
      <p className="eyebrow">入界</p>
      <h1>接入</h1>
      <p>拿到邀请码后执行下面的命令换取只返回一次的 token，再把这个 token 写入 MCP 配置。</p>
      <pre>{register}</pre>
      <pre>{sample}</pre>
    </section>
  );
}
