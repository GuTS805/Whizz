// Cross-platform APK build: syncs the Capacitor config, then runs the Gradle
// wrapper — gradlew.bat on Windows, ./gradlew on macOS/Linux.
//   npm run build:apk            → debug APK
//   npm run build:apk -- release → signed release APK
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.argv[2] === "release" ? "Release" : "Debug";
const isWindows = process.platform === "win32";

function run(cmd, args, cwd) {
  // .bat/.cmd files need a shell on Windows.
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWindows });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const androidDir = path.join(root, "android");
// Full path: some Windows setups don't search the current folder for commands.
const gradlew = path.join(androidDir, isWindows ? "gradlew.bat" : "gradlew");

run(isWindows ? "npx.cmd" : "npx", ["cap", "sync", "android"], root);
run(isWindows ? `"${gradlew}"` : gradlew, [`assemble${variant}`], androidDir);

console.log(`\nAPK: mobile/android/app/build/outputs/apk/${variant.toLowerCase()}/`);
