import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps) {
  return {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export function Logo() {
  return (
    <svg width="42" height="42" viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#6d28d9" />
      <path fill="#fff" d="M14 12h9v40h-9z" />
      <path fill="#fff" d="M24 30.5 44 12h10L34 32.5 54 52H44L24 34.5z" />
    </svg>
  );
}

export function Avatar({ size = 72 }: { size?: number }) {
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 80 80" aria-hidden>
      <circle cx="40" cy="40" r="40" fill="#efe8ff" />
      <circle cx="40" cy="33" r="13" fill="#f0c2a0" />
      <path d="M24 31c1-12 8-18 16-18s15 6 16 18c-2-5-7-8-16-8s-14 3-16 8z" fill="#2a211c" />
      <path d="M12 76c5-18 16-26 28-26s23 8 28 26" fill="#6d28d9" />
    </svg>
  );
}

export function HouseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M7 10.5V20h10v-9.5" />
    </svg>
  );
}

export function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg
      className={open ? "nav-chevron open" : "nav-chevron"}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
    >
      <path d="M2 4.5 6 8l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 1.5" />
    </svg>
  );
}

export function WalletIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BriefcaseIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </svg>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="9" cy="9" r="3" />
      <circle cx="16.5" cy="10" r="2.4" />
      <path d="M3.5 19c1.2-3.2 3.4-4.8 5.5-4.8S13.3 15.8 14.5 19" />
      <path d="M14 14.4c1.2-.5 2.5-.5 3.8.2 1.4.8 2.3 2.3 2.7 4.4" />
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H9l2 2h7.5A2.5 2.5 0 0 1 21 10.5v7A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-9Z" />
    </svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="m12 4 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <svg {...base({ width: 16, height: 16, ...props })}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.8 6.5l1.6 1.6M17.6 15.9l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.8 17.5l1.6-1.6M17.6 8.1l1.6-1.6" />
    </svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 16.5 4 20l3.8-1.4A8 8 0 1 0 5 16.5Z" />
    </svg>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <svg {...base({ width: 16, height: 16, strokeWidth: 2, ...props })}>
      <path d="M12 3v8" />
      <path d="M7 6.5a8 8 0 1 0 10 0" />
    </svg>
  );
}

export function DocIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M7 3h7l5 5v13H7V3Z" fill="#efe8ff" stroke="#6d28d9" strokeWidth="1.6" />
      <path d="M14 3v5h5" fill="none" stroke="#6d28d9" strokeWidth="1.6" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <svg {...base({ width: 16, height: 16, ...props })}>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function LeafIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M5 19C14 19 19 12 19 5 12 5 5 10 5 19Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 16c3-1 5-4 7-8" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function HeadsetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 13a8 8 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="3" y="13" width="4" height="6" rx="1.2" fill="currentColor" />
      <rect x="17" y="13" width="4" height="6" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function TasksIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m8 9 1.5 1.5L13 7" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 15h8" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function TimesheetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 3v4M16 3v4M4 10h16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function EvalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function ProgramIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function LifeRingIcon(props: IconProps) {
  return (
    <svg {...base({ width: 22, height: 22, ...props })}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="m6.2 6.2 2.4 2.4M15.4 15.4l2.4 2.4M17.8 6.2l-2.4 2.4M8.6 15.4l-2.4 2.4" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base({ width: 16, height: 16, ...props })}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </svg>
  );
}
