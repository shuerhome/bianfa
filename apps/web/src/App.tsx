// 路由分发；每页自己决定是否需要会话。/ → /account 或 /login。
import { Button } from "@bianfa/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, Shell } from "./components/Shell.js";
import { StateView } from "./components/StateView.js";
import { useSession } from "./lib/session.js";
import { Account } from "./pages/Account.js";
import { Consent } from "./pages/Consent.js";
import { Device } from "./pages/Device.js";
import { ForgotPassword } from "./pages/ForgotPassword.js";
import { Invite } from "./pages/Invite.js";
import { Login } from "./pages/Login.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { Signup } from "./pages/Signup.js";
import { VerifyEmail } from "./pages/VerifyEmail.js";
import { matchRoute, navigate, useLocation } from "./router.js";

function Home() {
  const { t } = useTranslation();
  const { user, pending } = useSession();
  useEffect(() => {
    if (pending) return;
    navigate(user ? "/account" : "/login", { replace: true });
  }, [pending, user]);
  return (
    <Card title="bianfa">
      <StateView kind="loading" title={t("common.loading")} />
    </Card>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <Card title={t("notFound.title")}>
      <StateView
        kind="error"
        title={t("notFound.body")}
        actions={
          <Button variant="primary" size="lg" onClick={() => navigate("/")}>
            {t("notFound.home")}
          </Button>
        }
      />
    </Card>
  );
}

export function App() {
  const location = useLocation();
  const route = matchRoute(location.pathname);
  let page: React.ReactNode;
  switch (route.name) {
    case "home":
      page = <Home />;
      break;
    case "login":
      page = <Login search={location.search} />;
      break;
    case "signup":
      page = <Signup search={location.search} />;
      break;
    case "forgot-password":
      page = <ForgotPassword search={location.search} />;
      break;
    case "reset-password":
      page = <ResetPassword search={location.search} />;
      break;
    case "verify-email":
      page = <VerifyEmail search={location.search} kind={route.kind} />;
      break;
    case "consent":
      page = <Consent search={location.search} />;
      break;
    case "device":
      page = <Device search={location.search} />;
      break;
    case "invite":
      page = <Invite token={route.token} />;
      break;
    case "account":
      page = <Account />;
      break;
    default:
      page = <NotFound />;
  }
  return <Shell>{page}</Shell>;
}
