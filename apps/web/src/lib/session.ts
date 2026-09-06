// 需要登录的页面：无会话 → 跳 /login?next=<当前页>（replace）。会话来自 authClient.useSession（cookie，同源）。
import { useEffect } from "react";
import { authClient } from "../auth-client.js";
import { navigate } from "../router.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export function useSession(): { user: SessionUser | null; pending: boolean; refetch: () => Promise<void> } {
  const { data, isPending, refetch } = authClient.useSession();
  const u = data?.user;
  return {
    user: u ? { id: u.id, email: u.email, name: u.name, emailVerified: Boolean(u.emailVerified) } : null,
    pending: isPending,
    refetch: () => refetch(),
  };
}

export function loginPath(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

export function useRequireSession(next: string): { user: SessionUser | null; pending: boolean } {
  const { user, pending } = useSession();
  useEffect(() => {
    if (!pending && !user) navigate(loginPath(next), { replace: true });
  }, [pending, user, next]);
  return { user, pending };
}
