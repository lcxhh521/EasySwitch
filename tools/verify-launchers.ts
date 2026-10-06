#!/usr/bin/env node
// Checks, on this machine, the launchers EasySwitch has for the agents that are installed (npm run verify-launchers).
// It runs each program's --help and looks for the flags EasySwitch uses. It sends no task, but each program
// can still read configuration or credentials during startup. Run only when actual CLI execution is authorized.
import { LAUNCHERS } from "../core/src/agent-launch.ts";
import { AGENTS, detectAgents } from "../core/src/agents.ts";
import { verifyLauncher } from "../core/src/verify-launchers.ts";

const detected = await detectAgents(AGENTS);
const lines: string[] = [];
let good = 0; let bad = 0; let skipped = 0;
for (const a of detected) {
  const l = LAUNCHERS[a.id];
  if (!l) continue;
  if (!a.installed || !a.where) { skipped++; lines.push(`- ${a.name}（${a.id}）：没装，跳过`); continue; }
  if (a.where.endsWith(".app")) { skipped++; lines.push(`- ${a.name}（${a.id}）：桌面应用，这个检查只看命令行程序，跳过`); continue; }
  const verdicts = await verifyLauncher(a.where, l);
  for (const v of verdicts) {
    if (!v.helpOk) { bad++; lines.push(`✗ ${a.name} ${v.form}：没能运行 --help（${v.error}）`); continue; }
    if (v.missing.length) { bad++; lines.push(`✗ ${a.name} ${v.form}：帮助里找不到这些参数：${v.missing.join(" ")}（我们用到了 ${v.checked.join(" ")}）`); }
    else { good++; lines.push(`✓ ${a.name} ${v.form}：用到的参数都在帮助里（${v.checked.join(" ") || "没有参数"}）`); }
  }
  lines.push(`    还要你亲眼看一下：用 es ${a.id} 启动后，它自己的模型菜单里有没有列出多个模型（${l.verified ? "这个启动器本来就跑通过" : "这个启动器还没在真实程序上跑过"}）`);
}
console.log(lines.join("\n"));
console.log(`\n${good} 个通过，${bad} 个有问题，${skipped} 个跳过。`);
console.log("说明：这只是看帮助文字里有没有这些参数，是个粗查：找不到不一定是错（有的参数不写在帮助里），找到也不等于真的好用；以实际用 es <名字> 启动一次为准。把输出贴回来就行，里面不含任何密钥。");
process.exit(bad ? 1 : 0);
