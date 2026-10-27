import { useState } from "react";
import { Link } from "react-router-dom";
import {
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
import { type AppLanguage } from "../locale/countryConfig.ts";
import { RegionalFilter } from "../locale/RegionalFilter.tsx";
import { useLocale } from "../locale/LocaleContext.tsx";
import { formatShortDate, holidaysForCountry, type CountryCode } from "../model.ts";
import { usePortal } from "../store.tsx";

/** HR and platform admins may open the country reference page. */
const COUNTRY_REFERENCE_ROLES = ["hr", "hr_admin", "hrbp", "admin", "super_admin", "it_admin"];

export function LocaleSettingsPage() {
  const { employee, demoProfile, state } = usePortal();
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
    userTimeZone,
  } = useLocale();
  const holidays = holidaysForCountry(state.holidays, activeCountry.code);
  const canSeeCountryReference = COUNTRY_REFERENCE_ROLES.includes(demoProfile.role);

  return (
    <Page title={t("nav.settings")}>

      <MetricGrid>
        <MetricCard label="Signed in as" value={employee.fullName} hint={demoProfile.personaLabel} />
        <MetricCard label="Home country" value={employee.countryName ?? "—"} hint={employee.legalEntity} />
        <MetricCard label={t("locale.region")} value={regionCode === "ALL" ? t("country.all") : activeCountry.name} />
        <MetricCard label={t("locale.timezone")} value={userTimeZone} />
      </MetricGrid>

      <div className="mgr-home-grid">
        <Card title="Your settings">
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
        </Card>

        <Card title={`${activeCountry.name} at a glance`}>
          <dl className="info-grid">
            <div className="info-fact"><dt>Legal entity</dt><dd>{activeCountry.legalEntity}</dd></div>
            <div className="info-fact"><dt>{t("locale.currency")}</dt><dd>{activeCountry.currency}</dd></div>
            <div className="info-fact"><dt>Office time zone</dt><dd>{activeCountry.timeZone}</dd></div>
            <div className="info-fact"><dt>Number format</dt><dd>{formatMoney(123456)}</dd></div>
            <div className="info-fact"><dt>Your time now</dt><dd>{formatDateTime(new Date().toISOString())}</dd></div>
          </dl>
        </Card>

        <Card title={t("holidays.title")}>
          <DataTable
            headers={["Date", "Holiday"]}
            rows={holidays.map((h) => [formatShortDate(h.date), h.name])}
            empty={<p className="note">No holidays listed.</p>}
          />
        </Card>

        <Card title={t("working.time")}>
          <p>
            {activeCountry.workingTime.workDays} · {activeCountry.workingTime.standardHours}
          </p>
          <p>Week starts: {activeCountry.workingTime.weekStart}</p>
          {activeCountry.workingTime.note && <p className="note">{activeCountry.workingTime.note}</p>}
        </Card>

        <Card title="Related">
          <div className="auth-shortcut-row">
            <Link className="auth-shortcut" to="/benefits/country">{t("benefits.country")}</Link>
            <Link className="auth-shortcut" to="/documents/country">{t("documents.country")}</Link>
            {canSeeCountryReference && (
              <Link className="auth-shortcut" to="/admin/countries">{t("admin.countries")}</Link>
            )}
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
          empty={<EmptyState title="No plans listed" description="Ask HR for details." />}
        />
      </Card>
    </Page>
  );
}

export function CountryDocumentsConfigPage() {
  const { activeCountry, t } = useLocale();
  return (
    <Page title={t("documents.country")} subtitle={activeCountry.name}>
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

/**
 * Country reference. These settings are not wired into leave balances, holidays or pay elsewhere in
 * the app, so the page is read-only rather than pretending edits take effect.
 */
export function CountryAdminPage() {
  const { countries, t } = useLocale();
  const { demoProfile } = usePortal();
  const [code, setCode] = useState<CountryCode>(countries[0]?.code ?? "IN");
  const [tab, setTab] = useState("overview");
  const selected = countries.find((c) => c.code === code) ?? countries[0];

  if (!COUNTRY_REFERENCE_ROLES.includes(demoProfile.role)) {
    return (
      <Page title={t("admin.countries")}>
        <EmptyState title="Not authorized" description="HR and admins only." />
      </Page>
    );
  }

  return (
    <Page title={`${t("admin.countries")} · Reference`} subtitle="Read-only">
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
              { id: "leave", label: "Leave & time" },
              { id: "benefits", label: "Benefits" },
              { id: "docs", label: "Documents" },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === "overview" && (
            <Card title={`${selected.name} (${selected.code})`}>
              <dl className="info-grid">
                <div className="info-fact"><dt>Legal entity</dt><dd>{selected.legalEntity}</dd></div>
                <div className="info-fact"><dt>Currency</dt><dd>{selected.currency}</dd></div>
                <div className="info-fact"><dt>Office time zone</dt><dd>{selected.timeZone}</dd></div>
              </dl>
            </Card>
          )}

          {tab === "leave" && (
            <div className="mgr-home-grid">
              <Card title={t("leave.policy")}>
                <p><strong>{selected.leavePolicy.name}</strong></p>
                <p>
                  Annual days: {selected.leavePolicy.annualDays} · Carry-forward: {selected.leavePolicy.carryForwardDays}
                </p>
                {selected.leavePolicy.note && <p className="note">{selected.leavePolicy.note}</p>}
                <StatusBadge status="Reference" tone="info" literal />
              </Card>
              <Card title={t("working.time")}>
                <p>{selected.workingTime.workDays} · {selected.workingTime.standardHours}</p>
                <p>Week starts: {selected.workingTime.weekStart}</p>
              </Card>
            </div>
          )}

          {tab === "benefits" && (
            <Card title={t("benefits.country")}>
              <DataTable
                headers={["Name", "Category", "Summary"]}
                rows={selected.benefits.map((b) => [b.name, b.category, b.summary])}
              />
            </Card>
          )}

          {tab === "docs" && (
            <Card title={t("documents.country")}>
              <DataTable
                headers={["Name", "Required", "Note"]}
                rows={selected.documents.map((d) => [d.name, d.required ? "Yes" : "No", d.note])}
              />
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
