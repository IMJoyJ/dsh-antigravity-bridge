import fs from "node:fs";
import path from "node:path";

const base = path.resolve('..');
const plugins = fs.existsSync(base) ? fs.readdirSync(base).filter(p => !p.startsWith(".") && p !== "node_modules") : [];

for (const plugin of plugins) {
  const src = path.join(base, plugin, "src");
  if (fs.existsSync(src)) {
    const files = fs.readdirSync(src, { recursive: true }).filter(f => typeof f === 'string' && (f.endsWith(".ts") || f.endsWith(".js")));
    for (const f of files) {
      const full = path.join(src, f);
      const content = fs.readFileSync(full, "utf8");
      if (content.includes("steer") || content.includes("notify") || content.includes("session") || content.includes("emit") || content.includes("broadcast")) {
        console.log(`Match in ${plugin}/${f}`);
        const lines = content.split("\n");
        lines.forEach((l, idx) => {
          if (/steer|notify|session\.|emit|notice/i.test(l) && !/node_modules/.test(l)) {
            console.log(`  L${idx+1}: ${l.trim().slice(0, 120)}`);
          }
        });
      }
    }
  }
}
