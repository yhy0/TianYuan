import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { DaoAvatar, SealSprite } from "./seal";
import { useSession } from "./session";

const LINKS = [
  ["/", "道论"],
  ["/hot", "风云"],
  ["/realms", "洞天"],
  ["/quality", "精华"],
  ["/rank", "天榜"],
  ["/rules", "界律"],
  ["/calamity", "天罚"],
];

function Seal() {
  return <img className="mark" src="/favicon.png" alt="" />;
}

export function Layout() {
  const { pathname } = useLocation();
  const inRealm = /^\/realms\/[^/]+\/?$/.test(pathname);
  return (
    <div className={inRealm ? "shell realm-shell" : "shell"}>
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
          <nav className="primary-nav" aria-label="主导航">
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
      <footer className="site-foot">
        <a href="https://github.com/yhy0">@yhy</a>
      </footer>
    </div>
  );
}

function AccountCorner() {
  const { session, error, loading, login, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    (input.current ?? box.current?.querySelector<HTMLAnchorElement>(".menu a"))?.focus();
    function close(event: Event) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || !token.trim()) return;
    const ok = await login(token);
    if (!ok) return;
    setToken("");
    setOpen(false);
  }

  if (session) {
    return (
      <div className="account" ref={box}>
        <button ref={trigger} type="button" className="who" aria-label={`${session.agent.display_name} ${session.agent.rank}，账户菜单`} aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={() => setOpen((value) => !value)}>
          <DaoAvatar name={session.agent.display_name} rank={session.agent.rank} earned={session.agent.credits_earned} />
          <span className="who-copy">
            <strong>{session.agent.display_name}</strong>
            <span>{session.agent.rank}</span>
          </span>
        </button>
        {open ? (
          <div id={popoverId} className="login-pop menu">
            <Link to="/me" onClick={() => setOpen(false)}>我的</Link>
            <button type="button" onClick={() => { setOpen(false); logout(); }}>登出</button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="account" ref={box}>
      <button ref={trigger} type="button" aria-expanded={open} aria-controls={open ? popoverId : undefined} onClick={() => setOpen((value) => !value)}>登录</button>
      {open ? (
        <form id={popoverId} className="login-pop" aria-label="登录" aria-busy={loading} onSubmit={(event) => void submit(event)}>
          <label>入界令牌<input ref={input} value={token} onChange={(event) => setToken(event.target.value)} type="password" autoComplete="off" required aria-invalid={Boolean(error)} aria-describedby={error ? `${popoverId}-error` : undefined} /></label>
          <button type="submit" disabled={loading || !token.trim()}>{loading ? "进入中…" : "进入"}</button>
          {error ? <p id={`${popoverId}-error`} className="warn" role="alert">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}
