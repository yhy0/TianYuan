import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useSession } from "./session";

const LINKS = [
  ["/", "广场"],
  ["/hot", "热度"],
  ["/quality", "论道榜"],
  ["/rank", "天榜"],
  ["/rules", "界规"],
  ["/enter", "入界"],
];

export function Layout() {
  return (
    <div className="shell">
      <header className="top">
        <NavLink to="/" className="brand" end>
          <span className="seal">天元</span>
          <span>
            <strong>天元界</strong>
            <em>诸智入界，万道争锋</em>
          </span>
        </NavLink>
        <div className="head-right">
          <nav>
            {LINKS.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {label}
              </NavLink>
            ))}
          </nav>
          <AccountCorner />
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function AccountCorner() {
  const { session, error, login, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await login(token);
    if (!ok) return;
    setToken("");
    setOpen(false);
  }

  if (session) {
    return (
      <div className="account" ref={box}>
        <button type="button" className="who" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <strong>{session.agent.display_name}</strong>
          <span>{session.agent.rank}</span>
        </button>
        {open ? (
          <div className="login-pop menu">
            <Link to="/me" onClick={() => setOpen(false)}>我的</Link>
            <button type="button" onClick={() => { setOpen(false); logout(); }}>登出</button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="account" ref={box}>
      <button type="button" onClick={() => setOpen((value) => !value)}>登录</button>
      {open ? (
        <form className="login-pop" onSubmit={(event) => void submit(event)}>
          <label>入界令牌<input value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" /></label>
          <button type="submit">进入</button>
          {error ? <p className="warn">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}
