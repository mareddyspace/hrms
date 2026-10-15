import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ProfileEditForm } from "../components/ProfileEditForm.tsx";
import { Card, Page, ProjectFacts } from "../components/ui.tsx";
import type { PersonRecord } from "../data/peopleData.ts";
import { getPerson, listPeople, subscribePeople } from "../data/peopleLocal.ts";
import {
  isPrimaryWeeklyOffLabel,
  isWeeklyOffDate,
  scheduleForEmployee,
} from "../data/workSchedule.ts";
import { formatLongDate, monthCells, monthLabel, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Employee360View } from "./Employee360View.tsx";

export { AttendancePage } from "./AttendanceModule.tsx";

function usePeople() {
  return useSyncExternalStore(subscribePeople, listPeople, listPeople);
}

export function MyInfo() {
  const { employee, demoProfile, currentProjects } = usePortal();
  const people = usePeople();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(employee);
  const [photoFile, setPhotoFile] = useState("");

  const person: PersonRecord | undefined = useMemo(() => {
    return (
      getPerson(employee.id) ||
      people.find((p) => p.employeeCode === employee.employeeCode) ||
      people.find((p) => p.email === employee.email)
    );
  }, [employee, people]);

  useEffect(() => {
    if (!editing) setDraft(employee);
  }, [employee, editing]);

  function readPhoto(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return;
        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        setPhotoFile(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const selfPerson: PersonRecord = person ?? {
    id: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    email: employee.email,
    personalEmail: employee.email,
    mobile: employee.mobile,
    photo: photoFile || employee.photo,
    gender: "",
    dateOfJoining: "2024-11-04",
    employmentType: employee.employmentType,
    employmentStatus: "Active",
    designation: employee.designation,
    jobFamily: employee.department ?? "Engineering",
    jobProfileId: "JP-SELF",
    positionId: "POS-SELF",
    grade: "L4",
    department: employee.department ?? "Engineering",
    division: `${employee.department ?? "Engineering"} Delivery`,
    businessUnit: `Infotech ${employee.countryName ?? "India"}`,
    costCenter: "CC-IN-1",
    location: employee.location ?? "Bengaluru",
    countryCode: employee.countryCode ?? "IN",
    countryName: employee.countryName ?? "India",
    legalEntity: employee.legalEntity ?? "Infotech India Pvt Ltd",
    managerId: "emp-ram",
    managerName: "Ram Krishnan",
    availability: "In Office",
    timeZone: employee.timeZone,
    currency: employee.currency ?? "INR",
    address: employee.address,
  };

  return (
    <Page
      title="My Profile"
      subtitle="Employee 360 · personal, employment, organization, skills, time, goals, documents, and pay (by permission)"
      action={
        <button
          className="btn-ghost"
          type="button"
          onClick={() => {
            setDraft(employee);
            setPhotoFile("");
            setEditing((open) => !open);
          }}
        >
          {editing ? "Cancel edit" : "Edit contact details"}
        </button>
      }
    >
      {editing && (
        <Card title="Edit contact details">
          <p className="note">
            Projects on file: {currentProjects.map((p) => p.name).join(", ") || "—"}
          </p>
          <ProfileEditForm
            draft={draft}
            setDraft={(next) =>
              setDraft((prev) => ({
                ...prev,
                ...(typeof next === "function" ? next(prev) : next),
              }))
            }
            photoFile={photoFile}
            onReadPhoto={readPhoto}
            onCancel={() => {
              setEditing(false);
              setPhotoFile("");
              setDraft(employee);
            }}
            onSaved={() => {
              setEditing(false);
              setPhotoFile("");
            }}
          />
        </Card>
      )}
      <Employee360View person={{ ...selfPerson, photo: photoFile || selfPerson.photo }} viewer={demoProfile} selfId={employee.id} />
    </Page>
  );
}

export function EmsPage() {
  const { employee, currentProjects, previousProjects } = usePortal();
  return (
    <Page title="Employee EMS" subtitle="Employment snapshot from the same profile used on the home screen.">
      <Card>
        <table className="data">
          <tbody>
            <tr>
              <th>Employee code</th>
              <td>{employee.employeeCode}</td>
            </tr>
            <tr>
              <th>Name</th>
              <td>{employee.fullName}</td>
            </tr>
            <tr>
              <th>Type</th>
              <td>{employee.employmentType}</td>
            </tr>
            <tr>
              <th>Designation</th>
              <td>{employee.designation}</td>
            </tr>
            <tr>
              <th>Shift</th>
              <td>
                {employee.shiftName} · {employee.shiftHours}
              </td>
            </tr>
            <tr>
              <th>Current assignment</th>
              <td>{currentProjects.map((project) => project.name).join(", ") || "—"}</td>
            </tr>
            <tr>
              <th>Previous assignment</th>
              <td>{previousProjects.map((project) => project.name).join(", ") || "—"}</td>
            </tr>
          </tbody>
        </table>
        <p className="note">Department, manager, and joining date will come from the employee master when the database is connected.</p>
      </Card>
    </Page>
  );
}

export function ProjectsPage() {
  const { currentProjects, previousProjects, hoursFor } = usePortal();
  const [mode, setMode] = useState<"current" | "previous">("current");
  const list = mode === "current" ? currentProjects : previousProjects;
  const [selectedId, setSelectedId] = useState(currentProjects[0]?.id ?? "");
  const selected = list.find((project) => project.id === selectedId) ?? list[0];
  return (
    <Page title="My projects" subtitle={`${currentProjects.length} current and ${previousProjects.length} previous. Hours come from your timesheets.`}>
      <Card>
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button className={mode === "current" ? "btn" : "btn-ghost"} type="button" onClick={() => setMode("current")}>
            Current
          </button>
          <button className={mode === "previous" ? "btn" : "btn-ghost"} type="button" onClick={() => setMode("previous")}>
            Previous
          </button>
        </div>
        <div className="projects-layout" style={{ marginTop: 14 }}>
          <div>
            {list.map((project) => (
              <button
                key={project.id}
                className={project.id === selected?.id ? "project-pill active" : "project-pill"}
                onClick={() => setSelectedId(project.id)}
              >
                {project.name}
              </button>
            ))}
            {list.length === 0 && <p className="empty">No projects in this list.</p>}
          </div>
          {selected && <ProjectFacts project={selected} hours={hoursFor(selected.id)} />}
        </div>
      </Card>
    </Page>
  );
}

export function HolidaysPage() {
  const today = todayISO();
  const { state, employee } = usePortal();
  const { holidays } = state;
  const initial = new Date();
  const [cursor, setCursor] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const cells = monthCells(cursor.year, cursor.month);
  const byDate = useMemo(() => new Map(holidays.map((holiday) => [holiday.date, holiday])), [holidays]);
  const schedule = useMemo(
    () =>
      scheduleForEmployee({
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        countryCode: employee.countryCode,
      }),
    [employee.shiftName, employee.shiftHours, employee.countryCode],
  );

  function move(delta: number) {
    const next = new Date(cursor.year, cursor.month + delta, 1);
    setCursor({ year: next.getFullYear(), month: next.getMonth() });
  }

  return (
    <Page title="Company holiday calendar" subtitle="Company-wide holidays for everyone. Use this calendar to plan leave around office closures.">
      <Card>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h2 className="card-title" style={{ margin: 0 }}>
            {monthLabel(cursor.year, cursor.month)}
          </h2>
          <span className="form-actions">
            <button className="btn-ghost" type="button" onClick={() => move(-1)}>
              Previous
            </button>
            <button className="btn-ghost" type="button" onClick={() => move(1)}>
              Next
            </button>
          </span>
        </div>
        <div className="cal">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div key={label} className="cal-head">
              {label}
            </div>
          ))}
          {cells.map((date, index) => {
            if (!date) return <div key={`blank-${index}`} />;
            const holiday = byDate.get(date);
            const weeklyOff = isWeeklyOffDate(date, schedule.weeklyOffDays);
            const showOff =
              !holiday && weeklyOff && isPrimaryWeeklyOffLabel(date, schedule.weeklyOffDays);
            return (
              <div
                key={date}
                className={`day ${holiday ? "holiday" : weeklyOff ? "weekend" : ""} ${date === today ? "today" : ""}`}
                title={holiday ? holiday.name : weeklyOff ? "Weekly Off" : undefined}
              >
                <strong>{Number(date.slice(-2))}</strong>
                {holiday ? holiday.name : showOff ? "Weekly Off" : ""}
              </div>
            );
          })}
        </div>
      </Card>
    </Page>
  );
}

export function HighlightsPage() {
  const { state, leaveTable, counts } = usePortal();
  const { holidays } = state;
  const today = todayISO();
  const next = holidays.find((holiday) => holiday.date >= today);
  return (
    <Page title="Highlights" subtitle="A reading of leave, holidays, and pending actions. Nothing new is stored here.">
      <div className="stat-grid">
        <div className="stat">
          <span>Next holiday</span>
          <strong style={{ fontSize: 18 }}>{next ? next.name : "None left in 2026"}</strong>
          <span>{next ? formatLongDate(next.date) : "The published list is complete."}</span>
        </div>
        {leaveTable.map((row) => (
          <div className="stat" key={row.code}>
            <span>{row.name} balance</span>
            <strong>{row.balance}</strong>
            <span>
              {row.utilized} used · {row.pending} pending
            </span>
          </div>
        ))}
        <div className="stat">
          <span>Open actions</span>
          <strong>{counts.tasks + counts.timesheet + counts.evaluation + counts.programs}</strong>
          <span>Tasks, timesheets, evaluations, programs</span>
        </div>
      </div>
    </Page>
  );
}
