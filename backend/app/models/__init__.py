from app.models.activity import AuditLog, Notification
from app.models.approvals import ApprovalDecision, ApprovalInstance, WorkflowDefinition
from app.models.attendance import AttendanceCorrection, AttendanceSession
from app.models.leave import Holiday, LeavePolicy, LeaveRequest, LeaveType
from app.models.people import AccessScope, Account, Country, Employee, EmployeeAssignment, RefreshToken
from app.models.timesheets import Project, ProjectMember, TimesheetEntry, TimesheetWeek

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
from app.models.recruiting import Candidate, CandidateStage, Interview, Offer, Requisition  # noqa: E402
from app.models.onboarding import Joiner, OnboardingTask, OnboardingTemplateTask  # noqa: E402
from app.models.performance import CheckIn, DevAction, Goal, PerfReview, Reviewer360, ReviewCycle  # noqa: E402
from app.models.learning import Certification, Course, EmployeeSkill, Enrollment  # noqa: E402

__all__ += [
    "Candidate", "CandidateStage", "Certification", "CheckIn", "Course", "DevAction", "EmployeeSkill", "Enrollment",
    "Goal", "Interview", "Joiner", "Offer", "OnboardingTask", "OnboardingTemplateTask", "PerfReview", "Requisition",
    "Reviewer360", "ReviewCycle",
]

# HR cases, service desk, engagement & recognition, shifts, admin platform (migration 0006)
from app.models.cases import HrCase, HrCaseFile, HrCaseNote  # noqa: E402
from app.models.desk import DeskTicket, DeskTicketComment, DeskTicketFile  # noqa: E402
from app.models.engagement import (  # noqa: E402
    EngagementParticipant, EngagementResponse, EngagementSurvey, Kudos, KudosLike, RewardItem, RewardRedemption,
)
from app.models.shifts import CoverageMinimum, RosterShift, RosterWeek, ShiftSwap, ShiftType  # noqa: E402
from app.models.platform import (  # noqa: E402
    AccountDataScope, AiSetting, EmailChannelSwitch, EmailOutboxItem, IntegrationConnector, IntegrationQuarantine,
    IntegrationRun, PageAccessOverride, PlatformSetting, ReminderLog,
)

__all__ += [
    "AccountDataScope", "AiSetting", "CoverageMinimum", "DeskTicket", "DeskTicketComment", "DeskTicketFile",
    "EmailChannelSwitch", "EmailOutboxItem", "EngagementParticipant", "EngagementResponse", "EngagementSurvey",
    "HrCase", "HrCaseFile", "HrCaseNote", "IntegrationConnector", "IntegrationQuarantine", "IntegrationRun", "Kudos",
    "KudosLike", "PageAccessOverride", "PlatformSetting", "ReminderLog", "RewardItem", "RewardRedemption",
    "RosterShift", "RosterWeek", "ShiftSwap", "ShiftType",
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

__all__ += ["LeaveCarryForward"]

# Approval delegation (migration 0009)
from app.models.delegations import ApprovalDelegation  # noqa: E402

__all__ += ["ApprovalDelegation"]

# Exits: resignation, termination, retirement, end of contract (migration 0014)
from app.models.exits import ExitCase  # noqa: E402

__all__ += ["ExitCase"]
