import { hostname } from "node:os";
import { join } from "node:path";
import { hostFileDecision } from "../args";
import { saveRemote } from "../actions/remote";
import type { Check, Ctx } from "../context";
import { writePrivate } from "../files";
import { pushHistory } from "../history";
import { markerName, parseMarker, type Probe } from "../remote-probe";
import { endStep } from "../report";
import { t } from "../ui/i18n";
import { hostFile } from "./host";

/**
 * Step 5, saving: the host file (asked when it is new or different), cc-remote's folder and this
 * machine's marker on the central server, and the prompt's history. Orca Server doesn't read shell
 * profiles, so the host file is what makes Orca's chats find the server.
 */
export async function stepSave(ctx: Ctx, host: string, base: string[], probe: Probe, machineId: string): Promise<void> {
  const label = t("Saving settings", "保存设置");
  ctx.progress.begin(label);
  const checks: Check[] = [];
  const changed: string[] = [];

  const current = hostFile(ctx);
  const decision = hostFileDecision(ctx.mode, current, host);
  let save = decision === "do";
  if (decision === "ask-yes") {
    const question = current
      ? t(`Replace the default server ${current} with ${host} (~/.config/cc-remote/host)?`, `把默认服务器 ${current} 换成 ${host}（~/.config/cc-remote/host）？`)
      : t(`Save ${host} as the default server (~/.config/cc-remote/host)?`, `把 ${host} 保存为默认服务器（~/.config/cc-remote/host）？`);
    save = await ctx.prompt.yesNo(question, true);
  }
  if (save) {
    writePrivate(join(ctx.config, "host"), `${host}\n`);
    ctx.record({ id: "local.hostfile", previous: current ?? null, value: host });
    ctx.saved.push("~/.config/cc-remote/host");
    changed.push(t("host file", "host 文件"));
  } else if (decision !== "skip") {
    checks.push({ id: "S1", status: "warn", label: "host", detail: t("not saved: Orca and other apps won't find the server without ~/.config/cc-remote/host", "未保存：没有 ~/.config/cc-remote/host，Orca 和其他应用找不到服务器") });
  }
  if (ctx.env.CC_REMOTE_HOST && ctx.env.CC_REMOTE_HOST.trim() !== host) {
    checks.push({ id: "S1", status: "info", label: "host", detail: t(`CC_REMOTE_HOST=${ctx.env.CC_REMOTE_HOST} overrides the host file in your shell`, `你的 shell 中 CC_REMOTE_HOST=${ctx.env.CC_REMOTE_HOST} 优先于 host 文件`) });
  }

  const machine = markerName(hostname());
  if (!machine) {
    checks.push({ id: "S2", status: "warn", label: t("machine", "机器"), detail: t("this hostname can't name a marker file; no marker written", "这个主机名不能用作标记文件名；未写入标记") });
  } else {
    const old = parseMarker(probe.sections.marker);
    const result = await saveRemote(ctx, base, host, machine, machineId, old);
    if (result === "created") {
      ctx.record({ id: "remote.marker", previous: null, value: `~/.cc-remote/machines/${machine}.json`, host });
      changed.push(t(`~/.cc-remote/machines/${machine} on ${host}`, `${host} 上的 ~/.cc-remote/machines/${machine}`));
    } else if (result === "foreign") {
      checks.push({ id: "S2", status: "warn", label: t("machine", "机器"), detail: t("the marker belongs to another machine and was left alone", "标记属于另一台机器，未改动") });
    } else if (result !== "updated") {
      checks.push({ id: "S2", status: "warn", label: "~/.cc-remote", detail: t(`couldn't prepare ~/.cc-remote on ${host} (${result})`, `无法在 ${host} 上准备 ~/.cc-remote（${result}）`) });
    }
  }

  pushHistory(ctx.home, "host", host);
  endStep(ctx, "save", checks, label, changed.length ? changed.join(", ") : t("nothing changed", "没有变化"));
}
