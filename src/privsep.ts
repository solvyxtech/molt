/**
 * Privilege separation: the worker's tools run as another user.
 *
 * Unattended, with hidden checks, the worker model's tools ran as the same
 * uid as Maat, so it could read everything Maat could. A Grok worker was seen
 * hunting for its hidden checks — `grep -r` over `/`, `/opt`, `~/.grok`,
 * Maat's own dist and `.maat/`. Masking what Maat writes (src/withhold.ts)
 * closes the files Maat knows about; it cannot close the reference program in
 * a world-readable temp dir, a mission contract in the task folder, the
 * judge's session store under the same HOME, the commands in `ps`, Maat's
 * process memory, or an earlier run's logs. Those share one root: the same
 * user. This removes it.
 *
 * Opt-in (`--worker-user <name>`, `MAAT_WORKER_USER`), Linux-first, for
 * containers, CI and unattended runs. Maat runs as root (or as a user with
 * passwordless sudo to the worker). When it is on:
 *
 *  - every command the worker triggers (`bash`, background jobs, an ACP
 *    agent such as Grok Build and every tool it runs itself) runs as the
 *    worker's uid/gid, with the worker's HOME and a scrubbed environment;
 *  - the file tools (read/write/edit/list/grep/inspect) are performed by a
 *    small helper running as the worker (src/fs-helper.ts), so they can read
 *    and write exactly what that user can and nothing else;
 *  - Maat's records — journal, receipts, integrity, out/, mission contract,
 *    reference and check temp dirs — live in a state dir outside the project,
 *    mode 700, owned by Maat (MAAT_STATE_DIR, default /var/lib/maat/<session>
 *    as root, ~/.local/state/maat/<session> otherwise). At the end of the job
 *    they are copied into the project's `.maat/` as before;
 *  - the judge and ask subprocesses and the hidden checks stay Maat's: same
 *    uid, a HOME the worker cannot read, checks run in the copy-on-run tree;
 *  - where the kernel allows it (root with CAP_SYS_ADMIN), the worker's
 *    commands share one PID namespace of their own with a private /proc, so
 *    `ps` shows them nothing of Maat's. Without it the process list stays
 *    visible: see docs/privilege-separation.md.
 *
 * Off (the default) nothing here runs and nothing changes.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GrepResult, WalkOptions, WalkResult } from "./files.js";
import { redirectState, stateDirName } from "./statedir.js";

export type WorkerUser = { name: string; uid: number; gid: number; home: string };

/** A process to start: what to exec, and as whom when Maat can say so directly. */
export type SpawnSpec = {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
};

/** The file tools' view of the disk, as the worker sees it. */
export type WorkerFs = {
  read(abs: string): Promise<string>;
  write(abs: string, content: string): Promise<void>;
  exists(abs: string): Promise<boolean>;
  isDir(abs: string): Promise<boolean>;
  sha256(abs: string): Promise<string | null>;
  walk(abs: string, opts: WalkOptions): Promise<WalkResult>;
  grep(abs: string, pattern: string, opts: { glob?: string; ignoreCase?: boolean }): Promise<GrepResult>;
  inspectDir(abs: string, rel: string): Promise<string>;
  inspectFile(abs: string, rel: string, opts: { offset?: number; length?: number }): Promise<string>;
  /** access(2) as the worker: R_OK 4, W_OK 2, X_OK 1. */
  access(abs: string, mode: number): Promise<boolean>;
};

export class PrivSepError extends Error {}

/** One entry `fs-helper.js pack` reads or `unpack` writes (src/fs-helper.ts). */
export type PackEntry = { rel: string; kind: "dir" | "file"; mode: number; data?: string };

/** A relative path from the file helper, or null if it could leave its root. */
export function safeRel(rel: string): string | null {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || isAbsolute(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes(sep))) return null;
  return parts.join(sep);
}

/**
 * Environment names that hold a credential, whatever the vendor. Broad on
 * purpose: it also drops harmless names such as AUTHOR_NAME, which costs the
 * worker nothing it needs. A worker agent's own credential gets through only
 * by name, from the agent's allowlist (`execSpec`'s `keep`).
 */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

/** Look a user up by name: NSS first (getent), then /etc/passwd. */
export function lookupUser(name: string): WorkerUser {
  const parse = (line: string): WorkerUser | null => {
    const f = line.trim().split(":");
    if (f.length < 7 || f[0] !== name) return null;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { name, uid, gid, home: f[5] || "/" };
  };
  const g = spawnSync("getent", ["passwd", name], { encoding: "utf8" });
  if (g.status === 0) {
    const u = parse(g.stdout.split("\n")[0] ?? "");
    if (u) return u;
  }
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const u = parse(line);
      if (u) return u;
    }
  } catch {
    /* no passwd file */
  }
  throw new PrivSepError(`no such user: ${name}`);
}

function which(bin: string): string | null {
  for (const d of (process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").split(":")) {
    if (!d) continue;
    const p = join(d, bin);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The pid of `parent`'s first child, as this PID namespace numbers it. */
function childOf(parent: number): number | null {
  try {
    const kids = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    if (kids.length) return Number(kids[0]);
  } catch {
    /* no children file: scan */
  }
  try {
    for (const n of readdirSync("/proc")) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const stat = readFileSync(`/proc/${n}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (ppid === parent) return Number(n);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* no /proc */
  }
  return null;
}

/** Where the state dir goes when MAAT_STATE_DIR does not say. */
export function defaultStateRoot(session: string): string {
  const root = process.getuid?.() === 0;
  return root
    ? join("/var/lib/maat", session)
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "maat", session);
}

export type PrivSepOptions = {
  /** The worker user's name. */
  user: string;
  /** The project folder the worker works in. */
  project: string;
  /** Overrides MAAT_STATE_DIR and the default. */
  stateDir?: string;
  /** false: never use a PID namespace; true: require one. Default: when available (MAAT_WORKER_PIDNS). */
  pidns?: boolean;
  /** Said once on stderr: what was tightened, what stays visible. */
  notice?: (text: string) => void;
  /**
   * The file helper script (dist/fs-helper.js). The CLI passes it; left out,
   * it is looked for beside the running script.
   */
  helper?: string;
};

export class PrivSep {
  readonly worker: WorkerUser;
  readonly project: string;
  readonly stateRoot: string;
  readonly maatUid: number;
  /** How the worker's processes are started: directly with a uid (root), or through sudo. */
  readonly mode: "root" | "sudo";
  readonly pidns: boolean;
  readonly helperScript: string;
  /** The project as it was when the job started, so a swapped folder is never walked. */
  private readonly projectReal: string;
  private readonly projectId: { dev: number; ino: number };
  private nsLeader?: ChildProcess;
  private nsInit?: number;
  private helper?: FsHelper;
  private closed = false;
  private onExit = () => this.close();
  private readonly savedEnv: Record<string, string | undefined> = {};

  constructor(opts: PrivSepOptions) {
    if (process.platform === "win32") throw new PrivSepError("--worker-user is not supported on Windows");
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (uid === undefined) throw new PrivSepError("--worker-user needs a POSIX system");
    this.maatUid = uid;
    this.worker = lookupUser(opts.user);
    if (this.worker.uid === uid) {
      throw new PrivSepError(`--worker-user ${opts.user} is the user Maat runs as; the worker must be a different user`);
    }
    if (this.worker.uid === 0) throw new PrivSepError("--worker-user must not be root");
    this.project = resolve(opts.project);
    this.projectReal = realpathSync(this.project);
    const pst = statSync(this.projectReal);
    this.projectId = { dev: pst.dev, ino: pst.ino };
    this.helperScript = opts.helper ?? join(dirname(realpathSync(process.argv[1] ?? ".")), "fs-helper.js");
    if (!existsSync(this.helperScript)) throw new PrivSepError(`the file helper is missing: ${this.helperScript}`);
    if (uid === 0) this.mode = "root";
    else if (spawnSync("sudo", ["-n", "-u", this.worker.name, "--", "true"], { stdio: "ignore" }).status === 0) this.mode = "sudo";
    else {
      throw new PrivSepError(
        `--worker-user needs Maat to run as root, or passwordless sudo to ${this.worker.name} (sudo -n -u ${this.worker.name} true failed)`,
      );
    }

    const session = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
    const wanted = opts.stateDir ?? process.env.MAAT_STATE_DIR ?? defaultStateRoot(session);
    this.stateRoot = resolve(wanted);
    const inProject = relative(this.project, this.stateRoot);
    if (!inProject || (!inProject.startsWith("..") && !inProject.startsWith(sep) && !/^[a-zA-Z]:/.test(inProject))) {
      throw new PrivSepError(`the state dir ${this.stateRoot} is inside the project; it must be outside it`);
    }
    this.makePrivate(this.stateRoot);
    this.makePrivate(join(this.stateRoot, "tmp"));

    const want = opts.pidns ?? envFlag("MAAT_WORKER_PIDNS");
    this.pidns = want === false ? false : this.startNamespace();
    if (want === true && !this.pidns) {
      throw new PrivSepError("MAAT_WORKER_PIDNS=1 but a PID namespace could not be made (needs root with CAP_SYS_ADMIN, unshare, nsenter and setpriv)");
    }
    process.on("exit", this.onExit);

    // Maat's own temp files (reference tries, check copies, drafts, judge
    // scratch) land in the state dir; the worker's get /tmp (workerEnv).
    this.setEnv("TMPDIR", join(this.stateRoot, "tmp"));
    // Maat reads the worker's repository as another user; git refuses a
    // repository owned by someone else unless told it is safe.
    const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
    this.setEnv(`GIT_CONFIG_KEY_${n}`, "safe.directory");
    this.setEnv(`GIT_CONFIG_VALUE_${n}`, "*");
    this.setEnv("GIT_CONFIG_COUNT", String(n + 1));

    this.seed();
    redirectState(this.project, this.stateRoot);

    const notice = opts.notice ?? (() => {});
    this.guardHome(notice);
    if (!this.pidns) {
      notice(
        "the worker can still list processes (ps): mount /proc with hidepid=2, or run Maat as root with CAP_SYS_ADMIN " +
          "so its commands get their own PID namespace (docs/privilege-separation.md)",
      );
    }
  }

  private setEnv(k: string, v: string): void {
    if (!(k in this.savedEnv)) this.savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  /** A folder only Maat can read: created mode 700, or tightened to it. */
  private makePrivate(dir: string): void {
    const parent = dirname(dir);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = statSync(dir);
    if (st.uid !== this.maatUid) throw new PrivSepError(`${dir} is not owned by Maat's user (uid ${this.maatUid})`);
    chmodSync(dir, 0o700);
  }

  /**
   * Maat's records from earlier jobs move to the state dir, so the chains
   * continue; a mission contract leaves the project entirely until the job is
   * over. The checks file, the worker's background logs and the mission
   * library (which the worker writes) stay.
   *
   * The project's `.maat/` is the worker's: it is read, and the contract
   * removed, by the file helper running as the worker (`fs-helper.js pack`),
   * never by Maat walking it. Only regular files and folders come back, by
   * name, and Maat writes them into its own state dir: a symlink in the
   * project (`.maat/receipts -> /root/...`) is skipped by the helper and could
   * not be created here anyway, so Maat never writes through one later.
   */
  private seed(): void {
    const src = join(this.project, stateDirName(this.project));
    const out = this.runHelper<{ entries: PackEntry[]; skipped: string[] }>("pack", {
      src,
      skip: ["done.yml", "bg", "mission/library"],
      clear: { dir: "mission", keep: ["library"] },
    });
    for (const e of out.entries) {
      const rel = safeRel(e.rel);
      if (!rel) continue;
      const to = join(this.stateRoot, rel);
      if (!this.privateParent(to)) continue;
      try {
        if (e.kind === "dir") mkdirSync(to, { mode: 0o700 });
        else writeFileSync(to, Buffer.from(e.data ?? "", "base64"), { mode: 0o600, flag: "w" });
      } catch {
        /* an entry that clashes with the state dir's own is not copied */
      }
    }
    this.skippedOnSeed = out.skipped;
  }

  /** What `seed` refused to carry over (symlinks and other non-files), project-relative to `.maat/`. */
  skippedOnSeed: readonly string[] = [];

  /**
   * True when every folder from the state root down to `p`'s parent exists
   * and is a real folder (not a symlink). The state dir is Maat's and mode
   * 700, so this holds unless something went badly wrong; it is checked
   * anyway, because a write here is a write as Maat.
   */
  private privateParent(p: string): boolean {
    const rel = relative(this.stateRoot, dirname(p));
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    let cur = this.stateRoot;
    for (const part of rel ? rel.split(sep) : []) {
      cur = join(cur, part);
      try {
        const st = lstatSync(cur);
        if (!st.isDirectory() || st.uid !== this.maatUid) return false;
      } catch {
        return false;
      }
    }
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return false;
    } catch {
      /* not there yet: fine */
    }
    return true;
  }

  /**
   * Run the file helper once, as the worker, with `input` on stdin and JSON
   * on stdout (`pack`, `unpack`; see src/fs-helper.ts).
   */
  private runHelper<T>(mode: "pack" | "unpack", input: unknown): T {
    const env = { ...this.workerEnv(), ELECTRON_RUN_AS_NODE: "1" };
    const spec: SpawnSpec =
      this.mode === "root"
        ? { file: process.execPath, args: [this.helperScript, mode], env, uid: this.worker.uid, gid: this.worker.gid }
        : this.execSpec(process.execPath, [this.helperScript, mode], "/", env);
    const r = spawnSync(spec.file, spec.args, {
      cwd: "/",
      env: { ...spec.env, ELECTRON_RUN_AS_NODE: "1" },
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 1 << 30,
      timeout: 120_000,
      ...(spec.uid !== undefined ? { uid: spec.uid, gid: spec.gid } : {}),
    });
    if (r.status !== 0) {
      throw new PrivSepError(`the worker file helper (${mode}) failed: ${(r.error?.message ?? r.stderr ?? "").toString().trim() || `exit ${r.status}`}`);
    }
    return JSON.parse(r.stdout) as T;
  }

  /**
   * The judge's and ask's HOME (Maat's own) holds their logins and session
   * stores. The worker must not be able to read it: tightened to 700 when it
   * is Maat's, refused otherwise.
   */
  private guardHome(notice: (t: string) => void): void {
    const home = homedir();
    if (!home || !existsSync(home)) return;
    const st = statSync(home);
    const byOthers = (st.mode & 0o005) !== 0;
    const byGroup = st.gid === this.worker.gid && (st.mode & 0o050) !== 0;
    if (!byOthers && !byGroup) return;
    if (st.uid !== this.maatUid) {
      throw new PrivSepError(`Maat's HOME ${home} is readable by ${this.worker.name} and not Maat's to tighten; set HOME to a private folder`);
    }
    chmodSync(home, st.mode & 0o700);
    notice(`tightened ${home} to mode 700 so ${this.worker.name} cannot read the judge's logins`);
  }

  /** One PID namespace with a private /proc for all of the worker's processes. */
  private startNamespace(): boolean {
    if (process.platform !== "linux" || this.mode !== "root") return false;
    if (!which("unshare") || !which("nsenter") || !which("setpriv")) return false;
    const probe = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", "true"], { stdio: "ignore", timeout: 10_000 });
    if (probe.status !== 0) return false;
    // A shell as the namespace's init: it reaps what the worker orphans, and
    // when it dies everything in the namespace dies with it. `--kill-child`
    // ends it when its unshare does, and unshare shares Maat's process group,
    // so killing Maat's group (a harness backstop) ends the namespace too.
    const leader = spawn(
      "unshare",
      ["--pid", "--fork", "--mount-proc", "--kill-child", "/bin/sh", "-c", "while :; do sleep 86400 & wait $!; done"],
      { stdio: "ignore" },
    );
    leader.on("error", () => {});
    leader.unref();
    let init: number | null = null;
    for (let i = 0; i < 200 && leader.pid && init === null; i++) {
      init = childOf(leader.pid);
      if (init === null) sleepSync(10);
    }
    if (!init) {
      try {
        leader.kill("SIGKILL");
      } catch {
        /* gone */
      }
      return false;
    }
    this.nsLeader = leader;
    this.nsInit = init;
    return true;
  }

  /** The environment a worker process gets: no credentials, no Maat internals, its own HOME and /tmp. */
  workerEnv(base: NodeJS.ProcessEnv = process.env, keep: readonly string[] = []): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(base)) {
      if (v === undefined) continue;
      if (SECRETISH.test(k) && !keep.includes(k)) continue;
      if (/^(MAAT|MOLT)_/.test(k) || /^GIT_CONFIG_/.test(k)) continue;
      if (k === "ELECTRON_RUN_AS_NODE" || k === "TMP" || k === "TEMP" || k === "XDG_STATE_HOME" || k === "XDG_CONFIG_HOME" || k === "XDG_DATA_HOME" || k === "XDG_CACHE_HOME" || k === "XDG_RUNTIME_DIR") continue;
      if (k === "SUDO_USER" || k === "SUDO_UID" || k === "SUDO_GID" || k === "SUDO_COMMAND" || k === "MAIL") continue;
      env[k] = v;
    }
    env.HOME = this.worker.home;
    env.USER = this.worker.name;
    env.LOGNAME = this.worker.name;
    env.TMPDIR = "/tmp";
    return env;
  }

  /** A shell command, run as the worker. */
  commandSpec(command: string, shell: string | true, cwd: string, env?: NodeJS.ProcessEnv): SpawnSpec {
    return this.execSpec(shell === true ? "/bin/sh" : shell, ["-c", command], cwd, env);
  }

  /**
   * A program, run as the worker (in its PID namespace when there is one).
   * `keep` names credential variables that pass the scrub: only the worker
   * agent's own login (an ACP spec's `workerCredentialEnv`), never anything
   * the worker's shell commands get.
   */
  execSpec(file: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, keep: readonly string[] = []): SpawnSpec {
    const wenv = this.workerEnv(env ?? process.env, keep);
    const { uid, gid, name } = this.worker;
    if (this.mode === "sudo") {
      const pairs = Object.entries(wenv).map(([k, v]) => `${k}=${v}`);
      return { file: "sudo", args: ["-n", "-u", name, "--", "env", "-i", ...pairs, file, ...args], env: wenv };
    }
    if (this.pidns && this.nsInit && this.nsAlive()) {
      return {
        file: "nsenter",
        args: [
          `--target=${this.nsInit}`,
          "--pid",
          "--mount",
          "--",
          "setpriv",
          `--reuid=${uid}`,
          `--regid=${gid}`,
          "--clear-groups",
          // Root in this container may hold CAP_SYS_ADMIN (it made the
          // namespace); the worker gets no capability, and no setuid binary
          // can hand it one.
          "--no-new-privs",
          "--bounding-set=-all",
          "--",
          // The working directory is entered inside the namespace, by path.
          // nsenter --wd opens it before entering, and a cwd from the outer
          // mount namespace is "unreachable" inside: getcwd() then fails with
          // EACCES whenever a parent is not readable by the worker (bench:
          // /var/lib/bench-work is 711), and git refuses to run at all.
          "/bin/sh",
          "-c",
          'cd -- "$0" && exec "$@"',
          cwd,
          file,
          ...args,
        ],
        env: wenv,
      };
    }
    return { file, args: [...args], env: wenv, uid, gid };
  }

  private nsAlive(): boolean {
    return this.nsInit !== undefined && existsSync(`/proc/${this.nsInit}`);
  }

  /** The file tools, performed as the worker. Started on first use. */
  fs(): WorkerFs {
    if (!this.helper) this.helper = new FsHelper(this);
    return this.helper;
  }

  /**
   * After Maat ran something in the project as itself (a project check in
   * place, a git commit), hand what it created back to the worker, so the
   * worker can go on editing its own tree. Only entries Maat's user owns.
   *
   * The tree is the worker's and the worker may be changing it while this
   * runs, so it is never walked by path. Each folder is opened relative to
   * the one before (`/proc/self/fd/<fd>/<name>`, the openat(2) of Linux) with
   * O_NOFOLLOW|O_DIRECTORY, files with O_NOFOLLOW, and ownership is changed
   * on the open descriptor (fchown). A folder swapped for a symlink fails to
   * open and is skipped; one moved out of the project is noticed (its path
   * no longer starts with the project's) and skipped. The project itself
   * must be the folder, by device and inode, that the job started in. Files
   * with more than one link are left alone (a hard link to a file outside),
   * as are symlinks and anything on another file system. Linux only: elsewhere
   * nothing is handed back.
   */
  handBack(dir: string = this.project, limit = 100_000): void {
    if (this.mode !== "root" || process.platform !== "linux" || !existsSync("/proc/self/fd")) return;
    const r = relative(this.project, resolve(dir));
    if (r.startsWith("..") || isAbsolute(r)) return;
    const { uid, gid } = this.worker;
    const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
    const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
    const inside = (fd: number): boolean => {
      try {
        const p = readlinkSync(`/proc/self/fd/${fd}`);
        return p === this.projectReal || p.startsWith(this.projectReal + sep);
      } catch {
        return false;
      }
    };
    let fd: number;
    try {
      fd = openSync(this.projectReal, DIR);
    } catch {
      return;
    }
    try {
      const st = fstatSync(fd);
      if (st.dev !== this.projectId.dev || st.ino !== this.projectId.ino || !inside(fd)) return;
      for (const part of r ? r.split(sep) : []) {
        const next = openSync(at(fd, part), DIR);
        closeSync(fd);
        fd = next;
      }
    } catch {
      closeSync(fd);
      return;
    }
    let seen = 0;
    const walk = (dfd: number, depth: number): void => {
      if (!inside(dfd)) return;
      const st = fstatSync(dfd);
      if (st.dev !== this.projectId.dev) return;
      if (st.uid === this.maatUid) fchownSync(dfd, uid, gid);
      if (depth > 256) return;
      let names: string[];
      try {
        names = readdirSync(`/proc/self/fd/${dfd}`);
      } catch {
        return;
      }
      for (const n of names) {
        if (++seen > limit) return;
        let lst;
        try {
          lst = lstatSync(at(dfd, n));
        } catch {
          continue;
        }
        if (lst.isDirectory()) {
          let sub: number;
          try {
            sub = openSync(at(dfd, n), DIR);
          } catch {
            continue;
          }
          try {
            walk(sub, depth + 1);
          } catch {
            /* best effort */
          } finally {
            closeSync(sub);
          }
        } else if (lst.isFile() && lst.uid === this.maatUid) {
          let f: number;
          try {
            f = openSync(at(dfd, n), FILE);
          } catch {
            continue;
          }
          try {
            const fst = fstatSync(f);
            if (fst.isFile() && fst.uid === this.maatUid && fst.nlink === 1 && fst.dev === this.projectId.dev) fchownSync(f, uid, gid);
          } catch {
            /* not ours to change */
          } finally {
            closeSync(f);
          }
        }
        // Symlinks, FIFOs, sockets and devices are left as they are.
      }
    };
    try {
      walk(fd, 0);
    } catch {
      /* best effort */
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The job is over: copy Maat's records into the project's `.maat/`, where
   * people have always found them. The temp dir is not copied. Returns the
   * folder they went to.
   *
   * Maat reads its own state dir (regular files and folders only) and the
   * file helper, running as the worker, writes them into the project, so the
   * copies are the worker's and Maat writes nothing in the worker's tree: a
   * symlink planted at `.maat/receipts` sends the worker's write where the
   * worker could write anyway.
   */
  publish(): string {
    const dest = join(this.project, stateDirName(this.project));
    const entries: PackEntry[] = [];
    const walk = (rel: string): void => {
      for (const name of readdirSync(rel ? join(this.stateRoot, rel) : this.stateRoot)) {
        if (!rel && name === "tmp") continue;
        const r = rel ? `${rel}/${name}` : name;
        const p = join(this.stateRoot, r);
        const st = lstatSync(p);
        if (st.isDirectory()) {
          entries.push({ rel: r, kind: "dir", mode: 0o755 });
          walk(r);
        } else if (st.isFile()) {
          entries.push({ rel: r, kind: "file", mode: 0o644, data: readFileSync(p).toString("base64") });
        }
      }
    };
    walk("");
    const out = this.runHelper<{ written: number; failed: string[] }>("unpack", { dest, entries });
    if (out.failed.length) {
      throw new PrivSepError(`${out.failed.length} record(s) could not be written into ${dest} (${out.failed.slice(0, 3).join(", ")}); they are still in ${this.stateRoot}`);
    }
    this.handBack(this.project);
    return dest;
  }

  /** Stop the helper and the namespace, and put Maat's records back where they were looked for. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    process.removeListener("exit", this.onExit);
    this.helper?.stop();
    if (this.nsLeader?.pid) {
      try {
        process.kill(this.nsLeader.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    redirectState(null);
    for (const [k, v] of Object.entries(this.savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return !/^(0|false|no|off)$/i.test(v);
}

// ---------------------------------------------------------------------------
// The file helper: a node process running as the worker

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class FsHelper implements WorkerFs {
  private child?: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private ps: PrivSep) {}

  private start(): ChildProcess {
    if (this.child) return this.child;
    const script = this.ps.helperScript;
    const env = { ...this.ps.workerEnv(), ELECTRON_RUN_AS_NODE: "1" };
    // Not in the PID namespace: it is Maat's own tool and only needs the uid.
    const spec: SpawnSpec =
      this.ps.mode === "root"
        ? { file: process.execPath, args: [script], env, uid: this.ps.worker.uid, gid: this.ps.worker.gid }
        : this.ps.execSpec(process.execPath, [script], "/", env);
    const child = spawn(spec.file, spec.args, {
      cwd: "/",
      env: { ...spec.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      ...(spec.uid !== undefined ? { uid: spec.uid, gid: spec.gid } : {}),
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.feed(d));
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      err = (err + d).slice(-2000);
    });
    const fail = (e: Error) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.child = undefined;
    };
    child.on("error", (e) => fail(e));
    child.on("exit", (code) => fail(new Error(`the worker file helper exited (${code ?? "signal"})${err.trim() ? `: ${err.trim()}` : ""}`)));
    child.stdin?.on("error", () => {});
    this.idle();
    return child;
  }

  /** Let Maat exit while nothing is asked of the helper. */
  private idle(): void {
    const c = this.child;
    if (!c) return;
    const busy = this.pending.size > 0;
    for (const s of [c, c.stdin, c.stdout, c.stderr] as ({ ref?: () => void; unref?: () => void } | null | undefined)[]) {
      if (busy) s?.ref?.();
      else s?.unref?.();
    }
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let msg: { id: number; ok: boolean; value?: unknown; error?: { message: string; code?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else {
        const e = new Error(msg.error?.message ?? "failed") as NodeJS.ErrnoException;
        if (msg.error?.code) e.code = msg.error.code;
        p.reject(e);
      }
    }
    this.idle();
  }

  private call<T>(op: string, ...args: unknown[]): Promise<T> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise as (v: unknown) => void, reject });
      this.idle();
      child.stdin?.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }

  read(abs: string) {
    return this.call<string>("read", abs);
  }
  write(abs: string, content: string) {
    return this.call<void>("write", abs, content);
  }
  exists(abs: string) {
    return this.call<boolean>("exists", abs);
  }
  isDir(abs: string) {
    return this.call<boolean>("isDir", abs);
  }
  sha256(abs: string) {
    return this.call<string | null>("sha256", abs);
  }
  walk(abs: string, opts: WalkOptions) {
    const { skip: _skip, ...plain } = opts;
    return this.call<WalkResult>("walk", abs, plain);
  }
  grep(abs: string, pattern: string, opts: { glob?: string; ignoreCase?: boolean }) {
    return this.call<GrepResult>("grep", abs, pattern, opts);
  }
  inspectDir(abs: string, rel: string) {
    return this.call<string>("inspectDir", abs, rel);
  }
  inspectFile(abs: string, rel: string, opts: { offset?: number; length?: number }) {
    return this.call<string>("inspectFile", abs, rel, opts);
  }
  access(abs: string, mode: number) {
    return this.call<boolean>("access", abs, mode);
  }

  stop(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* gone */
    }
    this.child = undefined;
  }
}

// ---------------------------------------------------------------------------
// The one instance

let active: PrivSep | undefined;

/** The privilege separation in force, if any. */
export function privSep(): PrivSep | undefined {
  return active;
}

/** Turn it on for this process. Throws PrivSepError when it cannot be made safe. */
export function enablePrivSep(opts: PrivSepOptions): PrivSep {
  active?.close();
  active = new PrivSep(opts);
  return active;
}

/** Turn it off (tests; the end of a run). */
export function disablePrivSep(): void {
  active?.close();
  active = undefined;
}

/** The worker user asked for, from the flag or MAAT_WORKER_USER. */
export function workerUserFrom(flag?: string): string | undefined {
  const v = (flag ?? process.env.MAAT_WORKER_USER ?? "").trim();
  return v || undefined;
}
