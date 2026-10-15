import fs from "fs";

const transcript =
  "C:/Users/Gayathri/.cursor/projects/c-Users-Gayathri-OneDrive-Desktop-hrmsspare/agent-transcripts/59b48e05-634c-4366-bde8-d8464262897c/59b48e05-634c-4366-bde8-d8464262897c.jsonl";

const want = new Set([
  "peopleData.ts",
  "peopleLocal.ts",
  "platformLocal.ts",
  "rewardLocal.ts",
  "talentLocal.ts",
  "orgJobsLocal.ts",
]);

const destMap = {
  "peopleData.ts": "src/data/peopleData.ts",
  "peopleLocal.ts": "src/data/peopleLocal.ts",
  "platformLocal.ts": "src/data/platformLocal.ts",
  "rewardLocal.ts": "src/data/rewardLocal.ts",
  "talentLocal.ts": "src/data/talentLocal.ts",
  "orgJobsLocal.ts": "src/data/orgJobsLocal.ts",
};

const latest = new Map();
for (const line of fs.readFileSync(transcript, "utf8").split(/\n/)) {
  if (!line.includes("peopleData") && !line.includes("peopleLocal") && !line.includes("platformLocal") && !line.includes("rewardLocal") && !line.includes("talentLocal") && !line.includes("orgJobsLocal")) {
    continue;
  }
  if (!line.includes('"name":"Write"')) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  for (const p of obj?.message?.content || []) {
    if (p?.type !== "tool_use" || p.name !== "Write") continue;
    const fp = String(p.input?.path || "");
    const base = fp.replace(/\\/g, "/").split("/").pop();
    if (want.has(base) && typeof p.input?.contents === "string") {
      latest.set(base, p.input.contents);
    }
  }
}

for (const [base, contents] of latest) {
  const dest = destMap[base];
  fs.mkdirSync(dest.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(dest, contents);
  console.log("wrote", dest, contents.length);
}
console.log("done", latest.size);
