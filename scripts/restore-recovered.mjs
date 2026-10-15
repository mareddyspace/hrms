import fs from "fs";
import path from "path";

const map = {
  "brand.ts": "src/brand.ts",
  "workforce.ts": "src/workforce.ts",
  "demoAccounts.ts": "src/demoAccounts.ts",
  "ui.tsx": "src/components/ui.tsx",
  "OrgChart.tsx": "src/components/OrgChart.tsx",
  "peoplePermissions.ts": "src/data/peoplePermissions.ts",
  "collabLocal.ts": "src/data/collabLocal.ts",
  "platformData.ts": "src/data/platformData.ts",
  "rbac.ts": "src/data/rbac.ts",
  "calendarData.ts": "src/data/calendarData.ts",
  "countryConfig.ts": "src/locale/countryConfig.ts",
  "LocaleContext.tsx": "src/locale/LocaleContext.tsx",
  "RegionalFilter.tsx": "src/locale/RegionalFilter.tsx",
  "RoleHomes.tsx": "src/pages/dashboards/RoleHomes.tsx",
  "PeopleModule.tsx": "src/pages/PeopleModule.tsx",
  "Employee360View.tsx": "src/pages/Employee360View.tsx",
  "CollabModules.tsx": "src/pages/CollabModules.tsx",
  "CalendarPage.tsx": "src/pages/CalendarPage.tsx",
  "OrgChartPage.tsx": "src/pages/OrgChartPage.tsx",
  "OrganizationJobsPages.tsx": "src/pages/OrganizationJobsPages.tsx",
  "RewardModules.tsx": "src/pages/RewardModules.tsx",
  "LocalePages.tsx": "src/pages/LocalePages.tsx",
  "TimezModules.tsx": "src/pages/TimezModules.tsx",
  "TalentModules.tsx": "src/pages/TalentModules.tsx",
  "PlatformModules.tsx": "src/pages/PlatformModules.tsx",
};

const root = process.cwd();
for (const [srcName, destRel] of Object.entries(map)) {
  const from = path.join(root, "scripts/recovered", srcName);
  const to = path.join(root, destRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log("restored", destRel);
}
