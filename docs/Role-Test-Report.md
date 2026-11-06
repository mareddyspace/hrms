# TimeZ HRMS — 8-User Test Against the Design Document

Date: 5 November 2026 · Tested on a scratch copy of the sample data (500 employees and 8 sign-in accounts). The live
database and the live site were not touched.

**What I tested against:** your Word document "HRMS Roadmap and Execution and sample company step by step process
document.docx" (on your Desktop, in Downloads and in Documents; all copies are identical). The sections I used:
- §7 Home dashboard
- §9 People
- §11 Organization
- §13 Recruiting
- §17 Leave
- §18 Timesheet
- §22 Compensation
- §25 Workflows
- §27–30 Roles, access model and permission model
- §49 Payroll boundary
- §55 Audit
- §56 Employee data security
- §57 AI governance
- §63–66 Experiences and administration
- Notifications and communication

**How**
1. **Server rules:** a script signed in as each of the 8 people and tried every rule against the real API: 204 checks.
   Every result is in [Role-Test-Results.csv](Role-Test-Results.csv): section, check, person, expected, actual, pass.
2. **Portal:** the portal ran locally against that scratch data. I signed in as each person with the sign-in page's
   "Fill" buttons and recorded their menu and home page.

**Result: 204 of 204 server checks pass.** The portal showed no errors. The only gaps are the ones already on the fix
list; they are listed at the end.

---

## 1. The 8 people

| Person | Role | Country | Reports to |
|---|---|---|---|
| Babu Menon | Employee | India | Ram |
| Priya Nair | Employee | India | Ram |
| Oliver Hughes | Employee | UK | Ram |
| Ram Krishnan | Manager | India | Jordan |
| Farhan Ali | HR Admin | India | Jordan |
| Sophie Clark | Recruiter | US | Farhan |
| Jordan Blake | Executive (CEO) | US | — |
| Alex Morgan | Super Admin | UK | Jordan |

## 2. Who can see Babu's information (§28, §29, §56, §22)

✅ = allowed, ⛔ = refused by the server.

| What | Babu | Priya | Oliver | Ram | Farhan | Sophie | Jordan | Alex |
|---|---|---|---|---|---|---|---|---|
| Leave balance | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Leave history | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Attendance | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Timesheet entries | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Goals | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Learning | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| Documents | ✅ | ⛔ | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ |
| **Salary records (§22)** | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ✅ |
| **Reveal mobile number (§29)** | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ✅ |
| Profile view (§9) | full | basic | basic | full | full | basic | full | full |
| Leave balance of an unrelated UK employee | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ✅ |

**What this means**
- **Employees** see only their own records. Colleagues get a basic directory card, as the document says: "Employees
  should not automatically have access to other employee information".
- **Ram (manager)** sees his team's leave, attendance, timesheets, goals, learning and documents, but **not their
  salary or private phone number**. The document says managers see compensation "only when explicitly permitted", and
  Ram has no such permission.
- **Jordan (CEO)** sees people in his reporting line like a senior manager, with no salary and no personal details.
- **Farhan (HR)** sees everyone, matching the document's "HR Admin → Global HR scope".
- **Alex (super admin)** sees everything, because that is what you decided on 3 November. ⚠ This is **wider than the
  document**, which gives the super admin "Platform scope" and keeps compensation "highly restricted". It is your call;
  I'm only pointing out the difference.

## 3. Self-service (§63)

Every one of the 8 can open their own leave balance and their own payslip list. ✅ 16 of 16.

## 4. Workflows (§17, §18, §25)

| Rule from the document | Result |
|---|---|
| Babu applies for leave | ✅ |
| It reaches his manager Ram's approvals inbox | ✅ |
| Priya's (India) and Oliver's (UK) leave also reach Ram | ✅ |
| Babu, Priya and Sophie cannot approve Babu's leave | ✅ refused |
| Rejecting needs a reason | ✅ refused without one |
| Ram approves | ✅ |
| Ram cannot approve his own leave | ✅ refused |
| Ram's own leave goes to *his* manager, Jordan, who can approve it | ✅ |
| Babu submits a timesheet day; Ram approves it; Babu and Priya cannot | ✅ |
| The leave decision is audited with who, what, when and before/after values (§55) | ✅ |

## 5. Notifications and communication

| Rule | Result |
|---|---|
| Ram is told when Babu asks for leave | ✅ |
| Babu is told when his leave is decided | ✅ |
| Babu can start a chat with Oliver and send a message | ✅ |
| Oliver sees that chat; Priya, who isn't in it, does not | ✅ |
| Everyone can read announcements and their own notifications | ✅ all 8 |
| Only HR (Farhan) and the super admin (Alex) can post a company announcement | ✅ the other 6 are refused |

## 6. Recruiting, organization, payroll, administration, AI

| Rule | Who is allowed (all match) |
|---|---|
| See candidates (§13) | Sophie, Farhan, Ram (as hiring manager), Jordan (only for the job openings he approves), Alex |
| Create an organization unit (§11, §66) | Farhan, Alex |
| Open payroll runs (§49: the payroll tab is for integration) | Farhan, Jordan (second approver), Alex |
| Control center, account list, audit trail (§55, §66) | Alex only |
| AI summary of a person (§57) | Only for people the asker may see. Babu can't summarise Ram; Sophie and Priya can't summarise Babu. |

## 7. Home page and menu per person (§7)

| Person | Home page | Menu groups |
|---|---|---|
| Babu, Priya, Oliver | Employee home: today's summary, pending requests, policy acknowledgements | Me, Time & pay, My workplace |
| Ram | Manager home: my day, team alerts, new joiners, quick links | adds Team, People & organization, Talent, Performance & learning, Copilot |
| Farhan | HR home: pending HR actions, country and department headcount, hiring, coverage risks, leave and attendance trends, onboarding | everything, including Admin |
| Sophie | Recruiter home: active candidates, shortcuts | Me, Time & pay, My workplace, People & organization, Talent, Performance & learning, Copilot |
| Jordan | Executive home: country distribution, business units, departments | adds Admin (payroll approval and report builder only) |
| Alex | Admin home: country distribution, joiners vs exits, platform | **every group** |

Each role has its own home page, as §7 asks.

## 8. Gaps against the document (already on the fix list)

1. **Alex's menu and home page are not a platform console yet.** He sees every employee and HR menu group, and his
   home page has employee-style "My day" and workforce charts. Step 3 of the Super Admin proposal fixes this; it was
   stopped before any change.
2. **Alex's data access is wider than §27/§22 describe.** This follows your decision; see section 2.
3. **Jordan's menu shows "Exits", but the server refuses that list for executives.** Low; listed in the audit report.
4. **Payroll tax figures are still worked out in the browser.** This is within §49's boundary (no payroll processing in
   V1), so it is not a rule break, but it is still open on the audit list.
5. **Not covered by this test:**
   - SSO (§55); there is no SSO provider to test with.
   - AI decisions on hiring, ratings or pay (§57). I checked that the AI can only draft and summarise within access; no
     endpoint lets the AI make those decisions.

## 9. Re-running

The script is at
`C:\Users\Gayathri\AppData\Local\Temp\claude\76716c1e42037d14\7ee33cf3-05b1-4eed-8dbf-962a6676409f\scratchpad\role_matrix.py`.
Run it from `backend/` with `.venv/Scripts/python.exe <script> <output.csv>`. It always uses a throwaway database.
