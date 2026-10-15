import fs from "fs";
import path from "path";

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "dist" || ent.name === "scripts") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|html|css|md)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = walk("src");
if (fs.existsSync("index.html")) files.push("index.html");

let filesChanged = 0;
for (const file of files) {
  let s = fs.readFileSync(file, "utf8");
  const orig = s;
  const guards = [];
  s = s.replace(/formatInTimeZone|timeZone|TimeZone|timezone|TIME_ZONE/g, (m) => {
    const i = guards.length;
    guards.push(m);
    return `<<TZGUARD${i}>>`;
  });
  s = s.replace(/TimeZ/g, "Infotech");
  s = s.replace(/timez\.com/gi, "infotech.com");
  s = s.replace(/@timez\b/gi, "@infotech");
  s = s.replace(/<<TZGUARD(\d+)>>/g, (_, i) => guards[Number(i)]);
  if (s !== orig) {
    fs.writeFileSync(file, s);
    filesChanged += 1;
    console.log("updated", file);
  }
}
console.log("filesChanged", filesChanged);
