// 三态/四档分段控件：真正的 <input type="radio">（键盘 ←→、读屏原生），外观走 .segmented__item
import { useId } from "react";

export interface SegmentedProps<V extends string | number> {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  tabular?: boolean;
}

export function Segmented<V extends string | number>({
  label,
  value,
  options,
  onChange,
  tabular,
}: SegmentedProps<V>) {
  const name = useId();
  return (
    <fieldset className="segmented" aria-label={label}>
      {options.map((o) => (
        <label key={String(o.value)} className={tabular ? "segmented__item tabular" : "segmented__item"}>
          <input
            type="radio"
            name={name}
            className="bf-sr-only"
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
