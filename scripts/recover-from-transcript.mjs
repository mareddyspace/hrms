import fs from "fs";

const transcript =
  "C:/Users/Gayathri/.cursor/projects/c-Users-Gayathri-OneDrive-Desktop-hrmsspare/agent-transcripts/59b48e05-634c-4366-bde8-d8464262897c/59b48e05-634c-4366-bde8-d8464262897c.jsonl";

const targets = [
  "collabData.ts",
  "dashboardMock.ts",
  "format.ts",
  "i18n.ts",
  "widgets.tsx",
  "rewardData.ts",
  "talentData.ts",
  "orgJobsData.ts",
];

const lines = fs.readFileSync(transcript, "utf8").split(/\n/);
const latest = new Map();

for (const line of lines) {
  if (!line.includes('"name":"Write"') && !line.includes('"name": "Write"')) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const parts = obj?.message?.content;
  if (!Array.isArray(parts)) continue;
  for (const p of parts) {
    if (p?.type !== "tool_use" || p.name !== "Write") continue;
    const fp = String(p.input?.path || "");
    const contents = p.input?.contents;
    if (typeof contents !== "string") continue;
    const base = fp.replace(/\\/g, "/").split("/").pop();
    if (targets.includes(base)) {
      latest.set(base, { path: fp, contents });
    }
  }
}

console.log("Found writes:");
for (const [k, v] of latest) {
  console.log(`  ${k} (${v.contents.length} chars) <- ${v.path}`);
}

const outDir = "scripts/recovered";
fs.mkdirSync(outDir, { recursive: true });
for (const [k, v] of latest) {
  fs.writeFileSync(`${outDir}/${k}`, v.contents, "utf8");
}
console.log(`Wrote ${latest.size} files to ${outDir}`);
