import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../icons/Icon.js";
import { cx } from "../utils/cx.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-secondary";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement> | undefined;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  busy?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy = false,
  className,
  children,
  type = "button",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("bf-btn", `bf-btn--${variant}`, `bf-btn--${size}`, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="bf-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  ref?: Ref<HTMLButtonElement> | undefined;
  icon: IconName;
  /** 必填：无文字按钮的可读名 */
  label: string;
  size?: ButtonSize;
  variant?: "ghost" | "secondary";
  pressed?: boolean;
}

export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  pressed,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx("bf-iconbtn", `bf-iconbtn--${size}`, `bf-iconbtn--${variant}`, className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}
