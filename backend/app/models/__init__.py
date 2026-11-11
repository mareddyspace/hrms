from app.models.activity import AuditLog, Notification
from app.models.approvals import ApprovalDecision, ApprovalInstance, WorkflowDefinition
from app.models.attendance import AttendanceCorrection, AttendanceSession
from app.models.leave import Holiday, LeavePolicy, LeaveRequest, LeaveType
from app.models.people import AccessScope, Account, Country, Employee, EmployeeAssignment, RefreshToken
from app.models.timesheets import Project, ProjectMember, TimesheetDay, TimesheetEntry, TimesheetWeek

__all__ = [
    "AccessScope",
    "Account",
    "ApprovalDecision",
    "ApprovalInstance",
    "AttendanceCorrection",
    "AttendanceSession",
    "AuditLog",
    "Country",
    "Employee",
    "EmployeeAssignment",
    "Holiday",
    "LeavePolicy",
    "LeaveRequest",
    "LeaveType",
    "Notification",
    "Project",
    "ProjectMember",
    "RefreshToken",
    "TimesheetDay",
    "TimesheetEntry",
    "TimesheetWeek",
    "WorkflowDefinition",
]

# Expenses, travel, lifecycle actions, organization & positions (migration 0003)
from app.models.travel import TravelRequest  # noqa: E402
from app.models.expenses import ExpenseClaim, ExpenseReceipt  # noqa: E402
from app.models.lifecycle import LifecycleAction  # noqa: E402
from app.models.org import JobFamily, JobProfile, OrgUnit, Position  # noqa: E402

__all__ += ["ExpenseClaim", "ExpenseReceipt", "JobFamily", "JobProfile", "LifecycleAction", "OrgUnit", "Position", "TravelRequest"]

# Recruiting, onboarding, performance, learning (migration 0004)
from app.models.recruiting import Candidate, CandidateStage, Interview, JobPosting, Offer, Requisition  # noqa: E402
from app.models.onboarding import Joiner, OnboardingTask, OnboardingTemplateTask  # noqa: E402
from app.models.performance import CheckIn, DevAction, Goal, PerfFeedback, PerfReview, Reviewer360, ReviewCycle  # noqa: E402
from app.models.learning import Certification, Course, EmployeeSkill, Enrollment  # noqa: E402

__all__ += [
    "Candidate", "CandidateStage", "Certification", "CheckIn", "Course", "DevAction", "EmployeeSkill", "Enrollment",
    "Goal", "Interview", "JobPosting", "Joiner", "Offer", "OnboardingTask", "OnboardingTemplateTask", "PerfReview", "Requisition",
    "PerfFeedback", "Reviewer360", "ReviewCycle",
]

# HR cases, service desk, engagement & recognition, shifts, admin platform (migration 0006)
from app.models.cases import HrCase, HrCaseFile, HrCaseNote  # noqa: E402
from app.models.desk import DeskTicket, DeskTicketComment, DeskTicketFile  # noqa: E402
from app.models.engagement import (  # noqa: E402
    EngagementParticipant, EngagementResponse, EngagementSurvey, Kudos, KudosLike, RewardItem, RewardRedemption,
)
from app.models.shifts import CoverageMinimum, RosterShift, RosterWeek, ShiftAvailability, ShiftSwap, ShiftType  # noqa: E402
from app.models.platform import (  # noqa: E402
    AccountDataScope, AiSetting, EmailChannelSwitch, EmailOutboxItem, IntegrationConnector, IntegrationQuarantine,
    IntegrationRun, PageAccessOverride, PlatformSetting, ReminderLog,
)

__all__ += [
    "AccountDataScope", "AiSetting", "CoverageMinimum", "DeskTicket", "DeskTicketComment", "DeskTicketFile",
    "EmailChannelSwitch", "EmailOutboxItem", "EngagementParticipant", "EngagementResponse", "EngagementSurvey",
    "HrCase", "HrCaseFile", "HrCaseNote", "IntegrationConnector", "IntegrationQuarantine", "IntegrationRun", "Kudos",
    "KudosLike", "PageAccessOverride", "PlatformSetting", "ReminderLog", "RewardItem", "RewardRedemption",
    "RosterShift", "RosterWeek", "ShiftAvailability", "ShiftSwap", "ShiftType",
]

# Compensation, benefits, documents & letters (migration 0005)
from app.models.compensation import CompBonus, CompensationRecord, CompProposal, CompReviewCycle, GradeBand  # noqa: E402
from app.models.benefits import (  # noqa: E402
    Beneficiary, BenefitDependent, BenefitDependentCoverage, BenefitEnrollment, BenefitPlan, BenefitWindow, LifeEvent,
)
from app.models.documents import (  # noqa: E402
    DocumentVersion, EmployeeDocument, LetterIssue, LetterRequest, LetterTemplate, PolicyAcknowledgment,
)

__all__ += [
    "Beneficiary", "BenefitDependent", "BenefitDependentCoverage", "BenefitEnrollment", "BenefitPlan", "BenefitWindow",
    "CompBonus", "CompensationRecord", "CompProposal", "CompReviewCycle", "DocumentVersion", "EmployeeDocument",
    "GradeBand", "LetterIssue", "LetterRequest", "LetterTemplate", "LifeEvent", "PolicyAcknowledgment",
]

# Skills library and careers (migration 0012)
from app.models.career import CareerPath, CareerProfile, Skill  # noqa: E402

__all__ += ["CareerPath", "CareerProfile", "Skill"]

# Effective-dated org history (migration 0013)
from app.models.org import OrgChangeVersion  # noqa: E402

__all__ += ["OrgChangeVersion"]

# Profile correction requests (migration 0008)
from app.models.profile import ProfileCorrection  # noqa: E402

__all__ += ["ProfileCorrection"]

# Leave rules: year-end carry-forward (migration 0011)
from app.models.leave import LeaveCarryForward  # noqa: E402
from app.models.leave import OptionalHoliday  # noqa: E402
__all__ += ["OptionalHoliday"]

__all__ += ["LeaveCarryForward"]

# Approval delegation (migration 0009)
from app.models.delegations import ApprovalDelegation  # noqa: E402

__all__ += ["ApprovalDelegation"]

# Exits: resignation, termination, retirement, end of contract (migration 0014)
from app.models.exits import ExitCase  # noqa: E402

__all__ += ["ExitCase"]

# Cash advances, leave encashment, software catalogue and licences (migration 0015)
from app.models.self_service import CashAdvance, EncashmentRequest, SoftwareRequest, SoftwareTitle  # noqa: E402

__all__ += ["CashAdvance", "EncashmentRequest", "SoftwareRequest", "SoftwareTitle"]

# Policies HR writes and publishes, with versions (migration 0018)
from app.models.policies import HrPolicy, HrPolicyVersion  # noqa: E402

__all__ += ["HrPolicy", "HrPolicyVersion"]

# Work tickets shared between people: owner, sub-owner, deadline, tasks, activity (migration 0020)
from app.models.tickets import Ticket, TicketCategory, TicketEvent, TicketTask, WorkAttachment  # noqa: E402

__all__ += ["Ticket", "TicketCategory", "TicketEvent", "TicketTask", "WorkAttachment"]

# Shared chat, mail, tasks, announcements and calendar events (migration 0022)
from app.models.sharing import (  # noqa: E402
    Announcement, AnnouncementRead, CalendarAttendee, CalendarEvent, ChatConversation, ChatMember, ChatMessage,
    MailMessage, MailRecipient, SharedTask,
)

__all__ += ["Announcement", "AnnouncementRead", "CalendarAttendee", "CalendarEvent", "ChatConversation", "ChatMember",
            "ChatMessage", "MailMessage", "MailRecipient", "SharedTask"]

# Payroll runs, bank details, overtime / comp-off, compliance due dates (migration 0023)
from app.models.payroll_runs import (  # noqa: E402
    ComplianceDueDate, EmployeeBankDetail, OvertimeRequest, PayrollRun, PayrollRunLine,
)

__all__ += ["ComplianceDueDate", "EmployeeBankDetail", "OvertimeRequest", "PayrollRun", "PayrollRunLine"]

# Project details (milestones, tasks, updates, documents, activity) and roster comp-off credits (migration 0025)
from app.models.projects import (  # noqa: E402
    CompOffCredit, ProjectActivity, ProjectDocument, ProjectMilestone, ProjectPost, ProjectTask,
)

__all__ += ["CompOffCredit", "ProjectActivity", "ProjectDocument", "ProjectMilestone", "ProjectPost", "ProjectTask"]

# Tax declarations with proofs; benefit plan documents (migration 0026)
from app.models.benefits import BenefitPlanDocument  # noqa: E402
from app.models.tax_declarations import TaxDeclaration, TaxDeclarationDocument, TaxDeclarationWindow  # noqa: E402

__all__ += ["BenefitPlanDocument", "TaxDeclaration", "TaxDeclarationDocument", "TaxDeclarationWindow"]

# Mail drafts, announcement category / pin, help desk subcategory / contact preference and FAQ votes (migration 0027)
from app.models.desk import DeskFaqVote  # noqa: E402
from app.models.sharing import MailDraft  # noqa: E402

__all__ += ["DeskFaqVote", "MailDraft"]

# Request comments / more-info requests / supporting files; expense, travel, cash advance and document extras (migration 0028)
from app.models.request_extras import RequestAttachment, RequestComment  # noqa: E402

__all__ += ["RequestAttachment", "RequestComment"]

# Saved reports (server-side report builder) and contract extension requests (migration 0038)
from app.models.insights import ContractExtension, SavedReport  # noqa: E402

__all__ += ["ContractExtension", "SavedReport"]

# Employee experience: assets and asset requests, immigration documents, privacy consents / requests / retention (migration 0037)
from app.models.experience import (  # noqa: E402
    Asset, AssetRequest, ImmigrationDocument, PrivacyConsent, PrivacyRequest, RetentionRule,
)

__all__ += ["Asset", "AssetRequest", "ImmigrationDocument", "PrivacyConsent", "PrivacyRequest", "RetentionRule"]
