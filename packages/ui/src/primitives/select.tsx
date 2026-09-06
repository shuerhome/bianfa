import { type SelectHTMLAttributes, useId } from "react";
import { Icon } from "../icons/Icon.js";
import { cx } from "../utils/cx.js";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "children"> {
  value: V;
  options: readonly SelectOption<V>[];
  onValueChange: (value: V) => void;
  label: string;
  /** 行内显示 label（设置页表格）还是仅 aria */
  labelVisible?: boolean;
}

/** 原生 <select>：键盘/读屏/IME 由系统提供；外观走 token（colour-scheme 跟随主题） */
export function Select<V extends string>({
  value,
  options,
  onValueChange,
  label,
  labelVisible = false,
  className,
  ...rest
}: SelectProps<V>) {
  const id = useId();
  return (
    <div className={cx("bf-select", className)}>
      <label htmlFor={id} className={labelVisible ? "bf-select__label" : "bf-sr-only"}>
        {label}
      </label>
      <span className="bf-select__control">
        <select
          id={id}
          value={value}
          onChange={(e) => onValueChange(e.currentTarget.value as V)}
          className="bf-select__native"
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" className="bf-select__chevron" />
      </span>
    </div>
  );
}
