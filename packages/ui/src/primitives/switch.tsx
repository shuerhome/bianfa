import { useId } from "react";
import { cx } from "../utils/cx.js";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

/** track 32×18、knob 14、translateX(14px)（specs/06 §4.4） */
export function Switch({ checked, onChange, label, description, disabled, className }: SwitchProps) {
  const id = useId();
  const descId = useId();
  return (
    <div className={cx("bf-switch-row", className)}>
      <div className="bf-switch-row__text">
        <label htmlFor={id} className="bf-switch-row__label">
          {label}
        </label>
        {description ? (
          <p id={descId} className="bf-switch-row__desc">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        className="bf-switch"
        onClick={() => onChange(!checked)}
      >
        <span className="bf-switch__knob" aria-hidden="true" />
      </button>
    </div>
  );
}
