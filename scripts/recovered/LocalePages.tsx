import { useState } from "react";
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
import { POLICY_DISCLAIMER, type AppLanguage, type CountrySettings } from "../locale/countryConfig.ts";
import { LocaleContextBanner, RegionalFilter } from "../locale/RegionalFilter.tsx";
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
    <Page title={t("nav.settings")} subtitle="Demo region, language, currency and time zone — shared TimeZ app">
      <Banner message={{ tone: "ok", text: t("locale.disclaimer") }} />
      <LocaleContextBanner />

      <MetricGrid>
        <MetricCard label="Signed-in identity" value={employee.fullName} hint={`${demoProfile.personaLabel} · unchanged by region`} />
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
            Full UI translation is not claimed. Only keys with reliable copy are translated; other screens stay English.
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
          <p className="note">{POLICY_DISCLAIMER}</p>
        </Card>

        <Card title={t("leave.policy")}>
          <p>
            <strong>{activeCountry.leavePolicy.name}</strong>
          </p>
          <p>
            Annual days (sample): {activeCountry.leavePolicy.annualDays} · Carry-forward (sample):{" "}
            {activeCountry.leavePolicy.carryForwardDays}
          </p>
          <p className="note">{activeCountry.leavePolicy.note}</p>
        </Card>

        <Card title={t("working.time")}>
          <p>
            {activeCountry.workingTime.workDays} · {activeCountry.workingTime.standardHours}
          </p>
          <p>Week starts: {activeCountry.workingTime.weekStart}</p>
          <p className="note">{activeCountry.workingTime.note}</p>
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
    <Page title={t("benefits.country")} subtitle={`${activeCountry.name} · sample catalog`}>
      <LocaleContextBanner />
      <Banner message={{ tone: "ok", text: POLICY_DISCLAIMER }} />
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
    <Page title={t("documents.country")} subtitle={`${activeCountry.name} · sample document checklist`}>
      <LocaleContextBanner />
      <Banner message={{ tone: "ok", text: POLICY_DISCLAIMER }} />
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

export function CountryAdminPage() {
  const { countries, updateCountrySettings, resetCountrySettings, t, formatMoney } = useLocale();
  const { demoProfile } = usePortal();
  const [code, setCode] = useState<CountryCode>(countries[0]?.code ?? "IN");
  const [tab, setTab] = useState("overview");
  const selected = countries.find((c) => c.code === code) ?? countries[0];

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
          description="Only HR Admin, IT Admin, or Super Admin personas can edit mock country settings in this demo."
        />
        <LocaleContextBanner />
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
      subtitle="Inspect and edit mock country settings (localStorage) — one shared TimeZ app"
      action={
        <button type="button" className="btn-ghost" onClick={() => resetCountrySettings()}>
          Reset defaults
        </button>
      }
    >
      <Banner message={{ tone: "ok", text: POLICY_DISCLAIMER }} />
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
                  <input value={selected.currency} onChange={(e) => patch({ currency: e.target.value })} />
                </Field>
                <Field label="Currency locale">
                  <input
                    value={selected.currencyLocale}
                    onChange={(e) => patch({ currencyLocale: e.target.value })}
                  />
                </Field>
                <Field label="IANA time zone">
                  <input value={selected.timeZone} onChange={(e) => patch({ timeZone: e.target.value })} />
                </Field>
              </div>
              <p className="note">Format preview: {formatMoney(250000)} · Headcount band stays on workforce mock.</p>
            </Card>
          )}

          {tab === "holidays" && (
            <Card title={t("holidays.title")}>
              <DataTable
                headers={["Date", "Name"]}
                rows={selected.holidays.map((h) => [h.date, h.name])}
              />
              <p className="note">Holiday rows are sample data. Edit JSON via reset or extend in code for demos.</p>
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
                    value={selected.leavePolicy.annualDays}
                    onChange={(e) =>
                      patch({
                        leavePolicy: {
                          ...selected.leavePolicy,
                          annualDays: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Carry-forward (sample)">
                  <input
                    type="number"
                    value={selected.leavePolicy.carryForwardDays}
                    onChange={(e) =>
                      patch({
                        leavePolicy: {
                          ...selected.leavePolicy,
                          carryForwardDays: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
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
