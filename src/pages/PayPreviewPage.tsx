import { useMemo, useState } from "react";
import { Card, Field, Page } from "../components/ui.tsx";
import { legalEntityFor, money } from "../countryPay.ts";
import { DEMO_ACCOUNTS } from "../demoAccounts.ts";
import { unusedLeaveFor } from "../data/finalPay.ts";
import { asDetailView, finalSettlementFor, generatePayslips, type PayslipInput } from "../data/payslipGenerator.ts";
import { getExitDetails, getPerson, listPeople } from "../data/peopleLocal.ts";
import { getTaxRegime } from "../data/taxRegime.ts";
import { getExitState } from "../features/lifecycle/exitStore.ts";
import type { CountryCode } from "../model.ts";
import { formatShortDate, parseISODate, todayISO, toPayslipView } from "../model.ts";
import { usePortal } from "../store.tsx";
import { TEAMMATES } from "../workforce.ts";
import { PayslipBody, PayslipHead } from "./PayslipsPage.tsx";

/** Only HR (which owns compensation & benefits) may see other people's pay. */
const PREVIEW_ROLES = new Set(["hr", "hr_admin"]);

interface PreviewPerson {
  id: string;
  name: string;
  group: string;
  role: string;
  countryCode: CountryCode;
  countryName: string;
  legalEntity: string;
  location?: string;
  nationality?: string;
  employmentStatus?: string;
  joiningDate?: string;
  exitDate?: string;
}

function previewPeople(): PreviewPerson[] {
  const fromDirectory = (id: string) => getPerson(id);
  const personas: PreviewPerson[] = DEMO_ACCOUNTS.map((a) => {
    const p = fromDirectory(a.id);
    return {
      id: a.id,
      name: `${a.fullName} · ${a.personaLabel}`,
      group: "Personas",
      role: a.role,
      countryCode: (a.countryCode ?? "IN") as CountryCode,
      countryName: a.countryName ?? "India",
      legalEntity: a.legalEntity ?? legalEntityFor(a.countryCode),
      location: a.location,
      nationality: p?.nationality,
      employmentStatus: p?.employmentStatus,
      joiningDate: p?.dateOfJoining,
      exitDate: p ? getExitDetails(p).exitDate : undefined,
    };
  });
  const teammates: PreviewPerson[] = TEAMMATES.map((t) => {
    const p = fromDirectory(t.id);
    return {
      id: t.id,
      name: t.name,
      group: "Ram's team",
      role: "employee",
      countryCode: "IN",
      countryName: "India",
      legalEntity: legalEntityFor("IN"),
      location: p?.location ?? "Bengaluru",
      nationality: p?.nationality ?? "Indian",
      employmentStatus: p?.employmentStatus,
      joiningDate: p?.dateOfJoining ?? t.dateOfJoining,
      exitDate: p ? getExitDetails(p).exitDate : undefined,
    };
  });
  const taken = new Set([...personas, ...teammates].map((p) => p.id));
  const all = listPeople().filter((p) => !taken.has(p.id) && p.employmentStatus !== "Terminated");
  const picks = [
    ...all.filter((p) => p.employmentStatus === "Contractor").slice(0, 3),
    ...(["GB", "AU", "CA", "DE", "AE", "SA", "US"] as const)
      .map((code) => all.find((p) => p.countryCode === code && p.employmentStatus === "Active"))
      .filter((p): p is NonNullable<typeof p> => Boolean(p)),
  ];
  const directory: PreviewPerson[] = picks.map((p) => ({
    id: p.id,
    name: `${p.fullName} · ${p.location}${p.employmentStatus === "Contractor" ? " · contractor" : ""}`,
    group: "Directory",
    role: "employee",
    countryCode: p.countryCode as CountryCode,
    countryName: p.countryName,
    legalEntity: p.legalEntity || legalEntityFor(p.countryCode as CountryCode),
    location: p.location,
    nationality: p.nationality,
    employmentStatus: p.employmentStatus,
    joiningDate: p.dateOfJoining,
    exitDate: getExitDetails(p).exitDate,
  }));
  return [...personas, ...teammates, ...directory];
}

function monthTitle(month: string) {
  return parseISODate(`${month}-01`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function PayPreviewPage() {
  const { employee, state } = usePortal();
  const allowed = PREVIEW_ROLES.has(employee.role);
  const people = useMemo(() => (allowed ? previewPeople() : []), [allowed]);
  const [personId, setPersonId] = useState(() => people[0]?.id ?? "");
  const [month, setMonth] = useState("");
  const person = people.find((p) => p.id === personId);

  const input = useMemo((): PayslipInput | null => {
    if (!person) return null;
    const exit = getExitState().cases.find(
      (c) => c.employeeId === person.id && (c.status === "Accepted" || c.status === "Completed"),
    );
    return {
      employeeId: person.id,
      role: person.role,
      countryCode: person.countryCode,
      joiningDate: person.joiningDate,
      lastWorkingDay: exit?.lastWorkingDay ?? getPerson(person.id)?.lastWorkingDay ?? person.exitDate,
      unusedLeaveDays: exit ? unusedLeaveFor(exit, state) : undefined,
      today: todayISO(),
      location: person.location,
      nationality: person.nationality,
      employmentStatus: person.employmentStatus,
      regime: getTaxRegime(person.id),
      investmentProofs: state.investmentProofs,
      timesheets: state.timesheets,
      orgTimesheets: state.orgTimesheets,
    };
  }, [person, state]);
  const slips = useMemo(() => (input ? generatePayslips(input).map((slip) => ({ ...slip, ...toPayslipView(slip) })) : []), [input]);
  const settlement = useMemo(() => (input ? finalSettlementFor(input) : null), [input]);

  if (!allowed) {
    return (
      <Page title="Pay preview">
        <Card>
          <p className="empty">Pay preview is limited to HR.</p>
        </Card>
      </Page>
    );
  }

  const slip = slips.find((s) => s.month === month) ?? slips[0];
  const detail = slip ? asDetailView(slip) : null;
  const groups = [...new Set(people.map((p) => p.group))];

  return (
    <Page title="Pay preview" subtitle="Read only">
      <Card>
        <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <Field label="Person">
            <select
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
                setMonth("");
              }}
            >
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {people
                    .filter((p) => p.group === g)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Month">
            <select value={slip?.month ?? ""} onChange={(event) => setMonth(event.target.value)} disabled={!slips.length}>
              {slips.map((s) => (
                <option key={s.month} value={s.month}>
                  {monthTitle(s.month)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>
      {settlement && (
        <Card title="Final settlement">
          <p className="muted" style={{ margin: 0 }}>
            Last working day {formatShortDate(settlement.lastWorkingDay)} · {settlement.paidDays} of {settlement.totalDays} days paid ·
            leave encashment {settlement.encashmentDays} days ({money(settlement.encashment, settlement.currency)}) · gross{" "}
            {money(settlement.gross, settlement.currency)} · net {money(settlement.net, settlement.currency)}
            {settlement.estimate ? " · estimate" : ""}
          </p>
        </Card>
      )}
      {person && slip && detail ? (
        <Card className="pay-sheet">
          <p className="muted" style={{ margin: "0 0 12px" }}>
            {person.name} · gross {money(slip.gross, slip.currency)} · deductions {money(slip.deductionTotal, slip.currency)} · net{" "}
            {money(slip.net, slip.currency)}
          </p>
          <PayslipHead payslip={slip} person={person} />
          <PayslipBody payslip={slip} />
        </Card>
      ) : (
        <Card>
          <p className="empty">No payslips for this person yet.</p>
        </Card>
      )}
    </Page>
  );
}
