import { Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell.tsx";
import { ExpensesPage } from "./pages/ExpensesPage.tsx";
import { LoginPage, TermsPage, VersionPage } from "./pages/InfoPages.tsx";
import { LeavePage } from "./pages/LeavePage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { PayslipDetail, PayslipsPage } from "./pages/PayslipsPage.tsx";
import { CalendarPage } from "./pages/CalendarPage.tsx";
import { OrgChartPage } from "./pages/OrgChartPage.tsx";
import { AttendancePage, EmsPage, HighlightsPage, HolidaysPage, MyInfo, ProjectsPage } from "./pages/ProfilePages.tsx";
import { AssetsPage, CabPage, CafeteriaPage, CashPage, EncashmentPage, SoftwarePage } from "./pages/RequestPages.tsx";
import { ConvertPage, FilesPage, FormsPage, PoliciesPage, SignPage } from "./pages/ResourcePages.tsx";
import { EvaluationsPage, ProgramsPage, TasksPage } from "./pages/TeamPages.tsx";
import {
  AnnouncementsPage,
  ApprovalsPage,
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
import { usePortal } from "./store.tsx";

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
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/org-chart" element={<OrgChartPage />} />
        <Route path="/team" element={<MyTeamPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/organization" element={<OrganizationPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/recruiting" element={<RecruitingPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/skills" element={<SkillsCareerPage />} />
        <Route path="/compensation" element={<CompensationPage />} />
        <Route path="/benefits" element={<BenefitsPage />} />
        <Route path="/payroll" element={<PayrollPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/ai/copilot" element={<AiCopilotPage />} />
        <Route path="/ai/agents" element={<AiAgentsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/countries" element={<CountryAdminPage />} />
        <Route path="/settings/locale" element={<LocaleSettingsPage />} />
        <Route path="/benefits/country" element={<CountryBenefitsConfigPage />} />
        <Route path="/documents/country" element={<CountryDocumentsConfigPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/roadmap" element={<RoadmapPage />} />
        <Route path="/encashment" element={<EncashmentPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/forms" element={<FormsPage />} />
        <Route path="/convert" element={<ConvertPage />} />
        <Route path="/sign" element={<SignPage />} />
        <Route path="/timesheet" element={<TimesheetPage />} />
        <Route path="/ems" element={<EmsPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/policies" element={<PoliciesPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/leave" element={<LeavePage />} />
        <Route path="/directory" element={<DirectoryPage />} />
        <Route path="/directory/new" element={<PeopleNewPage />} />
        <Route path="/directory/:id" element={<PeopleDetailPage />} />
        <Route path="/directory/new" element={<PeopleNewPage />} />
        <Route path="/directory/:id" element={<PeopleDetailPage />} />
        <Route path="/cash" element={<CashPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/announcements" element={<AnnouncementsPage />} />
        <Route path="/notifications" element={<NotificationCenterPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/cab" element={<CabPage />} />
        <Route path="/expenses" element={<ExpensesPage />} />
        <Route path="/reimbursement" element={<ReimbursementPage />} />
        <Route path="/investment" element={<InvestmentProofPage />} />
        <Route path="/payslips" element={<PayslipsPage />} />
        <Route path="/payslips/:id" element={<PayslipDetail />} />
        <Route path="/evaluations" element={<EvaluationsPage />} />
        <Route path="/software" element={<SoftwarePage />} />
        <Route path="/cafeteria" element={<CafeteriaPage />} />
        <Route path="/programs" element={<ProgramsPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/holidays" element={<HolidaysPage />} />
        <Route path="/highlights" element={<HighlightsPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/version" element={<VersionPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
