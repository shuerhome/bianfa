import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { AppError, errors, mapError } from "../../src/http/errors.js";

describe("error mapper（规格 04 §5.3）", () => {
  it("401 unauthorized 附 WWW-Authenticate", () => {
    const m = mapError(errors.unauthorized());
    expect(m.status).toBe(401);
    expect(m.body).toEqual({ error: "unauthorized" });
    expect(m.headers["WWW-Authenticate"]).toBe('Bearer error="invalid_token"');
  });

  it("403 insufficient_permission 带 required 与审计上下文", () => {
    const e = errors.insufficientPermission("editor", { orgId: "org1", targetType: "note", targetId: "n1" });
    const m = mapError(e);
    expect(m.status).toBe(403);
    expect(m.body).toEqual({ error: "insufficient_permission", required: "editor" });
    expect(e.denied).toMatchObject({ orgId: "org1", targetType: "note", targetId: "n1", required: "editor" });
  });

  it("403 insufficient_role 的 required 是 {resource, action}", () => {
    const m = mapError(errors.insufficientRole({ resource: "workspace", action: "create" }));
    expect(m.body).toEqual({
      error: "insufficient_role",
      required: { resource: "workspace", action: "create" },
    });
  });

  it("404 / 400 / 409 / 410 / 429 / 503", () => {
    expect(mapError(errors.notFound()).status).toBe(404);
    expect(mapError(errors.noActiveOrganization())).toMatchObject({
      status: 400,
      body: { error: "no_active_organization" },
    });
    expect(mapError(errors.conflict("vault_not_shareable"))).toMatchObject({
      status: 409,
      body: { error: "vault_not_shareable" },
    });
    expect(mapError(errors.gone()).status).toBe(410);
    const rl = mapError(errors.rateLimited(7));
    expect(rl.status).toBe(429);
    expect(rl.headers["Retry-After"]).toBe("7");
    expect(mapError(errors.serviceUnavailable("attachments_disabled"))).toMatchObject({
      status: 503,
      body: { error: "attachments_disabled" },
    });
  });

  it("HTTPException 与未知异常：不泄漏细节", () => {
    expect(mapError(new HTTPException(413))).toMatchObject({
      status: 413,
      body: { error: "payload_too_large" },
    });
    expect(mapError(new HTTPException(401)).headers["WWW-Authenticate"]).toBeDefined();
    expect(mapError(new Error("secret db password"))).toEqual({
      status: 500,
      body: { error: "internal_error" },
      headers: {},
    });
    expect(mapError(new SyntaxError("Unexpected token"))).toMatchObject({
      status: 400,
      body: { error: "invalid_json" },
    });
  });

  it("AppError 保留 cause", () => {
    const cause = new Error("root");
    const e = new AppError(500, "x", {}, { cause });
    expect(e.cause).toBe(cause);
  });
});
