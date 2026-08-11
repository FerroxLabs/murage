import {
  MAUS_COLORS,
  type MausColor,
  type MausExpression,
} from "@/lib/mascot";

// Exact SupaMaus mascot silhouette from the website's
// components/v2/MascotSlot.js. The geometry and tilt remain faithful to that
// source; app avatars use a larger borderless flat fill.
const BODY =
  "M93.4 40.6 L43 151.1 Q38 162 48.4 156 L91.4 131 Q100 126 108.7 131 L151.6 156 Q162 162 157 151.1 L106.6 40.6 Q100 26 93.4 40.6 Z";

const INK = "#10201b";

function PillEye({
  cx,
  cy = 88,
  width = 7,
  height = 18,
  angle = -12,
}: {
  cx: number;
  cy?: number;
  width?: number;
  height?: number;
  angle?: number;
}) {
  return (
    <rect
      x={cx - width / 2}
      y={cy - height / 2}
      width={width}
      height={height}
      rx={width / 2}
      fill={INK}
      transform={`rotate(${angle} ${cx} ${cy})`}
    />
  );
}

function Face({ expression }: { expression: MausExpression }) {
  const line = {
    fill: "none",
    stroke: INK,
    strokeWidth: 6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (expression) {
    case "friendly":
      return (
        <>
          <PillEye cx={90} height={15} angle={-18} />
          <PillEye cx={112} height={15} angle={-10} />
          <path d="M88 105 Q101 118 114 105" {...line} />
        </>
      );
    case "focused":
      return (
        <>
          <path d="M83 80 L94 84 M108 84 L119 80" {...line} strokeWidth="5" />
          <PillEye cx={90} cy={92} height={16} angle={-7} />
          <PillEye cx={112} cy={92} height={16} angle={7} />
          <path d="M90 111 Q101 107 112 111" {...line} />
        </>
      );
    case "thinking":
      return (
        <>
          <PillEye cx={90} cy={87} height={17} angle={-16} />
          <PillEye cx={112} cy={82} height={14} angle={-7} />
          <path d="M84 78 Q90 73 96 77 M108 73 Q115 70 120 75" {...line} strokeWidth="4.5" />
          <path d="M93 111 Q101 105 110 109" {...line} />
        </>
      );
    case "excited":
      return (
        <>
          <PillEye cx={90} cy={87} height={19} angle={-24} />
          <PillEye cx={112} cy={87} height={19} angle={4} />
          <path d="M88 102 Q101 124 114 102 Q101 109 88 102 Z" fill={INK} />
        </>
      );
    case "sleepy":
      return (
        <>
          <PillEye cx={90} cy={89} height={8} angle={-24} />
          <PillEye cx={112} cy={89} height={8} angle={-6} />
          <ellipse cx="101" cy="110" rx="6" ry="8" fill={INK} />
        </>
      );
    case "surprised":
      return (
        <>
          <PillEye cx={90} height={22} width={8} angle={-15} />
          <PillEye cx={112} height={22} width={8} angle={-8} />
          <circle cx="101" cy="111" r="8" fill={INK} />
        </>
      );
    case "skeptical":
      return (
        <>
          <path d="M83 82 L96 79 M107 77 L120 83" {...line} strokeWidth="5" />
          <PillEye cx={90} cy={91} height={17} angle={-18} />
          <PillEye cx={112} cy={92} height={8} angle={-2} />
          <path d="M91 112 Q101 107 112 113" {...line} />
        </>
      );
    case "worried":
      return (
        <>
          <path d="M83 82 Q90 76 97 82 M105 82 Q112 76 119 82" {...line} strokeWidth="4.5" />
          <PillEye cx={90} cy={91} height={17} angle={-5} />
          <PillEye cx={112} cy={91} height={17} angle={-20} />
          <path d="M89 115 Q101 103 113 115" {...line} />
        </>
      );
    case "mischievous":
      return (
        <>
          <path d="M83 82 L96 86 M106 86 L119 80" {...line} strokeWidth="5" />
          <PillEye cx={90} cy={93} height={15} angle={-2} />
          <PillEye cx={112} cy={93} height={15} angle={-22} />
          <path d="M89 106 Q103 118 116 103 Q103 110 89 106 Z" fill={INK} />
        </>
      );
    case "deadpan":
      return (
        <>
          <PillEye cx={90} angle={-18} />
          <PillEye cx={112} angle={-10} />
          <path d="M88 110 L114 110" {...line} />
        </>
      );
  }
}

export function MausAvatar({
  color,
  expression = "deadpan",
  size = 44,
  label,
}: {
  color: MausColor;
  expression?: MausExpression;
  size?: number;
  label?: string;
}) {
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;

  return (
    <svg
      width={size}
      height={size}
      viewBox="25 20 150 150"
      className="shrink-0 overflow-visible"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g transform="rotate(-20 100 100)">
        <path
          d={BODY}
          fill={fill}
        />
        <Face expression={expression} />
      </g>
    </svg>
  );
}

export function InitialsAvatar({
  initials,
  size = 32,
}: {
  initials: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
