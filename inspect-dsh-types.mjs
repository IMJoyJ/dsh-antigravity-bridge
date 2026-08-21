import fs from "node:fs";
import path from "node:path";

const p1 = path.resolve("../dsh-sidechain/node_modules/@deepseek-ai/dsh-agent");
const p2 = path.resolve("../node_modules/@deepseek-ai");

console.log("Searching dsh-agent definitions...");
function findDts(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findDts(full);
    else if (e.name.endsWith(".d.ts")) {
      console.log("Found:", full);
      const txt = fs.readFileSync(full, "utf8");
      if (txt.includes("steer") || txt.includes("inject") || txt.includes("followup") || txt.includes("notice")) {
        console.log("=== Matching snippet in", e.name, "===");
        txt.split("\n").forEach((line, i) => {
          if (/steer|inject|followup|notice|message/i.test(line)) {
            console.log(`  ${i+1}: ${line.slice(0, 100)}`);
          }
        });
      }
    }
  }
}

findDts(p1);
findDts(p2);

