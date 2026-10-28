import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CirclePauseIcon,
  ClockIcon,
  Columns3Icon,
  ContactIcon,
  EllipsisIcon,
  FlagIcon,
  HashIcon,
  InboxIcon,
  InfoIcon,
  LayoutGridIcon,
  LayoutListIcon,
  ListFilterIcon,
  MailIcon,
  MapPinIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoonIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PhoneIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SunIcon,
  TagIcon,
  ToggleLeftIcon,
  Trash2Icon,
  TriangleAlertIcon,
  TypeIcon,
  UsersIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Every icon the app draws, by name.
 *
 * Lucide, for the same reason Productboard's set reads as one: outlined,
 * rounded ends, one line weight throughout. The list is closed on purpose —
 * a call site names an icon rather than importing one, so the set stays small
 * enough to keep consistent and nothing has to set a size or weight by hand.
 */
const ICONS = {
  alert: CircleAlertIcon,
  "arrow-down": ArrowDownIcon,
  "arrow-left": ArrowLeftIcon,
  "arrow-left-right": ArrowLeftRightIcon,
  "arrow-right": ArrowRightIcon,
  "arrow-up": ArrowUpIcon,
  "arrow-up-down": ArrowUpDownIcon,
  "arrow-up-right": ArrowUpRightIcon,
  "at-sign": AtSignIcon,
  calendar: CalendarIcon,
  check: CheckIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-up": ChevronUpIcon,
  "circle-dashed": CircleDashedIcon,
  "circle-dot": CircleDotIcon,
  clock: ClockIcon,
  columns: Columns3Icon,
  contact: ContactIcon,
  ellipsis: EllipsisIcon,
  flag: FlagIcon,
  hash: HashIcon,
  inbox: InboxIcon,
  info: InfoIcon,
  "layout-grid": LayoutGridIcon,
  "layout-list": LayoutListIcon,
  "list-filter": ListFilterIcon,
  mail: MailIcon,
  "map-pin": MapPinIcon,
  maximize: Maximize2Icon,
  minimize: Minimize2Icon,
  moon: MoonIcon,
  panels: PanelsTopLeftIcon,
  pause: CirclePauseIcon,
  pencil: PencilIcon,
  phone: PhoneIcon,
  plug: PlugIcon,
  plus: PlusIcon,
  refresh: RefreshCwIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  sliders: SlidersHorizontalIcon,
  sparkle: SparkleIcon,
  sun: SunIcon,
  tag: TagIcon,
  toggle: ToggleLeftIcon,
  trash: Trash2Icon,
  type: TypeIcon,
  users: UsersIcon,
  warning: TriangleAlertIcon,
  workflow: WorkflowIcon,
  x: XIcon,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * One icon, in Dash's line.
 *
 * 16px in buttons, menus and the nav; 14px beside small text; 20px for an
 * empty state. `absoluteStrokeWidth` keeps the line at 1.5px whatever the
 * size, which is what keeps a 14px icon from looking bolder than a 20px one.
 * The colour is the text's around it, and the icon is always decoration: the
 * button it sits in carries the label.
 */
export const Icon = ({
  name,
  size = 16,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}): JSX.Element => {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      aria-hidden="true"
      focusable="false"
      className={className ? `dash-icon ${className}` : "dash-icon"}
    />
  );
};
