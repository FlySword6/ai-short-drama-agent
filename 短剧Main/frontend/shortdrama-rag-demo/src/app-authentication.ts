import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";
import { loginEntryPathFor, navigate, routePath } from "./routing";
import type { User as UserType } from "./types";
import type { WecomCallback } from "./pages/login-card";

export const DEMO_SESSION_KEY = "shortdrama_v01_demo";

/**
 * App 的认证启动状态。startupWecomCallback 必须在 React 根渲染前捕获，确保
 * StrictMode 重放不会二次读取已被清除的 fragment，也确保 callback 优先于旧 session。
 */
export function useAppAuthentication(
  startupWecomCallback: WecomCallback | null,
  demoUser: UserType,
): {
  wecomCallback: WecomCallback | null;
  markWecomCallbackHandled: () => void;
  user: UserType | null;
  setUser: Dispatch<SetStateAction<UserType | null>>;
  demoMode: boolean;
  setDemoMode: Dispatch<SetStateAction<boolean>>;
  booting: boolean;
  handleAuthenticated: (user: UserType) => void;
} {
  const callbackAtStartup = useRef(startupWecomCallback !== null).current;
  const [wecomCallback, setWecomCallback] = useState(startupWecomCallback);
  const [user, setUser] = useState<UserType | null>(() => (
    callbackAtStartup ? null : window.sessionStorage.getItem(DEMO_SESSION_KEY) === "1" ? demoUser : null
  ));
  const [demoMode, setDemoMode] = useState(() => (
    !callbackAtStartup && window.sessionStorage.getItem(DEMO_SESSION_KEY) === "1"
  ));
  const [booting, setBooting] = useState(() => (
    !callbackAtStartup && Boolean(api.getToken()) && window.sessionStorage.getItem(DEMO_SESSION_KEY) !== "1"
  ));

  useEffect(() => {
    // OAuth callback 是一次性凭据：无论旧 token 是否有效，都不得先恢复旧 session。
    if (callbackAtStartup) {
      setUser(null);
      setBooting(false);
      return;
    }
    if (demoMode) {
      setUser(demoUser);
      setBooting(false);
      return;
    }
    if (!api.getToken()) {
      setUser(null);
      setBooting(false);
      const pathname = window.location.pathname;
      if (pathname !== "/login" && pathname !== "/landing" && pathname !== "/") {
        navigate(loginEntryPathFor(routePath()), { replace: true });
      }
      return;
    }
    let active = true;
    setBooting(true);
    void api.me().then((currentUser) => {
      if (active) setUser(currentUser);
    }).catch(() => {
      api.setToken(null);
      if (active) {
        setUser(null);
        navigate(loginEntryPathFor(routePath()), { replace: true });
      }
    }).finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [callbackAtStartup, demoMode, demoUser]);

  const markWecomCallbackHandled = useCallback(() => setWecomCallback(null), []);
  const handleAuthenticated = useCallback((nextUser: UserType) => {
    window.sessionStorage.removeItem(DEMO_SESSION_KEY);
    setDemoMode(false);
    setUser(nextUser);
  }, []);

  return {
    wecomCallback,
    markWecomCallbackHandled,
    user,
    setUser,
    demoMode,
    setDemoMode,
    booting,
    handleAuthenticated,
  };
}
