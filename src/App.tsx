import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getPreferences } from "./data/preferences.ts";
import { PersonalisationPage } from "./pages/PersonalisationPage.tsx";
import { AuditLogPage } from "./pages/AuditLogPage.tsx";
import { Shell } from "./components/Shell.tsx";
import { ExpensesPage } from "./pages/ExpensesPage.tsx";
import { MailPage } from "./pages/MailPage.tsx";
import { LoginPage, TermsPage } from "./pages/InfoPages.tsx";
import { LeavePage } from "./pages/LeavePage.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { PayslipDetail, PayslipsPage } from "./pages/PayslipsPage.tsx";
import { PayPreviewPage } from "./pages/PayPreviewPage.tsx";
import { CalendarPage } from "./pages/CalendarPage.tsx";
import { OrgChartPage } from "./pages/OrgChartPage.tsx";
import { PersonProfilePage } from "./pages/PersonProfilePage.tsx";
import { AttendancePage, HolidaysPage, MyInfo, ProjectsPage } from "./pages/ProfilePages.tsx";
import { AssetsPage, CashPage, EncashmentPage, SoftwarePage } from "./pages/RequestPages.tsx";
import { MyPoliciesPage } from "./pages/MyPoliciesPage.tsx";
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
import { TicketsPage } from "./pages/TicketsPage.tsx";
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
  SkillsCareerPage,
  WorkflowsPage,
} from "./pages/TimezModules.tsx";
import { ApprovalsCenterPage } from "./pages/ApprovalsCenter.tsx";
import { AllExitsPage, MyExitPage, TeamExitsPage } from "./features/lifecycle/ExitPages.tsx";
import { MyProbationPage, ProbationReviewsPage } from "./features/lifecycle/ProbationPages.tsx";
import { ImmigrationPage } from "./features/compliance/ImmigrationPage.tsx";
import { PrivacyCentrePage } from "./features/compliance/PrivacyCentrePage.tsx";
import { GrievancePage } from "./features/compliance/GrievancePage.tsx";
import { BackgroundChecksPage } from "./features/compliance/BackgroundChecksPage.tsx";
import { EngagementSurveysPage, InternalJobBoardPage, SuccessionPage } from "./features/talentplus/index.ts";
import { BulkDataPage } from "./features/datatools/BulkDataPage.tsx";
import { ReportBuilderPage } from "./features/datatools/ReportBuilderPage.tsx";
import { ShiftRosterPage } from "./features/workforce/ShiftRosterPage.tsx";
import { OptionalHolidaysPage } from "./features/workforce/OptionalHolidaysPage.tsx";
import { ContractorsPage } from "./features/workforce/ContractorsPage.tsx";
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

const START_APPLIED_KEY = "kastech.start-page-applied";

function Guard() {
  const { signedIn, employee } = usePortal();
  const location = useLocation();
  if (!signedIn) {
    sessionStorage.removeItem(START_APPLIED_KEY);
    return <Navigate to="/login" replace />;
  }
  // Open the person's chosen start page once per sign-in.
  if (sessionStorage.getItem(START_APPLIED_KEY) !== employee.id) {
    sessionStorage.setItem(START_APPLIED_KEY, employee.id);
    const start = getPreferences(employee.id).startPage;
    if (location.pathname === "/" && start && start !== "/") return <Navigate to={start} replace />;
  }
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
        <Route path="/people/:id" element={<Allowed id="people"><PersonProfilePage /></Allowed>} />
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
        <Route path="/payroll/preview" element={<Allowed id="paypreview"><PayPreviewPage /></Allowed>} />
        <Route path="/analytics" element={<Allowed id="analytics"><AnalyticsPage /></Allowed>} />
        <Route path="/ai/copilot" element={<Allowed id="copilot"><AiCopilotPage /></Allowed>} />
        <Route path="/ai/agents" element={<Allowed id="agents"><AiAgentsPage /></Allowed>} />
        <Route path="/admin" element={<Allowed id="administration"><AdminPage /></Allowed>} />
        <Route path="/admin/countries" element={<Allowed id="administration"><CountryAdminPage /></Allowed>} />
        <Route path="/admin/audit" element={<Allowed id="auditlog"><AuditLogPage /></Allowed>} />
        <Route path="/settings/personalisation" element={<PersonalisationPage />} />
        <Route path="/settings/locale" element={<Allowed id="locale"><LocaleSettingsPage /></Allowed>} />
        <Route path="/benefits/country" element={<Allowed id="administration"><CountryBenefitsConfigPage /></Allowed>} />
        <Route path="/documents/country" element={<Allowed id="administration"><CountryDocumentsConfigPage /></Allowed>} />
        <Route path="/integrations" element={<Allowed id="integrations"><IntegrationsPage /></Allowed>} />
        <Route path="/encashment" element={<EncashmentPage />} />
        <Route path="/documents" element={<Allowed id="documents"><DocumentsPage /></Allowed>} />
        <Route path="/timesheet" element={<Allowed id="timesheet"><TimesheetPage /></Allowed>} />
        <Route path="/policies" element={<Allowed id="policies"><MyPoliciesPage /></Allowed>} />
        <Route path="/tasks" element={<Allowed id="tasks"><TasksPage /></Allowed>} />
        <Route path="/tickets" element={<Allowed id="tickets"><TicketsPage /></Allowed>} />
        <Route path="/attendance" element={<Allowed id="attendance"><AttendancePage /></Allowed>} />
        <Route path="/leave" element={<Allowed id="leave"><LeavePage /></Allowed>} />
        <Route path="/directory" element={<Allowed id="people"><DirectoryPage /></Allowed>} />
        <Route path="/directory/new" element={<Allowed id="people"><PeopleNewPage /></Allowed>} />
        <Route path="/directory/:id" element={<Allowed id="people"><PeopleDetailPage /></Allowed>} />
        <Route path="/cash" element={<CashPage />} />
        <Route path="/approvals" element={<ApprovalsCenterPage />} />
        <Route path="/chat" element={<Allowed id="messages"><ChatPage /></Allowed>} />
        <Route path="/mail" element={<Allowed id="mail"><MailPage /></Allowed>} />
        <Route path="/announcements" element={<Allowed id="announcements"><AnnouncementsPage /></Allowed>} />
        <Route path="/notifications" element={<Allowed id="notifications"><NotificationCenterPage /></Allowed>} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/expenses" element={<Allowed id="expenses"><ExpensesPage /></Allowed>} />
        <Route path="/reimbursement" element={<ReimbursementPage />} />
        <Route path="/investment" element={<Allowed id="taxdeclarations"><InvestmentProofPage /></Allowed>} />
        <Route path="/me/exit" element={<Allowed id="exit"><MyExitPage /></Allowed>} />
        <Route path="/team/exits" element={<Allowed id="teamexits"><TeamExitsPage /></Allowed>} />
        <Route path="/people/exits" element={<Allowed id="exitsadmin"><AllExitsPage /></Allowed>} />
        <Route path="/me/probation" element={<Allowed id="probation"><MyProbationPage /></Allowed>} />
        <Route path="/team/probation" element={<Allowed id="probationreviews"><ProbationReviewsPage /></Allowed>} />
        <Route path="/me/immigration" element={<Allowed id="immigration"><ImmigrationPage /></Allowed>} />
        <Route path="/me/privacy" element={<Allowed id="privacy"><PrivacyCentrePage /></Allowed>} />
        <Route path="/me/grievances" element={<Allowed id="grievances"><GrievancePage /></Allowed>} />
        <Route path="/talent/background-checks" element={<Allowed id="bgv"><BackgroundChecksPage /></Allowed>} />
        <Route path="/engagement-surveys" element={<Allowed id="engagement"><EngagementSurveysPage /></Allowed>} />
        <Route path="/succession" element={<Allowed id="succession"><SuccessionPage /></Allowed>} />
        <Route path="/internal-jobs" element={<Allowed id="internaljobs"><InternalJobBoardPage /></Allowed>} />
        <Route path="/data-tools/bulk" element={<Allowed id="bulkdata"><BulkDataPage /></Allowed>} />
        <Route path="/data-tools/reports" element={<Allowed id="reportbuilder"><ReportBuilderPage /></Allowed>} />
        <Route path="/workforce/shifts" element={<Allowed id="shifts"><ShiftRosterPage /></Allowed>} />
        <Route path="/workforce/optional-holidays" element={<Allowed id="optionalholidays"><OptionalHolidaysPage /></Allowed>} />
        <Route path="/workforce/contractors" element={<Allowed id="contractors"><ContractorsPage /></Allowed>} />
        <Route path="/payslips" element={<Allowed id="payslips"><PayslipsPage /></Allowed>} />
        <Route path="/payslips/:id" element={<Allowed id="payslips"><PayslipDetail /></Allowed>} />
        <Route path="/evaluations" element={<Allowed id="performance"><EvaluationsPage /></Allowed>} />
        <Route path="/software" element={<SoftwarePage />} />
        <Route path="/programs" element={<Allowed id="learning"><ProgramsPage /></Allowed>} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/holidays" element={<Allowed id="holidays"><HolidaysPage /></Allowed>} />
        <Route path="/help" element={<Allowed id="help"><HelpPage /></Allowed>} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
