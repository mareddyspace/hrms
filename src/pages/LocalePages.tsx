import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Banner,
  Card,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
} from "../components/ui.tsx";
import { type AppLanguage, type CountrySettings } from "../locale/countryConfig.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import type { CountryCode } from "../model.ts";
import { usePortal } from "../store.tsx";

export function LocaleSettingsPage() {
  const { employee, demoProfile } = usePortal();
  const {
    regionCode,
    setRegionCode,
    language,
    setLanguage,
    activeCountry,
    countries,
    t,
    languageLabels,
    formatMoney,
    formatDateTime,
    sampleSalary,
  } = useLocale();

  return (
    <Page title={t("nav.settings")} subtitle="Region, language, currency and time zone">
      <Banner message={{ tone: "ok", text: t("locale.disclaimer") }} />

      <MetricGrid>
        <MetricCard label="Signed-in identity" value={employee.fullName} hint={demoProfile.personaLabel} />
        <MetricCard label="Home country (profile)" value={employee.countryName ?? "—"} hint={employee.legalEntity} />
        <MetricCard label={t("locale.region")} value={regionCode === "ALL" ? t("country.all") : activeCountry.name} />
        <MetricCard label={t("locale.language")} value={languageLabels[language]} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="User context selectors">
          <Field label={t("locale.region")}>
            <select
              value={regionCode}
              onChange={(e) => setRegionCode(e.target.value === "ALL" ? "ALL" : (e.target.value as CountryCode))}
            >
              <option value="ALL">{t("country.all")}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("locale.language")}>
            <select value={language} onChange={(e) => setLanguage(e.target.value as AppLanguage)}>
              {(Object.keys(languageLabels) as AppLanguage[]).map((code) => (
                <option key={code} value={code}>
                  {languageLabels[code]}
                </option>
              ))}
            </select>
          </Field>
          <p className="note">
            Some screens are available in English only.
          </p>
        </Card>

        <Card title="Active region snapshot">
          <dl className="info-grid">
            <div className="info-fact"><dt>Legal entity</dt><dd>{activeCountry.legalEntity}</dd></div>
            <div className="info-fact"><dt>{t("locale.currency")}</dt><dd>{activeCountry.currency}</dd></div>
            <div className="info-fact"><dt>{t("locale.timezone")}</dt><dd>{activeCountry.timeZone}</dd></div>
            <div className="info-fact"><dt>Sample demo salary</dt><dd>{sampleSalary}</dd></div>
            <div className="info-fact"><dt>Format check</dt><dd>{formatMoney(123456)}</dd></div>
            <div className="info-fact"><dt>Local now</dt><dd>{formatDateTime(new Date().toISOString())}</dd></div>
          </dl>
        </Card>

        <Card title={t("holidays.title")}>
          <DataTable
            headers={["Date", "Holiday"]}
            rows={activeCountry.holidays.map((h) => [h.date, h.name])}
          />
        </Card>

        <Card title={t("leave.policy")}>
          <p>
            <strong>{activeCountry.leavePolicy.name}</strong>
          </p>
          <p>
            Annual days (sample): {activeCountry.leavePolicy.annualDays} · Carry-forward (sample):{" "}
            {activeCountry.leavePolicy.carryForwardDays}
          </p>
          {activeCountry.leavePolicy.note && <p className="note">{activeCountry.leavePolicy.note}</p>}
        </Card>

        <Card title={t("working.time")}>
          <p>
            {activeCountry.workingTime.workDays} · {activeCountry.workingTime.standardHours}
          </p>
          <p>Week starts: {activeCountry.workingTime.weekStart}</p>
          {activeCountry.workingTime.note && <p className="note">{activeCountry.workingTime.note}</p>}
        </Card>

        <Card title="Related country config">
          <div className="auth-shortcut-row">
            <Link className="auth-shortcut" to="/benefits/country">{t("benefits.country")}</Link>
            <Link className="auth-shortcut" to="/documents/country">{t("documents.country")}</Link>
            <Link className="auth-shortcut" to="/admin/countries">{t("admin.countries")}</Link>
            <Link className="auth-shortcut" to="/organization">Organization</Link>
            <Link className="auth-shortcut" to="/holidays">Holidays</Link>
          </div>
        </Card>
      </div>
    </Page>
  );
}

export function CountryBenefitsConfigPage() {
  const { activeCountry, t } = useLocale();
  return (
    <Page title={t("benefits.country")} subtitle={activeCountry.name}>
      <RegionalFilter />
      <Card title={activeCountry.name}>
        <DataTable
          headers={["Plan", "Category", "Summary"]}
          rows={activeCountry.benefits.map((b) => [b.name, b.category, b.summary])}
          empty={<EmptyState title="No sample plans" description="Edit via Administration → Countries." />}
        />
      </Card>
    </Page>
  );
}

export function CountryDocumentsConfigPage() {
  const { activeCountry, t } = useLocale();
  return (
    <Page title={t("documents.country")} subtitle={`${activeCountry.name} · document checklist`}>
      <RegionalFilter />
      <Card title={activeCountry.name}>
        <DataTable
          headers={["Document", "Required", "Note"]}
          rows={activeCountry.documents.map((d) => [
            d.name,
            d.required ? "Yes" : "No",
            d.note,
          ])}
        />
      </Card>
    </Page>
  );
}

/** Intl.supportedValuesOf is ES2022 — feature-detect so older engines fall back gracefully. */
function supportedValues(key: "currency" | "timeZone"): string[] | null {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  try {
    return typeof fn === "function" ? fn(key) : null;
  } catch {
    return null;
  }
}

function currencyError(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return "Currency must be a 3-letter ISO 4217 code (e.g. INR, USD).";
  const list = supportedValues("currency");
  if (list && !list.includes(code)) return `${code} is not a recognised ISO currency code.`;
  return "";
}

function timeZoneError(value: string): string {
  const zone = value.trim();
  if (!zone) return "Time zone is required.";
  const list = supportedValues("timeZone");
  if (list) return list.includes(zone) || zone === "UTC" ? "" : `${zone} is not a recognised IANA time zone.`;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return "";
  } catch {
    return `${zone} is not a recognised IANA time zone.`;
  }
}

/** Parses a day count; null when it is not a whole number >= 0. */
function parseDays(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function CountryAdminPage() {
  const { countries, updateCountrySettings, resetCountrySettings, t, formatMoney } = useLocale();
  const { demoProfile } = usePortal();
  const [code, setCode] = useState<CountryCode>(countries[0]?.code ?? "IN");
  const [tab, setTab] = useState("overview");
  const selected = countries.find((c) => c.code === code) ?? countries[0];
  // Currency / zone / day fields are edited as drafts and only saved once valid.
  const [currencyDraft, setCurrencyDraft] = useState("");
  const [zoneDraft, setZoneDraft] = useState("");
  const [annualDraft, setAnnualDraft] = useState("");
  const [carryDraft, setCarryDraft] = useState("");

  useEffect(() => {
    if (!selected) return;
    setCurrencyDraft(selected.currency);
    setZoneDraft(selected.timeZone);
    setAnnualDraft(String(selected.leavePolicy.annualDays));
    setCarryDraft(String(selected.leavePolicy.carryForwardDays));
  }, [
    selected?.code,
    selected?.currency,
    selected?.timeZone,
    selected?.leavePolicy.annualDays,
    selected?.leavePolicy.carryForwardDays,
  ]);

  const currencyMsg = currencyError(currencyDraft);
  const zoneMsg = timeZoneError(zoneDraft);
  const annualOk = parseDays(annualDraft) !== null;
  const carryOk = parseDays(carryDraft) !== null;

  const canEdit =
    demoProfile.role === "super_admin" ||
    demoProfile.role === "hr_admin" ||
    demoProfile.role === "it_admin" ||
    demoProfile.role === "admin";

  if (!canEdit) {
    return (
      <Page title={t("admin.countries")}>
        <EmptyState
          title="Not authorized"
          description="Only HR or Admin can edit country settings."
        />
        <Card title="Read-only snapshot">
          <DataTable
            headers={["Country", "Entity", "Currency", "Time zone"]}
            rows={countries.map((c) => [c.name, c.legalEntity, c.currency, c.timeZone])}
          />
        </Card>
      </Page>
    );
  }

  function patch(partial: Partial<CountrySettings>) {
    if (!selected) return;
    updateCountrySettings(selected.code, partial);
  }

  return (
    <Page
      title={t("admin.countries")}
      action={
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            if (window.confirm("Reset all country settings to their defaults? Your edits will be lost.")) {
              resetCountrySettings();
            }
          }}
        >
          Reset defaults
        </button>
      }
    >
      <FilterBar>
        <label className="filter-label">
          Country
          <select value={code} onChange={(e) => setCode(e.target.value as CountryCode)}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {!selected ? (
        <EmptyState title="No country" description="Country list missing." />
      ) : (
        <>
          <Tabs
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "holidays", label: "Holidays" },
              { id: "leave", label: "Leave & time" },
              { id: "benefits", label: "Benefits" },
              { id: "docs", label: "Documents" },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === "overview" && (
            <Card title={`${selected.name} (${selected.code})`}>
              <div className="form-grid-2">
                <Field label="Legal entity">
                  <input
                    value={selected.legalEntity}
                    onChange={(e) => patch({ legalEntity: e.target.value })}
                  />
                </Field>
                <Field label="Currency code">
                  <input
                    value={currencyDraft}
                    maxLength={3}
                    aria-invalid={!!currencyMsg}
                    onChange={(e) => {
                      const next = e.target.value.toUpperCase();
                      setCurrencyDraft(next);
                      if (!currencyError(next)) patch({ currency: next.trim() });
                    }}
                  />
                  {currencyMsg && <span className="note err">{currencyMsg}</span>}
                </Field>
                <Field label="Currency locale">
                  <input
                    value={selected.currencyLocale}
                    onChange={(e) => patch({ currencyLocale: e.target.value })}
                  />
                </Field>
                <Field label="IANA time zone">
                  <input
                    value={zoneDraft}
                    aria-invalid={!!zoneMsg}
                    onChange={(e) => {
                      const next = e.target.value;
                      setZoneDraft(next);
                      if (!timeZoneError(next)) patch({ timeZone: next.trim() });
                    }}
                  />
                  {zoneMsg && <span className="note err">{zoneMsg}</span>}
                </Field>
              </div>
              <p className="note">Format preview: {formatMoney(250000)}</p>
            </Card>
          )}

          {tab === "holidays" && (
            <Card title={t("holidays.title")}>
              <DataTable
                headers={["Date", "Name"]}
                rows={selected.holidays.map((h) => [h.date, h.name])}
              />
            </Card>
          )}

          {tab === "leave" && (
            <div className="mgr-home-grid">
              <Card title={t("leave.policy")}>
                <Field label="Policy name">
                  <input
                    value={selected.leavePolicy.name}
                    onChange={(e) =>
                      patch({ leavePolicy: { ...selected.leavePolicy, name: e.target.value } })
                    }
                  />
                </Field>
                <Field label="Annual days (sample)">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={annualDraft}
                    aria-invalid={!annualOk}
                    onChange={(e) => {
                      setAnnualDraft(e.target.value);
                      const days = parseDays(e.target.value);
                      if (days !== null) patch({ leavePolicy: { ...selected.leavePolicy, annualDays: days } });
                    }}
                  />
                  {!annualOk && <span className="note err">Enter a whole number of days, 0 or more.</span>}
                </Field>
                <Field label="Carry-forward (sample)">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={carryDraft}
                    aria-invalid={!carryOk}
                    onChange={(e) => {
                      setCarryDraft(e.target.value);
                      const days = parseDays(e.target.value);
                      if (days !== null) patch({ leavePolicy: { ...selected.leavePolicy, carryForwardDays: days } });
                    }}
                  />
                  {!carryOk && <span className="note err">Enter a whole number of days, 0 or more.</span>}
                </Field>
                <StatusBadge status="Sample only" tone="warn" />
              </Card>
              <Card title={t("working.time")}>
                <Field label="Standard hours">
                  <input
                    value={selected.workingTime.standardHours}
                    onChange={(e) =>
                      patch({ workingTime: { ...selected.workingTime, standardHours: e.target.value } })
                    }
                  />
                </Field>
                <Field label="Work days">
                  <input
                    value={selected.workingTime.workDays}
                    onChange={(e) =>
                      patch({ workingTime: { ...selected.workingTime, workDays: e.target.value } })
                    }
                  />
                </Field>
              </Card>
            </div>
          )}

          {tab === "benefits" && (
            <Card title={t("benefits.country")}>
              <DataTable
                headers={["ID", "Name", "Category", "Summary"]}
                rows={selected.benefits.map((b) => [b.id, b.name, b.category, b.summary])}
              />
            </Card>
          )}

          {tab === "docs" && (
            <Card title={t("documents.country")}>
              <DataTable
                headers={["ID", "Name", "Required", "Note"]}
                rows={selected.documents.map((d) => [d.id, d.name, d.required ? "Yes" : "No", d.note])}
              />
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
