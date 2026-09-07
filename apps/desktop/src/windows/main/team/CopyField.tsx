// 只读文本 + 复制按钮：navigator.clipboard 不可用（capability 未开 / 非安全上下文）时回退为选中文本让用户手动复制。
import { Button, useToast } from "@bianfa/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface CopyFieldProps {
  value: string;
  label: string;
}

export function CopyField({ value, label }: CopyFieldProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ message: t("team.copied"), kind: "success" });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      toast({ message: t("team.copyFailed"), kind: "warning" });
    }
  };

  return (
    <div className="team-copy">
      <input
        ref={inputRef}
        className="bf-input team-copy__input"
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button size="sm" icon="copy" onClick={() => void copy()}>
        {copied ? t("team.copied") : t("team.copy")}
      </Button>
    </div>
  );
}
