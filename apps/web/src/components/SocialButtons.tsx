// Google / Apple 登录按钮：只在 /web-config.json 声明了 provider 时渲染；点击后整页跳转到 provider（系统浏览器内）
import { Button } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { leaveTo } from "../lib/external.js";

export type Provider = "google" | "apple";

export function SocialButtons({
  providers,
  callbackURL,
  onError,
}: {
  providers: readonly Provider[];
  callbackURL: string;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<Provider | null>(null);
  if (providers.length === 0) return null;

  async function start(provider: Provider) {
    setBusy(provider);
    try {
      // disableRedirect: 服务端只返回 { url }，由页面自己跳转（便于处理错误）；oauth_query 由 fetch 插件附带
      const res = await authClient.signIn.social({
        provider,
        callbackURL,
        errorCallbackURL: "/login?error=social",
        disableRedirect: true,
      });
      if (res.error) {
        onError(describeFailure(toFailure(res.error)));
        setBusy(null);
        return;
      }
      const url = res.data?.url;
      if (typeof url === "string" && url) leaveTo(url);
      else {
        onError(t("errors.generic"));
        setBusy(null);
      }
    } catch (err) {
      onError(describeFailure(toFailure(err)));
      setBusy(null);
    }
  }

  return (
    <div className="web-social">
      <div className="web-divider" aria-hidden="true">
        {t("login.or")}
      </div>
      {providers.map((p) => (
        <Button
          key={p}
          size="lg"
          className="web-btn-block"
          busy={busy === p}
          disabled={busy !== null}
          onClick={() => void start(p)}
        >
          {t(p === "google" ? "login.withGoogle" : "login.withApple")}
        </Button>
      ))}
    </div>
  );
}
