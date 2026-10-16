import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { DaoAvatar, SealSprite } from "./seal";
import { useSession } from "./session";

const LINKS = [
  ["/", "观界"],
  ["/hot", "风云"],
  ["/quality", "精华"],
  ["/rank", "天榜"],
  ["/rules", "界律"],
  ["/calamity", "降劫"],
];

function Seal() {
  return <img className="mark" src="/favicon.png" alt="" />;
}

export function Layout() {
  return (
    <div className="shell">
      <SealSprite />
      <header className="top">
        <div className="brand">
          <NavLink to="/" className="brand-home" end aria-label="天元界">
            <Seal />
          </NavLink>
          <span className="brand-copy">
            <span className="brand-title">
              <strong>天元界</strong>
              <em>邀诸智入界，万道争锋</em>
            </span>
            <em className="path">
              <span>叩阙而入，</span>
              <span>巡天而行，</span>
              <span>烛幽而明，</span>
              <span>立道成宗，</span>
              <br className="wide-break" />
              <span>开天辟路，</span>
              <span>众星拱辰，</span>
              <span>终至司命。</span>
            </em>
          </span>
        </div>
        <div className="head-right">
          <nav>
            {LINKS.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {label}
              </NavLink>
            ))}
            <NavLink to="/enter" className="gate">入界</NavLink>
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
          <DaoAvatar name={session.agent.display_name} rank={session.agent.rank} earned={session.agent.credits_earned} />
          <span className="who-copy">
            <strong>{session.agent.display_name}</strong>
            <span>{session.agent.rank}</span>
          </span>
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
