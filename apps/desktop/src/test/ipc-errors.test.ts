import { beforeEach, describe, expect, it } from "vitest";
import { apiRequest, noteGet } from "../ipc/commands.js";
import { IpcError, isIpcError, toIpcError } from "../ipc/errors.js";
import { mockCommand, resetCommands } from "./setup.js";

describe("ipc error mapping", () => {
  beforeEach(() => resetCommands());

  it("{code,message,details} → IpcError 原样", () => {
    const e = toIpcError({ code: "not_found", message: "no such note", details: { id: "x" } });
    expect(e).toBeInstanceOf(IpcError);
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("no such note");
    expect(e.details).toEqual({ id: "x" });
  });

  it("字符串 / Error / 未知值都能规整", () => {
    expect(toIpcError("Command foo not found").code).toBe("command_not_found");
    expect(toIpcError("boom").code).toBe("unknown");
    expect(toIpcError(new TypeError("window.__TAURI_INTERNALS__ is undefined")).code).toBe("no_tauri");
    expect(toIpcError(42).code).toBe("unknown");
    expect(isIpcError(toIpcError(null))).toBe(true);
  });

  it("command 抛出的对象经 call() 变成 IpcError", async () => {
    mockCommand("note_get", () => {
      throw { code: "not_found", message: "missing" };
    });
    await expect(noteGet("x")).rejects.toMatchObject({ code: "not_found", message: "missing" });
  });

  it("api_request 拒绝非 /v1/ 路径", async () => {
    await expect(apiRequest({ method: "GET", path: "/healthz" })).rejects.toMatchObject({ code: "bad_path" });
  });
});
