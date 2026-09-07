// 设置 → 数据 → 数据位置：把便笺数据搬到别的盘（例如 Windows 上的 D:\）。
//
// 界面上刻意做了三件事，都是为了让「搬数据」这件危险操作不至于出事：
//   ① 选完目录先问服务端能不能用（云盘目录、嵌套目录、已有数据的目录一律先挡住），
//      而不是等用户点了「搬」再失败；
//   ② 搬完**明确告诉用户旧目录还在、要自己确认后再删** —— 后端刻意不删源，
//      宁可硬盘上多一份拷贝，也不能把唯一一份数据搬丢；
//   ③ 搬完必须重启：数据库连接已经关掉了，继续用这个进程只会到处报错。
import { Button, useToast } from "@bianfa/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type DataLocation,
  dataLocationCheck,
  dataLocationGet,
  dataLocationMove,
  pickDirectory,
} from "../../ipc/commands.js";

export function DataLocationPanel() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [info, setInfo] = useState<DataLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    void dataLocationGet()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const move = async (target: string | null) => {
    setBusy(true);
    try {
      if (target !== null) {
        const check = await dataLocationCheck(target);
        if (!check.ok) {
          toast({ message: check.reason ?? t("dataLocation.cannotUse"), kind: "danger" });
          return;
        }
      }
      const r = await dataLocationMove(target);
      setMoved({ from: r.from, to: r.to });
      setInfo(await dataLocationGet().catch(() => info));
    } catch (e) {
      toast({ message: `${t("dataLocation.moveFailed")}: ${(e as Error).message}`, kind: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const { path } = await pickDirectory({ title: t("dataLocation.pickTitle") });
    if (path) await move(path);
  };

  if (!info) return null;

  // 搬完之后整个面板换成一条「去重启」的提示：这时数据库已经关了，其它按钮点了也只会报错
  if (moved) {
    return (
      <div className="settings-notice settings-notice--warn" role="status">
        <p>{t("dataLocation.movedTo").replace("{{path}}", moved.to)}</p>
        <p>{t("dataLocation.restartNow")}</p>
        <p className="settings-hint">{t("dataLocation.oldKept").replace("{{path}}", moved.from)}</p>
      </div>
    );
  }

  return (
    <>
      <p className="settings-path" title={info.current}>
        {info.current}
      </p>
      {info.inCloudFolder ? (
        <p className="settings-hint settings-hint--warn">{t("dataLocation.cloudWarning")}</p>
      ) : null}
      <div className="settings-row">
        <Button icon="folder-open" busy={busy} onClick={() => void choose()}>
          {t("dataLocation.change")}
        </Button>
        {info.isCustom ? (
          <Button variant="ghost" busy={busy} onClick={() => void move(null)}>
            {t("dataLocation.resetToDefault")}
          </Button>
        ) : null}
      </div>
      <p className="settings-hint">{t("dataLocation.hint")}</p>
    </>
  );
}
