/**
 * Which package manager this machine has and the exact commands that install what cc-remote uses
 * locally (ripgrep, git, the ssh client, bash). Pure: the caller says what the machine looks like.
 * The manager comes from /etc/os-release (ID, then ID_LIKE), confirmed by finding it on PATH, and
 * otherwise from probing the usual ones in order. Extended from remote-harness's pkg_install_hint.
 */
export type Pkg = "ripgrep" | "git" | "ssh" | "bash";
export type Manager = "apt-get" | "dnf" | "yum" | "pacman" | "zypper" | "apk" | "brew" | "port" | "winget" | "scoop" | "choco";

export type Machine = {
  platform: NodeJS.Platform;
  /** os-release ID and ID_LIKE, lower case. */
  id?: string;
  like: string[];
  root: boolean;
  has(command: string): boolean;
};

/**
 * How to install some packages: the commands to run in order, as argv lists and as one line to
 * show, or only advice (`steps` empty) where cc-remote must not install anything itself.
 */
export type Plan = { pkgs: Pkg[]; manager?: Manager; steps: string[][]; text: string };

/** ID and ID_LIKE from the text of /etc/os-release. */
export function parseOsRelease(text: string): { id?: string; like: string[] } {
  const value = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return { id: value("ID") || undefined, like: (value("ID_LIKE") ?? "").split(/\s+/).filter(Boolean) };
}

const FAMILY: [RegExp, Manager[]][] = [
  [/^(debian|ubuntu|linuxmint|pop|raspbian|elementary|kali|zorin|neon)$/, ["apt-get"]],
  [/^fedora$/, ["dnf", "yum"]],
  [/^(rhel|centos|rocky|almalinux|ol|amzn)$/, ["dnf", "yum"]],
  [/^(arch|manjaro|endeavouros|artix)$/, ["pacman"]],
  [/^(opensuse.*|sles|sled|suse)$/, ["zypper"]],
  [/^alpine$/, ["apk"]],
];

const PROBE: Record<string, Manager[]> = {
  linux: ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"],
  darwin: ["brew", "port"],
  win32: ["winget", "scoop", "choco"],
};

/** The package manager to use, if the machine has one we know. */
export function chooseManager(m: Machine): Manager | undefined {
  if (m.platform === "linux") {
    for (const name of [m.id, ...m.like]) {
      const family = name ? FAMILY.find(([re]) => re.test(name))?.[1] : undefined;
      const found = family?.find((manager) => m.has(manager));
      if (found) return found;
    }
  }
  return (PROBE[m.platform] ?? PROBE.linux!).find((manager) => m.has(manager));
}

/** RHEL and its rebuilds ship ripgrep in EPEL only. */
const needsEpel = (m: Machine) => [m.id, ...m.like].some((n) => n && /^(rhel|centos|rocky|almalinux|ol)$/.test(n)) && m.id !== "fedora";

const NAMES: Record<Manager, Partial<Record<Pkg, string>>> = {
  "apt-get": { ripgrep: "ripgrep", git: "git", ssh: "openssh-client", bash: "bash" },
  dnf: { ripgrep: "ripgrep", git: "git", ssh: "openssh-clients", bash: "bash" },
  yum: { ripgrep: "ripgrep", git: "git", ssh: "openssh-clients", bash: "bash" },
  pacman: { ripgrep: "ripgrep", git: "git", ssh: "openssh", bash: "bash" },
  zypper: { ripgrep: "ripgrep", git: "git", ssh: "openssh-clients", bash: "bash" },
  apk: { ripgrep: "ripgrep", git: "git", ssh: "openssh-client", bash: "bash" },
  brew: { ripgrep: "ripgrep" },
  port: { ripgrep: "ripgrep" },
  winget: { ripgrep: "BurntSushi.ripgrep.MSVC", git: "Git.Git" },
  scoop: { ripgrep: "ripgrep", git: "git" },
  choco: { ripgrep: "ripgrep", git: "git" },
};

/** The command line for one package, package name last where the manager allows merging. */
function command(manager: Manager, name: string, sudo: string[], unattended: boolean): string[] {
  switch (manager) {
    case "apt-get": return [...sudo, "apt-get", "install", "-y", name];
    case "dnf": case "yum": case "zypper": return [...sudo, manager, "install", "-y", name];
    case "pacman": return [...sudo, "pacman", "-S", "--needed", "--noconfirm", name];
    case "apk": return [...sudo, "apk", "add", name];
    case "brew": return ["brew", "install", name];
    case "port": return [...sudo, "port", "install", name];
    case "scoop": return ["scoop", "install", name];
    case "choco": return ["choco", "install", name, "-y"];
    case "winget": return ["winget", "install", "--id", name, "-e", ...(unattended ? ["--accept-source-agreements", "--accept-package-agreements"] : [])];
  }
}

const show = (steps: string[][]) => steps.map((s) => s.join(" ")).join(" && ");
const advice = (pkgs: Pkg[], text: string): Plan => ({ pkgs, steps: [], text });

/**
 * How to install a package here. `unattended` is a non-interactive `--install`: `sudo -n`, which
 * fails rather than asking for a password, and winget's agreement flags.
 */
export function installPlan(pkg: Pkg, m: Machine, unattended = false): Plan {
  const sudo = m.root || m.platform === "win32" ? [] : unattended ? ["sudo", "-n"] : ["sudo"];
  if (m.platform === "darwin") {
    if (pkg === "git") return { pkgs: [pkg], steps: [["xcode-select", "--install"]], text: "xcode-select --install" };
    if (pkg !== "ripgrep") return advice([pkg], "built into macOS");
  }
  if (m.platform === "win32") {
    if (pkg === "ssh") return advice([pkg], "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 (in an administrator PowerShell)");
    if (pkg === "bash") return advice([pkg], "not needed on Windows");
  }
  const manager = chooseManager(m);
  const name = manager && NAMES[manager][pkg];
  if (!manager || !name) {
    if (m.platform === "darwin") return advice([pkg], "install Homebrew from https://brew.sh (cc-remote doesn't), then: brew install ripgrep");
    return advice([pkg], `install ${pkg} with your package manager`);
  }
  const steps = pkg === "ripgrep" && (manager === "dnf" || manager === "yum") && needsEpel(m)
    ? [[...sudo, manager, "install", "-y", "epel-release"], command(manager, name, sudo, unattended)]
    : [command(manager, name, sudo, unattended)];
  return { pkgs: [pkg], manager, steps, text: show(steps) };
}

/** Managers whose package name comes last, so one command can install several. */
const MERGEABLE = new Set<Manager>(["apt-get", "dnf", "yum", "pacman", "zypper", "apk", "brew", "port", "scoop"]);

/** Joins single-command plans of the same manager into one command: `apt-get install -y ripgrep git`. */
export function mergePlans(plans: Plan[]): Plan[] {
  const out: Plan[] = [];
  for (const plan of plans) {
    const prefix = plan.steps.length === 1 ? plan.steps[0]!.slice(0, -1).join("\0") : undefined;
    const into = plan.manager && MERGEABLE.has(plan.manager) && prefix !== undefined
      ? out.find((p) => p.manager === plan.manager && p.steps.length === 1 && p.steps[0]!.slice(0, -p.pkgs.length).join("\0") === prefix)
      : undefined;
    if (into) {
      into.pkgs.push(...plan.pkgs);
      into.steps[0]!.push(plan.steps[0]!.at(-1)!);
      into.text = show(into.steps);
    } else out.push({ ...plan, pkgs: [...plan.pkgs], steps: plan.steps.map((s) => [...s]) });
  }
  return out;
}

/** How to give this machine a unique name. */
export const hostnameAdvice = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "sudo scutil --set HostName <unique-name>"
  : platform === "win32" ? "Rename-Computer -NewName <unique-name> (administrator PowerShell)"
  : "sudo hostnamectl set-hostname <unique-name>";
