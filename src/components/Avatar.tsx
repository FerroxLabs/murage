import { memo, useId, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  MAUS_COLORS,
  type MausColor,
  type MausExpression,
  type MausMotion,
} from "@/lib/mascot";

// Exact SupaMaus mascot silhouette from the website's
// components/v2/MascotSlot.js. The geometry and tilt remain faithful to that
// source; app avatars use a larger borderless flat fill.
const BODY =
  "M93.4 40.6 L43 151.1 Q38 162 48.4 156 L91.4 131 Q100 126 108.7 131 L151.6 156 Q162 162 157 151.1 L106.6 40.6 Q100 26 93.4 40.6 Z";

const INK = "#10201b";

function shade(hex: string, amount: number) {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.max(0, Math.min(255, ((value >> shift) & 0xff) + amount));
  return `#${[channel(16), channel(8), channel(0)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

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
          <g className="maus-eyes">
            <PillEye cx={90} height={15} angle={-18} />
            <PillEye cx={112} height={15} angle={-10} />
          </g>
          <g className="maus-mouth"><path d="M88 105 Q101 118 114 105" {...line} /></g>
        </>
      );
    case "focused":
      return (
        <>
          <g className="maus-eyes">
            <path d="M83 80 L94 84 M108 84 L119 80" {...line} strokeWidth="5" />
            <PillEye cx={90} cy={92} height={16} angle={-7} />
            <PillEye cx={112} cy={92} height={16} angle={7} />
          </g>
          <g className="maus-mouth"><path d="M90 111 Q101 107 112 111" {...line} /></g>
        </>
      );
    case "thinking":
      return (
        <>
          <g className="maus-eyes">
            <PillEye cx={90} cy={87} height={17} angle={-16} />
            <PillEye cx={112} cy={82} height={14} angle={-7} />
            <path d="M84 78 Q90 73 96 77 M108 73 Q115 70 120 75" {...line} strokeWidth="4.5" />
          </g>
          <g className="maus-mouth"><path d="M93 111 Q101 105 110 109" {...line} /></g>
        </>
      );
    case "excited":
      return (
        <>
          <g className="maus-eyes">
            <PillEye cx={90} cy={87} height={19} angle={-24} />
            <PillEye cx={112} cy={87} height={19} angle={4} />
          </g>
          <g className="maus-mouth"><path d="M88 102 Q101 124 114 102 Q101 109 88 102 Z" fill={INK} /></g>
        </>
      );
    case "sleepy":
      return (
        <>
          <g className="maus-eyes">
            <PillEye cx={90} cy={89} height={8} angle={-24} />
            <PillEye cx={112} cy={89} height={8} angle={-6} />
          </g>
          <g className="maus-mouth"><ellipse cx="101" cy="110" rx="6" ry="8" fill={INK} /></g>
        </>
      );
    case "surprised":
      return (
        <>
          <g className="maus-eyes">
            <PillEye cx={90} height={22} width={8} angle={-15} />
            <PillEye cx={112} height={22} width={8} angle={-8} />
          </g>
          <g className="maus-mouth"><circle cx="101" cy="111" r="8" fill={INK} /></g>
        </>
      );
    case "skeptical":
      return (
        <>
          <g className="maus-eyes">
            <path d="M83 82 L96 79 M107 77 L120 83" {...line} strokeWidth="5" />
            <PillEye cx={90} cy={91} height={17} angle={-18} />
            <PillEye cx={112} cy={92} height={8} angle={-2} />
          </g>
          <g className="maus-mouth"><path d="M91 112 Q101 107 112 113" {...line} /></g>
        </>
      );
    case "worried":
      return (
        <>
          <g className="maus-eyes">
            <path d="M83 82 Q90 76 97 82 M105 82 Q112 76 119 82" {...line} strokeWidth="4.5" />
            <PillEye cx={90} cy={91} height={17} angle={-5} />
            <PillEye cx={112} cy={91} height={17} angle={-20} />
          </g>
          <g className="maus-mouth"><path d="M89 115 Q101 103 113 115" {...line} /></g>
        </>
      );
    case "mischievous":
      return (
        <>
          <g className="maus-eyes">
            <path d="M83 82 L96 86 M106 86 L119 80" {...line} strokeWidth="5" />
            <PillEye cx={90} cy={93} height={15} angle={-2} />
            <PillEye cx={112} cy={93} height={15} angle={-22} />
          </g>
          <g className="maus-mouth"><path d="M89 106 Q103 118 116 103 Q103 110 89 106 Z" fill={INK} /></g>
        </>
      );
    case "deadpan":
      return (
        <>
          <g className="maus-eyes">
            <PillEye cx={90} angle={-18} />
            <PillEye cx={112} angle={-10} />
          </g>
          <g className="maus-mouth"><path d="M88 110 L114 110" {...line} /></g>
        </>
      );
  }
}

function trackEyes(event: ReactPointerEvent<SVGSVGElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  event.currentTarget.style.setProperty("--maus-eye-x", `${Math.max(-1, Math.min(1, x)) * 3.4}px`);
  event.currentTarget.style.setProperty("--maus-eye-y", `${Math.max(-1, Math.min(1, y)) * 2.6}px`);
}

function resetEyes(event: ReactPointerEvent<SVGSVGElement>) {
  event.currentTarget.style.setProperty("--maus-eye-x", "0px");
  event.currentTarget.style.setProperty("--maus-eye-y", "0px");
}

function MausAvatarComponent({
  color,
  expression = "deadpan",
  size = 44,
  label,
  motion = "none",
  motionKey = 0,
}: {
  color: MausColor;
  expression?: MausExpression;
  size?: number;
  label?: string;
  motion?: MausMotion;
  motionKey?: number;
}) {
  const fill = MAUS_COLORS[color] ?? MAUS_COLORS.green;
  const uid = useId().replace(/:/g, "");
  const surfaceId = `maus-surface-${uid}`;
  const bevelId = `maus-bevel-${uid}`;
  const glossId = `maus-gloss-${uid}`;
  const clipId = `maus-clip-${uid}`;
  const surfaceShade = shade(fill, -30);
  const hasAlert = motion === "alert" || motion === "failure";
  const hasEllipsis = motion === "thinking";
  const hasRibbons = motion === "launch";
  const hasBurst = motion === "celebrate";
  const hasOrbit = motion === "arrive" || motion === "switch" || motion === "customize" || motion === "working";

  return (
    <svg
      width={size}
      height={size}
      viewBox="-22 51 164 164"
      className="shrink-0 overflow-visible"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onPointerMove={trackEyes}
      onPointerLeave={resetEyes}
      style={{ "--maus-color": fill, "--maus-eye-x": "0px", "--maus-eye-y": "0px" } as CSSProperties}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={BODY} />
        </clipPath>
        <linearGradient id={surfaceId} x1="66" y1="45" x2="132" y2="156" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={shade(fill, 54)} />
          <stop offset="0.3" stopColor={shade(fill, 22)} />
          <stop offset="0.72" stopColor={fill} />
          <stop offset="1" stopColor={surfaceShade} />
        </linearGradient>
        <linearGradient id={bevelId} x1="57" y1="44" x2="146" y2="151" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.68" />
          <stop offset="0.38" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="0.68" stopColor={surfaceShade} stopOpacity="0.1" />
          <stop offset="1" stopColor={INK} stopOpacity="0.28" />
        </linearGradient>
        <radialGradient id={glossId} cx="0.5" cy="0.45" r="0.58">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.62" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g key={motionKey} className={`maus-motion maus-motion--${motion}`}>
        {hasAlert && (
          <g className="maus-fx maus-fx--alert" aria-hidden="true">
            <path d="M97 45 Q100 40 103 45 L106 92 Q106 99 100 99 Q94 99 94 92 Z" fill={fill} />
            <circle cx="100" cy="116" r="8" fill={fill} />
          </g>
        )}

        {hasEllipsis && (
          <g className="maus-fx maus-fx--ellipsis" aria-hidden="true">
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--one" cx="72" cy="101" r="8" fill={fill} />
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--two" cx="100" cy="101" r="10" fill={fill} />
            <circle className="maus-ellipsis-dot maus-ellipsis-dot--three" cx="130" cy="101" r="8" fill={fill} />
          </g>
        )}

        {hasRibbons && (
          <g className="maus-fx maus-fx--ribbons" aria-hidden="true">
            <path className="maus-ribbon maus-ribbon--one" pathLength="1" d="M55 119 C79 137 119 140 150 116" stroke={fill} />
            <path className="maus-ribbon maus-ribbon--two" pathLength="1" d="M54 112 C85 126 119 125 145 103" stroke="#fcfcfc" />
            <path className="maus-ribbon maus-ribbon--three" pathLength="1" d="M62 126 C87 145 126 145 156 121" stroke={shade(fill, 44)} />
          </g>
        )}

        {hasBurst && (
          <g className="maus-fx maus-fx--burst" aria-hidden="true">
            <circle className="maus-burst-dot maus-burst-dot--one" cx="100" cy="100" r="5" fill={fill} />
            <circle className="maus-burst-dot maus-burst-dot--two" cx="100" cy="100" r="4" fill="#fcfcfc" />
            <circle className="maus-burst-dot maus-burst-dot--three" cx="100" cy="100" r="6" fill={shade(fill, 42)} />
            <circle className="maus-burst-dot maus-burst-dot--four" cx="100" cy="100" r="3.5" fill={fill} />
            <path className="maus-burst-ray maus-burst-ray--one" d="M100 100 L100 73" stroke={fill} />
            <path className="maus-burst-ray maus-burst-ray--two" d="M100 100 L125 88" stroke="#fcfcfc" />
            <path className="maus-burst-ray maus-burst-ray--three" d="M100 100 L82 121" stroke={shade(fill, 42)} />
          </g>
        )}

        {hasOrbit && (
          <g className="maus-orbit" aria-hidden="true">
            <path className="maus-speed-line maus-speed-line--one" pathLength="1" d="M38 119 C23 81 45 42 78 29" />
            <path className="maus-speed-line maus-speed-line--two" pathLength="1" d="M55 151 C32 126 29 94 39 70" />
            <circle className="maus-orbit-dot maus-orbit-dot--one" cx="47" cy="54" r="4.6" fill={fill} />
            <circle className="maus-orbit-dot maus-orbit-dot--two" cx="151" cy="65" r="3.4" fill="#fcfcfc" />
            <circle className="maus-orbit-dot maus-orbit-dot--three" cx="155" cy="132" r="5.2" fill={fill} />
          </g>
        )}

        <g className="maus-character">
          <g className="maus-solid" transform="rotate(-20 100 100)">
              <path className="maus-body" d={BODY} fill={`url(#${surfaceId})`} />
              <path
                className="maus-bevel"
                d={BODY}
                fill="none"
                stroke={`url(#${bevelId})`}
                strokeWidth="4.5"
                clipPath={`url(#${clipId})`}
              />
              <ellipse
                className="maus-specular"
                cx="73"
                cy="60"
                rx="42"
                ry="24"
                fill={`url(#${glossId})`}
                clipPath={`url(#${clipId})`}
                transform="rotate(-26 73 60)"
              />
              <path
                className="maus-rim-light"
                d="M94 43 L48 144"
                fill="none"
                stroke="#ffffff"
                strokeOpacity="0.35"
                strokeWidth="2.2"
                strokeLinecap="round"
                clipPath={`url(#${clipId})`}
              />
              <g className="maus-face">
                <Face expression={expression} />
              </g>
          </g>
        </g>
      </g>
    </svg>
  );
}

export const MausAvatar = memo(MausAvatarComponent);

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
