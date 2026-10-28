import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getPreferences } from "./data/preferences.ts";

import { Shell } from "./components/Shell.tsx";

import { LoginPage } from "./pages/InfoPages.tsx";

import { EmptyState, Page } from "./components/ui.tsx";
import { accountHasNavAccess, type NavAccessId } from "./demoAccounts.ts";
import { usePortal } from "./store.tsx";

// Pages load on first visit, so the first screen opens fast.
const EmailOutboxPage = lazy(() => import("./pages/EmailOutboxPage.tsx").then((m) => ({ default: m.EmailOutboxPage })));
const LifecycleActionsPage = lazy(() => import("./features/lifecycle/LifecycleActionsPage.tsx").then((m) => ({ default: m.LifecycleActionsPage })));
const RecognitionPage = lazy(() => import("./pages/RecognitionPage.tsx").then((m) => ({ default: m.RecognitionPage })));
const TravelPage = lazy(() => import("./pages/TravelPage.tsx").then((m) => ({ default: m.TravelPage })));
const ApprovalWorkflowsPage = lazy(() => import("./pages/ApprovalWorkflowsPage.tsx").then((m) => ({ default: m.ApprovalWorkflowsPage })));
const PersonalisationPage = lazy(() => import("./pages/PersonalisationPage.tsx").then((m) => ({ default: m.PersonalisationPage })));
const AuditLogPage = lazy(() => import("./pages/AuditLogPage.tsx").then((m) => ({ default: m.AuditLogPage })));
const ExpensesPage = lazy(() => import("./pages/ExpensesPage.tsx").then((m) => ({ default: m.ExpensesPage })));
const MailPage = lazy(() => import("./pages/MailPage.tsx").then((m) => ({ default: m.MailPage })));
const TermsPage = lazy(() => import("./pages/InfoPages.tsx").then((m) => ({ default: m.TermsPage })));
const LeavePage = lazy(() => import("./pages/LeavePage.tsx").then((m) => ({ default: m.LeavePage })));
const TeamLeaveCalendarPage = lazy(() => import("./pages/TeamLeaveCalendar.tsx").then((m) => ({ default: m.TeamLeaveCalendarPage })));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })));
const PayslipDetail = lazy(() => import("./pages/PayslipsPage.tsx").then((m) => ({ default: m.PayslipDetail })));
const PayslipsPage = lazy(() => import("./pages/PayslipsPage.tsx").then((m) => ({ default: m.PayslipsPage })));
const PayPreviewPage = lazy(() => import("./pages/PayPreviewPage.tsx").then((m) => ({ default: m.PayPreviewPage })));
const CalendarPage = lazy(() => import("./pages/CalendarPage.tsx").then((m) => ({ default: m.CalendarPage })));
const OrgChartPage = lazy(() => import("./pages/OrgChartPage.tsx").then((m) => ({ default: m.OrgChartPage })));
const PersonProfilePage = lazy(() => import("./pages/PersonProfilePage.tsx").then((m) => ({ default: m.PersonProfilePage })));
const AttendancePage = lazy(() => import("./pages/ProfilePages.tsx").then((m) => ({ default: m.AttendancePage })));
const HolidaysPage = lazy(() => import("./pages/ProfilePages.tsx").then((m) => ({ default: m.HolidaysPage })));
const MyInfo = lazy(() => import("./pages/ProfilePages.tsx").then((m) => ({ default: m.MyInfo })));
const ProjectsPage = lazy(() => import("./pages/ProfilePages.tsx").then((m) => ({ default: m.ProjectsPage })));
const AssetsPage = lazy(() => import("./pages/RequestPages.tsx").then((m) => ({ default: m.AssetsPage })));
const CashPage = lazy(() => import("./pages/RequestPages.tsx").then((m) => ({ default: m.CashPage })));
const EncashmentPage = lazy(() => import("./pages/RequestPages.tsx").then((m) => ({ default: m.EncashmentPage })));
const SoftwarePage = lazy(() => import("./pages/RequestPages.tsx").then((m) => ({ default: m.SoftwarePage })));
const MyPoliciesPage = lazy(() => import("./pages/MyPoliciesPage.tsx").then((m) => ({ default: m.MyPoliciesPage })));
const EvaluationsPage = lazy(() => import("./pages/TeamPages.tsx").then((m) => ({ default: m.EvaluationsPage })));
const ProgramsPage = lazy(() => import("./pages/TeamPages.tsx").then((m) => ({ default: m.ProgramsPage })));
const TasksPage = lazy(() => import("./pages/TeamPages.tsx").then((m) => ({ default: m.TasksPage })));
const AnnouncementsPage = lazy(() => import("./pages/CollabModules.tsx").then((m) => ({ default: m.AnnouncementsPage })));
const ChatPage = lazy(() => import("./pages/CollabModules.tsx").then((m) => ({ default: m.ChatPage })));
const HelpPage = lazy(() => import("./pages/CollabModules.tsx").then((m) => ({ default: m.HelpPage })));
const NotificationCenterPage = lazy(() => import("./pages/CollabModules.tsx").then((m) => ({ default: m.NotificationCenterPage })));
const DirectoryPage = lazy(() => import("./pages/PeopleModule.tsx").then((m) => ({ default: m.DirectoryPage })));
const PeopleDetailPage = lazy(() => import("./pages/PeopleModule.tsx").then((m) => ({ default: m.PeopleDetailPage })));
const PeopleNewPage = lazy(() => import("./pages/PeopleModule.tsx").then((m) => ({ default: m.PeopleNewPage })));
const JobsPage = lazy(() => import("./pages/OrganizationJobsPages.tsx").then((m) => ({ default: m.JobsPage })));
const OrganizationPage = lazy(() => import("./pages/OrganizationJobsPages.tsx").then((m) => ({ default: m.OrganizationPage })));
const BenefitsPage = lazy(() => import("./pages/RewardModules.tsx").then((m) => ({ default: m.BenefitsPage })));
const CompensationPage = lazy(() => import("./pages/RewardModules.tsx").then((m) => ({ default: m.CompensationPage })));
const DocumentsPage = lazy(() => import("./pages/RewardModules.tsx").then((m) => ({ default: m.DocumentsPage })));
const CountryAdminPage = lazy(() => import("./pages/LocalePages.tsx").then((m) => ({ default: m.CountryAdminPage })));
const CountryBenefitsConfigPage = lazy(() => import("./pages/LocalePages.tsx").then((m) => ({ default: m.CountryBenefitsConfigPage })));
const CountryDocumentsConfigPage = lazy(() => import("./pages/LocalePages.tsx").then((m) => ({ default: m.CountryDocumentsConfigPage })));
const LocaleSettingsPage = lazy(() => import("./pages/LocalePages.tsx").then((m) => ({ default: m.LocaleSettingsPage })));
const InvestmentProofPage = lazy(() => import("./pages/PayExtrasPages.tsx").then((m) => ({ default: m.InvestmentProofPage })));
const ReimbursementPage = lazy(() => import("./pages/PayExtrasPages.tsx").then((m) => ({ default: m.ReimbursementPage })));
const TimesheetPage = lazy(() => import("./pages/TimesheetPage.tsx").then((m) => ({ default: m.TimesheetPage })));
const TicketsPage = lazy(() => import("./pages/TicketsPage.tsx").then((m) => ({ default: m.TicketsPage })));
const AdminPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.AdminPage })));
const AiAgentsPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.AiAgentsPage })));
const AiCopilotPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.AiCopilotPage })));
const AnalyticsPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.AnalyticsPage })));
const IntegrationsPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.IntegrationsPage })));
const MyTeamPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.MyTeamPage })));
const OnboardingPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.OnboardingPage })));
const PayrollPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.PayrollPage })));
const RecruitingPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.RecruitingPage })));
const SkillsCareerPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.SkillsCareerPage })));
const WorkflowsPage = lazy(() => import("./pages/TimezModules.tsx").then((m) => ({ default: m.WorkflowsPage })));
const ApprovalsCenterPage = lazy(() => import("./pages/ApprovalsCenter.tsx").then((m) => ({ default: m.ApprovalsCenterPage })));
const AllExitsPage = lazy(() => import("./features/lifecycle/ExitPages.tsx").then((m) => ({ default: m.AllExitsPage })));
const MyExitPage = lazy(() => import("./features/lifecycle/ExitPages.tsx").then((m) => ({ default: m.MyExitPage })));
const TeamExitsPage = lazy(() => import("./features/lifecycle/ExitPages.tsx").then((m) => ({ default: m.TeamExitsPage })));
const MyProbationPage = lazy(() => import("./features/lifecycle/ProbationPages.tsx").then((m) => ({ default: m.MyProbationPage })));
const ProbationReviewsPage = lazy(() => import("./features/lifecycle/ProbationPages.tsx").then((m) => ({ default: m.ProbationReviewsPage })));
const ImmigrationPage = lazy(() => import("./features/compliance/ImmigrationPage.tsx").then((m) => ({ default: m.ImmigrationPage })));
const PrivacyCentrePage = lazy(() => import("./features/compliance/PrivacyCentrePage.tsx").then((m) => ({ default: m.PrivacyCentrePage })));
const GrievancePage = lazy(() => import("./features/compliance/GrievancePage.tsx").then((m) => ({ default: m.GrievancePage })));
const BackgroundChecksPage = lazy(() => import("./features/compliance/BackgroundChecksPage.tsx").then((m) => ({ default: m.BackgroundChecksPage })));
const EngagementSurveysPage = lazy(() => import("./features/talentplus/index.ts").then((m) => ({ default: m.EngagementSurveysPage })));
const InternalJobBoardPage = lazy(() => import("./features/talentplus/index.ts").then((m) => ({ default: m.InternalJobBoardPage })));
const SuccessionPage = lazy(() => import("./features/talentplus/index.ts").then((m) => ({ default: m.SuccessionPage })));
const BulkDataPage = lazy(() => import("./features/datatools/BulkDataPage.tsx").then((m) => ({ default: m.BulkDataPage })));
const ReportBuilderPage = lazy(() => import("./features/datatools/ReportBuilderPage.tsx").then((m) => ({ default: m.ReportBuilderPage })));
const ShiftRosterPage = lazy(() => import("./features/workforce/ShiftRosterPage.tsx").then((m) => ({ default: m.ShiftRosterPage })));
const OptionalHolidaysPage = lazy(() => import("./features/workforce/OptionalHolidaysPage.tsx").then((m) => ({ default: m.OptionalHolidaysPage })));
const ContractorsPage = lazy(() => import("./features/workforce/ContractorsPage.tsx").then((m) => ({ default: m.ContractorsPage })));

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
    <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
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
        <Route path="/encashment" element={<Allowed id="encashment"><EncashmentPage /></Allowed>} />
        <Route path="/documents" element={<Allowed id="documents"><DocumentsPage /></Allowed>} />
        <Route path="/timesheet" element={<Allowed id="timesheet"><TimesheetPage /></Allowed>} />
        <Route path="/policies" element={<Allowed id="policies"><MyPoliciesPage /></Allowed>} />
        <Route path="/tasks" element={<Allowed id="tasks"><TasksPage /></Allowed>} />
        <Route path="/tickets" element={<Allowed id="tickets"><TicketsPage /></Allowed>} />
        <Route path="/attendance" element={<Allowed id="attendance"><AttendancePage /></Allowed>} />
        <Route path="/leave" element={<Allowed id="leave"><LeavePage /></Allowed>} />
        <Route path="/leave/team-calendar" element={<Allowed id="leave"><TeamLeaveCalendarPage /></Allowed>} />
        <Route path="/directory" element={<Allowed id="people"><DirectoryPage /></Allowed>} />
        <Route path="/directory/new" element={<Allowed id="people"><PeopleNewPage /></Allowed>} />
        <Route path="/directory/:id" element={<Allowed id="people"><PeopleDetailPage /></Allowed>} />
        <Route path="/cash" element={<Allowed id="cashadvance"><CashPage /></Allowed>} />
        <Route path="/travel" element={<Allowed id="travel"><TravelPage /></Allowed>} />
        <Route path="/admin/email-outbox" element={<Allowed id="emailoutbox"><EmailOutboxPage /></Allowed>} />
        <Route path="/lifecycle/actions" element={<Allowed id="lifecycleactions"><LifecycleActionsPage /></Allowed>} />
        <Route path="/recognition" element={<Allowed id="recognition"><RecognitionPage /></Allowed>} />
        <Route path="/admin/workflows-config" element={<Allowed id="workflowsconfig"><ApprovalWorkflowsPage /></Allowed>} />
        <Route path="/approvals" element={<ApprovalsCenterPage />} />
        <Route path="/chat" element={<Allowed id="messages"><ChatPage /></Allowed>} />
        <Route path="/mail" element={<Allowed id="mail"><MailPage /></Allowed>} />
        <Route path="/announcements" element={<Allowed id="announcements"><AnnouncementsPage /></Allowed>} />
        <Route path="/notifications" element={<Allowed id="notifications"><NotificationCenterPage /></Allowed>} />
        <Route path="/assets" element={<Allowed id="assets"><AssetsPage /></Allowed>} />
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
        <Route path="/people/cases" element={<Allowed id="hrcases"><GrievancePage /></Allowed>} />
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
        <Route path="/software" element={<Allowed id="software"><SoftwarePage /></Allowed>} />
        <Route path="/programs" element={<Allowed id="learning"><ProgramsPage /></Allowed>} />
        <Route path="/projects" element={<Allowed id="projects"><ProjectsPage /></Allowed>} />
        <Route path="/holidays" element={<Allowed id="holidays"><HolidaysPage /></Allowed>} />
        <Route path="/help" element={<Allowed id="help"><HelpPage /></Allowed>} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
