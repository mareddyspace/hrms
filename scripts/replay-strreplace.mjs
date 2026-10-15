import fs from "fs";
import path from "path";

const transcript =
  "C:/Users/Gayathri/.cursor/projects/c-Users-Gayathri-OneDrive-Desktop-hrmsspare/agent-transcripts/59b48e05-634c-4366-bde8-d8464262897c/59b48e05-634c-4366-bde8-d8464262897c.jsonl";

const watch = new Set([
  "PeopleModule.tsx",
  "demoAccounts.ts",
  "CollabModules.tsx",
  "CalendarPage.tsx",
  "OrgChartPage.tsx",
  "OrganizationJobsPages.tsx",
  "RewardModules.tsx",
  "LocalePages.tsx",
  "TimezModules.tsx",
  "RoleHomes.tsx",
  "OrgChart.tsx",
  "workforce.ts",
  "collabLocal.ts",
  "platformData.ts",
  "peoplePermissions.ts",
  "LocaleContext.tsx",
  "countryConfig.ts",
  "ui.tsx",
  "brand.ts",
  "Employee360View.tsx",
  "TalentModules.tsx",
  "PlatformModules.tsx",
  "calendarData.ts",
  "RegionalFilter.tsx",
  "rbac.ts",
  "Shell.tsx",
  "App.tsx",
  "nav.ts",
  "main.tsx",
  "styles.css",
  "TeamPages.tsx",
]);

const pathMap = {
  "PeopleModule.tsx": "src/pages/PeopleModule.tsx",
  "demoAccounts.ts": "src/demoAccounts.ts",
  "CollabModules.tsx": "src/pages/CollabModules.tsx",
  "CalendarPage.tsx": "src/pages/CalendarPage.tsx",
  "OrgChartPage.tsx": "src/pages/OrgChartPage.tsx",
  "OrganizationJobsPages.tsx": "src/pages/OrganizationJobsPages.tsx",
  "RewardModules.tsx": "src/pages/RewardModules.tsx",
  "LocalePages.tsx": "src/pages/LocalePages.tsx",
  "TimezModules.tsx": "src/pages/TimezModules.tsx",
  "RoleHomes.tsx": "src/pages/dashboards/RoleHomes.tsx",
  "OrgChart.tsx": "src/components/OrgChart.tsx",
  "workforce.ts": "src/workforce.ts",
  "collabLocal.ts": "src/data/collabLocal.ts",
  "platformData.ts": "src/data/platformData.ts",
  "peoplePermissions.ts": "src/data/peoplePermissions.ts",
  "LocaleContext.tsx": "src/locale/LocaleContext.tsx",
  "countryConfig.ts": "src/locale/countryConfig.ts",
  "ui.tsx": "src/components/ui.tsx",
  "brand.ts": "src/brand.ts",
  "Employee360View.tsx": "src/pages/Employee360View.tsx",
  "TalentModules.tsx": "src/pages/TalentModules.tsx",
  "PlatformModules.tsx": "src/pages/PlatformModules.tsx",
  "calendarData.ts": "src/data/calendarData.ts",
  "RegionalFilter.tsx": "src/locale/RegionalFilter.tsx",
  "rbac.ts": "src/data/rbac.ts",
  "Shell.tsx": "src/components/Shell.tsx",
  "App.tsx": "src/App.tsx",
  "nav.ts": "src/nav.ts",
  "main.tsx": "src/main.tsx",
  "styles.css": "src/styles.css",
  "TeamPages.tsx": "src/pages/TeamPages.tsx",
};

const lines = fs.readFileSync(transcript, "utf8").split(/\n/);
let applied = 0;
let skipped = 0;
let failed = 0;

for (const line of lines) {
  if (!line.includes('"name":"StrReplace"') && !line.includes('"name": "StrReplace"')) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const parts = obj?.message?.content;
  if (!Array.isArray(parts)) continue;
  for (const p of parts) {
    if (p?.type !== "tool_use" || p.name !== "StrReplace") continue;
    const fp = String(p.input?.path || "");
    const base = fp.replace(/\\/g, "/").split("/").pop();
    if (!watch.has(base)) continue;
    const oldStr = p.input?.old_string;
    const newStr = p.input?.new_string;
    const replaceAll = Boolean(p.input?.replace_all);
    if (typeof oldStr !== "string" || typeof newStr !== "string") continue;
    const dest = pathMap[base];
    if (!dest || !fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    let text = fs.readFileSync(dest, "utf8");
    if (!text.includes(oldStr)) {
      failed++;
      continue;
    }
    text = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    fs.writeFileSync(dest, text, "utf8");
    applied++;
  }
}

console.log({ applied, skipped, failed });
