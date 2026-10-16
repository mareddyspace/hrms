import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Bot,
  Briefcase,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Clock3,
  FileText,
  GraduationCap,
  Home,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Network,
  PanelLeft,
  Plug,
  Search,
  Sparkles,
  Sun,
  Target,
  UserRound,
  Users,
  Wallet,
} from "lucide-react";
import { COMPANY_MARK, COMPANY_NAME, PRODUCT_TAGLINE } from "../brand.ts";
import { PASSWORD_STALE_DAYS, formatLoginStamp } from "../model.ts";
import {
  aboutLinks,
  filterNavForAccount,
  filterPinnedForAccount,
  navGroups,
  roleLabel,
  type NavGroupKey,
  type NavLink as SideNavLink,
} from "../nav.ts";
import {
  countUnreadMessages,
  countUnreadNotifications,
  subscribeCollab,
} from "../data/collabLocal.ts";
import { useLocale } from "../locale/LocaleContext.tsx";
import type { AppLanguage } from "../locale/countryConfig.ts";
import type { CountryCode } from "../model.ts";
import { getTalentState, subscribeTalent } from "../data/talentLocal.ts";
import { usePortal } from "../store.tsx";
import { countWaitingOnMe } from "../pages/ApprovalsCenter.tsx";
import { CopilotPopup } from "./CopilotPopup.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Banner, Dropdown, Field } from "./ui.tsx";

const SIDEBAR_KEY = "timez.sidebar.collapsed";
const THEME_KEY = "kastech.ess.theme";

const groupIcons: Record<NavGroupKey, ReactNode> = {
  me: <UserRound size={18} strokeWidth={1.75} />,
  myTime: <Clock3 size={18} strokeWidth={1.75} />,
  team: <Network size={18} strokeWidth={1.75} />,
  people: <Users size={18} strokeWidth={1.75} />,
  talent: <Briefcase size={18} strokeWidth={1.75} />,
  insights: <Sparkles size={18} strokeWidth={1.75} />,
  admin: <Building2 size={18} strokeWidth={1.75} />,
};

const linkIcons: Record<string, ReactNode> = {
  "/": <Home size={18} strokeWidth={1.75} />,
  "/info": <UserRound size={18} strokeWidth={1.75} />,
  "/calendar": <CalendarDays size={18} strokeWidth={1.75} />,
  "/org-chart": <Network size={18} strokeWidth={1.75} />,
  "/team": <Network size={18} strokeWidth={1.75} />,
  "/tasks": <ClipboardList size={18} strokeWidth={1.75} />,
  "/approvals": <Inbox size={18} strokeWidth={1.75} />,
  "/chat": <MessageSquare size={18} strokeWidth={1.75} />,
  "/announcements": <FileText size={18} strokeWidth={1.75} />,
  "/notifications": <Bell size={18} strokeWidth={1.75} />,
  "/directory": <Users size={18} strokeWidth={1.75} />,
  "/organization": <Building2 size={18} strokeWidth={1.75} />,
  "/jobs": <Briefcase size={18} strokeWidth={1.75} />,
  "/attendance": <CalendarDays size={18} strokeWidth={1.75} />,
  "/leave": <Clock3 size={18} strokeWidth={1.75} />,
  "/timesheet": <Clock3 size={18} strokeWidth={1.75} />,
  "/recruiting": <Target size={18} strokeWidth={1.75} />,
  "/onboarding": <UserRound size={18} strokeWidth={1.75} />,
  "/evaluations": <Target size={18} strokeWidth={1.75} />,
  "/programs": <GraduationCap size={18} strokeWidth={1.75} />,
  "/skills": <Sparkles size={18} strokeWidth={1.75} />,
  "/compensation": <Wallet size={18} strokeWidth={1.75} />,
  "/benefits": <Wallet size={18} strokeWidth={1.75} />,
  "/payslips": <Wallet size={18} strokeWidth={1.75} />,
  "/documents": <FileText size={18} strokeWidth={1.75} />,
  "/workflows": <Inbox size={18} strokeWidth={1.75} />,
  "/analytics": <LayoutDashboard size={18} strokeWidth={1.75} />,
  "/ai/copilot": <Bot size={18} strokeWidth={1.75} />,
  "/ai/agents": <Bot size={18} strokeWidth={1.75} />,
  "/integrations": <Plug size={18} strokeWidth={1.75} />,
  "/payroll": <Wallet size={18} strokeWidth={1.75} />,
  "/admin": <PanelLeft size={18} strokeWidth={1.75} />,
  "/settings/locale": <GlobeIcon />,
  "/admin/countries": <Building2 size={18} strokeWidth={1.75} />,
};

function GlobeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function WelcomeLoginDialog() {
  const { loginNotice, dismissLoginNotice, changePasswordAfterStaleLogin } = usePortal();
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  if (!loginNotice) return null;

  const stamp = loginNotice.previousIso
    ? formatLoginStamp(loginNotice.previousIso, loginNotice.timeZone)
    : null;
  const stale = loginNotice.requirePasswordChange;

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    const error = changePasswordAfterStaleLogin(newPassword, confirm);
    if (error) setMessage({ tone: "err", text: error });
    else {
      setNewPassword("");
      setConfirm("");
      setMessage({ tone: "ok", text: "Password updated. You can continue." });
    }
  }

  return (
    <div className="modal-root" role="presentation">
      {!stale && (
        <button className="modal-scrim" type="button" aria-label="Dismiss welcome notice" onClick={dismissLoginNotice} />
      )}
      {stale && <div className="modal-scrim modal-scrim-lock" aria-hidden />}
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="welcome-login-title">
        <h2 id="welcome-login-title">{stale ? "Update password" : "Welcome Back!"}</h2>
        <p className="modal-lede">
          {stale ? "Please set a new password to continue." : "Here are your last login details."}
        </p>
        {stamp && (
          <dl className="login-facts">
            <div>
              <dt>Previous login date</dt>
              <dd>{stamp.date}</dd>
            </div>
            <div>
              <dt>Previous login time</dt>
              <dd>{stamp.time}</dd>
            </div>
            <div>
              <dt>Time zone</dt>
              <dd>{stamp.zone}</dd>
            </div>
          </dl>
        )}
        {!stamp && !stale && <p className="note">No previous successful login is recorded on this device.</p>}

        {stale ? (
          <form onSubmit={submitPassword}>
            <div className="stack" style={{ marginTop: 12 }}>
              <Field label="New password">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm password">
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <Banner message={message} />
            <div className="form-actions">
              <button className="btn" type="submit">
                Update password
              </button>
            </div>
          </form>
        ) : (
          <div className="form-actions">
            <button className="btn" type="button" onClick={dismissLoginNotice}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="nav-badge">{count > 9 ? "9+" : count}</span>;
}

function usePasswordPolicyPrompt() {
  const { signedIn, passwordPolicy, changePassword, loginNotice } = usePortal();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const visible = Boolean(signedIn && passwordPolicy.warn && !loginNotice?.requirePasswordChange);
  const due = passwordPolicy.due;
  const label = due ? "Change password" : `Change password (${passwordPolicy.daysRemaining}d left)`;

  function submit(event: FormEvent) {
    event.preventDefault();
    const error = changePassword(current, newPassword, confirm);
    if (error) setMessage({ tone: "err", text: error });
    else {
      setCurrent("");
      setNewPassword("");
      setConfirm("");
      setMessage({ tone: "ok", text: "Password updated." });
      window.setTimeout(() => {
        setOpen(false);
        setMessage(null);
      }, 1200);
    }
  }

  const modal = open ? (
    <div className="modal-root" role="presentation">
      <button className="modal-scrim" type="button" aria-label="Close" onClick={() => setOpen(false)} />
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="password-policy-title">
        <h2 id="password-policy-title">Change password</h2>
        <p className="modal-lede">Please set a new password every {PASSWORD_STALE_DAYS} days.</p>
        <form onSubmit={submit}>
          <div className="stack" style={{ marginTop: 12 }}>
            <Field label="Current password">
              <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
            </Field>
            <Field label="New password">
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          <Banner message={message} />
          <div className="form-actions">
            <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn" type="submit">
              Update password
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : null;

  return { visible, due, label, openPrompt: () => setOpen(true), modal };
}

function readTheme(): "light" | "night" {
  return localStorage.getItem(THEME_KEY) === "night" ? "night" : "light";
}

function applyTheme(theme: "light" | "night") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

export function Shell() {
  const { employee, demoProfile, demoAccounts, signOut, switchDemoPersona, counts, state, canApproveLeaveFor, canVerifyProofs } =
    usePortal();
  const { regionCode, setRegionCode, language, setLanguage, countries, t, languageLabels, activeCountry } = useLocale();
  const passwordPrompt = usePasswordPolicyPrompt();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "1");
  const [query, setQuery] = useState("");
  const [headerSearch, setHeaderSearch] = useState("");
  const [theme, setTheme] = useState<"light" | "night">(readTheme);
  const [openGroups, setOpenGroups] = useState<string[]>(["Me", "Time & pay"]);
  const location = useLocation();
  const navigate = useNavigate();
  const persona = demoProfile.personaLabel || roleLabel(employee.role);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  const [collabTick, setCollabTick] = useState(0);
  useEffect(() => subscribeCollab(() => setCollabTick((n) => n + 1)), []);

  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);

  const badges = useMemo(() => {
    const mine = <T extends { employeeId: string }>(items: T[]) => items.filter((item) => item.employeeId === employee.id);
    // Your own pending leave, plus team leave and backdated-leave permissions waiting on you.
    const leavePending =
      mine(state.leaveRequests).filter((item) => item.status === "pending").length +
      state.leaveRequests.filter((item) => item.status === "pending" && canApproveLeaveFor(item.employeeId)).length +
      state.backdatedPermissions.filter((item) => item.status === "pending" && canApproveLeaveFor(item.employeeId)).length;
    void collabTick;
    return {
      "/leave": leavePending,
      "/timesheet": counts.timesheet,
      "/tasks": counts.tasks,
      // Open course enrollments — the same list the Learning page and home page use.
      "/programs": talent.enrollments.filter((e) => e.employeeId === employee.id && e.status !== "Completed").length,
      "/evaluations": counts.evaluation,
      "/approvals": countWaitingOnMe(state, employee.id, canApproveLeaveFor, canVerifyProofs),
      "/chat": countUnreadMessages(employee.id, demoProfile.role),
      "/notifications": countUnreadNotifications(demoProfile.role),
    } as Record<string, number>;
  }, [counts, employee.id, state, collabTick, demoProfile.role, talent, canApproveLeaveFor, canVerifyProofs]);

  const needle = query.trim().toLowerCase();
  const pinned = filterPinnedForAccount(demoProfile);
  const roleNav = filterNavForAccount(demoProfile);
  const filteredGroups = roleNav
    .map((group) => ({
      ...group,
      links: needle
        ? group.links.filter(
            (link) => link.label.toLowerCase().includes(needle) || group.label.toLowerCase().includes(needle),
          )
        : group.links,
    }))
    .filter((group) => group.links.length > 0);

  useEffect(() => {
    setMobileOpen(false);
    if (query.trim()) return;
    const activeGroup =
      navGroups.find((group) =>
        group.links.some((link) => location.pathname === link.to || (link.to !== "/" && location.pathname.startsWith(`${link.to}/`))),
      )?.label ?? (location.pathname === "/" ? "Me" : "");
    if (!activeGroup) return;
    setOpenGroups((current) => (current.includes(activeGroup) ? current : [...current, activeGroup]));
  }, [location.pathname, query]);

  function toggleGroup(label: string) {
    setOpenGroups((current) =>
      current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
    );
  }

  function groupBadgeTotal(links: readonly SideNavLink[]) {
    return links.reduce((sum, link) => sum + (link.badgeKey ? badges[link.badgeKey] ?? 0 : 0), 0);
  }

  function renderNavLink(link: SideNavLink) {
    return (
      <NavLink
        key={link.id}
        to={link.to}
        end={link.to === "/"}
        className={({ isActive }) => (isActive ? "sub-link active" : "sub-link")}
        title={link.label}
      >
        <span className="nav-ico">{linkIcons[link.to] ?? <FileText size={18} strokeWidth={1.75} />}</span>
        <span className="sub-link-label">{link.label}</span>
        <Badge count={link.badgeKey ? badges[link.badgeKey] ?? 0 : 0} />
      </NavLink>
    );
  }

  function onHeaderSearch(event: FormEvent) {
    event.preventDefault();
    const q = headerSearch.trim().toLowerCase();
    if (!q) return;
    const hit = [...pinned, ...roleNav.flatMap((group) => group.links)].find((link) =>
      link.label.toLowerCase().includes(q),
    );
    if (hit) {
      navigate(hit.to);
      setHeaderSearch("");
    }
  }

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className={mobileOpen ? "sidebar open" : "sidebar"} aria-label="Primary">
        <div className="side-top">
          <Link to="/" className="side-brand">
            <span className="mark" aria-hidden>
              {COMPANY_MARK}
            </span>
            <div>
              <strong>{COMPANY_NAME}</strong>
              <span>{PRODUCT_TAGLINE}</span>
            </div>
          </Link>

          <button
            type="button"
            className="side-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-pressed={collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            <span>{collapsed ? "Expand" : "Collapse"}</span>
          </button>

          <label className="side-search">
            <span className="sr-only">Filter menu</span>
            <Search size={16} className="side-search-ico" aria-hidden />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter menu…" autoComplete="off" />
          </label>
        </div>

        <nav aria-label="Sections" className="side-nav">
          {pinned.length > 0 && (
            <div className="side-pinned">
              {pinned
                .filter((link) => !needle || link.label.toLowerCase().includes(needle))
                .map((link) => renderNavLink(link))}
            </div>
          )}

          {filteredGroups.map((group) => {
            const expanded = Boolean(needle) || openGroups.includes(group.label) || collapsed;
            const sectionBadges = groupBadgeTotal(group.links);
            return (
              <div key={group.key} className={expanded ? "side-group open" : "side-group"}>
                <button
                  type="button"
                  className="group-toggle"
                  aria-expanded={expanded}
                  onClick={() => {
                    if (needle || collapsed) return;
                    toggleGroup(group.label);
                  }}
                >
                  <span className="nav-ico">{groupIcons[group.key]}</span>
                  <span className="group-label">{group.label}</span>
                  {!expanded && sectionBadges > 0 && <Badge count={sectionBadges} />}
                  {!collapsed && <ChevronDown size={16} className={expanded ? "nav-chevron open" : "nav-chevron"} />}
                </button>
                {expanded && <div className="side-subnav">{group.links.map((link) => renderNavLink(link))}</div>}
              </div>
            );
          })}
        </nav>

        {!collapsed && (
          <p className="side-role-chip" title={persona}>
            Viewing as <strong>{persona}</strong>
          </p>
        )}
      </aside>

      {mobileOpen && <button className="scrim" type="button" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}

      <div className="workspace">
        <header className="topbar">
          <button className="menu-toggle top-icon-btn" type="button" aria-expanded={mobileOpen} onClick={() => setMobileOpen((value) => !value)}>
            <Menu size={18} />
          </button>

          <form className="topbar-search" onSubmit={onHeaderSearch} role="search">
            <Search size={18} aria-hidden />
            <input
              value={headerSearch}
              onChange={(event) => setHeaderSearch(event.target.value)}
              placeholder={`Search ${COMPANY_NAME}…`}
              aria-label="Global search"
            />
          </form>

          <label className="topbar-locale" title={t("locale.disclaimer")}>
            <span className="sr-only">{t("locale.region")}</span>
            <select
              value={regionCode}
              aria-label={t("locale.region")}
              onChange={(e) => setRegionCode(e.target.value === "ALL" ? "ALL" : (e.target.value as CountryCode))}
            >
              <option value="ALL">{t("country.all")}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}
                </option>
              ))}
            </select>
          </label>
          <label className="topbar-locale" title={t("locale.language")}>
            <span className="sr-only">{t("locale.language")}</span>
            <select
              value={language}
              aria-label={t("locale.language")}
              onChange={(e) => setLanguage(e.target.value as AppLanguage)}
            >
              {(Object.keys(languageLabels) as AppLanguage[]).map((code) => (
                <option key={code} value={code}>
                  {code.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <div className="top-actions">
            {passwordPrompt.visible && (
              <button type="button" className={`password-policy-link${passwordPrompt.due ? " due" : ""}`} onClick={passwordPrompt.openPrompt}>
                {passwordPrompt.label}
              </button>
            )}
            <Link to="/notifications" className="top-icon-btn" aria-label="Notification center">
              <Bell size={18} strokeWidth={1.75} />
              {(badges["/notifications"] ?? 0) > 0 && <span className="dot" />}
            </Link>
            <Link to="/approvals" className="top-icon-btn" aria-label="Approvals and my requests" title="Approvals & my requests">
              <Inbox size={18} strokeWidth={1.75} />
              {(badges["/approvals"] ?? 0) > 0 && <span className="dot" />}
            </Link>
            <Link to="/help" className="top-icon-btn" aria-label="Help">
              <CircleHelp size={18} strokeWidth={1.75} />
            </Link>
            <Link to="/chat" className="top-icon-btn" aria-label="Messages">
              <MessageSquare size={18} strokeWidth={1.75} />
              {(badges["/chat"] ?? 0) > 0 && <span className="dot" />}
            </Link>
            <Link to="/announcements" className="top-icon-btn" aria-label="Announcements">
              <FileText size={18} strokeWidth={1.75} />
            </Link>
            <button
              type="button"
              className="top-icon-btn"
              aria-label={theme === "night" ? "Switch to light theme" : "Switch to night theme"}
              onClick={() => setTheme((current) => (current === "night" ? "light" : "night"))}
            >
              {theme === "night" ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
            </button>

            <Dropdown
              label={
                <span className="profile-chip">
                  <img src={employee.photo} alt="" />
                  <span>
                    <strong>{employee.fullName}</strong>
                    <small>
                      {employee.employeeCode} · {persona}
                      {employee.department ? ` · ${employee.department}` : ""}
                    </small>
                  </span>
                </span>
              }
              items={[
                { id: "profile", label: "My profile", to: "/info" },
                {
                  id: "org-context",
                  label: `Home: ${employee.countryName ?? "—"} · ${employee.legalEntity ?? "Infotech"}`,
                },
                {
                  id: "view-region",
                  label: `Demo region: ${regionCode === "ALL" ? "All" : activeCountry.name} · ${activeCountry.currency}`,
                },
                { id: "locale", label: t("nav.settings"), to: "/settings/locale" },
                ...(["admin", "super_admin", "hr", "hr_admin"].includes(demoProfile.role)
                  ? [{ id: "countries-admin", label: t("admin.countries"), to: "/admin/countries" }]
                  : []),
                { id: "help", label: "Help", to: "/help" },
                ...aboutLinks.filter((item) => item.to !== "/help").map((item) => ({ id: item.id, label: item.label, to: item.to })),
                // Switching persona skips the password, so it only exists while developing (npm run dev).
                ...(import.meta.env.DEV
                  ? [
                      {
                        id: "switcher-label",
                        label: "—— Switch persona (development only) ——",
                      },
                    ]
                  : []),
                ...(import.meta.env.DEV ? demoAccounts : []).map((account) => ({
                  id: `switch-${account.id}`,
                  label: `${account.personaLabel}${account.id === demoProfile.id ? " ✓" : ""}`,
                  onSelect: () => {
                    switchDemoPersona(account.id);
                    navigate("/");
                  },
                })),
                {
                  id: "signout",
                  label: "Sign out",
                  onSelect: () => {
                    signOut();
                    navigate("/login");
                  },
                },
              ]}
            />
            <button
              className="top-icon-btn"
              type="button"
              aria-label="Sign out"
              onClick={() => {
                signOut();
                navigate("/login");
              }}
            >
              <LogOut size={18} strokeWidth={1.75} />
            </button>
          </div>
        </header>

        <main className="main">
          {/* Keyed by path so a crashed page recovers as soon as you navigate elsewhere. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        <footer className="footer">
          <span>
            © {new Date().getFullYear()} {COMPANY_NAME}. All rights reserved.
          </span>
          <nav aria-label="Footer">
            <Link to="/terms">Terms</Link>
            <Link to="/help">Help</Link>
            <Link to="/version">Version</Link>
          </nav>
        </footer>
      </div>

      <WelcomeLoginDialog />
      {passwordPrompt.modal}
      <CopilotPopup />
    </div>
  );
}
