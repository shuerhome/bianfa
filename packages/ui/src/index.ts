// @bianfa/ui —— 无头 UI 原语 + Lucide sprite。样式：`@import "@bianfa/ui/ui.css"`；Tailwind 别名：`@import "@bianfa/ui/theme.css"`。
export { type AnchoredStyle, type Placement, useAnchored } from "./hooks/use-anchored.js";
export {
  ensureIconSprite,
  ICON_NAMES,
  ICON_PATHS,
  Icon,
  type IconName,
  type IconProps,
} from "./icons/Icon.js";
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  IconButton,
  type IconButtonProps,
} from "./primitives/button.js";
export { Dialog, type DialogProps } from "./primitives/dialog.js";
export { Menu, MenuItem, type MenuItemProps, type MenuProps, MenuSeparator } from "./primitives/menu.js";
export { Popover, type PopoverProps } from "./primitives/popover.js";
export { Select, type SelectOption, type SelectProps } from "./primitives/select.js";
export { Switch, type SwitchProps } from "./primitives/switch.js";
export { type TabItem, TabPanel, type TabPanelProps, Tabs, type TabsProps } from "./primitives/tabs.js";
export { type ToastOptions, ToastProvider, useToast } from "./primitives/toast.js";
export { Tooltip, type TooltipProps } from "./primitives/tooltip.js";
export { cx } from "./utils/cx.js";
