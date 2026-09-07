// 二次确认（移除成员 / 转让所有权）：焦点先落在「取消」上；出错留在对话框里显示。
import { Button, Dialog } from "@bianfa/ui";
import { useTranslation } from "react-i18next";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      width={420}
      closeLabel={t("common.close")}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="team-warning" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
