import { lstatSync, readdirSync, unlinkSync } from "node:fs";

/** Caller MUST hold the directory's writer lease (root enrollment or device state).
 * Only our UUID-named atomic-write remnants are eligible; never age-prune user files.
 */
export function sweepAtomicTemps(directory: string): void {
  for (const name of readdirSync(directory)) {
    if (!/^\.(?:state|connection)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(name)) continue;
    const path = `${directory}/${name}`;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())) continue;
      unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
