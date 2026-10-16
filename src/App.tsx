import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell.tsx";
import { ExpensesPage } from "./pages/ExpensesPage.tsx";
import { LoginPage, TermsPage, VersionPage } from "./pages/InfoPages.tsx";
import { LeavePage } from "./pages/LeavePage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { PayslipDetail, PayslipsPage } from "./pages/PayslipsPage.tsx";
import { CalendarPage } from "./pages/CalendarPage.tsx";
import { OrgChartPage } from "./pages/OrgChartPage.tsx";
import { PersonProfilePage } from "./pages/PersonProfilePage.tsx";
import { AttendancePage, EmsPage, HighlightsPage, HolidaysPage, MyInfo, ProjectsPage } from "./pages/ProfilePages.tsx";
import { AssetsPage, CabPage, CafeteriaPage, CashPage, EncashmentPage, SoftwarePage } from "./pages/RequestPages.tsx";
import { ConvertPage, FilesPage, FormsPage, PoliciesPage, SignPage } from "./pages/ResourcePages.tsx";
import { EvaluationsPage, ProgramsPage, TasksPage } from "./pages/TeamPages.tsx";
import {
  AnnouncementsPage,
  ChatPage,
  HelpPage,
  NotificationCenterPage,
} from "./pages/CollabModules.tsx";
import { DirectoryPage, PeopleDetailPage, PeopleNewPage } from "./pages/PeopleModule.tsx";
import { JobsPage, OrganizationPage } from "./pages/OrganizationJobsPages.tsx";
import { BenefitsPage, CompensationPage, DocumentsPage } from "./pages/RewardModules.tsx";
import {
  CountryAdminPage,
  CountryBenefitsConfigPage,
  CountryDocumentsConfigPage,
  LocaleSettingsPage,
} from "./pages/LocalePages.tsx";
import { InvestmentProofPage, ReimbursementPage } from "./pages/PayExtrasPages.tsx";
import { TimesheetPage } from "./pages/TimesheetPage.tsx";
import {
  AdminPage,
  AiAgentsPage,
  AiCopilotPage,
  AnalyticsPage,
  IntegrationsPage,
  MyTeamPage,
  OnboardingPage,
  PayrollPage,
  RecruitingPage,
  RoadmapPage,
  SkillsCareerPage,
  WorkflowsPage,
} from "./pages/TimezModules.tsx";
import { ApprovalsCenterPage } from "./pages/ApprovalsCenter.tsx";
import { EmptyState, Page } from "./components/ui.tsx";
import { accountHasNavAccess, type NavAccessId } from "./demoAccounts.ts";
import { usePortal } from "./store.tsx";

/** Pages are reachable only when the signed-in role has them in its access list — not just from the menu. */
function Allowed({ id, children }: { id: NavAccessId; children: ReactNode }) {
  const { demoProfile } = usePortal();
  if (accountHasNavAccess(demoProfile, id)) return <>{children}</>;
  return (
    <Page title="Not available">
      <EmptyState title="You don't have access to this page" description="Ask HR if you think you should." />
    </Page>
  );
}

function Guard() {
  const { signedIn } = usePortal();
  if (!signedIn) return <Navigate to="/login" replace />;
  return <Shell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Guard />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/info" element={<MyInfo />} />
        <Route path="/calendar" element={<Allowed id="calendar"><CalendarPage /></Allowed>} />
        <Route path="/org-chart" element={<Allowed id="orgchart"><OrgChartPage /></Allowed>} />
        <Route path="/people/:id" element={<PersonProfilePage />} />
        <Route path="/team" element={<Allowed id="team"><MyTeamPage /></Allowed>} />
        <Route path="/workflows" element={<Allowed id="workflows"><WorkflowsPage /></Allowed>} />
        <Route path="/organization" element={<Allowed id="organization"><OrganizationPage /></Allowed>} />
        <Route path="/jobs" element={<Allowed id="jobs"><JobsPage /></Allowed>} />
        <Route path="/recruiting" element={<Allowed id="recruiting"><RecruitingPage /></Allowed>} />
        <Route path="/onboarding" element={<Allowed id="onboarding"><OnboardingPage /></Allowed>} />
        <Route path="/skills" element={<Allowed id="skills"><SkillsCareerPage /></Allowed>} />
        <Route path="/compensation" element={<Allowed id="compensation"><CompensationPage /></Allowed>} />
        <Route path="/benefits" element={<Allowed id="benefits"><BenefitsPage /></Allowed>} />
        <Route path="/payroll" element={<Allowed id="payroll"><PayrollPage /></Allowed>} />
        <Route path="/analytics" element={<Allowed id="analytics"><AnalyticsPage /></Allowed>} />
        <Route path="/ai/copilot" element={<Allowed id="copilot"><AiCopilotPage /></Allowed>} />
        <Route path="/ai/agents" element={<Allowed id="agents"><AiAgentsPage /></Allowed>} />
        <Route path="/admin" element={<Allowed id="administration"><AdminPage /></Allowed>} />
        <Route path="/admin/countries" element={<CountryAdminPage />} />
        <Route path="/settings/locale" element={<Allowed id="locale"><LocaleSettingsPage /></Allowed>} />
        <Route path="/benefits/country" element={<CountryBenefitsConfigPage />} />
        <Route path="/documents/country" element={<CountryDocumentsConfigPage />} />
        <Route path="/integrations" element={<Allowed id="integrations"><IntegrationsPage /></Allowed>} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/encashment" element={<EncashmentPage />} />
        <Route path="/documents" element={<Allowed id="documents"><DocumentsPage /></Allowed>} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/convert" element={<ConvertPage />} />
        <Route path="/sign" element={<SignPage />} />
        <Route path="/timesheet" element={<Allowed id="timesheet"><TimesheetPage /></Allowed>} />
        <Route path="/ems" element={<EmsPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/policies" element={<PoliciesPage />} />
        <Route path="/tasks" element={<Allowed id="tasks"><TasksPage /></Allowed>} />
        <Route path="/attendance" element={<Allowed id="attendance"><AttendancePage /></Allowed>} />
        <Route path="/leave" element={<Allowed id="leave"><LeavePage /></Allowed>} />
        <Route path="/directory" element={<Allowed id="people"><DirectoryPage /></Allowed>} />
        <Route path="/directory/new" element={<Allowed id="people"><PeopleNewPage /></Allowed>} />
        <Route path="/directory/:id" element={<Allowed id="people"><PeopleDetailPage /></Allowed>} />
        <Route path="/cash" element={<CashPage />} />
        <Route path="/approvals" element={<ApprovalsCenterPage />} />
        <Route path="/chat" element={<Allowed id="messages"><ChatPage /></Allowed>} />
        <Route path="/announcements" element={<Allowed id="announcements"><AnnouncementsPage /></Allowed>} />
        <Route path="/notifications" element={<Allowed id="notifications"><NotificationCenterPage /></Allowed>} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/cab" element={<CabPage />} />
        <Route path="/expenses" element={<Allowed id="expenses"><ExpensesPage /></Allowed>} />
        <Route path="/reimbursement" element={<ReimbursementPage />} />
        <Route path="/investment" element={<InvestmentProofPage />} />
        <Route path="/payslips" element={<Allowed id="payslips"><PayslipsPage /></Allowed>} />
        <Route path="/payslips/:id" element={<Allowed id="payslips"><PayslipDetail /></Allowed>} />
        <Route path="/evaluations" element={<Allowed id="performance"><EvaluationsPage /></Allowed>} />
        <Route path="/software" element={<SoftwarePage />} />
        <Route path="/cafeteria" element={<CafeteriaPage />} />
        <Route path="/programs" element={<Allowed id="learning"><ProgramsPage /></Allowed>} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/holidays" element={<Allowed id="holidays"><HolidaysPage /></Allowed>} />
        <Route path="/highlights" element={<HighlightsPage />} />
        <Route path="/help" element={<Allowed id="help"><HelpPage /></Allowed>} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/version" element={<VersionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
