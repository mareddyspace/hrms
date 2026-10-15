import fs from "fs";

const transcript =
  "C:/Users/Gayathri/.cursor/projects/c-Users-Gayathri-OneDrive-Desktop-hrmsspare/agent-transcripts/59b48e05-634c-4366-bde8-d8464262897c/59b48e05-634c-4366-bde8-d8464262897c.jsonl";

const pathMap = {
  "dashboardMock.ts": "src/data/dashboardMock.ts",
  "widgets.tsx": "src/pages/dashboards/widgets.tsx",
  "talentData.ts": "src/data/talentData.ts",
  "rewardData.ts": "src/data/rewardData.ts",
  "collabData.ts": "src/data/collabData.ts",
  "i18n.ts": "src/locale/i18n.ts",
  "format.ts": "src/locale/format.ts",
  "collabLocal.ts": "src/data/collabLocal.ts",
  "platformData.ts": "src/data/platformData.ts",
  "peoplePermissions.ts": "src/data/peoplePermissions.ts",
  "rbac.ts": "src/data/rbac.ts",
  "calendarData.ts": "src/data/calendarData.ts",
  "PeopleModule.tsx": "src/pages/PeopleModule.tsx",
  "demoAccounts.ts": "src/demoAccounts.ts",
  "OrgChart.tsx": "src/components/OrgChart.tsx",
  "RoleHomes.tsx": "src/pages/dashboards/RoleHomes.tsx",
  "ui.tsx": "src/components/ui.tsx",
};

const watch = new Set(Object.keys(pathMap));
const lines = fs.readFileSync(transcript, "utf8").split(/\n/);
let applied = 0;
let failed = 0;

for (const line of lines) {
  if (!line.includes('"name":"StrReplace"')) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  for (const p of obj?.message?.content || []) {
    if (p?.type !== "tool_use" || p.name !== "StrReplace") continue;
    const base = String(p.input?.path || "")
      .replace(/\\/g, "/")
      .split("/")
      .pop();
    if (!watch.has(base)) continue;
    const oldStr = p.input?.old_string;
    const newStr = p.input?.new_string;
    if (typeof oldStr !== "string" || typeof newStr !== "string") continue;
    const dest = pathMap[base];
    let text = fs.readFileSync(dest, "utf8");
    if (!text.includes(oldStr)) {
      failed++;
      continue;
    }
    text = p.input?.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
    fs.writeFileSync(dest, text);
    applied++;
  }
}

console.log({ applied, failed });
