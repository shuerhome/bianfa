// 邮件模板（规格 04 §1.6）：中英双语，纯文本 + 简单 HTML；正文里绝不放 token 之外的秘密，链接一律 APP_ORIGIN 页面。
export type MailTemplate =
  | "verify_email"
  | "reset_password"
  | "invite"
  | "security_alert"
  | "invite_accepted"
  | "account_deletion_scheduled"
  | "email_changed";

export type MailVars = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function str(vars: MailVars, key: string, fallback = ""): string {
  const v = vars[key];
  if (v === undefined) return fallback;
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function list(vars: MailVars, key: string): string[] {
  const v = vars[key];
  return Array.isArray(v) ? [...v] : [];
}

interface Section {
  zh: string;
  en: string;
}

function layout(
  subject: string,
  paragraphs: Section[],
  link?: { url: string; zh: string; en: string },
): RenderedMail {
  const textLines: string[] = [];
  const htmlParts: string[] = [];
  for (const p of paragraphs) {
    textLines.push(p.zh, p.en, "");
    htmlParts.push(`<p>${esc(p.zh)}<br><span style="color:#666">${esc(p.en)}</span></p>`);
  }
  if (link) {
    textLines.push(`${link.zh} / ${link.en}`, link.url, "");
    htmlParts.push(
      `<p><a href="${esc(link.url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">${esc(link.zh)} / ${esc(link.en)}</a></p><p style="font-size:12px;color:#888">${esc(link.url)}</p>`,
    );
  }
  textLines.push("— 便笺 bianfa");
  htmlParts.push('<p style="color:#888">— 便笺 bianfa</p>');
  return {
    subject,
    text: textLines.join("\n"),
    html: `<!doctype html><html lang="zh-CN"><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px;margin:0 auto;padding:24px">${htmlParts.join("")}</body></html>`,
  };
}

export function renderMail(template: MailTemplate, vars: MailVars): RenderedMail {
  const name = str(vars, "name", "");
  const greet: Section = { zh: `${name ? `${name}，` : ""}你好：`, en: `Hi${name ? ` ${name}` : ""},` };
  switch (template) {
    case "verify_email":
      return layout(
        "验证你的邮箱 · Verify your email — bianfa",
        [
          greet,
          {
            zh: "请在 15 分钟内点击下面的按钮完成邮箱验证；如果这不是你本人的操作，忽略本邮件即可。",
            en: "Please verify your email within 15 minutes using the button below. If you did not sign up, ignore this message.",
          },
        ],
        { url: str(vars, "url"), zh: "验证邮箱", en: "Verify email" },
      );
    case "reset_password":
      return layout(
        "重置密码 · Reset your password — bianfa",
        [
          greet,
          {
            zh: "我们收到了重置密码的请求，链接 30 分钟内有效。若不是你发起的，请忽略，密码不会被更改。",
            en: "We received a request to reset your password. The link is valid for 30 minutes. If you did not request this, ignore it — nothing changes.",
          },
        ],
        { url: str(vars, "url"), zh: "重置密码", en: "Reset password" },
      );
    case "invite": {
      const org = str(vars, "org_name");
      const inviter = str(vars, "inviter_name");
      const role = str(vars, "role", "member");
      return layout(
        `${inviter} 邀请你加入 ${org} · You're invited to ${org} — bianfa`,
        [
          greet,
          {
            zh: `${inviter} 邀请你以「${role}」身份加入组织「${org}」。邀请 48 小时内有效。`,
            en: `${inviter} invited you to join "${org}" as ${role}. The invitation expires in 48 hours.`,
          },
        ],
        { url: str(vars, "url"), zh: "查看邀请", en: "View invitation" },
      );
    }
    case "invite_accepted": {
      const org = str(vars, "org_name");
      const member = str(vars, "member_name");
      return layout(`${member} 已加入 ${org} · ${member} joined ${org} — bianfa`, [
        greet,
        {
          zh: `${member}（${str(vars, "member_email")}）已接受邀请，加入组织「${org}」。`,
          en: `${member} (${str(vars, "member_email")}) accepted the invitation and joined "${org}".`,
        },
      ]);
    }
    case "security_alert": {
      const reason = str(vars, "reason");
      const devices = list(vars, "devices");
      const sections: Section[] = [
        greet,
        {
          zh: `你的账号发生了安全相关变更：${reason}。以下设备的登录已被撤销，需要重新登录：`,
          en: `A security-relevant change happened on your account: ${reason}. The following devices were signed out and must sign in again:`,
        },
        {
          zh: devices.length ? devices.map((d) => `· ${d}`).join("\n") : "（没有其他设备）",
          en: devices.length ? "" : "(no other devices)",
        },
        {
          zh: "如果这不是你本人的操作，请立即重置密码并联系我们。",
          en: "If this wasn't you, reset your password immediately and contact us.",
        },
      ];
      return layout("安全提醒 · Security alert — bianfa", sections);
    }
    case "account_deletion_scheduled":
      return layout(
        "账号将在 30 天后删除 · Your account is scheduled for deletion — bianfa",
        [
          greet,
          {
            zh: `你的账号已安排在 ${str(vars, "due_at")} 删除。在此之前登录并取消即可保留账号与数据。`,
            en: `Your account is scheduled for deletion on ${str(vars, "due_at")}. Sign in and cancel before then to keep your account and data.`,
          },
        ],
        { url: str(vars, "url"), zh: "取消删除", en: "Cancel deletion" },
      );
    case "email_changed":
      return layout(
        "确认更换邮箱 · Confirm your new email — bianfa",
        [
          greet,
          {
            zh: `有人请求把账号邮箱改为 ${str(vars, "new_email")}。如果是你，请点击下面的按钮确认；否则请忽略并尽快改密。`,
            en: `A request was made to change the account email to ${str(vars, "new_email")}. If that was you, confirm below; otherwise ignore this and change your password.`,
          },
        ],
        { url: str(vars, "url"), zh: "确认更换", en: "Confirm change" },
      );
  }
}
