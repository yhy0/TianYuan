import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const TOKEN_KEY = "tianyuan-token";
const LEGACY_KEY = "tianyuan-steward";

export interface SessionUser {
  name: string;
  display_name: string;
  rank: string;
  credits: number;
  staked: number;
  credits_earned: number;
  status: string;
  credits_locked: number;
  online?: boolean;
}

export interface InviteUser {
  id: string;
  code: string;
  created_at: number;
  agent_name: string;
  agent_display: string;
}

export interface SessionInvite {
  code: string;
  max_uses: number;
  used_count: number;
  note: string;
  frozen: number;
  created_at: number;
  issuer_name: string | null;
  users: InviteUser[];
}

export interface SessionAgent {
  name: string;
  display_name: string;
  credits: number;
  staked: number;
  credits_earned: number;
  rank?: string;
  online?: boolean;
  status: string;
  credits_locked: number;
}

export interface SessionData {
  role: "steward" | "deputy" | "agent";
  offices?: { name: string; display_name: string; role: "siming" | "shaosiming" }[];
  agent: SessionUser;
  invites: SessionInvite[];
  agents: SessionAgent[];
}

interface SessionContextValue {
  token: string;
  session: SessionData | null;
  loading: boolean;
  error: string;
  login: (token: string) => Promise<boolean>;
  logout: () => void;
  refresh: () => Promise<boolean>;
  call: (path: string, method: string, body?: unknown) => Promise<unknown>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function savedToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(LEGACY_KEY) || "";
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (current: string) => {
    if (!current) {
      setSession(null);
      setLoading(false);
      return false;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/account/session", { headers: { Authorization: `Bearer ${current}` } });
      const data = (await response.json()) as SessionData & { error?: string };
      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem(TOKEN_KEY);
          sessionStorage.removeItem(LEGACY_KEY);
          setToken("");
        }
        throw new Error(data.error || "登录失败");
      }
      sessionStorage.setItem(TOKEN_KEY, current);
      setToken(current);
      setSession(data);
      return true;
    } catch (reason) {
      setSession(null);
      setError(reason instanceof Error ? reason.message : "登录失败");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const next = savedToken();
    setToken(next);
    void load(next);
  }, [load]);

  const login = useCallback(async (next: string) => load(next.trim()), [load]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_KEY);
    setToken("");
    setSession(null);
    setError("");
  }, []);

  const call = useCallback(async (path: string, method: string, body?: unknown) => {
    const response = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败");
    return data;
  }, [token]);

  const value = useMemo(() => ({ token, session, loading, error, login, logout, refresh: () => load(token), call }), [token, session, loading, error, login, logout, load, call]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("登录状态还没有接上。");
  return value;
}
