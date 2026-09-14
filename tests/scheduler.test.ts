import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULE, jobs, label, parseTime, plistFor } from "../src/scheduler/launchd.js";

describe("launchd scheduler", () => {
  it("defines the three initiative jobs at the default times", () => {
    expect(jobs().map((j) => [j.name, j.at, j.args.join(" ")])).toEqual([
      ["morning", "07:00", "brief --notify"],
      ["silence", "12:00", "silence-check --notify"],
      ["evening", "18:00", "nudge wrap"],
    ]);
    expect(jobs({ ...DEFAULT_SCHEDULE, morning: "6:30" })[0].at).toBe("6:30");
  });

  it("validates times", () => {
    expect(parseTime("07:05")).toEqual({ hour: 7, minute: 5 });
    expect(() => parseTime("7pm")).toThrow(/HH:MM/);
    expect(() => parseTime("25:00")).toThrow(/range/);
  });

  it("renders a plist with the node entry point, calendar interval, cwd and logs", () => {
    const job = jobs()[0];
    const plist = plistFor(job, { node: "/usr/local/bin/node", entry: "/repo/dist/cli/cos.js", cwd: "/repo" });
    expect(label(job)).toBe("com.chief-of-staff.morning");
    expect(plist).toContain("<string>com.chief-of-staff.morning</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>\n    <string>/repo/dist/cli/cos.js</string>\n    <string>brief</string>\n    <string>--notify</string>");
    expect(plist).toContain("<key>Hour</key><integer>7</integer>");
    expect(plist).toContain("<key>Minute</key><integer>0</integer>");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/repo</string>");
    expect(plist).toContain("morning.log");
    expect(plist).toContain("<key>RunAtLoad</key><false/>");
  });

  it("escapes XML in paths", () => {
    const plist = plistFor(jobs()[0], { node: "/n", entry: "/a&b/cos.js", cwd: "/x<y>" });
    expect(plist).toContain("/a&amp;b/cos.js");
    expect(plist).toContain("/x&lt;y&gt;");
  });
});
