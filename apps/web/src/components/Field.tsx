// 表单字段：label + input + 错误行（aria-invalid / aria-describedby），高度 --h-ctl-lg
import { cx } from "@bianfa/ui";
import { type InputHTMLAttributes, useId } from "react";

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> {
  label: string;
  error?: string | null | undefined;
  hint?: string | undefined;
  inputClassName?: string;
}

export function Field({ label, error, hint, inputClassName, ...rest }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="web-field">
      <label className="web-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={cx("bf-input", "web-input", inputClassName)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? (
        <span id={hintId} className="web-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="web-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
