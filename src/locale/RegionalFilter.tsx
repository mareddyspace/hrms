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

/** Optional one-line scope hint — keep short; region picker carries the real control. */
export function LocaleContextBanner() {
  const { activeCountry, regionCode } = useLocale();
  const label = regionCode === "ALL" ? "All countries" : activeCountry.name;
  return <p className="note locale-banner">Showing demo data for {label}.</p>;
}
