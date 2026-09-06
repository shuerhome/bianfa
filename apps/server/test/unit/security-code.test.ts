// 单测：安全码规则（trim、4–32、≠ 密码）与 create.before 的哈希替换（明文不进落库数据）。
import { describe, expect, it } from "vitest";
import {
  hashSecurityCodeForCreate,
  normalizeSecurityCode,
  SECURITY_CODE_MAX,
  SECURITY_CODE_MIN,
  securityCodeProblem,
  securityCodeSchema,
} from "../../src/auth/security-code.js";
import { hashPassword, verifyPassword } from "../../src/security/argon2.js";

describe("securityCodeProblem", () => {
  it("缺失 / 空白 → required；短 / 长；与密码相同", () => {
    expect(securityCodeProblem(undefined, "pw")).toBe("required");
    expect(securityCodeProblem(42, "pw")).toBe("required");
    expect(securityCodeProblem("   ", "pw")).toBe("required");
    expect(securityCodeProblem(" abc ", "pw")).toBe("short");
    expect(securityCodeProblem("x".repeat(SECURITY_CODE_MAX + 1), "pw")).toBe("long");
    expect(securityCodeProblem("hunter22", "hunter22")).toBe("equals_password");
    expect(securityCodeProblem(" hunter22 ", "hunter22")).toBe("equals_password");
    expect(securityCodeProblem("我的小狗叫 Bobo", "hunter22")).toBeNull();
    expect(securityCodeProblem("a".repeat(SECURITY_CODE_MIN), null)).toBeNull();
  });

  it("normalize 只去首尾空白；zod schema 同规则", () => {
    expect(normalizeSecurityCode("  a b  ")).toBe("a b");
    expect(securityCodeSchema.parse("  abcd  ")).toBe("abcd");
    expect(securityCodeSchema.safeParse(" ab ").success).toBe(false);
    expect(securityCodeSchema.safeParse("x".repeat(33)).success).toBe(false);
  });
});

describe("hashSecurityCodeForCreate", () => {
  const hasher = { hash: hashPassword, verify: verifyPassword };

  it("明文 → securityCode: undefined + hash + set_at；hash 可验证 trim 后的码", async () => {
    const out = await hashSecurityCodeForCreate(
      { name: "A", email: "a@x.invalid", securityCode: "  my code 1  " },
      hasher,
    );
    expect("securityCode" in out.data).toBe(true);
    expect(out.data.securityCode).toBeUndefined();
    expect(String(out.data.securityCodeHash)).toMatch(/^\$argon2id\$/);
    expect(out.data.securityCodeSetAt).toBeInstanceOf(Date);
    expect(JSON.stringify(out.data)).not.toContain("my code 1");
    expect(await verifyPassword({ hash: String(out.data.securityCodeHash), password: "my code 1" })).toBe(
      true,
    );
    expect(await verifyPassword({ hash: String(out.data.securityCodeHash), password: "  my code 1  " })).toBe(
      false,
    );
  });

  it("没有安全码（社交登录）→ 只清掉字段，不写 hash", async () => {
    const out = await hashSecurityCodeForCreate({ name: "A", email: "a@x.invalid" }, hasher);
    expect(out.data).toEqual({ securityCode: undefined });
    const blank = await hashSecurityCodeForCreate({ securityCode: "   " }, hasher);
    expect(blank.data).toEqual({ securityCode: undefined });
  });
});
