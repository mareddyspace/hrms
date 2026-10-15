import { useLocale } from "./LocaleContext.tsx";
import type { CountryCode } from "../model.ts";

export function RegionalFilter({
  label,
  includeAll = true,
}: {
  label?: string;
  includeAll?: boolean;
}) {
  const { regionCode, setRegionCode, countries, t } = useLocale();
  return (
    <label className="filter-label">
      {label ?? t("common.filter")}
      <select
        value={regionCode}
        onChange={(e) => {
          const v = e.target.value;
          setRegionCode(v === "ALL" ? "ALL" : (v as CountryCode));
        }}
      >
        {includeAll && <option value="ALL">{t("country.all")}</option>}
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name} ({c.code})
          </option>
        ))}
      </select>
    </label>
  );
}

export function LocaleContextBanner() {
  const { t, activeCountry, regionCode, formatDateTime } = useLocale();
  return (
    <p className="note locale-banner">
      <strong>{t("locale.viewOnly")}:</strong>{" "}
      {regionCode === "ALL" ? t("country.all") : `${activeCountry.name} · ${activeCountry.currency} · ${activeCountry.timeZone}`}
      {" · "}
      {t("locale.disclaimer")} · Now ({activeCountry.timeZone}): {formatDateTime(new Date().toISOString())}
    </p>
  );
}
