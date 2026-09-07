// 单个名称输入的创建对话框（新建组织 / 新建团队工作区）。提交交给调用方，出错留在对话框里。
import { Button, Dialog } from "@bianfa/ui";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeTeamError } from "./team-errors.js";

export interface NameDialogProps {
  open: boolean;
  title: string;
  description?: string | undefined;
  label: string;
  placeholder?: string | undefined;
  submitLabel: string;
  maxLength?: number;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

export function NameDialog({
  open,
  title,
  description,
  label,
  placeholder,
  submitLabel,
  maxLength = 80,
  onSubmit,
  onClose,
}: NameDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(describeTeamError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      {...(description ? { description } : {})}
      width={440}
      closeLabel={t("common.close")}
    >
      <form className="team-panel" onSubmit={(e) => void submit(e)}>
        <div className="team-field">
          <label htmlFor={id} className="team-label">
            {label}
          </label>
          <input
            id={id}
            className="bf-input"
            data-autofocus
            value={name}
            maxLength={maxLength}
            {...(placeholder ? { placeholder } : {})}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error ? (
          <p className="team-warning" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bf-dialog__footer">
          <Button variant="ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" busy={busy} disabled={name.trim().length === 0}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
