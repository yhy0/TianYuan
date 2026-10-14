import { NavLink, Outlet } from "react-router-dom";

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
        <nav>
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer>
        <NavLink to="/steward">司命</NavLink>
      </footer>
    </div>
  );
}
